# Pilote réel : sauvegarde, mise en service, essai sur le canal X

> **Statut (mission V3)** : ce dossier est remis pour un **contrôle indépendant** ; il n'autorise aucun pilote. Les opérations externes de la « Gate B » (schéma distant réel, HTTPS réel, ports confinés, sauvegarde hébergée, essai Buffer réel, exploitation du mécanisme urgent, acceptation des risques) sont **NON TESTÉES**.

## Profil du premier pilote (seulement après autorisation)

Un administrateur et un client volontaire, **un compte Buffer** et des canaux neufs dédiés ; un second espace synthétique pour contrôler l'isolation. `CADENCE_PROFILE=pilot` (notifications en simulation, contenu minimal). Pas de transfert de canal ni de modification directe d'un post programmé dans Buffer ; aucune reprise forcée d'une tentative inconnue ; échéances **au moins 24 heures à l'avance** (vérifié à chaque nouvelle programmation ou reprogrammation, pas seulement à la rédaction) ; contrôle humain quotidien des programmations et des anomalies. Synchronisations manuelles d'abord, puis 30–60 minutes après mesure du quota réel. **Le traitement urgent des annulations fonctionne même en pilote manuel** et reste indépendant de l'intervalle général (docs/EXPLOITATION.md).

**Suspension immédiate** : contenu d'un autre espace visible, effet externe inexpliqué, doublon, post invalidé encore programmé, restauration inutilisable, compte Buffer changé, perte de maîtrise des accès. Suspendre les nouvelles écritures **puis rapprocher les programmations déjà présentes avec l'opérateur** : arrêter le planificateur seul n'annule pas ce qui existe chez Buffer.

Rien de ce qui suit n'a été fait. Ce sont des instructions, dans l'ordre. Chaque étape demande votre accord ; on s'arrête à la première qui échoue.

## 0. Point de retour Git

Le tag `retour-avant-validation` marque le dernier état avant les correctifs de la validation réelle (`57d33c8`). Revenir en arrière : `git checkout retour-avant-validation`. Rien n'a été supprimé ni écrasé : toutes les branches existent encore.

```
main < nuit/audit-ameliorations < fiabilite/corrections-p0 < admin/gestion-clients
     < v2/fondations < studio/content-studio < validation/pilote   ← à fusionner
```

```bash
git checkout main && git merge --ff-only validation/pilote     # avance main sans rien mélanger
```

## 1. Sauvegarde de la base distante, AVANT toute migration

Dans Supabase → *Project Settings → Database → Backups*, vérifier qu'une sauvegarde récente existe (ou *Create backup* si l'offre le permet). Sans cela, exporter à la main : *SQL Editor* → lancer les requêtes 2 et 4 de `supabase/outils/verification.sql` et garder les résultats dans un fichier.

Les migrations n'effacent aucune donnée (testé), mais une sauvegarde reste la seule vraie assurance.

## 2. Migrations 0004 à 0008

Une par une, dans *SQL Editor*, dans l'ordre. Après chacune, lancer les requêtes 1, 2 et 3 de `verification.sql` : le drapeau de la migration passe à `true`, les comptes de la photographie sont identiques, les droits sont inchangés.

| Migration | Retour arrière | Particularité |
| --- | --- | --- |
| `0004_fiabilite_statuts.sql` | `supabase/outils/0004_retour_arriere.sql` | Remplace une fonction ; copier d'abord le résultat de la requête 4 |
| `0005_gestion_clients.sql` | `0005_retour_arriere.sql` | Retire l'écriture directe sur `channels` |
| `0006_sync_planifiee.sql` | `0006_retour_arriere.sql` | |
| `0007_notifications.sql` | `0007_retour_arriere.sql` | Aucune notification pour le passé |
| `0008_studio.sql` | `0008_retour_arriere.sql` | **Crée le bucket privé `media`** ; ajoute une règle sur `storage.objects` |

Après `0008` : dans *Storage*, le bucket `media` est **privé** (cadenas), limité à 50 Mo.

**Vérifié sur un vrai Supabase local** (voir BASE_DE_TEST.md) : les huit migrations s'appliquent dans l'ordre sur Postgres 17 ; toutes les tables ont RLS ; `anon` n'a aucun droit sur les tables ; `authenticated` n'écrit nulle part directement ; les seules fonctions appelables sans session sont les fonctions protégées par secret ; le bucket est privé.

