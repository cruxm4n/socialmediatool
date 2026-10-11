# État réel du projet — 11 octobre 2026

## Lecture seule vis-à-vis de Buffer — état courant (branche `fix/cadence-read-only-buffer-2026-10-11`)

Branche créée depuis `origin/main` (`e637c8d`, fusion de la PR #2). Elle est locale : ni poussée, ni fusionnée, ni déployée.

**Cadence ne fait plus que lire Buffer.** Une approbation, une demande de modification, un commentaire ou une synchronisation n'y créent, n'y modifient, n'y programment et n'y annulent rien :

- le client du vrai Buffer (`src/server/publishing/buffer-provider.ts`) ne contient plus aucune mutation ; ses opérations d'écriture sont refusées sans appel réseau ;
- `CADENCE_BUFFER_WRITES` n'est plus lue : la définir n'ouvre rien ;
- `approvePost`, `approvePosts` et `runSync` n'appellent plus aucune programmation (`scheduleApprovedPosts` est supprimée) ; aucune boucle de fond n'interroge Buffer ;
- une publication programmée dans Buffer sans accord valable est **signalée** (alerte, rubrique « Programmées sans validation », synchronisation « partielle ») ; Cadence ne la déprogramme pas et ne peut pas l'empêcher. Le retour en brouillon fait à la main est constaté à la synchronisation suivante.

| Vérification (Node 24.21.0, Buffer simulé, piles locales neuves) | Résultat |
| --- | --- |
| Unitaires + SQL/RLS | 691/691, zéro ignoré |
| Dont nouvelle suite `tests/unit/buffer-read-only.test.ts` | 28/28 |
| Intégration native (pile neuve) | 83/83, dont multi-comptes 26/26 |
| E2E Chromium (pile neuve) | 62/62, zéro ignoré |
| Lint, TypeScript, build isolé | Réussis |

Évolution des tests par rapport à `e637c8d` (815 tests, 836 désormais) : 16 tests unitaires de l'ancienne programmation automatique sont **supprimés** parce que la fonction qu'ils appelaient n'existe plus (14 dans `sync.test.ts`, 1 dans `contre-audit-sync.test.ts`, 1 dans `v3-urgent.test.ts`) ; 37 sont ajoutés (dont six après une revue de non-régression : rapprochement d'une réservation héritée quand le tag, le texte, la date ou les médias diffèrent, et lecture d'une réponse illisible) ; les autres tests concernés sont réécrits pour vérifier le refus ou le constat en lecture seule. Deux contre-tests indépendants (`audit-independent-provider`, `audit-independent-sync`) ont dû changer avec le comportement : leurs empreintes dans `tests/audit-independent.sha256` sont actualisées, les six autres sont inchangées. Certaines assertions d'intégration réécrites comptent « au moins un » constat, la base étant partagée entre fichiers.

Limites inchangées : tout repose sur un Buffer simulé ; aucun compte Buffer réel, aucune base distante ni la production n'ont été sollicités. L'ancien moteur du Studio (`src/server/studio*.ts`) reste présent mais n'est importé par aucun écran, et ses écritures sont refusées par le client Buffer. Planificateur non activé ; voir [docs/SYNCHRONISATION.md](docs/SYNCHRONISATION.md). **NOT READY pour la production.**

Les sections ci-dessous décrivent l'état antérieur à cette branche et sont conservées pour la traçabilité.

## Corrections des tests après consolidation — état courant

**Toutes les suites locales passent après correction des 35 échecs hérités de `54cda08`.** Aucun fichier applicatif, migration ou dépendance n’est modifié par cette correction. Quatre tests supplémentaires vérifient le refus d’une connexion absente/révoquée/en révocation et une barrière d’écriture fermée.

| Vérification | Résultat final |
| --- | --- |
| Ciblés unitaires/SQL | 151/151 |
| Ciblés SQL après correction de la fixture historique | 53/53 |
| Ciblés intégration V3 | 19/19 |
| Unitaires | 460/460 |
| SQL/RLS PGlite | 210/210 |
| Total unitaires + SQL | 670/670, zéro ignoré |
| Intégration native | 83/83, zéro ignoré |
| Dont multi-comptes | 26/26 |
| E2E Chromium | 62/62, zéro échec/ignoré |
| Lint, TypeScript, build et calendrier navigateur | Réussis |
| Empreintes indépendantes | 8/8 ; sept inchangées, une actualisée pour le pilote |

Les tests Studio conservent le vrai `emissionProblem`. Seul le fournisseur Buffer est remplacé ; les tests natifs exécutent les vraies RPC sur une pile neuve. Le bloc complet des scénarios et assertions de `audit-independent-studio.test.ts` est identique octet par octet à `54cda08` ; seuls les imports, mocks de connexion et hooks d’environnement changent. L’empreinte actualisée est explicitement documentée, pas présentée comme inchangée.

Les 35 échecs relevaient des mocks/fixtures et d’une attente de message obsolète, sans bug applicatif identifié dans ces scénarios. Trois piles synthétiques neuves (V3 ciblée, intégration complète, E2E) sont utilisées puis arrêtées sans suppression. Preuves privées : `/home/ubuntu/cadence-recovery-backups/test-fixes-20261011T105608Z/validation`. Aucun appel Buffer réel, SQL distant, mutation de production ou désactivation de test.

**La publication GitHub peut être préparée ; le produit reste NOT READY pour le pilote réel.** Le flux manuel complet, les comptes Buffer réels, les médias et la restauration de production restent à qualifier. Les pourcentages précédents ne sont pas recalculés automatiquement à partir du seul passage des tests.

Les tableaux d’échecs ci-dessous décrivent les passages historiques avant correction ; ils sont conservés pour la traçabilité et ne représentent plus l’état courant des suites.

## Verdict

**NOT READY pour le pilote réel du nouveau périmètre. GO AVEC PRÉREQUIS pour poursuivre sur la référence récupérée.** Le portail et une grande partie de sa sécurité sont développés et testables localement. Le flux manuel préféré n'est pas encore le comportement complet du backend. La production est une ancienne version en simulation.

Référence : `/home/ubuntu/cadence`, branche `chore/cadence-consolidation-2026-10-11`, base `09cdeb1974f13301790d17fa2ab6a7150f6e8fab`. Production constatée : image `cadence-web:v1-2f51602`. Les commits locaux de nettoyage ne sont pas déployés.

## Estimation structurée du nouveau périmètre

- **Avancement du développement : environ 85 %.**
- **Fiabilité vérifiée : environ 75 %.**
- **Préparation à la production : environ 50 %.**

Ces nombres sont des estimations d'ingénierie, pas des mesures scientifiques ni des taux de tests réussis. Confiance **moyenne** pour développement/fiabilité locale, **faible à moyenne** pour production. Incertitude pratique de l'ordre de 10–15 points ; ne pas interpréter une différence de quelques points comme un progrès mesuré.

Les poids ci-dessous totalisent **100 %** du MVP simplifié. Pour chaque colonne : score = somme(poids × estimation de la ligne) / 100. Les valeurs intermédiaires sont 83,2 / 73,4 / 48,9 ; affichage arrondi par pas de cinq pour éviter une fausse précision. Le dénominateur exclut composition Studio et automatisation de publication future ; leur retrait peut augmenter mécaniquement l'avancement sans produire de nouvelle fonctionnalité.

Développement apprécie code, interface, backend et adéquation au nouveau besoin. Fiabilité apprécie vérifications réellement exécutées, limites des mocks et cas de panne/concurrence. Production apprécie aussi intégration réelle, accès client, exploitation, sauvegardes et retour arrière. Une fonctionnalité simulée peut avoir du code complet mais une fiabilité/production inférieure. La pondération donne plus de poids à l'isolation et à Buffer qu'aux écrans.

U = tests unitaires, S = SQL/RLS sur PGlite, I = intégration sur PostgreSQL/Auth/REST/Storage neufs, E = navigateur Chromium local avec Buffer simulé. La colonne preuves ne signifie pas que chaque scénario de la fonctionnalité est entièrement couvert. **Aucune intégration réelle Buffer ou validation de production effectuée pendant cette mission.**

| Fonctionnalité | Poids | Dév. | Fiabilité | Prod. | Code / interface / backend | Preuves et reste à faire |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Authentification client | 8 % | 90 % | 80 % | 60 % | Oui / oui / oui | E connexion/session expirée, I sessions réelles de test ; invitation et récupération réelles à valider |
| Gestion des clients | 6 % | 75 % | 70 % | 45 % | Oui / oui / partiel | E création/archivage/restauration et accès ; invitation Auth encore manuelle dans Supabase ; désactivation globale de compte non démontrée |
| Isolation multi-client | 14 % | 90 % | 85 % | 60 % | Oui / oui / oui | S/I RLS, décision/commentaires croisés, collisions ; E URLs directes ; médias externes publics et déploiement réel non certifiés |
| Connexions Buffer | 12 % | 85 % | 75 % | 40 % | Oui / oui / oui local | U/S/I/E deux comptes synthétiques, rotation/révocation/identité ; deux clés réelles et partage d'un compte entre clients NON VÉRIFIÉS |
| Synchronisation Buffer | 14 % | 80 % | 70 % | 35 % | Oui / oui / oui local | U/S/I/E import, verrous, panne, reprise et quotas ; pagination et formats/quotas réels, flux exclusivement lecteur à finaliser |
| Consultation des publications | 6 % | 95 % | 85 % | 70 % | Oui / oui / oui | E listes/filtres/fiches A/B ; exhaustivité et fidélité des formats Buffer réels à contrôler |
| Calendrier client et admin | 4 % | 90 % | 85 % | 65 % | Oui / oui / oui | E + navigateur sans réseau : mois/semaine, filtres, mobile, absence de déplacement ; brouillons sans date hors grille explicités |
| Prévisualisation médias | 6 % | 75 % | 55 % | 40 % | Oui / oui / partiel | U/S/I modèle Storage admin seul, E aperçus synthétiques ; URLs publiques, expiration, documents/carrousels/vidéos et métadonnées réelles à vérifier |
| Validation / refus | 8 % | 70 % | 60 % | 35 % | Oui / oui / partiel pour cible | S/I/E empreinte, concurrence, date, accord périmé ; couplage programmation et date future à retirer ; refus distinct de demande de changement à définir |
| Demandes de modification | 4 % | 90 % | 80 % | 60 % | Oui / oui / oui | E/I commentaire exigé, nouvelle version resoumise ; parcours manuel réel et notification à vérifier |
| Commentaires | 4 % | 95 % | 85 % | 65 % | Oui / oui / oui | E/I échanges admin/client et isolation ; remise de notification réelle non vérifiée |
| Historique et versions | 6 % | 85 % | 75 % | 55 % | Oui / oui / oui | S immutabilité, I posts/versions filtrés, E modification/revalidation ; module partagé extrait ; archivage/restauration et fidélité médias à compléter |
| Administration minimale | 4 % | 85 % | 75 % | 50 % | Oui / oui / oui local | E clients/connexions/erreurs, interface simplifiée ; retirer restes d'automatisation et clarifier accès/invitations |
| Déploiement et sauvegardes | 4 % | 55 % | 35 % | 25 % | Scripts / docs / exploitation existante | Image identifiée, bundle restauré et sources sauvegardées ; restauration DB/Auth/Storage actuelle, hors site et mise en service du nouveau MVP NON VÉRIFIÉES |
| **Total pondéré, arrondi** | **100 %** | **≈85 %** | **≈75 %** | **≈50 %** | — | Ne vaut pas autorisation de déploiement |

Les modules de consultation, calendrier, commentaires et demandes de modification sont **utilisables en laboratoire local**. Aucun module n'est déclaré terminé de bout en bout sur les deux comptes de production. Le fait qu'un ancien document rapporte un essai Buffer réel sur un canal X de test ne valide pas l'intégration actuelle multi-comptes ni LinkedIn/Instagram/Facebook/TikTok.

## Résultats des vérifications de cette mission

Toutes les vérifications applicatives utilisent Node **24.21.0**, un checkout indépendant sans `.env.local` et `CADENCE_NO_LOCAL_ENV=1`. Aucune clé Buffer réelle ni compte client réel utilisés. Les piles nouvelles ont secrets générés, données synthétiques, ports en boucle locale, répertoires et conteneurs distincts de toute production. Les piles préexistantes n'ont pas été modifiées.

| Vérification | Avant nettoyage | Après nettoyage / résultat retenu | Limite |
| --- | --- | --- | --- |
| Lint | Réussi | Réussi, contrôle final enregistré | Ne certifie pas la logique métier |
| TypeScript | Réussi | Réussi après régénération des types Next | Un premier contrôle avait des types générés pointant vers les routes retirées ; corrigé par `next typegen`, pas par assouplissement TS |
| Build Next isolé | Pas relancé séparément sur 09cdeb1 | Réussi | Compilation sans services réels ; pas une image déployée |
| Unitaires, 37 fichiers | 429/455, 26 échecs | **430/456, 26 échecs hérités** | Mocks ; 1 test partagé de versions ajouté |
| SQL/RLS PGlite, 12 fichiers | 208/210, 2 échecs | **208/210, 2 échecs hérités** | Rôles et fonctions SQL, pas Auth/Storage HTTP ni transactions simultanées |
| Ensemble U + S | **637/665, 28 échecs** | **638/666, mêmes 28 échecs**, aucun nouvel échec | Suite non verte ; ne pas l'exclure pour présenter un succès |
| Intégration native, 3 fichiers | **76/83, 7 échecs** ; database 38/38, multi-comptes 26/26, V3 12/19 | **76/83, mêmes 7 échecs**, database 38/38, multi-comptes 26/26, V3 12/19 | Buffer simulé persistant ; vrais PostgreSQL/Auth/Storage locaux |
| E2E portail, Chromium | Suite ancienne Studio non réexécutée avant retrait | **62/62 réussis, 0 échec, 0 ignoré**, environ 3 min 21 s | Navigation réelle locale, Buffer simulé ; 2 parcours Studio archivés hors suite active |
| Calendrier navigateur sans réseau | Non relancé séparément sur baseline | **Réussi** : clavier, mobile, filtres, mois/semaine et 8 contrôles de largeur | Aucun appel réseau ni base |
| Intégrité des contre-tests indépendants | Manifeste Git conservé | **8/8 empreintes conformes**, assertions intactes | Deux tests Studio indépendants restent en échec à cause de mock incomplet |
| Recherche de secrets | — | **Aucun motif détecté** : 323 fichiers de travail et 640 blobs historiques au premier passage | Recherche par motifs, pas preuve d'absence ; valeurs jamais affichées |
| Sauvegarde et récupération Git | — | **13 archives vérifiées, 3 bundles initiaux vérifiés ; clone restauré et fsck réussi** | Code/configurations uniquement ; pas restauration des données de production |
| Préservation des originaux | — | **0 fichier de travail changé** dans les quatre implantations initiales ; images/ID/état des 23 conteneurs préexistants inchangés | Instantanés au moment des contrôles, pas gel des autres sessions |

### Échecs hérités et essais intermédiaires

- `studio-push.test.ts` (21), `audit-independent-studio.test.ts` (2) et intégration V3 (7) : mocks `@/server/publishing` sans export `emissionProblem`, ajouté depuis les tests. Les assertions indépendantes n'ont pas été modifiées ; ne pas conclure que le scénario métier a été exercé jusqu'au bout.
- `sync.test.ts` (2) : mock de configuration sans `bufferWritesEnabled` et `BUFFER_WRITES_DISABLED`, incompatible avec la barrière réelle. Ce sont des tests de compatibilité d'un ancien schéma ; ne pas rouvrir la barrière réelle pour les faire passer.
- `provider.test.ts` (1) : ancienne attente du nom `BUFFER_API_KEY`, alors que l'erreur concerne désormais la clé de connexion. Les autres assertions de classification/retry restent à conserver lors de la correction.
- SQL `migrations.test.ts` et `notifications.test.ts` (2) : fixtures réutilisant un canal entre réel et mock, refusées par `channel_connection_mode_mismatch`. Préparer des connexions/canaux distincts plutôt que supprimer le garde-fou.
- Première suite E2E sur base réutilisée après intégration : 52/62 réussis, 7 échecs, 3 non exécutés. Deuxième sur base neuve : 57/62 réussis, 2 échecs d'attentes de tests, 3 non exécutés. Le test nouveau attendait à tort un lien Buffer réel sur un post simulé ; l'ancien test de panne attendait 200 au lieu de l'échec partiel 502. Les contrôles de panne et d'indépendance A/B ont été préservés et précisés. Troisième passage : 58 réussites, 1 échec (helper de test non encore exporté dans le worker chargé), 3 non exécutés ; export corrigé et vérifié par TypeScript, puis suite relancée sur une base neuve.
- Deuxième passage intégration sur base réutilisée : 74/83 réussis, 9 échecs. Un test de liste d'organisations était affecté par un membre ajouté lors du passage précédent ; N17 attendait un verrou trois secondes avec le rôle `anon` limité à trois secondes. Les paramètres constatés sont `anon=3s`, `authenticated=8s`. Le test N17 maintient désormais le verrou deux secondes **après le signal de verrou acquis**, avec les mêmes assertions. Aucun timeout de rôle ni contrôle de sécurité n'a été changé. Nouvelle suite finale sur une base neuve séparée : 76 réussites, mêmes 7 échecs hérités. N17 passe également trois répétitions supplémentaires, sans échec.

Les logs et JSON correspondants sont conservés sous `/home/ubuntu/cadence-recovery-backups/20261011T093314Z/validation`. Les erreurs de fixtures ne sont pas présentées comme fuite de données démontrée ; l'incapacité d'un test à conclure reste une limite de vérification.

## Contre-tests et invariants

| Invariant | Preuve locale | Limite / verdict |
| --- | --- | --- |
| A ne lit pas les posts/versions de B | I RLS et collisions, E URL directe | Vérifié sur base isolée ; production actuelle non vérifiée |
| A ne décide ni ne commente chez B | I/S RPC et policies, E espaces fermés | Vérifié localement |
| A ne télécharge pas le Storage de B | I V3 accès HTTP Storage, S policies | Modèle actuel **admin seul**, même propriétaire client refusé ; ne prouve pas que les aperçus Buffer externes sont privés |
| Une clé ne traverse pas les clients | I deux comptes persistants, U identité/routeur, S association | Réel non vérifié ; clé Buffer personnelle plus large qu'un seul client, garde-fou local nécessaire |
| Retrait d'accès empêche d'agir | I membre retiré, rôle changé et notifications annulées | Désactivation globale Auth/invitation entièrement administrée par Cadence non terminée |
| Modification après accord invalide | S/I empreinte et nouvelles versions, E modification pendant relecture | Seulement champs importés ; threads/métadonnées non lus et changement binaire derrière même URL restent des limites |
| Réponse tardive ne restaure pas un ancien état | S/I jetons de réservation, confirmation périmée et collision | Lecture réelle retardée, horodatages Buffer et tous formats non vérifiés |
| Deux jobs simultanés restent cohérents | I vraies transactions, E double sync, S réservations | Test N17 temporisation ajustée sans lever les limites ; conserver le suivi d'erreurs |
| Une erreur Buffer ne vaut pas approbation | S/I/E erreur et reprise | L'accord local reste distinct d'une programmation réussie ; simulation uniquement |
| Commentaires gardent le bon dossier | S/I/E lecture/décision filtrées | Vérifié sur données synthétiques |
| Panne VPS/Buffer conserve l'historique | I SIGKILL du worker et reprise, SQL historique durable | Ne remplace pas une restauration complète après perte du disque/volume |

## Six prérequis avant d'inviter deux vrais clients

1. **Flux manuel incomplet :** programmation/compensation encore dans actions, sync et boucle urgente ; contraintes de date future incompatibles avec validation avant programmation.
2. **Intégration réelle non vérifiée :** deux comptes, médias et formats, pagination, identité/rotation et quotas ; aucun verrou externe ne bloque la programmation humaine anticipée.
3. **Suites historiques non vertes :** 28 échecs U/S et 7 scénarios V3 arrêtés sur mocks ; corriger sans affaiblir les tests.
4. **Déploiement en retard :** production `2f51602` et mode simulé ; présence du code 0013 sur disque ne prouve pas sa présence applicative ni son schéma en production.
5. **Cycle d'accès et confidentialité médias incomplets :** invitation Auth manuelle, désactivation globale à prouver, URLs publiques Buffer et formats non affichés.
6. **Reprise d'exploitation non certifiée :** récupération Git démontrée ; restauration récente DB/Auth/Storage, clé maître et copie hors site non vérifiées.

Aucune nouvelle faille exploitable n'est certifiée par ces seuls prérequis ; ils sont des blocages de qualification du pilote. Aucun secret révoqué/rotaté, workflow n8n modifié, SQL distant appliqué ou client réel invité.

## Résultats finaux des suites isolées

Résultat retenu sur deux piles neuves distinctes :

- **E2E `portal-e2e.json` : 62/62 réussis**, aucun échec, aucun test ignoré. Inclut les trois nouveaux scénarios de retrait du Studio/calendrier en consultation et le parcours deux clients/deux comptes synthétiques, panne, reprise et révocation.
- **Intégration `verified-integration.json` : 76/83 réussis**, sept échecs hérités sur mock Studio incomplet. Database 38/38 ; multi-comptes 26/26 ; V3 12/19.
- **Concurrence N17 : trois répétitions supplémentaires réussies**, avec les limites de rôles maintenues.
- **U/S `cleanup-unit-sql.json` : 638/666 réussis**, mêmes 28 échecs qu'avant les changements ; une nouvelle assertion d'historique partagée réussie.
- **Lint, types, build, calendrier navigateur et empreintes indépendantes : réussis.**

Les quatre passages E2E successifs et la répétition d'intégration restent documentés, y compris leurs échecs intermédiaires. Le dernier passage E2E a été exécuté après correction de tous les tests concernés, sans édition de ceux-ci pendant la suite. Les services créés pour ces vérifications ont été arrêtés en conservant conteneurs, volumes et données ; aucun service préexistant n'a été arrêté. La simulation n'est pas une validation en production.

## Nouvelle vérification de consolidation

Base applicative inchangée : `c0af3a0`. La nouvelle branche `chore/cadence-consolidation-2026-10-11` conserve le même code, les mêmes migrations, dépendances et assertions. Les références d’archive préservent l’historique divergent sans le fusionner. Aucun gain fonctionnel ni hausse des pourcentages n’est revendiqué.

| Vérification réexécutée | Résultat | Portée |
| --- | --- | --- |
| Lint, build isolé, TypeScript | Réussis | Node 24.21.0, configuration propre |
| Calendrier navigateur sans réseau | Réussi | Lecture seule, navigation, filtres, mobile |
| Unitaires + SQL/RLS PGlite | 638/666, 28 échecs | Ensemble des échecs identique au passage antérieur, pas seulement le nombre |
| Intégration native | 76/83, 7 échecs | Database 38/38 ; multi-comptes 26/26 ; V3 12/19 ; mêmes échecs |
| E2E Chromium | 62/62, zéro échec ou ignoré | Deuxième pile neuve, Buffer simulé |
| Empreintes indépendantes | 8/8 conformes | Aucun test modifié |

Deux nouvelles piles exclusivement locales ont été créées puis arrêtées, avec conteneurs, volumes et réseaux conservés. Supabase distant, Buffer réel, n8n et production n’ont pas été sollicités par ces suites. Les limites et prérequis précédents restent applicables : **NOT READY pour la production**. Preuves privées : `/home/ubuntu/cadence-recovery-backups/consolidation-20261011T103558Z/validation`.
