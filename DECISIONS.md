# Décisions structurantes

Chaque entrée : la décision, sa raison, et ce qu'elle coûte.

## D1 — Calendrier sur mesure plutôt que FullCalendar

**Décision.** Le calendrier est un composant maison, en lecture seule.

**Pourquoi.** Les besoins sont simples (un mois, une semaine, des miniatures, des filtres) et un composant maison s'accorde avec le reste de l'interface. Le glisser-déposer du prototype a été retiré lors du recentrage (D10) : les dates se modifient dans Buffer.

## D2 — (abandonnée) Date fictive figée

Le prototype utilisait une date simulée. Depuis le passage aux données réelles, l'application utilise l'heure réelle. Les publications du Buffer simulé sont datées par rapport au jour courant.

## D3 — Règles métier dans des fonctions pures

**Décision.** Transitions de statut, règles de déplacement et contraintes par réseau vivent dans `src/lib/domain/`, sans dépendance à l'interface ni à la base.

**Pourquoi.** Elles sont testables isolément. Les règles qui engagent la sécurité ou la cohérence (qui peut décider, quoi programmer) sont, elles, dans des fonctions SQL : voir D11.

## D4 — La date fait partie de ce que le client valide

**Décision.** L'empreinte validée couvre le texte, les médias, le canal et la date (à la minute). Changer l'un d'eux dans Buffer annule la validation.

**Pourquoi.** Une approbation ne doit jamais couvrir un contenu modifié après coup. C'est le choix le plus sûr.

**Coût.** Décaler une publication d'une heure redemande une validation.

## D5 — Le client ne voit pas les brouillons

**Décision.** Un brouillon Buffer n'est transmis au client que s'il porte le tag « À valider ». La règle est appliquée par la base (RLS), pas par l'interface.

**Pourquoi.** Un brouillon est un document de travail de l'agence. Le tag vous laisse décider du moment, sans quitter Buffer.

## D6 — Pictogrammes de réseaux dessinés pour le projet

**Décision.** Les icônes des quatre réseaux sont des dessins simplifiés maison.

**Pourquoi.** Lucide ne fournit plus d'icônes de marques, et le cahier des charges demande de ne pas reprendre de ressources propriétaires.

## D7 — Serveur de développement limité à la machine locale

**Décision.** `npm run dev` et `npm run start` écoutent sur `127.0.0.1` uniquement.

**Pourquoi.** Par défaut Next.js écoute sur toutes les interfaces réseau. Sur une machine joignable depuis Internet, le prototype serait alors exposé.

## D8 — npm comme gestionnaire de paquets

**Décision.** npm, déjà installé. Pas de pnpm ni de yarn.

**Pourquoi.** Un outil de moins à installer et à comprendre.

## D9 — Typographies Instrument Sans et Fraunces

**Décision.** Instrument Sans pour l'interface, Fraunces (serif) pour les titres.

**Pourquoi.** Le duo donne un caractère éditorial et évite l'allure de gabarit d'administration. Les polices sont téléchargées à la compilation puis servies par l'application, sans appel à Google pour les visiteurs.

## D10 — Buffer crée et publie, Cadence valide

**Décision.** Cadence ne crée, ne modifie et ne date aucune publication. L'éditeur, l'envoi de médias, le glisser-déposer, les idées et la médiathèque du prototype ont été supprimés.

**Pourquoi.** Buffer fait déjà tout cela, mieux, et gère les connexions aux réseaux. Refaire ces fonctions aurait coûté des semaines pour un résultat inférieur.

**Coût.** Deux outils pour vous (Buffer pour produire, Cadence pour suivre les validations). Les limites de Buffer deviennent celles du produit : voir docs/BUFFER.md.

## D11 — Les règles sensibles vivent dans des fonctions SQL

**Décision.** Synchronisation, décision du client, réservation avant programmation : chacune est une fonction SQL exécutée en une transaction.

**Pourquoi.** Trois raisons. Elles sont atomiques, donc deux validations ou deux programmations simultanées ne peuvent pas se marcher dessus. Elles s'appliquent quel que soit l'appelant, application aujourd'hui, n8n demain. Et l'isolation entre clients ne dépend d'aucun code d'interface.

