> **Réévaluation du 11 octobre 2026 :** ne pas activer les commandes historiques ci-dessous pendant la récupération. L’hypothèse « une requête par passage » n’est plus un budget fiable avec le contrôle d’identité et plusieurs organisations. Voir [ARCHITECTURE.md](../ARCHITECTURE.md#budget-dappels-par-compte) : mesurer les appels par connexion, privilégier 60 min ou manuel pour démarrer. Le moteur de programmation reste à découpler.

# Synchronisation automatique toutes les 5 minutes

Buffer ne prévient d'aucun changement : il faut l'interroger régulièrement. Un **planificateur** appelle Cadence toutes les 5 minutes ; Cadence fait le travail (lire Buffer, mettre la base à jour, déprogrammer ce qui a été modifié après validation, programmer ce qui est approuvé, envoyer les notifications en attente).

**Rien n'est activé.** Tout est préparé dans le dépôt ; l'activation se fait par une des trois commandes ci-dessous, sur votre décision.

## Ce que fait un passage

```
planificateur ──POST /api/automation/sync──► Cadence
                (en-tête x-automation-secret)   │ 1. demande le verrou à la base (begin_sync_run)
                                                │ 2. synchronise
                                                │ 3. rend le verrou avec le résultat (finish_sync_run)
```

| Situation | Comportement |
| --- | --- |
| Deux déclenchements en même temps (planificateur + bouton, ou deux planificateurs) | Un seul s'exécute. L'autre répond aussitôt `skipped: "running"`, sans appeler Buffer. |
| Le serveur s'arrête en pleine synchronisation | Le verrou expire seul au bout de 5 minutes. |
| Buffer ne répond pas | Chaque appel est abandonné après 15 secondes ; l'échec est enregistré ; nouvel essai au passage suivant. |
| La base ne répond pas | Chaque appel est abandonné après 20 secondes. |
| Quota Buffer atteint (HTTP 429) | Arrêt immédiat des appels ; les passages planifiés sont suspendus le temps indiqué par Buffer (15 minutes à défaut). |
| Quota Buffer presque épuisé (moins de 10 % restants) | Pause préventive : 15 minutes, 1 heure ou 6 heures selon la fenêtre entamée. Le bouton manuel et la programmation à l'approbation restent possibles. |
| Échec de programmation ou de déprogrammation | Réponse HTTP 502, anomalie affichée, nouvel essai au passage suivant (règles inchangées : cinq essais rapprochés, puis un par heure). |

L'état se lit dans **Administration → Synchronisation** : dernier succès, dernier échec et son motif, dernier passage du planificateur, anomalies de la dernière exécution. La pastille de l'en-tête résume : à jour, en cours, en retard, en pause, en échec.

## Traitement urgent (indépendant du poll)

Le poll général lit Buffer toutes les N minutes. **Les annulations à confirmer et les réservations abandonnées n'attendent pas ce poll** : le traitement urgent (`src/server/urgent.ts`) tourne dans le serveur toutes les 30 secondes et dès son démarrage (rattrapage après un arrêt brutal), ne lit que la base tant qu'il n'y a rien à faire, et compense au plus tard 60 secondes après son (re)démarrage. Il respecte un refus de quota (429) de Buffer sans le contourner. Voir `docs/EXPLOITATION.md` (budget, limites externes, alerte) et DECISIONS.md D33.

| Situation | Comportement |
| --- | --- |
| Crash après l'acceptation par Buffer, avant la confirmation locale | La réservation (« claimed », jeton) est rapprochée de l'état réel après 120 s : confirmée si conforme, annulée si le contenu ou l'accord n'est plus le bon |
| Accord retiré, rôle changé, canal transféré, client archivé | La programmation passe en « annulation à confirmer » ; reprise immédiate dans l'action, sinon par la boucle |
| Instantané général de Buffer en échec | Sans effet sur la reprise urgente |
| Deux processus | Un seul traite (verrou propre, bail renouvelé) ; l'ancien détenteur s'arrête |
| Buffer refuse (429) | Rien n'est tenté avant l'échéance ; l'urgence reste visible et durable ; jamais « annulé » |

## Prérequis

1. Migration `0006_sync_planifiee.sql` appliquée (verrou et état). Sans elle la synchronisation fonctionne, mais sans verrou entre processus et sans suivi du planificateur.
2. `AUTOMATION_SECRET` défini côté application, et son empreinte enregistrée dans la base (déjà le cas).
3. Facultatif : `SYNC_INTERVAL_MINUTES` (5 par défaut) dans la configuration, si vous changez la fréquence. Il sert à l'affichage (« en retard » au-delà de trois intervalles) et au planificateur Docker.

## Attention au quota Buffer

Un passage coûte une requête, plus deux par publication à programmer ou déprogrammer.

| Fréquence | Requêtes par mois | Compte de test (15 000) | Offre gratuite (3 000) |
| --- | --- | --- | --- |
| 5 minutes | ≈ 8 640 | Confortable | **Insuffisant** |
| 15 minutes | ≈ 2 880 | Confortable | Juste |
| 30 minutes | ≈ 1 440 | Confortable | Confortable |

Sur l'offre gratuite de Buffer, 5 minutes épuiserait le quota mensuel en dix jours environ. Cadence s'en protège (pause préventive) et l'écran Synchronisation l'annonce, mais il vaut mieux choisir 15 ou 30 minutes sur ce compte.

## Trois façons d'activer — en choisir une seule

### A. Docker (recommandé une fois l'application déployée avec Docker)

Le service `scheduler` de `docker-compose.yml` est désactivé par défaut (profil `scheduler`). Il vit et redémarre avec l'application, sans rien installer sur la machine.

```bash
docker compose --profile scheduler up -d scheduler     # activer
docker compose logs -f scheduler                        # suivre : une ligne par passage
docker compose --profile scheduler stop scheduler       # désactiver
```

### B. Tâche planifiée de la machine (application lancée sans Docker)

```bash
crontab -e
# puis coller la ligne de deploy/cadence-sync.cron, avec le bon chemin
```

Le script `scripts/sync-tick.sh` lit `AUTOMATION_SECRET` dans `.env.local` et écrit une ligne par passage. Pour désactiver : retirer la ligne.

### C. n8n

Importer `docs/n8n/cadence-synchronisation.json` (workflow inactif à l'import), créer l'identifiant « Header Auth » `x-automation-secret`, corriger l'adresse de Cadence, puis activer. À préférer seulement si n8n peut joindre l'application et que vous voulez y brancher vos propres alertes.

**Pourquoi A ou B plutôt que n8n par défaut :** un appel HTTP toutes les 5 minutes ne demande aucune logique ; moins il y a de pièces, moins il y a de pannes. Si A et C tournaient ensemble par erreur, le verrou empêcherait tout doublon.

## Vérifier après activation

1. Attendre un passage, ouvrir **Administration → Synchronisation** : « Planificateur : actif », « Dernier succès : à l'instant ».
2. Le journal montre une ligne `planifié` toutes les 5 minutes.
3. Essai du verrou : cliquer sur **Synchroniser** pendant un passage → « Une synchronisation est déjà en cours ».

## Essayer à la main, sans rien planifier

```bash
./scripts/sync-tick.sh        # un seul passage, application lancée en local
```
