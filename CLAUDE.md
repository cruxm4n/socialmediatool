# Référence de travail — V1 (11 octobre 2026)

Utiliser `/home/ubuntu/cadence`, branche `release/cadence-v1-finalisation`, pour Claude Code ET Codex. Vérifier `git status --short --branch` avant de modifier. Les anciens dossiers sont conservés ; ne pas y poursuivre le développement ni les supprimer. Lire README.md, PROJECT_STATUS.md et DEPLOYMENT.md avant de reprendre.

Cadence est un portail de validation client : **Buffer** crée et publie ; **Cadence** lit Buffer, affiche le calendrier, porte la validation du client (accord, demande de modification, commentaires, historique) et programme dans Buffer le brouillon que le client vient d'approuver. Le Studio a été supprimé : ne pas réintroduire d'éditeur ni d'autre écriture vers Buffer.

Aucun push, merge, déploiement, modification de la base de production, de Buffer, de n8n, de Caddy ni suppression de volumes sans autorisation explicite du propriétaire. La production tourne sur cette machine (`cadence-prod-*`, pilotée depuis `/home/ubuntu/cadence-prod`) : voir DEPLOYMENT.md. Node 24 est utilisé pour les validations.

---

# Instructions pour Claude Code

@AGENTS.md

## Le projet en deux lignes

« Cadence » : portail de validation client relié à Buffer, qu'il lit et où il ne fait que programmer les brouillons approuvés. Supabase garde comptes, clients, publications lues, décisions et commentaires ; une couche de service côté serveur relie le tout. L'utilisateur débute en développement : expliquer simplement, en français, et faire soi-même plutôt que de lui demander de créer des fichiers.

## Par où commencer

`README.md`, puis `ARCHITECTURE.md`. Les faits vérifiés sur l'API Buffer sont dans `docs/BUFFER.md` : ne rien supposer d'autre sans le vérifier sur <https://developers.buffer.com>.

## Commandes

- `npm run dev` — port 3000, écoute sur 127.0.0.1 uniquement
- `npm run check` — lint, typage, tests des règles et des migrations (base locale en mémoire), compilation
- `npm run test:db` — tests sur une base Supabase de test dédiée (variables `TEST_*`), jamais celle de l'application
- `npm run test:e2e` — parcours Playwright, Buffer simulé, port 3100
- `node scripts/test-stack.mjs up` — pile de test isolée (intégration et E2E sans toucher à la base de test existante). `down` supprime les volumes de cette pile : préférer un simple arrêt des conteneurs
- Avant de dire qu'une tâche est finie : lancer les trois, et rapporter le résultat réel.
- `node scripts/backup.mjs` / `node scripts/restore-check.mjs` : sauvegarde et contrôle de restauration (docs/SAUVEGARDE.md).
- Git : `main` porte l'état validé ; travailler dans une branche et committer par lot cohérent.

## Règles du projet