**Coût.** Du SQL à maintenir, moins familier que du TypeScript. Il est couvert par 22 tests d'intégration.

## D12 — Un secret partagé plutôt que la clé « service role » de Supabase

**Décision.** Les fonctions d'automatisation sont appelables avec la clé publique, mais exigent un secret dont seule l'empreinte est en base.

**Pourquoi.** La clé « service role » contourne toutes les règles de sécurité : une fuite donnerait accès à tout. Le secret ne donne accès qu'à cinq fonctions précises. Il servira tel quel à n8n.

**Coût.** Le conseiller de sécurité Supabase signale ces fonctions comme « appelables sans connexion ». C'est attendu. Si le secret fuit, quelqu'un pourrait injecter de faux posts ou marquer des posts comme programmés : le changer alors dans `.env.local` et dans `private.app_secrets`.

## D13 — Aucune suppression de données

**Décision.** Aucune fonction ne supprime de ligne. Un post disparu de Buffer est marqué `removed_at`. Les données du Buffer simulé (préfixe `mock-`) sont écartées par un filtre selon le mode, pas effacées.

**Pourquoi.** L'historique des validations doit rester consultable. Et l'outil utilisé pour appliquer les migrations exige votre confirmation pour toute requête destructive : une première version qui effaçait les données de test a été refusée, d'où ce choix.

**Coût.** Les données de test s'accumulent dans la base de développement. Pour nettoyer : `delete from public.channels where buffer_channel_id like 'mock-%';` dans l'éditeur SQL de Supabase.

## D14 — Prérendu de Next.js désactivé

**Décision.** L'option `cacheComponents`, activée par défaut à la création du projet, est désactivée.

**Pourquoi.** Chaque page dépend de l'utilisateur connecté : il n'y a rien à prérendre, et l'option imposait des contournements sur toutes les pages.

## D15 — La validation porte sur une publication, pas sur une campagne

**Décision.** Le client valide chaque publication Buffer séparément (une par canal).

**Pourquoi.** C'est l'unité de Buffer, et une validation par publication résiste aux modifications : changer le texte LinkedIn n'annule pas la validation Instagram.

**Coût.** Une campagne sur quatre réseaux demande quatre validations. Un bouton « tout approuver » est envisageable.

## D16 — Les migrations sont testées sur un PostgreSQL en mémoire

**Décision.** `npm run test` rejoue les migrations et les fonctions SQL sur PGlite (PostgreSQL compilé pour Node, 25 Mo, aucune installation), avec un minimum de ce que Supabase fournit (rôles, `auth.uid()`).

**Pourquoi.** L'outil sert trois clients : un second projet Supabase ou un conteneur PostgreSQL seraient disproportionnés, et la machine n'a presque plus de disque. Une migration non vérifiée avait pourtant cassé la synchronisation.

**Coût.** Ce n'est pas Supabase : l'API HTTP et l'authentification réelle ne sont pas couvertes.

## D17 — Le code tolère une base en retard d'une migration

**Décision.** En mode réel, si les fonctions de la migration `0003` sont absentes, la synchronisation utilise les anciennes et écarte elle-même les posts simulés.

**Pourquoi.** Les migrations sont appliquées à la main : le code et la base ne changent pas au même instant. Une synchronisation qui s'arrête pour cette raison bloque tout l'outil.

**Coût.** Un chemin de repli à retirer une fois `0003` appliquée partout.

## D18 — Un canal transféré garde son passé pour l'ancien client seulement

**Décision.** Un canal n'appartient qu'à un client. Quand il passe à un autre client alors qu'il porte déjà des publications, la base note la date (`channels.visible_from`) : le nouveau client ne voit que les publications apparues ensuite. L'administrateur voit tout. Le transfert exige une confirmation, vérifiée par la base et pas seulement par l'écran.

**Pourquoi.** Une publication est rattachée à un client par son canal. Sans cette date, changer l'attribution d'un canal montrerait au nouveau client les textes, commentaires et décisions de l'ancien.

