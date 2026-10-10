# Feuille de route

## Fait

| Étape | Contenu | État |
| --- | --- | --- |
| Prototype | Design system, coque, calendrier, aperçus par réseau, espace client | Terminé |
| Recentrage Buffer | Suppression de la création de posts, du glisser-déposer, des idées et de la médiathèque | Terminé |
| Supabase | Schéma, authentification, RLS, fonctions de validation et de programmation | Terminé (projet `socialflow-dev`) |
| Couche de service | Synchronisation, programmation et déprogrammation Buffer côté serveur | Terminé |
| Essai réel | Brouillon → validation → programmation → modification → déprogrammation sur un vrai compte Buffer | Réussi le 8 octobre 2026 |
| Audit de nuit | Fiabilité, sécurité, mobile, tests supplémentaires | Voir [NIGHT_REPORT.md](NIGHT_REPORT.md) |

| Cadence V2 | Synchronisation planifiée (verrou, état, pause sur quota), notifications en mode simulation, bandeau « À traiter », liens Buffer, fraîcheur des données | Terminé localement le 9 octobre 2026 — activation décrite dans [docs/MISE_EN_SERVICE.md](docs/MISE_EN_SERVICE.md) |

| Content Studio | Création de contenus, texte par réseau, hashtags, médias et carrousels, calendrier déplaçable, approbation groupée, historique des versions | Terminé localement le 9 octobre 2026 — activation dans [docs/STUDIO.md](docs/STUDIO.md) |

## Reste à faire

1. ~~Synchronisation automatique.~~ **Prête, non activée** : migration `0006` puis une commande ([docs/PLANIFICATEUR.md](docs/PLANIFICATEUR.md)).
2. ~~Écran de gestion des clients et des utilisateurs.~~ **Fait le 9 octobre 2026** (Administration → Clients → fiche client), actif une fois la migration `0005` appliquée. Reste manuel : la création du compte d'un utilisateur (Supabase → Authentication → « Invite user »).
3. ~~Notifications.~~ **Prêtes, en mode simulation** : migration `0007`, puis n8n pour l'envoi réel ([docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)). Reste à imaginer : rappel au client sans réponse.
4. **Premier essai réel du Studio** sur le canal de test : il lèvera les inconnues listées dans docs/STUDIO.md.
4 bis. **Essais Buffer complémentaires** : vidéo, post sans texte, Instagram et TikTok en mode rappel, médias téléversés dans Buffer.
5. **Changement de mot de passe et mot de passe oublié.**
6. **Déploiement** : Docker, HTTPS, sauvegardes. Le `Dockerfile` existe mais n'a jamais été exécuté.
7. **Assistant IA** : hors périmètre depuis le recentrage, à rediscuter.

## Décisions qui vous reviennent

- **Compte Buffer définitif.** Les essais ont utilisé le compte de test. Le compte Synology est sur l'offre gratuite : trois canaux, dix posts programmés, 3 000 requêtes par mois.
- **Fréquence de synchronisation.** Elle borne le temps pendant lequel une modification faite dans Buffer sur un post déjà programmé reste non détectée. Cinq minutes par défaut ; **quinze ou trente sur l'offre gratuite de Buffer**, dont le quota mensuel ne supporte pas cinq (détail dans docs/PLANIFICATEUR.md).
- **Validation par publication ou par campagne.** Aujourd'hui, le client valide chaque publication (une par canal). Un regroupement est possible plus tard.
- **Nom du produit.** « Cadence » est un nom de travail.
