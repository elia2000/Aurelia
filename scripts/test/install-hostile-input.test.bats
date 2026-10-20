#!/usr/bin/env bats
# Hostile and malformed values in what scripts/install.sh takes from its environment
# and command line (AURELLE_*, REPO_BRANCH, REPO_URL). A value must either be refused
# with a clear message (exit code 2, before anything is changed) or end up in the
# generated files as plain text; it must never be run as a command or add lines to a
# file. The installer runs as root, so a command that slips through runs as root.
#
# The script is sourced (see helpers/installer.bash). A "canary" file path is put into
# each hostile value: if the file exists afterwards, the value was run.

load 'helpers/installer'

setup() {
  load_installer
  sleep() { return 0; }
  # No network: resolve_unattended_options asks for the public address.
  AURELLE_PUBLIC_IP="203.0.113.7"
  CANARY="$TEST_DIR/canary"
  # run_silent logs and runs; keep the real one, it is what the installer uses.
  UNATTENDED=1
}

teardown() {
  unload_installer
}

# ===========================================================================
# REPO_BRANCH: it is placed inside shell strings (git commands run by bash -lc)
# ===========================================================================

@test "REPO_BRANCH: branch and tag names are accepted" {
  local name=""
  for name in main develop release/1.2 v1.2.3 feature_x-1.0 hotfix/a.b "release-2026.10"; do
    is_valid_git_ref_name "$name"
  done
}

@test "REPO_BRANCH: quotes, spaces, substitutions, options and odd git syntax are refused" {
  local name=""
  for name in "x'; touch ${CANARY}; '" 'a b' 'a$(id)' 'a`id`' 'a;id' 'a|id' 'a&id' 'a"b' '-x' '--upload-pack=x' \
              'a..b' 'a//b' '/a' 'a/' 'a.lock' 'a@{b' 'a~1' 'a^' 'a:b' 'a?b' 'a*b' 'a[b' 'a\b' "a"$'\n'"b" ""; do
    refute is_valid_git_ref_name "$name"
  done
}

@test "REPO_BRANCH: --branch with a hostile name exits with 2 and runs nothing" {
  run parse_cli_args --yes --branch "x'; touch ${CANARY}; '"
  [ "$status" -eq 2 ]
  [[ "$output" == *"branch"* ]]
  [ ! -e "$CANARY" ]
}

@test "REPO_BRANCH: the same value from the environment exits with 2 as well" {
  REPO_BRANCH="x'; touch ${CANARY}; '"
  run parse_cli_args --yes
  [ "$status" -eq 2 ]
  [ ! -e "$CANARY" ]
}

@test "REPO_BRANCH: a good name passes parse_cli_args" {
  REPO_BRANCH="release/1.2"
  parse_cli_args --yes
  [ "$REPO_BRANCH" = "release/1.2" ]
}

@test "REPO_URL: an address that would be read as a git option is refused" {
  run parse_cli_args --yes --repo "--upload-pack=touch ${CANARY}"
  [ "$status" -eq 2 ]
  [ ! -e "$CANARY" ]
}

@test "clone_repo: the address and the target are passed after -- so neither can be an option" {
  local record="$TEST_DIR/git-args"
  run_as_root() {
    [[ "$1" == "test" ]] && return 1
    [[ "$1" == "mkdir" ]] && return 0
    printf '%s\n' "$*" >> "$record"
    return 0
  }
  run_with_retries() { "$@"; }
  REPO_URL="https://example.test/r.git"
  INSTALL_DIR="$TEST_DIR/fresh"
  clone_repo
  grep -qF -- 'git clone -- https://example.test/r.git' "$record"
}

# ===========================================================================
# AURELLE_EMAIL: used in a systemd unit, in .env and in sed
# ===========================================================================

@test "is_valid_email: plain addresses only" {
  is_valid_email "me@example.com"
  is_valid_email "first.last+tag@mail.example.org"
  is_valid_email "under_score-dash@sub-domain.example.co"
}

@test "is_valid_email: shell, sed, systemd and .env metacharacters are refused" {
  local bad=""
  for bad in 'a;b@example.com' 'a|b@example.com' 'a&b@example.com' 'a$HOME@example.com' 'a`id`@example.com' \
             'a#b@example.com' 'a%b@example.com' 'a<b>@example.com' 'a(b)@example.com' 'a{b}@example.com' \
             'a*b@example.com' 'a?b@example.com' 'a!b@example.com' 'a=b@example.com' 'a\b@example.com' \
             "a'b@example.com" 'a"b@example.com' '-x@example.com' '--email@example.com' 'a@-example.com' \
             'a@example.com;id' 'a@exa mple.com' 'a@example.c' "a@example.com"$'\n'"X=1" ""; do
    refute is_valid_email "$bad"
  done
}

