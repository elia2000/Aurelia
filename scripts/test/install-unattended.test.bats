#!/usr/bin/env bats
# Unattended mode of scripts/install.sh, the part that makes the one-line install work
# without a person: the command line, the AURELLE_* variables, behaviour with no
# terminal, exit codes, what stays on screen at the end.
#
# The script is sourced (see helpers/installer.bash); functions that end the program
# with `exit` run inside bats' `run`, which keeps the exit in a subshell.

load 'helpers/installer'

setup() {
  load_installer
  # Never wait: a retry loop in a test would only slow it down.
  sleep() { return 0; }
}

teardown() {
  unload_installer
}

# ===========================================================================
# Command line
# ===========================================================================

@test "parse_cli_args: --yes switches unattended mode on" {
  parse_cli_args --yes
  [ "$UNATTENDED" = "1" ]
}

@test "parse_cli_args: -y and --non-interactive mean the same" {
  parse_cli_args -y
  [ "$UNATTENDED" = "1" ]
  UNATTENDED=0 AURELLE_YES=0
  parse_cli_args --non-interactive
  [ "$UNATTENDED" = "1" ]
}

@test "parse_cli_args: no option leaves the interactive menu on" {
  parse_cli_args
  [ "$UNATTENDED" = "0" ]
}

@test "parse_cli_args: AURELLE_YES in the environment switches unattended mode on" {
  local value=""
  for value in 1 yes true TRUE On y; do
    UNATTENDED=0
    AURELLE_YES="$value"
    parse_cli_args
    [ "$UNATTENDED" = "1" ]
  done
}

@test "parse_cli_args: AURELLE_YES=0 and other words do not" {
  local value=""
  for value in 0 no false off ""; do
    UNATTENDED=0
    AURELLE_YES="$value"
    parse_cli_args
    [ "$UNATTENDED" = "0" ]
  done
}

@test "parse_cli_args: flags fill the variables that AURELLE_* would" {
  parse_cli_args --yes --domain chat.example.com --email me@example.com --tls selfsigned \
    --server-port 6001 --client-port 8443 --worker-port 8081 --ip 203.0.113.7 \
    --tls-cert /tmp/c.pem --tls-key /tmp/k.pem --action update --branch release --repo /srv/aurelle.git
  [ "$AURELLE_DOMAIN" = "chat.example.com" ]
  [ "$AURELLE_EMAIL" = "me@example.com" ]
  [ "$AURELLE_TLS" = "selfsigned" ]
  [ "$AURELLE_SERVER_PORT" = "6001" ]
  [ "$AURELLE_CLIENT_PORT" = "8443" ]
  [ "$AURELLE_WORKER_PORT" = "8081" ]
  [ "$AURELLE_PUBLIC_IP" = "203.0.113.7" ]
  [ "$AURELLE_TLS_CERT" = "/tmp/c.pem" ]
  [ "$AURELLE_TLS_KEY" = "/tmp/k.pem" ]
  [ "$AURELLE_ACTION" = "update" ]
  [ "$REPO_BRANCH" = "release" ]
  [ "$REPO_URL" = "/srv/aurelle.git" ]
}

@test "parse_cli_args: --flag=value works as well as --flag value" {
  parse_cli_args --domain=chat.example.com --email=me@example.com --branch=v1.2.3
  [ "$AURELLE_DOMAIN" = "chat.example.com" ]
  [ "$AURELLE_EMAIL" = "me@example.com" ]
  [ "$REPO_BRANCH" = "v1.2.3" ]
}

@test "parse_cli_args: a bare --calls-relay means yes, an explicit word is taken" {
  parse_cli_args --calls-relay
  [ "$AURELLE_CALLS_RELAY" = "1" ]
  parse_cli_args --calls-relay no
  [ "$AURELLE_CALLS_RELAY" = "no" ]
  parse_cli_args --calls-relay=force
  [ "$AURELLE_CALLS_RELAY" = "force" ]
  parse_cli_args --no-calls-relay
  [ "$AURELLE_CALLS_RELAY" = "0" ]
}

@test "parse_cli_args: a flag after a bare --calls-relay is not swallowed as its value" {
  parse_cli_args --calls-relay --domain chat.example.com
  [ "$AURELLE_CALLS_RELAY" = "1" ]
  [ "$AURELLE_DOMAIN" = "chat.example.com" ]
}

@test "parse_cli_args: an unknown option exits with 2 and says so" {
  run parse_cli_args --frobnicate
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unknown option: --frobnicate"* ]]
  [[ "$output" == *"--help"* ]]
}

@test "parse_cli_args: a flag that needs a value exits with 2 when it has none" {
  run parse_cli_args --domain
  [ "$status" -eq 2 ]
  [[ "$output" == *"--domain needs a value"* ]]
}

@test "parse_cli_args: a stray argument exits with 2" {
  run parse_cli_args install
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unknown option: install"* ]]
  run parse_cli_args --yes -- install
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unexpected argument: install"* ]]
}

@test "parse_cli_args: --help prints the usage and exits with 0" {
  run parse_cli_args --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: install.sh"* ]]
  [[ "$output" == *"AURELLE_YES"* ]]
  [[ "$output" == *"--calls-relay"* ]]
  [[ "$output" == *"Exit codes"* ]]
}

@test "parse_cli_args: --version only asks for the version" {
  parse_cli_args --version
  [ "$SHOW_VERSION" = "1" ]
  [ "$UNATTENDED" = "0" ]
}

