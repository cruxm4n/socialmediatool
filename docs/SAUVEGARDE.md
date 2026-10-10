# Sauvegarde et restauration

Une sauvegarde **n'est validée que lorsqu'elle a été restaurée et contrôlée**. Les scripts ci-dessous font les deux étapes.

## Ce que contient une sauvegarde

| Élément | Où | Pourquoi |
| --- | --- | --- |
| Droits (GRANT/REVOKE, privilèges par défaut), politiques RLS, empreinte | `database.dump`, `acl.json` | Sans eux la copie « réussit » mais l'application reçoit `permission denied for table posts` |
| Données métier (`public`) : clients, canaux, publications, validations, commentaires, historique, versions, notifications, Studio, médias (métadonnées) | `database.dump` | Le cœur de Cadence |
| Comptes et droits (`auth.users`, `auth.identities`, `public.profiles`, `public.organization_members`) | `database.dump` | Sans eux, personne ne peut se reconnecter ni retrouver son client |
| Secret d'automatisation (empreinte) et historique des migrations (`private`, `supabase_migrations`) | `database.dump` | Savoir quel schéma restaurer |
| Fichiers du stockage (bucket `media`) | `storage/media/…` | Le dump ne contient que les noms des fichiers, pas leur contenu |
| Manifeste : date, commit du code, migrations, nombre de lignes **et empreinte du contenu** de chaque table suivie, empreinte SHA-256 de chaque fichier, dérive constatée, liste de ce qui est hors dump | `manifest.json` | Contrôle de restauration |

**Ce qui n'y est PAS** (liste reprise dans `manifest.json` → `excludedFromDump`) : la clé Buffer, le secret d'automatisation en clair, les fichiers `.env*` (à conserver à part, dans un gestionnaire de secrets), les réglages du projet Supabase hébergé (URL de redirection, durées de session, fournisseurs, modèles d'e-mail, SMTP, clés et secrets JWT), la configuration de Caddy/n8n/du planificateur, les tâches `pg_cron`, les propriétaires SQL (`--no-owner`), le contenu de Buffer (Buffer est l'autre copie des publications).

**Effets externes non restaurables** : restaurer la base n'annule pas ce que Buffer a reçu et ne le recrée pas. Après une reprise, les tentatives d'envoi Studio « en cours » ou « inconnues » restent bloquées (aucune recréation automatique, voir D30), les notifications restaurées sont remises en **simulation**, et les annulations en attente sont reprises par le traitement urgent (voir PLANIFICATEUR.md) — pas de recréation « par magie ».

## Faire une sauvegarde

```bash
# Pile isolée de test (scripts/test-stack.mjs) : le fichier d'environnement (0600) porte la clé éphémère.
set -a; . ~/.cadence-test-stack/env; set +a
SUPABASE_SERVICE_ROLE_KEY=$TEST_SERVICE_ROLE_KEY node scripts/backup.mjs --container $TEST_DB_CONTAINER --user supabase_admin \
  --api-url $TEST_SUPABASE_URL --out ~/cadence-backups-test
# Base CLI préexistante (conteneur supabase_db_cadence-supabase-test) : --user postgres (défaut) et --api-url http://127.0.0.1:54321

# Projet Supabase DISTANT : pg_dump 17 est exécuté dans un conteneur qui sert de simple client.
DATABASE_URL='postgresql://…' SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/backup.mjs --container supabase_db_cadence-supabase-test --remote --out /chemin/sauvegardes
```

Le script ne modifie rien : il lit la base et le stockage. Le dossier créé est en mode 700, les fichiers en 600. **Code de sortie 3** : la base a changé pendant la sauvegarde (empreintes de contenu avant/après différentes) ; la sauvegarde est inutilisable pour une restauration (`driftDetected`) : recommencer en suspendant synchronisations et validations. Ce n'est pas une garantie d'atomicité : c'est un constat.
La chaîne `DATABASE_URL` contient un mot de passe : ne la collez pas dans un historique partagé.

## Vérifier qu'elle se restaure

Deux niveaux. Aucun ne dit « vérifié » s'il n'a pas réellement contrôlé ce qu'il annonce ; tout contrôle en échec donne un code de sortie ≠ 0.

### 1. Base et droits (`restore-check.mjs`)

```bash
node scripts/restore-check.mjs --container supabase_db_cadence-supabase-test --backup ~/cadence-backups-test/cadence-backup-AAAAMMJJ-HHMMSS
```

