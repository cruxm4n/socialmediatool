-- Retour arrière de 0012 (connexions fournisseur). Ne supprime AUCUNE donnée : les tables et la colonne restent.
-- Effet : la lecture du fournisseur redevient celle de 0009 (sans connexion d'origine), l'état du schéma n'exige
-- plus 0012. À n'utiliser qu'avec l'ancienne version de l'application (2f51602), qui ignore les connexions.
-- Préalable : sauvegarde fraîche. Les garde-fous (déclencheurs) sont retirés pour que l'ancienne application
-- continue d'écrire des canaux sans connexion.
begin;
drop trigger if exists channels_connection_guard on public.channels;
-- La fonction public.sync_buffer_posts de 0009 doit être rejouée depuis supabase/migrations/0009_stabilisation.sql
-- (section 7) ; public.schema_status depuis 0011 (section 5). Ces deux « create or replace » sont rejouables.
commit;
