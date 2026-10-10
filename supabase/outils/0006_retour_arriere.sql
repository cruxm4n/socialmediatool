-- Retour arrière de 0006 (synchronisation planifiée). À coller dans Supabase > SQL Editor.
-- L'application fonctionne sans ces fonctions : elle se contente alors du verrou interne au serveur.
-- La table sync_state est conservée (règle du projet : aucune suppression de données) ; elle ne gêne pas.
begin;
drop function if exists public.begin_sync_run(text, text, text, boolean, integer);
drop function if exists public.finish_sync_run(text, text, uuid, boolean, text, integer, text, jsonb);
commit;
