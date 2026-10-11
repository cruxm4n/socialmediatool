> **Fonction abandonnée pour le nouveau produit, 11 octobre 2026.** L’interface Studio est retirée de la branche de nettoyage. Ce document décrit le fonctionnement historique conservé pour comprendre les données, migrations et tests. Ne pas appliquer de suppression SQL sur sa seule lecture. Voir [CLEANUP_REPORT.md](../CLEANUP_REPORT.md).

# Content Studio

**État : développé et testé localement. Rien n'est activé : la base n'a pas la migration `0008`, aucun fichier n'a été déposé dans Supabase, aucun brouillon n'a été créé dans Buffer.** Sans la migration, les écrans du Studio affichent « Le Studio n'est pas encore activé » et le reste de Cadence fonctionne comme avant.

## Ce que fait le Studio

| Besoin | Où | Comment |
| --- | --- | --- |
| Créer un contenu | Administration → **Studio** → Nouveau contenu | Choix du client, puis d'un ou plusieurs de ses canaux |
| Un texte par réseau | Éditeur, onglets par canal | Un nouveau canal reprend le texte affiché ; « Copier ce texte sur tous les canaux » |
| Hashtags | Éditeur | Communs au contenu, ajoutés à la fin de chaque texte, sans doublon avec ceux déjà écrits |
| Date et heure | Éditeur | Dans le fuseau du client ; alerte si une autre publication du même canal est prévue à moins de 30 minutes |
| Sauvegarde automatique | Éditeur | 1,2 seconde après la dernière frappe ; indicateur « Enregistré » ; deux onglets ne s'écrasent pas |
| Médias | Studio → **Médias**, ou bouton Bibliothèque de l'éditeur | Dépôt d'images et de vidéos (glisser-déposer), une bibliothèque par client |
| Carrousel | Éditeur | Plusieurs médias, ordre modifiable |
| Aperçu | Éditeur, colonne de droite | L'aperçu par réseau déjà utilisé pour les fiches |
| Formats compatibles | Éditeur, « Contrôles avant envoi » | Longueur, nombre de hashtags, média obligatoire, nombre et type de médias, durée de vidéo, recadrage Instagram |
| Calendrier | Administration → Calendrier | Les contenus du Studio y figurent ; un brouillon se déplace par glisser-déposer (jour changé, heure conservée) |
| Envoi en validation | Bouton de l'éditeur | Crée un brouillon tagué par canal dans Buffer |
| Commentaires, demandes de modification | Inchangé | Espace client et fiche de la publication |
| Historique des versions | Fiche d'une publication (admin et client) | Texte, date et médias de chaque version |
| Approbation groupée | Espace client → À valider | Cases à cocher, « Approuver la sélection » |
| Notifications | Inchangé (voir NOTIFICATIONS.md) | Le client est prévenu dès que le brouillon entre en validation |

## L'architecture, en une image

```
   STUDIO (Cadence)                      BUFFER                      CIRCUIT EXISTANT (inchangé)
┌────────────────────┐   « Envoyer   ┌──────────────┐   relecture   ┌───────────────────────────┐
│ contenu            │  en validation│ brouillon     │  de Buffer    │ publication « à valider » │
│  ├ texte LinkedIn  │──────────────►│ tagué         │──────────────►│  → le client approuve     │
│  ├ texte Instagram │  un brouillon │ « À valider » │               │  → Cadence programme      │
│  ├ médias, date    │  par canal    │ (pas programmé)│              │  → Buffer publie          │
└────────────────────┘               └──────────────┘               └───────────────────────────┘
  visible de vous seul                                               empreinte, versions, RLS
```

Le Studio s'arrête à la création du brouillon. Tout ce qui protège la validation — empreinte du contenu, annulation de l'accord si le contenu change, programmation réservée aux publications approuvées, isolation entre clients — est le circuit qui existait déjà, **sans une ligne modifiée**. C'est le choix d'architecture minimal : le client valide toujours exactement ce que Buffer publiera.

Conséquence à connaître : le contenu est créé dans Buffer **au moment de l'envoi en validation**, pas au moment de l'approbation. Buffer voit donc les brouillons en attente (ils comptent dans ses limites de brouillons, pas dans celles des posts programmés).

### Ce qui change par rapport à la règle « Cadence n'édite aucune publication »

Cette règle datait du recentrage du 8 octobre. Le Studio la remplace par : **Cadence prépare, Buffer publie.** Voir DECISIONS.md, D20. Les publications créées directement dans Buffer continuent de fonctionner comme avant, tag « À valider » compris.

