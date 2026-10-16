#!/usr/bin/env bats

CHECK_SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/check-relay.sh"

setup() {
  TEST_DIR="$(mktemp -d)"
  mkdir -p "$TEST_DIR/bin"
  # A relay stand-in whose answer is chosen per test.
  cat << 'EOF2' > "$TEST_DIR/bin/turnutils_uclient"
#!/bin/sh
echo "$@" >> "$STUB_CALLS"
case "$STUB_MODE" in
  ok) echo "2: : start_mclient: tot_send_msgs=20, tot_recv_msgs=20" ;;
  refused) echo "0: : ERROR: Cannot complete Allocation" ;;
  closed) echo "recv: Connection refused" ;;
  silent) : ;;
esac
EOF2
  cat << 'EOF2' > "$TEST_DIR/bin/curl"
#!/bin/sh
if [ "$STUB_CLOUDFLARE" = "1" ]; then
  printf 'HTTP/1.1 301 Moved Permanently\r\nServer: cloudflare\r\nCF-RAY: 123-FRA\r\n\r\n'
else
  printf 'HTTP/1.1 404 Not Found\r\nServer: nginx\r\n\r\n'
fi
EOF2
  chmod +x "$TEST_DIR/bin/turnutils_uclient" "$TEST_DIR/bin/curl"
  export PATH="$TEST_DIR/bin:$PATH"
  export STUB_CALLS="$TEST_DIR/calls.log"
  export STUB_MODE=ok
  unset CALLS_TURN_URLS CALLS_TURN_SECRET
}

teardown() {
  rm -rf "$TEST_DIR"
}

write_env() {
  printf '%s\n' "CALLS_TURN_URLS=\"$1\"" "CALLS_TURN_SECRET=s3cret" > "$TEST_DIR/.env"
}

@test "check-relay passes when the relay answers over UDP and TCP" {
  write_env "stun:127.0.0.1:3478,turn:127.0.0.1:3478?transport=udp"
  run "$CHECK_SCRIPT" "$TEST_DIR/.env"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "ok    udp: relayed 20 packets" ]]
  [[ "$output" =~ "ok    tcp: relayed 20 packets" ]]
}

@test "check-relay asks for both transports and each address only once" {
  write_env "turn:127.0.0.1:3478,turn:127.0.0.1:3478?transport=tcp,turns:127.0.0.1:5349"
  run "$CHECK_SCRIPT" "$TEST_DIR/.env"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$STUB_CALLS")" -eq 2 ]
  grep -q -- "^-t " "$STUB_CALLS"
  [[ "$output" =~ "Skipped 1 turns:" ]]
}

@test "check-relay names a wrong secret when the allocation is refused" {
  STUB_MODE=refused
  write_env "turn:127.0.0.1:3478"
  run "$CHECK_SCRIPT" "$TEST_DIR/.env"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "refused the allocation" ]]
  [[ "$output" =~ "static-auth-secret" ]]
}

@test "check-relay says when nothing listens on the port" {
  STUB_MODE=closed
  write_env "turn:127.0.0.1:3478"
  run "$CHECK_SCRIPT" "$TEST_DIR/.env"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "coturn is not listening on udp port 3478" ]]
}

@test "check-relay says when the relay does not answer at all" {
  STUB_MODE=silent
  write_env "turn:127.0.0.1:3478"
  run "$CHECK_SCRIPT" "$TEST_DIR/.env"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no answer" ]]
}

@test "check-relay flags a relay host behind Cloudflare's proxy" {
  export STUB_CLOUDFLARE=1
  write_env "turn:127.0.0.1:3478"
  run "$CHECK_SCRIPT" "$TEST_DIR/.env"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "orange cloud" ]]
  [[ "$output" =~ "DNS only" ]]
}

@test "check-relay refuses to run without a secret" {
  printf '%s\n' "CALLS_TURN_URLS=turn:127.0.0.1:3478" > "$TEST_DIR/.env"
  run "$CHECK_SCRIPT" "$TEST_DIR/.env"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "CALLS_TURN_SECRET is not set" ]]
}

@test "check-relay reads the settings from the environment too" {
  export CALLS_TURN_URLS="turn:127.0.0.1:3478"
  export CALLS_TURN_SECRET="from-env"
  run "$CHECK_SCRIPT" "$TEST_DIR/missing.env"
  [ "$status" -eq 0 ]
}
