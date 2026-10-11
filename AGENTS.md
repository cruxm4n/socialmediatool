# Cadence — référence commune

Répertoire : `/home/ubuntu/cadence`. Branche : `chore/cadence-recovery-cleanup-2026-10-11`. Lire les six documents racine référencés dans README.md. Ne pas confondre ce dépôt de développement avec la production `2f51602` ni les anciens checkouts.

La cible abandonne le Studio et privilégie Buffer → décision locale → programmation humaine. Le backend historique conserve des écritures Buffer : ne pas les activer. Préserver les migrations, données, fixtures et contre-tests indépendants. Documenter les échecs hérités sans affaiblir leurs assertions pour obtenir du vert.

Ne pas toucher aux services existants, à la production, aux comptes Buffer, aux secrets ni aux volumes Docker. Pas de push, merge principal ou déploiement sans autorisation explicite. `scripts/test-stack.mjs down` et plusieurs scripts de laboratoire suppriment leurs volumes : ne pas les utiliser dans le cadre de la récupération ; arrêter uniquement les piles neuves identifiées, sans suppression.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