**Coût.** Une publication encore en attente au moment du transfert n'est visible d'aucun client : il faut la recréer dans Buffer. Un canal qui revient chez son premier client ne lui rend pas son ancien historique.

## D19 — Les comptes se créent dans Supabase, les accès se donnent dans Cadence

**Décision.** Cadence n'envoie pas d'invitation. L'administrateur invite la personne depuis Supabase (Authentication → Users → « Invite user »), puis lui donne accès à un client dans la fiche client, par son e-mail.

**Pourquoi.** Inviter depuis l'application exigerait d'y stocker la clé « service role », écartée en D12. Pour deux ou trois clients, une étape manuelle ponctuelle coûte moins qu'un secret tout-puissant.

**Coût.** Deux écrans au lieu d'un pour accueillir un nouvel utilisateur.


## D20 — Cadence prépare, Buffer publie (révise D10)

Le 9 octobre 2026, le Content Studio est ajouté : les contenus peuvent être rédigés dans Cadence. Cela revient sur D10 (« Buffer crée et publie, Cadence valide »), décidée la veille.

Pour ne pas fragiliser ce qui protège la validation, le Studio ne remplace rien : il crée un brouillon tagué dans Buffer au moment de l'envoi en validation, et ce brouillon suit le circuit existant. Autre voie écartée : garder le contenu dans Cadence jusqu'à l'approbation, puis le créer programmé dans Buffer. Elle aurait demandé de réécrire la synchronisation et la comparaison des contenus (les adresses de médias changent quand Buffer les héberge), et le client aurait validé une copie, non ce que Buffer publiera.

Prix de ce choix : les brouillons en attente existent dans Buffer avant l'accord du client.

## D21 — Une file d'attente en base pour les notifications, un webhook pour l'envoi

La base sait quand un fait se produit (déclencheur sur l'historique) et garantit l'unicité (clé unique) ; elle ne sait pas envoyer un e-mail. Le serveur remet donc les messages à un webhook, que n8n transforme en e-mail. Aucun service payant, aucune bibliothèque, et un mode simulation par défaut qui laisse une trace de ce qui serait parti.

## D22 — Un verrou en base plutôt qu'un verrou par serveur

Avec un planificateur, un bouton et bientôt n8n, deux synchronisations peuvent partir de processus différents. Le verrou vit donc dans la base (`sync_state`), avec une durée de vie : un serveur arrêté en pleine exécution ne bloque rien durablement.

## D23 — Chaque publication garde son client d'origine (révise D18)

**Décision.** L'appartenance d'une publication est explicite (`posts.owner_organization_id`, `ownership` : `assigned`, `unassigned`, `ambiguous`). Elle vient du Studio (client du contenu) ou du canal à l'import, et ne change plus lors d'un transfert. Un import dans un canal déjà transféré ou détaché est `ambiguous` : visible de l'administrateur seul jusqu'à attribution (`admin_set_post_owner`). La date d'import (`created_at`) n'est plus jamais utilisée pour décider d'une visibilité.

**Pourquoi.** L'audit du 9 octobre 2026 a reproduit qu'un ancien contenu découvert après un transfert recevait une date locale récente et devenait visible du nouveau client (D18 reposait sur `visible_from`).

**Coût.** Les contenus créés directement dans Buffer sur un canal transféré demandent un clic d'attribution. L'ancien client garde la lecture de son historique, sans pouvoir le modifier.

## D24 — Une approbation est liée à un propriétaire, un contenu et une version ; transfert, détachement et archivage suspendent

**Décision.** `approved_organization_id`, `approved_hash`, `approved_version` doivent tous correspondre au propriétaire actuel pour qu'un post soit programmable. Un transfert, un détachement ou un archivage retire la validation des publications non publiées concernées (`approval_status = 'none'`) ; une programmation déjà acceptée par Buffer passe en `unschedule_pending` et n'est jamais présentée comme annulée avant constat dans Buffer. La demande de validation revient à la synchronisation suivante si le tag est toujours posé et que le client redevient éligible.

**Pourquoi.** L'ancien test « un transfert conserve la programmation » validait un comportement dangereux.

## D25 — Réservation de programmation à jeton, confirmation conditionnelle

**Décision.** `claim_posts_for_scheduling_in_mode` pose un jeton, la version et l'empreinte réservées ; `complete_scheduling` ne confirme que si le jeton, l'empreinte, la version et le propriétaire sont encore valides, sinon le post passe en « annulation à confirmer ». Chaque changement de contenu crée une nouvelle version ; l'historique des versions est append-only.

## D26 — Un résultat inconnu n'est ni un succès ni un échec

**Décision.** Délai dépassé, coupure, 5xx ou réponse illisible pendant une création Buffer = `unknown`. Aucune nouvelle création automatique : réconciliation par lecture de Buffer (texte, canal, date exacts), adoption du brouillon retrouvé, ou renvoi autorisé après un délai de sécurité de 10 minutes et une lecture complète. Aucune idempotence de Buffer n'est supposée (non vérifiée).


## D27 — Toute transition de propriétaire d'un canal laisse une trace durable (révise D23)

**Décision.** Un transfert (autre client), un détachement et un rattachement écrivent une ligne dans `channel_owner_history` (administrateur seul) et, pour un transfert, posent `channels.visible_from` — **même si le canal ne contient aucune publication importée**. Un déclencheur sur `channels` applique cette règle quelle que soit la voie d'écriture (fonction d'administration, SQL direct, ancien code). Le détachement puis le rattachement à un autre client ne réinitialisent rien.