@test "AURELLE_EMAIL: a hostile address is a usage error" {
  local bad=""
  for bad in "a;touch ${CANARY}@example.com" 'a$HOME@example.com' 'a|e@example.com' 'a#b@example.com'; do
    AURELLE_EMAIL="$bad"
    run resolve_unattended_options
    [ "$status" -eq 2 ]
    [[ "$output" == *"AURELLE_EMAIL"* ]]
  done
  [ ! -e "$CANARY" ]
}

# ===========================================================================
# replace_env_value: the value is data, whatever it holds
# ===========================================================================

@test "replace_env_value: | & \\ and / in a value are written as they are" {
  local env_file="$TEST_DIR/.env"
  printf 'KEY=old\nOTHER=keep\n' > "$env_file"
  replace_env_value "$env_file" KEY 'a|b&c\d/e'
  [ "$(grep '^KEY=' "$env_file")" = 'KEY=a|b&c\d/e' ]
  [ "$(grep -c '^KEY=' "$env_file")" -eq 1 ]
  [ "$(grep '^OTHER=' "$env_file")" = 'OTHER=keep' ]
}

@test "replace_env_value: a new key is appended once, a quote in the value cannot end the command" {
  local env_file="$TEST_DIR/.env"
  printf 'KEY=old\n' > "$env_file"
  replace_env_value "$env_file" NEWKEY "x'; touch ${CANARY}; echo '"
  [ ! -e "$CANARY" ]
  [ "$(grep -c '^NEWKEY=' "$env_file")" -eq 1 ]
  [ "$(grep '^NEWKEY=' "$env_file")" = "NEWKEY=x'; touch ${CANARY}; echo '" ]
}

@test "replace_env_value: a value with a line break is refused, the file stays as it was" {
  local env_file="$TEST_DIR/.env"
  printf 'KEY=old\n' > "$env_file"
  run replace_env_value "$env_file" KEY $'x\nADMIN_API_TOKEN=evil'
  [ "$status" -ne 0 ]
  [ "$(cat "$env_file")" = "KEY=old" ]
}

# ===========================================================================
# AURELLE_POSTGRES_URL: written into .env
# ===========================================================================

@test "AURELLE_POSTGRES_URL: a line break, space, quote, backtick or backslash is a usage error" {
  AURELLE_DB="postgres"
  local bad=""
  for bad in $'postgres://u:p@h/db\nEOF\ntouch '"${CANARY}" "postgres://u:p@h/db x=1" "postgres://u:p'@h/db" \
             'postgres://u:p"@h/db' 'postgres://u:`id`@h/db' 'postgres://u:p\@h/db' $'postgres://u:p@h/db\r\nX=1'; do
    AURELLE_POSTGRES_URL="$bad"
    run resolve_unattended_options
    [ "$status" -eq 2 ]
    [[ "$output" == *"AURELLE_POSTGRES_URL"* ]]
  done
  [ ! -e "$CANARY" ]
}

@test "AURELLE_POSTGRES_URL: a usual URL with encoded characters and query is accepted" {
  AURELLE_DB="postgres"
  AURELLE_POSTGRES_URL="postgresql://user:p%40ss%23w0rd@db.example.test:5432/app?sslmode=require"
  resolve_unattended_options
  [ "$POSTGRES_URL" = "$AURELLE_POSTGRES_URL" ]
  [ "$POSTGRES_SSL" = "true" ]
}

@test "write_env_fallback: a value with a line break and EOF is refused and runs nothing" {
  SERVER_PORT=5174 CLIENT_PORT=80 WORKER_PORT=8080
  POSTGRES_URL=$'postgres://u:p@h/db\nEOF\ntouch '"${CANARY}"$'\ncat <<\'EOF\''
  rm -f "$INSTALL_DIR/.env"
  run write_env_fallback "$INSTALL_DIR/.env"
  [ "$status" -ne 0 ]
  [ ! -e "$CANARY" ]
  [ ! -e "$INSTALL_DIR/.env" ]
}

