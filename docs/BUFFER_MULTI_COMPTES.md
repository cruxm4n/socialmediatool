# Plusieurs comptes Buffer : ce qui est pris en charge, ce qui manque

Question posée : Cadence peut-il fonctionner avec **deux comptes Buffer indépendants et deux clés d'API** ?

```
Buffer 1 : Client 1 — LinkedIn, Instagram, Facebook
Buffer 2 : Client 2 — Instagram, TikTok        Client 1 — TikTok (plus tard)
```

**Décision de périmètre (mission V3, C14) : le pilote utilise UN SEUL compte Buffer et UNE clé ; plusieurs espaces clients restent isolés malgré ce compte commun (isolation par propriétaire en base, pas par compte Buffer). Deux comptes indépendants sont HORS pilote : si le premier client l'exige, c'est un blocage à consigner et une mission dédiée — jamais un basculement de clé improvisé.** Deux canaux ne valent pas deux comptes : une case « deux comptes » ne peut pas être cochée sur la base de deux canaux.

**Réponse : non, pas aujourd'hui. Un seul compte Buffer (une clé) est pris en charge.** Cadence est déjà multi-clients et multi-canaux ; c'est le *multi-comptes Buffer* qui manque. Rien n'a été implémenté : le besoin n'est pas tranché et une demi-implémentation serait plus dangereuse que l'absence.

## Ce qui est déjà en place

| Besoin | État |
| --- | --- |
| Plusieurs canaux par client (y compris deux du même réseau) | Pris en charge, testé (`tests/sql/gestion-clients.test.ts`) |
| Identité interne distincte de l'identité Buffer | Oui : `posts.id`, `channels.id` (UUID internes) ; `buffer_post_id`, `buffer_channel_id` sont des colonnes externes, jamais utilisées comme clés étrangères |
| Appartenance d'une publication à un client indépendante du canal | Oui (migration 0009 : `posts.owner_organization_id`) |
| Frontière technique avec le fournisseur | Oui : `PublishingProvider` (`src/server/publishing/provider.ts`), seule porte vers Buffer ; un second fournisseur s'ajoute sans toucher à l'interface |
| Quotas : lecture de `RateLimit`, 429, `Retry-After`, pause du planificateur | Oui (propagé aussi depuis les écritures, migration 0009 : `set_sync_backoff`) |
| Résultat inconnu d'une écriture | Oui : jamais de nouvelle création sans réconciliation |

## Ce qui manque pour deux comptes Buffer

1. **Une clé par compte.** `BUFFER_API_KEY` est unique (`src/server/env.ts`) et `getProvider()` renvoie un seul `BufferProvider`. Il faut une liste `{ accountKey, apiKey }` et un fournisseur par compte.
2. **Le compte d'origine d'un canal.** `channels.buffer_channel_id` est `unique` globalement et rien n'enregistre à quel compte Buffer le canal appartient. Ajouter `channels.provider_account text not null default 'default'` et passer la contrainte d'unicité à `(provider_account, buffer_channel_id)` ; idem `posts.buffer_post_id`.
3. **Le routage des écritures.** `scheduleApprovedPosts`, `unscheduleInvalidatedPosts`, `pushDraftToBuffer`, `reconcileDraftPush` appellent `getProvider()` sans argument : elles doivent résoudre le fournisseur **du canal du post**, jamais « le » fournisseur.
4. **Le tag de validation par compte.** Le tag « À valider » doit exister dans chaque organisation Buffer (`reviewTagIdFor` le cherche par organisation : déjà correct, mais chaque compte doit le créer).
5. **Synchronisation et verrou par compte.** `fetchSnapshot` lit toutes les organisations d'une clé ; avec deux clés il faut deux lectures, un verrou (`sync_state.mode`) par compte, et des pauses de quota **indépendantes** (le quota est par clé).
6. **Quotas.** Chaque clé a ses propres plafonds (Free : 100 / 15 min, 250 / jour, 3 000 / 30 jours). Deux comptes doublent la capacité, pas la fréquence acceptable par compte.
7. **Identifiants simulés et réels.** Le filtre `mock-%` sépare simulation et réel : à conserver, y compris pour le nouveau champ.
8. **Interface.** Fiche client : afficher le compte d'origine de chaque canal ; Synchronisation : un état par compte.
9. **Même client sur deux comptes** (Client 1 : TikTok sur Buffer 2) : aucun obstacle de fond — un client possède des canaux, quel que soit leur compte — à condition de la règle 3.

Estimation : environ 2 jours de travail et une migration (`0010`), avec tests de non-mélange des clés (un post du compte A ne doit jamais être écrit avec la clé du compte B).

## Garde-fous du pilote à un compte

- Le compte est **figé** tant qu'une tentative n'est pas résolue (envoi Studio `unknown`/`pushing`, annulation à confirmer) : changer `BUFFER_API_KEY` à ce moment ferait lire/écrire un autre compte avec des identifiants du premier. Procédure : résoudre les tentatives (aucune attente, aucun `unknown`, aucune annulation en attente), vérifier `Administration → Synchronisation`, **puis seulement** changer la clé.
- Pour une future extension (NON TESTÉ, hors pilote) : compte fournisseur explicite sur les identifiants, unicité composée `(compte, identifiant)`, routage strict des écritures, état/verrou/quota par compte, tests de non-mélange de clés.

## Risques à traiter avant de le faire

- **Mélange de clés** : écrire dans le mauvais compte est silencieux côté Buffer. Test dédié obligatoire.
- **Coût en quota** : un compte supplémentaire multiplie les lectures périodiques.
- **Limites Buffer** : une offre gratuite n'autorise qu'**une** clé d'API ; Essentials 3, Team 5 (page « API limits » de Buffer, consultée le 10 octobre 2026).

## Autre fournisseur

Aucun second fournisseur n'est introduit et aucune migration vers Post for Me n'est entreprise. L'interface `PublishingProvider` suffit pour le faire plus tard : elle expose `fetchSnapshot`, `getPost`, `schedulePost`, `unschedulePost`, `createDraft`, `updateDraft`, `rescheduleDraft`, `findDraftCandidates`. Ce qu'un autre fournisseur devrait fournir en plus : un statut « brouillon » et un tag, ou son équivalent, pour le circuit de validation.

## Limites propres aux réseaux (vérifiées le 10 octobre 2026)

Source : <https://developers.buffer.com/guides/character-limits.html>. Les règles locales sont dans `src/lib/domain/studio.ts`.

| Réseau | Buffer | Cadence (avant) | Cadence (maintenant) |
| --- | --- | --- | --- |
| Instagram | 2 196 caractères | 2 200 | 2 196 |
| Facebook | 5 000 | 63 206 | 5 000 |
| LinkedIn | 3 000 | 3 000 | 3 000 |
| TikTok | 2 200 avec vidéo (4 000 photo/texte) | 2 200 | 2 200 (vidéo seule, choix produit) |
| X | 280 (Free) ; 25 000 (Premium) | 280 | 280 (prudent, dépend du compte) |

Non vérifié par essai réel : comptage UTF-16 et pondérations de X, nombre de hashtags Instagram (la limite de 30 est ancienne ; Buffer renvoie vers une aide qui parle de 5 — Cadence avertit au-delà de 5 sans bloquer), publication de photos TikTok, `schedulingType: notification` (Instagram sur compte personnel).
