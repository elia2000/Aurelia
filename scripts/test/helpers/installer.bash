# Shared setup for the bats files that source scripts/install.sh.
#
#   load 'helpers/installer'
#   setup() { load_installer; }
#   teardown() { unload_installer; }
#
# The script is sourced with its traps and its final main call removed, then every path
# it writes is pointed into TEST_DIR, so a test never touches the machine it runs on
# (it may well run as root, in CI images and in sandboxes).

INSTALL_SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/install.sh"
REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

load_installer() {
  TEST_DIR="$(mktemp -d)"

  # A developer's own settings must not leak into the tests.
  local var=""
  for var in $(compgen -v AURELLE_); do
    unset "$var"
  done
  unset REPO_URL REPO_BRANCH SCRIPT_REMOTE_URL MIRROR_NODESOURCE MIRROR_APT_EXTRA MIRROR_NPM NO_COLOR FORCE_COLOR

  # Commands that would need root or the network are stubs; a test that wants one to
  # do something defines the function again. git and dpkg are the real ones.
  apt-get()     { return 0; }
  systemctl()   { return 0; }
  nginx()       { return 0; }
  useradd()     { return 0; }
  usermod()     { return 0; }
  certbot()     { return 0; }
  lsb_release() { printf "jammy"; }
  tput()        { return 1; }  # terminal_columns falls back to $COLUMNS
  visudo()      { return 0; }
  export -f apt-get systemctl nginx useradd usermod certbot lsb_release tput visudo

  # shellcheck disable=SC1090
  source <(
    sed \
      -e "s/trap '[^']*' INT TERM/:/g" \
      -e "s/trap '[^']*' EXIT/:/g" \
      -e '/^show_menu$/d' \
      -e '/^main$/d' \
      -e '/^main[[:space:]"]/d' \
      "$INSTALL_SCRIPT"
  )

  # Sourcing resets these to their real values: point them into TEST_DIR again.
  INSTALL_DIR="$TEST_DIR/install"
  LOG_FILE="$TEST_DIR/install.log"
  mkdir -p "$INSTALL_DIR"
  touch "$LOG_FILE"
  DATA_COMMAND_LAUNCHER="$INSTALL_DIR/scripts/run-data-command.sh"
  SERVICE_FILE="$TEST_DIR/songbird.service"
  WORKER_SERVICE_FILE="$TEST_DIR/songbird-worker.service"
  LEGO_RENEW_SERVICE_FILE="$TEST_DIR/songbird-lego-renew.service"
  LEGO_RENEW_TIMER_FILE="$TEST_DIR/songbird-lego-renew.timer"
  NGINX_SITE_FILE="$TEST_DIR/nginx-site"
  NGINX_ENABLED_FILE="$TEST_DIR/nginx-enabled"
  GLOBAL_COMMAND_PATH="$TEST_DIR/songbird-deploy"
  CERT_INSTALL_DIR="$TEST_DIR/ssl"
  ACME_WEBROOT="$TEST_DIR/acme"
  LEGO_STATE_DIR="$TEST_DIR/lego-state"
  LEGO_BIN="$TEST_DIR/lego"
  # Nothing listens in a test, and a real installer may be running on this machine.
  AURELLE_HEALTH_TIMEOUT=0
  AURELLE_APT_LOCK_WAIT=0
  INSTALL_LOCK_PATH="$TEST_DIR/install.lock.d"

  clear() { return 0; }
  export COLUMNS=80
}

unload_installer() {
  rm -rf "$TEST_DIR"
}

# Runs the install script as a program the way "ssh host 'curl ... | bash'" does: the
# script text on stdin and no controlling terminal (setsid starts a new session).
# The arguments are passed to the script after "bash -s --". Needs setsid.
run_piped_without_terminal() {
  run bash -c 'cat "$1" | timeout 120 setsid -w bash -s -- "${@:2}"' _ "$INSTALL_SCRIPT" "$@"
}

# `! command` does not fail a bats test (errexit ignores negated commands, except as the
# last line). refute fails the test when the command succeeds.
refute() {
  if "$@"; then
    echo "expected to fail, but it succeeded: $*" >&2
    return 1
  fi
  return 0
}
