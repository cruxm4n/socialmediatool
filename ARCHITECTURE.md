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
- **Cadence** prépare les contenus (Studio), recueille la décision du client, et demande à Buffer de programmer. Il ne publie jamais lui-même.
- **n8n** n'est pas indispensable. Il peut déclencher la synchronisation et sert de passerelle d'envoi des e-mails de notification. Voir [docs/PLANIFICATEUR.md](docs/PLANIFICATEUR.md), [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) et [docs/N8N.md](docs/N8N.md).

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
    automation-rpc.ts      Appel des fonctions SQL protégées par le secret
    notifications.ts       Remise des notifications (simulation ou webhook)
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

Avant de commencer, elle demande un **verrou** à la base (`begin_sync_run`) : une seule synchronisation s'exécute à la fois, quel que soit le déclencheur. Elle le rend avec son résultat (`finish_sync_run`), ce qui alimente l'état affiché dans l'administration : dernier succès, dernier échec, anomalies, pause après un quota Buffer atteint. Elle termine en remettant les notifications en attente.

Le planificateur (toutes les 5 minutes) est préparé mais non activé : [docs/PLANIFICATEUR.md](docs/PLANIFICATEUR.md). En attendant, l'ouverture de l'espace admin déclenche une synchronisation si la dernière date de plus de quinze minutes.

L'interface ne lit que la base. Remplacer ce fichier par des workflows n8n qui appellent les mêmes fonctions SQL ne demande aucun changement d'écran.

## Modèle de données

Un **post** correspond à une publication Buffer sur un canal. Trois états distincts sont stockés :

| Champ | Qui le fixe | Valeurs |
| --- | --- | --- |
| `buffer_status` | Buffer | `draft`, `scheduled`, `sending`, `sent`, `error`, `needs_approval` |
| `approval_status` | Le client, via Cadence | `none`, `pending`, `changes_requested`, `approved` |
| `schedule_state` | La couche de service | `idle`, `claimed`, `scheduled`, `failed`, `unschedule_pending` |

L'écran en déduit un statut unique (`src/lib/domain/status.ts`) : brouillon, à valider, modifications demandées, approuvé, programmé, publié, erreur. Ce que dit Buffer l'emporte, car c'est lui qui publie.

Autres tables : `organizations`, `profiles`, `organization_members`, `channels` (canal Buffer ↔ client), `approval_decisions`, `comments`, `post_events` (historique), `sync_runs` (journal), `sync_state` (verrou et état de la synchronisation, une ligne par mode), `notifications` (file d'attente et historique) et `notification_preferences`.

### Notifications

Un déclencheur sur `post_events` met une notification en file d'attente pour chaque fait qui le mérite ; une clé unique empêche les doublons. Le serveur réserve les notifications (`claim_notifications`), les regroupe en un message par destinataire, puis les marque simulées ou les remet à un webhook. Détail : [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md).

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
| Date prévue absente ou dépassée | Approbation refusée (base et interface) ; le client peut demander une modification |
| Quota Buffer atteint ou Buffer injoignable | Arrêt immédiat des appels, posts repris à la synchronisation suivante |
| Quota Buffer atteint ou presque épuisé | Exécutions planifiées suspendues un temps ; bouton manuel toujours disponible |
| Deux synchronisations déclenchées en même temps | Verrou en base : une seule s'exécute, l'autre répond « déjà en cours » |
| Serveur arrêté en pleine synchronisation | Le verrou expire seul au bout de cinq minutes |
| Cinq échecs de programmation de suite | Nouvel essai au plus une fois par heure, sans abandon définitif |
| Session expirée pendant une action | Rien n'est enregistré, renvoi vers la connexion |
| Canal déconnecté dans Buffer | Alerte sur la fiche de la publication |
| Canal rattaché à aucun client | Alerte pour l'admin ; personne ne peut valider |

## Content Studio

Les contenus peuvent être préparés dans Cadence : tables `studio_drafts` (un contenu : client, date, hashtags, médias ordonnés) et `studio_variants` (son texte pour un canal, et l'identifiant du brouillon Buffer une fois envoyé), bibliothèque `media_assets` et espace de stockage privé `media`. `post_versions` garde le contenu de chaque version d'une publication.

« Envoyer en validation » (`pushDraftToBuffer`, dans `src/server/studio.ts`) crée un brouillon tagué par canal dans Buffer, puis relit Buffer : la publication entre alors dans le circuit décrit plus haut, inchangé. Le Studio ne programme jamais. Détail, garde-fous et activation : [docs/STUDIO.md](docs/STUDIO.md).

## Sécurité

- **Isolation entre clients : dans la base.** Les règles RLS décident de chaque lecture. Un client ne reçoit que les posts soumis des canaux de son organisation. L'interface n'ajoute aucun filtre de confidentialité.
- **Aucune écriture directe.** Les tables sont en lecture seule pour l'API. Les modifications passent par des fonctions SQL qui vérifient l'identité (`decide_post`, `add_comment`) ou le secret d'automatisation.
- **La clé Buffer reste sur le serveur.** Elle n'est lue que dans `src/server/`, marqué `server-only` : l'importer depuis un composant navigateur fait échouer la compilation.
- **Secret d'automatisation.** Seule son empreinte est en base, dans un schéma non exposé par l'API.
- **Détails techniques cachés au client.** Il voit « incident technique ». Les événements techniques de l'historique lui sont fermés par la base elle-même.
- **En-têtes de sécurité** sur toutes les réponses (`next.config.ts`) : pas d'affichage dans un cadre tiers, pas de détection de type, référent limité.
- **Liens externes** : seule une adresse `http(s)` renvoyée par Buffer est rendue cliquable.

### Points de vigilance connus

- Les fonctions d'automatisation sont appelables sans session, protégées par le seul secret. C'est un choix : le projet n'utilise pas la clé « service role » de Supabase. Le conseiller de sécurité Supabase le signale en avertissement ; voir DECISIONS.md, D12.
- Les colonnes `schedule_error` et `buffer_error` d'un post restent lisibles par un client qui interrogerait l'API directement sur ses propres posts (l'historique, lui, est protégé). Les masquer demanderait une vue dédiée.
- La protection contre les mots de passe compromis de Supabase Auth est désactivée (réglage du projet).

## Rendu Next.js 16

`cacheComponents` est désactivé : toutes les pages dépendent de la session, elles sont rendues à chaque requête. La documentation de cette version de Next.js est dans `node_modules/next/dist/docs/`.
