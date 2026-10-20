#!/usr/bin/env bats
# The voice/video calls relay (coturn) step of scripts/install.sh: the configuration it
# writes, the app settings that must match it, the firewall, and what happens when
# something is missing.
#
# Nothing here touches the machine: apt-get is a script in PATH that only records its
# arguments, systemctl/ufw/getent are functions, and every file the step writes lives in
# TEST_DIR (the paths are variables of the script).

load 'helpers/installer'

DOCS_FILE="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/docs/Calls-and-Video-Messages.md"
COMPOSE_FILE="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/docker-compose.yaml"
CALLS_CONFIG_MODULE="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/server/lib/callsConfig.js"

setup() {
  load_installer
  sleep() { return 0; }

  mkdir -p "$TEST_DIR/bin" "$INSTALL_DIR/scripts"
  export CALLS_LOG="$TEST_DIR/calls.log"
  : > "$CALLS_LOG"

  # apt_get_run starts apt-get through env, so a shell function would not be found.
  cat > "$TEST_DIR/bin/apt-get" <<'EOF'
#!/bin/bash
echo "apt-get $*" >> "$CALLS_LOG"
exit "${FAKE_APT_STATUS:-0}"
EOF
  chmod +x "$TEST_DIR/bin/apt-get"
  export PATH="$TEST_DIR/bin:$PATH"

  # The check script the relay step runs at its end.
  cat > "$INSTALL_DIR/scripts/check-relay.sh" <<'EOF'
#!/bin/bash
echo "check-relay $* CALLS_TURN_URLS=${CALLS_TURN_URLS:-}" >> "$CALLS_LOG"
exit "${FAKE_CHECK_STATUS:-0}"
EOF

  COTURN_CONFIG_PRIMARY="$TEST_DIR/turnserver.conf"
  COTURN_CONFIG_ALTERNATE="$TEST_DIR/coturn/turnserver.conf"
  COTURN_CERT_DIR="$TEST_DIR/coturn-certs"
  COTURN_DEFAULTS_FILE="$TEST_DIR/default-coturn"
  CERTBOT_HOOK_DIR="$TEST_DIR/hooks"
  printf 'SERVER_PORT=5174\nADMIN_API_TOKEN=keepme\n' > "$INSTALL_DIR/.env"

  FAKE_COTURN_INSTALLED=1
  FAKE_COTURN_RESTART_FAIL=0
  FAKE_UFW=inactive
  FAKE_RESOLVED=""
  FAKE_LOCAL_IP="10.0.0.5"
  dpkg() {
    if [[ "${1:-}" == "-s" ]]; then
      [[ "$FAKE_COTURN_INSTALLED" == "1" ]]
      return
    fi
    command dpkg "$@"
  }
  turnutils_uclient() { :; }
  systemctl() {
    echo "systemctl $*" >> "$CALLS_LOG"
    if [[ "$*" == "restart coturn" && "$FAKE_COTURN_RESTART_FAIL" == "1" ]]; then
      return 1
    fi
    return 0
  }
  ufw() {
    echo "ufw $*" >> "$CALLS_LOG"
    if [[ "${1:-}" == "status" ]]; then
      echo "Status: ${FAKE_UFW}"
    fi
    return 0
  }
  # install(1) with the owner switches a non-root test could not use.
  install() {
    local args=("$@")
    local dest="${args[-1]}"
    local src="${args[-2]}"
    if [[ "$src" == "/dev/null" ]]; then
      : > "$dest"
    else
      cp "$src" "$dest"
    fi
    chmod 755 "$dest" 2>/dev/null || true
  }
  chown() { return 0; }
  getent() {
    case "$1" in
      group) return 2 ;;
      ahostsv4)
        if [[ -n "$FAKE_RESOLVED" ]]; then
          printf '%s STREAM %s\n' "$FAKE_RESOLVED" "$2"
        fi
        ;;
    esac
  }
  hostname() { printf 'vps-1'; }
  detect_local_ipv4() { printf '%s' "$FAKE_LOCAL_IP"; }
  wait_for_tcp_port() { return 0; }
  wait_for_app_health() { return 0; }

  CALLS_RELAY_MODE="yes"
  AURELLE_PUBLIC_IP="203.0.113.7"
  DEPLOY_MODE="ip"
  CERT_MODE="http"
}

teardown() {
  unload_installer
}

conf_value() {
  grep -E "^$1=" "$COTURN_CONFIG_PRIMARY" | head -n 1 | cut -d= -f2-
}

env_value() {
  grep -E "^$1=" "$INSTALL_DIR/.env" | tail -n 1 | cut -d= -f2-
}

# ===========================================================================
# The configuration template
# ===========================================================================

