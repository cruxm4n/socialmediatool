# Cadence — portail de validation client

Cadence relie une agence et ses clients autour des publications préparées dans **Buffer**.

| Outil | Rôle |
| --- | --- |
| **Buffer** | Création des publications, médias, programmation, publication, comptes sociaux |
| **Cadence** | Lecture de Buffer, calendrier éditorial, consultation, validation par le client, commentaires, demandes de modification, historique |

Cadence ne remplace pas Buffer et **n'y écrit jamais** : il le lit. La validation d'un client est un état propre à Cadence, distinct du statut Buffer.

## Le parcours

1. L'agence prépare un brouillon dans Buffer et lui pose le tag « À valider » (ou « À vérifier »).
2. Cadence le lit à la synchronisation suivante : il apparaît « À valider » dans l'espace du client propriétaire du canal.
3. Le client l'approuve, ou demande une modification avec un commentaire.
4. Approuvé, il passe dans « Prêtes à publier » côté agence, qui le programme à la main dans Buffer.
5. Cadence constate la programmation, puis la publication.

L'accord du client porte sur un contenu précis (texte, médias, canal, et date si elle existait) : si ce contenu change dans Buffer, l'accord tombe et une nouvelle validation est demandée. Fixer la date d'un brouillon approuvé sans date, ou retirer son tag, ne retire pas l'accord.

Chaque client a sa propre connexion Buffer (une clé d'API, chiffrée côté serveur) et ne voit que ses publications : l'isolation est appliquée par la base (RLS), pas par l'interface.

## Travailler sur le projet

Dossier de référence : `/home/ubuntu/cadence`, branche `release/cadence-v1-finalisation`. Ce dépôt de développement n'alimente pas le site public : voir [DEPLOYMENT.md](DEPLOYMENT.md).

Prérequis : **Node.js 24**, npm ; Docker pour les suites d'intégration et E2E.

```bash
npm ci
cp .env.example .env.local   # configuration de développement uniquement
npm run dev                  # http://127.0.0.1:3000, Buffer simulé
```

En développement et dans les tests, Buffer est **simulé** : aucune clé réelle n'est nécessaire, et `npm run dev` ignore `BUFFER_MODE=real`. En production, le simulateur n'est jamais utilisé en silence (voir `.env.example`). Les migrations `0001` à `0014` s'appliquent dans l'ordre.

## Vérifications

```bash
CADENCE_NO_LOCAL_ENV=1 npm run check        # lint, typage, tests unitaires et SQL, compilation
node scripts/test-stack.mjs up              # pile Supabase de test isolée, secrets générés
set -a; . ~/.cadence-test-stack/env; set +a
CADENCE_NO_LOCAL_ENV=1 npm run test:db      # intégration : vrais JWT, deux clients, deux comptes
CADENCE_NO_LOCAL_ENV=1 npm run test:e2e     # parcours dans un navigateur
```

Les suites d'intégration et E2E écrivent dans leur base : utiliser une pile neuve pour chacune, jamais la base de l'application. `node scripts/migration-lab.mjs` rejoue les migrations sur PostgreSQL natif.

## Documentation

- [PROJECT_STATUS.md](PROJECT_STATUS.md) : rapport de validation de la V1, résultats des tests, points ouverts.
- [DEPLOYMENT.md](DEPLOYMENT.md) : production constatée, procédure de mise en production et retour arrière.
- [ARCHITECTURE.md](ARCHITECTURE.md) et [DECISIONS.md](DECISIONS.md) : conception et décisions.
- [docs/BUFFER.md](docs/BUFFER.md) : ce que l'API Buffer permet, vérifié par essai.
- [docs/CONNEXIONS_FOURNISSEUR.md](docs/CONNEXIONS_FOURNISSEUR.md) : comptes Buffer par client, chiffrement des clés.
- [docs/SAUVEGARDE.md](docs/SAUVEGARDE.md) et [docs/EXPLOITATION.md](docs/EXPLOITATION.md) : sauvegarde, restauration, exploitation.

`CLEANUP_REPORT.md`, `NIGHT_REPORT.md`, `ROADMAP.md`, `TESTING.md`, `docs/STUDIO.md`, `docs/N8N.md` et `docs/PILOTE.md` sont des documents **historiques** : ils décrivent des états antérieurs (Studio, programmation automatique) et ne valent pas pour cette version.
