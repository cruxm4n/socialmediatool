#!/usr/bin/env node
// Vérifie qu'une sauvegarde Cadence (scripts/backup.mjs) est RESTAURABLE ET UTILISABLE au niveau de la base :
// elle est rechargée dans une base jetable, à côté de la base de test (même serveur Postgres, base distincte),
// puis contrôlée : données, droits (ACL), politiques RLS, et comportement réel des rôles `authenticated` / `anon`.
//
// Ce que ce script ne prouve PAS : le service Auth, l'API et le Storage (fichiers servis). C'est le rôle de
// scripts/restore-drill.mjs, qui monte une pile Supabase isolée. Le message final le dit.
//
// Garanties :
//   - la base de contrôle doit s'appeler cadence_restore_… ET ne pas exister : une base existante n'est jamais
//     supprimée ni réutilisée ; seule la base créée ici est supprimée à la fin (sauf --keep) ;
//   - la base « postgres » et les projets distants ne sont jamais touchés ;
//   - une restauration incomplète, ou dont les droits diffèrent de la source, se termine par un code de sortie ≠ 0.
//
// Usage :
//   node scripts/restore-check.mjs --container supabase_db_cadence-supabase-test --backup ~/cadence-backups-test/cadence-backup-… [--keep] [--user postgres]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ACL_SNAPSHOT_SQL, diffSnapshots, parseSnapshot, snapshotFromJson } from "./lib/acl-snapshot.mjs";
import { postgresIn, readManifest, restoreBackup, sha256File, validateBackup } from "./lib/restore.mjs";

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const container = option("container");
const backup = option("backup") ? resolve(option("backup")) : null;
const dbName = option("db", `cadence_restore_${Date.now()}`);
const keep = args.includes("--keep");
// Utilisateur SQL du conteneur : « postgres » pour la base de test locale, « supabase_admin » pour une pile de répétition.
const sqlUser = option("user", "postgres");

if (!container || !backup) {
  console.error("Usage : node scripts/restore-check.mjs --container NOM --backup DOSSIER [--db cadence_restore_xxx] [--keep]");
  process.exit(2);
}
if (!/^cadence_restore_[a-z0-9_]+$/.test(dbName)) {
  console.error(`Refusé : la base de contrôle doit s'appeler cadence_restore_… (reçu « ${dbName} »).`);
  process.exit(2);
}

let manifest;
try {
  manifest = readManifest(backup);
} catch (error) {
  console.error(`Sauvegarde inutilisable : ${error.message}`);
  process.exit(2);
}
const pg = postgresIn(container, sqlUser);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const one = (query) => pg.psql(dbName, query);
const safe = (query, fallback = null) => {
  try {
    return one(query);
  } catch {
    return fallback;
  }
};

const dumpPath = join(backup, manifest.database.file);
check("dump présent et empreinte conforme au manifeste", existsSync(dumpPath) && sha256File(dumpPath) === manifest.database.sha256);
const inconsistencies = validateBackup(backup, manifest);
check("manifeste complet ; fichiers du stockage présents et intacts ; aucune dérive signalée", inconsistencies.length === 0, inconsistencies.slice(0, 4).join(" | "));

