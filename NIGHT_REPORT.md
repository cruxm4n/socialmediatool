# Rapport de nuit — audit et améliorations

Session du 8 octobre 2026, en autonomie. Travail sur la branche Git `nuit/audit-ameliorations` (la branche `main` contient l'état d'avant la session).

## En bref

- **Stable** : les 107 tests automatiques passent, et le parcours complet a été rejoué deux fois sur le vrai Buffer (canal X de test), avec nettoyage vérifié.
- **Trois bugs réels corrigés**, dont un qui touchait le mobile et un qui pouvait laisser une publication bloquée sans jamais être programmée.
- **Rien n'a été déployé, rien n'a été publié.** Aucune page Synology, aucune donnée de production n'a été touchée.
- **Une action de votre part est à prévoir avant le 14 octobre** : voir « Actions manuelles ».

## Actions manuelles nécessaires

1. **Un vrai post est programmé sur X pour le mercredi 14 octobre à 09:39 (heure de Paris).** Vous l'avez créé, fait approuver et programmer via le dashboard pendant la soirée. Son texte commence par « vfdsfsdfsdfsd » : s'il s'agit d'un essai, supprimez-le ou repassez-le en brouillon dans Buffer, sinon il sera publié. Je ne l'ai pas modifié.
2. **Régénérez la clé d'API Buffer.** Elle a transité par la conversation. Mettez la nouvelle dans `.env.local` puis relancez l'application.
3. **Relancez votre serveur de développement** (`npm run dev`). Celui qui tourne a été lancé avant que le script ne limite l'écoute à `127.0.0.1` : il écoute encore sur toutes les interfaces réseau.
4. **Fusionnez la branche si le résultat vous convient** : `git checkout main && git merge nuit/audit-ameliorations`.
5. **Dans Supabase** (Authentication > Policies de mot de passe) : activez la protection contre les mots de passe compromis. C'est un réglage du projet que je ne peux pas modifier.
6. **Disque.** Il était plein à 100 % en fin de session. J'ai vidé le cache de téléchargement de npm (1,9 Go, entièrement régénérable) : il reste 2,2 Go. Le dossier `.next/dev` de votre serveur de développement pèse 717 Mo et se vide en supprimant `.next` serveur arrêté.

## Bugs détectés et corrigés

