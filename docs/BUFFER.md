# Buffer : ce que l'API permet, vérifié par essai

Référence : <https://developers.buffer.com>. Point d'entrée unique : `POST https://api.buffer.com` (GraphQL), en-tête `Authorization: Bearer <clé>`.

Essais réalisés le 8 octobre 2026 sur le compte de test (un canal X, « Amollety »). Tous les posts de test étaient datés du 15 décembre 2026 et ont été supprimés ; le contrôle final renvoie zéro post dans le compte.

## Résultats

| Opération | Résultat | Détail |
| --- | --- | --- |
| Lister les canaux | OK | `channels(input: { organizationId })` |
| Créer un tag | OK | `createTag` — le tag « À valider » existe maintenant dans le compte de test |
| Créer un brouillon daté et tagué | OK | `createPost` avec `saveToDraft: true`, `mode: customScheduled`, `dueAt`, `tagIds` |
| Lire les brouillons, filtrer par tag | OK | `posts(input: { filter: { status: [draft], tags: { in: [...] } } })` |
| Brouillon → programmé **sans renvoyer le texte** | **Refusé** | `InvalidInputError` : « Post must have either text or media. » |
| Brouillon → programmé en renvoyant le texte | OK | `editPost(id, saveToDraft: false, mode: customScheduled, schedulingType, dueAt, text)` → statut `scheduled`, date inchangée |
| Médias et tags lors de ce passage | Conservés | Non renvoyés dans la requête, toujours présents après |
| Programmé → brouillon | OK | `editPost(id, saveToDraft: true, text)` → statut `draft`, date conservée |
| Modifier le texte d'un post programmé | OK | Le post reste programmé : c'est au dashboard de détecter le changement |
| Supprimer un post | OK | `deletePost` |

## Ce que cela impose au projet

- **Programmer un post oblige à renvoyer son texte.** Le dashboard renvoie le texte validé par le client, après avoir relu le post dans Buffer et vérifié qu'il est identique. Un post sans texte (média seul) renvoie ses médias : ce cas n'a pas été essayé en réel.
- **Aucun webhook.** Buffer ne prévient pas d'un changement : il faut l'interroger régulièrement.
- **Les notes d'un post sont en lecture seule.** Les commentaires du client restent dans le dashboard.
- **Pas de champ « client » sur un post.** Le rattachement passe par le canal.
- **Un post programmé peut être modifié dans Buffer.** Entre deux synchronisations, une version non validée peut donc rester programmée. La synchronisation suivante la repasse en brouillon. Plus la synchronisation est fréquente, plus cette fenêtre est courte.

## Quotas

Les quotas dépendent de l'offre et s'appliquent par clé d'API. Ils sont renvoyés dans l'en-tête `RateLimit` de chaque réponse, et affichés dans l'écran Synchronisation.

| Compte | 15 min | 24 h | 30 jours |
| --- | --- | --- | --- |
| Compte de test (clé utilisée ici) | 100 | 500 | 15 000 |
| Compte Synology (offre gratuite, vu via le connecteur) | 100 | 250 | 3 000 |

Une synchronisation coûte une requête (deux si plus de 100 posts actifs), plus deux requêtes par post à programmer ou déprogrammer. Toutes les 15 minutes, cela représente environ 2 900 requêtes par mois : confortable sur le compte de test, juste sur l'offre gratuite.

## Non vérifié

- Posts avec vidéo, posts sans texte, Instagram et TikTok en mode « rappel » (`schedulingType: notification`).
- Stabilité dans le temps des adresses de médias renvoyées par Buffer. Si elles changeaient d'un appel à l'autre, les validations seraient annulées à tort : à surveiller lors des premiers usages réels avec des médias téléversés dans Buffer.
- Comportement au-delà de 500 posts actifs (la lecture s'arrête à cinq pages et le signale).

## Vérification du 11 octobre 2026 (lecture seule)

Cadence ne fait plus que **lire** Buffer : aucune des écritures décrites plus haut n'est utilisée par l'application, et son client Buffer n'en contient plus. Les lectures ont été revérifiées sur l'API réelle, sans aucune mutation :

| Contrôle | Résultat |
| --- | --- |
| Schéma GraphQL (introspection) | Les champs lus existent toujours : `Post` (`id status text dueAt sentAt updatedAt externalLink channelId channelService schedulingType error.message tags.name assets`), `Channel`, `Account`, filtre `PostsFiltersInput.status`, tri `createdAt` |
| Requête de relevé de Cadence, telle quelle | Acceptée par l'API sur deux comptes distincts (canaux, publications actives, dernières publiées, pagination) |
| Client `BufferProvider` exécuté contre le compte de test | Compte constaté (`account.id`), 2 canaux, relevé complet, relecture d'une publication, publication inexistante → `null` |
| Clé d'un autre compte que celui de la connexion | Refusée avant toute opération |
| Clé invalide | Refusée par Buffer (HTTP 401), message clair, rien n'est enregistré |
| Tentative d'écriture (`schedulePost`) | Refusée par Cadence, **zéro requête réseau** |

### Limites réelles à connaître

- **Statuts Buffer** : `draft`, `needs_approval`, `scheduled`, `sending`, `sent`, `error`. Il n'existe pas de statut « validé par le client » dans Buffer : la validation est un état **interne à Cadence**, distinct du statut Buffer.
- **Le tag de soumission reste dans Buffer** après l'accord du client : Cadence ne le retire pas (lecture seule). L'agence peut le retirer à la main ; depuis la migration 0014, cela ne retire plus l'accord.
- **Pas de webhook** : un changement dans Buffer n'est vu qu'à la synchronisation suivante.
- **Quotas par clé** (en-tête `RateLimit`) : 100 / 15 min ; 250 ou 500 / jour ; 3 000 ou 15 000 / 30 jours selon l'offre. Une synchronisation coûte une à deux requêtes par compte.
- **Offre gratuite** : 3 canaux, 3 tags, 10 publications programmées par compte (constaté sur le compte « Syno »).
- **Pagination** : la lecture s'arrête à 500 publications actives par compte et le signale ; au-delà, rien n'est déclaré supprimé.
- **Non vérifié en réel** : vidéos, documents, publications sans texte, adresses de médias dans la durée.
