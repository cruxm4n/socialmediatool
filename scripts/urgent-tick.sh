#!/bin/sh
# Surveillance externe du traitement URGENT (annulations à confirmer, réservations abandonnées) : un POST par minute
# suffit. Le serveur exécute déjà sa propre boucle (30 s) ; ce script la double si le processus de la boucle est
# bloqué, et prouve de l'extérieur que le mécanisme répond (exit 1 = 502 : une annulation n'a pas abouti).
# Variables : AUTOMATION_SECRET (ou CADENCE_ENV_FILE), CADENCE_URL (défaut http://127.0.0.1:3000).
set -eu
ENV_FILE="${CADENCE_ENV_FILE:-$(dirname "$0")/../.env.local}"
if [ -z "${AUTOMATION_SECRET:-}" ] && [ -f "$ENV_FILE" ]; then
  AUTOMATION_SECRET="$(sed -n 's/^AUTOMATION_SECRET=//p' "$ENV_FILE" | head -n 1)"
fi
if [ -z "${AUTOMATION_SECRET:-}" ]; then
  echo "$(date -u +%FT%TZ) erreur : AUTOMATION_SECRET introuvable" >&2
  exit 2
fi
URL="${CADENCE_URL:-http://127.0.0.1:3000}/api/automation/urgent"
STATUS="$(printf 'header = "x-automation-secret: %s"\n' "$AUTOMATION_SECRET" \
  | curl --silent --show-error --max-time 120 --config - --request POST --output /dev/null --write-out '%{http_code}' "$URL" 2>&1)" || {
  echo "$(date -u +%FT%TZ) erreur : Cadence injoignable ($STATUS)" >&2
  exit 1
}
case "$STATUS" in
  200) echo "$(date -u +%FT%TZ) ok" ;;
  502) echo "$(date -u +%FT%TZ) traitement urgent incomplet (annulation en attente : voir Administration > Synchronisation)" >&2; exit 1 ;;
  401) echo "$(date -u +%FT%TZ) erreur : secret refusé" >&2; exit 2 ;;
  *) echo "$(date -u +%FT%TZ) erreur : réponse HTTP $STATUS" >&2; exit 1 ;;
esac