@test "print_usage: documents the one-line command with the script address" {
  run print_usage
  [ "$status" -eq 0 ]
  [[ "$output" == *"curl -fsSL ${SCRIPT_REMOTE_URL} | sudo env AURELLE_YES=1"* ]]
  [[ "$output" == *"bash -s -- --yes"* ]]
}

# ===========================================================================
# Values: validation helpers
# ===========================================================================

@test "is_valid_domain_name: accepts host names" {
  is_valid_domain_name "chat.example.com"
  is_valid_domain_name "a.b-c.example.org"
  is_valid_domain_name "localhost"
  is_valid_domain_name "xn--80ak6aa92e.com"
}

@test "is_valid_domain_name: refuses what is not a host name" {
  refute is_valid_domain_name ""
  refute is_valid_domain_name "chat example.com"
  refute is_valid_domain_name "-bad.example.com"
  refute is_valid_domain_name "bad-.example.com"
  refute is_valid_domain_name "chat.example.com;rm -rf /"
  refute is_valid_domain_name 'chat.$(id).example.com'
  refute is_valid_domain_name "chat..example.com"
  refute is_valid_domain_name "$(printf 'a%.0s' {1..300}).com"
}

@test "is_valid_email: accepts addresses and refuses quotes and spaces" {
  is_valid_email "me@example.com"
  is_valid_email "first.last+tag@mail.example.org"
  refute is_valid_email "me@example"
  refute is_valid_email "me example@example.com"
  refute is_valid_email "me@@example.com"
  refute is_valid_email "'; touch /x; '@example.com"
  refute is_valid_email ""
}

@test "is_valid_ipv4 and is_private_ipv4" {
  is_valid_ipv4 "203.0.113.7"
  refute is_valid_ipv4 "256.1.1.1"
  refute is_valid_ipv4 "1.2.3"
  refute is_valid_ipv4 "a.b.c.d"
  is_private_ipv4 "10.1.2.3"
  is_private_ipv4 "172.16.0.1"
  is_private_ipv4 "172.31.255.255"
  is_private_ipv4 "192.168.1.1"
  is_private_ipv4 "127.0.0.1"
  is_private_ipv4 "169.254.1.1"
  is_private_ipv4 "100.64.0.1"
  refute is_private_ipv4 "172.32.0.1"
  refute is_private_ipv4 "100.128.0.1"
  refute is_private_ipv4 "8.8.8.8"
  refute is_private_ipv4 "203.0.113.7"
}

@test "is_truthy: the words that mean yes" {
  is_truthy 1
  is_truthy yes
  is_truthy YES
  is_truthy true
  is_truthy on
  refute is_truthy 0
  refute is_truthy no
  refute is_truthy ""
  refute is_truthy maybe
}

# ===========================================================================
# resolve_unattended_options: the answers every question gets
# ===========================================================================

@test "defaults: an IP install on plain HTTP with the usual ports" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  resolve_unattended_options
  [ "$DEPLOY_MODE" = "ip" ]
  [ "$CERT_MODE" = "http" ]
  [ "$SERVER_PORT" = "5174" ]
  [ "$CLIENT_PORT" = "80" ]
  [ "$WORKER_PORT" = "8080" ]
  [ "$DB_CLIENT" = "sqlite3" ]
  [ "$SOURCE_MODE" = "github" ]
  [ "$PUBLIC_IP" = "203.0.113.7" ]
  [ "$CERTBOT_IP_ADDRESS" = "203.0.113.7" ]
  [ "${#DOMAIN_NAMES[@]}" -eq 0 ]
}

@test "a domain gets HTTPS from Let's Encrypt on port 443" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  AURELLE_DOMAIN="Chat.Example.com"
  AURELLE_EMAIL="me@example.com"
  resolve_unattended_options
  [ "$DEPLOY_MODE" = "domain" ]
  [ "$CERT_MODE" = "certbot" ]
  [ "$CLIENT_PORT" = "443" ]
  [ "${DOMAIN_NAMES[0]}" = "chat.example.com" ]
  [ "$CERTBOT_EMAIL" = "me@example.com" ]
  [ "$NGINX_SERVER_NAME" = "chat.example.com" ]
}

@test "several domains are split, trimmed and de-duplicated" {
  AURELLE_DOMAIN=" chat.example.com , https://www.chat.example.com/ ,chat.example.com"
  resolve_unattended_options
  [ "${#DOMAIN_NAMES[@]}" -eq 2 ]
  [ "${DOMAIN_NAMES[0]}" = "chat.example.com" ]
  [ "${DOMAIN_NAMES[1]}" = "www.chat.example.com" ]
}

@test "a domain without an email still installs (Let's Encrypt accepts that)" {
  AURELLE_DOMAIN="chat.example.com"
  resolve_unattended_options
  [ "$CERT_MODE" = "certbot" ]
  [ -z "$CERTBOT_EMAIL" ]
}

@test "AURELLE_TLS=http keeps a domain on plain HTTP and port 80" {
  AURELLE_DOMAIN="chat.example.com"
  AURELLE_TLS="http"
  resolve_unattended_options
  [ "$CERT_MODE" = "http" ]
  [ "$CLIENT_PORT" = "80" ]
}

@test "AURELLE_TLS=selfsigned is taken as written" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  AURELLE_TLS="Self-Signed"
  resolve_unattended_options
  [ "$CERT_MODE" = "selfsigned" ]
  [ "$CLIENT_PORT" = "443" ]
}

