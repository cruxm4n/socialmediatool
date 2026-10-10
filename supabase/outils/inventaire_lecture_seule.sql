-- INVENTAIRE EN LECTURE SEULE d un schéma Cadence (à coller dans Supabase > SQL Editor, ou psql). Aucune ligne n est
-- modifiée, aucune fonction créée. À lancer dans une mission distincte AUTORISÉE, jamais pendant une mission locale.
-- Résultats à enregistrer dans deux fichiers texte puis à comparer hors ligne :
--   node scripts/schema-compare.mjs --structure structure.txt --droits droits.txt
-- Équivalence du schéma ≠ entrée d historique ≠ migration exécutée. Aucune réparation d historique n est préconisée sur
-- la seule présence de marqueurs : voir docs/ALIGNEMENT_SUPABASE.md.

-- A. Historique de migrations (peut être absent : migrations appliquées au SQL Editor sans enregistrement).
select case when to_regclass('supabase_migrations.schema_migrations') is null then 'historique absent'
            else (select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations) end as historique;

-- B. Structure : tables/colonnes, fonctions (source), déclencheurs, contraintes -> enregistrer dans structure.txt
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
order by 1;

-- C. Droits, politiques RLS, privilèges par défaut -> enregistrer dans droits.txt (colonnes séparées par « | »)
select 'table' as kind, n.nspname || '.' || c.relname as object, coalesce(c.relacl::text, '') as acl,
       pg_get_userbyid(c.relowner) as owner,
       c.relkind::text || case when c.relrowsecurity then ':rls' else ':norls' end || case when c.relforcerowsecurity then ':force' else '' end as detail
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'private', 'auth', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'S')
union all
select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', coalesce(p.proacl::text, ''),
       pg_get_userbyid(p.proowner), case when p.prosecdef then 'definer' else 'invoker' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private', 'auth', 'storage')
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
union all
select 'schema', nspname, coalesce(nspacl::text, ''), pg_get_userbyid(nspowner), ''
from pg_namespace where nspname in ('public', 'private', 'auth', 'storage')
union all
select 'column', n.nspname || '.' || c.relname || '.' || a.attname, a.attacl::text, pg_get_userbyid(c.relowner), ''
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where a.attacl is not null and not a.attisdropped and n.nspname in ('public', 'private', 'auth', 'storage')
union all
select 'policy', schemaname || '.' || tablename || '.' || policyname, '', '',
       md5(coalesce(cmd, '') || '|' || coalesce(roles::text, '') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
from pg_policies where schemaname in ('public', 'private', 'auth', 'storage')
union all
select 'default_acl', n.nspname || '.' || d.defaclobjtype::text || '.' || pg_get_userbyid(d.defaclrole), coalesce(d.defaclacl::text, ''), '', ''
from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname in ('public', 'private', 'auth', 'storage')
order by 1, 2;