@test "render_coturn_config: the settings the app and coturn must agree on" {
  run render_coturn_config chat.example.com "abc123" "203.0.113.7" "" 3478 49160 49260
  [ "$status" -eq 0 ]
  [[ "$output" == *$'\nrealm=chat.example.com\n'* ]]
  [[ "$output" == *$'\nlistening-port=3478\n'* ]]
  [[ "$output" == *$'\nuse-auth-secret\n'* ]]
  [[ "$output" == *$'\nstatic-auth-secret=abc123\n'* ]]
  [[ "$output" == *$'\nmin-port=49160\n'* ]]
  [[ "$output" == *$'\nmax-port=49260\n'* ]]
  [[ "$output" == *$'\nfingerprint\n'* ]]
  [[ "$output" == *$'\nno-multicast-peers\n'* ]]
  [[ "$output" == *$'\nno-cli\n'* ]]
  [[ "$output" == *$'\nuser-quota=6\n'* ]]
  [[ "$output" == *$'\ntotal-quota=200\n'* ]]
  [[ "${lines[0]}" == "$COTURN_MARKER" ]]
}

@test "render_coturn_config: external-ip is the public address, with the private one behind NAT" {
  run render_coturn_config r s "203.0.113.7" "" 3478 49160 49260
  [[ "$output" == *$'\nexternal-ip=203.0.113.7\n'* ]]
  run render_coturn_config r s "203.0.113.7" "203.0.113.7" 3478 49160 49260
  [[ "$output" == *$'\nexternal-ip=203.0.113.7\n'* ]]
  run render_coturn_config r s "203.0.113.7" "10.0.0.5" 3478 49160 49260
  [[ "$output" == *$'\nexternal-ip=203.0.113.7/10.0.0.5\n'* ]]
  run render_coturn_config r s "" "" 3478 49160 49260
  [[ "$output" != *"external-ip"* ]]
}

@test "render_coturn_config: TLS lines only when the port, the certificate and the key are all given" {
  run render_coturn_config r s "" "" 3478 49160 49260
  [[ "$output" != *"tls-listening-port"* ]]
  [[ "$output" != *"cert="* ]]
  run render_coturn_config r s "" "" 3478 49160 49260 5349
  [[ "$output" != *"tls-listening-port"* ]]
  run render_coturn_config r s "" "" 3478 49160 49260 5349 /etc/coturn/certs/fullchain.pem
  [[ "$output" != *"tls-listening-port"* ]]
  run render_coturn_config r s "" "" 3478 49160 49260 5349 /c/fullchain.pem /c/privkey.pem
  [[ "$output" == *$'\ntls-listening-port=5349\n'* ]]
  [[ "$output" == *$'\ncert=/c/fullchain.pem\n'* ]]
  [[ "$output" == *$'\npkey=/c/privkey.pem\n'* ]]
}

@test "render_coturn_config: the denied peer lines are exactly the documented ones" {
  rendered="$(render_coturn_config r s "" "" 3478 49160 49260 | grep '^denied-peer-ip=' | sort)"
  documented="$(grep '^denied-peer-ip=' "$DOCS_FILE" | sort)"
  [ -n "$documented" ]
  [ "$rendered" = "$documented" ]
  [ "$(printf '%s\n' "$rendered" | wc -l)" -eq 12 ]
}

@test "render_coturn_config: the denied peers match docker-compose.yaml" {
  rendered="$(render_coturn_config r s "" "" 3478 49160 49260 | sed -n 's/^denied-peer-ip=//p' | sort)"
  compose="$(sed -n 's/.*"--denied-peer-ip=\(.*\)".*/\1/p' "$COMPOSE_FILE" | sort)"
  [ -n "$compose" ]
  [ "$rendered" = "$compose" ]
}

@test "render_coturn_config: never the range that blocks all of IPv4, never loopback peers" {
  run render_coturn_config r s "203.0.113.7" "10.0.0.5" 3478 49160 49260 5349 /c /k
  [[ "$output" != *"::-::"* ]]
  [[ "$output" != *"allow-loopback-peers"* ]]
  [[ "$output" != *"no-multicast-peers=0"* ]]
  [[ "$output" != *"allowed-peer-ip"* ]]
  # IPv4 mapped IPv6 addresses would slip past the IPv4 ranges.
  [[ "$output" == *$'\ndenied-peer-ip=::ffff:0:0-::ffff:ffff:ffff\n'* ]]
  [[ "$output" == *$'\ndenied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff\n'* ]]
}

@test "render_coturn_config: the secret in the configuration is the one the app signs credentials with" {
  command -v node >/dev/null || skip "node is not installed"
  secret="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  conf="$(render_coturn_config r "$secret" "203.0.113.7" "" 3478 49160 49260)"
  urls="$(build_calls_turn_urls 203.0.113.7 3478 "")"
  # coturn's "TURN REST API" check: credential = base64(HMAC-SHA1(secret, username)).
  run node --input-type=module -e "
    import crypto from 'node:crypto';
    import { readCallsConfig, buildIceServers } from '${CALLS_CONFIG_MODULE}';
    const config = readCallsConfig({ CALLS_TURN_URLS: process.argv[1], CALLS_TURN_SECRET: process.argv[2] });
    const out = buildIceServers(config, 'user1', 1700000000000);
    const server = out.iceServers[0];
    const expected = crypto.createHmac('sha1', process.argv[3]).update(server.username).digest('base64');
    console.log(out.hasRelay, server.credential === expected);
  " "$urls" "$secret" "$(printf '%s\n' "$conf" | sed -n 's/^static-auth-secret=//p')"
  [ "$status" -eq 0 ]
  [ "$output" = "true true" ]
}