**Pourquoi.** Le contre-audit du 10 octobre 2026 a reproduit, avec les droits réels du client B, qu'un transfert sans publication déjà importée n'était pas enregistré : un ancien contenu de A découvert ensuite recevait B comme propriétaire. L'absence d'import local n'est pas une preuve d'absence d'historique dans Buffer.

**Coût.** Un transfert d'un canal vide exige quand même une attribution manuelle des contenus découverts ensuite (`admin_set_post_owner`). C'est voulu.

## D28 — Une approbation vaut tant que son approbateur est habilité ; retirer un membre retire ses accords

**Décision.** Le retrait d'un membre d'un client (`organization_members`, déclencheur) remet en « à valider » les publications qu'il avait approuvées et passe leur éventuelle programmation en « annulation à confirmer ». La réservation et sa confirmation revalident l'approbateur (membre du client propriétaire, rôle `client`). Rétablir le membre ne ressuscite pas l'ancien accord.

**Pourquoi.** Contre-audit : retirer le dernier approbateur laissait l'accord réservable. Aucune décision métier ne justifie qu'un accord survive à la personne qui l'a donné.

## D29 — La confirmation d'une programmation exige le jeton ; la compensation est immédiate et durable

**Décision.** `complete_scheduling` sans jeton, ou avec un jeton qui n'est plus la réservation courante, n'a aucun effet sur cette réservation (`superseded`/`ignored`). Une confirmation tardive d'une opération périmée place le post en « annulation à confirmer » (`stale`). Dès qu'une confirmation est périmée, le serveur déprogramme **immédiatement**, dans le même passage ; en cas d'échec l'état reste en base et la reprise passe en premier à chaque cycle, même si la lecture de Buffer échoue. Seul le statut constaté par le fournisseur est enregistré.

**Marges.** Envoi du Studio 15 min > approbation 10 min > réservation 5 min (`src/lib/domain/schedule-margins.ts`, comparées au SQL par un test). Elles laissent une fenêtre de compensation ; elles ne la garantissent pas si Buffer est injoignable, d'où l'anomalie visible.

## D30 — Cadence ne conclut jamais à l'absence d'un brouillon Buffer

**Décision.** Après un résultat inconnu ou un envoi interrompu, un nouvel envoi n'est possible que si le brouillon est **retrouvé** (adopté, jamais recréé) ou si une **personne** confirme son absence après vérification dans Buffer (`absence_requires_operator`). Aucune recherche, même complète, ne vaut preuve : la lecture est paginée, le texte peut être modifié dans Buffer, les médias ne sont comparés que par leur nature. Un ancien identifiant (peut-être supprimé) ne lève pas l'incertitude d'une recréation. Il n'existe plus de « renvoi forcé » : tout envoi abandonné est de résultat inconnu. La tentative (canal, texte, date, médias, ancien identifiant) est conservée avec la variante, y compris retirée.