@test "write_env_fallback: quotes, dollar signs and backticks in a value are written as they are" {
  SERVER_PORT=5174 CLIENT_PORT=80 WORKER_PORT=8080
  POSTGRES_PASSWORD="p'w\"\$(touch ${CANARY})\`id\`"
  rm -f "$INSTALL_DIR/.env"
  write_env_fallback "$INSTALL_DIR/.env"
  [ ! -e "$CANARY" ]
  [ "$(grep '^POSTGRES_PASSWORD=' "$INSTALL_DIR/.env")" = "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" ]
  grep -q '^WORKER_PORT=8080$' "$INSTALL_DIR/.env"
}

@test "write_env_fallback: the file is created with mode 600 and holds the values as written" {
  SERVER_PORT=5174 CLIENT_PORT=80 WORKER_PORT=8080
  POSTGRES_URL="postgres://u:p\$x@h/db"
  rm -f "$INSTALL_DIR/.env"
  write_env_fallback "$INSTALL_DIR/.env"
  [ "$(stat -c %a "$INSTALL_DIR/.env")" = "600" ]
  [ "$(grep '^POSTGRES_URL=' "$INSTALL_DIR/.env")" = 'POSTGRES_URL=postgres://u:p$x@h/db' ]
}

# ===========================================================================
# Ports of the calls relay, checked before anything is changed
# ===========================================================================

@test "AURELLE_RELAY_PORT, _MIN_PORT and _MAX_PORT: anything but a valid range is a usage error" {
  local bad=""
  for bad in "abc" "0" "70000" "-5" "1;touch ${CANARY}" "\$(touch ${CANARY})" "" "3478 3479"; do
    AURELLE_RELAY_PORT="3478" AURELLE_RELAY_MIN_PORT="49160" AURELLE_RELAY_MAX_PORT="49260"
    AURELLE_RELAY_PORT="$bad"
    [ -n "$bad" ] || continue
    run resolve_unattended_options
    [ "$status" -eq 2 ]
    [[ "$output" == *"AURELLE_RELAY"* ]]
    AURELLE_RELAY_PORT="3478"
    AURELLE_RELAY_MIN_PORT="$bad"
    run resolve_unattended_options
    [ "$status" -eq 2 ]
    AURELLE_RELAY_MIN_PORT="49160"
    AURELLE_RELAY_MAX_PORT="$bad"
    run resolve_unattended_options
    [ "$status" -eq 2 ]
  done
  [ ! -e "$CANARY" ]
}

@test "AURELLE_RELAY_MIN_PORT must be below AURELLE_RELAY_MAX_PORT" {
  AURELLE_RELAY_MIN_PORT=5000
  AURELLE_RELAY_MAX_PORT=4000
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  AURELLE_RELAY_MIN_PORT=5000
  AURELLE_RELAY_MAX_PORT=5000
  run resolve_unattended_options
  [ "$status" -eq 2 ]
}

@test "relay ports with leading zeros are written in decimal" {
  AURELLE_RELAY_PORT="03478"
  AURELLE_RELAY_MIN_PORT="049160"
  AURELLE_RELAY_MAX_PORT="049260"
  resolve_unattended_options
  [ "$AURELLE_RELAY_PORT" = "3478" ]
  [ "$AURELLE_RELAY_MIN_PORT" = "49160" ]
  [ "$AURELLE_RELAY_MAX_PORT" = "49260" ]
}

@test "the relay ports are not checked when the relay is switched off" {
  AURELLE_CALLS_RELAY=0
  AURELLE_RELAY_PORT=abc
  resolve_unattended_options
}

@test "the default relay ports pass" {
  resolve_unattended_options
}

# ===========================================================================
# Numbers used in arithmetic: a value must never be evaluated
# ===========================================================================

@test "AURELLE_HEALTH_TIMEOUT: arithmetic syntax in the value is not evaluated" {
  AURELLE_HEALTH_TIMEOUT="HOME[\$(touch ${CANARY})]"
  songbird_healthcheck_responds() { return 1; }
  # a bad value falls back to the default (90 s of waiting); only the sleep is stubbed
  run wait_for_app_health 5174
  [ "$status" -eq 1 ]
  [ ! -e "$CANARY" ]
}

@test "AURELLE_HEALTH_TIMEOUT: a number is taken, anything else means the default" {
  songbird_healthcheck_responds() { return 1; }
  local count_file="$TEST_DIR/sleeps"
  : > "$count_file"
  sleep() { printf 'x' >> "$count_file"; return 0; }
  AURELLE_HEALTH_TIMEOUT=6
  wait_for_app_health 5174 || true
  [ "$(wc -c < "$count_file")" -eq 3 ]
  : > "$count_file"
  AURELLE_HEALTH_TIMEOUT="six"
  wait_for_app_health 5174 || true
  [ "$(wc -c < "$count_file")" -eq 45 ]
}

