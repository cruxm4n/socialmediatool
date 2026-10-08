# Instructions pour Claude Code

@AGENTS.md

## Le projet en deux lignes

« Cadence » : portail de validation client pour des publications créées dans Buffer. Buffer crée et publie ; Supabase garde comptes, clients et validations ; une couche de service côté serveur relie les deux (n8n la remplacera peut-être). L'utilisateur débute en développement : expliquer simplement, en français, et faire soi-même plutôt que de lui demander de créer des fichiers.

## Par où commencer

`ROADMAP.md`, puis `ARCHITECTURE.md`. Les faits vérifiés sur l'API Buffer sont dans `docs/BUFFER.md` : ne rien supposer d'autre sans le vérifier sur <https://developers.buffer.com>.

## Commandes

- `npm run dev` — port 3000, écoute sur 127.0.0.1 uniquement
- `npm run check` — lint, typage, tests des règles, compilation
- `npm run test:db` — tests de la base Supabase (isolation, concurrence)
- `npm run test:e2e` — parcours Playwright, Buffer simulé, port 3100
- Avant de dire qu'une tâche est finie : lancer les trois, et rapporter le résultat réel.

## Règles du projet

- **Cadence n'édite aucune publication.** Pas d'éditeur, pas d'envoi de média, pas de changement de date : cela se fait dans Buffer.
- **Jamais de programmation sans validation.** Toute programmation passe par `claim_posts_for_scheduling`, qui exige un post approuvé dont l'empreinte est inchangée.
- **Isolation dans la base.** Toute nouvelle table reçoit RLS et une règle de lecture. Ne jamais compter sur un filtre d'interface.
- **Aucune écriture directe dans les tables** depuis l'application : passer par une fonction SQL.
- **Aucune suppression de données dans les fonctions SQL** (`delete`) : marquer plutôt (`removed_at`). L'outil Supabase exige d'ailleurs une confirmation manuelle pour toute requête destructive.
- **Clé Buffer et secret : uniquement dans `src/server/`** (fichiers `server-only`).
- Tout appel à Buffer passe par `PublishingProvider`. Les tests utilisent `MockProvider`, jamais l'API réelle.
- Essais sur le vrai Buffer : uniquement sur le canal de test, posts datés loin dans le futur, supprimés ensuite, contrôle final « zéro post restant ». Jamais sur les pages Synology.

## Conventions

- Interface, commentaires et documentation en français ; identifiants de code en anglais.
- Règles métier pures dans `src/lib/domain/`, testées dans `tests/unit/`.
- Couleurs : variables de `src/app/globals.css` uniquement, sauf les aperçus de réseaux qui imitent une interface tierce.
- Composants shadcn/ui : `npx shadcn@latest add <nom>`.
- Un bouton fait toujours quelque chose. Ne jamais présenter comme opérationnel ce qui ne l'est pas.

## Next.js 16

Documentation dans `node_modules/next/dist/docs/`. `cacheComponents` est désactivé : les pages sont rendues à chaque requête. `middleware` s'appelle `proxy` (`src/proxy.ts`). Ne pas laisser de `transform` permanent sur un conteneur de page (cela décale les éléments en position fixe).

## Prudence

- Aucun secret dans le code ni dans la conversation. Ils vont dans `.env.local`.
- Ne pas modifier le VPS, n8n ni les conteneurs existants sans demande explicite. Ne rien déployer.
- Disque presque plein sur la machine de développement (moins de 1 Go libre en octobre 2026) : éviter les installations lourdes.
