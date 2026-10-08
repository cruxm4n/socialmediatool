# Tests

## Lancer les tests

```bash
npm run check       # lint + typage + tests des règles + compilation
npm run test:db     # base Supabase de développement : isolation, concurrence, programmation
npm run test:e2e    # parcours dans un navigateur, Buffer simulé, port 3100
```

Les tests automatiques n'appellent **jamais** l'API Buffer : ils utilisent un Buffer simulé. Les essais sur le vrai Buffer sont manuels et consignés plus bas.

## Résultats du 8 octobre 2026

| Vérification | Commande | Résultat |
| --- | --- | --- |
| Lint | `npm run lint` | Aucune erreur, aucun avertissement |
| TypeScript | `npm run typecheck` | Aucune erreur |
| Tests des règles | `npm run test` | 30 réussis sur 30 |
| Compilation | `npm run build` | Réussie |
| Tests de la base | `npm run test:db` | 22 réussis sur 22 |
| Parcours | `npm run test:e2e` | 26 réussis sur 26 |
| Essai réel Buffer | manuel, scripté | Réussi, voir ci-dessous |

## Essais sur le vrai Buffer

Compte de test, canal X « Amollety ». Posts sur le thème du rugby, datés du 15 décembre 2026, jamais publiés, tous supprimés.

### Essai 1 — capacités de l'API

| # | Opération | Résultat |
| --- | --- | --- |
| 1 | Création du tag « À valider » | OK |
| 2 | Création d'un brouillon daté et tagué | OK — statut `draft`, date conservée |
| 3 | Lecture des brouillons filtrés par tag | OK |
| 4 | Brouillon → programmé, sans renvoyer le texte | **Échec** : « Post must have either text or media. » |
| 5 | Brouillon → programmé, texte renvoyé | OK — statut `scheduled`, date identique, image et tag conservés |
| 6 | Programmé → brouillon | OK — statut `draft` |
| 7 | Suppression, puis contrôle | OK — zéro post restant |

L'échec de l'étape 4 a conduit à renvoyer systématiquement le texte validé (`buffer-provider.ts`).

### Essai 2 — le parcours complet à travers l'application

| # | Étape | Constaté |
| --- | --- | --- |
| 1 | Deux brouillons créés dans Buffer : un tagué, un non tagué | Statut `draft` pour les deux |
| 2 | Synchronisation | 2 lus, 2 créés |
| 3 | L'admin rattache le canal X à Maison Colibri | « Canal rattaché au client. » |
| 4 | Liste admin | Tagué : « À valider ». Non tagué : « Brouillon » |
| 5 | Inès (Maison Colibri) | Voit uniquement le post tagué |
| 5 bis | Sofia (Nordwind Cycles) | Ne voit aucun des deux |
| 6 | Inès approuve | « Publication approuvée et programmée dans Buffer. » |
| 7 | Lecture dans Buffer | Statut `scheduled`, date 15 décembre 10:00 UTC, texte identique |
| 7 bis | Brouillon non tagué dans Buffer | Toujours `draft` |
| 8 | Deux synchronisations de suite | Aucune reprogrammation |
| 9 | Texte modifié dans Buffer, post programmé | Buffer le laisse programmé |
| 10 | Synchronisation | 1 validation annulée, 1 déprogrammé |
| 11 | Lecture dans Buffer | Statut `draft` |
| 12 | Côté cliente | De nouveau « À valider », version 2, historique complet |
| 13 | Suppression des deux posts | OK |
| 14 | Contrôle final dans Buffer | Zéro post |
| 15 | Synchronisation finale | 2 posts marqués supprimés |

Quota consommé par l'ensemble des essais : environ 40 requêtes sur 500 par jour.

## Ce que couvrent les tests automatiques

### Règles (`tests/unit/`, 30 tests)

- Statut affiché à partir des trois états ; alertes pour l'admin ; droit de décider.
- Client Buffer avec un faux réseau : lecture des canaux et posts, reconnaissance du tag, clé transmise, texte renvoyé à la programmation, médias renvoyés si le post n'a pas de texte, refus sans date, refus de Buffer remonté, quota dépassé, panne réseau.
- Comparaison du contenu validé et du contenu présent dans Buffer.
- Dates : fuseaux, changement d'heure, grille du calendrier.