**Erreurs GraphQL (HTTP 200).** `UNEXPECTED`, code inconnu ou absent, réponse vide ou sans post : inconnu pour une écriture. `UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`, refus typé : échec certain. `RATE_LIMIT_EXCEEDED` : quota. Un succès accompagné d'avertissements garde l'identifiant du post.

## D31 — Notifications : un message à la fois, revalidé, sans contenu privé par défaut

**Décision.** Le serveur réserve, remet **un seul message**, rend les autres à la file puis réserve de nouveau : chaque message repasse par la revalidation de la base (membre, client actif, version, préférences) juste avant sa remise. Par défaut (`NOTIFICATIONS_CONTENT=minimal`) aucun texte de publication ni commentaire ne sort : un lien vers une page authentifiée. L'atomicité parfaite entre PostgreSQL et un service d'e-mail externe n'est pas prétendue : un message déjà remis ne se rappelle pas.

## D32 — Une restauration n'est vérifiée que droits, Auth et Storage compris

**Décision.** La sauvegarde conserve les droits (plus de `--no-privileges`) et une empreinte des droits/politiques RLS (`acl.json`). La restauration filtre le sommaire du dump (schémas de Cadence en entier, données seules pour `auth`/`storage` d'un projet neuf), neutralise le temps de la restauration les privilèges par défaut de la plateforme, puis compare l'empreinte. `restore-check.mjs` (base, droits, rôles réels) et `restore-drill.mjs` (pile isolée : connexion, API, médias) se terminent en échec dès qu'un contrôle échoue.

## D33 — Le rattrapage des compensations ne dépend jamais du poll général (révise D29)

**Décision.** Une annulation à confirmer et une réservation de programmation abandonnée sont reprises par un **traitement urgent** distinct de la synchronisation générale : verrou et bail propres (renouvelés avant chaque appel externe), boucle du serveur de 30 s et rattrapage au démarrage, déclenchable de l'extérieur (`POST /api/automation/urgent`). Il lit d'abord l'état local et n'appelle Buffer que s'il y a du travail ; budget : au plus 60 s après son (re)démarrage, hors durée réseau. Une réservation « claimed » de plus de 120 s est rapprochée de l'état **réel** de Buffer (jeton, contenu, accord) : confirmée, ou annulée si illégitime. Une réponse incertaine d'une programmation laisse la réservation « en cours » (ce n'est pas un échec certain).

