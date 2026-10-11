# Cadence — récupération et nettoyage du 11 octobre 2026

## Verdict et référence unique

**GO AVEC PRÉREQUIS pour poursuivre la simplification ; NOT READY pour inviter deux vrais clients au nouveau workflow.** La référence de développement est `/home/ubuntu/cadence`, branche `chore/cadence-recovery-cleanup-2026-10-11`, créée depuis `09cdeb1974f13301790d17fa2ab6a7150f6e8fab`. Les changements de cette mission sont uniquement locaux. Aucun push, merge principal, déploiement, mutation Buffer ni modification de données Supabase réelles.

La production continue d'exécuter `cadence-web:v1-2f51602`. Un dépôt plus récent sur disque n'est pas une version déployée. Les limites fonctionnelles et les résultats exacts sont dans [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Découverte du serveur et périmètre

Hôte constaté : `instance-20260905-1836`, utilisateur `ubuntu` (uid 1001), Linux `6.17.0-1020-oracle`. L'accès système fonctionne dans cette session. Le blocage bwrap observé lors de la demande précédente n'a pas été contourné : aucun mécanisme de sécurité n'a été désactivé.

Exploration de `/home/ubuntu`, `/opt`, `/srv`, sources Git et copies, worktrees, montages Docker, services utilisateur, processus, sessions tmux et proxy accessibles. **Quatre implantations Git Cadence initiales, correspondant à trois magasins Git indépendants ; huit copies de travail sans `.git`.** Un dépôt sans rapport, `/home/ubuntu/mon-projet`, a été laissé intact. Aucun projet Cadence supplémentaire n'a été trouvé dans `/opt` ou `/srv` avec les recherches effectuées. Les espaces non accessibles ou externes ne peuvent pas être certifiés inventoriés.

### Implantations initiales

| Chemin | Taille indicative initiale | Branche / HEAD | Dernier commit UTC | État |
| --- | --- | --- | --- | --- |
| `/home/ubuntu/social-media-dashboard` | 2,5 Go avec dépendances | `stabilisation/v2-contre-audit` / `b26560c456ab317b33fb7380958e38b3c246a080` | 10 octobre 11:25:46 | 100 chemins au statut Git : 52 changements suivis, 48 entrées non suivies ; sauvegardés sans commit dans cette branche |
| `/home/ubuntu/cadence-stabilisation-v3` | 8,7 Mo | `cadence/stabilisation-v3` / `2f516020a3c6071492f26fc3a7bbe7d3f6e52e1d` | 10 octobre 15:03:34 | Propre ; worktree du magasin précédent |
| `/home/ubuntu/cadence-refactor` | 17 Mo hors cible symlink | `release/cadence-clean-multibuffer-v1` / `09cdeb1974f13301790d17fa2ab6a7150f6e8fab` | 10 octobre 20:51:02 | Propre ; magasin indépendant, branche la plus récente trouvée |
| `/home/ubuntu/cadence-prod/build/2f51602` | 4,4 Mo | HEAD détachée / `2f516020a3c6071492f26fc3a7bbe7d3f6e52e1d` | 10 octobre 15:03:34 | Propre ; source de construction conservée |

Dernières modifications observées hors caches/dépendances : rapport de nettoyage historique dans `social-media-dashboard` vers 10 octobre 18:57 UTC, `TESTING.md` de refactor vers 20:50 UTC, résultats de test du worktree vers 16:27 UTC et fichiers de la copie de production vers 18:09 UTC. Ces dates de copie ou de rapport ne prouvent pas une supériorité du code.

Même remote déclaré, sans identifiants intégrés : `https://github.com/cruxm4n/socialmediatool.git`. Aucune récupération réseau Git n'a été faite ; les références distantes sont des observations locales qui peuvent être anciennes. `origin/main` diffère selon le magasin : `df860d8`, `61fe9f8` ou `2bbd79a`. Ne pas sélectionner automatiquement « main ».

### Branches et indices historiques

Douze noms de branches locales pertinents, treize couples nom/HEAD (deux `main` différents). Les états distants archivés et tous les SHA complets sont dans le relevé privé `repositories-initial.json`.

| Branche / référence | Commit constaté | Rôle et évaluation |
| --- | --- | --- |
| `main` historique | `61fe9f8` | Ancienne fondation ; pas une référence de sécurité récente |
| `main` copie de construction | `2bbd79a` | Merge historique, ne correspond pas au HEAD exécuté |
| `nuit/audit-ameliorations` | `df860d8` | Améliorations historiques intégrées dans la lignée conservée |
| `v2/fondations` | `381d137` | Fondations V2 |
| `admin/gestion-clients` | `bd4ede4` | Gestion client reprise dans la lignée récente |
| `studio/content-studio` | `57d33c8` | Fonction désormais abandonnée ; conserver l'historique |
| `validation/pilote` | `df30e96` | Ancien parcours pilote, pas une preuve du nouveau MVP |
| `fiabilite/corrections-p0` | `a78f031` | Correctifs historiques, ascendance conservée |
| `stabilisation/post-audit` | **`d29897e`** | Indice recherché retrouvé ; antérieur à la stabilisation récente |
| `stabilisation/v2-contre-audit` | `b26560c` | Checkout historique sale ; son code local correspond à V3 |
| `cadence/stabilisation-v3` | `2f51602` | Référence du déploiement constaté, plus ancienne que les corrections multi-comptes |
| `refactor/cadence-clean-multitenant-v1` | `4e132cb` | Connexions 0012 + UI ; contre-audit indépendant avait encore trouvé des failles |
| **`release/cadence-clean-multibuffer-v1`** | **`09cdeb1`** | Dernière base trouvée ; 0013 et tests de cycle de vie ; choisie pour développement, pas certifiée production |

Les références demandées `09cdeb1`, `d29897e` et `release/cadence-clean-multibuffer-v1` ont été retrouvées. Aucune fusion automatique ni cherry-pick de migrations incompatibles.

Comparaison essentielle du travail non commité : **87 fichiers de code/tests présents dans le statut historique correspondent exactement aux blobs de `2f51602` ; zéro différence de contenu dans ce sous-ensemble. Dix-sept documents de mission/rapport ne sont pas dans cet arbre et sont sauvegardés.** Face à `09cdeb1`, 62 de ces fichiers correspondent et 25 ont évolué dans la branche récente. Ce n'est donc pas un choix fondé uniquement sur la date ; le travail sale est préservé et son contenu applicatif est déjà dans l'ascendance retenue.

### Copies sans Git

| Chemin | Rôle / précaution |
| --- | --- |
| `/home/ubuntu/cadence-prod/build/rc-4e132cb` | Ancien candidat, pas le web actif |
| `/home/ubuntu/.cadence-audit-v2-private` | Résultats et sources privées d'audit |
| `/home/ubuntu/.local/state/cadence/multitenant-audit/20261010T192748Z/work` | Copie de contre-audit |
| Même préfixe, `/docker-context` | Contexte de construction historique |
| `/tmp/cadence-counter-baseline-ntxdnztd` | Baseline de contre-audit |
| `/tmp/cadence-counter-docker-mf8kfhgm` | Copie de contexte Docker |
| `/tmp/cadence-audit-fcq4gla5` | Copie d'audit |
| `/tmp/cadence-counter-audit-b_7cqwmy` | Données privées et Storage encore référencés par des conteneurs historiques |

Ces copies ont été sauvegardées. **Aucune n'a été supprimée**, même sous `/tmp`. Les tailles et empreintes exactes figurent dans l'inventaire privé.

## Quelle version est la meilleure ?

| Question | Conclusion | Confiance / limite |
| --- | --- | --- |
| A. Plus récente trouvée | `09cdeb1`, 10 octobre 20:51 UTC | Forte sur les magasins accessibles ; remote actuel non consulté |
| B. Plus de fonctions utiles | `09cdeb1` : V3 + connexions et UI multi-Buffer | Forte sur le code ; cela inclut encore du moteur hors cible |
| C. Base de sécurité la plus étayée | `09cdeb1` : vérifications durables, collisions et révocation ; 26/26 scénarios natifs multi-comptes passent | Moyenne à forte localement ; suites historiques non entièrement vertes et Buffer réel non testé |
| D. Réellement déployée | Image `v1-2f51602`, label `2f51602`, code embarqué | Forte sur image/label ; intégrité du contexte original non démontrée |
| E. Base du portail simplifié | Clone indépendant de `09cdeb1` dans `/home/ubuntu/cadence` | Forte pour poursuivre le développement, insuffisante pour un déploiement immédiat |

La branche `4e132cb` a été contre-auditée historiquement avec huit scénarios en échec. Les tests natifs de `09cdeb1` rejouent notamment routeur chargé avant révocation, collision de post, rotation d'identité, panne d'un compte et ancien appel de sync ; ils passent dans cette mission. Ne pas attribuer ces corrections à la production `2f51602`.

Les branches récentes sont dans une même lignée : `2f51602` → `21feb42` (0012) → `39da689` (routeur) → `302ad7b` (UI) → `4e132cb` (documentation) → `09cdeb1` (0013). Il n'a pas été nécessaire de combiner des implémentations divergentes pour choisir cette base. Tout autre futur correctif historique doit être comparé fichier par fichier et testé avec ses migrations ; pas de merge aveugle.

## Ce qui tourne et ce qui dépend des anciens dossiers

L'image web n'a pas de montage de code source. La passerelle a un bind depuis `cadence-prod/tools`. Caddy existant dirige vers web/passerelle. Les unités de surveillance/sauvegarde utilisent `cadence-prod/bin`. Les sessions tmux `cadence-stabilisation` et `codex-nuit`, ainsi que plusieurs agents, sont encore rattachés à `social-media-dashboard`. Certains outils utilisent ses `node_modules` via symlink. Aucune configuration PM2 trouvée ; aucun serveur Next autonome pertinent trouvé sur l'hôte en dehors des conteneurs inspectés.

L'instance n8n et ses services PostgreSQL restent installés. Les conteneurs `supabase_*_cadence-supabase-test` préexistants n'ont pas été utilisés pour écrire : leurs images et paramètres non secrets ont seulement servi de modèles à des piles nouvelles. Des conteneurs d'audit anciens référencent encore des chemins temporaires : aucun ménage système n'est sûr sur le seul nom d'un dossier.

Voir [DEPLOYMENT.md](DEPLOYMENT.md) pour l'image, son ID, les services et les limites de preuve. Aucun service préexistant redémarré ou arrêté.

## Sauvegardes et restauration

Racine privée : **`/home/ubuntu/cadence-recovery-backups/20261011T093314Z`**. Répertoire mode **700**, archives/manifests/bundles mode **600**. Environ 21 Go libres avant sauvegarde ; le chemin choisi ne chevauche aucun montage de service inspecté. Les sauvegardes peuvent contenir des secrets : ne pas les ajouter à Git, les partager ni les servir par HTTP.

Douze archives de dépôts/copies initiales, plus une archive de configurations d'exploitation sélectionnées. Les fichiers ont été hachés avant/après les douze sauvegardes de travail, les sources étaient stables, puis chaque contenu extrait en mémoire a été comparé à son SHA-256. Les symlinks ont été contrôlés. `node_modules`, sorties Next, caches, couverture et artefacts TypeScript reconstruisibles sont exclus ; code, Git, fichiers non suivis et configurations sont conservés.

| Archive | Fichiers | Taille compressée | Vérification |
| --- | ---: | ---: | --- |
| `00-social-media-dashboard.tar.gz` | 1524 | 8.3 Mio | Vérifiée |
| `01-cadence-refactor.tar.gz` | 1657 | 8.1 Mio | Vérifiée |
| `02-cadence-stabilisation-v3.tar.gz` | 335 | 5.4 Mio | Vérifiée |
| `03-2f51602.tar.gz` | 321 | 1.5 Mio | Vérifiée |
| `04-rc-4e132cb.tar.gz` | 307 | 0.7 Mio | Vérifiée |
| `05-.cadence-audit-v2-private.tar.gz` | 3199 | 92.5 Mio | Vérifiée |
| `06-work.tar.gz` | 352 | 5.2 Mio | Vérifiée |
| `07-docker-context.tar.gz` | 307 | 0.7 Mio | Vérifiée |
| `08-cadence-counter-baseline-ntxdnztd.tar.gz` | 230 | 0.4 Mio | Vérifiée |
| `09-cadence-counter-docker-mf8kfhgm.tar.gz` | 238 | 0.5 Mio | Vérifiée |
| `10-cadence-audit-fcq4gla5.tar.gz` | 269 | 5.3 Mio | Vérifiée |
| `11-cadence-counter-audit-b_7cqwmy.tar.gz` | 3181 | 92.0 Mio | Vérifiée |
| `12-operational-config-private.tar.gz` | 119 | 0.8 Mio | Vérifiée |

Trois Git bundles initiaux : `repository-0.bundle` (magasin historique et worktree), `repository-1.bundle` (refactor), `repository-2.bundle` (copie de construction). Tous ont passé `git bundle verify`. La restauration de `repository-1.bundle` a créé le nouveau dépôt ; `git fsck --full` y a réussi. Les dépendances ont été copiées dans un dossier indépendant, sans symlink vers les anciens dépôts.

`INVENTORY.json`, les manifests par archive, `SHA256SUMS`, `repositories-initial.json`, `runtime-sanitized.json` et `validation/` constituent les preuves privées. Le nouvel historique de nettoyage sera également sauvegardé dans un bundle final. Les archives des sources contiennent les changements non commités ; un bundle seul ne les contient pas.

### Restaurer du code sans écraser un dossier existant

1. Vérifier `SHA256SUMS` et le bundle depuis la racine privée. Ne pas afficher les `.env`, fichiers d'accès ou traces contenant des identifiants.
2. Créer un **nouveau** dossier avec permissions restrictives. Cloner le bundle pertinent vers ce dossier neuf, puis choisir la référence désirée ; ne pas restaurer dans un service ou checkout actif.
3. Pour récupérer le travail non commité, extraire l'archive dans un autre dossier vide privé ; comparer puis recopier uniquement les fichiers de travail voulus. Les archives de worktrees peuvent contenir un fichier `.git` pointant vers l'ancien magasin : ne pas activer ce pointeur ni écraser le `.git` du clone restauré.
4. Refaire `npm ci` avec Node 24, sur cette copie isolée. Garder les secrets hors Git et les configurations de test distinctes.
5. Vérifier `git status`, HEAD, différences et tests avant de désigner cette copie comme référence. Ne jamais utiliser `reset --hard` ou `clean` pour faciliter la restauration.

Exemple de restauration de l'historique, **dans un chemin inexistant uniquement** :

```bash
umask 077
git clone /home/ubuntu/cadence-recovery-backups/20261011T093314Z/repository-1.bundle /home/ubuntu/cadence-restauration-controle
```

Cette mission n'a pas sauvegardé les données de production, volumes Docker, comptes Buffer ou services distants. Les configurations d'exploitation ont été archivées séparément sans données DB/Storage. La restauration Git démontrée ne constitue pas un essai de restauration Supabase/Storage de production. Aucun résultat de backup hors site n'est certifié ici.

## Nettoyage effectué dans la nouvelle branche

| Élément précis | Décision / réalisation | Risque et garde-fou |
| --- | --- | --- |
| Quatre pages `src/app/admin/studio/{page,nouveau/page,medias/page,[id]/page}.tsx` | SUPPRIMER de la branche | Remplacées par route de compatibilité `studio/[[...path]]/page.tsx`, contrôle admin puis redirection |
| `src/components/studio/studio-editor.tsx` | SUPPRIMER | Création, autosave, composition multi-réseaux exclusivement Studio ; récupérable par Git |
| `src/components/studio/media-library.tsx` | SUPPRIMER | Interface d'édition/bibliothèque retirée ; médias et Storage conservés |
| `src/components/studio/studio-views.tsx`, `src/server/studio-page.tsx` | SUPPRIMER | Plus de consommateurs après retrait des routes ; build vérifié |
| `src/components/shell/nav.ts` | SIMPLIFIER | Entrée Studio retirée ; autres navigations préservées |
| `src/components/dashboard/admin-views.tsx`, route admin calendrier | SIMPLIFIER | Plus de chargement de brouillons Studio ni de mutation calendrier |
| `src/components/calendar/editorial-calendar.tsx` | SIMPLIFIER | Contextes de déplacement, drop handlers et attributs drag retirés ; vues/filtres/liens conservés |
| `src/components/publications/post-detail.tsx` et route admin détail | SIMPLIFIER | Lien d'édition Studio et lecture d'origine retirés ; aperçu, commentaires, activité et versions conservés |
| Lecture `listPostVersions` | RÉUTILISER dans `src/server/post-versions.ts` | Même session/RLS, mêmes erreurs et données ; routes client/admin indépendantes du Studio ; export historique conservé pour tests |
| `tests/e2e/06-studio.spec.ts`, `07-pilote.spec.ts` | CONSERVER dans `tests/legacy-e2e/` | Parcours UI retirés hors suite active, assertions et fixtures conservées ; remplacement portail ajouté |
| Captures E2E | SIMPLIFIER | Seuls écrans de composition abandonnés retirés ; captures des parcours conservés toujours exécutées |
| Tests calendrier/historique | CONSERVER / COMPLÉTER | Absence de déplacement, navigation, médias/texte/date des versions et protection des anciennes URLs |
| Exemple d'environnement | CLARIFIER | Proposition de 60 min dans le template, aucun secret réel ni runtime modifié |
| Documentation racine / consignes agents | ACTUALISER | Une référence commune et limites explicites ; anciens docs n8n/Studio/planificateur marqués historiques |

Huit fichiers applicatifs exclusivement Studio supprimés. Le diff de `src/` face à `09cdeb1` représente **45 lignes ajoutées, 1 449 retirées, soit 1 404 lignes nettes en moins**, sans annoncer de pourcentage de gain. Les deux anciens fichiers E2E sont déplacés, pas perdus. Aucune dépendance npm retirée : aucune exclusivité au Studio démontrée dans les packages actuels. Aucun éditeur tiers lourd ni fournisseur IA exclusif identifié dans les imports inspectés. Aucun fichier temporaire supplémentaire supprimé par supposition ; aucun renommage esthétique.

### Nettoyages reportés volontairement

| Composant | Décision | Pourquoi / condition de retrait |
| --- | --- | --- |
| `src/server/studio.ts`, `studio-actions.ts`, `src/lib/domain/studio.ts` | CONSERVER temporairement | Tests et opérations historiques ; interfaces de production ne les importent plus après extraction des versions ; retirer quand tentatives historiques et compatibilité sont traitées |
| Types et helpers Studio dans `src/lib/types.ts`, `view.ts` | À VÉRIFIER puis SUPPRIMER progressivement | Consommateurs des tests/moteur restants ; éviter de casser les fixtures |
| `post_versions`, `media_assets`, Storage | CONSERVER | Historique client et fichiers existants, même si introduits par la migration Studio |
| `studio_drafts`, `studio_variants`, `studio_push_events`, RPC et grants Studio | À VÉRIFIER | Données, essais incertains, FK, déclencheurs et migration 0013 ; aucun DROP autorisé par le nettoyage courant |
| Migrations 0001–0013 | CONSERVER toutes | Historique appliqué possible ; transition future additive, test montée/rollback et données préservées |
| Programmation, annulation, compensation | SIMPLIFIER après transition manuelle | Encore couplées à décisions/sync ; une suppression immédiate pourrait laisser un effet externe en attente |
| n8n / webhooks | CONSERVER temporairement si utilisés | Templates seulement démontrés ; inventaire de l'instance réelle non vérifié, aucune clé supprimée |
| Anciens dépôts/branches/copies/caches | CONSERVER | Références d'exploitation, symlinks et travail historique ; aucune suppression hors nouvelle branche |

Le retrait de l'interface ne signifie pas que les anciennes fonctions SQL ont disparu. Les RLS/grants existants restent actifs ; leur retrait nécessitera une migration corrective réversible après inventaire. Aucun changement de schéma dans cette mission.

## Tests, régressions et traçabilité

Avant nettoyage : 665 tests unitaires/SQL, 637 réussis et 28 échecs ; intégration native 83 tests, 76 réussis et 7 échecs. Après nettoyage : 666 unitaires/SQL, 638 réussis et les **mêmes 28 échecs**, zéro échec supplémentaire dans cette suite. Le test natif N17 a ensuite été ajusté de trois à deux secondes de maintien du verrou après constat du timeout anon à trois secondes ; mêmes assertions, aucune limite serveur modifiée. Les huit fichiers du manifeste `tests/audit-independent.sha256` sont inchangés et leur vérification réussit.

Un premier passage navigateur sur la base réutilisée d'intégration a donné 52 réussites, 7 échecs et 3 non exécutés. Ce passage est conservé, mais non retenu comme preuve propre : fixtures et comptes des suites précédentes perturbaient les attentes. Un second passage sur base neuve a confirmé ces contaminations (les erreurs de largeur et de comptage ont disparu) et révélé deux attentes de tests à rectifier : un faux lien Buffer demandé sur une publication simulée dans le nouveau test, et un ancien scénario de panne attendant HTTP 200 alors que le contrat signale correctement un échec partiel en 502. Les assertions d'indépendance A/B restent conservées ; le test de panne exige désormais 502, `ok:false` et un échec de programmation explicite.

Un troisième passage a donné 58 réussites, un échec et trois non exécutés : l’export du helper de test ajouté n’était pas encore chargé dans le worker en cours. Ce défaut de test a été corrigé et typé, puis la suite complète relancée dans une autre pile neuve, sans réutiliser les données.

Le dernier passage E2E complet passe **62/62**, zéro échec et zéro ignoré. L’intégration finale sur base neuve passe **76/83**, avec les mêmes sept échecs hérités ; les 26 scénarios multi-comptes passent et N17 passe trois répétitions supplémentaires.

Les résultats définitifs, la ventilation et les vérifications non réalisées sont centralisés dans [PROJECT_STATUS.md](PROJECT_STATUS.md). Les logs bruts et traces de tests synthétiques restent dans la sauvegarde privée. Aucun succès de simulation n'est présenté comme essai réel Buffer.

## Index des anciens documents

Les six documents racine actualisés sont l'entrée de référence. Les documents suivants restent conservés pour leurs détails, avec leurs limites de date/version :

| Document / emplacement | Utilité / statut |
| --- | --- |
| `TESTING.md`, `DECISIONS.md` | Protocoles et décisions historiques ; confronter aux résultats actuels |
| `docs/CONNEXIONS_FOURNISSEUR.md`, `BUFFER_MULTI_COMPTES.md` | Conception 0012/0013 et comptes ; ne prouvent pas le déploiement |
| `docs/BUFFER.md` | Essais réels historiques sur un canal de test ; ne valident pas les deux comptes actuels |
| `docs/BASE_DE_TEST.md`, `ALIGNEMENT_SUPABASE.md` | Installation/alignement ; commandes à revoir avant toute base réelle |
| `docs/SAUVEGARDE.md`, `EXPLOITATION.md`, `MISE_EN_SERVICE.md`, `PILOTE.md` | Exploitation et restauration ; aucune exécution destructive autorisée ici |
| `docs/N8N.md`, `PLANIFICATEUR.md`, `STUDIO.md` | Historiques, marqués comme tels ; recommandations de cible dans ARCHITECTURE.md |
| `docs/NOTIFICATIONS.md` | File et webhook ; e-mails réels non vérifiés |
| `/home/ubuntu/cadence-refactor/AUDIT_CODEX_MULTITENANT_FINAL.md` | Contre-audit indépendant de **4e132cb**, huit scénarios en échec ; sauvegardé sans écrasement |
| Rapports `AUDIT_*`, `RAPPORT_*`, missions de `social-media-dashboard` | Contexte et essais passés, sauvegardés dans l'archive 00 ; 17 documents absents de V3 explicitement préservés |
| `/home/ubuntu/cadence-prod/evidence/` | Preuves historiques d'exploitation ; archive privée de configuration, ne pas publier les accès |

Aucun ancien rapport remplacé ou supprimé. Le rapport matinal demandé avant la mission de récupération n'avait pas été créé pendant le blocage d'accès ; ce bilan de nettoyage et les cinq autres documents constituent la livraison cohérente de la mission actuelle, sans créer une série supplémentaire d'audits.

## État final de la mission

Commits locaux :

- `36c2479` — retrait des écrans Studio, calendriers en lecture seule, historique partagé et tests des parcours conservés.
- `dbea95d` — contrat d'échec partiel du test E2E, export du helper, temporisation du test concurrent et exclusion des artefacts de lint.
- Commit documentaire suivant — les six documents racine demandés, index et consignes de référence, exemples sans secrets. Son identifiant exact figure dans `git log` et le bundle final ; éviter une référence auto-référentielle dans ce document.

Identité Git locale de l'agent : `Codex <codex@local.invalid>`, configurée uniquement dans ce nouveau dépôt ; aucune identité globale modifiée. `push.default=nothing` dans ce dépôt prévient un push implicite.

Les six documents demandés sont présents. Les travaux d'origine ont été comparés à leurs manifests : zéro fichier de travail changé dans les quatre implantations initiales. Les images/ID/états des 23 conteneurs préexistants sont inchangés. Cinq piles de test indépendantes ont été créées au fil des vérifications ; elles sont arrêtées, avec conteneurs, volumes, réseaux et données conservés conformément à l'interdiction de suppression. Aucun nettoyage des ressources anciennes.

Le bundle final `cadence-cleanup-final.bundle` sauvegarde les commits de la nouvelle branche et est vérifié puis restauré dans un clone de contrôle privé. Référence, sauvegardes, inventaire final et statut des services sont aussi récapitulés dans le terminal. L'objectif de récupération est atteint sur les emplacements accessibles ; le nettoyage est volontairement progressif et le produit manuel reste à finaliser. La production et les anciennes branches sont préservées.

## Consolidation du dépôt canonique

Mission de consolidation du 11 octobre 2026. Référence recommandée : **`/home/ubuntu/cadence`**, branche **`chore/cadence-consolidation-2026-10-11`**, issue de **`c0af3a02f15857f3cd8fdd723361ef55e56d27b4`**. Le commit documentaire de consolidation est identifiable par `git log -1` et le bundle final ; son SHA n’est pas inclus dans son propre contenu. Aucun push, déploiement, changement de données, déplacement ni suppression d’ancien dossier.

### Inventaire et classement

Tailles approximatives relevées avant consolidation, incluant caches et dépendances ; elles ne mesurent pas le volume de travail unique. Hôte `instance-20260905-1836`, utilisateur `ubuntu` ; environ 19 Gio disponibles avant les sauvegardes.

| Chemin absolu | Taille | Classe | État constaté / décision |
| --- | ---: | --- | --- |
| `/home/ubuntu/cadence` | 1,1 Gio | Canonique | `c0af3a0`, propre avant travaux, dépendances autonomes ; seule base de développement recommandée |
| `/home/ubuntu/cadence-prod` | 13 Mio | Production | Services et outillage en usage ; conserver intégralement |
| `/home/ubuntu/cadence-prod/build/2f51602` | Inclus ci-dessus | Production | Dépôt propre, HEAD détachée `2f51602` ; source correspondant aux métadonnées de l’image active |
| `/home/ubuntu/cadence-prod/build/rc-4e132cb` | Inclus ci-dessus | Candidat historique | Copie sans `.git`, 307/307 fichiers identiques à `4e132cb` ; rien à récupérer |
| `/home/ubuntu/cadence-refactor` | 17 Mio | Potentiellement archivable après autorisation | `release/cadence-clean-multibuffer-v1`, `09cdeb1`, propre ; contenu déjà repris dans le canonique |
| `/home/ubuntu/cadence-stabilisation-v3` | 8,7 Mio | Ancienne référence, archivage conditionnel | `cadence/stabilisation-v3`, `2f51602`, propre ; worktree de `social-media-dashboard`, encore référencé par des scripts d’exploitation |
| `/home/ubuntu/social-media-dashboard` | 2,5 Gio | Historique sauvegardé, encore utilisé | `stabilisation/v2-contre-audit`, `b26560c` ; 52 changements suivis + 52 fichiers non suivis en mode détaillé ; sessions et dépendances d’outils encore présentes |
| `/home/ubuntu/cadence-supabase-test` | 48 Kio | Test en usage | Configuration CLI, pile Supabase locale active sur 54321/54322 ; ne pas déplacer |
| `/home/ubuntu/cadence-backups-test` | 440 Kio | Sauvegarde de test | Archive de restauration historique ; préserver |
| `/home/ubuntu/cadence-recovery-backups` | 254 Mio avant cette mission | Sauvegarde | Sauvegardes initiales et nouveaux états récupérables ; conserver |
| `/home/ubuntu/.cadence-audit-v2-private` | 246 Mio | Audit historique potentiellement archivable | Copie sans dépôt actif : 177 fichiers src/tests/migrations correspondent à des blobs Git déjà préservés ; 3 196 empreintes de sauvegarde reconfirmées |
| `/home/ubuntu/.cadence-v3-backups` | 536 Kio | Sauvegarde de test | Sauvegardée à nouveau ; ne pas confondre avec une sauvegarde actuelle de production |
| `/home/ubuntu/.cadence-test-stack` | 4 Kio | Test, vide | Aucun état de pile présent ; aucune suppression effectuée |

Les quatre implantations Git initiales représentent trois magasins indépendants ; le canonique en ajoute un quatrième. `cadence-stabilisation-v3` partage le magasin de `social-media-dashboard`. Aucun dépôt Git supplémentaire n’a été découvert dans les copies examinées. Le sous-dossier `audit-git` de l’audit privé contient des diffs et rapports, pas un dépôt bare.

### Comparaison réelle et choix

- **Historique et code ne sont pas équivalents.** Les anciens correctifs ont été repris dans `826c171` depuis la branche officielle, avec les tests dans `981d308`, puis la documentation dans `2f51602`. Plusieurs commits des branches historiques ne sont donc pas ancêtres de HEAD, bien que leurs fonctions et migrations soient reprises. Une fusion globale réintroduirait des versions obsolètes.
- Tous les fichiers de migrations présents dans les branches candidates ont le même blob que leur homologue canonique. Les migrations 0001 à 0013 restent intactes ; aucune migration ajoutée, supprimée ou appliquée. Le schéma distant n’a pas été interrogé.
- Les 104 fichiers modifiés/non suivis détaillés du checkout historique donnent **87 correspondances exactes avec `2f51602` et 17 documents uniques**. Face à `c0af3a0` : 59 identiques, 28 anciennes versions déjà commitées, 17 documents. Aucun correctif applicatif inédit à importer. Les documents uniques restent dans le dossier d’origine et sa sauvegarde privée.
- Les fichiers exclusivement absents des anciennes variantes sont des écrans Studio volontairement retirés, deux parcours E2E conservés dans `tests/legacy-e2e`, d’anciens rapports ou du squelette UI retiré lors de `07b1ced`. Rien n’est réintroduit par supposition.
- La copie candidate `rc-4e132cb` est exactement son arbre Git : 307 fichiers identiques, zéro différence. Elle précède le cycle de vie des connexions de `09cdeb1`.
- La copie d’audit privée ne fournit aucun blob src/tests/migrations nouveau : ses 177 fichiers utiles sont déjà dans l’historique consolidé. Ses neuf migrations sont identiques. Les contre-tests indépendants restent protégés par leur manifeste.
- `main` de la copie de production pointe sur `2bbd79a`, un merge de publication dont **l’arbre est exactement celui de `2f51602`** ; aucun ajout fonctionnel. Ce commit manquait comme objet dans le canonique, il est désormais conservé par une référence d’archive.
- Contrôle distant **en lecture seule** par `git ls-remote --heads` : GitHub annonce seulement `main=2bbd79a` et `cadence/stabilisation-v3=2f51602`. Les références `origin/*` des anciens dossiers ne prouvent pas leur présence actuelle sur GitHub. Les huit commits de la ligne canonique depuis `2f51602` restent locaux au regard de ces branches distantes. Aucun fetch réseau, push ou modification du dépôt distant.

**Décision : conserver le code de `c0af3a0`. Zéro fonctionnalité récupérée ou développée pendant cette consolidation, zéro cherry-pick applicatif, zéro dépendance retirée.** Le gain est la préservation explicite et vérifiable de l’historique, la référence commune et une nouvelle qualification locale. Les fonctionnalités multi-comptes, revocation, isolation, décisions, commentaires, versions et consultation étaient déjà présentes. Le Studio et les calendriers éditables restent retirés.

### Historique consolidé sans fusion incompatible

- Branche de travail créée depuis l’arbre propre : `chore/cadence-consolidation-2026-10-11`. L’ancienne branche et tous les anciens checkouts restent intacts.
- **16 tags d’archive** sous `archive/consolidation-2026-10-11/` : deux références du canonique avant travaux, dix branches historiques, trois branches refactor et la branche main de la copie de production. Importés uniquement depuis les bundles locaux vérifiés, sans copie massive de fichiers.
- **52 commits accessibles** après récupération des références, dont **34 hors de l’ascendance active** (33 historiques et le merge officiel). Ces chiffres précèdent le nouveau commit documentaire. Chaque commit accessible depuis une référence des trois sources indépendantes est accessible depuis le canonique ; zéro manquant.
- `git fsck --full --no-reflogs --unreachable` : aucun commit inaccessible, aucune corruption sur les quatre magasins examinés. Les anciens historiques restent consultables sans les fusionner.

Commandes de consultation :

```bash
cd /home/ubuntu/cadence
git status --short --branch
git for-each-ref --format='%(refname:short) %(objectname:short)' refs/tags/archive/consolidation-2026-10-11
git log --all --graph --oneline --decorate
```

Les tags préservent les anciens commits dans un clone/bundle complet. Les fichiers non commités, configurations privées et rapports internes restent dans les archives privées, jamais ajoutés à Git. La conservation d’anciens dossiers n’en fait pas des bases de développement recommandées.

### Sauvegardes nouvelles et restauration

Racine privée : **`/home/ubuntu/cadence-recovery-backups/consolidation-20261011T103558Z`**, permissions 0700 ; fichiers créés sous umask 077. Elle n’est sous aucun bind mount Docker inventorié.

- Dix archives nouvelles : six sources de code (canonique, historique, refactor, worktree, build actif, build candidat) et quatre états locaux de test/sauvegarde. Les dix archives ont été relues ; chaque fichier a été comparé à son empreinte. L’archive du dossier vide est volontairement vide.
- Cinq bundles initiaux `--all` vérifiés, dont ceux du canonique et du build de production. Archives de travail et bundles sont complémentaires ; les fichiers ignorés utiles sont conservés, dont les configurations locales et anciennes sessions synthétiques, dans cette racine privée uniquement.
- `node_modules`, caches Next, artefacts de compilation, rapports Playwright et répertoires `.git` sont exclus des nouvelles archives de travail ; historique préservé séparément par bundle. Les captures et documents historiques sont conservés.
- Sauvegarde précédente : `/home/ubuntu/cadence-recovery-backups/20261011T093314Z` ; **135/135 empreintes conformes, quatre bundles vérifiés**. Les 3 196 fichiers hashés de la copie privée d’audit sont toujours conformes à cette sauvegarde.
- Le bundle final `cadence-consolidation-final.bundle` et sa restauration de contrôle, après commit, sont consignés dans `final-verification.json`. Les empreintes finales sont dans `SHA256SUMS`.

Restauration de l’historique dans un **nouveau chemin inexistant**, jamais dans un service actif :

```bash
umask 077
git clone --mirror /home/ubuntu/cadence-recovery-backups/consolidation-20261011T103558Z/cadence-consolidation-final.bundle /home/ubuntu/cadence-consolidation-restauration.git
git --git-dir=/home/ubuntu/cadence-consolidation-restauration.git fsck --full
```

Pour les fichiers non commités : extraire l’archive pertinente dans un autre dossier privé neuf, comparer les manifests, puis sélectionner les seuls fichiers nécessaires. Ne pas recopier en bloc l’ancien Studio ni activer d’anciennes configurations. Aucune DB, aucun volume actif, aucun service distant n’a été sauvegardé par cette consolidation : les archives Git/configurations ne remplacent pas un test de restauration des données de production.

### Services et chemins à préserver

- Caddy chargé : `sociallr.duckdns.org` → `cadence-prod-web:3000` ; chemins Auth/REST/Storage → `cadence-prod-gw:8000`. Ports hôte 80/443 ; passerelle accessible aussi sur `127.0.0.1:18000`. Configuration montée depuis `/home/ubuntu/stack/caddy/Caddyfile`.
- Production : image `cadence-web:v1-2f51602`, ID `sha256:affb99671211c72265ee9f4aff16e7e7c7c402721cf32d108f60134f03f7027a` ; aucun montage de source dans web. Passerelle montée en lecture seule depuis `cadence-prod/tools/scripts/lib/gateway.mjs`. Volumes DB et Storage distincts, inchangés.
- Timers utilisateur `cadence-backup.timer` et `cadence-monitor.timer` actifs, avec scripts dans `cadence-prod/bin`. Leur présence n’atteste pas d’un backup récent réussi. Le Compose de la pile Caddy/n8n est `/home/ubuntu/stack/docker-compose.yml`. Le Compose racine de chaque dépôt est un modèle applicatif ; aucune pile nouvelle n’a été lancée depuis ces fichiers.
- `cadence-prod/node_modules`, `cadence-prod/tools/node_modules`, `cadence-refactor/node_modules` et `cadence-stabilisation-v3/node_modules` pointent vers `social-media-dashboard/node_modules`. Le canonique possède ses propres dépendances, sans ce lien.
- Les sessions tmux `cadence-stabilisation` et `codex-nuit`, ainsi que plusieurs processus d’agent, conservent leur cwd dans `social-media-dashboard`. Aucune session déplacée, arrêtée ou reconfigurée. Aucun fichier PM2 de dump trouvé aux emplacements usuels.
- Une configuration Supabase distante existe dans l’ancien environnement local, inventoriée sans valeur secrète et non utilisée. La pile Supabase CLI locale existante reste active et intacte ; les nouvelles suites utilisent deux piles indépendantes, nouveaux secrets et ports locaux.
- n8n et sa base restent dans la pile `stack`, sans intervention. Les références applicatives restantes et templates demeurent tels quels ; aucun workflow réel inspecté ni modifié.

### Tests réexécutés et limites

| Suite | Résultat nouveau | Comparaison / portée |
| --- | --- | --- |
| Lint | Réussi | Node 24.21.0 |
| Build Next isolé | Réussi | `.next-test`, Buffer simulé, aucune configuration réelle |
| TypeScript | Réussi | Types Next régénérés |
| Calendrier navigateur | Réussi | Aucun réseau ; navigation, filtres, lecture seule et largeurs |
| Unitaires | 430/456 ; 26 échecs | Mêmes scénarios en échec qu’avant consolidation |
| SQL/RLS PGlite | 208/210 ; 2 échecs | Base en mémoire ; fixtures de modes incompatibles |
| Total unitaires + SQL | 638/666 ; 28 échecs | Liste d’échecs identique au JSON antérieur |
| Intégration PostgreSQL/Auth/REST/Storage | 76/83 ; 7 échecs | Database 38/38, multi-comptes 26/26, V3 12/19 ; mêmes échecs |
| E2E Chromium | 62/62 ; zéro échec/ignoré | Deuxième pile neuve ; Buffer simulé |
| Intégrité des contre-tests | 8/8 | Aucun test ni fixture modifié |
| Recherche de secrets consolidée | Aucun motif détecté | 315 fichiers de travail et 764 blobs historiques ; contrôle par motifs, sans valeur affichée |

Les 28 échecs U/S sont ceux déjà expliqués dans PROJECT_STATUS.md : mocks Studio incomplets (23), configuration sync (2), ancien message Provider (1), fixtures SQL réel/mock (2). Les sept échecs natifs V3 restent liés au mock Studio incomplet. Ils ne sont ni exclus, ni corrigés artificiellement, ni assimilés à des réussites. Les assertions des contre-tests indépendants restent intactes.

Les suites natives et E2E vérifient localement les sessions A/B, RLS, décisions et commentaires croisés, retrait d’accès, version/empreinte périmée, collision d’identifiants, révocation/rotation, quotas séparés et concurrence. Les médias externes Buffer privés, les deux comptes réels, le schéma distant et la restauration de production restent **NON VÉRIFIÉS**. Les appels Buffer sont remplacés par des fournisseurs synthétiques ; aucun succès local ne certifie l’API réelle. Les tests unitaires de verrouillage utilisent des commandes système simulées, pas le pare-feu réel.

Les logs/JSON et runners privés sont sous `/home/ubuntu/cadence-recovery-backups/consolidation-20261011T103558Z/validation`. Deux nouvelles piles de quatre conteneurs ont été arrêtées en conservant conteneurs, volumes, réseaux et fichiers ; seules leurs passerelles locales et leur serveur navigateur ont été terminés. Les 43 conteneurs préexistants sont inchangés lors du contrôle par ID/image/état/montages, consigné dans `final-verification.json`. Les fichiers de travail des cinq anciennes sources contrôlées sont identiques à leurs manifests.

### Liste précise d’archivage après autorisation

**Aucun dossier déplacé ou supprimé.**

| Dossier | Archivage envisageable | Conditions |
| --- | --- | --- |
| `/home/ubuntu/cadence-refactor` | Oui, après autorisation | Aucun conteneur/processus inventorié ne l’utilise ; historique, rapports ignorés et fichiers de travail sauvegardés ; mettre à jour les liens documentaires lors de l’archivage |
| `/home/ubuntu/.cadence-audit-v2-private` | Oui, après autorisation | Copie de laboratoire, aucun montage/cwd actif inventorié ; conserver sa sauvegarde vérifiée et ses preuves |
| `/home/ubuntu/cadence-stabilisation-v3` | Conditionnel, pas maintenant | Réviser les références des scripts d’exploitation et le lien worktree ; ne pas déplacer ce worktree comme un dépôt autonome |
| `/home/ubuntu/social-media-dashboard` | Conditionnel, pas maintenant | Sortir les agents/tmux de l’ancien dossier et rendre l’outillage production indépendant de ses node_modules, sous une autre autorisation ; préserver aussi le worktree associé |
| `/home/ubuntu/cadence-supabase-test` | Non tant que la pile est utilisée | Configuration d’un environnement local encore actif |
| `/home/ubuntu/cadence-prod` et ses builds | Exclu de cette consolidation | Production et retour arrière ; ne pas archiver dans ce cadre |
| Dossiers de sauvegardes, dont `.cadence-v3-backups` et `cadence-backups-test` | Conserver | Classer et indexer, sans effacer les chemins de restauration |

### Verdict et suite

**GO pour utiliser le dépôt canonique consolidé ; NOT READY pour la production.** Aucun invariant critique n’est déclaré validé par simple simulation. Le flux manuel reste partiellement couplé à la programmation, les suites héritées ne sont pas vertes, l’intégration réelle et la restauration actuelle ne sont pas qualifiées. Il n’y a pas de nouvelle fonctionnalité ni de régression applicative introduite : l’arbre src/tests/migrations/lockfile est identique à `c0af3a0`.

Prochaines actions : (1) réparer les pilotes/mocks et fixtures sans affaiblir les assertions ; (2) terminer la validation locale sans écriture Buffer et la règle des dates ; (3) qualifier les lectures réelles des deux comptes dans un cadre autorisé ; (4) préparer la compatibilité schéma/image et une restauration isolée ; (5) décider séparément de l’archivage des deux dossiers sans usage actif, puis seulement des dossiers encore dépendants.

## Correction des 35 échecs et préparation de publication

Correction minimale depuis `54cda08`, sur `chore/cadence-consolidation-2026-10-11`. Aucun fichier src, migration, script d’exploitation ou dépendance modifié. Aucun Studio réintroduit.

| Cause racine | Échecs avant correction | Correction |
| --- | ---: | --- |
| Mocks publishing remplaçant aussi le nouvel export emissionProblem | 23 unitaires + 7 natifs | Mocks partiels conservant le vrai contrôle ; routes et états actifs explicites dans les fixtures unitaires ; vraies RPC dans l’intégration |
| Mock de configuration sync incomplet | 2 unitaires | Conservation des exports du vrai module, état de barrière explicite dans le pilote ; nouveau test de refus avant réservation |
| Même canal utilisé en réel et simulé | 2 SQL | Identités de canaux préfixées explicitement dans les deux fixtures mixtes ; identités historiques conservées dans le test de montée de version ; aucune modification du garde-fou channel_connection_mode_mismatch |
| Ancien message de clé globale attendu | 1 unitaire | Vérification exacte du message par compte, du type ProviderError, du kind api, de l’outcome failed et de l’absence de retry |

Le premier passage complet a donné 669/670 : le préfixage automatique ajoutait quatre canaux à une fixture de montée de version. Il a été remplacé par une option explicite dans les seules deux fixtures mixtes. L’assertion sur les cinq canaux historiques reste intacte, puis les tests ciblés et l’ensemble U/SQL sont relancés. Aucun test natif/E2E ne dépend de LocalDb. Aucune assertion de sécurité supprimée ou assouplie, aucun test ignoré. Quatre scénarios unitaires ajoutés. Le bloc complet des deux contre-tests Studio indépendants est byte-identique à celui de `54cda08`. Une seule empreinte de leur manifeste change, car la fixture et les imports sont adaptés pour exécuter le vrai contrôle de connexion. L’ancien fichier reste récupérable dans Git et dans `before-fixes.bundle`.

Résultats finaux : ciblés 151/151 et V3 19/19, unitaires 460/460, SQL/RLS 210/210, intégration 83/83 dont multi-comptes 26/26, E2E 62/62 ; lint, TypeScript, build et calendrier navigateur réussis. Les résultats antérieurs en échec restent historiques. Les nouvelles preuves sont sous `/home/ubuntu/cadence-recovery-backups/test-fixes-20261011T105608Z/validation`.

Sauvegarde avant correction : `/home/ubuntu/cadence-recovery-backups/test-fixes-20261011T105608Z/before-fixes.bundle`, vérifiée. Trois piles locales neuves et secrets synthétiques, sans modification des ressources préexistantes ; ressources conservées après arrêt. Recherche de secrets avant publication et bundle final consignés dans les preuves privées.

L’autorisation de publication porte sur la branche consolidée vers origin `cruxm4n/socialmediatool`, avec PR vers main ; elle ne porte sur aucun merge ou déploiement. Les tags historiques restent locaux et sauvegardés, hors du push de branche. Le statut GitHub et les URLs effectives sont fournis dans le bilan terminal après vérification distante. Le passage des suites locales ne rend pas terminé le flux manuel ni ne qualifie les comptes Buffer et la production.
