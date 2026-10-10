// Empreinte des DROITS d'une base Cadence : ce que `pg_dump --no-privileges` perdait sans que personne ne s'en aperçoive.
//
// Une restauration n'est « vérifiée » que si, entre la source et la copie restaurée, sont identiques :
//   - les droits (ACL) des tables, vues, séquences, fonctions, schémas et colonnes ;
//   - l'activation de la RLS et chaque politique (commande, rôles, expressions) ;
//   - les privilèges par défaut des schémas sauvegardés.
// Les propriétaires et les « grantor » ne sont pas comparés : une restauration sans propriétaire (--no-owner)
// donne les objets à l'utilisateur qui restaure, ce qui ne change rien aux droits des rôles de l'application.

export const SNAPSHOT_SCHEMAS = ["public", "private", "auth", "storage"];

const IN_LIST = SNAPSHOT_SCHEMAS.map((name) => `'${name}'`).join(", ");

/** Requête unique : une ligne par objet, « type|objet|acl|propriétaire|détail ». Lecture seule. */
// search_path fixé : les expressions des politiques sont rendues par pg_get_expr, qui qualifie (ou non) les noms
// selon le chemin de recherche de la session. Deux sessions de rôles différents donneraient des textes différents
// pour une politique identique.
export const ACL_SNAPSHOT_SQL = `
select set_config('search_path', 'pg_catalog', false);
select 'table' as kind, n.nspname || '.' || c.relname as object, coalesce(c.relacl::text, '') as acl,
       pg_get_userbyid(c.relowner) as owner,
       c.relkind::text || case when c.relrowsecurity then ':rls' else ':norls' end || case when c.relforcerowsecurity then ':force' else '' end as detail
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in (${IN_LIST}) and c.relkind in ('r', 'p', 'v', 'm', 'S')
union all
select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', coalesce(p.proacl::text, ''),
       pg_get_userbyid(p.proowner), case when p.prosecdef then 'definer' else 'invoker' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in (${IN_LIST})
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
union all
select 'schema', nspname, coalesce(nspacl::text, ''), pg_get_userbyid(nspowner), ''
from pg_namespace where nspname in (${IN_LIST})
union all
select 'column', n.nspname || '.' || c.relname || '.' || a.attname, a.attacl::text, pg_get_userbyid(c.relowner), ''
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where a.attacl is not null and not a.attisdropped and n.nspname in (${IN_LIST})
union all
select 'policy', schemaname || '.' || tablename || '.' || policyname, '', '',
       md5(coalesce(cmd, '') || '|' || coalesce(roles::text, '') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
from pg_policies where schemaname in (${IN_LIST})
union all
select 'default_acl', n.nspname || '.' || d.defaclobjtype::text || '.' || pg_get_userbyid(d.defaclrole), coalesce(d.defaclacl::text, ''), '', ''
from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname in (${IN_LIST})
order by 1, 2;
`;

/** Un ACL PostgreSQL « {a=r/x,b=arwd/x} » → liste triée « a=r », sans grantor ni droits du propriétaire. */
export function normalizeAcl(acl, owner = "") {
  if (!acl) return "";
  const inner = acl.replace(/^\{/, "").replace(/\}$/, "");
  if (inner === "") return "";
  const entries = inner
    .split(",")
    .map((entry) => entry.replace(/^"|"$/g, "").replace(/\/[^/]*$/, ""))
    .filter((entry) => {
      const grantee = entry.split("=")[0];
      return owner === "" || grantee !== owner;
    });
  return entries.sort().join(",");
}

/** Sortie psql (-At -F "|") → lignes comparables. */
export function parseSnapshot(output) {
  const rows = new Map();
  const kinds = new Set(["table", "function", "schema", "column", "policy", "default_acl"]);
  for (const line of output.split("\n").filter(Boolean)) {
    const [kind, object, acl = "", owner = "", detail = ""] = line.split("|");
    if (!kinds.has(kind) || object === undefined) continue;
    // Les politiques et les fonctions peuvent contenir « | » dans leurs arguments : on recolle proprement.
    rows.set(`${kind}:${object}`, { kind, object, acl: normalizeAcl(acl, owner), detail });
  }
  return rows;
}

/** Différences entre deux empreintes : manquants, en trop, droits ou politiques différents. */
export function diffSnapshots(source, restored) {
  const problems = [];
  for (const [key, expected] of source) {
    const actual = restored.get(key);
    if (!actual) {
      problems.push(`manquant après restauration : ${key}`);
    } else if (actual.acl !== expected.acl) {
      problems.push(`droits différents : ${key} (source « ${expected.acl} », restauré « ${actual.acl} »)`);
    } else if (actual.detail !== expected.detail) {
      problems.push(`réglage différent : ${key} (source « ${expected.detail} », restauré « ${actual.detail} »)`);
    }
  }
  for (const key of restored.keys()) {
    if (!source.has(key)) problems.push(`en trop après restauration : ${key}`);
  }
  return problems;
}

/** Sérialisation stable d'une empreinte (pour le manifeste). */
export function snapshotToJson(rows) {
  return [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row);
}

export function snapshotFromJson(list) {
  return new Map(list.map((row) => [`${row.kind}:${row.object}`, row]));
}
