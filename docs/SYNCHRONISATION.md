# Synchronisation avec Buffer — lecture seule

Référence du 11 octobre 2026. Ce document remplace `docs/PLANIFICATEUR.md` (historique) pour le portail de validation.

## Ce que fait une synchronisation

Elle **lit** Buffer et met la base de Cadence à jour. Elle ne crée, ne modifie, ne programme et ne déprogramme **rien** dans Buffer, quelle que soit la configuration : le client du vrai Buffer ne contient plus aucune mutation, et l'ancienne variable `CADENCE_BUFFER_WRITES` n'est plus lue.

À chaque passage :

1. Chaque compte Buffer (une connexion par client) est lu séparément, avec sa propre clé, son propre délai et son propre quota. La panne ou le quota d'un compte ne bloque pas les autres, et rien d'un compte non lu n'est déclaré supprimé.
2. La base enregistre les nouveautés. Un contenu modifié (texte, date, médias) crée une nouvelle version ; s'il était approuvé, l'accord est annulé et le client doit valider de nouveau.
3. Les publications programmées dans Buffer alors que leur accord n'est plus valable sont relues (une lecture chacune). Encore programmée : l'alerte reste, avec la consigne de la repasser en brouillon **dans Buffer**. Repassée en brouillon à la main : le retour est constaté et l'alerte se lève.

## Ce que Cadence ne peut pas empêcher

L'API de Buffer n'offre aucun moyen d'interdire une programmation faite à la main avant l'accord du client. Cadence la **détecte** à la synchronisation suivante et l'affiche à l'administrateur (« Programmé dans Buffer sans validation du client », rubrique « Programmées sans validation »). Entre deux synchronisations, une publication programmée sans accord peut donc partir : c'est une règle de travail (programmer après l'accord), pas un verrou technique.

La date fait partie de ce que le client approuve. Programmer dans Buffer à une **autre** date que celle approuvée annule l'accord.

## Déclenchement

| Moyen | État | Usage |
| --- | --- | --- |
| Bouton « Synchroniser » de l'administration | Actif | Actualisation à la demande |
| Ouverture de l'administration après 15 minutes sans synchronisation | Actif | Rattrapage silencieux |
| Planificateur (`docker compose --profile scheduler up -d scheduler`, ou `deploy/cadence-sync.cron`) | **Non activé** | Lecture périodique, à activer sur décision |

Aucun planificateur n'est activé par défaut, et aucune boucle de fond n'interroge Buffer. Une seule synchronisation tourne à la fois (verrou en base).

## Fréquence et quotas

Intervalle par défaut : **60 minutes** (`SYNC_INTERVAL_MINUTES`). Une synchronisation coûte environ une à deux requêtes par compte (deux pages au-delà de 100 publications actives), plus une requête par publication à relire.

| Intervalle | Requêtes par compte et par jour | Par 30 jours |
| --- | --- | --- |
| 60 min (défaut) | 24 à 48 | 720 à 1 440 |
| 30 min | 48 à 96 | 1 440 à 2 880 |
| 15 min | 96 à 192 | 2 880 à 5 760 |

Quotas relevés historiquement (docs/BUFFER.md) : 100 requêtes par 15 minutes ; 250 à 500 par jour ; 3 000 à 15 000 par 30 jours selon l'offre. À 60 minutes, l'offre la plus basse connue est respectée avec marge. **Ces quotas sont à relire sur chaque compte réel** (en-tête `RateLimit`, affiché dans l'écran Synchronisation) avant de réduire l'intervalle. Ne pas descendre sous 30 minutes sans cette mesure.

Protections déjà en place : un refus de quota (429) met en pause le seul compte concerné jusqu'à l'échéance demandée par Buffer ; un quota presque épuisé espace les lectures planifiées de ce compte ; aucune requête n'est retentée en boucle.

## Activer le planificateur (le moment venu)

1. Connecter et vérifier le compte Buffer de chaque client (fiche du client).
2. Lancer une synchronisation manuelle et relever le quota de chaque compte dans l'écran Synchronisation.
3. Choisir `SYNC_INTERVAL_MINUTES` (60 conseillé), puis activer **un seul** planificateur : le service `scheduler` du `docker-compose.yml`, ou la ligne de `deploy/cadence-sync.cron`. Jamais les deux, ni n8n en plus.
4. Vérifier dans l'écran Synchronisation que les passages planifiés apparaissent et qu'aucun compte n'est en pause.

Arrêt : `docker compose stop scheduler`, ou retirer la ligne de la crontab. Les données déjà lues restent ; l'écran indique leur ancienneté.
