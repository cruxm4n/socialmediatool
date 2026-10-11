# Prochaines étapes — Cadence simplifié

Référence commune : `/home/ubuntu/cadence`, branche `chore/cadence-consolidation-2026-10-11`. Ne pas reprendre dans les anciennes sessions sans changer explicitement de dossier. La récupération et le retrait de l'interface Studio sont réalisés ; les tâches ci-dessous ne sont pas présentées comme terminées.

## Les cinq prochaines actions

1. **P0 — Réparer la compatibilité des tests hérités et établir une base verte.** Examiner les mocks `emissionProblem`, `bufferWritesEnabled`, le message d'erreur Provider et les fixtures réel/mock. Conserver les assertions d'isolation et le manifeste de contre-tests indépendants. Ne pas modifier du code applicatif pour satisfaire un ancien message ou autoriser une fixture incohérente.
2. **P0 — Découpler la validation de toute écriture Buffer pour le mode manuel.** Couvrir approbation unitaire/groupée, sync, compensation et boucle urgente. Préparer une migration additive pour approuver un brouillon sans date future. Définir la date et le contenu exacts validés, et le traitement d'une programmation directe dans Buffer. L’ajout de la date lors de la programmation manuelle ne doit pas créer une boucle de revalidation involontaire ; si la date fait partie de l’accord, sa modification doit au contraire demander un nouvel accord.
3. **P0 — Vérifier les lectures réelles de deux comptes Buffer dans un cadre autorisé.** Brouillons datés/non datés, canaux explicitement autorisés, médias, statuts, pagination, suppression et modification. Mesurer les quotas séparés. Aucune mutation ni activation de clé d'écriture nécessaire à cette vérification de lecture.
4. **P1 — Finaliser l'accès client et la fidélité de la validation.** Invitation/récupération de compte, retrait d'accès effectif, différence refus/demande de changement, formats acceptés, accès médias et historique. Exécuter le parcours manuel complet avec deux clients de test indépendants.
5. **P1 — Préparer le pilote et son retour arrière.** Restauration vérifiée DB/Auth/Storage/clé maître, image identifiée, schéma courant inventorié, alertes utiles et un seul timer. Soumettre le déploiement concret à autorisation avant d'inviter deux clients réels.

## Roadmap testable et réversible

Efforts indicatifs en jours d'ingénierie, hors délais de réponse des comptes/API. Total restant estimé **6 à 12 jours**, puis observation d'un pilote sur une à deux semaines. Cette fourchette n'est pas un engagement et dépend des échecs à corriger et des formats de médias retenus.

| Tâche | Priorité / effort | Dépendances / risque | Acceptation et tests | Retour arrière |
| --- | --- | --- | --- | --- |
| Base de tests cohérente | P0 / 1–2 j | Aucune ; risque moyen si assertions affaiblies | Unitaires + SQL + intégration natives + E2E ; expliquer chaque échec hérité ; contre-tests indépendants inchangés ou nouvelle version explicitement justifiée | Revert du seul commit de tests ; assertions originales conservées |
| Flux manuel et dates | P0 / 1–2 j | Base de tests ; risque élevé métier/SQL | Brouillon sans date approuvable sur empreinte affichée ; aucune mutation Buffer sur tous les chemins manuels ; concurrence sync/validation, modification après accord, reprise et doublons | Flag fermé par défaut ; migration additive réversible ; conserver toutes décisions et jobs ; ne jamais réactiver automatiquement les écritures |
| Lecture Buffer réelle et quotas | P0 / 0,5–1,5 j | Accès de lecture autorisé et comptes de test ; risque de fuite si mapping erroné | A/B ne voient que leurs canaux ; identité vérifiée ; médias et pages complets ; erreurs/429 durables par compte ; budget mesuré | Suspendre le timer, garder les instantanés et signaler leur ancienneté |
| Accès client, version affichée et formats | P1 / 1–2 j | Flux manuel ; risque moyen | Invitation et récupération ; retrait d'un membre interdit décisions/commentaires/Storage ; rejeter version périmée ; refus clairement défini ; formats non lus exclus du pilote | Réactiver les seuls écrans précédents compatibles, sans rétablir un accès retiré |
| Retrait du moteur Studio résiduel | P2 / 0,5–1 j | Aucun consommateur restant démontré, périmètre manuel stable ; risque moyen | Graphe d'import, build, backend, SQL/RLS et E2E ; préserver versions, médias et tentatives anciennes | Revert de petits commits ; tables conservées |
| n8n hors parcours critique | P1 / 0,5 j | Inventaire réel des workflows, sans modifier instance ici ; risque moyen notifications | Un seul timer backend ; validation/sync indépendantes de n8n ; remise d'e-mail facultative explicitement documentée | Garder ancien déclencheur désactivé comme solution de retour ; aucun workflow supprimé sans accord |
| Nettoyage SQL différé | P3 / 0,5–1 j | Inventaire données/RPC/FK/policies/grants ; risque élevé | Migration corrective isolée, essais montée/retour ; pas de perte d'historique ni d'accès média | Aucun DROP tant que récupération non prouvée ; ne pas effacer les fichiers de migrations |
| Restauration, exploitation et pilote | P0 avant invitation / 1–2 j | Toutes tâches P0 ; risque élevé si artefact/schéma mal identifié | Restore neuf DB/Auth/Storage, deux clients isolés, image et contexte identifiés, panne/reprise, monitoring et critères d'arrêt | Image précédente compatible + sauvegarde restaurable ; rapprochement externe avant toute reprise d'effets |

## Précautions sur les tests hérités

Les échecs observés avant nettoyage ne sont pas des régressions introduites par le retrait des écrans. Les neutraliser ou exclure globalement les suites Studio masquerait la dette. Les deux parcours UI retirés sont conservés dans `tests/legacy-e2e/` ; les tests du moteur restent actifs. Une suite verte avec des mocks ne prouve pas que les deux comptes réels sont intégrés.

Le propriétaire peut toujours programmer dans Buffer avant validation. Pour le MVP manuel, conserver les posts en brouillon par procédure, contrôler la dernière version et alerter les programmations sans accord. Ne promettre un blocage technique que si Buffer fournit réellement une politique applicable au compte et aux droits concernés.

## Consigne de reprise pour Claude Code / Codex

Commencer par `cd /home/ubuntu/cadence`, lire `PROJECT_STATUS.md`, vérifier `git status --short --branch`, puis traiter la première action. Utiliser un nouvel environnement isolé pour chaque famille de tests qui écrit ; ne pas réutiliser les données d'une suite d'intégration pour les E2E. Ne pas déplacer la référence, supprimer les anciennes branches, publier ou déployer pour « terminer le ménage ».
