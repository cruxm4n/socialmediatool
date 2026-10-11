#!/bin/sh
# Un passage du planificateur : demande à Cadence de synchroniser Buffer.
# Lancé à intervalle régulier (60 minutes conseillées) par une tâche planifiée (voir docs/SYNCHRONISATION.md).
#
# Variables : AUTOMATION_SECRET (obligatoire), CADENCE_URL (défaut http://127.0.0.1:3000).
# Si AUTOMATION_SECRET est absent, il est lu dans le fichier CADENCE_ENV_FILE (défaut .env.local).
# Deux passages ne se chevauchent jamais : Cadence n'en exécute qu'un à la fois (verrou en base).
set -eu

ENV_FILE="${CADENCE_ENV_FILE:-$(dirname "$0")/../.env.local}"
if [ -z "${AUTOMATION_SECRET:-}" ] && [ -f "$ENV_FILE" ]; then
  AUTOMATION_SECRET="$(sed -n 's/^AUTOMATION_SECRET=//p' "$ENV_FILE" | head -n 1)"
fi
if [ -z "${AUTOMATION_SECRET:-}" ]; then
  echo "$(date -u +%FT%TZ) erreur : AUTOMATION_SECRET introuvable" >&2
  exit 2
fi

URL="${CADENCE_URL:-http://127.0.0.1:3000}/api/automation/sync"
# Le secret passe par l'entrée standard de curl : il n'apparaît ni dans la liste des processus ni dans les journaux.
STATUS="$(printf 'header = "x-automation-secret: %s"\n' "$AUTOMATION_SECRET" \
  | curl --silent --show-error --max-time 240 --config - --request POST --output /dev/null --write-out '%{http_code}' "$URL" 2>&1)" || {
  echo "$(date -u +%FT%TZ) erreur : Cadence injoignable ($STATUS)" >&2
  exit 1
}

case "$STATUS" in
  200) echo "$(date -u +%FT%TZ) ok" ;;
  502) echo "$(date -u +%FT%TZ) synchronisation en échec ou partielle (détail dans Cadence > Synchronisation)" >&2; exit 1 ;;
  401) echo "$(date -u +%FT%TZ) erreur : secret refusé" >&2; exit 2 ;;
  *) echo "$(date -u +%FT%TZ) erreur : réponse HTTP $STATUS" >&2; exit 1 ;;
esac
