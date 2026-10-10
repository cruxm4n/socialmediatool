# Connexions fournisseur : un compte Buffer par client

Depuis la migration `0012`, Cadence ne dépend plus d'une clé Buffer globale. Chaque canal appartient à une **connexion**, c'est-à-dire à un compte Buffer précis.

```
Client (organisation) ──┐
                        ├─ Connexion (un compte Buffer, réel ou simulé)
Agence (partagée) ──────┘        └─ Canaux ── Publications
```

## Ce que Buffer permet (vérifié le 10 octobre 2026 sur developers.buffer.com)

- **Clé d'API par compte** : créée dans *Settings → API* du compte Buffer. Elle agit pour ce compte seulement et donne accès à toutes ses organisations. C'est le mécanisme utilisé par Cadence.
- **OAuth 2.0 (code d'autorisation + PKCE)** : existe aussi, avec jetons d'accès d'une heure et jetons de rafraîchissement à usage unique. **Non implémenté** dans Cadence. Le stockage chiffré est prévu pour l'accueillir (le secret est un texte opaque), mais le parcours d'autorisation et le rafraîchissement restent à écrire.
- **Limites** : les quotas s'appliquent par clé ; une offre gratuite n'autorise qu'une clé. Instagram et TikTok en mode « rappel » ne sont pas vérifiés (voir `docs/BUFFER.md`).

## Modèle de données

| Table | Rôle |
| --- | --- |
| `public.provider_connections` | Une ligne par compte : mode (`real`/`mock`), client propriétaire ou « partagée », état, pause de quota, dernière lecture. Aucun secret. |
| `private.provider_credentials` | Le secret **chiffré**. Schéma privé : invisible de l'API, des clients et du navigateur. Effacé à la révocation. |
| `public.provider_connection_events` | Journal : création, clé remplacée, révocation, refus. Jamais de valeur secrète. |
| `channels.provider_connection_id` | La connexion d'origine du canal. **Posée une fois, jamais modifiée.** |

Trois origines possibles pour le secret (`credential_source`) :
- `none` : compte simulé, aucun secret ;
- `stored` : clé chiffrée en base (le cas normal pour un client) ;
- `environment` : la clé du serveur `BUFFER_API_KEY`, réservée à **la** connexion qui le déclare (le compte historique). Ce n'est pas un repli : sans cette connexion, la variable n'est lue par personne.

## Règles garanties par la base (pas par l'interface)

1. Un canal ne change jamais de connexion (`channel_connection_immutable`).
2. Un canal connu sous un compte est refusé s'il est annoncé par un autre : aucune fusion entre comptes.
3. Les canaux du compte d'un client ne peuvent être attribués qu'à ce client (`channel_connection_org_mismatch`).
4. La lecture d'un compte ne déclare « retirées » que **ses** publications : un compte en panne, en pause ou révoqué ne fait rien disparaître.
5. Une connexion ne se révoque pas tant que des programmations, annulations ou envois incertains en dépendent, sauf décision forcée et tracée.
6. Une connexion révoquée ne se réactive pas ; son secret est effacé ; son historique et ses publications restent.
7. Seul l'administrateur lit les connexions. Un client n'a aucun accès, même à celles de son propre client.

## Routage (code)

`getProvider()` (`src/server/publishing/index.ts`) renvoie un **routeur** (`router.ts`). Le reste de l'application continue de n'utiliser que `PublishingProvider`.

- Chaque opération est envoyée au compte du canal concerné ; la route vient de la base (`provider_routes`).
- **Aucun repli** : sans route, ou si la connexion est révoquée ou son secret illisible, l'opération est refusée et rien n'est envoyé.
- Une erreur porte l'identifiant de sa connexion (`ProviderError.connectionId`) : panne ou quota d'un compte ne bloquent ni ne mettent en pause les autres.
- Un refus de quota (429) met **ce compte** en pause (`provider_connections.paused_until`) ; la pause globale du mode n'est pas posée.

## Chiffrement

- AES-256-GCM, clé `CADENCE_CREDENTIALS_KEY` (32 octets en base64), **jamais en base**.
- Chaque secret est lié à sa connexion : recopié sur une autre, il ne se déchiffre pas.
- Générer la clé : `openssl rand -base64 32`, à placer dans `env/app.env` (0600) et dans la sauvegarde chiffrée des réglages.
- **Perdre cette clé rend les clés Buffer enregistrées inutilisables** (il faut les ressaisir). La changer exige de ressaisir chaque clé (pas de rotation automatique dans cette version).

## Utilisation

- **Paramètres → Intégrations** : toutes les connexions, création, remplacement de clé, révocation.
- **Fiche d'un client → Comptes Buffer de ce client** : les connexions propres à ce client.
- Une clé saisie n'est jamais réaffichée ; seuls ses quatre derniers caractères le sont.
- Remplacer une clé = nouvelle clé du **même** compte. Pour un autre compte : nouvelle connexion (les publications restent rattachées à l'ancienne).

## Changer le compte Buffer d'un client

1. Créer la nouvelle connexion pour le client.
2. Synchroniser : ses canaux apparaissent, à attribuer au client.
3. Laisser les publications de l'ancien compte se terminer ou les annuler dans Cadence (annulations confirmées).
4. Révoquer l'ancienne connexion quand elle n'a plus d'opération en attente.

## Ce qui n'est pas fait

- Aucun compte réel n'a été connecté ni testé : seuls des faux comptes ont servi.
- Pas de vérification en ligne d'une clé à l'enregistrement (elle est constatée à la première lecture en mode réel).
- Pas d'OAuth, pas de rotation automatique de la clé de chiffrement.
- Les identifiants de canal et de publication restent uniques pour toute la base : deux comptes qui annonceraient le même identifiant sont refusés, pas gérés.
- Pause préventive de quota (quota presque épuisé) : conservée avec un seul compte, non appliquée par compte lorsqu'il y en a plusieurs.