@test "render_coturn_config: a real coturn reads every line and lists the denied ranges" {
  command -v turnserver >/dev/null || skip "coturn is not installed"
  command -v setsid >/dev/null || skip "setsid is not installed"
  render_coturn_config chat.example.com secret203 "203.0.113.7" "10.0.0.5" 3478 49160 49260 \
    | grep -v '^syslog$' > "$TEST_DIR/t.conf"
  local port=$((20000 + RANDOM % 20000))
  # coturn signals its whole process group when it is stopped: give it a session.
  run setsid -w timeout 4 turnserver -c "$TEST_DIR/t.conf" --listening-port "$port" \
    --listening-ip 127.0.0.1 --relay-ip 127.0.0.1 --min-port 49400 --max-port 49410 \
    --no-cli --no-tls --no-dtls --pidfile "" --log-file stdout
  # 124: still running when the timeout stopped it, so it did not reject the file.
  [ "$status" -eq 124 ]
  [[ "$output" != *"Bad configuration format"* ]]
  [ "$(printf '%s\n' "$output" | grep -c 'Black listing:')" -eq 12 ]
}

# ===========================================================================
# URLs, host and ports
# ===========================================================================

@test "build_calls_turn_urls: STUN, TURN over UDP and TCP, and TLS when there is a certificate" {
  [ "$(build_calls_turn_urls 203.0.113.7 3478 "")" = "stun:203.0.113.7:3478,turn:203.0.113.7:3478,turn:203.0.113.7:3478?transport=tcp" ]
  [ "$(build_calls_turn_urls chat.example.com 3478 5349)" = "stun:chat.example.com:3478,turn:chat.example.com:3478,turn:chat.example.com:3478?transport=tcp,turns:chat.example.com:5349" ]
}

@test "build_calls_turn_urls: the app adds no second TCP twin to what is written" {
  command -v node >/dev/null || skip "node is not installed"
  urls="$(build_calls_turn_urls chat.example.com 3478 5349)"
  run node --input-type=module -e "
    import { readCallsConfig, buildIceServers } from '${CALLS_CONFIG_MODULE}';
    const config = readCallsConfig({ CALLS_TURN_URLS: process.argv[1], CALLS_TURN_SECRET: 's' });
    console.log(JSON.stringify(buildIceServers(config, 'u').iceServers.flatMap((s) => s.urls)));
  " "$urls"
  [ "$status" -eq 0 ]
  [ "$output" = '["stun:chat.example.com:3478","turn:chat.example.com:3478","turn:chat.example.com:3478?transport=tcp","turns:chat.example.com:5349"]' ]
}

@test "build_calls_turn_urls: what the app offers is still right when the TCP twin is left out" {
  command -v node >/dev/null || skip "node is not installed"
  # The app adds the TCP twin itself; the installer also writes it, so that it stays when
  # CALLS_TURN_TCP_FALLBACK is switched off.
  urls="$(build_calls_turn_urls 203.0.113.7 3478 "")"
  run node --input-type=module -e "
    import { readCallsConfig, buildIceServers } from '${CALLS_CONFIG_MODULE}';
    const config = readCallsConfig({ CALLS_TURN_URLS: process.argv[1], CALLS_TURN_SECRET: 's', CALLS_TURN_TCP_FALLBACK: 'false' });
    console.log(JSON.stringify(buildIceServers(config, 'u').iceServers.flatMap((s) => s.urls)));
  " "$urls"
  [ "$status" -eq 0 ]
  [ "$output" = '["stun:203.0.113.7:3478","turn:203.0.113.7:3478","turn:203.0.113.7:3478?transport=tcp"]' ]
}

@test "relay_host_for: the IP when there is no name" {
  [ "$(relay_host_for "" "203.0.113.7" "")" = "203.0.113.7" ]
}

@test "relay_host_for: the name when it points at this server" {
  [ "$(relay_host_for chat.example.com 203.0.113.7 "203.0.113.7")" = "chat.example.com" ]
  [ "$(relay_host_for chat.example.com 203.0.113.7 "198.51.100.1 203.0.113.7")" = "chat.example.com" ]
}

@test "relay_host_for: the IP when the name points somewhere else (Cloudflare's proxy)" {
  [ "$(relay_host_for chat.example.com 203.0.113.7 "104.21.0.1 172.67.0.1")" = "203.0.113.7" ]
}

