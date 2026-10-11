# Cadence — portail de validation client

État de référence au **11 octobre 2026** : `/home/ubuntu/cadence`, branche `chore/cadence-consolidation-2026-10-11`, issue de `09cdeb1974f13301790d17fa2ab6a7150f6e8fab`. Ce dépôt est indépendant, restauré depuis un Git bundle vérifié puis consolidé depuis `c0af3a0`. Les historiques divergents sont conservés sous les tags `archive/consolidation-2026-10-11/*` ; voir la section « Consolidation du dépôt canonique » de [CLEANUP_REPORT.md](CLEANUP_REPORT.md#consolidation-du-dépôt-canonique). La production exécute encore **2f51602**, avec Buffer et notifications simulés. Aucun déploiement n'a été réalisé par cette mission.

## Produit et état réel

Buffer devient l'outil de création, de gestion des médias, de programmation et de publication. Cadence conserve connexion client, consultation, calendrier, aperçus, validation, demandes de modification, commentaires et historique. Supabase porte les comptes, les permissions et les décisions.

**Cible MVP :** brouillon Buffer → synchronisation Cadence → décision client → programmation manuelle dans Buffer.

**Lecture seule vis-à-vis de Buffer (branche `fix/cadence-read-only-buffer-2026-10-11`) :** une approbation, une demande de modification, un commentaire ou une synchronisation n'écrivent rien dans Buffer. Le client du vrai Buffer ne contient plus aucune mutation et `CADENCE_BUFFER_WRITES` n'est plus lue. La programmation se fait à la main dans Buffer après l'accord ; Cadence constate et signale une programmation sans accord valable, sans pouvoir l'empêcher. L'approbation exige toujours un brouillon daté dans le futur, et la date fait partie de l'accord. Voir [docs/SYNCHRONISATION.md](docs/SYNCHRONISATION.md). L'ancien moteur du Studio (`src/server/studio*.ts`) reste présent mais n'est importé par aucun écran ; ses écritures sont refusées par le client Buffer.

L'interface Studio a été retirée ; ses anciens liens redirigent vers les publications après contrôle administrateur. Les calendriers permettent de consulter, filtrer et ouvrir une fiche. Les données, médias, versions, migrations et tests historiques restent conservés.

## Travailler sur la même version

Claude Code et Codex doivent démarrer depuis le même dossier :

```bash
cd /home/ubuntu/cadence
git status --short --branch
```

Vérifier la branche ci-dessus et se répartir les fichiers si les deux outils travaillent simultanément. Les anciennes sessions tmux et agents restent dans leurs dossiers historiques ; elles n'ont pas été déplacées. Les anciens dépôts ne doivent pas être supprimés : ils contiennent des références d'exploitation et du travail sauvegardé.

## Installation locale

Prérequis retenu : **Node.js 24**, npm ; Docker seulement pour les tests isolés. Utiliser le lockfile :

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Compléter uniquement une configuration de développement isolée. Aucune configuration de production n'a été copiée dans ce nouveau dépôt. `.env.example` décrit les variables ; les secrets restent hors Git. Appliquer les migrations **0001 à 0013**, dans l'ordre, uniquement à une base de développement neuve pour l'installation locale. Ne pas utiliser les seeds de démonstration contre une base réelle.

Le serveur de développement écoute sur `127.0.0.1`. Buffer simulé est le défaut en développement ; les clés réelles ne sont jamais nécessaires aux tests.

## Vérifications

```bash
CADENCE_NO_LOCAL_ENV=1 npm run lint
CADENCE_NO_LOCAL_ENV=1 npm run typecheck
CADENCE_NO_LOCAL_ENV=1 npm test
CADENCE_NO_LOCAL_ENV=1 ISOLATED_BUILD=1 BUFFER_MODE=mock CADENCE_ALLOW_SIMULATED_BUFFER=1 URGENT_LOOP=off npm run build
npm run test:ui
```

Les suites d'intégration et E2E écrivent : utiliser exclusivement des identifiants `TEST_*` d'une pile indépendante, sans clé Buffer réelle. Les commandes et limites sont dans [PROJECT_STATUS.md](PROJECT_STATUS.md) et [TESTING.md](TESTING.md). Les suites locales passent après adaptation des mocks et fixtures hérités (670 unitaires/SQL, 83 intégrations, 62 E2E) ; ces succès avec Buffer simulé ne certifient pas l’intégration réelle ni la mise en production. Le script historique `test-stack.mjs down` supprime des volumes : **ne pas l'utiliser dans le cadre de cette récupération** ; les piles créées pour la mission seront simplement arrêtées et conservées.

## Documentation de référence

- [ARCHITECTURE.md](ARCHITECTURE.md) : constat, cible, Buffer et n8n.
- [PROJECT_STATUS.md](PROJECT_STATUS.md) : preuves, tests, avancement et limites.
- [DEPLOYMENT.md](DEPLOYMENT.md) : exploitation constatée, préparation et rollback, sans déploiement.
- [CLEANUP_REPORT.md](CLEANUP_REPORT.md) : inventaire Git, sauvegardes, choix de base et modifications.
- [NEXT_STEPS.md](NEXT_STEPS.md) : actions ordonnées et critères d'acceptation.

Les documents historiques utiles sont indexés dans `CLEANUP_REPORT.md`. Leurs affirmations de validation réelle ou de préparation à la production ne valent pas pour cette branche sans nouvelle vérification.