Le script crée une base jetable `cadence_restore_…` (il **refuse** une base du même nom qui existe déjà, ne touche jamais `postgres`, et ne supprime que ce qu'il a créé ; `--keep` la garde), restaure le dump, puis contrôle :

- empreinte du dump, manifeste complet (schémas, droits, empreintes, historique), fichiers du stockage **présents et intacts** (SHA-256), absence d'erreur grave ;
- **contenu identique** de chaque table suivie (empreinte, pas seulement le nombre de lignes), historique des migrations ;
- une table prévue par l'historique de migrations mais absente du manifeste est une **erreur** (jamais « absente, donc acceptable ») ;
- **droits et politiques** : l'empreinte (`acl.json`, prise à la source) doit être identique — tables, vues, séquences, fonctions, schémas, colonnes, RLS, politiques, privilèges par défaut ;
- **comportement réel des rôles** : `anon` n'accède à rien, `authenticated` ne lit pas `private` ni n'écrit dans `posts`, un client lit une de ses publications et pas celle d'un autre client, et exactement les siennes ;
- cohérence métier (validations, décisions, comptes, versions).

**Non couvert** : le service Auth, l'API HTTP et le Storage servi. Le script le rappelle dans son message final.

### 2. Restauration complète (`restore-drill.mjs`)

```bash
DRILL_ADMIN_EMAIL=… DRILL_ADMIN_PASSWORD=… DRILL_CLIENT_A_EMAIL=… DRILL_CLIENT_A_PASSWORD=… \
DRILL_CLIENT_B_EMAIL=… DRILL_CLIENT_B_PASSWORD=… \
  node scripts/restore-drill.mjs --backup ~/cadence-backups-test/cadence-backup-AAAAMMJJ-HHMMSS \
    --template-prefix cadence-test-<horodatage>        # pile isolée existante comme modèle (aucune pile CLI lue)
```

Les identifiants sont ceux de la **source** (synthétiques, jamais affichés) : le mot de passe d'origine doit fonctionner dans la copie ; il n'est pas réinitialisé pour masquer une erreur Auth. Sans eux le contrôle de connexion **échoue** ; `--reset-passwords` existe pour un essai dégradé explicitement non probant.

Le script monte une pile Supabase **neuve et isolée** (base, Auth, Storage, API ; réseau Docker dédié, ports sur 127.0.0.1, **secrets générés**) en copiant l'image, la commande et les réglages **non secrets** d'une pile modèle (`docker inspect`, lecture seule ; toute autre variable est abandonnée). Il n'écrit dans aucun service ni volume existant et ne supprime, à la fin, que ce qu'il a créé (`--keep` pour inspecter). Ensuite :

1. restauration comme sur un projet neuf (Auth et Storage ont migré leurs schémas, les données y sont rechargées, les schémas de Cadence restaurés en entier, droits compris) ;
2. empreinte des droits comparée à la source ; nombre de lignes ;
3. médias renvoyés dans le Storage **neuf** par son API ;
4. **connexion par mot de passe** de l'administrateur et de **deux clients** par le service Auth restauré ;
5. par l'API, pour chaque client : il lit une de ses publications, exactement les siennes, aucune d'un autre client ; il n'écrit pas, ne décide pas pour un autre ; les tables Studio/historique/état de synchronisation ne lui renvoient rien ; une fonction d'administration lui est refusée ; l'administrateur lit tout ; un visiteur anonyme ne lit rien ;
6. **chaque** média est téléchargé par l'administrateur octet pour octet ; refus pour les deux clients et pour l'anonyme (modèle actuel : stockage privé administrateur) ;
7. contenu de chaque table identique, historique de migrations identique.

Le script exige ~3 Go libres et les images Supabase déjà présentes (celles de la pile de test).

### 3. Contrôles négatifs (`restore-negatives.mjs`)

```bash
SUPABASE_SERVICE_ROLE_KEY=$TEST_SERVICE_ROLE_KEY node scripts/restore-negatives.mjs --container $TEST_DB_CONTAINER \
  --user supabase_admin --backup <sauvegarde bonne> --api-url $TEST_SUPABASE_URL
```

Prouve que les contrôles **détectent** le défaut (code ≠ 0 **et** motif attendu) : dump privé de ses droits, dump altéré, fichier de stockage manquant ou altéré, manifeste incomplet (droits, empreintes, schémas, compteurs), table attendue absente, politique en trop, destination existante (refus sans toucher à la base, canari intact), dérive pendant la sauvegarde.

### Du niveau 0009 au niveau actuel

Essai local : `node scripts/test-stack.mjs up --fixture --upto 0009` (pile au niveau 0009), sauvegarde, puis `restore-drill.mjs … --then-migrate` : la sauvegarde est restaurée à son niveau, les migrations manquantes sont appliquées dans l'ordre sur la copie, puis connexions, API et médias sont éprouvés sur le schéma final. Une sauvegarde prise à 0009 se restaure telle quelle (c'est son niveau) ; les migrations 0010 puis 0011 sont ensuite appliquées dans l'ordre (voir ALIGNEMENT_SUPABASE.md). Une sauvegarde au niveau actuel se restaure sans migration. Ne **jamais** appliquer les migrations puis réimporter le même schéma : l'ordre est unique (restauration, puis éventuelle montée).