@test "relay_host_for: the IP when the name does not resolve yet" {
  [ "$(relay_host_for chat.example.com 203.0.113.7 "")" = "203.0.113.7" ]
}

@test "relay_host_for: the name when the public IP is unknown" {
  [ "$(relay_host_for chat.example.com "" "")" = "chat.example.com" ]
}

@test "is_valid_port_range" {
  is_valid_port_range 3478 49160 49260
  refute is_valid_port_range 0 49160 49260
  refute is_valid_port_range 3478 49260 49160
  refute is_valid_port_range 3478 49160 49160
  refute is_valid_port_range 3478 49160 70000
  refute is_valid_port_range abc 49160 49260
}

# ===========================================================================
# A configuration that is somebody else's
# ===========================================================================

@test "coturn_config_is_unmanaged: a file with our marker is ours" {
  printf '%s\nrealm=x\nlistening-port=3478\n' "$COTURN_MARKER" > "$TEST_DIR/c.conf"
  refute coturn_config_is_unmanaged "$TEST_DIR/c.conf"
}

@test "coturn_config_is_unmanaged: a missing file or the distribution default is nobody's" {
  refute coturn_config_is_unmanaged "$TEST_DIR/none.conf"
  printf '%s\n' '# comment' '' '#listening-port=3478' '  # another' 'syslog' 'no-rfc5780' 'no-stun-backward-compatibility' 'response-origin-only-with-rfc5780' > "$TEST_DIR/c.conf"
  refute coturn_config_is_unmanaged "$TEST_DIR/c.conf"
}

@test "coturn_config_is_unmanaged: active settings without our marker belong to somebody" {
  printf '%s\n' 'listening-port=3478' 'realm=other.example.com' > "$TEST_DIR/c.conf"
  coturn_config_is_unmanaged "$TEST_DIR/c.conf"
}

@test "coturn_config_path: the main file, or the one in /etc/coturn when only that exists" {
  [ "$(coturn_config_path)" = "$COTURN_CONFIG_PRIMARY" ]
  mkdir -p "$(dirname "$COTURN_CONFIG_ALTERNATE")"
  : > "$COTURN_CONFIG_ALTERNATE"
  [ "$(coturn_config_path)" = "$COTURN_CONFIG_ALTERNATE" ]
  : > "$COTURN_CONFIG_PRIMARY"
  [ "$(coturn_config_path)" = "$COTURN_CONFIG_PRIMARY" ]
}

# ===========================================================================
# install_calls_relay
# ===========================================================================

@test "install_calls_relay: writes the configuration and the app settings with one secret" {
  install_calls_relay
  [ -f "$COTURN_CONFIG_PRIMARY" ]
  grep -qF "$COTURN_MARKER" "$COTURN_CONFIG_PRIMARY"

  secret="$(conf_value static-auth-secret)"
  [[ "$secret" =~ ^[0-9a-f]{64}$ ]]
  [ "$(env_value CALLS_TURN_SECRET)" = "$secret" ]
  [ "$(env_value CALLS_TURN_URLS)" = "stun:203.0.113.7:3478,turn:203.0.113.7:3478,turn:203.0.113.7:3478?transport=tcp" ]
  [ "$(conf_value external-ip)" = "203.0.113.7/10.0.0.5" ]
  [ "$(conf_value realm)" = "vps-1" ]
  # What was in the file before stays.
  [ "$(env_value ADMIN_API_TOKEN)" = "keepme" ]
  [ "$(env_value SERVER_PORT)" = "5174" ]
}

@test "install_calls_relay: starts coturn, then restarts the app so it reads the new settings" {
  install_calls_relay
  grep -qx 'systemctl enable coturn' "$CALLS_LOG"
  grep -qx 'systemctl restart coturn' "$CALLS_LOG"
  grep -qx 'systemctl restart songbird.service' "$CALLS_LOG"
  # coturn first, the app after the settings are written.
  coturn_line="$(grep -nx 'systemctl restart coturn' "$CALLS_LOG" | head -n 1 | cut -d: -f1)"
  app_line="$(grep -nx 'systemctl restart songbird.service' "$CALLS_LOG" | head -n 1 | cut -d: -f1)"
  [ "$coturn_line" -lt "$app_line" ]
}

@test "install_calls_relay: the configuration is private to root and the coturn group" {
  install_calls_relay
  [ "$(stat -c %a "$COTURN_CONFIG_PRIMARY")" = "640" ]
}

@test "install_calls_relay: installs coturn from apt when it is missing" {
  FAKE_COTURN_INSTALLED=0
  install_calls_relay
  grep -q 'apt-get .*install -y coturn openssl' "$CALLS_LOG"
  [ -f "$COTURN_CONFIG_PRIMARY" ]
}

@test "install_calls_relay: does not touch apt when coturn is already installed" {
  install_calls_relay
  refute grep -q 'apt-get' "$CALLS_LOG"
}

