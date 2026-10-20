#!/usr/bin/env bash
# Checks the call relay (coturn) from the machine this runs on, the way two
# callers use it: it asks for the same short-lived credentials the app hands
# out, opens two relay allocations over UDP and over TCP, and sends packets
# between them.
#
# Usage:
#   bash scripts/check-relay.sh [path/to/.env]
#
# It reads CALLS_TURN_URLS and CALLS_TURN_SECRET from the environment, or from
# the .env file next to this folder. Needs `turnutils_uclient`, which comes
# with coturn (apt install coturn).
#
# A pass here means the relay is up and the secret matches. It does NOT prove
# that a phone behind a VPN can reach it: for that, use the call's "Technical
# details".

set -uo pipefail

ENV_FILE="${1:-$(cd "$(dirname "$0")/.." && pwd)/.env}"

read_env() {
  # Value of the last KEY=... line in the .env file, without surrounding quotes.
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -n 1)" || true
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

URLS="${CALLS_TURN_URLS:-$(read_env CALLS_TURN_URLS)}"
SECRET="${CALLS_TURN_SECRET:-$(read_env CALLS_TURN_SECRET)}"

if ! command -v turnutils_uclient >/dev/null 2>&1; then
  echo "turnutils_uclient was not found. It ships with coturn: apt install coturn" >&2
  exit 2
fi
if [ -z "$SECRET" ]; then
  echo "CALLS_TURN_SECRET is not set (looked in the environment and in $ENV_FILE)." >&2
  exit 2
fi
if [ -z "$URLS" ]; then
  echo "CALLS_TURN_URLS is not set (looked in the environment and in $ENV_FILE)." >&2
  exit 2
fi

# host:port of every turn: address, once each.
TARGETS=()
SKIPPED_TLS=0
IFS=',' read -r -a RAW_URLS <<< "$URLS"
for raw in "${RAW_URLS[@]}"; do
  url="$(printf '%s' "$raw" | tr -d '[:space:]')"
  case "$url" in
    turn:*) rest="${url#turn:}" ;;
    turns:*) SKIPPED_TLS=$((SKIPPED_TLS + 1)); continue ;;
    *) continue ;;
  esac
  rest="${rest%%\?*}"
  host="${rest%%:*}"
  port="${rest##*:}"
  [ "$port" = "$rest" ] && port=3478
  [ -z "$host" ] && continue
  target="$host:$port"
  seen=0
  for known in "${TARGETS[@]+"${TARGETS[@]}"}"; do
    [ "$known" = "$target" ] && seen=1
  done
  [ "$seen" -eq 0 ] && TARGETS+=("$target")
done

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "No turn: address found in CALLS_TURN_URLS (turns: addresses use TLS and are not checked here)." >&2
  exit 2
fi

# Same scheme as the app: username is an expiry time, password is
# base64(HMAC-SHA1(secret, username)). Every test gets a username of its own:
# coturn counts allocations per user (user-quota=6 in the bundled configuration)
# and one test opens several, so a second test under the same name would be
# refused and look like a broken relay.
CREDENTIALS_ISSUED=0
new_credentials() {
  CREDENTIALS_ISSUED=$((CREDENTIALS_ISSUED + 1))
  USERNAME=$(( $(date +%s) + 3600 + CREDENTIALS_ISSUED ))
  PASSWORD="$(printf '%s' "$USERNAME" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)"
}

FAILED=0

for target in "${TARGETS[@]}"; do
  host="${target%:*}"
  port="${target##*:}"
  addr="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1 {print $1}')"
  echo "Relay $host:$port (${addr:-no address found})"

  if [ -z "$addr" ]; then
    echo "  FAIL  the name does not resolve from this machine"
    FAILED=1
    continue
  fi

  # A name served through Cloudflare's proxy answers web requests with cf-ray.
  if command -v curl >/dev/null 2>&1 \
    && curl -sI --max-time 6 "http://$host/" 2>/dev/null | grep -qi '^cf-ray:'; then
    echo "  FAIL  $host is behind Cloudflare's proxy (orange cloud). Set its DNS record to \"DNS only\"."
    FAILED=1
  fi

  for transport in udp tcp; do
    new_credentials
    args=(-u "$USERNAME" -w "$PASSWORD" -p "$port" -n 5 -m 1 -y)
    [ "$transport" = "tcp" ] && args=(-t "${args[@]}")
    output="$(timeout 30 turnutils_uclient "${args[@]}" "$host" 2>&1)"
    received="$(printf '%s\n' "$output" | grep -o 'tot_recv_msgs=[0-9]*' | tail -n 1 | cut -d= -f2)"
    if printf '%s' "$output" | grep -q 'Cannot complete Allocation'; then
      echo "  FAIL  $transport: the relay refused the allocation. CALLS_TURN_SECRET must equal coturn's static-auth-secret (with use-auth-secret), and the clocks of both must agree."
      FAILED=1
    elif [ "${received:-0}" -gt 0 ] 2>/dev/null; then
      echo "  ok    $transport: relayed $received packets between two allocations"
    elif printf '%s' "$output" | grep -qi 'refused'; then
      echo "  FAIL  $transport: connection refused. coturn is not listening on $transport port $port."
      FAILED=1
    else
      echo "  FAIL  $transport: no answer. A firewall may be dropping $transport $port, or coturn is not running."
      FAILED=1
    fi
  done
done

if [ "$SKIPPED_TLS" -gt 0 ]; then
  echo "Skipped $SKIPPED_TLS turns: (TLS) address(es)."
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "The relay works from this machine. If a call from a phone still hangs on Connecting, the phone cannot reach it: open the call's Technical details."
  exit 0
fi
echo "The relay has problems (see FAIL above)."
exit 1
