# Tests

## Lancer les tests

```bash
npm run check       # lint + typage + tests des règles et des migrations + compilation
npm run test        # règles (tests/unit) et migrations SQL sur une base locale en mémoire (tests/sql)
npm run test:db     # base Supabase de TEST dédiée (variables TEST_*) : isolation, concurrence, programmation
npm run test:e2e    # parcours dans un navigateur, Buffer simulé, port 3100, même base de test
```

## Migrations SQL : vérification locale et application (9 octobre 2026)

`tests/sql/` exécute les migrations `0001` à `0004` sur un vrai PostgreSQL **en mémoire** (PGlite), créé et jeté à chaque test. Rien ne touche à Supabase. Sont vérifiés : l'application dans l'ordre sur une base vide, la montée de version depuis l'état actuel de la base (`0001` + `0002` avec des validations existantes, qui doivent être conservées), la séparation réel/simulé, l'annulation des validations, les posts absents de Buffer, l'isolation entre clients (RLS) et les droits d'exécution.

Limite : ce n'est pas Supabase. L'API HTTP, la connexion par mot de passe et les droits par défaut réels du projet ne sont pas couverts ; `test:db` et `test:e2e` restent nécessaires sur un projet Supabase de test.

**État de la base `socialflow-dev`, sondé en lecture seule le 9 octobre 2026 : `0001`, `0002` et `0003` appliquées** (les 306 empreintes sont au nouveau format, les 52 validations conservées). **`0004` : à vérifier** avec la requête 1 de `supabase/outils/verification.sql` — elle n'est pas détectable sans écrire.

Pour appliquer `0004` : dans Supabase → *SQL Editor*, lancer les requêtes 2 et 4 de `supabase/outils/verification.sql` et garder leurs résultats, coller et exécuter `supabase/migrations/0004_fiabilite_statuts.sql`, puis relancer les requêtes 1, 2 et 3. Le fichier s'exécute en une transaction et ne modifie aucune donnée. Retour arrière : `supabase/outils/0004_retour_arriere.sql` (testé localement).

## Résultats du 8 octobre 2026 (après l'audit de nuit)

| Vérification | Commande | Résultat |
| --- | --- | --- |
| Lint | `npm run lint` | Aucune erreur, aucun avertissement |
| TypeScript | `npm run typecheck` | Aucune erreur |
| Règles et couche de service | `npm run test` | 48 réussis sur 48 |
| Compilation | `npm run build` | Réussie |
| Base de données | `npm run test:db` | 25 réussis sur 25 |
| Parcours | `npm run test:e2e` | 34 réussis sur 34 |
| Essai réel Buffer | manuel, scripté | Réussi, rejoué après l'audit |

| Suite | Avant l'audit | Après |
| --- | --- | --- |
| Règles | 30 | 48 |
| Base | 22 | 25 |
| Parcours | 26 | 34 |

## Essais sur le vrai Buffer

Compte de test, canal X « Amollety ». Posts sur le thème du rugby, datés du 15 décembre 2026, jamais publiés, tous supprimés.

### Essai 1 — capacités de l'API

| # | Opération | Résultat |
| --- | --- | --- |
| 1 | Création du tag « À valider » | OK |
| 2 | Création d'un brouillon daté et tagué | OK — statut `draft`, date conservée |
| 3 | Lecture des brouillons filtrés par tag | OK |
| 4 | Brouillon → programmé, sans renvoyer le texte | **Échec** : « Post must have either text or media. » |
| 5 | Brouillon → programmé, texte renvoyé | OK — statut `scheduled`, date identique, image et tag conservés |
| 6 | Programmé → brouillon | OK — statut `draft` |
| 7 | Suppression, puis contrôle | OK — zéro post restant |

L'échec de l'étape 4 a conduit à renvoyer systématiquement le texte validé (`buffer-provider.ts`).

### Essai 2 — le parcours complet à travers l'application