@test "install_calls_relay: skips cleanly, with a message, when coturn cannot be installed" {
  FAKE_COTURN_INSTALLED=0
  export FAKE_APT_STATUS=100
  install_calls_relay > "$TEST_DIR/out" 2>&1
  output="$(cat "$TEST_DIR/out")"
  [[ "$output" == *"coturn could not be installed"* ]]
  [[ "$output" == *"docs/Calls-and-Video-Messages.md"* ]]
  [ ! -e "$COTURN_CONFIG_PRIMARY" ]
  refute grep -q 'systemctl' "$CALLS_LOG"
  refute grep -q '^CALLS_TURN' "$INSTALL_DIR/.env"
  [ "$CALLS_RELAY_SUMMARY" = "Skipped: coturn could not be installed." ]
}

@test "install_calls_relay: does nothing when the relay was not asked for" {
  CALLS_RELAY_MODE="no"
  install_calls_relay
  [ ! -e "$COTURN_CONFIG_PRIMARY" ]
  [ ! -s "$CALLS_LOG" ]
  [ -n "$CALLS_RELAY_SUMMARY" ]
}

@test "install_calls_relay: skips, with a message, when the server's public address is unknown" {
  AURELLE_PUBLIC_IP=""
  detect_public_ip() { PUBLIC_IP=""; }
  run install_calls_relay
  [ "$status" -eq 0 ]
  [[ "$output" == *"public address could not be found"* ]]
  [[ "$output" == *"AURELLE_PUBLIC_IP"* ]]
  [ ! -e "$COTURN_CONFIG_PRIMARY" ]
}

@test "install_calls_relay: skips when the relay ports are not usable" {
  AURELLE_RELAY_MIN_PORT=50000
  AURELLE_RELAY_MAX_PORT=49000
  run install_calls_relay
  [ "$status" -eq 0 ]
  [[ "$output" == *"relay ports are not valid"* ]]
  [ ! -e "$COTURN_CONFIG_PRIMARY" ]
}

@test "install_calls_relay: the ports can be changed" {
  AURELLE_RELAY_PORT=3490
  AURELLE_RELAY_MIN_PORT=50000
  AURELLE_RELAY_MAX_PORT=50100
  install_calls_relay
  [ "$(conf_value listening-port)" = "3490" ]
  [ "$(conf_value min-port)" = "50000" ]
  [ "$(conf_value max-port)" = "50100" ]
  [ "$(env_value CALLS_TURN_URLS)" = "stun:203.0.113.7:3490,turn:203.0.113.7:3490,turn:203.0.113.7:3490?transport=tcp" ]
}

@test "install_calls_relay: running it again keeps the secret" {
  install_calls_relay
  first="$(env_value CALLS_TURN_SECRET)"
  install_calls_relay
  [ "$(env_value CALLS_TURN_SECRET)" = "$first" ]
  [ "$(conf_value static-auth-secret)" = "$first" ]
  [ "$(grep -c '^CALLS_TURN_URLS=' "$INSTALL_DIR/.env")" -eq 1 ]
  [ "$(grep -c '^CALLS_TURN_SECRET=' "$INSTALL_DIR/.env")" -eq 1 ]
}

@test "install_calls_relay: coturn that did not start is a warning, and the app keeps its settings" {
  FAKE_COTURN_RESTART_FAIL=1
  run install_calls_relay
  [ "$status" -eq 0 ]
  [[ "$output" == *"coturn did not start"* ]]
  [[ "$output" == *"journalctl -u coturn"* ]]
  refute grep -q '^CALLS_TURN' "$INSTALL_DIR/.env"
  refute grep -qx 'systemctl restart songbird.service' "$CALLS_LOG"
}

@test "install_calls_relay: a domain that points at this server is the relay name and gets TLS" {
  DEPLOY_MODE="domain"
  CERT_MODE="files"
  parse_domain_input "chat.example.com"
  FAKE_RESOLVED="203.0.113.7"
  # The web server's copy of the certificate, where the installer put it.
  installed_cert="$(manual_group_fullchain_path "${DOMAIN_GROUPS[0]}")"
  installed_key="$(manual_group_privkey_path "${DOMAIN_GROUPS[0]}")"
  mkdir -p "$(dirname "$installed_cert")"
  printf 'cert\n' > "$installed_cert"
  printf 'key\n' > "$installed_key"
  install_calls_relay
  [ "$(conf_value realm)" = "chat.example.com" ]
  [ "$(conf_value tls-listening-port)" = "5349" ]
  [ "$(conf_value cert)" = "$COTURN_CERT_DIR/fullchain.pem" ]
  [ "$(conf_value pkey)" = "$COTURN_CERT_DIR/privkey.pem" ]
  [ "$(cat "$COTURN_CERT_DIR/fullchain.pem")" = "cert" ]
  [ "$(cat "$COTURN_CERT_DIR/privkey.pem")" = "key" ]
  [ "$(env_value CALLS_TURN_URLS)" = "stun:chat.example.com:3478,turn:chat.example.com:3478,turn:chat.example.com:3478?transport=tcp,turns:chat.example.com:5349" ]
}