### Base de données (`tests/integration/`, 22 tests)

- **Isolation** : un client ne lit que les posts soumis de son organisation ; pas les brouillons ; pas le journal ; un visiteur non connecté ne lit rien ; personne n'écrit directement dans les tables ; un client ne décide ni ne commente chez un autre ; seul l'admin rattache un canal ; les fonctions d'automatisation exigent le secret.
- **Décision** : refus pour un admin ; refus d'une version périmée ; commentaire obligatoire pour une demande de modifications ; **deux validations simultanées, une seule retenue** ; refus si le post n'est plus un brouillon.
- **Programmation** : jamais pour un post non approuvé, refusé ou à date passée ; **deux programmations simultanées, une seule réservation** ; nouvelle tentative après échec.
- **Synchronisation** : rejouable sans effet ; validation annulée et déprogrammation demandée après modification ; nouvelle version après correction ; suivi du tag ; retour en brouillon dans Buffer ; post disparu marqué, jamais effacé.

### Parcours (`tests/e2e/`, 26 tests)

- **Accès** : renvoi vers la connexion ; mauvais mot de passe ; chaque rôle dans son espace ; déconnexion ; routes d'automatisation fermées sans secret.
- **Isolation** : un client ne voit pas l'autre ; l'espace d'un autre client renvoie 404 ; l'espace admin lui est fermé ; l'adresse directe d'une publication d'un autre client ne révèle rien.
- **Admin** : navigation ; absence de tout outil de création ; synchronisation et journal ; filtres et recherche ; brouillon non tagué ; alerte « programmé sans validation » ; erreur Buffer ; commentaire ; calendrier ; rattachement d'un canal avec effet immédiat côté client.
- **Validation** : approbation → programmation, une seule fois malgré des synchronisations répétées ; demande de modifications ; commentaire ; calendrier client.
- **Cas difficiles** : publication modifiée pendant la relecture ; cycle complet demande → correction → approbation ; modification après programmation ; échec de programmation puis rattrapage ; tag posé puis post supprimé.

## Correspondance avec vos exigences

| Exigence | Vérifiée par |
| --- | --- |
| Appels API et transitions de statut | Tests des règles, essais réels |
| Une publication non validée ne peut pas être programmée | Test de base « ne réserve jamais… », parcours, essai réel 7 bis |
| Pas de double programmation | Test de base « deux programmations simultanées », parcours « une seule fois » |
| Pas de validations concurrentes | Test de base « deux validations simultanées » |
| Droits d'accès entre clients | 8 tests de base, 4 parcours, essai réel 5 bis |
| Aucun client n'accède à la clé Buffer | Clé lue uniquement dans des fichiers `server-only` ; non vérifié par un test dédié |

## Bugs trouvés par les tests

- **Déconnexion globale.** Se déconnecter fermait toutes les sessions du compte, y compris sur d'autres appareils. Corrigé : seule la session courante est fermée.
- **Détail technique visible du client.** Le message d'erreur de Buffer apparaissait dans l'historique côté client. Corrigé : le client voit « incident technique ».
- **Glisser-déposer décalé** (prototype, fonction retirée depuis).

## Limites connues

- Les tests de base et de parcours utilisent la base de développement et y laissent des données préfixées `mock-`, invisibles en mode réel. Nettoyage : voir DECISIONS.md, D13.
- Non essayé sur le vrai Buffer : vidéo, post sans texte, Instagram, TikTok, médias téléversés dans Buffer.
- Une page de publication introuvable s'affiche correctement mais avec un code HTTP 200 au lieu de 404.
- Navigation au clavier et lecteurs d'écran : non testés de façon systématique.
- `Dockerfile` et `docker-compose.yml` : jamais exécutés.
- `npm audit` signale 9 vulnérabilités « high » dans les dépendances de développement. Non analysées ; à examiner avant toute mise en ligne.
- Supabase prévient que Node.js 20 ne sera bientôt plus pris en charge : passer à Node 22.