@test "AURELLE_TLS=files needs both files to exist" {
  AURELLE_DOMAIN="chat.example.com"
  AURELLE_TLS="files"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_TLS_CERT"* ]]

  printf 'cert\n' > "$TEST_DIR/fullchain.pem"
  printf 'key\n' > "$TEST_DIR/privkey.pem"
  AURELLE_TLS_CERT="$TEST_DIR/fullchain.pem"
  AURELLE_TLS_KEY="$TEST_DIR/missing.pem"
  run resolve_unattended_options
  [ "$status" -eq 2 ]

  AURELLE_TLS_KEY="$TEST_DIR/privkey.pem"
  resolve_unattended_options
  [ "$CERT_MODE" = "files" ]
  [ "$MANUAL_CERT_FULLCHAIN_PATH" = "$TEST_DIR/fullchain.pem" ]
  [ "$MANUAL_CERT_PRIVKEY_PATH" = "$TEST_DIR/privkey.pem" ]
  [ "${#MANUAL_CERT_GROUP_FULLCHAIN_PATHS[@]}" -eq "${#DOMAIN_GROUPS[@]}" ]
}

@test "AURELLE_TLS=bogus is a usage error" {
  AURELLE_TLS="bogus"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_TLS must be"* ]]
}

@test "an IP certificate needs the public address and an email" {
  AURELLE_TLS="certbot"
  detect_local_ipv4() { return 0; }
  curl() { return 22; }
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_PUBLIC_IP"* ]]

  AURELLE_PUBLIC_IP="203.0.113.7"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_EMAIL"* ]]

  AURELLE_EMAIL="me@example.com"
  resolve_unattended_options
  [ "$CERT_MODE" = "certbot" ]
  [ "$NGINX_SERVER_NAME" = "203.0.113.7" ]
}

@test "ports come from the variables and are checked" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  AURELLE_SERVER_PORT="6001"
  AURELLE_CLIENT_PORT="8080"
  AURELLE_WORKER_PORT="9001"
  resolve_unattended_options
  [ "$SERVER_PORT" = "6001" ]
  [ "$CLIENT_PORT" = "8080" ]
  [ "$WORKER_PORT" = "9001" ]
}

@test "a port that is not a port is a usage error" {
  local bad=""
  for bad in abc 0 65536 -1 "80 80" 1e3; do
    AURELLE_SERVER_PORT="$bad"
    run resolve_unattended_options
    [ "$status" -eq 2 ]
    [[ "$output" == *"AURELLE_SERVER_PORT must be a port"* ]]
  done
}

@test "the media worker cannot share a port with the server or with nginx" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  AURELLE_WORKER_PORT="5174"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"media worker port"* ]]

  AURELLE_WORKER_PORT="80"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
}

@test "an invalid domain is a usage error before anything is touched" {
  local bad=""
  for bad in "chat example.com" "chat.example.com;id" '$(id).example.com' "-x.example.com"; do
    AURELLE_DOMAIN="$bad"
    run resolve_unattended_options
    [ "$status" -eq 2 ]
    [[ "$output" == *"AURELLE_DOMAIN"* ]]
  done
}

@test "an invalid email is a usage error" {
  AURELLE_EMAIL="not an email"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_EMAIL"* ]]
}

@test "an invalid public IP is a usage error" {
  AURELLE_PUBLIC_IP="999.1.1.1"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_PUBLIC_IP"* ]]
}

@test "AURELLE_DB=postgres with a URL uses it and notices SSL" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  AURELLE_DB="postgres"
  AURELLE_POSTGRES_URL="postgresql://user:pass@db.example.com:5432/aurelle?sslmode=require"
  resolve_unattended_options
  [ "$DB_CLIENT" = "postgres" ]
  [ "$POSTGRES_URL" = "$AURELLE_POSTGRES_URL" ]
  [ "$POSTGRES_SSL" = "true" ]
}

@test "AURELLE_DB=postgres without a URL gets a generated password, not the default" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  AURELLE_DB="postgres"
  resolve_unattended_options
  [ "$DB_CLIENT" = "postgres" ]
  [ -z "$POSTGRES_URL" ]
  [ "${#POSTGRES_PASSWORD}" -eq 32 ]
  [ "$POSTGRES_PASSWORD" != "$DEFAULT_POSTGRES_PASSWORD" ]
}

@test "AURELLE_DB: a wrong value or a wrong URL is a usage error" {
  AURELLE_DB="mysql"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_DB must be"* ]]

  AURELLE_DB="postgres"
  AURELLE_POSTGRES_URL="mysql://x"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_POSTGRES_URL"* ]]
}

@test "the owner name and password go together" {
  AURELLE_PUBLIC_IP="203.0.113.7"
  AURELLE_OWNER_USERNAME="admin"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_OWNER_USERNAME and AURELLE_OWNER_PASSWORD go together"* ]]

  AURELLE_OWNER_PASSWORD="S3cret-pass"
  resolve_unattended_options
}

@test "AURELLE_RESTORE_BACKUP must be a file that exists" {
  AURELLE_RESTORE_BACKUP="$TEST_DIR/missing.db"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_RESTORE_BACKUP"* ]]

  : > "$TEST_DIR/backup.db"
  AURELLE_RESTORE_BACKUP="$TEST_DIR/backup.db"
  AURELLE_PUBLIC_IP="203.0.113.7"
  resolve_unattended_options
  [ "$DB_BACKUP_PATH" = "$TEST_DIR/backup.db" ]
}

