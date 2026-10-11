# Connexions fournisseur : un compte Buffer par client

Depuis les migrations `0012` et `0013`, Cadence ne dépend plus d'une clé Buffer globale. Chaque canal appartient à une **connexion**, c'est-à-dire à un compte Buffer précis, relié par **sa** clé d'API.

```
Client (organisation) ──┐
                        ├─ Connexion (un compte Buffer) ── Canaux ── Publications
Agence (partagée) ──────┘
```

Une clé par client : le client 1 a la clé de son compte Buffer, le client 2 la sienne. Un troisième client s'ajoute de la même façon, sans modifier le code ni un fichier de configuration.

## Ce que Buffer permet (documentation officielle, relue le 10 octobre 2026)

Sources : <https://developers.buffer.com/guides/authentication.html>, <https://developers.buffer.com/guides/api-limits.html>, <https://developers.buffer.com/reference.html>. Aucun appel authentifié n'a servi à cette vérification.

| Point | Constat | Conséquence dans Cadence |
| --- | --- | --- |
| Authentification | Clé d'API envoyée en `Authorization: Bearer`. Elle se crée dans *Settings → API* du compte Buffer. « Your API key acts on behalf of your account only » : elle vaut pour le compte entier, toutes ses organisations, sans restriction par organisation. | Une connexion = un compte = une clé. Deux clients = deux comptes Buffer distincts. |
| OAuth 2.0 | Existe (code d'autorisation + PKCE obligatoire, jetons de rafraîchissement à usage unique). | **Non implémenté.** La clé d'API suffit à un usage privé d'agence ; OAuth serait nécessaire pour que les clients se connectent eux-mêmes. |
| Identité du compte | `query { account { id email name organizations { id } } }` | `account.id` est lu par le serveur à chaque enregistrement ou remplacement de clé, et recontrôlé par chaque client HTTP avant sa première opération. |
| Canaux | `channels(input: { organizationId })` : `id`, `service`, `name`, `displayName`, `isDisconnected`… | Affichés par « Vérifier ». |
| Nombre de clés | Offre gratuite : 1 clé ; Essentials : 3 ; Team : 5. | Une clé par compte suffit. |
| Quotas | Par **client** (clé) : 100 requêtes / 15 min ; 250 (Free, Essentials) ou 500 (Team) / 24 h ; 3 000, 7 500 ou 15 000 / 30 jours. En-têtes `RateLimit` et `RateLimit-Policy` ; `429` avec `Retry-After`. | Pause et espacement **par connexion**. |
| Instagram, TikTok | Selon le type de compte et le format, Buffer publie automatiquement ou envoie un rappel (`schedulingType: notification`). | **Non vérifié par essai** (voir `docs/BUFFER.md`). |

Aucun point d'entrée n'est supposé : les requêtes utilisées sont celles de `docs/BUFFER.md` (essais du 8 octobre) et la lecture du compte ci-dessus.

## Modèle de données

| Table | Rôle |
| --- | --- |
| `public.provider_connections` | Une ligne par compte : mode, client propriétaire (ou « partagée »), état (`active`, `revoking`, `revoked`), identité constatée (`external_account_id`), pause de quota, espacement des lectures, dernière lecture. Aucun secret. |
| `private.provider_credentials` | La clé **chiffrée**, sa version de clé maître et son empreinte non réversible. Schéma privé : invisible de l'API, des clients et du navigateur. Effacée à la révocation. |
| `public.provider_connection_events` | Journal : création, vérification, clé remplacée ou re-chiffrée, révocation demandée, annulée, refusée, effectuée, collision. Jamais de valeur secrète. |
| `channels.provider_connection_id` | La connexion d'origine du canal. **Posée une fois, jamais modifiée.** |

## Règles garanties par la base (pas par l'interface)

1. Un canal ne change jamais de connexion.
2. Un canal ou une **publication** connus sous un compte sont refusés s'ils sont annoncés par un autre : rien n'est modifié (ni canal, ni texte, ni version), la collision est consignée.
3. Les canaux du compte d'un client ne peuvent être attribués qu'à ce client.
4. La lecture d'un compte ne déclare « retirées » que **ses** publications.
5. Un compte Buffer n'est relié que par **une** connexion non révoquée ; une même clé ne s'enregistre qu'**une** fois (empreinte).
6. Une clé réelle et l'identité de son compte ne s'enregistrent que par le **serveur** (fonctions `server_*`, secret d'automatisation + acteur administrateur). Une session de navigateur, même administrateur, ne peut ni enregistrer une clé réelle, ni la remplacer, ni déclarer une identité.
7. Remplacer une clé exige le **même** compte. Une clé d'un autre compte, ou d'identité inconnue sur une connexion déjà vérifiée, est refusée : l'ancienne reste en place.
8. **Révocation et réservations partagent un verrou.** Toute réservation d'un effet externe (programmation, envoi du Studio) verrouille la connexion du canal et exige qu'elle soit `active` dans la même transaction. Une révocation qui a constaté « rien en attente » ne peut pas être doublée par une réservation concurrente ; une réservation en cours fait attendre puis refuser la révocation.
9. Un ancien appelant (relevé sans périmètre, application `2f51602`) ne vaut que pour le compte historique de son mode.
10. Seul l'administrateur lit les connexions. Un client n'a aucun accès, même à celles de son propre client.

## Cycle de vie d'une connexion

```
active ──(révocation demandée, il reste des effets engagés)──▶ revoking ──(plus rien en attente)──▶ revoked
   │                                                              │  ▲
   └──────────(rien en attente : révocation immédiate)───────────┼──┘ (demande annulée : retour à active)
                                                                  └──(décision forcée, tracée)──▶ revoked
```

- **`revoking`** : plus aucun **nouvel** effet (création, modification, programmation) ne part par ce compte. Sa clé est **conservée** : annuler une programmation, relire une publication et rapprocher un envoi incertain restent possibles. C'est ce qui évite de se retrouver avec une publication programmée que plus personne ne peut annuler.
- **`revoked`** : la clé est effacée. Cadence n'envoie plus rien par ce compte. L'historique et les publications restent.
- **Révocation forcée** : possible, sur confirmation écrite. Elle efface la clé alors que des effets restent ouverts ; Cadence ne les déclare **pas** annulés et le dit. Ils sont à traiter dans Buffer.

## Routage (code)

`getProvider()` (`src/server/publishing/index.ts`) renvoie un **routeur** (`router.ts`). Le reste de l'application continue de n'utiliser que `PublishingProvider`.

- Chaque opération est envoyée au compte du canal concerné ; la route vient de la base (`provider_routes`).
- **Aucun repli** : sans route, ou si la connexion est révoquée, non vérifiée ou son secret illisible, l'opération est refusée et rien n'est envoyé.
- **État durable relu avant chaque opération** (`provider_connection_states`) : une révocation, une demande de révocation, une pause ou un remplacement de clé décidés par un autre processus valent immédiatement pour un routeur déjà chargé. Si cet état est illisible, l'opération est refusée.
- Une erreur porte l'identifiant de sa connexion (`ProviderError.connectionId`) : panne ou quota d'un compte ne bloquent ni ne mettent en pause les autres. Une annulation en échec sur le compte A ne retient pas les programmations approuvées du compte B.
- Les comptes sont lus **en parallèle** (quatre au plus) : un compte lent ne retarde pas la lecture des autres.
- Un refus de quota (429) met **ce compte** en pause (`paused_until`, durée demandée conservée en entier). Un quota presque épuisé espace seulement les **lectures planifiées** de ce compte (`read_backoff_until`) ; ses écritures et annulations restent possibles.

## Mode du serveur : aucun simulateur silencieux en production

| Configuration (`NODE_ENV=production`) | Effet |
| --- | --- |
| `BUFFER_MODE=real` | Mode réel. Sans compte connecté : « Aucun compte Buffer connecté », rien n'est lu ni envoyé. |
| `BUFFER_MODE=mock` **et** `CADENCE_ALLOW_SIMULATED_BUFFER=1` | Buffer simulé, autorisé explicitement (piles de test, démonstration). |
| `BUFFER_MODE=mock` seul, absent ou mal écrit | **Bloqué** : aucune opération, lecture comprise ; `/api/ready` le signale. Jamais de simulateur à la place. |

Hors production (`next dev`, tests), le Buffer simulé reste le défaut, et `BUFFER_MODE=real` est ignoré par `next dev` sauf `CADENCE_ALLOW_REAL_BUFFER_IN_DEV=1`.

**Lecture seule.** Depuis le 11 octobre 2026, Cadence ne fait que lire Buffer : aucune création, modification, programmation ni annulation n'est envoyée, quelle que soit la configuration. La variable `CADENCE_BUFFER_WRITES` n'est plus lue. Voir docs/SYNCHRONISATION.md.

## Chiffrement et rotation

- AES-256-GCM, clé maître `CADENCE_CREDENTIALS_KEY` (32 octets en base64), **jamais en base ni dans une sauvegarde**. Elle n'est jamais générée par le serveur : absente, aucune clé Buffer ne s'enregistre.
- Chaque secret est lié à sa connexion : recopié sur une autre, il ne se déchiffre pas.
- Générer la clé : `openssl rand -base64 32`, à placer dans `env/app.env` (0600) **et** à conserver hors du VPS.
- **Perdre cette clé rend les clés Buffer enregistrées inutilisables** : il faut les ressaisir.
- **Rotation**, sans perdre l'accès aux connexions :
  1. générer une nouvelle clé ; poser `CADENCE_CREDENTIALS_KEY=<nouvelle>`, `CADENCE_CREDENTIALS_KEY_VERSION=<n+1>`, `CADENCE_CREDENTIALS_PREVIOUS_KEYS=<n>:<ancienne>` ; redémarrer ;
  2. *Paramètres → Sécurité → Re-chiffrer avec la clé courante* (aucun appel à Buffer, aucune clé ne change de valeur) ;
  3. quand la ligne « Rotation de la clé maître » est au vert, retirer `CADENCE_CREDENTIALS_PREVIOUS_KEYS`.
- La vérification de restauration (`scripts/restore-check.mjs`, `restore-drill.mjs`) contrôle que les clés restaurées se déchiffrent avec la clé maître **fournie au script** ; sans elle, le contrôle est signalé « non vérifié ».

## Utilisation

- **Fiche d'un client → Intégrations — compte Buffer de ce client** : connecter le compte, vérifier, remplacer la clé, révoquer ; détail des réseaux connectés, des programmations en attente et des envois non résolus.
- **Paramètres → Intégrations** : toutes les connexions, l'état du serveur (mode, comptes utilisables, envoi activé ou non).
- En mode réel, « Vérifier et connecter » interroge Buffer (lecture seule) avant d'enregistrer : une clé refusée ou non vérifiable n'est pas enregistrée.
- Une clé saisie n'est jamais réaffichée ; seuls ses quatre derniers caractères le sont.

## Changer le compte Buffer d'un client

1. Demander la révocation de l'ancienne connexion : plus rien de nouveau n'y part.
2. Laisser ses publications se terminer, ou les annuler dans Cadence (annulations confirmées par Buffer).
3. Terminer la révocation quand il ne reste rien en attente.
4. Créer la nouvelle connexion pour le client, synchroniser, attribuer ses canaux.

## Retour arrière

Le retour normal est **applicatif** : remettre l'image précédente, la base reste telle quelle.

| Vers | Sur une base 0013 | Remarque |
| --- | --- | --- |
| `2f51602` (V1, avant les connexions) | Possible. Son relevé ne vaut que pour le compte historique de son mode ; les comptes des clients ne sont ni lus, ni modifiés, ni retirés. | Tant qu'elle tourne, les comptes des clients ne sont plus synchronisés ni programmés. |
| `4e132cb` (connexions sans cycle de vie) | **À ne pas faire** dès qu'un compte réel existe. | Jamais déployée. |

Les scripts `supabase/outils/0012_retour_arriere.sql` et `0013_retour_arriere.sql` ne sont **pas** des retours arrière opérationnels : ils retirent des garde-fous et ne doivent pas être appliqués en production.

## Ce qui n'est pas fait

- **Aucun compte Buffer réel n'a été connecté ni testé.** Les preuves reposent sur des faux comptes persistants et sur un faux serveur HTTP. Un test qui passe avec une clé factice ne prouve pas qu'une vraie clé appartient au bon compte.
- Pas d'OAuth.
- Les identifiants de canal et de publication restent uniques pour toute la base : deux comptes qui annonceraient le même identifiant sont refusés, pas gérés.
- Le verrou de synchronisation et le bail urgent restent par mode (un seul passage à la fois parcourt tous les comptes) : voir `DECISIONS.md` D47.
- L'en-tête `RateLimit-Policy` (durée exacte des fenêtres) n'est pas lu : les fenêtres sont déduites du nom des quotas.
- Instagram et TikTok en mode « rappel », vidéos, publications sans texte : non vérifiés.
