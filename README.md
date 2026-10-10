# Cadence — portail de validation des publications

Les publications se créent dans **Buffer**. Cadence les récupère, les présente au bon client, recueille sa décision, puis les programme dans Buffer une fois approuvées.

> **État au 8 octobre 2026 : fonctionnel en local, relié à Supabase et à Buffer, sans n8n.**
> Vérifié de bout en bout sur un vrai compte Buffer (canal X de test). Rien n'est déployé.

## Le fonctionnement en six étapes

1. Vous créez un brouillon daté dans Buffer et lui ajoutez le tag **« À valider »**.
2. Vous cliquez **Synchroniser** dans Cadence (ou un planificateur le fait).
3. Le client du canal concerné voit la publication, avec un aperçu.
4. Il **approuve**, **commente** ou **demande une modification**.
5. Une approbation programme aussitôt la publication dans Buffer, à sa date prévue.
6. Si vous modifiez ensuite la publication dans Buffer, la validation est annulée, la publication repasse en brouillon dans Buffer et le client doit la revalider.

Une publication que le client n'a pas approuvée n'est jamais programmée par Cadence.

## Lancer en local

Prérequis : Node.js 20.9 ou plus récent (Node 22 conseillé), npm.

```bash
npm install
npm run dev
```

Puis ouvrir <http://localhost:3000>. Le serveur n'écoute que sur `127.0.0.1` ; avec VS Code en Remote SSH, le port est redirigé automatiquement.

La configuration est dans `.env.local` (déjà présent sur cette machine, jamais versionné). Pour repartir de zéro : copier `.env.example`, appliquer `supabase/migrations/0001_schema.sql`, puis suivre `supabase/seed.example.sql`.

### Comptes de démonstration

Les adresses et mots de passe sont dans `.env.local` (variables `DEMO_…`).

| Compte | Rôle | Voit |
| --- | --- | --- |
| Alex Martin | Administrateur | Tous les clients |
| Inès Faure, Hugo Bernard | Clients | Maison Colibri uniquement |
| Sofia Lemaire | Cliente | Nordwind Cycles uniquement |

Les deux organisations sont fictives. Le canal X de test est rattaché à Maison Colibri.

### Buffer réel ou simulé

`BUFFER_MODE` dans `.env.local` :

- `real` — appelle l'API Buffer avec `BUFFER_API_KEY`.
- `mock` — Buffer simulé, quinze publications fictives, aucun appel réseau. C'est le mode des tests automatiques.

Les données simulées et réelles ne s'affichent jamais ensemble.

### Synchroniser

- À la main : bouton **Synchroniser** (en-tête de l'espace admin).
- À l'ouverture de l'espace admin, si la dernière synchronisation date de plus de quinze minutes.
- Automatiquement, toutes les 5 minutes : planificateur préparé, à activer par une commande — [docs/PLANIFICATEUR.md](docs/PLANIFICATEUR.md).

La pastille de l'en-tête et l'écran **Synchronisation** disent si les données sont à jour.

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement, port 3000 |
| `npm run check` | Lint, typage, tests des règles, compilation |
| `npm run test:db` | Tests de la base Supabase : isolation, validations simultanées, programmation |
| `npm run test:e2e` | Parcours dans un navigateur, Buffer simulé, port 3100 |
| `node scripts/setup-test-db.mjs` | Prépare la base de test locale (voir docs/BASE_DE_TEST.md) |
| `npm run build` puis `npm run start` | Version de production en local |

Première utilisation des parcours : `npx playwright install --only-shell chromium`.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — qui fait quoi, modèle de données, sécurité
- [docs/BUFFER.md](docs/BUFFER.md) — ce que l'API Buffer permet, résultats des essais réels
- [docs/PILOTE.md](docs/PILOTE.md) — sauvegarde, migrations, Docker, checklist de l'essai réel sur le canal X
- [docs/BASE_DE_TEST.md](docs/BASE_DE_TEST.md) — base Supabase locale pour les tests qui écrivent
- [docs/MISE_EN_SERVICE.md](docs/MISE_EN_SERVICE.md) — **ce qu'il reste à autoriser** : fusion, migrations, planificateur, notifications
- [docs/STUDIO.md](docs/STUDIO.md) — Content Studio : création, médias, calendrier, garde-fous, activation
- [docs/PLANIFICATEUR.md](docs/PLANIFICATEUR.md) — synchronisation automatique
- [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) — qui est prévenu de quoi, mode simulation, envoi réel
- [docs/N8N.md](docs/N8N.md) — brancher n8n
- [TESTING.md](TESTING.md) — tests et résultats
- [DECISIONS.md](DECISIONS.md) — décisions et leurs raisons
- [ROADMAP.md](ROADMAP.md) — ce qui est fait, ce qui reste
- [NIGHT_REPORT.md](NIGHT_REPORT.md) — audit et améliorations du 8 octobre 2026
- [CLAUDE.md](CLAUDE.md) — conventions pour les sessions Claude Code