@test "resolve_calls_relay_mode: 1/0/force and the empty default" {
  AURELLE_CALLS_RELAY=""
  resolve_calls_relay_mode
  [ -z "$CALLS_RELAY_MODE" ]
  local value=""
  for value in 1 yes true ON; do
    AURELLE_CALLS_RELAY="$value"
    resolve_calls_relay_mode
    [ "$CALLS_RELAY_MODE" = "yes" ]
  done
  for value in 0 no false off; do
    AURELLE_CALLS_RELAY="$value"
    resolve_calls_relay_mode
    [ "$CALLS_RELAY_MODE" = "no" ]
  done
  AURELLE_CALLS_RELAY="force"
  resolve_calls_relay_mode
  [ "$CALLS_RELAY_MODE" = "force" ]
}

@test "resolve_calls_relay_mode: anything else is a usage error" {
  AURELLE_CALLS_RELAY="sometimes"
  run resolve_calls_relay_mode
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_CALLS_RELAY must be"* ]]
}

# ===========================================================================
# Questions in unattended mode
# ===========================================================================

@test "prompt_read: unattended it asks nothing and answers empty" {
  UNATTENDED=1
  local answer="something"
  prompt_read "Port: " answer
  [ -z "$answer" ]
}

@test "prompt_yes_no: unattended it answers with the default" {
  UNATTENDED=1
  [ "$(prompt_yes_no "Delete everything?" "no")" = "no" ]
  [ "$(prompt_yes_no "Install the relay?" "yes")" = "yes" ]
}

@test "prompt_non_empty and prompt_secret: unattended they fail and name the variable" {
  UNATTENDED=1
  run prompt_non_empty "Nickname"
  [ "$status" -eq 1 ]
  [[ "$output" == *"AURELLE_*"* ]]
  run prompt_secret "Password"
  [ "$status" -eq 1 ]
}

