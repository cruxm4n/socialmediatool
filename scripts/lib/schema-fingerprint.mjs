// Empreinte structurelle d'un schéma Cadence : tables et colonnes, fonctions (source, signature, SECURITY DEFINER,
// search_path, propriétaire non comparé), déclencheurs, contraintes. Lecture seule : la même requête sert au
// laboratoire de migrations (scripts/migration-lab.mjs) et à l'inventaire à lancer plus tard sur un projet réel
// (supabase/outils/inventaire_lecture_seule.sql, identique à FINGERPRINT_SQL : un test le vérifie).
//
// Les fonctions sont comparées par leur CODE SOURCE (prosrc) et non par pg_get_functiondef : le texte rendu varie
// d'une version de PostgreSQL à l'autre, pas le source stocké.
export const FINGERPRINT_SQL = `
select 'column|' || table_schema || '.' || table_name || '.' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '')
from information_schema.columns where table_schema in ('public', 'private')
union all
select 'function|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(p.prosrc)
       || '|' || case when p.prosecdef then 'definer' else 'invoker' end || '|' || coalesce(p.proconfig::text, '')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
union all
select 'trigger|' || c.relname || '.' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal and n.nspname in ('public', 'private', 'storage')
union all
select 'constraint|' || c.relname || '.' || k.conname || '|' || pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid = k.conrelid
join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private')
order by 1;`;

/** Compare deux listes de lignes d'empreinte : ce qui manque (« - ») et ce qui est en trop (« + »). */
export function diffLines(expected, actual) {
  const left = new Set(expected);
  const right = new Set(actual);
  return [...expected.filter((line) => !right.has(line)).map((line) => `- ${line}`), ...actual.filter((line) => !left.has(line)).map((line) => `+ ${line}`)];
}