| # | Étape | Constaté |
| --- | --- | --- |
| 1 | Deux brouillons créés dans Buffer : un tagué, un non tagué | Statut `draft` pour les deux |
| 2 | Synchronisation | 2 lus, 2 créés |
| 3 | L'admin rattache le canal X à Maison Colibri | « Canal rattaché au client. » |
| 4 | Liste admin | Tagué : « À valider ». Non tagué : « Brouillon » |
| 5 | Inès (Maison Colibri) | Voit uniquement le post tagué |
| 5 bis | Sofia (Nordwind Cycles) | Ne voit aucun des deux |
| 6 | Inès approuve | « Publication approuvée et programmée dans Buffer. » |
| 7 | Lecture dans Buffer | Statut `scheduled`, date 15 décembre 10:00 UTC, texte identique |
| 7 bis | Brouillon non tagué dans Buffer | Toujours `draft` |
| 8 | Deux synchronisations de suite | Aucune reprogrammation |
| 9 | Texte modifié dans Buffer, post programmé | Buffer le laisse programmé |
| 10 | Synchronisation | 1 validation annulée, 1 déprogrammé |
| 11 | Lecture dans Buffer | Statut `draft` |
| 12 | Côté cliente | De nouveau « À valider », version 2, historique complet |
| 13 | Suppression des deux posts | OK |
| 14 | Contrôle final dans Buffer | Zéro post |
| 15 | Synchronisation finale | 2 posts marqués supprimés |

Quota consommé par l'ensemble des essais : environ 40 requêtes sur 500 par jour.

### Essai 3 — même parcours, rejoué après l'audit de nuit

Mêmes quinze étapes, mêmes résultats. Un post personnel de l'utilisateur, programmé pour le 14 octobre, était présent dans le compte : il a été lu par la synchronisation, affiché, et n'a subi aucune modification. Contrôle final : zéro post de test restant.

Un premier lancement s'était arrêté à l'étape 3 sur une erreur du script d'essai (attente d'un message qui ne s'affiche pas quand le canal est déjà rattaché). Les deux posts créés ont été supprimés avant de relancer.

## Ce que couvrent les tests automatiques

### Règles et couche de service (`tests/unit/`, 48 tests)

- **Couche de service isolée** (`sync.test.ts`) : rien n'est programmé si le texte, la date ou les médias ont changé dans Buffer ; ni si le post a disparu ou n'est plus un brouillon ; pas de reprogrammation d'un post déjà programmé ; arrêt des appels dès que le quota est atteint ; un refus sur un post n'empêche pas les suivants ; ordre lecture → déprogrammation → programmation ; échec enregistré si Buffer est injoignable.
- Client Buffer : nouvel essai d'une lecture après une panne, jamais d'une écriture ; erreurs 5xx et 401 ; aucun canal renvoyé.
- Date prévue utilisable ; lien externe limité à `http(s)`.

- Statut affiché à partir des trois états ; alertes pour l'admin ; droit de décider.
- Client Buffer avec un faux réseau : lecture des canaux et posts, reconnaissance du tag, clé transmise, texte renvoyé à la programmation, médias renvoyés si le post n'a pas de texte, refus sans date, refus de Buffer remonté, quota dépassé, panne réseau.
- Comparaison du contenu validé et du contenu présent dans Buffer.
- Dates : fuseaux, changement d'heure, grille du calendrier.

### Base de données (`tests/integration/`, 25 tests)

- **Garde-fous de l'audit** : approbation refusée si la date est passée ou absente ; un client ne lit pas les événements techniques, même par l'API ; une validation tombe si la date est avancée dans le passé.

- **Isolation** : un client ne lit que les posts soumis de son organisation ; pas les brouillons ; pas le journal ; un visiteur non connecté ne lit rien ; personne n'écrit directement dans les tables ; un client ne décide ni ne commente chez un autre ; seul l'admin rattache un canal ; les fonctions d'automatisation exigent le secret.
- **Décision** : refus pour un admin ; refus d'une version périmée ; commentaire obligatoire pour une demande de modifications ; **deux validations simultanées, une seule retenue** ; refus si le post n'est plus un brouillon.
- **Programmation** : jamais pour un post non approuvé, refusé ou à date passée ; **deux programmations simultanées, une seule réservation** ; nouvelle tentative après échec.
- **Synchronisation** : rejouable sans effet ; validation annulée et déprogrammation demandée après modification ; nouvelle version après correction ; suivi du tag ; retour en brouillon dans Buffer ; post disparu marqué, jamais effacé.

### Parcours (`tests/e2e/`, 34 tests)

- **Ajouts de l'audit** : en-têtes de sécurité ; session expirée pendant une action ; indicateur cliquable ; menu mobile ; aucun débordement horizontal sur les onze pages en 390 px ; unicité des publications dans la liste ; date dépassée non approuvable ; publication suivante à valider ; décisions accessibles en bas d'écran sur mobile ; adresse d'une publication supprimée.