| # | Bug | Gravité | Correction |
| --- | --- | --- | --- |
| 1 | Sur mobile, plusieurs pages (vue d'ensemble, liste des publications, accueil et historique client) s'élargissaient jusqu'à 926 px sur un écran de 390 px | Élevée : pages peu utilisables au téléphone | Colonnes de grille explicites sur toutes les mises en page ; un test vérifie désormais chaque page |
| 2 | Après cinq échecs de programmation, une publication approuvée n'était plus jamais retentée | Élevée : une panne Buffer de quelques minutes pouvait bloquer définitivement une publication validée | Nouvel essai au plus une fois par heure, sans abandon |
| 3 | Une session expirée pendant une action (commenter, approuver) ne produisait rien de visible : le bouton restait sans effet | Moyenne | L'action répond « session expirée » et l'interface renvoie vers la connexion |
| 4 | Le client pouvait approuver une publication dont la date était déjà passée ; elle restait « approuvée » sans pouvoir être programmée | Moyenne | Refus par la base et bouton désactivé, avec une explication ; la demande de modification reste possible |
| 5 | Quota Buffer atteint : chaque publication en attente consommait une tentative et un appel inutile | Moyenne | Arrêt des appels dès le premier refus, reprise à la synchronisation suivante |
| 6 | Un client pouvait lire les événements techniques (messages d'erreur de Buffer) en interrogeant l'API directement | Faible : uniquement sur ses propres publications | Fermé par la règle de sécurité de la base |
| 7 | En mode simulé, les publications « publiées » des séries de tests précédentes s'accumulaient dans les listes (huit doublons constatés) | Faible : mode de test uniquement | Seule la série en cours est affichée |
| 8 | Compte valide dans Supabase mais sans profil dans l'application : boucle sur la page de connexion | Faible | Message clair, session refermée |
| 9 | Fiche admin d'une publication supprimée dans Buffer : affichée comme si elle existait encore | Faible | Bandeau « Supprimée dans Buffer » |

## Améliorations réalisées

### Fiabilité
- Client Buffer : délai maximal de quinze secondes par appel ; une lecture est retentée une fois après une panne passagère ; une écriture ne l'est jamais, car on ignore si Buffer l'a prise en compte.
- Clé refusée (401) et panne de Buffer (5xx) donnent des messages distincts.
- Si Buffer ne renvoie aucun canal, la synchronisation ne conclut plus que toutes les publications ont été supprimées.
- Page d'erreur avec bouton « Réessayer » quand la base est injoignable.
- Canal déconnecté dans Buffer : alerte sur la fiche de la publication.

### Sécurité
- En-têtes de sécurité sur toutes les réponses : l'application ne peut plus être affichée dans le cadre d'un autre site.
- Le lien « Voir sur le réseau » n'accepte que des adresses `http(s)`.
- Revue complète des droits : aucune fuite entre clients trouvée. Les tests d'isolation existants passent tous.
- Vérification qu'aucun secret n'est versionné dans Git avant le premier commit.

### Ergonomie
- Les quatre indicateurs de la vue d'ensemble ouvrent la liste filtrée sur le statut correspondant.
- Après une décision, la fiche propose la « publication suivante à valider ».
- Synchronisation automatique à l'ouverture de l'espace admin si la dernière date de plus de quinze minutes : le dashboard se tient à jour sans n8n.
- Icône de l'application dans l'onglet du navigateur.

### Performance
- Un seul client Supabase par requête au lieu d'un par lecture.
- L'historique n'envoie plus la liste de tous les identifiants de publications dans l'adresse de la requête.
- Les publications publiées depuis plus de 90 jours ne sont plus chargées.
- Temps de chargement mesurés en local, base distante : entre 0,8 et 2,1 secondes par page.

### Qualité du code
- Projet placé sous Git, trois commits cohérents.
- Sept composants d'interface inutilisés supprimés ; l'outil `shadcn` déplacé en dépendance de développement.
- Type commun `ActionResult` pour toutes les actions serveur.
- Migration SQL versionnée : `supabase/migrations/0002_fiabilite.sql`.

## Tests exécutés

| Suite | Avant | Après | Résultat |
| --- | --- | --- | --- |
| Règles et couche de service (`npm run test`) | 30 | 48 | 48 réussis |
| Base de données (`npm run test:db`) | 22 | 25 | 25 réussis |
| Parcours navigateur (`npm run test:e2e`) | 26 | 34 | 34 réussis |
| Lint, typage, compilation | — | — | Sans erreur ni avertissement |

Nouveautés principales : la couche de service est testée isolément (rien n'est programmé si le texte, la date ou les médias ont changé dans Buffer) ; débordement mobile vérifié sur les onze pages ; session expirée ; date dépassée ; en-têtes de sécurité.

**Essai réel sur Buffer, rejoué après les modifications** (canal X de test, posts rugby datés du 15 décembre, supprimés) : brouillon tagué visible de la bonne cliente et d'elle seule, approbation, statut « programmé » confirmé par l'API Buffer, aucune reprogrammation après deux synchronisations, modification détectée, retour en brouillon, suppression. Contrôle final : zéro post de test restant ; votre post du 14 octobre intact. Quota : 421 requêtes restantes sur 500 pour la journée.

Le premier lancement de cet essai a échoué sur une erreur de mon script de test, pas de l'application ; les posts créés ont été supprimés et l'essai relancé avec succès.

## Problèmes restants

- **Fenêtre entre deux synchronisations.** Un post programmé puis modifié dans Buffer reste programmé jusqu'à la synchronisation suivante. Sans planificateur, cette fenêtre dépend de l'ouverture de l'espace admin.
- **Messages d'erreur dans la table des publications.** Les colonnes `schedule_error` et `buffer_error` restent lisibles par un client qui interrogerait l'API directement, sur ses propres publications uniquement.
- **Fonctions d'automatisation protégées par le seul secret partagé** : choix assumé (DECISIONS.md, D12), signalé en avertissement par Supabase.
- **Vulnérabilités npm : 9 « high », toutes dues au même paquet (`braces`)**, pour lequel aucune version corrigée n'existe. Il n'est utilisé que par des outils de développement (lint, `shadcn`), jamais par l'application en fonctionnement.
- **Non essayé sur le vrai Buffer** : vidéo, post sans texte, Instagram, TikTok, médias téléversés dans Buffer.
- **Une page de publication introuvable** répond avec le code HTTP 200 au lieu de 404 (l'affichage est correct).
- **Canal supprimé dans Buffer** : il reste listé dans la page Clients sans indication.
- **Docker** : fichiers présents, jamais exécutés (disque insuffisant pour essayer).
- **Node.js 20** : Supabase annonce la fin de sa prise en charge ; passer à Node 22.
- **Accessibilité** : navigation au clavier et lecteurs d'écran non audités de façon systématique.

## Évolutions recommandées, par ordre de priorité

1. **Brancher un planificateur** (n8n ou cron, voir `docs/N8N.md`) : c'est ce qui réduit le plus le risque restant.
2. **Notifications par e-mail** : prévenir le client d'une proposition, et vous d'une décision ou d'un échec.
3. **Écran de gestion des clients et des utilisateurs**, pour ne plus passer par Supabase.
4. **Essais Buffer avec médias et Instagram**, avant d'y connecter un vrai client.
5. **Bouton « tout approuver »** pour une campagne sur plusieurs réseaux.
6. **Vue réservée au client dans la base**, pour masquer aussi les colonnes d'erreur.
7. **Mot de passe oublié et changement de mot de passe.**
