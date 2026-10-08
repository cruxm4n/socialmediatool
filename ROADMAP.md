# Feuille de route

## Fait

| Étape | Contenu | État |
| --- | --- | --- |
| Prototype | Design system, coque, calendrier, aperçus par réseau, espace client | Terminé |
| Recentrage Buffer | Suppression de la création de posts, du glisser-déposer, des idées et de la médiathèque | Terminé |
| Supabase | Schéma, authentification, RLS, fonctions de validation et de programmation | Terminé (projet `socialflow-dev`) |
| Couche de service | Synchronisation, programmation et déprogrammation Buffer côté serveur | Terminé |
| Essai réel | Brouillon → validation → programmation → modification → déprogrammation sur un vrai compte Buffer | Réussi le 8 octobre 2026 |

## Reste à faire

1. **Synchronisation automatique.** Aujourd'hui : bouton, ou tâche planifiée à installer. Ensuite n8n ([docs/N8N.md](docs/N8N.md)).
2. **Écran de gestion des clients et des utilisateurs.** Ils se créent pour l'instant dans Supabase (`supabase/seed.example.sql`).
3. **Notifications.** Le client n'est pas prévenu d'une nouvelle proposition, ni l'admin d'une décision.
4. **Essais Buffer complémentaires** : vidéo, post sans texte, Instagram et TikTok en mode rappel, médias téléversés dans Buffer.
5. **Changement de mot de passe et mot de passe oublié.**
6. **Déploiement** : Docker, HTTPS, sauvegardes. Le `Dockerfile` existe mais n'a jamais été exécuté.
7. **Assistant IA** : hors périmètre depuis le recentrage, à rediscuter.

## Décisions qui vous reviennent

- **Compte Buffer définitif.** Les essais ont utilisé le compte de test. Le compte Synology est sur l'offre gratuite : trois canaux, dix posts programmés, 3 000 requêtes par mois.
- **Fréquence de synchronisation.** Elle borne le temps pendant lequel une modification faite dans Buffer sur un post déjà programmé reste non détectée. Quinze minutes est un bon départ.
- **Validation par publication ou par campagne.** Aujourd'hui, le client valide chaque publication (une par canal). Un regroupement est possible plus tard.
- **Nom du produit.** « Cadence » est un nom de travail.