- **Accès** : renvoi vers la connexion ; mauvais mot de passe ; chaque rôle dans son espace ; déconnexion ; routes d'automatisation fermées sans secret.
- **Isolation** : un client ne voit pas l'autre ; l'espace d'un autre client renvoie 404 ; l'espace admin lui est fermé ; l'adresse directe d'une publication d'un autre client ne révèle rien.
- **Admin** : navigation ; absence de tout outil de création ; synchronisation et journal ; filtres et recherche ; brouillon non tagué ; alerte « programmé sans validation » ; erreur Buffer ; commentaire ; calendrier ; rattachement d'un canal avec effet immédiat côté client.
- **Validation** : approbation → programmation, une seule fois malgré des synchronisations répétées ; demande de modifications ; commentaire ; calendrier client.
- **Cas difficiles** : publication modifiée pendant la relecture ; cycle complet demande → correction → approbation ; modification après programmation ; échec de programmation puis rattrapage ; tag posé puis post supprimé.

## Correspondance avec vos exigences

| Exigence | Vérifiée par |
| --- | --- |
| Appels API et transitions de statut | Tests des règles, essais réels |
| Une publication non validée ne peut pas être programmée | Test de base « ne réserve jamais… », parcours, essai réel 7 bis |
| Pas de double programmation | Test de base « deux programmations simultanées », parcours « une seule fois » |
| Pas de validations concurrentes | Test de base « deux validations simultanées » |
| Droits d'accès entre clients | 8 tests de base, 4 parcours, essai réel 5 bis |
| Aucun client n'accède à la clé Buffer | Clé lue uniquement dans des fichiers `server-only` ; non vérifié par un test dédié |

## Bugs trouvés par les tests

Liste complète et corrections dans [NIGHT_REPORT.md](NIGHT_REPORT.md). Les principaux :

- **Pages élargies sur mobile** (926 px sur un écran de 390 px).
- **Publication approuvée jamais retentée** après cinq échecs de programmation.
- **Session expirée sans effet visible** lors d'une action.
- **Approbation possible d'une publication à date passée.**
- **Déconnexion globale** : se déconnecter fermait les sessions des autres appareils.
- **Détail technique visible du client** dans l'historique.

## Limites connues

- Les tests de base et de parcours utilisent la base de développement et y laissent des données préfixées `mock-`, invisibles en mode réel. Nettoyage : voir DECISIONS.md, D13.
- Non essayé sur le vrai Buffer : vidéo, post sans texte, Instagram, TikTok, médias téléversés dans Buffer.
- Une page de publication introuvable s'affiche correctement mais avec un code HTTP 200 au lieu de 404.
- Navigation au clavier et lecteurs d'écran : non testés de façon systématique.
- `Dockerfile` et `docker-compose.yml` : jamais exécutés.
- `npm audit` signale 9 vulnérabilités « high ». Analysées : toutes viennent du paquet `braces`, sans version corrigée disponible, utilisé uniquement par des outils de développement.
- Supabase prévient que Node.js 20 ne sera bientôt plus pris en charge : passer à Node 22.

## Garde-fou ajouté pendant la session Codex

Les suites DB et E2E écrivent dans Supabase. Elles exigent désormais une configuration dédiée : `TEST_SUPABASE_URL`, `TEST_SUPABASE_PUBLISHABLE_KEY`, `TEST_AUTOMATION_SECRET` et `TEST_DEMO_{ADMIN,INES,HUGO,SOFIA}_{EMAIL,PASSWORD}`. Aucune valeur provenant des identifiants applicatifs ne sert de repli. Une URL distante identique à celle de l'application est refusée. Utiliser un projet de test exclusivement dédié, avec les migrations 0001, 0002 et 0003 et les comptes de démonstration préparés pour ce projet. Le préfixe mock ne remplace pas l'isolation de la base.

La migration 0003 est préparée mais NON appliquée. Les tests DB/E2E n'ont pas été lancés dans cette session faute de configuration isolée vérifiée. Leurs résultats historiques ci-dessus ne valident pas le nouveau diff.

Les E2E utilisent `.next-test` pour préserver `.next` du serveur de développement. Pour compiler localement de la même manière : `ISOLATED_BUILD=1 BUFFER_MODE=mock npm run build`.

## Vérification navigateur sans Supabase

