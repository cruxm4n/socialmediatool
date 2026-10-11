-- Retour arrière de 0013 — À NE PAS APPLIQUER SANS DÉCISION ÉCRITE. Document de portée, pas une procédure courante.
--
-- Le retour normal après un déploiement raté est APPLICATIF : on remet l'image précédente, la base reste en 0013.
--   - L'application 2f51602 (avant les connexions) fonctionne sur une base 0013 : son relevé « sans périmètre » ne
--     vaut que pour le compte historique de son mode ; il ne retire ni ne modifie rien des comptes des clients
--     (tests N18 et N24 de tests/integration/multi-comptes.test.ts, laboratoire de migrations).
--   - L'application 4e132cb (connexions, sans cycle de vie) NE DOIT PAS être remise sur une base 0013 dès qu'un compte
--     réel existe : elle enregistrait les clés par une session (fonction désormais fermée) et ne relit pas l'état
--     durable des connexions. Elle n'a jamais été déployée ; ne pas la déployer.
--
-- Ce script ne supprime AUCUNE donnée : colonnes, connexions, clés chiffrées, journal et identités constatées restent.
-- Il retire seulement les deux garde-fous de réservation, ce qui RÉOUVRE le défaut P1-01 (une réservation peut
-- aboutir sur une connexion en cours de révocation). Il n'a de sens que pour diagnostiquer un blocage de réservation
-- attribué à ces garde-fous, sur une base de travail, jamais comme mesure durable en production.
-- Les fonctions redéfinies par 0013 (sync_buffer_posts, provider_connections_for_run, schema_status, révocation,
-- création de connexion) NE sont PAS remises à leur version 0012 : celle-ci contient les défauts corrigés
-- (collision de publication, ancien appelant non borné, clé sans identité). Les rejouer depuis 0012 serait une
-- régression de sécurité.
-- Préalable : sauvegarde fraîche et restaurée (docs/SAUVEGARDE.md).
begin;
drop trigger if exists posts_schedule_claim_guard on public.posts;
drop trigger if exists studio_variants_push_claim_guard on public.studio_variants;
commit;
