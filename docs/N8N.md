# Brancher n8n plus tard

Aujourd'hui, le serveur de l'application fait lui-même le lien avec Buffer (`src/server/sync.ts`). Rien n'est à reconstruire pour passer à n8n : deux chemins sont possibles.

## Chemin 1 — n8n déclenche, l'application travaille (le plus simple)

Un workflow n8n avec deux nœuds :

1. **Schedule Trigger** : toutes les 15 minutes.
2. **HTTP Request** : `POST https://<adresse-de-l-application>/api/automation/sync`, en-tête `x-automation-secret: <AUTOMATION_SECRET>`.

La réponse JSON indique ce qui a été fait (`fetched`, `created`, `invalidated`, `scheduled`, `scheduleFailures`…). Ajouter un nœud **IF** sur `ok = false` ou `scheduleFailures > 0` pour envoyer une alerte.

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
2. `sync_buffer_posts(p_secret, p_payload)` — met la base à jour, détecte les changements, annule les validations périmées.
3. `list_posts_to_unschedule(p_secret)` → pour chaque post : `editPost(saveToDraft: true, text)` dans Buffer, puis `complete_unscheduling(p_secret, p_post_id, p_ok, p_error)`.
4. `claim_posts_for_scheduling(p_secret)` → pour chaque post réservé : relire le post dans Buffer, vérifier que texte, date et médias sont ceux renvoyés par la fonction, `editPost(saveToDraft: false, mode: customScheduled, dueAt, text)`, puis `complete_scheduling(p_secret, p_post_id, p_ok, p_error)`.

La réservation de l'étape 4 est atomique : même si n8n et l'application tournent en même temps pendant la bascule, un post ne peut pas être programmé deux fois.

Une fois n8n en place : retirer `BUFFER_API_KEY` du fichier `.env.local` de l'application et l'appel à `scheduleApprovedPosts` dans `src/server/actions.ts` (l'approbation sera alors programmée au passage suivant de n8n, ou via un webhook n8n appelé à cet endroit).

## Recommandation

Commencer par le chemin 1 dès que l'application a une adresse joignable par n8n. Le chemin 2 n'apporte quelque chose que si l'on veut sortir la clé Buffer de l'application.
