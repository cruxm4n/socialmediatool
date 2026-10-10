#!/bin/sh
# Ferme aux connexions EXTERNES les ports de la pile Supabase de TEST PRÉEXISTANTE (54321 API, 54322 Postgres), que la
# CLI Supabase publie sur toutes les interfaces (0.0.0.0 et [::]) sans option de liaison locale.
#
# Les piles créées par cette mission (scripts/test-stack.mjs, restore-drill.mjs, migration-lab.mjs) n'ont PAS besoin
# de cette règle : elles écoutent sur 127.0.0.1 ou dans un réseau Docker interne.
#
# CE SCRIPT MODIFIE LE PARE-FEU DE LA MACHINE quand on l'applique : il n'a pas été exécuté pendant les missions de
# stabilisation. `apply` exige CADENCE_FIREWALL_CONFIRM=oui, posé par le propriétaire de la machine.
#
# Sous-commandes :
#   plan     affiche les règles qui seraient posées, sans rien exécuter ni lire du pare-feu
#   check    état réel (lecture seule). Codes : 0 règles présentes ; 1 règle(s) ABSENTE(S) ; 3 vérification IMPOSSIBLE
#            (droits insuffisants, outil absent, chaîne inexistante) — jamais confondu avec « absente »
#   apply    pose les règles (idempotent : une règle déjà présente n'est pas dupliquée)
#   remove   retire exactement ces règles (idempotent)
#
# Portée : uniquement le TCP, uniquement les ports PORTS (54321:54322 par défaut), uniquement les connexions entrantes
# par les interfaces EXTERNES (ni lo, ni docker0, ni br-*, ni veth*), en IPv4 ET en IPv6. 80/443, n8n et les autres
# services ne sont pas concernés. Les règles ne survivent pas à un redémarrage (voir docs/EXPLOITATION.md).
#
# Variables : PORTS (défaut 54321:54322), CHAIN (défaut DOCKER-USER), IPTABLES, IP6TABLES, IP (commande « ip »),
#             IFACES (liste d'interfaces externes, sinon déduites de « ip -o link »).
set -u
PORTS="${PORTS:-54321:54322}"
CHAIN="${CHAIN:-DOCKER-USER}"
IPT4="${IPTABLES:-iptables}"
IPT6="${IP6TABLES:-ip6tables}"
IPCMD="${IP:-ip}"
COMMENT="cadence-test-ports"

case "$PORTS" in
  *[!0-9:]*|"") echo "PORTS invalide : $PORTS" >&2; exit 2 ;;
esac
# Garde-fou : ce script ne doit jamais toucher 80, 443 ni un port hors de la plage de test.
for p in $(echo "$PORTS" | tr ':' ' '); do
  if [ "$p" -lt 54000 ] || [ "$p" -gt 54999 ]; then echo "Refusé : le port $p n'est pas un port de test (54000-54999)." >&2; exit 2; fi
done

external_ifaces() {
  if [ -n "${IFACES:-}" ]; then echo "$IFACES"; return 0; fi
  "$IPCMD" -o link show 2>/dev/null | awk -F': ' '{print $2}' | sed 's/@.*//' | grep -v -E '^(lo|docker[0-9]*|br-.*|veth.*|virbr.*|cni.*|flannel.*|tun.*)$' | sort -u
}

rule_args() { # $1 = interface
  echo "-i $1 -p tcp -m conntrack --ctorigdstport $PORTS -m comment --comment $COMMENT -j DROP"
}

# Sortie : 0 présente, 1 absente, 3 impossible (message sur stderr de l'outil dans $ERRFILE).
probe() { # $1 = outil, $2 = interface
  ERRFILE="$(mktemp)"
  # shellcheck disable=SC2046
  "$1" -C "$CHAIN" $(rule_args "$2") 2>"$ERRFILE"
  code=$?
  if [ "$code" -eq 0 ]; then rm -f "$ERRFILE"; return 0; fi
  if grep -q -i -E "permission denied|you must be root|can't initialize|not permitted|command not found|not found" "$ERRFILE" 2>/dev/null; then return 3; fi
  if grep -q -i -E "no chain/target/match by that name" "$ERRFILE" 2>/dev/null; then
    # La chaîne n'existe pas : on ne peut pas affirmer que le trafic est filtré OU non — vérification impossible.
    return 3
  fi
  if [ "$code" -eq 1 ]; then rm -f "$ERRFILE"; return 1; fi
  return 3
}

families() { echo "$IPT4:IPv4 $IPT6:IPv6"; }

action="${1:-check}"
case "$action" in
  plan)
    for family in $(families); do
      tool="${family%%:*}"; label="${family##*:}"
      for iface in $(external_ifaces); do echo "$label : $tool -I $CHAIN 1 $(rule_args "$iface")"; done
    done
    exit 0
    ;;
  check)
    worst=0; any=0
    for family in $(families); do
      tool="${family%%:*}"; label="${family##*:}"
      ifaces="$(external_ifaces)"
      if [ -z "$ifaces" ]; then echo "$label : aucune interface externe déterminée — vérification IMPOSSIBLE" >&2; worst=3; continue; fi
      for iface in $ifaces; do
        any=1
        probe "$tool" "$iface"; code=$?
        case "$code" in
          0) echo "$label $iface : règle PRÉSENTE (ports $PORTS fermés en entrée)" ;;
          1) echo "$label $iface : règle ABSENTE (ports $PORTS joignables depuis cette interface)"; [ "$worst" -lt 1 ] && worst=1 ;;
          *) echo "$label $iface : vérification IMPOSSIBLE ($(head -n 1 "$ERRFILE" 2>/dev/null | cut -c1-120))"; worst=3 ;;
        esac
        rm -f "${ERRFILE:-/dev/null}"
      done
    done
    [ "$any" -eq 0 ] && worst=3
    exit "$worst"
    ;;
  apply|remove)
    if [ "$action" = "apply" ] && [ "${CADENCE_FIREWALL_CONFIRM:-}" != "oui" ]; then
      echo "Refusé : apply modifie le pare-feu de la machine. Posez CADENCE_FIREWALL_CONFIRM=oui (décision du propriétaire)." >&2
      exit 2
    fi
    status=0
    for family in $(families); do
      tool="${family%%:*}"; label="${family##*:}"
      for iface in $(external_ifaces); do
        probe "$tool" "$iface"; code=$?
        if [ "$code" -eq 3 ]; then echo "$label $iface : impossible ($(head -n 1 "$ERRFILE" | cut -c1-120))" >&2; status=3; continue; fi
        if [ "$action" = "apply" ]; then
          if [ "$code" -eq 0 ]; then echo "$label $iface : déjà posée"; continue; fi
          # shellcheck disable=SC2046
          if "$tool" -I "$CHAIN" 1 $(rule_args "$iface"); then echo "$label $iface : posée"; else echo "$label $iface : échec de pose" >&2; status=3; fi
        else
          while [ "$code" -eq 0 ]; do
            # shellcheck disable=SC2046
            "$tool" -D "$CHAIN" $(rule_args "$iface") || { status=3; break; }
            probe "$tool" "$iface"; code=$?
          done
          echo "$label $iface : retirée (ou absente)"
        fi
      done
    done
    exit "$status"
    ;;
  *)
    echo "usage : $0 plan|check|apply|remove" >&2
    exit 2
    ;;
esac
