> **Document historique, 11 octobre 2026 :** les chemins décrits ci-dessous ne sont plus l’architecture recommandée. Voir [ARCHITECTURE.md](../ARCHITECTURE.md#n8n--dépendances-constatées). Ne pas déplacer l’orchestration ou les secrets vers n8n ; les templates ne prouvent pas que des workflows sont installés. Aucune modification de l’instance n8n n’est autorisée par la mission de nettoyage.

# Brancher n8n plus tard

Aujourd'hui, le serveur de l'application fait lui-même le lien avec Buffer (`src/server/sync.ts`). Rien n'est à reconstruire pour passer à n8n : deux chemins sont possibles.

## Chemin 1 — n8n déclenche, l'application travaille (le plus simple)

Un workflow n8n avec deux nœuds :

1. **Schedule Trigger** : toutes les 5 minutes (15 ou 30 sur l'offre gratuite de Buffer). Workflow prêt à importer : `docs/n8n/cadence-synchronisation.json`.
2. **HTTP Request** : `POST https://<adresse-de-l-application>/api/automation/sync`, en-tête `x-automation-secret: <AUTOMATION_SECRET>`.

La réponse JSON indique ce qui a été fait (`fetched`, `created`, `invalidated`, `scheduled`, `scheduleFailures`, `unscheduleFailures`…). Ajouter un nœud **IF** sur le code HTTP non-2xx, puis sur `ok = false`, `scheduleFailures > 0` ou `unscheduleFailures > 0` pour envoyer une alerte.

Prérequis : n8n doit pouvoir joindre l'application. Tant qu'elle tourne en local sans adresse publique, ce chemin n'est possible que si n8n est sur la même machine.

## Chemin 2 — n8n fait tout, l'application ne parle plus à Buffer

n8n appelle Buffer puis les fonctions SQL de Supabase, exactement comme le fait `src/server/sync.ts`. L'interface ne change pas : elle ne lit que la base.

Identifiants à créer dans n8n (aucun n'est dans le dépôt) :

| Identifiant | Usage |
| --- | --- |
| Clé d'API Buffer (Header Auth : `Authorization: Bearer …`) | Appels à `https://api.buffer.com` |
| Adresse et clé « publishable » Supabase | Appels à `https://<projet>.supabase.co/rest/v1/rpc/<fonction>` avec les en-têtes `apikey` et `Authorization: Bearer <clé>` |
| `AUTOMATION_SECRET` | Paramètre `p_secret` de chaque fonction |

Enchaînement d'une exécution :

1. Lire Buffer : canaux et posts (la requête GraphQL est dans `src/server/publishing/buffer-provider.ts`, méthode `fetchSnapshot`).
2. `sync_buffer_posts(p_secret, p_payload)` — met la base à jour, détecte les changements, annule les validations périmées. Si la réponse contient `unresolved` (identifiants de posts programmés, à date passée, absents de la lecture), relire chacun dans Buffer puis rappeler la fonction avec `complete: false`, les posts retrouvés dans `posts` et les introuvables dans `confirmedGone`.
3. `list_posts_to_unschedule_in_mode(p_secret, p_mode: real)` → pour chaque post : `editPost(saveToDraft: true, text)` dans Buffer, puis `complete_unscheduling(p_secret, p_post_id, p_ok, p_error)`.
4. `claim_posts_for_scheduling_in_mode(p_secret, p_mode: real)` → pour chaque post réservé : relire le post dans Buffer, vérifier que le tag de validation est toujours présent et que texte, date (instant exact) et médias sont ceux renvoyés par la fonction, `editPost(saveToDraft: false, mode: customScheduled, dueAt, text)`, puis `complete_scheduling(p_secret, p_post_id, p_ok, p_error)`.

La réservation de l'étape 4 est atomique : même si n8n et l'application tournent en même temps pendant la bascule, un post ne peut pas être programmé deux fois.

Une fois n8n en place : retirer `BUFFER_API_KEY` du fichier `.env.local` de l'application et l'appel à `scheduleApprovedPosts` dans `src/server/actions.ts` (l'approbation sera alors programmée au passage suivant de n8n, ou via un webhook n8n appelé à cet endroit).

## Recommandation

Commencer par le chemin 1 dès que l'application a une adresse joignable par n8n. Le chemin 2 n'apporte quelque chose que si l'on veut sortir la clé Buffer de l'application.

## Contrat d'erreur et prérequis de migration

La migration locale `supabase/migrations/0003_isolation_modes.sql` doit être appliquée et testée dans une base isolée avant toute utilisation de cette version de l'application. Elle n'a pas été appliquée par Codex. Les nouvelles fonctions exigent `p_mode` (`real` ou `mock`) ; les anciennes signatures traitent uniquement les posts réels.

`POST /api/automation/sync` renvoie 401 sans secret valide, 200 quand tous les traitements réussissent, et 502 en cas d'échec total ou partiel. Configurer HTTP Request pour conserver la réponse des erreurs HTTP. Les compteurs décrivent les opérations effectuées, même en cas d'échec partiel. Le journal contient également les échecs partiels. Après un quota ou une panne pendant la déprogrammation, aucune programmation n'est tentée pendant cette exécution.

Stocker le secret dans les identifiants n8n, limiter l'accès aux exécutions et masquer les en-têtes dans les journaux. Une mutation Buffer ne doit jamais être retentée aveuglément : relire son statut et son contenu à l'exécution suivante. Aucune intégration n8n n'est déployée dans cette session.
