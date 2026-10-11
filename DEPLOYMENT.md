# Mise en production de Cadence

**Aucune bascule n'est faite sans l'accord explicite du propriétaire.** Ce document décrit l'état constaté de la production et la procédure préparée pour la version suivante. Tant qu'elle n'a pas été exécutée, la production reste telle que décrite ci-dessous.

## Ce qui tourne réellement (constaté le 11 octobre 2026)

| Élément | Constat |
| --- | --- |
| Adresse publique | <https://sociallr.duckdns.org>, servie par cette machine |
| Conteneur applicatif | `cadence-prod-web`, image `cadence-web:v1-86fc3b9` (commit `86fc3b9a19faef577daed0c07390c0d8afa4eac0`) |
| Passerelle Supabase | `cadence-prod-gw` (même image), port local `127.0.0.1:18000` pour les sauvegardes |
| Supabase de production | `cadence-prod-db`, `-auth`, `-rest`, `-storage` ; volumes `cadence-prod-db-data` et `cadence-prod-storage` |
| Schéma de la base | Niveau `0014` |
| Proxy | Caddy existant (`/home/ubuntu/stack`), bloc `sociallr.duckdns.org` |
| Mode | `BUFFER_MODE=real`, `CADENCE_CREDENTIALS_KEY` présente, `CADENCE_PROFILE=pilot`, `NOTIFICATIONS_MODE=simulate` |
| Exploitation | `/home/ubuntu/cadence-prod` (hors Git) : `env/`, `bin/deploy.sh`, `bin/rollback.sh`, `bin/backup-run.sh`, `bin/monitor.sh`, `RUNBOOK.md` |

Le dépôt de développement `/home/ubuntu/cadence` n'alimente pas le site : `deploy.sh` extrait le commit depuis GitHub et lance l'image correspondante.

## Ce que la version suivante change pour la production

| Sujet | En production (`86fc3b9`) | Version suivante |
| --- | --- | --- |
| Écriture vers Buffer | Aucune | Une seule : programmer le brouillon que le client vient d'approuver |
| Comptes clients | Script serveur | Créés depuis la fiche du client, mot de passe généré et chiffré |
| Migration | `0014` | `0015` (une table privée et deux fonctions, aucune donnée modifiée) |
| `SUPABASE_SERVICE_ROLE_KEY` | absente | **à créer** : jeton `service_role` de longue durée, signé avec le secret JWT de la pile |
| `CADENCE_BUFFER_SCHEDULING` | sans objet | facultative : `off` coupe la programmation automatique |

## Procédure

Les commandes se lancent depuis `/home/ubuntu/cadence-prod`. `<SHA>` est le commit de tête de la branche de release, donné dans le rapport de validation (`PROJECT_STATUS.md`).

### 1. Publier la branche sur GitHub

`deploy.sh` clone GitHub : le commit doit y être.

```bash
git -C /home/ubuntu/cadence push origin release/cadence-v1-finalisation
```

### 2. Sauvegarder

```bash
bin/backup-run.sh
jq . state/backup-status.json        # "ok": true, et le dossier de la sauvegarde
```

### 3. Vérifier que la sauvegarde se restaure, et répéter la migration

Dans une pile isolée, sans lien avec la production :

```bash
node restore-fresh.mjs --config . --backup <dossier de la sauvegarde> --prefix cadence-v1-repet --gw-port 18114
docker exec -i cadence-v1-repet-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q \
  < /home/ubuntu/cadence/supabase/migrations/0015_mots_de_passe_clients.sql
```

La restauration doit annoncer le même nombre de comptes, de clients et de publications que la production. Arrêter ensuite la pile (`docker stop`), sans supprimer ses volumes tant que la bascule n'est pas validée.

### 4. Appliquer la migration 0015 sur la production

```bash
docker exec -i cadence-prod-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q \
  < /home/ubuntu/cadence/supabase/migrations/0015_mots_de_passe_clients.sql
docker exec cadence-prod-db psql -U supabase_admin -d postgres -c \
  "insert into supabase_migrations.schema_migrations (version, name) values ('0015', 'mots_de_passe_clients') on conflict (version) do nothing"
```

La migration est une transaction : en cas d'erreur, rien n'est appliqué. La version actuellement en ligne (`86fc3b9`) fonctionne sur une base `0015`.

### 5. Modifier la configuration

```bash
cp -p env/app.env backups/app.env.$(date +%Y%m%d-%H%M%S).bak
```

Dans `env/app.env`, ajouter `SUPABASE_SERVICE_ROLE_KEY` : un jeton `service_role` de longue durée, signé avec le secret JWT de la pile (`secrets.json`). Il n'est jamais affiché ni journalisé. Les lignes `BUFFER_MODE=real` et `CADENCE_CREDENTIALS_KEY` sont déjà en place.

Ce jeton donne tous les droits sur la base : il reste sur le serveur, dans un fichier lisible du seul propriétaire, et ne sert dans l'application qu'à créer un compte et à changer son mot de passe.

**`CADENCE_CREDENTIALS_KEY` doit rester conservée hors du serveur** (gestionnaire de mots de passe). Elle chiffre les clés Buffer et, désormais, les mots de passe des comptes clients : sans elle, les uns et les autres sont illisibles.

### 6. Archiver les données de démonstration (si ce n'est pas déjà fait)

