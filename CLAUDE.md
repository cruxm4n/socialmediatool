# Instructions pour Claude Code

@AGENTS.md

## Le projet en deux lignes

« Cadence » : studio de préparation et portail de validation client. Les contenus se préparent dans le Studio de Cadence (ou directement dans Buffer) ; Buffer publie ; Supabase garde comptes, clients, contenus en préparation, médias et validations ; une couche de service côté serveur relie le tout. L'utilisateur débute en développement : expliquer simplement, en français, et faire soi-même plutôt que de lui demander de créer des fichiers.

## Par où commencer

`ROADMAP.md`, puis `ARCHITECTURE.md`. Les faits vérifiés sur l'API Buffer sont dans `docs/BUFFER.md` : ne rien supposer d'autre sans le vérifier sur <https://developers.buffer.com>.

## Commandes

- `npm run dev` — port 3000, écoute sur 127.0.0.1 uniquement
- `npm run check` — lint, typage, tests des règles et des migrations (base locale en mémoire), compilation
- `npm run test:db` — tests sur une base Supabase de test dédiée (variables `TEST_*`), jamais celle de l'application
- `npm run test:e2e` — parcours Playwright, Buffer simulé, port 3100
- `node scripts/test-stack.mjs up` — pile de test isolée (intégration et E2E sans toucher à la base de test existante), puis `down`
- Avant de dire qu'une tâche est finie : lancer les trois, et rapporter le résultat réel.
- `node scripts/backup.mjs` / `node scripts/restore-check.mjs` : sauvegarde et contrôle de restauration (docs/SAUVEGARDE.md).
- Git : `main` porte l'état validé ; travailler dans une branche et committer par lot cohérent.

## Règles du projet

- **Cadence prépare, Buffer publie.** Le Studio (`src/server/studio.ts`) ne crée que des BROUILLONS tagués dans Buffer, par `createDraft` / `updateDraft` / `rescheduleDraft`. Il n'appelle jamais `schedulePost`. Voir docs/STUDIO.md.
- **Jamais deux fois le même brouillon.** Tout envoi vers Buffer passe par `studio_claim_push` puis `studio_complete_push`, qui retiennent l'identifiant Buffer. Un résultat Buffer inconnu (`ProviderError.outcome === "unknown"` sur une création) met la variante en `unknown` : aucun renvoi avant `reconcileDraftPush`. Ne jamais supposer que Buffer dédoublonne.
- **Rien du Studio n'est visible d'un client** tant que la publication n'est pas entrée en validation : tables et stockage réservés à l'administrateur.
- **Jamais de programmation sans validation.** Toute programmation passe par `claim_posts_for_scheduling_in_mode`, qui exige un post approuvé dont l'empreinte, la version et le propriétaire sont inchangés, et renvoie un **jeton**. `complete_scheduling` doit le représenter ; une confirmation périmée est compensée (`unschedule_pending`), jamais enregistrée comme programmée.
- **Isolation dans la base.** Toute nouvelle table reçoit RLS et une règle de lecture. Ne jamais compter sur un filtre d'interface.
- **Aucune écriture directe dans les tables** depuis l'application : passer par une fonction SQL.
- **Aucune suppression de données dans les fonctions SQL** (`delete`) : marquer plutôt (`removed_at`, `archived_at`). Seule exception : retirer un accès (`admin_set_member`), qui doit réellement disparaître. L'outil Supabase exige d'ailleurs une confirmation manuelle pour toute requête destructive.
- **Clé Buffer et secret : uniquement dans `src/server/`** (fichiers `server-only`).
- **Un client ne voit jamais l'historique d'un autre.** Chaque publication a un propriétaire explicite (`posts.owner_organization_id`, `ownership`), indépendant du propriétaire actuel du canal et de `created_at`. Un import dont l'origine est ambiguë (canal transféré/détaché) n'est visible que de l'admin jusqu'à `admin_set_post_owner`. Décider/commenter exige `private.can_decide_post` (propriétaire = client actuel du canal, client actif). L'attribution d'un canal passe par `admin_assign_channel` (qui suspend les validations du client précédent), jamais par une écriture directe. Voir DECISIONS.md D23.
- **Aucune transition de propriétaire de canal sans trace** (D27) : `channel_owner_history` + `visible_from`, même sans publication importée ; ne jamais conclure d'un canal « vide » qu'il n'a pas d'historique.
- **Un accord appartient à une personne habilitée** (D28) : retirer un membre retire ses approbations ; la réservation revalide l'approbateur.
- **La confirmation de programmation exige le jeton** (D29) ; une confirmation périmée déclenche une compensation immédiate, jamais « annulé » sans constat du fournisseur.
- **Jamais de renvoi forcé d'un envoi Studio incertain** (D30) : retrouver le brouillon, ou confirmation humaine de son absence. Une réponse Buffer sans résultat net est « inconnu ».
- **Une sauvegarde n'est valide que restaurée** avec droits, Auth et Storage (D32) : `scripts/restore-check.mjs` puis `scripts/restore-drill.mjs`. Ne jamais dumper avec `--no-privileges`.
- **Une seule synchronisation à la fois** : tout déclenchement passe par `runSync`, qui prend le verrou de la base (`begin_sync_run`).
- **Une compensation ne dépend jamais du poll général** (D33) : annulations à confirmer et réservations abandonnées sont reprises par le traitement urgent (`src/server/urgent.ts`, boucle de `src/instrumentation.ts`, `POST /api/automation/urgent`), avec bail renouvelé. Un refus de quota (429) n'est contourné par aucune écriture, compensation comprise (D34).
- **Une tentative d'envoi Studio a une identité** (D35) : toute confirmation représente `push_attempt_id` ; une réponse d'une autre tentative devient un brouillon orphelin consigné, jamais appliquée.
- **Profil pilote** : `CADENCE_PROFILE=pilot` impose notifications simulées et minimales, échéances ≥ 24 h à chaque programmation ; `/api/ready` (secret) ≠ `/api/health` (liveness).
- **Contexte de test propre** : lancer les suites depuis une copie sans `.env*`, avec `CADENCE_NO_LOCAL_ENV=1` ; piles de test : `scripts/test-stack.mjs` (secrets générés, 127.0.0.1 seulement).
- **Notifications : jamais d'envoi réel en développement.** Le mode par défaut est `simulate` ; ne pas renseigner `NOTIFICATIONS_MODE=webhook` dans `.env.local`.
- Tout appel à Buffer passe par `PublishingProvider`. Les tests utilisent `MockProvider`, jamais l'API réelle.
- Essais sur le vrai Buffer : uniquement sur le canal de test, posts datés loin dans le futur, supprimés ensuite, contrôle final « zéro post restant ». Jamais sur les pages Synology.

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
- Disque presque plein sur la machine de développement (moins de 1 Go libre en octobre 2026) : éviter les installations lourdes.