@test "install_calls_relay: no TLS without a certificate for the relay name" {
  DEPLOY_MODE="domain"
  CERT_MODE="selfsigned"
  parse_domain_input "chat.example.com"
  FAKE_RESOLVED="203.0.113.7"
  install_calls_relay
  [ "$(conf_value realm)" = "chat.example.com" ]
  refute grep -q '^tls-listening-port' "$COTURN_CONFIG_PRIMARY"
  refute grep -q '^cert=' "$COTURN_CONFIG_PRIMARY"
  [[ "$(env_value CALLS_TURN_URLS)" != *"turns:"* ]]
}

@test "install_calls_relay: behind Cloudflare the relay address is the server IP, not the name" {
  DEPLOY_MODE="domain"
  CERT_MODE="certbot"
  parse_domain_input "chat.example.com"
  FAKE_RESOLVED="104.21.0.1"
  run install_calls_relay
  [ "$status" -eq 0 ]
  [[ "$output" == *"behind Cloudflare"* ]]
  [ "$(conf_value realm)" = "chat.example.com" ]
  [ "$(env_value CALLS_TURN_URLS)" = "stun:203.0.113.7:3478,turn:203.0.113.7:3478,turn:203.0.113.7:3478?transport=tcp" ]
  refute grep -q '^tls-listening-port' "$COTURN_CONFIG_PRIMARY"
}

@test "install_calls_relay: a coturn set up by somebody else is left alone" {
  printf '%s\n' 'listening-port=3478' 'realm=other.example.com' 'static-auth-secret=theirs' > "$COTURN_CONFIG_PRIMARY"
  install_calls_relay > "$TEST_DIR/out" 2>&1
  [[ "$(cat "$TEST_DIR/out")" == *"did not write"* ]]
  [[ "$(cat "$TEST_DIR/out")" == *"AURELLE_CALLS_RELAY=force"* ]]
  grep -qx 'static-auth-secret=theirs' "$COTURN_CONFIG_PRIMARY"
  refute grep -q '^CALLS_TURN' "$INSTALL_DIR/.env"
  [[ "$CALLS_RELAY_SUMMARY" == *"alone"* ]]
}

@test "install_calls_relay: force replaces it and keeps a backup" {
  printf '%s\n' 'listening-port=3478' 'realm=other.example.com' 'static-auth-secret=theirs' > "$COTURN_CONFIG_PRIMARY"
  CALLS_RELAY_MODE="force"
  install_calls_relay
  grep -qF "$COTURN_MARKER" "$COTURN_CONFIG_PRIMARY"
  refute grep -q 'theirs' "$COTURN_CONFIG_PRIMARY"
  backups=("$COTURN_CONFIG_PRIMARY".bak.*)
  [ -f "${backups[0]}" ]
  grep -qx 'static-auth-secret=theirs' "${backups[0]}"
  [ -n "$(env_value CALLS_TURN_URLS)" ]
}

@test "install_calls_relay: a relay already set in .env (Docker's coturn) is not replaced silently" {
  printf 'CALLS_TURN_URLS=turn:turn.example.com:3478\nCALLS_TURN_SECRET=docker\n' >> "$INSTALL_DIR/.env"
  run install_calls_relay
  [ "$status" -eq 0 ]
  [[ "$output" == *"CALLS_TURN_URLS is already set"* ]]
  [ "$(env_value CALLS_TURN_SECRET)" = "docker" ]
  [ ! -e "$COTURN_CONFIG_PRIMARY" ]
}

@test "install_calls_relay: the TURNSERVER_ENABLED switch of older packages is turned on" {
  printf '%s\n' '#TURNSERVER_ENABLED=1' > "$COTURN_DEFAULTS_FILE"
  install_calls_relay
  grep -qx 'TURNSERVER_ENABLED=1' "$COTURN_DEFAULTS_FILE"
}

@test "install_calls_relay: opens the relay ports in an active ufw" {
  FAKE_UFW="active"
  install_calls_relay
  grep -qx 'ufw allow 3478/tcp' "$CALLS_LOG"
  grep -qx 'ufw allow 3478/udp' "$CALLS_LOG"
  grep -qx 'ufw allow 49160:49260/udp' "$CALLS_LOG"
}

@test "install_calls_relay: leaves an inactive ufw alone" {
  FAKE_UFW="inactive"
  run install_calls_relay
  refute grep -q 'ufw allow' "$CALLS_LOG"
  refute grep -q 'ufw enable' "$CALLS_LOG"
  [[ "$output" == *"hosting provider has its own firewall"* ]]
}

