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
