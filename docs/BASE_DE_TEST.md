# Base de test locale

Une pile Supabase **complète et jetable** tourne dans Docker, sur cette machine, à part de la production : Postgres 17 de Supabase (les vraies migrations), authentification, API REST et stockage. Elle écoute sur le port `54321` (API) et `54322` (Postgres). **Attention : la CLI Supabase publie ces ports sur toutes les interfaces, pas seulement en local** (constaté par l'audit du 9 octobre 2026 ; voir `docs/EXPLOITATION.md` et `scripts/lock-test-ports.sh`). Les tests qui écrivent (`npm run test:db`, `npm run test:e2e`) ne parlent qu'à elle ; `tests/support/env.ts` refuse de les lancer contre une base distante qui serait celle de l'application.

Elle ne touche ni à Caddy ni à n8n : ses conteneurs s'appellent `supabase_*_cadence-supabase-test`.

## Première installation

```bash
mkdir -p ~/cadence-supabase-test && cd ~/cadence-supabase-test
npx -y supabase@latest init
# Dans supabase/config.toml : désactiver studio, analytics, edge_runtime, inbucket, realtime (inutiles ici).
ln -s ~/social-media-dashboard/supabase/migrations supabase/migrations
npx -y supabase@latest start -x studio,imgproxy,mailpit,postgres-meta,edge-runtime,logflare,vector,supavisor,realtime
```

`start` applique `0001` à `0009` : c'est la vérification que les migrations s'enchaînent sur un vrai Supabase.

## Préparer les comptes

```bash
cd ~/social-media-dashboard
node scripts/setup-test-db.mjs
```

Le script crée l'administrateur, deux clients, un utilisateur par rôle, le secret d'automatisation, et écrit `.env.test.local` (ignoré par Git, droits 600). Il refuse toute adresse autre que locale et n'ouvre jamais `.env.local`.

## Lancer les tests

```bash
npm run test:db      # 28 tests d'intégration : isolation, concurrence, programmation
npm run test:e2e     # 60 parcours dans Chromium, Buffer simulé, port 3100
```

## Pile isolée jetable (recommandée pour les suites qui écrivent)

```bash
node scripts/test-stack.mjs up --fixture     # pile neuve : base, Auth, Storage, API, passerelle ; 127.0.0.1 seulement
set -a; . ~/.cadence-test-stack/env; set +a  # TEST_* générés, fichier 0600 hors dépôt
CADENCE_NO_LOCAL_ENV=1 npm run test:db       # le dépôt n'ouvre ni .env.local ni .env.test.local
node scripts/test-stack.mjs down             # supprime ce que `up` a créé (étiquette unique), rien d'autre
```

- **Aucun secret n'est lu d'ailleurs** : mots de passe, secret JWT, clés, URL de base sont générés pour la pile ; seuls l'image, la commande et des réglages non secrets (liste blanche) sont copiés d'un conteneur modèle, en lecture seule (`docker inspect`). `CADENCE_TEMPLATE_PREFIX=<préfixe>` utilise une pile isolée existante comme modèle plutôt que les conteneurs de la CLI.
- Variables écrites : `TEST_SUPABASE_URL`, `TEST_SUPABASE_PUBLISHABLE_KEY`, `TEST_AUTOMATION_SECRET`, `TEST_DEMO_*`, `TEST_DB_CONTAINER`, `TEST_SERVICE_ROLE_KEY` (clé de service éphémère), `TEST_PORT_AUTH|REST|STORAGE`.
- `--fixture` : deux clients, quatre publications soumises, une décision, une demande de modification commentée, deux médias (sauvegarde/restauration, parcours de l'image).
- `CADENCE_STACK_DIR=<dossier>` : contexte distinct (jamais d'écrasement d'un état existant).
- Les ports de service sont liés à `127.0.0.1` ; rien n'est publié sur `0.0.0.0` ni `[::]`.

## Repartir d'une base propre

Les parcours laissent des données (clients et contenus d'essai archivés, canaux simulés). Pour un résultat reproductible :

```bash
cd ~/cadence-supabase-test && npx -y supabase@latest db reset   # rejoue les 9 migrations ; efface la base DE TEST
cd ~/social-media-dashboard && node scripts/setup-test-db.mjs
```

## Arrêter ou supprimer

```bash
cd ~/cadence-supabase-test
npx -y supabase@latest stop              # arrête, garde les données
npx -y supabase@latest stop --no-backup  # arrête et supprime les volumes de la base de TEST
```

## Ce que cette base prouve, et ce qu'elle ne prouve pas

Elle prouve : les migrations sur le vrai moteur, les règles RLS, les droits, le stockage et ses règles, l'authentification par mot de passe, l'API HTTP, et tous les parcours dans un vrai navigateur.

Elle ne prouve pas : le comportement du **vrai Buffer** (toujours simulé), l'envoi d'**e-mails**, la configuration du projet Supabase **distant** (paramètres d'authentification, quotas, réglages du stockage hébergé), ni le fonctionnement derrière **Caddy** et HTTPS.
