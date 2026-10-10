-- Contrôles en lecture seule, à coller dans Supabase > SQL Editor. Aucune ligne n'est modifiée.

-- 1. Quelles migrations sont en place ? (une ligne, cinq colonnes true/false)
select
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'decide_post' and p.prosrc like '%date_invalid%')            as "0002 appliquée",
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'claim_posts_for_scheduling_in_mode')                         as "0003 appliquée (fonctions)",
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = 'post_hash' and p.prosrc like '%jsonb_build_object%')        as "0003 appliquée (empreinte)",
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'sync_buffer_posts' and p.prosrc like '%confirmedGone%')      as "0004 appliquée",
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'admin_assign_channel')                                      as "0005 appliquée";

-- 2. Photographie des données : à lancer AVANT et APRÈS, les deux résultats doivent être identiques.
select
  (select count(*) from public.posts)                                                          as posts,
  (select count(*) from public.posts where approval_status = 'approved')                       as approuves,
  (select count(*) from public.posts where approval_status = 'approved'
                                       and approved_hash is distinct from content_hash)        as approuves_incoherents,
  (select count(*) from public.posts where removed_at is not null)                             as supprimes,
  (select count(*) from public.approval_decisions)                                             as decisions,
  (select count(*) from public.comments)                                                       as commentaires,
  (select count(*) from public.post_events)                                                    as evenements,
  (select count(*) from public.organizations)                                                  as clients,
  (select count(*) from public.organization_members)                                           as acces,
  (select count(*) from public.channels where organization_id is not null)                     as canaux_attribues;

-- 3. Droits : la fonction de synchronisation doit rester appelable par anon et authenticated (deux fois true).
select has_function_privilege('anon', 'public.sync_buffer_posts(text, jsonb)', 'execute')          as anon,
       has_function_privilege('authenticated', 'public.sync_buffer_posts(text, jsonb)', 'execute') as authenticated;

-- 4. Sauvegarde de la fonction actuelle : copier le résultat dans un fichier avant d'appliquer 0004.
select pg_get_functiondef('public.sync_buffer_posts(text, jsonb)'::regprocedure);

-- 5. Migrations suivantes (une ligne, true/false)
select
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'begin_sync_run')                                            as "0006 appliquée",
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'claim_notifications')                                       as "0007 appliquée",
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'studio_save_draft')                                         as "0008 appliquée";

-- 6. Corrections des deux audits (une ligne, true/false) : 0009 (appartenance explicite, jeton) et 0010 (contre-audit).
select
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'posts' and column_name = 'owner_organization_id')           as "0009 appliquée (propriétaire explicite)",
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'posts' and column_name = 'schedule_token')                  as "0009 appliquée (jeton)",
  to_regclass('public.channel_owner_history') is not null                                                           as "0010 appliquée (historique des canaux)",
  exists (select 1 from pg_trigger where tgname = 'channels_owner_guard' and not tgisinternal)                        as "0010 appliquée (garde du propriétaire)",
  exists (select 1 from pg_trigger where tgname = 'organization_members_revoke_approvals' and not tgisinternal)       as "0010 appliquée (approbations révoquées)",
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'get_sync_pause')                                               as "0010 appliquée (pause de quota)";

-- 7. Migration 0011 (correction V3) : traitement urgent, identité des tentatives d'envoi, revalidation des notifications
--    (une ligne, true/false). Toutes à true une fois 0011 appliquée.
select
  to_regclass('public.studio_push_events') is not null                                                   as "0011 : journal des tentatives",
  to_regprocedure('public.begin_urgent_run(text, text, integer)') is not null                            as "0011 : verrou du traitement urgent",
  to_regprocedure('public.mark_unschedule_needed(text, uuid, text)') is not null                          as "0011 : annulation demandée",
  to_regprocedure('public.schema_status(text)') is not null                                               as "0011 : état du schéma",
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sync_state' and column_name = 'backoff_hard') as "0011 : pause « refus »",
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_variants' and column_name = 'push_attempt_id') as "0011 : identité de tentative";

-- 8. Urgences en cours à examiner AVANT de rouvrir les écritures (annulations à confirmer, réservations abandonnées).
select count(*) filter (where schedule_state = 'unschedule_pending') as annulations_a_confirmer,
       count(*) filter (where schedule_state = 'claimed')            as reservations_en_cours,
       min(unschedule_since) filter (where schedule_state = 'unschedule_pending') as plus_ancienne_annulation
from public.posts where removed_at is null;
