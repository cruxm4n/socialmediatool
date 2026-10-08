# Architecture

## Qui fait quoi

```
            crée, modifie, date, publie
Vous ─────────────────────────────────────────► Buffer ──► réseaux sociaux
                                                  ▲  │
                              programme / déprogramme │ lit
                                                  │  ▼
Client ──► Cadence (Next.js) ◄──────────────► couche de service (serveur)
            valide, commente        │
                                    ▼
                               Supabase : comptes, clients, canaux,
                               validations, commentaires, historique
```

- **Buffer** est la source de vérité du contenu : texte, médias, date, statut de publication.
- **Supabase** est la source de vérité de la validation : qui a approuvé quoi, quand, quelle version.
- **Cadence** n'édite aucune publication. Il affiche, recueille la décision, et demande à Buffer de programmer.
- **n8n** n'est pas utilisé aujourd'hui. Voir [docs/N8N.md](docs/N8N.md).

## Organisation du code

```
src/
  app/                     Pages (rendues côté serveur à chaque requête)
    connexion/             Connexion e-mail + mot de passe
    admin/                 Espace administrateur
    client/[org]/          Espace d'un client
    api/automation/        Points d'entrée serveur à serveur, protégés par secret
  proxy.ts                 Avant chaque page : session Supabase, renvoi vers la connexion
  components/              Interface (calendrier, fiches, aperçus par réseau, coque)
  lib/                     Code partagé, sans accès réseau
    types.ts               Types métier
    view.ts                Post enrichi pour l'affichage
    dates.ts               UTC en stockage, fuseau du client à l'affichage
    domain/status.ts       Statut affiché, alertes, droit de décider
  server/                  Tout ce qui ne doit jamais atteindre le navigateur
    env.ts                 Lecture de la configuration
    auth.ts                Session, contrôle du rôle et de l'organisation
    data.ts                Lectures, toujours avec la session de l'utilisateur
    actions.ts             Actions : connexion, décision, commentaire, synchronisation
    sync.ts                COUCHE DE SERVICE : lien entre Buffer et la base
    publishing/
      provider.ts          Contrat du fournisseur de publication
      buffer-provider.ts   Buffer réel (GraphQL)
      mock-provider.ts     Buffer simulé
supabase/migrations/       Schéma, règles RLS et fonctions SQL
tests/                     unit/ (règles), integration/ (base), e2e/ (parcours)
```

## La couche de service, remplaçable par n8n

`src/server/sync.ts` ne connaît que deux choses : le contrat `PublishingProvider` et des fonctions SQL protégées par un secret. Une synchronisation enchaîne :

1. **Lire** Buffer, puis `sync_buffer_posts` : une transaction qui crée et met à jour les posts, calcule leur empreinte et annule les validations devenues périmées.
2. **Déprogrammer** les posts modifiés après validation (`list_posts_to_unschedule`, `complete_unscheduling`).
3. **Programmer** les posts approuvés (`claim_posts_for_scheduling`, `complete_scheduling`).

L'interface ne lit que la base. Remplacer ce fichier par des workflows n8n qui appellent les mêmes fonctions SQL ne demande aucun changement d'écran.

## Modèle de données

Un **post** correspond à une publication Buffer sur un canal. Trois états distincts sont stockés :

| Champ | Qui le fixe | Valeurs |
| --- | --- | --- |
| `buffer_status` | Buffer | `draft`, `scheduled`, `sending`, `sent`, `error`, `needs_approval` |
| `approval_status` | Le client, via Cadence | `none`, `pending`, `changes_requested`, `approved` |
| `schedule_state` | La couche de service | `idle`, `claimed`, `scheduled`, `failed`, `unschedule_pending` |

L'écran en déduit un statut unique (`src/lib/domain/status.ts`) : brouillon, à valider, modifications demandées, approuvé, programmé, publié, erreur. Ce que dit Buffer l'emporte, car c'est lui qui publie.

Autres tables : `organizations`, `profiles`, `organization_members`, `channels` (canal Buffer ↔ client), `approval_decisions`, `comments`, `post_events` (historique), `sync_runs` (journal).

### Empreinte et versions

Chaque post a une **empreinte** calculée sur son texte, sa date, son canal et ses médias. Une décision porte toujours sur une empreinte précise.

- Le contenu change dans Buffer → nouvelle empreinte, version + 1.
- Il était approuvé → la validation est annulée ; s'il était programmé, il est repassé en brouillon dans Buffer.
- Le client décide sur une page affichée avant le changement → la base refuse (`stale_version`).

### Cas traités

| Situation | Comportement |
| --- | --- |
| Deux utilisateurs du client valident en même temps | Verrou de ligne : une seule décision retenue |
| Deux programmations simultanées | Réservation atomique : le post n'est programmé qu'une fois |
| Contenu modifié entre la validation et la programmation | Relu dans Buffer juste avant : rien n'est programmé |
| Buffer refuse ou est injoignable | État « Erreur », détail pour l'admin, nouvelle tentative à la synchronisation suivante (cinq au plus) |
| Post programmé à la main dans Buffer sans validation | Alerte pour l'admin ; Cadence n'y touche pas |
| Tag retiré d'un brouillon en attente | Retiré de la validation, invisible pour le client |
| Post supprimé dans Buffer | Marqué supprimé, jamais effacé |
| Date prévue dépassée | Non programmé, alerte pour l'admin |
| Canal rattaché à aucun client | Alerte pour l'admin ; personne ne peut valider |

## Sécurité

- **Isolation entre clients : dans la base.** Les règles RLS décident de chaque lecture. Un client ne reçoit que les posts soumis des canaux de son organisation. L'interface n'ajoute aucun filtre de confidentialité.
- **Aucune écriture directe.** Les tables sont en lecture seule pour l'API. Les modifications passent par des fonctions SQL qui vérifient l'identité (`decide_post`, `add_comment`) ou le secret d'automatisation.
- **La clé Buffer reste sur le serveur.** Elle n'est lue que dans `src/server/`, marqué `server-only` : l'importer depuis un composant navigateur fait échouer la compilation.
- **Secret d'automatisation.** Seule son empreinte est en base, dans un schéma non exposé par l'API.
- **Détails techniques cachés au client.** Il voit « incident technique », pas le message d'erreur de Buffer.

### Points de vigilance connus

- Les fonctions d'automatisation sont appelables sans session, protégées par le seul secret. C'est un choix : le projet n'utilise pas la clé « service role » de Supabase. Le conseiller de sécurité Supabase le signale en avertissement ; voir DECISIONS.md, D12.
- Les messages d'erreur de programmation sont masqués dans l'interface client, mais lisibles par un client qui interrogerait l'API directement sur ses propres posts.
- La protection contre les mots de passe compromis de Supabase Auth est désactivée (réglage du projet).

## Rendu Next.js 16

`cacheComponents` est désactivé : toutes les pages dépendent de la session, elles sont rendues à chaque requête. La documentation de cette version de Next.js est dans `node_modules/next/dist/docs/`.