## Garde-fous

| Risque | Protection |
| --- | --- |
| Publier ou programmer sans accord | Le Studio n'appelle jamais la programmation. Il crée avec `saveToDraft: true` ; si Buffer renvoyait malgré tout un post programmé, il est aussitôt repassé en brouillon. La programmation reste `claim_posts_for_scheduling_in_mode`, qui exige une approbation à l'empreinte inchangée. |
| Créer deux fois le même brouillon (double clic, deux onglets, nouvel essai) | La base réserve chaque texte avant l'appel à Buffer et retient l'identifiant du brouillon créé. Un texte déjà dans Buffer est mis à jour, jamais recréé. |
| Envoi interrompu entre Buffer et la base | Il n'est pas repris d'office : Cadence demande de vérifier dans Buffer, puis une confirmation explicite. |
| Modifier un contenu déjà approuvé | Le renvoi met Buffer à jour ; à la relecture, la base constate le changement et annule l'accord. Le client est prévenu. |
| Déplacer une publication approuvée dans le calendrier | Confirmation demandée : la date fait partie de ce que le client valide. Une publication programmée ou publiée ne se déplace pas d'ici. |
| Envoyer vers le canal d'un autre client | Un contenu n'accepte que les canaux et les médias de son client ; contrôle refait à l'envoi (canal transféré entre-temps). |
| Un client qui verrait des brouillons | Les tables du Studio et la bibliothèque sont lisibles par l'administrateur seul (RLS). Le client ne voit une publication qu'une fois entrée en validation. |
| Fichiers accessibles à tous | Espace de stockage privé ; lecture et dépôt réservés à l'administrateur ; aucune règle de modification ni de suppression. Les adresses d'affichage expirent après une heure. |
| Tests qui publieraient | Les tests utilisent le Buffer simulé ou un faux réseau. Aucun n'appelle Buffer. |

## Activation — à faire par vous, dans cet ordre

1. **Appliquer `0008_studio.sql`** (après `0007`), comme les précédentes : voir MISE_EN_SERVICE.md. Elle crée l'espace de stockage privé `media`, quatre tables et les fonctions. Vérification : requête 5 de `supabase/outils/verification.sql`.
2. **Vérifier l'espace de stockage** dans Supabase → Storage : `media` existe, privé, limité à 50 Mo par fichier.
3. **Premier essai en Buffer simulé** (`BUFFER_MODE=mock`, le réglage par défaut) : créer un contenu, déposer une image, envoyer en validation. Rien ne sort vers Buffer ; la publication apparaît « à valider » dans l'espace du client de démonstration.
4. **Créer le tag « À valider » dans Buffer** s'il n'existe pas sur le compte définitif : le Studio ne crée pas de tag et refuse d'envoyer sans lui.
5. **Premier essai réel, sur le canal de test uniquement** (règle du projet) : un contenu daté loin dans le futur, envoyé en validation, vérifié dans Buffer, puis supprimé dans Buffer. C'est cet essai qui lèvera les inconnues ci-dessous.

## Ce qui n'a pas pu être vérifié sans vous

Les appels à Buffer du Studio sont conformes au schéma de l'API (relu le 9 octobre 2026) et testés contre un faux réseau, **mais aucun n'a été exécuté sur le vrai Buffer**, puisque cela crée du contenu. À vérifier lors du premier essai réel :

| Point | Pourquoi c'est une inconnue | Si cela échoue |
| --- | --- | --- |
| Buffer télécharge-t-il le média à la création du brouillon, ou plus tard ? | L'adresse remise à Buffer expire au bout de 7 jours | Allonger la durée (`BUFFER_URL_SECONDS` dans `src/server/studio.ts`) ou resigner à la programmation |
| `editPost` accepte-t-il de changer la date d'un brouillon ? | Seul le passage brouillon ↔ programmé a été essayé en réel | Le déplacement au calendrier renverra l'erreur de Buffer ; la date se changera dans Buffer |
| Métadonnées exigées par Instagram et Facebook (`type`, `shouldShareToFeed`) | Renseignées d'après le schéma, non essayées | Buffer refusera la création avec un message explicite, affiché sur le canal |
| Vidéos, carrousels mêlant images et vidéos | Jamais essayés en réel (déjà noté dans BUFFER.md) | Idem |
| Dépôt de fichier depuis le navigateur | **Vérifié** sur une base Supabase locale (9 octobre), y compris dans l'image Docker. Reste à confirmer sur le projet hébergé (plafond de taille du plan) | Le message d'erreur de Supabase s'affiche |
| Droits réels de Supabase sur `storage.objects` | **Vérifiés** sur un vrai stockage Supabase local (bucket privé, politiques lecture et dépôt seulement) | À revérifier une fois sur le projet hébergé |

