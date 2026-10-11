# Cadence — portail de validation client

Cadence relie une agence et ses clients autour des publications préparées dans **Buffer**.

| Outil | Rôle |
| --- | --- |
| **Buffer** | Création des publications, médias, dates, publication, comptes sociaux |
| **Cadence** | Lecture de Buffer, calendrier éditorial, consultation, validation par le client, commentaires, demandes de modification, historique, programmation du brouillon approuvé |

Cadence ne remplace pas Buffer. Il le lit, et n'y écrit qu'**une seule chose** : dès que le client approuve un brouillon, Cadence le passe en « programmé » à la date que ce brouillon porte déjà. Il ne crée, ne modifie, ne supprime et ne déprogramme rien. La validation d'un client est un état propre à Cadence, distinct du statut Buffer.

## Le parcours

1. L'agence prépare un brouillon **daté** dans Buffer et lui pose le tag « À valider » (ou « À vérifier »).
2. Cadence le lit à la synchronisation suivante : il apparaît « À valider » dans l'espace du client propriétaire du canal.
3. Le client l'approuve, ou demande une modification avec un commentaire.
4. À l'approbation, Cadence relit le brouillon dans Buffer, vérifie qu'il est toujours celui que le client a validé, et le programme à sa date. En cas d'échec, l'accord reste enregistré et la synchronisation suivante réessaie.
5. Cadence constate ensuite la publication.

Un brouillon sans date peut être approuvé, mais ne peut pas être programmé : il attend dans « Approuvées, pas encore programmées » que l'agence fixe sa date dans Buffer, puis part à la synchronisation suivante.

L'accord du client porte sur un contenu précis (texte, médias, canal, et date si elle existait) : si ce contenu change dans Buffer, l'accord tombe et une nouvelle validation est demandée. Une publication déjà programmée dont le contenu change est **signalée** à l'agence ; Cadence ne la repasse pas en brouillon. Retirer le tag d'un brouillon approuvé ne retire pas l'accord.

Chaque client a sa propre connexion Buffer (une clé d'API, chiffrée côté serveur) et ne voit que ses publications : l'isolation est appliquée par la base (RLS), pas par l'interface.

L'administrateur crée les comptes de ses clients depuis la fiche du client. Le mot de passe est généré par le serveur, affiché à l'administrateur (qui peut le relire ou le renouveler) et conservé chiffré dans la base.

## Travailler sur le projet

Dossier de référence : `/home/ubuntu/cadence`, branche `release/cadence-v1-finalisation`. Ce dépôt de développement n'alimente pas le site public : voir [DEPLOYMENT.md](DEPLOYMENT.md).

Prérequis : **Node.js 24**, npm ; Docker pour les suites d'intégration et E2E.

```bash
npm ci
cp .env.example .env.local   # configuration de développement uniquement
npm run dev                  # http://127.0.0.1:3000, Buffer simulé
```

En développement et dans les tests, Buffer est **simulé** : aucune clé réelle n'est nécessaire, et `npm run dev` ignore `BUFFER_MODE=real`. En production, le simulateur n'est jamais utilisé en silence (voir `.env.example`). Les migrations `0001` à `0015` s'appliquent dans l'ordre.

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