Après la compilation isolée, `npm run test:ui` monte uniquement le composant calendrier dans Chromium avec des données locales. Tous les accès réseau du navigateur sont bloqués ; les styles proviennent de `.next-test`. Vérifications : sélection au clavier, détail mobile, compteur filtré, navigation mois/semaine et absence de débordement à 320, 390, 768 et 1440 px. Ce banc utilise une ancre à la place du routeur Next.js ; il ne valide pas la navigation entre pages, les sessions ou les décisions en base.

## Résultats de la session Codex autonome

66/66 tests unitaires réussis ; lint, typage et compilation isolée réussis. Banc calendrier Chromium réussi sans réseau. Suites DB/E2E non exécutées sur une base distante ; leur refus sans configuration isolée a été vérifié. Migration 0003 préparée et non appliquée. Détails et tâches restantes : [CODEX_REPORT.md](CODEX_REPORT.md).

## Résultats du 9 octobre 2026 (corrections de fiabilité)

| Vérification | Commande | Résultat |
| --- | --- | --- |
| Lint | `npm run lint` | Aucune erreur |
| TypeScript | `npm run typecheck` | Aucune erreur |
| Règles et couche de service | `npm run test` (tests/unit) | 71 réussis sur 71 |
| Migrations et fonctions SQL | `npm run test` (tests/sql) | 16 réussis sur 16, base locale en mémoire |
| Compilation | `ISOLATED_BUILD=1 BUFFER_MODE=mock npm run build` | Réussie |
| Base Supabase | `npm run test:db` | **Non exécuté** : aucune base de test (`TEST_SUPABASE_URL` absent) |
| Parcours | `npm run test:e2e` | **Non exécuté** : même raison |
| Essai réel Buffer | — | **Non exécuté** (aucun appel à Buffer pendant cette session) |

Les tests SQL ont été contrôlés à rebours : sans la migration `0004`, cinq d'entre eux échouent.

## Gestion des clients (9 octobre 2026)

Migration `0005_gestion_clients.sql` : **testée localement, non appliquée à Supabase.** À appliquer après `0004`, de la même façon ; retour arrière dans `supabase/outils/0005_retour_arriere.sql`. Sans elle, les écrans s'affichent et le rattachement simple d'un canal fonctionne comme avant ; créer, modifier, archiver un client, transférer un canal et gérer les accès répondent « migration 0005 requise ».

| Vérification | Résultat |
| --- | --- |
| Lint, TypeScript, compilation | Réussis |
| `npm run test` | 109 réussis : 79 règles et service, 30 SQL sur base locale |
| Écrans dans un navigateur (liste, fiche, formulaire, 1360 / 390 / 320 px) | Affichés sans erreur ni débordement, en lecture seule sur la base réelle |
| `npm run test:e2e` (dont `04-clients.spec.ts`, nouveau) | **Non exécuté** : aucune base de test |
| Création, archivage, transfert, accès à travers l'interface | **Non exécutés** : ils écriraient dans la base réelle, qui n'a pas la migration |

Les tests SQL couvrent : droits réservés à l'administrateur, fin des écritures directes, création et modification d'un client, archivage, rattachement, plusieurs comptes d'un même réseau, transfert avec confirmation, invisibilité de l'historique de l'ancien client (publications, commentaires, décisions, événements, profils, et tentative directe par identifiant), association et dissociation d'utilisateurs, ajout par e-mail, montée de version et retour arrière.

## Cadence V2 et Content Studio (9 octobre 2026)

Branches `v2/fondations` puis `studio/content-studio`. **Rien n'a été appliqué à Supabase, aucun appel réel à Buffer, aucun e-mail envoyé, rien de déployé.**

| Vérification | Commande | Résultat |
| --- | --- | --- |
| Lint | `npm run lint` | Aucune erreur, aucun avertissement |
| TypeScript | `npm run typecheck` | Aucune erreur |
| Règles, couche de service, migrations | `npm run test` | **280 réussis sur 280** (19 fichiers) |
| Compilation | `npm run build` | Réussie, 26 routes |
| Base Supabase de test | `npm run test:db` | **Non exécuté** : aucune base de test dédiée |
| Parcours navigateur | `npm run test:e2e` | **Non exécuté** : même raison. `05-v2.spec.ts` et `06-studio.spec.ts` sont écrits mais n'ont jamais tourné |
| Écrans dans un vrai navigateur | — | **Non vérifiés à l'œil.** Ouvrir l'espace admin sur la base réelle aurait déclenché une synchronisation, donc des écritures |