## Limites connues

- **Mêmes médias pour tous les canaux d'un contenu.** Seul le texte varie par réseau. Un visuel différent par réseau demande deux contenus.
- **Les limites de formats sont indicatives** (valeurs publiées par les réseaux en octobre 2026). Buffer reste juge ; l'API de Buffer expose ses propres règles (`configuration`), qui pourraient les remplacer.
- **Pas de recadrage ni de retouche** : les médias sont envoyés tels quels.
- **Pas de glisser-déposer sur mobile** : la date se change dans l'éditeur.
- **Identité de la tentative** (mission V3, C02) : chaque envoi porte un identifiant de tentative (`push_attempt_id`) avec la photographie du contenu (texte, date, hashtags, nature des médias, canal, révision, ancien identifiant). Toute confirmation le représente : la réponse **tardive** de la même tentative devenue « inconnue » est rapprochée sans recréation ; celle d'une **autre** tentative (nouvelle révision, variante retirée puis réajoutée, envoi débloqué entre-temps) n'est jamais appliquée à la tentative courante : le brouillon créé est consigné comme **orphelin** (`studio_variants.push_orphans`, journal `studio_push_events`) et signalé « à supprimer dans Buffer ». Aucune nouvelle révision, retrait/réajout de variante, archivage/restauration ni double clic ne contourne le verrou d'un envoi inconnu ou abandonné (cinq minutes).
- **Pendant une création, toute erreur qui n'est pas un refus prouvé sans effet est « inconnue »** (réponse perdue ou illisible, exception inattendue après l'appel, `UNEXPECTED`) ; l'enregistrement local d'une création réussie est retenté (3 essais) avant de laisser la tentative à résoudre.
- **Adoption** : automatique seulement pour une correspondance exacte, unique, en brouillon et **sans média** (l'identité des médias ne se prouve pas : adresses réhébergées). Avec médias, ou statut `error`/`sent`/`sending`/`scheduled`, une personne décide dans Buffer ; une lecture impossible des identifiants déjà rattachés n'autorise aucune adoption. La réconciliation respecte une pause de quota.
- **Absence confirmée** : dérogation à la garantie automatique, pour **une tentative précise**, avec une **preuve consignée** (texte saisi : ce qui a été vérifié et où ; qui, quand) ; le risque de doublon subsiste et l'écran le dit. Pas de confirmation globale aveugle.
- **« Soumis au client »** n'est affirmé que si une relecture fraîche montre une ligne du **même texte exact**, de la **même date**, du **propriétaire attendu**, non retirée, **taguée**, encore en brouillon et en attente de décision ; une ancienne ligne, une synchronisation sautée ou en échec ne suffisent pas.
- **Résultat inconnu ou envoi interrompu** : si Buffer n'a pas répondu à une création, ou si le serveur s'est arrêté pendant un envoi, le brouillon existe peut-être. Aucun renvoi n'est possible (il n'y a plus de « renvoi forcé »). « Vérifier dans Buffer » cherche le brouillon (canal, texte, date, nature des médias, tous statuts) : trouvé, il est adopté et mis à jour, jamais recréé ; des ressemblances ou une lecture partielle demandent une décision humaine. Si rien n'est trouvé, Cadence **ne peut pas** conclure qu'il n'existe pas : après avoir vérifié dans Buffer et **consigné ce qui a été vérifié**, « J'ai vérifié : aucun brouillon » autorise le renvoi (au moins 10 minutes après l'incident). Voir DECISIONS.md D30.
- **Quota Buffer** : pendant une pause, l'envoi, le changement de date et la programmation après approbation sont refusés avec le délai ; le bouton « Synchroniser » reste le seul passage manuel.
- **Un brouillon modifié à la main dans Buffer** après son envoi sera écrasé par le prochain renvoi depuis le Studio. Choisir un seul endroit pour corriger un contenu donné.
- **Retirer un canal d'un contenu déjà envoyé** ne se fait pas d'ici : supprimer le brouillon dans Buffer.
- **Archiver un contenu** ne supprime rien dans Buffer.
- **Stories, premiers commentaires, mentions, lieux** : hors périmètre.