**Pourquoi.** D29 laissait une fenêtre de crash dépendante du prochain cycle (jusqu'à 30 min) : un post à échéance plus proche pouvait partir. Des échéances ≥ 24 h sont une précaution de pilote, pas une correction.

**Limites.** Serveur arrêté ou Buffer indisponible jusqu'à l'échéance : aucune garantie logicielle ; l'état réel est visible (ancienneté, tentatives, dernier essai).

## D34 — Un refus de quota n'est contourné par aucune écriture, y compris une compensation

**Décision.** `Retry-After` (secondes ou date HTTP) est conservé sans raccourcissement jusqu'à 30 jours (fenêtre documentée) ; une fin d'exécution ne raccourcit jamais une pause plus longue ; la pause « dure » (refus 429) s'applique à tous les chemins — manuels, Studio, réconciliation, compensation — alors qu'une pause préventive laisse passer les compensations. Aucune boucle d'appels refusés.

## D35 — Une tentative d'envoi Studio a une identité ; une réponse d'une autre tentative n'est jamais appliquée

**Décision.** Chaque envoi reçoit un identifiant de tentative ; les confirmations le représentent ; une réponse tardive de la même tentative est rapprochée, celle d'une autre est consignée comme brouillon orphelin. Toute erreur qui n'est pas un refus prouvé sans effet est « inconnue » pendant une création ; l'adoption automatique est limitée à une correspondance exacte, unique, en brouillon, sans média ; l'absence confirmée est une **dérogation** tracée (preuve, auteur, tentative).

## D36 — Les notifications sont revalidées juste avant la remise et génériques au pilote

**Décision.** `complete_notifications(…, 'verify')` annule celles qui ne sont plus légitimes avant l'appel au prestataire ; une vérification impossible n'autorise rien ; clé d'idempotence stable par lot ; `CADENCE_PROFILE=pilot` impose simulation et contenu minimal.

## D37 — Une restauration prouve les contenus, pas seulement les compteurs

**Décision.** Le manifeste porte l'empreinte du contenu de chaque table suivie (avant/après pour constater la dérive), la liste de ce qui est hors dump, et les fichiers du stockage ; une table attendue absente est une erreur ; les contrôles négatifs sont un outil (`restore-negatives.mjs`) et non une promesse ; les identifiants d'origine se connectent dans la copie (aucune réinitialisation pour masquer Auth).

## D38 — Équivalence de schéma, historique et exécution sont trois choses ; aucune réparation distante par défaut

**Décision.** L'inventaire est en lecture seule et comparé hors ligne à des empreintes attendues par niveau ; aucune réparation d'historique n'est préconisée sur la seule présence de marqueurs ; 0010 et 0011 n'ont pas de retour arrière (correction en avant).

## D39 — Un compte Buffer pour le pilote ; la liveness n'est pas la préparation

**Décision.** Le pilote utilise un seul compte et une clé, figés tant qu'une tentative est non résolue (C14). `/api/health` dit que le processus tourne ; `/api/ready` (secret) dit que la configuration, la base et les migrations requises sont en place, sans appeler Buffer. Les cookies de session sont `Secure` derrière HTTPS.

## D40 — Un compte Buffer par connexion, routé par le canal (10 octobre 2026)

Une clé Buffer globale ne permet pas plusieurs clients à comptes indépendants. Chaque canal reçoit sa connexion d'origine (`channels.provider_connection_id`), posée une fois et immuable ; le routeur envoie chaque opération au compte du canal. Il n'existe aucun repli : sans route active, l'opération est refusée. La clé du serveur ne sert qu'à la connexion « historique » qui la déclare. Alternatives écartées : une colonne « clé » par client (secret en clair, pas d'historique) ; un fournisseur choisi par le client actuel du canal (un transfert de canal aurait changé de compte en silence).

## D41 — Secrets chiffrés par le serveur, schéma privé (10 octobre 2026)

Les clés sont chiffrées en AES-256-GCM avant d'atteindre la base, liées à leur connexion, stockées dans `private.provider_credentials` (hors API). La clé de chiffrement vit hors base. La RLS seule ne suffit pas : le serveur lit les secrets avec le secret d'automatisation, donc un vol de la base sans la clé de chiffrement ne livre aucune clé Buffer.

## D42 — Panne et quota par compte (10 octobre 2026)

Une erreur du fournisseur porte sa connexion. Elle n'interrompt que les opérations de ce compte pendant le passage, et un 429 ne met en pause que lui. La lecture d'un compte ne peut déclarer retirées que ses propres publications. Conséquence acceptée : la pause préventive de quota n'est plus appliquée lorsqu'il y a plusieurs comptes.

## D43 — En production, aucun fournisseur simulé n'est choisi en silence (10 octobre 2026)

**Contexte.** « Tout ce qui n'est pas `real` est simulé » était prudent pour un pilote, mais dangereux pour une production : une variable oubliée affichait de fausses publications comme si elles existaient.

**Décision.** En production, le Buffer simulé exige `BUFFER_MODE=mock` **et** `CADENCE_ALLOW_SIMULATED_BUFFER=1` (piles de test, démonstration). Toute autre configuration est le mode réel ; si elle est invalide (mode absent, mal écrit, `mock` sans autorisation), le fournisseur est **bloqué en entier** et `/api/ready` le signale. Sans compte connecté, le mode réel n'appelle rien et l'interface affiche « Aucun compte Buffer connecté ». Hors production, le simulateur reste le défaut.

## D44 — Lire Buffer n'autorise pas à y écrire : barrière d'activation (10 octobre 2026)

**Décision.** En mode réel, créer, modifier, programmer et annuler exigent `CADENCE_BUFFER_WRITES=enabled`, fermé par défaut. Sans lui, rien n'est réservé en base ni envoyé ; l'interface dit « lecture seule ». L'annulation est fermée comme le reste : la barrière est un interrupteur complet, simple à auditer. **Conséquence acceptée** : refermer la barrière alors que des annulations sont en attente les reporte (elles restent visibles « à confirmer »).

## D45 — L'identité d'un compte se constate côté serveur, jamais depuis le navigateur (10 octobre 2026)

**Contexte.** Contrôle indépendant, P1-02 : la règle « remplacer une clé = même compte » ne s'appliquait que si l'identité était fournie, et rien ne la fournissait.

**Décision.** Le serveur lit `account.id` chez Buffer (lecture seule) avant d'enregistrer ou de remplacer une clé réelle, et l'enregistre par des fonctions SQL protégées par le secret d'automatisation et un acteur administrateur (`server_*`). Les fonctions de session correspondantes sont fermées (`server_only`). Une clé à l'identité inconnue ne remplace jamais une clé vérifiée ; un échec de vérification ne prouve rien et ne change rien. Un compte = une connexion non révoquée ; une clé = une connexion (empreinte HMAC). Chaque client HTTP recontrôle l'identité avant sa première opération. En simulation, une clé peut être enregistrée « non vérifiée » : elle reste inutilisable.

## D46 — Révocation et réservations partagent un verrou ; « révocation demandée » garde la clé pour annuler (10 octobre 2026)

**Contexte.** Contrôle indépendant, P1-01 : une réservation concurrente pouvait aboutir pendant une révocation, laissant une publication programmée sans clé pour l'annuler ; un routeur déjà chargé continuait d'émettre.

**Décision.** Toute réservation d'effet externe (déclencheurs sur `posts` et `studio_variants`) prend la connexion du canal en verrou partagé et exige qu'elle soit active ; la révocation la prend en exclusif puis compte les effets en attente. L'état intermédiaire `revoking` bloque tout nouvel effet et **conserve la clé** pour annuler, relire et rapprocher. Le routeur relit l'état durable avant chaque opération. La révocation forcée reste possible, sur phrase de confirmation, et dit qu'elle n'annule rien chez Buffer.

## D47 — Un seul passage de synchronisation à la fois, comptes lus en parallèle (10 octobre 2026)

**Contexte.** Le verrou de synchronisation et le bail urgent sont par mode. Faut-il un verrou par compte ?

**Décision.** Non, pour l'instant. La fusion du relevé est une seule transaction ; un verrou par compte multiplierait les ordres d'entrelacement à prouver sans gain pour deux ou trois comptes. Ce qui isole réellement les comptes est ailleurs et il est prouvé : lecture en parallèle (un compte lent ne retarde pas les autres), panne et quota portés par la connexion, annulation en échec sur A qui ne retient pas les programmations de B, espacement des lectures planifiées par compte. **Limite assumée** : les écritures d'un passage restent séquentielles ; un compte qui répond lentement à chaque écriture allonge le passage (délai borné à 15 s par requête, puis le compte n'est plus sollicité pendant ce passage). À mesurer avant d'aller au-delà de quelques comptes.

## D48 — Une publication garde son compte d'origine ; un ancien appelant ne vaut que pour le compte historique (10 octobre 2026)

**Contexte.** Contrôle indépendant, P1-03 et P1-05 : le même identifiant annoncé par un autre compte déplaçait la publication et révélait un texte à l'autre client ; un relevé « sans périmètre » de l'ancienne application retirait les publications des nouveaux comptes.

**Décision.** `sync_buffer_posts` (0013) refuse sans aucune mutation une publication connue annoncée sur un canal d'un autre compte, et la consigne. Un relevé sans connexion est rattaché au compte historique du mode (`is_default`) : il ne peut ni retirer, ni modifier, ni créer quoi que ce soit sur les comptes des clients. Le choix reste de **refuser** les collisions, pas de composer les clés avec la connexion.