Avant cette session : 109 tests. Détail des 280 :

| Fichier | Tests | Ce qui est vérifié |
| --- | --- | --- |
| `tests/sql/migrations.test.ts` | 19 | Les huit migrations dans l'ordre ; montée de version depuis une base utilisée ; **0004 et 0005 appliquées dans l'ordre inverse et rejouées** |
| `tests/sql/gestion-clients.test.ts` | 12 | Inchangé (0005) |
| `tests/sql/sync-planifiee.test.ts` | 8 | Verrou par mode, expiration, jeton périmé, pause planifiée, droits, retour arrière de 0006 |
| `tests/sql/notifications.test.ts` | 16 | Chaque déclencheur, anti-doublon, préférences, client archivé et canal transféré, annulation des demandes périmées, nouvelles tentatives, droits, retour arrière de 0007 |
| `tests/sql/studio.test.ts` | 17 | Droits du Studio et du stockage, médias, révisions, **anti-doublon d'envoi**, envoi interrompu, canal transféré, circuit de validation inchangé, versions, retour arrière de 0008 |
| `tests/unit/admin-actions.test.ts` | 23 | Actions d'administration : refus client et sans session, messages, transfert, base sans 0005 |
| `tests/unit/sync.test.ts` | 33 | Dont 9 nouveaux : verrou, pause sur quota, anomalies, base sans 0006, remise des notifications |
| `tests/unit/sync-health.test.ts` | 9 | États à jour / en retard / en échec / en pause, quota Buffer |
| `tests/unit/notifications.test.ts` | 11 | Rédaction des messages, mode simulation par défaut, webhook, échecs |
| `tests/unit/inbox.test.ts` | 10 | Classement « À traiter », liens Buffer |
| `tests/unit/ecrans.test.tsx` | 7 | Rendu du bandeau « À traiter » et de l'écran Synchronisation |
| `tests/unit/provider.test.ts` | 26 | Dont 7 nouveaux : création, mise à jour et déplacement d'un brouillon ; **jamais programmé** |
| `tests/unit/studio.test.ts` | 17 | Hashtags, formats par réseau, contrôles avant envoi, conflits, vues calendrier |
| `tests/unit/studio-push.test.ts` | 12 | Envoi vers Buffer : contenu, mise à jour sans recréation, refus, pannes, identifiant conservé |
| `tests/unit/studio-actions.test.ts` | 24 | Droits des actions du Studio, déplacement au calendrier, approbation groupée |
| Autres (`clients`, `dates`, `status`, `test-env`) | 36 | Inchangés |

### Ce que ces tests ne prouvent pas

- **Ils n'exercent ni Supabase ni Buffer réels.** La base est un PostgreSQL en mémoire qui imite Supabase ; Buffer est un faux réseau ou le Buffer simulé. Les requêtes GraphQL du Studio sont conformes au schéma de l'API, lu le 9 octobre 2026, mais aucune n'a été exécutée.
- **Aucun écran n'a été vu dans un navigateur.** L'éditeur du Studio, la bibliothèque de médias, le glisser-déposer du calendrier et l'approbation groupée compilent, passent le typage et le lint ; leur logique est testée ; leur rendu et leur ergonomie ne le sont pas. C'est le premier point à contrôler.
- **Le dépôt de fichiers** (navigateur → stockage Supabase) n'a jamais tourné.

### Pour lever ces réserves

1. Un projet Supabase de test, les huit migrations, les variables `TEST_*` : `npm run test:db` puis `npm run test:e2e` couvrent alors les parcours V2 et Studio en Buffer simulé.
2. Un essai réel du Studio sur le canal de test Buffer, décrit dans docs/STUDIO.md.

## Validation réelle avant mise en service (9 octobre 2026) — branche `validation/pilote`

Première exécution de `test:db` et `test:e2e`, sur une **base Supabase locale** (Postgres 17 de Supabase, authentification, API REST et stockage, dans Docker : voir [docs/BASE_DE_TEST.md](docs/BASE_DE_TEST.md)). **Ceci remplace les mentions « non exécuté » des sections précédentes.** La production n'a jamais été touchée ; Buffer est resté simulé ; aucun e-mail n'est parti.