// 1. Base de contrôle neuve : on ne réutilise ni ne supprime jamais une base existante.
const exists = pg.psql("postgres", `select count(*) from pg_database where datname = '${dbName}';`);
if (exists !== "0") {
  console.error(`Refusé : la base ${dbName} existe déjà (elle n'est jamais supprimée ni réutilisée). Choisissez un autre nom.`);
  process.exit(2);
}
pg.docker(["exec", "-i", container, "psql", "-U", sqlUser, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${dbName}`]);
let created = true;

try {
  pg.psql(dbName, 'create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists "uuid-ossp" with schema extensions;');

  // 2. Restauration (même code que la restauration réelle)
  const restored = restoreBackup({ pg, container, database: dbName, backup });
  check("pg_restore sans erreur grave", restored.problems.length === 0, restored.problems.slice(0, 3).join(" | "));

  // 3. Nombre de lignes
  for (const [table, expected] of Object.entries(manifest.rowCounts)) {
    if (expected === null) continue;
    const actual = safe(`select count(*) from ${table};`);
    check(`lignes restaurées : ${table}`, Number(actual) === expected, `attendu ${expected}, obtenu ${actual}`);
  }
  // Contenu identique, pas seulement le nombre de lignes (relevé avant la sauvegarde, comparé après restauration).
  for (const [table, expected] of Object.entries(manifest.rowDigests ?? {})) {
    if (expected === null) continue;
    const actual = safe(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from ${table} t;`);
    check(`contenu restauré à l'identique : ${table}`, actual === expected);
  }
  const migrations = (safe("select version from supabase_migrations.schema_migrations order by version;", "") ?? "").split("\n").filter(Boolean);
  check("historique des migrations restauré", JSON.stringify(migrations) === JSON.stringify(manifest.migrations));

  // 4. DROITS : la même empreinte qu'à la source (ce que --no-privileges faisait perdre sans bruit)
  if (manifest.acl && existsSync(join(backup, manifest.acl.file))) {
    const aclFile = join(backup, manifest.acl.file);
    check("empreinte des droits conforme au manifeste", sha256File(aclFile) === manifest.acl.sha256);
    const source = snapshotFromJson(JSON.parse(readFileSync(aclFile, "utf8")));
    const actual = parseSnapshot(one(ACL_SNAPSHOT_SQL));
    const differences = diffSnapshots(source, actual);
    check(`droits, politiques RLS et fonctions identiques à la source (${source.size} entrées)`, differences.length === 0, differences.slice(0, 4).join(" | "));
  } else {
    check("empreinte des droits présente dans la sauvegarde", false, "sauvegarde faite avant le contre-audit : refaites-la avec scripts/backup.mjs actuel");
  }

  // 5. Cohérence métier
  check("RLS activée sur toutes les tables publiques", one("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;") === "0");
  check("fonctions SQL restaurées (décision, synchronisation, réservation)", Number(one("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('decide_post','sync_buffer_posts','claim_posts_for_scheduling_in_mode','complete_scheduling');")) >= 4);
  check("aucun post programmé par Cadence sans validation", one("select count(*) from public.posts where schedule_state = 'scheduled' and approval_status <> 'approved';") === "0");
  check("aucune approbation sans empreinte", one("select count(*) from public.posts where approval_status = 'approved' and approved_hash is null;") === "0");
  check("toute décision se rattache à une publication et à un compte", one("select count(*) from public.approval_decisions d left join public.posts p on p.id = d.post_id left join public.profiles u on u.id = d.user_id where p.id is null or u.id is null;") === "0");
  check("tout profil correspond à un compte restauré", one("select count(*) from public.profiles p left join auth.users u on u.id = p.id where u.id is null;") === "0");
  check("tout membre correspond à un client et à un profil", one("select count(*) from public.organization_members m left join public.organizations o on o.id = m.organization_id left join public.profiles p on p.id = m.user_id where o.id is null or p.id is null;") === "0");
  if (manifest.migrations.some((version) => version.startsWith("0009"))) {
    check("toute publication attribuée a un propriétaire", one("select count(*) from public.posts where ownership = 'assigned' and owner_organization_id is null;") === "0");
    check("versions de contenu complètes", one("select count(*) from public.posts p where not exists (select 1 from public.post_versions v where v.post_id = p.id and v.version = p.version);") === "0");
  }

  // 6. COMPORTEMENT RÉEL des rôles (pas seulement leurs droits déclarés)
  // Chaque contrôle s'exécute dans une transaction annulée, avec le rôle et l'identité demandés (comme PostgREST).
  const rawAsRole = (role, sub, statement) =>
    one(`begin; set local role ${role}; select set_config('request.jwt.claim.sub', '${sub}', true); select set_config('request.jwt.claims', '{"sub":"${sub}","role":"${role}"}', true); ${statement}; rollback;`);
  /** Valeur scalaire lue avec ce rôle (ligne « RESULT:… » : les étiquettes de commande de psql sont ignorées). */
  const asRole = (role, sub, scalar) => {
    const output = rawAsRole(role, sub, `select 'RESULT:' || (${scalar})`);
    const line = output.split("\n").find((item) => item.startsWith("RESULT:"));
    if (line === undefined) throw new Error("aucun résultat");
    return line.slice("RESULT:".length);
  };
  const denied = (role, sub, statement) => {
    try {
      rawAsRole(role, sub, statement);
      return false;
    } catch (error) {
      return /permission denied/i.test(String(error.stderr ?? error.message));
    }
  };
  const anyUser = "00000000-0000-0000-0000-000000000000";
  check("anon n'a aucun accès aux publications", denied("anon", anyUser, "select count(*) from public.posts"));
  check("authenticated ne lit pas le schéma private", denied("authenticated", anyUser, "select * from private.app_secrets"));
  check("authenticated n'écrit pas directement dans les publications", denied("authenticated", anyUser, "update public.posts set text = text"));

  const pair = safe(
    `select m.user_id || '|' || p.id || '|' || (select q.id from public.posts q where q.ownership = 'assigned' and q.owner_organization_id <> m.organization_id and q.approval_status <> 'none' and q.removed_at is null limit 1)
     from public.organization_members m
     join public.profiles pr on pr.id = m.user_id and pr.role = 'client'
     join public.organizations o on o.id = m.organization_id and o.archived_at is null
     join public.posts p on p.owner_organization_id = m.organization_id and p.ownership = 'assigned' and p.approval_status <> 'none' and p.removed_at is null
     where exists (select 1 from public.posts q where q.ownership = 'assigned' and q.owner_organization_id <> m.organization_id and q.approval_status <> 'none' and q.removed_at is null)
     limit 1;`,
    "",
  );
  if (pair) {
    const [clientId, ownPost, otherPost] = pair.split("|");
    // Une lecture refusée (« permission denied ») est un constat d'échec, jamais un arrêt du contrôle.
    const reading = (name, expression, expected) => {
      try {
        const actual = asRole("authenticated", clientId, expression);
        check(name, actual === expected, `attendu ${expected}, obtenu ${actual}`);
        return actual;
      } catch (error) {
        const reason = /permission denied/i.test(String(error.stderr ?? "")) ? "permission denied" : String(error.message).split("\n")[0];
        check(name, false, reason);
        return null;
      }
    };
    reading("un client authentifié lit une de ses publications", `select count(*) from public.posts where id = '${ownPost}'`, "1");
    reading("le même client ne lit pas la publication d'un autre client", `select count(*) from public.posts where id = '${otherPost}'`, "0");
    const expected = one(`select count(*) from public.posts p where p.approval_status <> 'none' and p.removed_at is null and p.ownership = 'assigned' and p.owner_organization_id in (select organization_id from public.organization_members where user_id = '${clientId}');`);
    reading("ses publications visibles correspondent exactement à ses clients", "select count(*) from public.posts", expected);
  } else {
    console.log("NON VÉRIFIÉ  isolation entre deux clients : il faut au moins deux clients avec des publications dans la sauvegarde.");
  }
} finally {
  if (created && !keep) {
    try {
      pg.docker(["exec", "-i", container, "psql", "-U", sqlUser, "-d", "postgres", "-c", `drop database if exists ${dbName}`]);
    } catch (error) {
      console.error(`Suppression de ${dbName} impossible : ${error.message}`);
    }
  }
  created = false;
}

const failed = results.filter((result) => !result.ok);
console.log("");
if (failed.length === 0) {
  console.log(`BASE RESTAURÉE ET DROITS CONFORMES (${results.length} contrôles).`);
  console.log("Non couvert ici : service Auth, API HTTP, Storage servi. Lancez scripts/restore-drill.mjs pour la restauration complète.");
} else {
  console.log(`RESTAURATION NON VALIDÉE : ${failed.length} contrôle(s) en échec sur ${results.length}.`);
}
process.exit(failed.length === 0 ? 0 : 1);