- **Buffer publie, Cadence valide.** La validation est un état interne à Cadence, distinct du statut Buffer. Un brouillon portant le tag de soumission entre en validation ; l'accord du client est attaché au contenu (texte, médias, canal, et date si elle existait) et tombe si ce contenu change. Un brouillon sans date est approuvable ; retirer le tag après l'accord ne le retire pas (migration 0014).
- **Isolation dans la base.** Toute nouvelle table reçoit RLS et une règle de lecture. Ne jamais compter sur un filtre d'interface.
- **Aucune écriture directe dans les tables** depuis l'application : passer par une fonction SQL.
- **Aucune suppression de données dans les fonctions SQL** (`delete`) : marquer plutôt (`removed_at`, `archived_at`). Seule exception : retirer un accès (`admin_set_member`), qui doit réellement disparaître. L'outil Supabase exige d'ailleurs une confirmation manuelle pour toute requête destructive.
- **Clé Buffer et secret : uniquement dans `src/server/`** (fichiers `server-only`).
- **Un client ne voit jamais l'historique d'un autre.** Chaque publication a un propriétaire explicite (`posts.owner_organization_id`, `ownership`), indépendant du propriétaire actuel du canal et de `created_at`. Un import dont l'origine est ambiguë (canal transféré/détaché) n'est visible que de l'admin jusqu'à `admin_set_post_owner`. Décider/commenter exige `private.can_decide_post` (propriétaire = client actuel du canal, client actif). L'attribution d'un canal passe par `admin_assign_channel` (qui suspend les validations du client précédent), jamais par une écriture directe. Voir DECISIONS.md D23.
- **Aucune transition de propriétaire de canal sans trace** (D27) : `channel_owner_history` + `visible_from`, même sans publication importée ; ne jamais conclure d'un canal « vide » qu'il n'a pas d'historique.
- **Un accord appartient à une personne habilitée** (D28) : retirer un membre retire ses approbations ; la réservation revalide l'approbateur.
- **Une sauvegarde n'est valide que restaurée** avec droits, Auth et Storage (D32) : `scripts/restore-check.mjs` puis `scripts/restore-drill.mjs`. Ne jamais dumper avec `--no-privileges`.
- **Une seule synchronisation à la fois** : tout déclenchement passe par `runSync`, qui prend le verrou de la base (`begin_sync_run`).
- **Profil pilote** : `CADENCE_PROFILE=pilot` impose notifications simulées et minimales ; `/api/ready` (secret) ≠ `/api/health` (liveness).
- **Contexte de test propre** : lancer les suites depuis une copie sans `.env*`, avec `CADENCE_NO_LOCAL_ENV=1` ; piles de test : `scripts/test-stack.mjs` (secrets générés, 127.0.0.1 seulement).
- **Un compte Buffer par connexion, jamais de clé globale par défaut** (D40) : tout appel passe par le routeur (`src/server/publishing/router.ts`), qui envoie l'opération au compte du canal. Pas de route, connexion révoquée ou secret illisible → refus, jamais de repli. Un canal ne change jamais de connexion. Voir docs/CONNEXIONS_FOURNISSEUR.md.
- **Les secrets des connexions sont chiffrés avant la base** (D41) : `src/server/credentials.ts`, clé `CADENCE_CREDENTIALS_KEY` hors base ; jamais renvoyés au navigateur, jamais journalisés, jamais réaffichés.
- **Une erreur de fournisseur marquée d'une connexion ne vaut que pour elle** (D42) : elle ne bloque ni ne met en pause les autres comptes (`ProviderError.connectionId`).
- **`npm run dev` n'utilise jamais le vrai Buffer** : `BUFFER_MODE=real` est ignoré en développement sans `CADENCE_ALLOW_REAL_BUFFER_IN_DEV=1`.
- **En production, aucun Buffer simulé silencieux** (D43) : il exige `BUFFER_MODE=mock` ET `CADENCE_ALLOW_SIMULATED_BUFFER=1` ; toute configuration invalide BLOQUE le fournisseur (`bufferModeProblem()`), elle ne le remplace jamais par un simulateur. Ne jamais présenter une simulation comme un résultat du fournisseur.
- **Une seule écriture vers Buffer : programmer un brouillon approuvé** (D44, révisé par le propriétaire le 11 octobre 2026). Dès que le client approuve, Cadence passe le brouillon en « programmé » dans Buffer, à la date déjà portée par le brouillon (`schedulePost`, appelé par `scheduleApprovedPosts`). Rien d'autre n'est écrit : ni création, ni modification de contenu, ni suppression, ni retour en brouillon. Le client Buffer refuse toute autre mutation avant qu'elle ne quitte le serveur ; `tests/unit/buffer-write-scope.test.ts` le vérifie. `CADENCE_BUFFER_SCHEDULING=off` coupe cette programmation.
- **Les mots de passe des comptes clients** sont générés par le serveur, affichés en clair à l'administrateur dans la fiche du client et chiffrés dans la base avec `CADENCE_CREDENTIALS_KEY` (décision du propriétaire, 11 octobre 2026). Jamais en clair dans une table, jamais journalisés.
- **L'identité d'un compte Buffer se constate côté serveur** (D45) : clé réelle et identité ne s'enregistrent que par les fonctions `server_*` (secret d'automatisation + acteur administrateur), après lecture de `account.id`. Jamais par une fonction de session, jamais depuis une valeur venue du navigateur. Un échec de vérification ne remplace jamais la clé en place.
- **Révocation et réservations partagent un verrou** (D46) : ne jamais réserver un effet externe sans passer par les fonctions de réservation (leurs déclencheurs verrouillent la connexion) ; l'état `revoking` garde la clé pour annuler. Le routeur relit l'état durable avant chaque opération : ne pas mettre cet état en cache.
- **Une publication garde son compte d'origine** (D48) : une collision d'identifiant entre comptes est refusée sans mutation ; un relevé sans connexion ne vaut que pour le compte historique.
- **Notifications : jamais d'envoi réel en développement.** Le mode par défaut est `simulate` ; ne pas renseigner `NOTIFICATIONS_MODE=webhook` dans `.env.local`.
- Tout appel à Buffer passe par `PublishingProvider`. Les tests utilisent `MockProvider`, jamais l'API réelle.
- Essais sur le vrai Buffer : en lecture seule, de préférence avec le compte de test. Aucune écriture dans un compte Buffer réel sans autorisation explicite ; jamais sur les pages Synology.

## Conventions

- Interface, commentaires et documentation en français ; identifiants de code en anglais.
- Règles métier pures dans `src/lib/domain/`, testées dans `tests/unit/`.
- Couleurs : variables de `src/app/globals.css` uniquement, sauf les aperçus de réseaux qui imitent une interface tierce.
- Composants shadcn/ui : `npx shadcn@latest add <nom>`.
- Un bouton fait toujours quelque chose. Ne jamais présenter comme opérationnel ce qui ne l'est pas.
- Toute grille de mise en page reçoit `grid-cols-1` : sans colonne explicite, un contenu long élargit la page sur mobile (bug rencontré).
- Une action serveur renvoie un `ActionResult` ; côté navigateur, appeler `leaveIfExpired(result)` avant de l'exploiter.

## Next.js 16

Documentation dans `node_modules/next/dist/docs/`. `cacheComponents` est désactivé : les pages sont rendues à chaque requête. `middleware` s'appelle `proxy` (`src/proxy.ts`). Ne pas laisser de `transform` permanent sur un conteneur de page (cela décale les éléments en position fixe).

## Prudence

- Aucun secret dans le code ni dans la conversation. Ils vont dans `.env.local`.
- Ne pas modifier le VPS, n8n ni les conteneurs existants sans demande explicite. Ne rien déployer.
- Recontrôler l'espace disque avant une installation ou une construction lourde (environ 18 Go libres le 11 octobre 2026).