| Vérification | Résultat | Nature |
| --- | --- | --- |
| Migrations `0001` à `0008` sur Supabase local | Appliquées dans l'ordre | **Réel** (moteur Supabase, pas la base en mémoire) |
| Audit RLS et droits sur ce moteur | Toutes les tables avec RLS ; `anon` sans droit sur les tables ; aucune écriture directe pour `authenticated` ; bucket `media` privé, politiques lecture/dépôt seulement | **Réel** |
| `npm run lint`, `npm run typecheck` | Aucune erreur, aucun avertissement | |
| `npm run test` | **281 / 281** | Mocks et base en mémoire |
| `npm run test:db` | **28 / 28** | **Réel** (base locale) |
| `npm run test:e2e` | **63 / 63**, depuis une base **vierge** | **Réel** (Chromium) pour l'interface, la base et le stockage ; **Buffer simulé** |
| Captures et mesures, bureau 1440 px et mobile 390 px, 18 écrans | Aucun débordement, aucune erreur JavaScript, aucune réponse HTTP 5xx | **Réel** |
| Image Docker : construction, démarrage isolé, connexion, dépôt d'un média | Réussis (`scripts/smoke-docker.mjs`) | **Réel** (conteneur local, base de test) |
| Appels à Buffer (création, mise à jour, changement de date, programmation) | Vérifiés **contre le Buffer simulé et un faux réseau uniquement** | **Pas testé en réel** |
| Envoi d'e-mails | Mode simulation uniquement | **Pas testé en réel** |
| Planificateur (cron, service Docker `scheduler`, workflow n8n) | Script vérifié contre une adresse injoignable ; non démarré | **Pas testé en réel** |

### Parcours pilote (`tests/e2e/07-pilote.spec.ts`)

Créer un client → rattacher un canal → accès d'une cliente → rédiger dans le Studio → déposer une image (vrai dépôt dans le stockage de test) → envoyer en validation → la cliente voit le texte, les hashtags et l'image → demande de modification → correction dans le Studio → renvoi (le même brouillon est mis à jour) → approbation → programmation → statuts concordants côté admin et client → archivage, accès coupé au client, restauration. **Réussi de bout en bout.**

### Défauts trouvés par l'exécution réelle, tous corrigés