**Non vérifiable en local :** les réglages du projet Supabase hébergé (protection des mots de passe compromis, limites de débit de l'authentification, plafond de taille des fichiers du plan).

## 3. Configuration de l'application

Dans `.env.production` ou `.env.local` (jamais dans Git) :

```
BUFFER_MODE=real
BUFFER_API_KEY=…          # clé du COMPTE DE TEST, pas du compte Synology
NOTIFICATIONS_MODE=simulate   # reste en simulation pendant tout le pilote
SYNC_INTERVAL_MINUTES=15      # voir « Quota Buffer »
APP_URL=https://…
```

Le planificateur reste **désactivé** tant que l'étape 6 n'est pas faite.

## 4. Docker

L'image se construit **sans aucune configuration** : `NEXT_PUBLIC_SUPABASE_*` n'est plus lu à la compilation (correctif de cette session : l'éditeur de médias et le rafraîchissement de session les lisent désormais à l'exécution). Elle ne contient aucun secret (`.dockerignore` exclut `.env*`, les tests et les captures).

```bash
docker compose build web          # construit seulement
docker compose up -d web          # démarre (écoute 127.0.0.1:3000 ; Caddy fait le reste)
docker compose logs -f web
```

Ne rien faire sur les conteneurs `caddy` et `n8n` existants. Le service `scheduler` ne démarre qu'avec `--profile scheduler`.

## 5. Checklist de l'essai réel sur le canal X de démonstration

Règles du projet : canal de test uniquement, posts datés loin dans le futur, tout supprimé ensuite, contrôle final « zéro post restant ». **Jamais** sur les pages Synology.

1. [ ] Sauvegarde faite (étape 1), migrations vérifiées (étape 2).
2. [ ] `BUFFER_MODE=real` avec la clé du compte de test. Écran **Paramètres** : mode « Réel », clé « Présente ».
3. [ ] Le tag « À valider » existe dans Buffer (le Studio refuse d'en créer un).
4. [ ] **Synchroniser** : le canal X apparaît, rattaché à Maison Colibri. Écran Synchronisation : le quota restant s'affiche (Buffer le renvoie à chaque réponse). **Noter les trois valeurs.**
5. [ ] Studio : un contenu pour le canal X, daté dans plusieurs mois, un texte court, une image. **Envoyer en validation.**
6. [ ] Dans Buffer : un brouillon, tagué « À valider », **non programmé**, avec l'image. Si Buffer l'a programmé : stop, c'est un défaut.
7. [ ] Espace client (compte de démonstration) : la publication est à valider. Demander une modification.
8. [ ] Corriger dans le Studio, renvoyer. Dans Buffer : le **même** brouillon est mis à jour, pas un second.
9. [ ] Approuver côté client. Dans Buffer : le post est **programmé** à la bonne date.
10. [ ] Cadence : statut « Programmé » côté admin et client.
11. [ ] Calendrier : déplacer un autre brouillon de test par glisser-déposer ; vérifier la date dans Buffer.
12. [ ] **Nettoyage : supprimer tous les posts de test dans Buffer.** Contrôle : zéro post sur le canal. Archiver le contenu dans le Studio.
13. [ ] Reporter dans docs/STUDIO.md ce que Buffer a réellement fait pour chaque inconnue de la liste.

Points à observer pendant l'essai (les inconnues restantes) : Buffer a-t-il téléchargé l'image à la création ? (étape 6 : l'image doit s'afficher) ; le changement de date d'un brouillon est-il accepté ? (étape 11) ; Instagram et Facebook demandent-ils des champs supplémentaires ?

## 6. Activer le planificateur

Seulement après l'essai ci-dessus. [docs/PLANIFICATEUR.md](PLANIFICATEUR.md).

### Quota Buffer

| Compte | Quota mensuel | Fréquence tenable |
| --- | --- | --- |
| Test | 15 000 | 5 minutes (≈ 8 640) |
| Synology, offre gratuite | 3 000 | **30 minutes** (≈ 1 440) ; 15 minutes (≈ 2 880) laisse à peine de marge |

Vérifier le quota réel avant d'activer : écran Synchronisation, carte « Quota de requêtes Buffer restant ». Cadence se met en pause avant d'épuiser une fenêtre, et l'écran signale un intervalle qui dépasse le quota mensuel.

## 7. Notifications

Rester en `simulate` pendant le pilote : l'écran Notifications montre ce qui *serait* parti. Passer en envoi réel : [docs/NOTIFICATIONS.md](NOTIFICATIONS.md).