@test "a port with leading zeros is read as decimal, without a bash error" {
  AURELLE_CLIENT_PORT="0080"
  AURELLE_SERVER_PORT="05174"
  run resolve_unattended_options
  [ "$status" -eq 0 ]
  [[ "$output" != *"value too great"* ]]
  AURELLE_CLIENT_PORT="0080"
  resolve_unattended_options
  [ "$CLIENT_PORT" = "80" ]
  [ "$SERVER_PORT" = "5174" ]
}

# ===========================================================================
# The first owner account
# ===========================================================================

@test "AURELLE_OWNER_*: a line break or control character is a usage error" {
  AURELLE_OWNER_USERNAME=$'admin\nroot'
  AURELLE_OWNER_PASSWORD="S3cret-pass"
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" == *"AURELLE_OWNER"* ]]

  AURELLE_OWNER_USERNAME="admin"
  AURELLE_OWNER_PASSWORD=$'pass\nword'
  run resolve_unattended_options
  [ "$status" -eq 2 ]

  AURELLE_OWNER_PASSWORD="S3cret-pass"
  AURELLE_OWNER_NICKNAME=$'Nick\tname'
  run resolve_unattended_options
  [ "$status" -eq 2 ]
}

@test "AURELLE_OWNER_*: a password with shell characters is passed on untouched" {
  AURELLE_OWNER_USERNAME="admin"
  AURELLE_OWNER_PASSWORD="p'a\"s s;\$(id)\`x\`#&|"
  resolve_unattended_options
  local record="$TEST_DIR/args"
  check_owner_exists() { return 1; }
  run_db_command() { printf '%s\n' "$@" > "$record"; return 0; }
  create_owner_user
  grep -qxF -- "$AURELLE_OWNER_PASSWORD" "$record"
}

# ===========================================================================
# Domains and addresses typed at the prompts reach the same files
# ===========================================================================

@test "prompt validation: an interactive domain is checked like AURELLE_DOMAIN" {
  UNATTENDED=0
  local answers=("bad;name" 'x$(id).test' "chat.example.test")
  local i=0
  prompt_read() {
    printf -v "$2" '%s' "${answers[$i]}"
    i=$((i + 1))
  }
  prompt_deploy_mode() { DEPLOY_MODE="domain"; }
  prompt_cert_mode() { CERT_MODE="http"; }
  prompt_port() { printf 5174; }
  prompt_client_port() { printf 80; }
  prompt_worker_port() { printf 8080; }
  collect_install_options > "$TEST_DIR/out" 2>&1
  [ "${DOMAIN_NAMES[*]}" = "chat.example.test" ]
  [ "$i" -eq 3 ]
  grep -q "not a valid" "$TEST_DIR/out"
}

@test "prompt validation: an interactive email for Let's Encrypt is checked" {
  UNATTENDED=0
  local answers=("a;b@example.com" "ok@example.com")
  prompt_deploy_mode() { DEPLOY_MODE="ip"; }
  prompt_cert_mode() { CERT_MODE="certbot"; }
  prompt_port() { printf 5174; }
  prompt_client_port() { printf 443; }
  prompt_worker_port() { printf 8080; }
  # prompt_non_empty is called in $( ), so count through a file
  prompt_non_empty() {
    local n
    n="$(cat "$TEST_DIR/n" 2>/dev/null || printf 0)"
    printf '%s' "$((n + 1))" > "$TEST_DIR/n"
    case "$1" in
      *email*) printf '%s' "${answers[$n]:-ok@example.com}" ;;
      *) printf '203.0.113.7' ;;
    esac
  }
  collect_install_options > "$TEST_DIR/out" 2>&1
  [ "$CERTBOT_EMAIL" = "ok@example.com" ]
}

# ===========================================================================
# What is printed back
# ===========================================================================

@test "usage errors print a hostile value without its line breaks and escape sequences" {
  AURELLE_EMAIL=$'a@example.test\n\e[31mFAKE ERROR\e[0m'
  run resolve_unattended_options
  [ "$status" -eq 2 ]
  [[ "$output" != *$'\e[31m'* ]]
  # the error is one line, the second line is the hint
  [ "$(printf '%s\n' "$output" | grep -c 'AURELLE')" -eq 1 ]
}