@test "prompt_secret_optional: unattended it gives an empty value" {
  UNATTENDED=1
  run prompt_secret_optional "Token"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "press_enter_to_continue: unattended it does not wait" {
  UNATTENDED=1
  run press_enter_to_continue
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "init_prompt_io: unattended it never opens the terminal" {
  UNATTENDED=1
  run bash -c '
    source <(sed -e "s/trap [^;]* EXIT/:/" -e "/^main[[:space:]\"]/d" "$1") 2>/dev/null
    UNATTENDED=1
    init_prompt_io
    printf "fd=%s out=%s\n" "$PROMPT_FD" "$PROMPT_FD_OUT"
    IFS= read -r -u "$PROMPT_FD" line && echo "read:$line" || echo "eof"
  ' _ "$INSTALL_SCRIPT" < /dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"fd=3 out=2"* ]]
  [[ "$output" == *"eof"* ]]
}

# ===========================================================================
# No terminal at all (ssh host 'curl ... | bash', CI, cron)
# ===========================================================================

@test "no terminal: the interactive script stops at once with exit code 2 and says what to do" {
  command -v setsid >/dev/null || skip "setsid is not installed"
  run_piped_without_terminal
  [ "$status" -eq 2 ]
  [[ "$output" == *"No terminal is available"* ]]
  [[ "$output" == *"AURELLE_YES=1"* ]]
  [[ "$output" == *"ssh -t"* ]]
  # It must not have started the menu, and above all must not loop on it.
  [[ "$output" != *"Deploy Menu"* ]]
  [ "${#lines[@]}" -lt 30 ]
}

@test "no terminal: --help still works and exits with 0" {
  command -v setsid >/dev/null || skip "setsid is not installed"
  run_piped_without_terminal --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: install.sh"* ]]
}

@test "no terminal: --version prints the version and exits with 0" {
  command -v setsid >/dev/null || skip "setsid is not installed"
  run_piped_without_terminal --version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$output" == "0.0.0" ]]
}

@test "no terminal: a wrong option exits with 2 before anything is changed" {
  command -v setsid >/dev/null || skip "setsid is not installed"
  run_piped_without_terminal --yes --nonsense
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unknown option: --nonsense"* ]]
}

@test "no terminal: the script run from a file behaves the same" {
  command -v setsid >/dev/null || skip "setsid is not installed"
  run bash -c 'setsid -w bash "$1" < /dev/null' _ "$INSTALL_SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"No terminal is available"* ]]
}

@test "the program runs main only on its last line, so a cut download does nothing" {
  [ "$(tail -n 1 "$INSTALL_SCRIPT")" = 'main "$@"' ]
  [ "$(grep -c '^main "\$@"$' "$INSTALL_SCRIPT")" -eq 1 ]
}

# ===========================================================================
# The screen at the end of a run
# ===========================================================================

call_exit_handler() {
  ( exit "$1" )
  handle_exit
}

@test "clear_screen: unattended it never clears" {
  UNATTENDED=1
  clear() { printf 'CLEARED\n'; }
  run clear_screen
  [ "$status" -eq 0 ]
  [[ "$output" != *"CLEARED"* ]]
}

# clear_screen only clears a real terminal, so these two run it on a pseudo terminal
# (script(1)): the interactive menu clears, an unattended run must not.
run_clear_screen_on_terminal() {
  cat > "$TEST_DIR/clear-on-terminal.sh" <<'EOF2'
#!/bin/bash
source <(sed -e "s/trap '[^']*' INT TERM/:/g" -e "s/trap '[^']*' EXIT/:/g" -e '/^main[[:space:]"]/d' "$1")
clear() { printf 'CLEARED\n'; }
UNATTENDED="$2"
TERM=xterm
clear_screen
printf 'END\n'
EOF2
  run script -qec "bash $TEST_DIR/clear-on-terminal.sh $INSTALL_SCRIPT $1" /dev/null
}

@test "clear_screen: on a terminal the interactive menu clears the screen" {
  command -v script >/dev/null || skip "script(1) is not installed"
  run_clear_screen_on_terminal 0
  [[ "$output" == *"CLEARED"* ]]
  [[ "$output" == *"END"* ]]
}

@test "clear_screen: on a terminal an unattended run still never clears" {
  command -v script >/dev/null || skip "script(1) is not installed"
  run_clear_screen_on_terminal 1
  [[ "$output" != *"CLEARED"* ]]
  [[ "$output" == *"END"* ]]
}

@test "clear_screen: it does not clear when the output is not a terminal" {
  clear() { printf 'CLEARED\n'; }
  run clear_screen
  [ "$status" -eq 0 ]
  [[ "$output" != *"CLEARED"* ]]
}

@test "handle_exit: unattended success leaves the screen and the summary alone" {
  UNATTENDED=1
  clear() { printf 'CLEARED\n'; }
  INSTALL_SUMMARY_TITLE="Aurelle Installation Complete"
  INSTALL_SUMMARY_LINES=("Visit: http://203.0.113.7")
  run call_exit_handler 0
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "handle_exit: the menu's last summary is shown again after the screen is cleared" {
  clear_screen() { printf 'CLEARED\n'; }
  INSTALL_SUMMARY_TITLE="Aurelle Installation Complete"
  INSTALL_SUMMARY_LINES=("Visit: http://203.0.113.7" "" "Logs:")
  run call_exit_handler 0
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "CLEARED" ]]
  [[ "$output" == *"Aurelle Installation Complete"* ]]
  [[ "$output" == *"Visit: http://203.0.113.7"* ]]
}

@test "handle_exit: showing the summary again does not write it into the log twice" {
  clear_screen() { :; }
  INSTALL_SUMMARY_TITLE="Aurelle Installation Complete"
  INSTALL_SUMMARY_LINES=("Visit: http://203.0.113.7")
  : > "$LOG_FILE"
  call_exit_handler 0 > /dev/null
  [ ! -s "$LOG_FILE" ]
}

@test "handle_exit: without a summary nothing is printed" {
  clear_screen() { :; }
  run call_exit_handler 0
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "handle_exit: SKIP_CLEAR_ON_EXIT keeps --help and --version output on screen" {
  clear_screen() { printf 'CLEARED\n'; }
  SKIP_CLEAR_ON_EXIT=1
  run call_exit_handler 0
  [[ "$output" != *"CLEARED"* ]]
}

@test "handle_exit: a failure says the code and where the log is" {
  rm -f "$LOG_FILE"
  : > "$LOG_FILE"
  run call_exit_handler 1
  [[ "$output" == *"Script exited with code 1"* ]]
  [[ "$output" == *"$LOG_FILE"* ]]
}

@test "handle_exit: an unattended failure says the command can simply be run again" {
  UNATTENDED=1
  run call_exit_handler 1
  [[ "$output" == *"Script exited with code 1"* ]]
  [[ "$output" == *"run the same command again"* ]]
}

@test "handle_exit: it releases the install lock" {
  acquire_install_lock
  [ -d "$INSTALL_LOCK_PATH" ]
  call_exit_handler 0 > /dev/null
  [ ! -d "$INSTALL_LOCK_PATH" ]
}

@test "the install summary names the URL, the first admin, the logs and the update command" {
  UNATTENDED=1
  DEPLOY_MODE="domain"
  DOMAIN_NAMES=("chat.example.com")
  CERT_MODE="certbot"
  CLIENT_PORT="443"
  CALLS_RELAY_SUMMARY="coturn works"
  run show_deployment_success_frame install
  [ "$status" -eq 0 ]
  [[ "$output" == *"Visit: https://chat.example.com"* ]]
  [[ "$output" == *"First admin account"* ]]
  [[ "$output" == *"ADMIN_API_TOKEN"* ]]
  [[ "$output" == *"coturn works"* ]]
  [[ "$output" == *"Installer: ${LOG_FILE}"* ]]
  [[ "$output" == *"journalctl -u songbird"* ]]
  [[ "$output" == *"songbird-deploy --yes"* ]]
}

@test "the install summary says when the owner account was created" {
  UNATTENDED=1
  DEPLOY_MODE="ip"
  PUBLIC_IP="203.0.113.7"
  CERT_MODE="http"
  CLIENT_PORT="80"
  OWNER_CREATED="admin"
  run show_deployment_success_frame install
  [[ "$output" == *"Visit: http://203.0.113.7"* ]]
  [[ "$output" == *"The owner account admin was created"* ]]
  [[ "$output" != *"register an account"* ]]
}

@test "the install summary does not send an HTTP site to the browser claim, which refuses HTTP" {
  UNATTENDED=1
  DEPLOY_MODE="ip"
  PUBLIC_IP="203.0.113.7"
  CERT_MODE="http"
  CLIENT_PORT="80"
  run show_deployment_success_frame install
  [[ "$output" == *"plain HTTP"* ]]
  [[ "$output" == *"Manage Database, Create user"* ]]
  [[ "$output" != *"Read the token with"* ]]
}

@test "the install summary points an HTTPS site at the token claim" {
  UNATTENDED=1
  DEPLOY_MODE="domain"
  DOMAIN_NAMES=("chat.example.com")
  CERT_MODE="certbot"
  CLIENT_PORT="443"
  run show_deployment_success_frame install
  [[ "$output" == *"Read the token with"* ]]
  [[ "$output" != *"plain HTTP"* ]]
}

@test "the install summary does not claim HTTPS when the certificate failed" {
  UNATTENDED=1
  DEPLOY_MODE="domain"
  DOMAIN_NAMES=("chat.example.com")
  CERT_MODE="certbot"
  CLIENT_PORT="443"
  TLS_FAILED="1"
  run show_deployment_success_frame install
  [[ "$output" == *"Visit: http://chat.example.com"* ]]
  [[ "$output" != *"Visit: https://"* ]]
  [[ "$output" == *"HTTPS is NOT active"* ]]
}

@test "site_visit_lines: ports other than the default are written out" {
  DEPLOY_MODE="ip"
  PUBLIC_IP="203.0.113.7"
  CERT_MODE="http"
  CLIENT_PORT="8081"
  run site_visit_lines
  [ "$output" = "Visit: http://203.0.113.7:8081" ]
  CERT_MODE="selfsigned"
  CLIENT_PORT="8443"
  run site_visit_lines
  [[ "$output" == *"Visit: https://203.0.113.7:8443"* ]]
  [[ "$output" == *"Self-signed"* ]]
}

# ===========================================================================
# Which action an unattended run takes
# ===========================================================================

stub_actions() {
  ACTIONS_LOG="$TEST_DIR/actions.log"
  : > "$ACTIONS_LOG"
  install_songbird()          { echo "install" >> "$ACTIONS_LOG"; }
  update_songbird()           { echo "update" >> "$ACTIONS_LOG"; }
  repair_installation()       { echo "repair" >> "$ACTIONS_LOG"; }
  resolve_unattended_options(){ echo "resolve" >> "$ACTIONS_LOG"; }
  resolve_unattended_update_options() { echo "resolve-update" >> "$ACTIONS_LOG"; }
  install_calls_relay_if_requested() { echo "relay-if-requested" >> "$ACTIONS_LOG"; }
  show_deployment_success_frame() { echo "frame:$1" >> "$ACTIONS_LOG"; }
  acquire_install_lock()      { return 0; }
}

@test "run_unattended: a host without an installation gets an install" {
  stub_actions
  installation_is_complete() { return 1; }
  run run_unattended
  [ "$status" -eq 0 ]
  grep -qx 'resolve' "$ACTIONS_LOG"
  grep -qx 'install' "$ACTIONS_LOG"
  refute grep -qx 'update' "$ACTIONS_LOG"
}

@test "run_unattended: an installed host with a newer version is updated, not reinstalled" {
  stub_actions
  installation_is_complete() { return 0; }
  unattended_request_differs_from_installed() { return 1; }
  update_is_needed() { UPDATE_REASON="newer"; return 0; }
  run run_unattended
  [ "$status" -eq 0 ]
  grep -qx 'update' "$ACTIONS_LOG"
  refute grep -qx 'install' "$ACTIONS_LOG"
}

@test "run_unattended: an installed host at the newest version changes nothing" {
  stub_actions
  installation_is_complete() { return 0; }
  unattended_request_differs_from_installed() { return 1; }
  update_is_needed() { return 1; }
  run run_unattended
  [ "$status" -eq 0 ]
  grep -qx 'frame:current' "$ACTIONS_LOG"
  refute grep -qx 'update' "$ACTIONS_LOG"
  refute grep -qx 'install' "$ACTIONS_LOG"
}

@test "run_unattended: an installation that does not answer is repaired" {
  stub_actions
  installation_is_complete() { return 0; }
  unattended_request_differs_from_installed() { return 1; }
  update_is_needed() { UPDATE_REASON="down"; return 0; }
  run run_unattended
  [ "$status" -eq 0 ]
  grep -qx 'repair' "$ACTIONS_LOG"
  refute grep -qx 'update' "$ACTIONS_LOG"
}

@test "run_unattended: when the source cannot be reached it fails and stops nothing" {
  stub_actions
  installation_is_complete() { return 0; }
  unattended_request_differs_from_installed() { return 1; }
  update_is_needed() { return 2; }
  run run_unattended
  [ "$status" -eq 1 ]
  refute grep -qx 'update' "$ACTIONS_LOG"
  refute grep -qx 'repair' "$ACTIONS_LOG"
}

@test "run_unattended: asking for a different setup on an installed host reconfigures it" {
  stub_actions
  installation_is_complete() { return 0; }
  unattended_request_differs_from_installed() { return 0; }
  run run_unattended
  [ "$status" -eq 0 ]
  grep -qx 'install' "$ACTIONS_LOG"
  # The requested setup is already in the variables: it must not be overwritten.
  refute grep -qx 'resolve' "$ACTIONS_LOG"
}

@test "run_unattended: AURELLE_ACTION=install installs even where Aurelle is installed" {
  stub_actions
  installation_is_complete() { return 0; }
  AURELLE_ACTION="install"
  run run_unattended
  [ "$status" -eq 0 ]
  grep -qx 'install' "$ACTIONS_LOG"
}

@test "run_unattended: AURELLE_ACTION=update without an installation fails" {
  stub_actions
  installation_is_complete() { return 1; }
  AURELLE_ACTION="update"
  run run_unattended
  [ "$status" -eq 1 ]
  [[ "$output" == *"no complete installation"* ]]
  refute grep -qx 'install' "$ACTIONS_LOG"
}

@test "run_unattended: an unknown AURELLE_ACTION is a usage error" {
  stub_actions
  AURELLE_ACTION="reinstall"
  run run_unattended
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_ACTION must be"* ]]
}

@test "run_unattended: a failed install is a non-zero exit" {
  stub_actions
  installation_is_complete() { return 1; }
  install_songbird() { return 1; }
  run run_unattended
  [ "$status" -eq 1 ]
}

@test "run_unattended: installed but without HTTPS is exit code 3" {
  stub_actions
  installation_is_complete() { return 1; }
  install_songbird() { TLS_FAILED="1"; }
  run run_unattended
  [ "$status" -eq 3 ]
  [[ "$output" == *"TLS certificate could not be issued"* ]]
}

# ===========================================================================
# An installation that exists: what it is, and whether this run asks for another
# ===========================================================================

write_installed_site() {
  local names="$1"
  local certificate="${2:-}"
  mkdir -p "$INSTALL_DIR"
  printf 'SERVER_PORT=5174\nCLIENT_PORT=%s\nWORKER_PORT=8080\nDB_CLIENT=sqlite3\n' "${3:-80}" > "$INSTALL_DIR/.env"
  {
    printf 'server {\n  listen 80;\n  server_name %s;\n' "$names"
    [[ -n "$certificate" ]] && printf '  ssl_certificate %s;\n' "$certificate"
    printf '}\n'
  } > "$NGINX_SITE_FILE"
}

@test "load_deployment_from_existing: reads a domain with a Let's Encrypt certificate" {
  write_installed_site "chat.example.com www.chat.example.com" "/etc/letsencrypt/live/chat.example.com/fullchain.pem" 443
  load_deployment_from_existing
  [ "$DEPLOY_MODE" = "domain" ]
  [ "$CERT_MODE" = "certbot" ]
  [ "${DOMAIN_NAMES[0]}" = "chat.example.com" ]
  [ "${DOMAIN_NAMES[1]}" = "www.chat.example.com" ]
  [ "$CLIENT_PORT" = "443" ]
}

@test "load_deployment_from_existing: reads an IP site on plain HTTP" {
  write_installed_site "203.0.113.7"
  load_deployment_from_existing
  [ "$DEPLOY_MODE" = "ip" ]
  [ "$CERT_MODE" = "http" ]
  [ "$CERTBOT_IP_ADDRESS" = "203.0.113.7" ]
}

@test "load_deployment_from_existing: own certificate files are files mode" {
  write_installed_site "chat.example.com" "/etc/ssl/songbird/chat.example.com/fullchain.pem" 443
  load_deployment_from_existing
  [ "$CERT_MODE" = "files" ]
}

@test "unattended_request_differs_from_installed: no setup flags never differ" {
  write_installed_site "chat.example.com" "/etc/letsencrypt/live/chat.example.com/fullchain.pem" 443
  run unattended_request_differs_from_installed
  [ "$status" -eq 1 ]
}

@test "unattended_request_differs_from_installed: the same domain is not a difference" {
  write_installed_site "chat.example.com" "/etc/letsencrypt/live/chat.example.com/fullchain.pem" 443
  AURELLE_DOMAIN="chat.example.com"
  AURELLE_PUBLIC_IP="203.0.113.7"
  run unattended_request_differs_from_installed
  [ "$status" -eq 1 ]
}

@test "unattended_request_differs_from_installed: another domain is" {
  write_installed_site "chat.example.com" "/etc/letsencrypt/live/chat.example.com/fullchain.pem" 443
  AURELLE_DOMAIN="other.example.com"
  AURELLE_PUBLIC_IP="203.0.113.7"
  unattended_request_differs_from_installed
  [ "${DOMAIN_NAMES[0]}" = "other.example.com" ]
}

@test "unattended_request_differs_from_installed: HTTPS asked for an HTTP site is" {
  write_installed_site "203.0.113.7"
  AURELLE_DOMAIN="chat.example.com"
  AURELLE_PUBLIC_IP="203.0.113.7"
  unattended_request_differs_from_installed
  [ "$CERT_MODE" = "certbot" ]
}

@test "unattended_request_differs_from_installed: another port is" {
  write_installed_site "203.0.113.7"
  AURELLE_CLIENT_PORT="8081"
  AURELLE_PUBLIC_IP="203.0.113.7"
  unattended_request_differs_from_installed
  [ "$CLIENT_PORT" = "8081" ]
}

# ===========================================================================
# update_is_needed: ask the source before anything is stopped
# ===========================================================================

@test "update_is_needed: a source that cannot be reached is neither yes nor no" {
  run_with_retries() { return 1; }
  run update_is_needed
  [ "$status" -eq 2 ]
  [[ "$output" == *"Nothing was changed"* ]]
}

@test "update_is_needed: a newer commit is a yes" {
  run_with_retries() { return 0; }
  repo_target_ref() { printf 'main'; }
  run_in_install_dir_output() { printf 'aaa111'; }
  repo_remote_commit() { printf 'bbb222'; }
  update_is_needed
  [ "$UPDATE_REASON" = "newer" ]
}

@test "update_is_needed: the same commit, a build and an answering app is a no" {
  run_with_retries() { return 0; }
  repo_target_ref() { printf 'main'; }
  run_in_install_dir_output() { printf 'aaa111'; }
  repo_remote_commit() { printf 'aaa111'; }
  path_exists_as_root() { return 0; }
  songbird_healthcheck_responds() { return 0; }
  run update_is_needed
  [ "$status" -eq 1 ]
}

@test "update_is_needed: the same commit without a client build is a repair" {
  run_with_retries() { return 0; }
  repo_target_ref() { printf 'main'; }
  run_in_install_dir_output() { printf 'aaa111'; }
  repo_remote_commit() { printf 'aaa111'; }
  path_exists_as_root() { return 1; }
  update_is_needed
  [ "$UPDATE_REASON" = "build" ]
}

@test "update_is_needed: the same commit with an app that does not answer is a repair" {
  run_with_retries() { return 0; }
  repo_target_ref() { printf 'main'; }
  run_in_install_dir_output() { printf 'aaa111'; }
  repo_remote_commit() { printf 'aaa111'; }
  path_exists_as_root() { return 0; }
  songbird_healthcheck_responds() { return 1; }
  update_is_needed
  [ "$UPDATE_REASON" = "down" ]
}

# ===========================================================================
# Install lock
# ===========================================================================

@test "acquire_install_lock: a second installer is refused while the first runs" {
  acquire_install_lock
  [ "$INSTALL_LOCK_HELD" = "1" ]
  [ -d "$INSTALL_LOCK_PATH" ]
  # The same process may ask again (the menu calls install and update one after the other).
  acquire_install_lock
  # Another process: pretend the lock belongs to a live one.
  INSTALL_LOCK_HELD="0"
  printf '1\n' > "$INSTALL_LOCK_PATH/pid"
  run acquire_install_lock
  [ "$status" -eq 1 ]
  [[ "$output" == *"already running"* ]]
}

@test "acquire_install_lock: the lock of a process that is gone is taken over" {
  mkdir -p "$INSTALL_LOCK_PATH"
  printf '99999999\n' > "$INSTALL_LOCK_PATH/pid"
  acquire_install_lock
  [ "$INSTALL_LOCK_HELD" = "1" ]
  [ "$(cat "$INSTALL_LOCK_PATH/pid")" = "$$" ]
}

@test "release_install_lock: removes the lock and only a lock this process holds" {
  mkdir -p "$INSTALL_LOCK_PATH"
  release_install_lock
  [ -d "$INSTALL_LOCK_PATH" ]
  acquire_install_lock
  release_install_lock
  [ ! -d "$INSTALL_LOCK_PATH" ]
}

# ===========================================================================
# The install log
# ===========================================================================

@test "redact_secrets: keys, tokens, passwords and secrets never reach the log" {
  local line="Running: sed -i s|^ADMIN_API_TOKEN=.*|ADMIN_API_TOKEN=abc123def| /opt/songbird/.env"
  local redacted=""
  redacted="$(printf '%s\n' "$line" | redact_secrets)"
  [[ "$redacted" != *"abc123def"* ]]
  [[ "$redacted" == *"ADMIN_API_TOKEN=<redacted>"* ]]
  redacted="$(printf '%s\n' "docker run -e WEBHOOK_SECRET=s3cr3t -e APP_ENV=production" | redact_secrets)"
  [[ "$redacted" == *"WEBHOOK_SECRET=<redacted>"* ]]
  [[ "$redacted" == *"APP_ENV=production"* ]]
}

@test "log_to_file: values of secret settings are replaced" {
  log_to_file "CALLS_TURN_SECRET=0123456789abcdef"
  log_to_file "POSTGRES_PASSWORD='hunter2' next"
  log_to_file "VAPID_PRIVATE_KEY=zzzzzzzz"
  log_to_file "STORAGE_ENCRYPTION_KEY=ffff0000"
  log_to_file "psql --password hunter3 mydb"
  log_to_file "SERVER_PORT=5174"
  run cat "$LOG_FILE"
  [[ "$output" != *"0123456789abcdef"* ]]
  [[ "$output" != *"hunter2"* ]]
  [[ "$output" != *"zzzzzzzz"* ]]
  [[ "$output" != *"ffff0000"* ]]
  [[ "$output" != *"hunter3"* ]]
  [[ "$output" == *"CALLS_TURN_SECRET=<redacted>"* ]]
  [[ "$output" == *"SERVER_PORT=5174"* ]]
}

@test "log_to_file: lines written before the log directory exists are kept and flushed" {
  LOG_FILE="$TEST_DIR/logs/install.log"
  log "first line"
  warn "second line"
  [ ! -e "$LOG_FILE" ]
  [ "${#PENDING_LOG_LINES[@]}" -eq 2 ]
  ensure_log_dir
  [ "${#PENDING_LOG_LINES[@]}" -eq 0 ]
  run cat "$LOG_FILE"
  [[ "$output" == *"first line"* ]]
  [[ "$output" == *"WARNING: second line"* ]]
}

@test "ensure_log_dir: the log is private to its owner" {
  LOG_FILE="$TEST_DIR/logs/install.log"
  ensure_log_dir
  [ "$(stat -c %a "$LOG_FILE")" = "600" ]
  [ "$(stat -c %a "$(dirname "$LOG_FILE")")" = "750" ]
}

@test "usage_fail: it exits with 2 and records the message" {
  run usage_fail "AURELLE_X is wrong"
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_X is wrong"* ]]
  grep -q "AURELLE_X is wrong" "$LOG_FILE"
}