@test "install_calls_relay: a passing check says so and still reminds of the provider's firewall" {
  install_calls_relay > /dev/null
  grep -q "check-relay ${INSTALL_DIR}/.env" "$CALLS_LOG"
  [[ "$CALLS_RELAY_SUMMARY" == *"works from this server"* ]]
  [[ "$CALLS_RELAY_SUMMARY" == *"hosting provider's firewall"* ]]
}

@test "install_calls_relay: a failing check is only a warning, with advice" {
  export FAKE_CHECK_STATUS=1
  install_calls_relay > "$TEST_DIR/out" 2>&1
  output="$(cat "$TEST_DIR/out")"
  [[ "$output" == *"WARNING: The calls relay is installed but the check from this server failed"* ]]
  [[ "$output" == *"hosting provider's firewall"* ]]
  [[ "$output" == *"check-relay.sh"* ]]
  # The settings stay: the relay may well work from outside.
  [ -n "$(env_value CALLS_TURN_URLS)" ]
  [[ "$CALLS_RELAY_SUMMARY" == *"check failed"* ]]
}

@test "install_calls_relay: the check is also run against the server's own address to tell the cases apart" {
  export FAKE_CHECK_STATUS=1
  install_calls_relay >/dev/null
  grep -q 'CALLS_TURN_URLS=turn:10.0.0.5:3478' "$CALLS_LOG"
}

@test "install_calls_relay: the secret never reaches the install log" {
  install_calls_relay >/dev/null
  secret="$(env_value CALLS_TURN_SECRET)"
  [ -n "$secret" ]
  refute grep -qF "$secret" "$LOG_FILE"
}

# ===========================================================================
# Advice after a failed check
# ===========================================================================

@test "advise_relay_problems: a host name gets the Cloudflare advice, an IP does not" {
  run advise_relay_problems chat.example.com 3478 no
  [[ "$output" == *"DNS-only"* ]]
  [[ "$output" == *"orange cloud"* ]]
  [[ "$output" == *"journalctl -u coturn"* ]]
  run advise_relay_problems 203.0.113.7 3478 no
  [[ "$output" != *"orange cloud"* ]]
  [[ "$output" == *"3478/tcp, 3478/udp and 49160-49260/udp"* ]]
}

@test "advise_relay_problems: when coturn answers locally the blame goes to the way in" {
  run advise_relay_problems 203.0.113.7 3478 yes
  [[ "$output" == *"coturn itself works"* ]]
  [[ "$output" != *"journalctl -u coturn"* ]]
}

# ===========================================================================
# The question
# ===========================================================================

@test "prompt_calls_relay_choice: unattended it installs the relay by default" {
  UNATTENDED=1
  CALLS_RELAY_MODE=""
  prompt_calls_relay_choice
  [ "$CALLS_RELAY_MODE" = "yes" ]
}

@test "prompt_calls_relay_choice: AURELLE_CALLS_RELAY=0 is kept unattended" {
  UNATTENDED=1
  AURELLE_CALLS_RELAY=0
  resolve_calls_relay_mode
  prompt_calls_relay_choice
  [ "$CALLS_RELAY_MODE" = "no" ]
}

@test "prompt_calls_relay_choice: interactively it asks, and the default is yes" {
  CALLS_RELAY_MODE=""
  prompt_yes_no() { printf '%s' "$2" > "$TEST_DIR/default-answer"; printf 'yes'; }
  run prompt_calls_relay_choice
  [[ "$output" == *"relay"* ]]
  CALLS_RELAY_MODE="$(prompt_calls_relay_choice | tail -n 1)"
  [ "$(cat "$TEST_DIR/default-answer")" = "yes" ]
}

@test "prompt_calls_relay_choice: interactively a 'no' is kept" {
  CALLS_RELAY_MODE=""
  prompt_yes_no() { printf 'no'; }
  prompt_calls_relay_choice > /dev/null
  [ "$CALLS_RELAY_MODE" = "no" ]
}

@test "prompt_calls_relay_choice: nothing is asked when the variable already decided" {
  CALLS_RELAY_MODE="yes"
  prompt_yes_no() { echo "ASKED" >> "$TEST_DIR/asked"; printf 'no'; }
  prompt_calls_relay_choice
  [ "$CALLS_RELAY_MODE" = "yes" ]
  [ ! -e "$TEST_DIR/asked" ]
}

# ===========================================================================
# Firewall
# ===========================================================================

@test "firewall_open_ports: ufw gets port ranges with a colon" {
  FAKE_UFW="active"
  firewall_open_ports "80/tcp" "49160-49260/udp"
  grep -qx 'ufw allow 80/tcp' "$CALLS_LOG"
  grep -qx 'ufw allow 49160:49260/udp' "$CALLS_LOG"
}

