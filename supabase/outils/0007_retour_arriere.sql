-- Retour arrière de 0007 (notifications). À coller dans Supabase > SQL Editor.
-- Plus aucune notification n'est mise en file d'attente ni envoyée. Les tables et leur contenu
-- (préférences, historique) sont conservés : règle du projet, aucune suppression de données.
begin;
drop trigger if exists post_events_notify on public.post_events;
drop function if exists private.enqueue_notifications();
drop function if exists public.set_notification_preferences(boolean, boolean, boolean, boolean);
drop function if exists public.claim_notifications(text, text, integer);
drop function if exists public.complete_notifications(text, uuid[], text, text);
commit;