| Défaut | Gravité | Comment il a été trouvé |
| --- | --- | --- |
| **Média ajouté pendant la création d'un contenu perdu en silence** : l'éditeur affichait « Enregistré » alors que la base n'avait pas le média | Haute | Parcours pilote ; cause établie par journaux (le changement d'adresse remontait l'éditeur depuis la base) |
| **Build Docker impossible** : `playwright.config.ts` importait `tests/`, exclu de l'image | Haute (bloquait tout déploiement) | `docker build` |
| **Image Docker sans configuration publique** : `proxy.ts` et le client du Studio lisaient `NEXT_PUBLIC_SUPABASE_*` à la compilation ; en production, toutes les pages auraient renvoyé vers la connexion et le dépôt de médias aurait échoué | Haute | Relecture pour Docker, confirmée par l'image |
| **Mauvais message d'erreur** : `user_not_found` reconnu comme `not_found` (recherche par sous-chaîne) ; même défaut latent entre `invalid_media` et `invalid_media_type` | Moyenne | E2E `04-clients` |
| « 3 **canalaux** Buffer ne sont rattachés… » | Faible | Capture |
| Aperçu mobile : libellés coupés lettre par lettre (« J'aim e ») | Faible | Capture mobile |
| Squelettes de chargement qui débordent de 10 px sur mobile (règle `grid-cols-1` oubliée) | Faible | Mesure de débordement |

Six tests périmés ou fragiles ont aussi été corrigés (sélecteurs devenus ambigus avec les nouveaux écrans, case désactivée parce que la date était dépassée, attente d'un enregistrement asynchrone). Aucun test n'a été affaibli pour passer.

### Ce que cette validation ne couvre toujours pas

- Le comportement du **vrai Buffer**, y compris les trois inconnues du Studio (voir docs/STUDIO.md).
- Les **réglages du projet Supabase distant** (authentification, quotas, stockage hébergé).
- Le fonctionnement **derrière Caddy et en HTTPS**.
- Un **vrai téléphone** : le mobile est testé par une fenêtre de 390 px dans Chromium.
- La **charge** : un seul utilisateur à la fois dans les parcours.

## Mission de correction V3 : suites et outils ajoutés

| Quoi | Commande | Ce que ça prouve |
| --- | --- | --- |
| Règles, service, outils (mémoire) | `npm test` | dont `tests/unit/v3-*.test.ts`, `lock-test-ports`, `schema-tools`, `secure-cookies`, `tests/sql/v3-correction.test.ts` |
| Contre-tests indépendants (gelés, 25 scénarios) | `npx vitest run tests/sql/audit-independent*.test.ts tests/unit/audit-independent*.test.ts` | empreintes SHA-256 inchangées (`sha256sum` avant/après) |
| Intégration native, vrais JWT, faux Buffer persistant, processus SIGKILL | `node scripts/test-stack.mjs up --fixture` puis `CADENCE_NO_LOCAL_ENV=1 npm run test:db` | `tests/integration/v3-correction.test.ts` : isolation HTTP, transferts concurrents, créations incertaines, reprise urgente, deux workers, 429 |
| Migrations natives | `node scripts/migration-lab.mjs --template-prefix <pile>` | montées, fixture 307 publications, prérequis, atomicité, rejeu |
| Sauvegarde / restauration | `backup.mjs`, `restore-check.mjs`, `restore-drill.mjs`, `restore-negatives.mjs` | voir `docs/SAUVEGARDE.md` |
| Image Docker, HTTPS, restrictions | `node scripts/image-journey.mjs --image <étiquette> --stack-env <fichier>` | liveness/préparation, administrateur + deux clients, cookies, redirections, en-têtes |
| Ports | `tests/unit/lock-test-ports.test.ts` (faux `iptables`) | idempotence, IPv4/IPv6, diagnostics ; **jamais exécuté sur l'hôte** |

Contexte propre : lancer ces commandes depuis une copie de travail **sans fichier `.env*`** (Next et Vite en chargent automatiquement), avec `CADENCE_NO_LOCAL_ENV=1`.

## Multi-comptes : cycle de vie des connexions (migration 0013, 10 octobre 2026)

Suites ajoutées après le contrôle indépendant du commit `4e132cb` (cinq défauts P1 reproduits). Aucune n'appelle Buffer : deux faux comptes persistants, ou un faux serveur HTTP injecté.

| Quoi | Commande | Ce que ça prouve |
| --- | --- | --- |
| Base (PGlite, rôles réels) | `npx vitest run tests/sql/connexions-cycle-de-vie.test.ts tests/sql/connexions-fournisseur.test.ts` | clé réelle et identité par le serveur seulement, compte et clé non réutilisables, rotation, révocation demandée, réservation refusée sur connexion révoquée, collision de publication sans mutation, ancien appelant borné |
| Routeur | `npx vitest run tests/unit/connection-router.test.ts` | état durable relu avant chaque opération (révocation, pause, clé remplacée), barrière d'écriture, configuration invalide, lecture en parallèle, espacement par compte |
| Identité du compte, actions serveur | `npx vitest run tests/unit/connection-identity.test.ts` | faux Buffer HTTP : clé refusée ou non vérifiable jamais enregistrée, autre compte refusé, aucune clé dans les réponses, rotation de la clé maître |
| Mode de production | `npx vitest run tests/unit/credentials.test.ts tests/unit/v3-readiness.test.ts` | aucun simulateur silencieux en production, écritures fermées par défaut |
| **Intégration native, deux comptes** | `node scripts/test-stack.mjs up --fixture` puis `TEST_SCOPE=integration npx vitest run tests/integration/multi-comptes.test.ts` | les 18 contre-tests du contrôle indépendant (N01–N18) et 8 variantes : deux transactions concurrentes dans les deux ordres, SIGKILL après l'effet externe, vrai `runSync` avec un compte en panne ou en pause, ancien appelant |
| Migrations natives | `node scripts/migration-lab.mjs` | 0013 : prérequis, interruption en cours de route annulée en entier (schéma, données, clés chiffrées), reprise, ancien appelant |
| Parcours navigateur, deux clients | `npx playwright test tests/e2e/10-multi-comptes.spec.ts` | création des clients et des connexions, attribution des canaux, validation, panne d'un compte, reprise sans doublon, révocation, aucune action croisée, mobile |

Limites : la concurrence entre transactions n'est pas jouable sur PGlite (une seule connexion) — elle l'est dans l'intégration native. Les tests à clé factice ne prouvent pas qu'une vraie clé appartient au bon compte : cela demande un essai réel, sur autorisation.

