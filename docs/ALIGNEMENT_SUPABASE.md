# Alignement du projet Supabase distant : plan (NON exécuté)

**Rien de ce document n'a été appliqué.** Le projet distant n'a été ni lu ni modifié pendant les missions de stabilisation et de correction V3 (aucun accès distant autorisé). Toute valeur « distante » ci-dessous vient de l'audit du 9 octobre 2026 et **n'est pas re-qualifiée** : voir « Dérive distante non qualifiée ».

## Ce qu'il faut distinguer

| Notion | Question | Comment la vérifier |
| --- | --- | --- |
| **Équivalence du schéma** | Les objets (tables, colonnes, fonctions — par leur code source —, politiques, déclencheurs, droits) sont-ils ceux du niveau N ? | `supabase/outils/inventaire_lecture_seule.sql` puis `node scripts/schema-compare.mjs` (hors ligne) |
| **Inscription dans l'historique** | `supabase_migrations.schema_migrations` contient-elle la version ? | Requête A de l'inventaire. Peut être absente alors que les objets existent (migration appliquée au SQL Editor) |
| **Exécution d'une migration** | A-t-elle été jouée en entier, une fois, dans l'ordre ? | Journal de l'opérateur ; l'équivalence du schéma n'en est pas la preuve |

**Ne jamais** « réparer » l'historique (`supabase migration repair --status applied 0003`) sur la seule présence de deux marqueurs : l'objet peut être partiel ou d'une autre version. Si une réparation d'historique est un jour décidée, elle l'est **après** comparaison complète du schéma au niveau attendu et sur décision du propriétaire. **Aucun outil de ce dépôt n'applique une réparation distante.**

## Dérive distante non qualifiée

L'audit du 9 octobre 2026 a observé : 0001–0002 présentes et inscrites ; 0003 présente (fonctions) sans entrée d'historique ; 0004–0008 absentes ; 307 publications (298 simulées, 9 réelles). Ces constats ne sont **pas** vérifiés dans cette mission : **NON TESTÉ — schéma distant réel.** Aucune exportation représentative distante autorisée n'existe localement ; la fixture de 307 publications est synthétique.

## Inventaire en lecture seule (mission distante future)

1. Lancer `supabase/outils/inventaire_lecture_seule.sql` (SQL Editor ou `psql`) : requête A (historique), requête B (structure : colonnes, fonctions par `md5(prosrc)` avec signature, `SECURITY DEFINER`, `search_path`, déclencheurs, contraintes), requête C (droits, politiques RLS, privilèges par défaut).
2. Enregistrer B dans `structure.txt` et C dans `droits.txt`.
3. `node scripts/schema-compare.mjs --structure structure.txt --droits droits.txt` : compare aux empreintes attendues `supabase/outils/schema-attendu/niveau-{0003,0008,0009,0010,0011}.txt` (produites par le laboratoire sur PostgreSQL 17) et indique le niveau égalé ou le plus proche, avec les différences. Le code source des fonctions est comparé (stable d'une version de PostgreSQL à l'autre) ; les colonnes, contraintes et droits peuvent varier légèrement selon la plateforme : une différence est à **interpréter**, pas à « réparer ».
4. Dépendances : `select * from pg_depend …` n'est pas automatisé ; les déclencheurs sont inventoriés, les vues/matérialisées n'existent pas dans Cadence.

## Plan d'alignement, dans l'ordre (chaque étape demande l'accord du propriétaire)

1. **Sauvegarde** du projet réel (`scripts/backup.mjs --remote`, voir SAUVEGARDE.md), puis **restauration vérifiée sur une destination indépendante compatible** (Auth, API, Storage, droits). Ne pas continuer sans elle.
2. **Inventaire** (ci-dessus) ; décider avec le propriétaire de l'état réel.
3. **Appliquer les migrations manquantes une par une, dans l'ordre**, dans le SQL Editor (ou `supabase db push` seulement après avoir établi que l'historique correspond à la réalité). Après chacune : requêtes 1–3 de `supabase/outils/verification.sql`, comptes de la photographie inchangés, schéma comparé au niveau attendu. Les migrations 0009, 0010 et 0011 portent une **garde de prérequis** (échec net, base inchangée) et sont **rejouables à leur niveau**.
4. **Contrôles de données** après 0009/0010/0011 : `select ownership, count(*) from public.posts group by 1;` — les imports d'origine incertaine sont `ambiguous` (administrateur seul) ; aucun accord `approved` dont le propriétaire, l'approbateur ou la version ne correspond n'est programmable ; `select count(*) from public.posts where schedule_state in ('claimed','unschedule_pending');` à examiner avec l'opérateur (compensations à faire) **avant** de rouvrir les écritures.
5. **Publications simulées** : 298 `mock-…` cohabitent avec les réelles (décision à part ; aucune suppression faite).
6. **Paramètres hébergés** à contrôler à la main : bucket `media` privé, protection des mots de passe compromis, limites de débit d'authentification, URL de redirection, SMTP.

## Ce qui a été vérifié localement (mission V3)

`node scripts/migration-lab.mjs --template-prefix <pile>` (PostgreSQL 17 natif, image Supabase, rôles de la plateforme ; bases créées et supprimées par le script) :

- installation neuve 0001 → 0011 ; équivalence d'empreinte avec toute montée ;
- montée depuis 0003 **avec historique 0003 absent alors que ses objets existent** : la chaîne rejouée aboutit à l'empreinte d'une installation neuve ;
- montée 0008, 0009 et 0010 → 0011 ; avec fixture de **307 publications (298 simulées, 9 réelles)**, accords, commentaires, versions, canaux transféré/vide, réservation en cours, compensations en attente : publications, décisions, commentaires et versions conservés ; un client ne lit rien d'un autre ; aucun accord inéligible n'est programmable ;
- prérequis manquant : **échec net, base inchangée**, puis reprise (0010 puis 0011) ; migration interrompue en cours de route : transaction annulée en entier, reprise possible ;
- rejeu à son niveau : 0002–0011 sans erreur, empreinte inchangée (0001 non rejouable : migration historique, jamais réécrite). Rejouer une ancienne migration **après** une plus récente n'est pas un rejeu : c'est une régression, à interdire.

Les mêmes scénarios, sur PGlite : `tests/sql/migrations.test.ts`, `stabilisation.test.ts`, `contre-audit.test.ts`, `v3-correction.test.ts`.

## Retour arrière : plan en avant

Il n'existe **pas** de retour arrière pour 0010 et 0011 : revenir aux fonctions de 0009 rouvrirait les défauts corrigés (fuite entre clients, confirmation sans jeton, compensation différée). Un défaut se corrige **en avant** (nouvelle migration). `supabase/outils/0009_retour_arriere.sql` et les précédents existent mais **réouvrent des failles** : à réserver à une panne de la migration elle-même, avec gel des écritures, application compatible (version antérieure du code) et sans qu'il défasse ce que Buffer a déjà reçu. Ne **jamais** présenter la réouverture de politiques vulnérables comme une reprise normale.

Plan de récupération en avant : restaurer la sauvegarde (étape 1) sur une destination neuve, appliquer les migrations manquantes dans l'ordre, rapprocher les effets externes avec l'opérateur (programmations réellement présentes chez Buffer), puis basculer.

## Pourquoi pas `supabase db reset`

Il efface la base. Il n'est utilisé que sur une pile de TEST locale créée pour l'essai.