En mode réel, les publications et canaux fictifs (`mock-…`) ne sont plus affichés. `sql/archive-mock-data.sql` les marque en plus comme retirés, sans rien supprimer. Le script se termine par `rollback` : lire ses compteurs, puis remplacer par `commit`.

Le client de démonstration existant s'archive depuis l'interface (Clients → fiche → Archiver).

### 7. Déployer

```bash
bin/deploy.sh <SHA> --branch release/cadence-v1-finalisation --dry-run
bin/deploy.sh <SHA> --branch release/cadence-v1-finalisation
```

Le script fait une sauvegarde, construit l'image `cadence-web:v1-<7 premiers caractères>`, remplace les conteneurs web et passerelle, vérifie la santé, la version et `/api/ready`, et **revient seul à l'image précédente** si une vérification échoue. Coupure : quelques secondes.

### 8. Mettre en service

1. Se connecter en administrateur. Le bandeau « Aucun compte Buffer connecté » est attendu.
2. Créer chaque client (Clients → Nouveau client).
3. Paramètres → Intégrations → « Connecter un compte Buffer » : coller la clé d'API du compte Buffer du client (dans Buffer : Settings → API) et choisir le client propriétaire. Cadence vérifie la clé auprès de Buffer avant de l'enregistrer.
4. Synchroniser, puis attribuer les canaux au client (Clients → fiche).
5. Créer le compte de chaque utilisateur client depuis la fiche du client (« Créer le compte »), et lui transmettre vous-même le mot de passe affiché.
6. Activer la synchronisation planifiée, une fois par heure (`crontab -e`) :

   ```
   0 * * * * CADENCE_URL=https://sociallr.duckdns.org CADENCE_ENV_FILE=/home/ubuntu/cadence-prod/env/app.env /home/ubuntu/cadence/scripts/sync-tick.sh >> /home/ubuntu/cadence-prod/state/sync.log 2>&1
   ```

   Sans elle, Buffer n'est relu que lorsqu'un administrateur ouvre Cadence ou clique sur « Synchroniser ». Une lecture par heure et par compte reste très en deçà des quotas Buffer (voir [docs/BUFFER.md](docs/BUFFER.md)).

### 9. Contrôles après déploiement

| Contrôle | Attendu |
| --- | --- |
| `curl -s https://sociallr.duckdns.org/api/health` | `"version":"<SHA>"` |
| `bin/monitor.sh && jq '.fail' state/status.json` | `0` |
| Paramètres → Intégrations | « Réel : Buffer est lu par les comptes connectés » |
| Paramètres → Exploitation | « Prêt », aucune ligne « À corriger » |
| Un brouillon tagué « À valider » créé dans Buffer | Visible après synchronisation, statut « À valider » |
| Connexion d'un client | Il ne voit que ses publications ; l'adresse d'un autre client renvoie « introuvable » |
| Le client approuve un brouillon daté | Message « approuvée et programmée dans Buffer », statut « Programmé », le brouillon est programmé dans Buffer à sa date |
| Le client approuve un brouillon sans date | Statut « Approuvé », rubrique « Approuvées, pas encore programmées » côté administrateur |
| Création d'un compte client | Mot de passe affiché une fois créé, réaffichable et renouvelable ; la personne se connecte à son seul espace |
| Le client demande une modification | Statut « Modifications demandées », commentaire visible de l'administrateur |

## Retour arrière

- **Code** : `bin/rollback.sh` remet l'image précédente (`cadence-web:v1-86fc3b9`). Elle fonctionne sur une base `0015` et ignore les variables ajoutées.
- **Couper la programmation sans revenir en arrière** : ajouter `CADENCE_BUFFER_SCHEDULING=off` dans `env/app.env`, puis `./web.sh up <image>` et `./web.sh gw <image>`.
- **Configuration** : restaurer `backups/app.env.<horodatage>.bak`, puis `./web.sh up <image>` et `./web.sh gw <image>`. Pour revenir à la démonstration, il faut à la fois `BUFFER_MODE=mock` et `CADENCE_ALLOW_SIMULATED_BUFFER=1`.
- **Base** : `0015` ajoute une table privée et deux fonctions, sans toucher aux données existantes ; il n'y a rien à restaurer. Voir `supabase/outils/0015_retour_arriere.sql` pour la portée exacte. Une restauration complète se fait toujours sur une pile neuve (`restore-fresh.mjs`), jamais par écrasement de la base en service.
- **Comptes Buffer** : révoquer une connexion efface sa clé dans Cadence ; rien ne change dans Buffer.

Revenir à une image antérieure ne remet pas la base à son ancien schéma. Les migrations restent additives ; une migration appliquée ne se supprime pas.

## Sauvegardes et supervision

Les minuteurs `cadence-backup.timer` (03 h 30) et `cadence-monitor.timer` (toutes les 5 minutes) pointent vers `/home/ubuntu/cadence-prod/bin/`. La copie hors serveur n'est **pas configurée** (`offsite.env` absent) : la supervision le signale en avertissement. Une sauvegarde n'est valable que restaurée : voir [docs/SAUVEGARDE.md](docs/SAUVEGARDE.md).

Les secrets de production (`env/`, `secrets.json`) et la clé `CADENCE_CREDENTIALS_KEY` ne sont ni dans Git, ni dans l'image, ni journalisés.