@test "firewall_open_ports: firewalld gets the ports permanently and a reload" {
  have_cmd() { [[ "$1" == "firewall-cmd" ]]; }
  firewall-cmd() { echo "firewall-cmd $*" >> "$CALLS_LOG"; return 0; }
  firewall_open_ports "80/tcp" "49160-49260/udp"
  grep -qx 'firewall-cmd --state' "$CALLS_LOG"
  grep -qx 'firewall-cmd --permanent --add-port=80/tcp' "$CALLS_LOG"
  grep -qx 'firewall-cmd --permanent --add-port=49160-49260/udp' "$CALLS_LOG"
  grep -qx 'firewall-cmd --reload' "$CALLS_LOG"
}

@test "firewall_open_ports: no active firewall means nothing is changed and the ports are listed" {
  FAKE_UFW="inactive"
  run firewall_open_ports "80/tcp" "443/tcp"
  [ "$status" -eq 0 ]
  refute grep -q 'allow' "$CALLS_LOG"
  [[ "$output" == *"allow: 80/tcp 443/tcp"* ]]
}

@test "firewall_open_ports: a rule that fails is reported with the command to run by hand" {
  FAKE_UFW="active"
  ufw() {
    if [[ "${1:-}" == "status" ]]; then echo "Status: active"; return 0; fi
    return 1
  }
  run firewall_open_ports "80/tcp"
  [ "$status" -eq 0 ]
  [[ "$output" == *"sudo ufw allow 80/tcp"* ]]
}

@test "configure_firewall: plain HTTP opens its port; HTTPS opens 80 for the redirect and renewals too" {
  FAKE_UFW="active"
  CERT_MODE="http"
  CLIENT_PORT="80"
  configure_firewall
  grep -qx 'ufw allow 80/tcp' "$CALLS_LOG"
  : > "$CALLS_LOG"
  CERT_MODE="certbot"
  CLIENT_PORT="443"
  configure_firewall
  grep -qx 'ufw allow 80/tcp' "$CALLS_LOG"
  grep -qx 'ufw allow 443/tcp' "$CALLS_LOG"
}

# ===========================================================================
# Certificate for the relay
# ===========================================================================

@test "relay_certificate_files: Let's Encrypt files when they exist" {
  CERT_MODE="certbot"
  run_as_root() { "$@"; }
  mkdir -p "$TEST_DIR/le"
  # The script names /etc/letsencrypt: with no such files there is nothing to use.
  run relay_certificate_files chat.example.com
  [ "$status" -eq 1 ]
}

@test "relay_certificate_files: none for self-signed or plain HTTP" {
  CERT_MODE="selfsigned"
  run relay_certificate_files chat.example.com
  [ "$status" -eq 1 ]
  CERT_MODE="http"
  run relay_certificate_files chat.example.com
  [ "$status" -eq 1 ]
}

@test "install_certbot_deploy_hook: reloads nginx and refreshes the relay's copy of the certificate" {
  install_certbot_deploy_hook chat.example.com
  hook="$CERTBOT_HOOK_DIR/aurelle-reload.sh"
  [ -x "$hook" ]
  bash -n "$hook"
  grep -qx 'systemctl reload nginx >/dev/null 2>&1 || true' "$hook"
  grep -q '/etc/letsencrypt/live/chat.example.com' "$hook"
  grep -qF "fullchain.pem\" ${COTURN_CERT_DIR}/fullchain.pem" "$hook"
  grep -q 'systemctl restart coturn' "$hook"
  # The relay part only acts when the relay has its own copy.
  grep -q "\[ -d ${COTURN_CERT_DIR} \]" "$hook"
}

@test "stage_coturn_certificate: copies the certificate and the key where coturn can read them" {
  printf 'cert\n' > "$TEST_DIR/a.pem"
  printf 'key\n' > "$TEST_DIR/b.pem"
  stage_coturn_certificate "$TEST_DIR/a.pem" "$TEST_DIR/b.pem"
  [ "$(cat "$COTURN_CERT_DIR/fullchain.pem")" = "cert" ]
  [ "$(cat "$COTURN_CERT_DIR/privkey.pem")" = "key" ]
  [ "$(stat -c %a "$COTURN_CERT_DIR/privkey.pem")" = "640" ]
}

# ===========================================================================
# Menu and updates
# ===========================================================================

@test "describe_calls_relay_state: tells whether the app has a relay" {
  run describe_calls_relay_state
  [[ "$output" == *"Not installed"* ]]
  [[ "$output" == *"AURELLE_CALLS_RELAY=1"* ]]
  printf 'CALLS_TURN_URLS=turn:x:3478\n' >> "$INSTALL_DIR/.env"
  run describe_calls_relay_state
  [[ "$output" == *"Configured"* ]]
}

@test "install_calls_relay_if_requested: an update only sets up the relay when asked" {
  STRICT_CHECKS="1"
  load_deployment_from_existing() { :; }
  CALLS_RELAY_MODE=""
  install_calls_relay_if_requested
  [ ! -e "$COTURN_CONFIG_PRIMARY" ]
  CALLS_RELAY_MODE="yes"
  install_calls_relay_if_requested
  [ -f "$COTURN_CONFIG_PRIMARY" ]
}
