-- Retour arrière de 0014 — À NE PAS APPLIQUER SANS DÉCISION ÉCRITE. Document de portée, pas une procédure courante.
--
-- Le retour normal après un déploiement raté est APPLICATIF : on remet l'image précédente, la base reste en 0014.
--   - 0014 ne crée ni table, ni colonne, ni politique : elle redéfinit decide_post, sync_buffer_posts et
--     schema_status, et ajoute le marqueur private.validation_rules_version(). Les signatures sont inchangées.
--   - L'application 68e1e85 (avant 0014) fonctionne sur une base 0014 : son contrôle de préparation ignore le niveau
--     0014, et ses écrans refusent seulement, côté navigateur, l'approbation d'un brouillon sans date.
--
-- Revenir aux règles d'avant (accord refusé sans date, accord retiré avec le tag) demanderait de rejouer les
-- définitions de decide_post (0009) et de sync_buffer_posts (0013). Ce n'est PAS fait ici, volontairement :
--   - un accord déjà donné sur un brouillon sans date resterait enregistré, mais serait annulé dès que l'agence
--     fixerait la date dans Buffer : le client devrait revalider sans que rien n'ait changé pour lui ;
--   - un accord dont le tag a été retiré depuis serait retiré à la synchronisation suivante.
-- Aucune donnée n'est supprimée par 0014 ; il n'y a donc rien à restaurer côté données.
-- Ce script retire uniquement le marqueur de niveau, pour qu'une base de travail se déclare de nouveau « 0013 ».
-- Préalable : sauvegarde fraîche et restaurée (docs/SAUVEGARDE.md).
begin;
drop function if exists private.validation_rules_version();
commit;
