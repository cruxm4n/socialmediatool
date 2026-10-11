# Déploiement et restauration — état constaté

**Aucun déploiement réalisé ni autorisé par la mission de récupération du 11 octobre 2026.** Les commandes de déploiement historiques ne doivent pas être exécutées pour suivre ce document.

## Ce qui tourne réellement

| Preuve | Constat |
| --- | --- |
| Conteneur applicatif | `cadence-prod-web`, sain lors de l'inspection |
| Image exécutée | `cadence-web:v1-2f51602` |
| ID d'image | `sha256:affb99671211c72265ee9f4aff16e7e7c7c402721cf32d108f60134f03f7027a` |
| Label OCI revision | `2f516020a3c6071492f26fc3a7bbe7d3f6e52e1d` |
| Source de construction correspondante sur disque | `/home/ubuntu/cadence-prod/build/2f51602`, HEAD détachée et propre |
| Source montée dans web | Aucune ; l'image contient le code exécuté |
| Passerelle | `cadence-prod-gw`, bind de `/home/ubuntu/cadence-prod/tools/scripts/lib/gateway.mjs`, port boucle locale `18000` |
| Supabase de production | Conteneurs DB/Auth/REST/Storage ; volumes `cadence-prod-db-data` et `cadence-prod-storage`, inchangés |
| Proxy | Caddy existant dans `/home/ubuntu/stack`, cible web/passerelle constatée ; aucune modification |
| Mode applicatif | `BUFFER_MODE=mock`, `CADENCE_PROFILE=pilot`, `NOTIFICATIONS_MODE=simulate` : démonstration privée, intégration Buffer réelle non prouvée |

Le label Git et le dossier source concordent. Ils ne prouvent pas à eux seuls que le contexte Docker était exempt de fichiers modifiés : une empreinte de contexte et une reconstruction reproductible restent à contrôler. Le candidat `rc-4e132cb` et son image existent mais ne sont pas le service web actif. Le `docker-compose.yml` du dépôt est un modèle ; il ne décrit pas à lui seul toute la pile réellement déployée.

Le dépôt de développement choisi, `/home/ubuntu/cadence`, n'est ni monté par la production ni utilisé par ses unités systemd. Les scripts du répertoire `cadence-prod` et les anciens chemins sont conservés. Le dépôt historique fournit encore des dépendances par symlink à certains outils et est utilisé par des sessions tmux : ne pas le supprimer.

## Préparation avant une future autorisation

1. Achever le flux manuel et fermer les écritures externes dans tous les chemins de ce mode, y compris jobs urgents et compensations. Résoudre les tests en échec sans neutraliser les contre-tests.
2. Identifier le schéma **réellement appliqué** sur la base de production et sa dérive. La présence de fichiers 0012/0013 dans Git ne prouve pas leur application distante. Cette lecture SQL de production n'a pas été effectuée pendant la récupération.
3. Vérifier une sauvegarde DB/Auth/RLS/Storage restaurée dans une nouvelle pile isolée, ainsi que la disponibilité séparée de la clé maître. Aucune donnée réelle à supprimer ou réinitialiser.
4. Construire un artefact immuable depuis une révision propre, enregistrer commit, empreinte du contexte, lockfile, ID d'image et versions de migrations. Exclure `.env*`, sauvegardes, captures, sessions de test et données privées du contexte.
5. Tester l'image sur une base dédiée, deux clients, deux connexions et médias de test ; `/api/health` pour la vie du processus, `/api/ready` protégé pour la configuration et le schéma. Ni l'un ni l'autre ne certifie une intégration Buffer réelle.
6. Préparer un diff exact de configuration, image et migrations, une fenêtre et un rollback vérifié. Demander l'autorisation de déploiement sur ces éléments concrets ; ne pas appliquer une migration automatiquement depuis un build.

Node 24 est retenu par le Dockerfile et utilisé pour cette mission. Ne pas activer le profil `scheduler` ni modifier Caddy, domaines, ports ou services existants pendant ce nettoyage. Aucun besoin démontré d'un nouveau service de queue.

## Rollback

Conserver l'image précédente et son ID, les paramètres de runtime dans un stockage privé, les empreintes et les sauvegardes vérifiées. Revenir à une image antérieure ne remet pas automatiquement la base à son ancien schéma. Les migrations de transition doivent être additives, testées avec l'application précédente, et proposer un retour arrière qui conserve décisions, versions et jobs. Une suppression de migration déjà appliquée n'est jamais une stratégie de retour arrière.

Après un retour arrière : vérifier l'isolation des deux clients, les versions, les jobs en attente et le statut externe avant de rouvrir un effet Buffer. Une restauration locale ne peut annuler une publication déjà reçue par Buffer. Maintenir les écritures fermées pendant l'analyse et le rapprochement.

Les scripts `/home/ubuntu/cadence-prod/bin/deploy.sh` et `rollback.sh` sont des outils historiques, sauvegardés, non exécutés ici. Leur compatibilité avec les nouvelles migrations et les garde-fous doit être revue avant usage ; leur existence n'autorise pas leur exécution.

## Sauvegardes et surveillance

Les timers utilisateur `cadence-monitor.timer` (environ 5 min) et `cadence-backup.timer` (03:30) pointent vers `/home/ubuntu/cadence-prod/bin/`. Les scripts et configurations ont été inspectés en lecture seule. Leur présence ne prouve ni un succès récent de sauvegarde, ni une copie hors site récupérable.

La sauvegarde de récupération de cette mission couvre **code, historique Git, changements non commités, copies et configurations**. Elle ne sauvegarde pas la DB ni les volumes des services en fonctionnement. Voir [CLEANUP_REPORT.md](CLEANUP_REPORT.md#sauvegardes-et-restauration) pour emplacements et restauration du code. Les procédures DB/Storage historiques restent dans [docs/SAUVEGARDE.md](docs/SAUVEGARDE.md), à exécuter uniquement dans un laboratoire démontré isolé avec autorisation adaptée. Plusieurs scripts de laboratoire suppriment leurs propres volumes : ne pas les lancer sans revue de leur nettoyage.

Les nouveaux conteneurs de test de cette mission sont identifiés dans les fichiers privés `validation/*stack/state.json`. Ils seront arrêtés sans suppression de conteneurs, volumes, réseau ni fichiers. Les piles antérieures, y compris les conteneurs d'audit arrêtés, restent inchangées.
