# Cadence — référence commune

Répertoire : `/home/ubuntu/cadence`. Branche : `release/cadence-v1-finalisation`. Lire README.md, PROJECT_STATUS.md et DEPLOYMENT.md. Les tags `archive/consolidation-2026-10-11/*` préservent les variantes historiques ; ne pas les fusionner globalement. Ne pas confondre ce dépôt de développement avec la production (conteneurs `cadence-prod-*`, pilotés depuis `/home/ubuntu/cadence-prod`) ni avec les anciens checkouts.

Produit : Buffer crée, programme et publie ; Cadence lit Buffer et porte la validation du client. Le Studio est supprimé et Cadence n'écrit jamais dans Buffer : ne réintroduire ni éditeur ni mutation. Préserver les migrations, les données et les contre-tests indépendants. Ne jamais affaiblir une assertion pour obtenir du vert ; documenter un échec plutôt que le masquer.

Ne pas toucher aux services existants, à la production, aux comptes Buffer, aux secrets ni aux volumes Docker. Pas de push, de fusion ni de déploiement sans autorisation explicite. `scripts/test-stack.mjs down` et plusieurs scripts de laboratoire suppriment leurs propres volumes : arrêter les piles de test sans les supprimer, sauf demande contraire.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
