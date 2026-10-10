-- Retour arrière de 0008 (Content Studio). À coller dans Supabase > SQL Editor.
-- Le Studio cesse de fonctionner ; les publications déjà envoyées dans Buffer continuent leur
-- circuit normal. Les tables, les médias déposés et l'historique des versions sont conservés
-- (règle du projet : aucune suppression de données). Plus aucun dépôt de média n'est possible.
begin;
drop trigger if exists posts_record_version on public.posts;
drop function if exists private.record_post_version();
drop function if exists public.studio_register_media(uuid, text, text, text, bigint, integer, integer, integer);
drop function if exists public.studio_set_media_archived(uuid, boolean);
drop function if exists public.studio_save_draft(uuid, integer, jsonb);
drop function if exists public.studio_reschedule_draft(uuid, integer, timestamptz);
drop function if exists public.studio_set_draft_archived(uuid, boolean);
drop function if exists public.studio_claim_push(uuid, boolean);
drop function if exists public.studio_complete_push(uuid, boolean, text, text, integer);
drop policy if exists cadence_media_insert on storage.objects;
commit;
