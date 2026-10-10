# Mise en service : ce qu'il reste à autoriser

Tout ce qui suit a été préparé et testé **localement**. Rien n'a été appliqué à Supabase, rien n'a été déployé, aucun planificateur ne tourne, aucun e-mail n'est parti. Chaque étape est indépendante de la suivante : vous pouvez vous arrêter après n'importe laquelle.

## 1. Fusionner les branches

Les branches s'empilent sans divergence : chacune contient la précédente.

```
main (état initial)
 └─ nuit/audit-ameliorations
     └─ fiabilite/corrections-p0        migrations 0003 (appliquée) et 0004
         └─ admin/gestion-clients       migration 0005, écrans Clients
             └─ v2/fondations           migrations 0006 et 0007, Cadence V2
                 └─ studio/content-studio   voir docs/STUDIO.md
```

Fusionner revient donc à avancer `main` jusqu'à la branche voulue, sans conflit possible :

```bash
git checkout main
git merge --ff-only v2/fondations      # ou studio/content-studio pour tout prendre
git push origin main                    # seulement quand vous voulez publier sur GitHub
```

`--ff-only` refuse la fusion si quelqu'un a modifié `main` entre-temps, au lieu de créer un mélange. Les anciennes branches peuvent ensuite rester ou être supprimées (`git branch -d <nom>`), au choix. Le fichier `MISSION_CODEX.mddsds` à la racine n'est suivi par aucune branche : c'est une copie mal nommée de `MISSION_CODEX.md`, laissée telle quelle.

## 2. Appliquer les migrations

État connu de la base `socialflow-dev` (sondé en lecture seule le 9 octobre 2026) : `0001`, `0002`, `0003` appliquées.

**L'application fonctionne à chaque étape intermédiaire** : chaque écran signale la migration qui lui manque au lieu de planter.

| Migration | Apporte | Sans elle |
| --- | --- | --- |
| `0004_fiabilite_statuts.sql` | Tag retiré après validation, posts programmés absents de la lecture | Deux cas limites mal traités |
| `0005_gestion_clients.sql` | Clients, canaux, accès | Écrans Clients en lecture seule |
| `0006_sync_planifiee.sql` | Verrou et état de synchronisation | Pas de verrou entre processus, pas de suivi du planificateur |
| `0007_notifications.sql` | Notifications (simulées par défaut) | Écran Notifications « indisponible » |
| `0008_studio.sql` | Content Studio, espace de stockage des médias, historique des versions | Studio « pas encore activé », pas de panneau Versions |

Procédure, identique pour chacune, dans Supabase → *SQL Editor* :

1. Lancer la requête 2 de `supabase/outils/verification.sql` et garder le résultat (photographie des données).
2. Coller le fichier de migration et l'exécuter. Chaque fichier s'exécute en une transaction : en cas d'erreur, rien n'est changé.
3. Relancer les requêtes 1 et 5 (migrations en place), 2 (données inchangées) et 3 (droits).

Ordre conseillé : `0004`, `0005`, `0006`, `0007`, `0008`. `0004` et `0005` sont indépendantes l'une de l'autre ; toutes peuvent être rejouées sans dommage (testé). `0008` demande `0005` (fonctions d'administration) et crée un espace de stockage : c'est la seule qui touche au schéma `storage`.

Retour arrière de chacune : `supabase/outils/000X_retour_arriere.sql` (tous testés localement). Aucun ne supprime de données.

## 3. Activer le planificateur

Après `0006`. Une commande, au choix parmi trois moyens : [docs/PLANIFICATEUR.md](PLANIFICATEUR.md). **À décider avant : la fréquence**, selon le compte Buffer définitif (5 minutes dépasse le quota de l'offre gratuite).

## 4. Activer l'envoi réel des notifications

Après `0007`, et après avoir observé quelques jours de notifications « simulées ». Trois réglages et un workflow n8n : [docs/NOTIFICATIONS.md](NOTIFICATIONS.md).

## 5. Activer le Content Studio

Après `0008`. Cinq étapes, dont un premier essai en Buffer simulé puis un essai réel sur le canal de test : [docs/STUDIO.md](STUDIO.md).

## 6. Essai réel

La procédure détaillée (sauvegarde, migrations vérifiées une à une, Docker, checklist du canal X) est dans [PILOTE.md](PILOTE.md). La validation locale du 9 octobre est dans TESTING.md ; elle remplace la mention « non exécuté » ci-dessous pour `test:db` et `test:e2e`.

## 7. Ce qui n'a pas pu être vérifié localement

| Vérification | Pourquoi | Ce qu'il faut |
| --- | --- | --- |
| `npm run test:db` et `npm run test:e2e` (dont `05-v2.spec.ts`) | Ils écrivent dans une base | Un projet Supabase de test dédié, variables `TEST_*` |
| Planificateur en conditions réelles | Il appellerait Buffer et écrirait dans la base | Votre accord, sur le compte Buffer de test |
| Envoi réel d'un e-mail | Interdit pendant le développement | n8n et une messagerie |
| Image Docker et service `scheduler` | Jamais construits ni lancés | Le déploiement |
| Appels Buffer du Studio (création, mise à jour, changement de date d'un brouillon), dépôt de fichiers | Ils créent du contenu dans Buffer et dans Supabase | Votre accord, sur le canal de test — détail dans STUDIO.md |
| Droits réels de Supabase sur les nouvelles tables | La base locale imite Supabase sans l'être | La requête 3 de `verification.sql`, puis `npm run test:db` |