### Pile de test isolée pour les suites d'intégration et E2E

`node scripts/test-stack.mjs up [--fixture]` crée une pile neuve (migrations de `supabase/migrations` appliquées, historique des migrations enregistré, quatre comptes, **secrets générés**), écrit `~/.cadence-test-stack/env` (0600) ; `set -a; . ~/.cadence-test-stack/env; set +a; npm run test:db && npm run test:e2e` ; `node scripts/test-stack.mjs down` supprime tout. Elle évite de modifier la base de test existante. `CADENCE_STACK_DIR` choisit un autre dossier d'état (une pile existante n'est jamais écrasée). Voir BASE_DE_TEST.md.

## Restaurer pour de vrai (après incident)

1. Créer un projet Supabase **neuf** (jamais par-dessus l'existant sans l'avoir sauvegardé). Il doit être de la même version de plateforme que la source ; les rôles `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_auth_admin`, `supabase_storage_admin` doivent exister (le script le vérifie).
2. Ne **pas** appliquer les migrations de Cadence : le dump contient schémas, données et droits de `public`, `private` et `supabase_migrations`.
3. Restaurer par le code du dépôt, qui sait filtrer le sommaire du dump (`scripts/lib/restore.mjs`, `restoreBackup`), plutôt que par un `pg_restore` brut : `-n` ne reprend ni le `CREATE SCHEMA` ni les droits du schéma, et les privilèges par défaut de la plateforme donneraient l'exécution à `anon`.
4. Renvoyer chaque fichier de `storage/media/` au même chemin par l'API Storage (`x-upsert: true`), comme le fait `restore-drill.mjs`.
5. Régénérer clés et secret d'automatisation (`supabase/seed.example.sql`), puis lancer `supabase/outils/verification.sql` et une synchronisation manuelle.
6. **Avant de relancer l'application** : `CADENCE_PROFILE=pilot` (ou au moins `NOTIFICATIONS_MODE=simulate`) **et `URGENT_LOOP=off`** : la file de notifications restaurée contient des messages « en attente » dont l'envoi a peut-être déjà eu lieu avant l'incident ; des annulations « à confirmer » ou des réservations « en cours » restaurées décrivent un état ANTÉRIEUR à l'incident. Examiner `supabase/outils/verification.sql` (§8) et, sur décision de l'opérateur, rapprocher avec Buffer **avant** de réactiver le traitement urgent (il lit l'état réel avant d'agir, mais l'opérateur doit d'abord savoir ce que Buffer contient). Les tentatives d'envoi Studio « en cours » ou « inconnues » restent bloquées : aucune recréation automatique après une reprise aveugle.
7. Les utilisateurs conservent leur mot de passe (empreintes dans `auth.users`). Avec un autre secret JWT, les sessions ouvertes sont invalidées : reconnexion simple.

## Limites connues

- Le dump, les compteurs et les fichiers ne partagent pas un instant atomique : le manifeste signale `driftDetected` (empreintes de contenu avant ≠ après) si la base a changé pendant la sauvegarde ; suspendre synchronisations et validations pendant la sauvegarde le supprime. **Une détection n'est pas une garantie d'atomicité.**
- **NON TESTÉ** (hors de la mission locale) : restauration sur un projet Supabase **hébergé**, stockage chiffré hors VPS, planification quotidienne, restauration des réglages exclus du dump. Procédure concrète prête (ci-dessus) ; contrôle à faire dans une mission autorisée.
- Les réglages du projet Supabase hébergé (authentification, redirections, SMTP, clés, plafonds) ne sont pas dans le dump : à noter à part.
- Le dump contient des empreintes de mots de passe : à chiffrer et conserver hors du VPS.
- Une plateforme de version différente peut produire des écarts de droits sur `auth`/`storage` : le contrôle les signale, c'est à une personne de trancher.

## État réel de la validation (10 octobre 2026, deuxième stabilisation)

Voir `RAPPORT_CORRECTION_V3.md` pour les résultats exacts de la dernière exécution (restauration complète : connexions administrateur et deux clients avec leurs mots de passe d'origine, API, médias octet pour octet, contrôles négatifs).

Fréquence recommandée pour 2 à 3 clients : une sauvegarde quotidienne (cron hôte, rétention 14 jours) et une avant chaque migration.
Le plan Supabase gratuit ne fournit pas de sauvegardes quotidiennes téléchargeables : ce script en tient lieu.
