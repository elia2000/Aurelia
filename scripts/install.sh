#!/usr/bin/env bash
# songbird-deploy-version: 0.12.4

set -uo pipefail

# A few environments (cron, "sudo env -i", some CI runners) run without HOME.
export HOME="${HOME:-/root}"
# Package installs write their output to the log, so a question from apt or
# needrestart would wait for an answer nobody can see.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

COLOR_RESET=""
COLOR_LOG=""
COLOR_WARN=""
COLOR_ERROR=""
COLOR_SUCCESS=""

if [[ -z "${NO_COLOR:-}" && ( "${FORCE_COLOR:-0}" != "0" || ( "${TERM:-}" != "dumb" && ( -t 1 || -t 2 ) ) ) ]]; then
  COLOR_RESET=$'\033[0m'
  COLOR_LOG=$'\033[1;38;2;42;186;130m'
  COLOR_WARN=$'\033[1;33m'
  COLOR_ERROR=$'\033[1;31m'
  COLOR_SUCCESS=$'\033[1;32m'
fi

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

is_unattended() {
  [[ "${UNATTENDED:-0}" == "1" ]]
}

# clear only when it can work and is wanted: a terminal on stdout and a TERM.
# Never in unattended mode, where the output is a log that must stay complete.
clear_screen() {
  if is_unattended; then
    return 0
  fi
  if [[ -t 1 && -n "${TERM:-}" && "${TERM:-}" != "dumb" ]]; then
    clear
  fi
  return 0
}

# The last install summary is remembered so it can be shown again after the
# menu clears the screen: it is the one thing the user still needs.
INSTALL_SUMMARY_TITLE=""
INSTALL_SUMMARY_LINES=()
SUCCESS_FRAME_LOG="1"

handle_exit() {
  local exit_code=$?
  # One message per exit, even when a signal handler exits too.
  trap - EXIT
  release_install_lock

  if [[ "$exit_code" -eq 0 ]]; then
    if [[ "${SKIP_CLEAR_ON_EXIT:-0}" != "1" ]]; then
      clear_screen
    fi
    if ! is_unattended && (( ${#INSTALL_SUMMARY_LINES[@]} > 0 )); then
      SUCCESS_FRAME_LOG="0" print_success_frame "$INSTALL_SUMMARY_TITLE" "${INSTALL_SUMMARY_LINES[@]}"
    fi
    return 0
  fi

  printf "\n%b[AURELLE] Script exited with code %s.%b\n" "$COLOR_ERROR" "$exit_code" "$COLOR_RESET" >&2
  if [[ -f "$LOG_FILE" ]]; then
    printf "%b[AURELLE] Review the log at %s for the last recorded step.%b\n" "$COLOR_ERROR" "$LOG_FILE" "$COLOR_RESET" >&2
  fi
  if is_unattended; then
    printf "%b[AURELLE] Every step can be repeated: fix the problem above and run the same command again.%b\n" "$COLOR_ERROR" "$COLOR_RESET" >&2
  fi
}

handle_interrupt() {
  # The EXIT trap prints the single "exited with code" message.
  exit 130
}

trap 'handle_interrupt' INT TERM
trap 'handle_exit' EXIT

APP_NAME="songbird"
INSTALL_DIR="/opt/songbird"
LOG_FILE="/opt/songbird/logs/install.log"
DATA_COMMAND_LAUNCHER="${DATA_COMMAND_LAUNCHER:-${INSTALL_DIR}/scripts/run-data-command.sh}"
REPO_URL="${REPO_URL:-https://github.com/elia2000/Aurelia.git}"
# Branch or tag to install. Empty means the default branch of the repository
# (main on GitHub); a branch or a tag name installs exactly that.
REPO_BRANCH="${REPO_BRANCH:-}"
SERVICE_USER="songbird"
SERVICE_GROUP="songbird"
SERVICE_NAME="songbird"
SERVICE_FILE="/etc/systemd/system/songbird.service"
WORKER_SERVICE_NAME="songbird-worker"
WORKER_SERVICE_FILE="/etc/systemd/system/songbird-worker.service"
LEGO_RENEW_SERVICE_FILE="/etc/systemd/system/songbird-lego-renew.service"
LEGO_RENEW_TIMER_FILE="/etc/systemd/system/songbird-lego-renew.timer"
NGINX_SITE_FILE="/etc/nginx/sites-available/songbird"
NGINX_ENABLED_FILE="/etc/nginx/sites-enabled/songbird"
DEFAULT_SERVER_PORT="5174"
DEFAULT_CLIENT_PORT="80"
DEFAULT_WORKER_PORT="8080"
DEFAULT_FILE_UPLOAD="true"
DEFAULT_FILE_UPLOAD_MAX_SIZE_MB="25"
DEFAULT_MAX_UPLOAD_MB="75"
DEFAULT_RETENTION_DAYS="7"
DEFAULT_TEXT_RETENTION_DAYS="0"
DEFAULT_SIGN_UP="true"
DEFAULT_CHAT_VOICE_WAVEFORM_MAX_DECODE_MB="5"
DEFAULT_CHAT_VOICE_WAVEFORM_MAX_DECODE_SECONDS="480"
NODE_MAJOR="24"
# What an install needs: free disk for packages, dependencies and the build, and
# memory (RAM plus swap) for the client build. AURELLE_MIN_FREE_DISK_MB=0 skips the
# disk check (a server whose build is known to fit in less).
MIN_FREE_DISK_MB="${AURELLE_MIN_FREE_DISK_MB:-2048}"
MIN_MEMORY_MB=1024
[[ "$MIN_FREE_DISK_MB" =~ ^[0-9]+$ ]] || MIN_FREE_DISK_MB=2048
# Keep in step with "engines.node" in package.json.
NODE_MIN_VERSION="24.18.0"
SCRIPT_REMOTE_URL="${SCRIPT_REMOTE_URL:-https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh}"
LOG_LINES="${LOG_LINES:-100}"
CERT_INSTALL_DIR="/etc/ssl/songbird"
ACME_WEBROOT="/var/lib/songbird/certbot"
LEGO_STATE_DIR="/var/lib/songbird/lego"
LEGO_BIN="/usr/local/bin/lego"
GLOBAL_COMMAND_PATH="/usr/local/bin/songbird-deploy"
SONGBIRD_SOCIAL_GITHUB="https://github.com/elia2000/Aurelia"

# Mirror URLs
MIRROR_NODESOURCE="${MIRROR_NODESOURCE:-}"
MIRROR_APT_EXTRA="${MIRROR_APT_EXTRA:-}"
MIRROR_NPM="${MIRROR_NPM:-}"

SUDO=""
OS_ID=""
OS_ID_LIKE=""
DEPLOY_MODE="ip"
DOMAIN_NAMES=()
DOMAIN_GROUPS=()
MANUAL_CERT_GROUP_FULLCHAIN_PATHS=()
MANUAL_CERT_GROUP_PRIVKEY_PATHS=()
CERTBOT_EMAIL=""
DEFAULT_DB_CLIENT="sqlite3"
DEFAULT_POSTGRES_HOST="127.0.0.1"
DEFAULT_POSTGRES_PORT="5432"
DEFAULT_POSTGRES_DB="songbird"
DEFAULT_POSTGRES_USER="postgres"
DEFAULT_POSTGRES_PASSWORD="postgres"
DEFAULT_POSTGRES_URL=""
DEFAULT_POSTGRES_SSL="false"
POSTGRES_URL=""
POSTGRES_SSL="false"
DB_CLIENT="$DEFAULT_DB_CLIENT"
POSTGRES_HOST="$DEFAULT_POSTGRES_HOST"
POSTGRES_PORT="$DEFAULT_POSTGRES_PORT"
POSTGRES_DB="$DEFAULT_POSTGRES_DB"
POSTGRES_USER="$DEFAULT_POSTGRES_USER"
POSTGRES_PASSWORD="$DEFAULT_POSTGRES_PASSWORD"
SERVER_PORT="$DEFAULT_SERVER_PORT"
CLIENT_PORT="$DEFAULT_CLIENT_PORT"
WORKER_PORT="$DEFAULT_WORKER_PORT"
FILE_UPLOAD="$DEFAULT_FILE_UPLOAD"
MAX_UPLOAD_MB="$DEFAULT_MAX_UPLOAD_MB"
RETENTION_DAYS="$DEFAULT_RETENTION_DAYS"
TEXT_RETENTION_DAYS="$DEFAULT_TEXT_RETENTION_DAYS"
ACCOUNT_CREATION="$DEFAULT_SIGN_UP"
NGINX_SERVER_NAME="_"
CURRENT_ENV_FILE=""
PROMPT_FD=0
PROMPT_FD_OUT=1
DB_BACKUP_PATH=""
RESTORE_BACKUP_QUIET="no"
LAST_UNZIP_OUTPUT=""
LAST_UNZIP_STATUS=0
SOURCE_MODE=""
SOURCE_ZIP_PATH=""
CERT_MODE="http"
CERTBOT_IP_ADDRESS=""
MANUAL_CERT_FULLCHAIN_PATH=""
MANUAL_CERT_PRIVKEY_PATH=""
NODE_EXEC_PATH=""
NPM_EXEC_PATH=""
SKIP_CLEAR_ON_EXIT="0"
MENU_ACTION_PAUSED="0"
# Unattended mode (AURELLE_YES=1 or --yes): no prompt, no terminal needed.
UNATTENDED="0"
# Exit codes: 0 done, 1 failed, 2 wrong usage or no terminal to ask on, 3 installed
# but the TLS certificate could not be issued (the site answers over HTTP).
EXIT_USAGE=2
EXIT_TLS_FAILED=3
# Log lines written before the log directory exists; flushed by ensure_log_dir.
PENDING_LOG_LINES=()
# Set when the certificate step failed but the site works over plain HTTP.
TLS_FAILED="0"
# Calls relay (coturn) choice: yes, no, force (replace a coturn configuration that is
# not ours) or empty when nobody decided yet.
CALLS_RELAY_MODE=""
PUBLIC_IP=""
UPDATE_STOPPED_SERVICES="no"

# Answers for unattended mode. Each one can come from the environment or from a
# command line flag; empty means "use the default".
AURELLE_YES="${AURELLE_YES:-0}"
AURELLE_ACTION="${AURELLE_ACTION:-auto}"
AURELLE_DOMAIN="${AURELLE_DOMAIN:-}"
AURELLE_EMAIL="${AURELLE_EMAIL:-}"
AURELLE_TLS="${AURELLE_TLS:-auto}"
AURELLE_TLS_CERT="${AURELLE_TLS_CERT:-}"
AURELLE_TLS_KEY="${AURELLE_TLS_KEY:-}"
AURELLE_PUBLIC_IP="${AURELLE_PUBLIC_IP:-}"
AURELLE_SERVER_PORT="${AURELLE_SERVER_PORT:-}"
AURELLE_CLIENT_PORT="${AURELLE_CLIENT_PORT:-}"
AURELLE_WORKER_PORT="${AURELLE_WORKER_PORT:-}"
AURELLE_DB="${AURELLE_DB:-sqlite3}"
AURELLE_POSTGRES_URL="${AURELLE_POSTGRES_URL:-}"
AURELLE_BACKUP="${AURELLE_BACKUP:-0}"
AURELLE_RESTORE_BACKUP="${AURELLE_RESTORE_BACKUP:-}"
AURELLE_OWNER_USERNAME="${AURELLE_OWNER_USERNAME:-}"
AURELLE_OWNER_PASSWORD="${AURELLE_OWNER_PASSWORD:-}"
AURELLE_OWNER_NICKNAME="${AURELLE_OWNER_NICKNAME:-}"
# Calls relay (coturn): 1/yes, 0/no, or force (replace a coturn configuration that
# this installer did not write; the old file is kept as a backup).
AURELLE_CALLS_RELAY="${AURELLE_CALLS_RELAY:-}"
AURELLE_RELAY_PORT="${AURELLE_RELAY_PORT:-3478}"
AURELLE_RELAY_MIN_PORT="${AURELLE_RELAY_MIN_PORT:-49160}"
AURELLE_RELAY_MAX_PORT="${AURELLE_RELAY_MAX_PORT:-49260}"
SHOW_VERSION="0"
# Checks that need a live system (the app answering after a restart) only run in a
# real run; main() switches them on. The unit tests source this file without it.
STRICT_CHECKS="0"
ABORT_ON_INPUT_CLOSED="0"
INSTALL_LOCK_HELD="0"
INSTALL_LOCK_DIR=""
INSTALL_LOCK_PATH="/run/lock/aurelle-install.lock.d"
if [[ ! -d /run/lock ]]; then
  INSTALL_LOCK_PATH="/tmp/aurelle-install.lock.d"
fi
CALLS_RELAY_SUMMARY=""
OWNER_CREATED=""

resolve_current_script_path() {
  # "curl ... | bash" has no script file: BASH_SOURCE is empty and $0 is just
  # "bash", which must never be mistaken for a file called bash in the current
  # directory (or for /usr/bin/bash when that is the current directory).
  local source_hint="${BASH_SOURCE[0]:-}"
  if [[ -z "$source_hint" ]]; then
    return 1
  fi
  if [[ "$source_hint" != /* ]]; then
    source_hint="$(pwd)/$source_hint"
  fi
  if [[ -f "$source_hint" ]]; then
    printf "%s" "$source_hint"
    return 0
  fi
  return 1
}

read_first_line() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    return 1
  fi
  head -n 1 "$file_path" | tr -d '\r\n'
}

read_version_file_value() {
  local version_file="$1"
  local version=""
  version="$(read_first_line "$version_file" 2>/dev/null || true)"
  version="$(printf "%s" "$version" | xargs)"
  if [[ -z "$version" ]]; then
    return 1
  fi
  printf "%s" "$version"
}

read_script_version_header() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    return 1
  fi
  local header=""
  header="$(grep -E '^# songbird-deploy-version:' "$file_path" | head -n 1 | cut -d ':' -f 2- | xargs || true)"
  if [[ -z "$header" || "$header" == "auto" ]]; then
    return 1
  fi
  printf "%s" "$header"
}

resolve_script_version_for_path() {
  local script_path="$1"
  local header_version=""
  header_version="$(read_script_version_header "$script_path" 2>/dev/null || true)"
  if [[ -n "$header_version" ]]; then
    printf "%s" "$header_version"
    return 0
  fi

  local script_dir=""
  local repo_root=""
  if [[ -n "$script_path" ]]; then
    script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd -P 2>/dev/null || true)"
  fi
  if [[ -n "$script_dir" ]]; then
    repo_root="$(cd -- "$script_dir/.." && pwd -P 2>/dev/null || true)"
  fi
  if [[ -n "$repo_root" && -f "$repo_root/VERSION" ]]; then
    read_version_file_value "$repo_root/VERSION"
    return $?
  fi

  if [[ -f "$INSTALL_DIR/scripts/install.sh" ]]; then
    header_version="$(read_script_version_header "$INSTALL_DIR/scripts/install.sh" 2>/dev/null || true)"
    if [[ -n "$header_version" ]]; then
      printf "%s" "$header_version"
      return 0
    fi
  fi

  if [[ -f "$INSTALL_DIR/VERSION" ]]; then
    read_version_file_value "$INSTALL_DIR/VERSION"
    return $?
  fi

  return 1
}

CURRENT_SCRIPT_PATH="$(resolve_current_script_path 2>/dev/null || true)"
SCRIPT_VERSION="$(resolve_script_version_for_path "$CURRENT_SCRIPT_PATH" 2>/dev/null || printf "0.0.0")"
LAST_GLOBAL_COMMAND_VERSION=""

# Secrets must never reach the log: the commands the installer runs (sed on the
# env file, curl, db commands) carry them as plain text.
redact_secrets() {
  sed -E \
    -e 's/([A-Za-z_]*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY|API_KEY)[A-Za-z_]*)=["'"'"']?[^[:space:]|"'"'"']+/\1=<redacted>/g' \
    -e 's/(--password[ =])[^[:space:]]+/\1<redacted>/g'
}

# Append one already formatted line to the install log. Before the log directory
# exists (it lives inside the clone) lines are kept and written by ensure_log_dir.
log_to_file() {
  local line=""
  line="$(printf '%s' "$1" | redact_secrets)"
  if [[ -f "$LOG_FILE" ]]; then
    if ! printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null; then
      # Not writable for this user (the service user owns the log): go through sudo.
      if [[ -n "${SUDO:-}" ]]; then
        printf '%s\n' "$line" | $SUDO tee -a "$LOG_FILE" >/dev/null 2>&1 || true
      fi
    fi
  else
    PENDING_LOG_LINES+=("$line")
  fi
  return 0
}

log() {
  local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"

  printf "%b[AURELLE] %s%b\n" "$COLOR_LOG" "$1" "$COLOR_RESET"
  log_to_file "$(printf "[%s] [AURELLE] %s" "$timestamp" "$1")"
}


ensure_log_dir() {
  local log_dir="$(dirname "$LOG_FILE")"
  if [[ ! -d "$log_dir" ]]; then
    run_as_root mkdir -p "$log_dir" || return 1
    log "Created log directory: $log_dir"
  fi
  if [[ ! -f "$LOG_FILE" ]]; then
    run_as_root touch "$LOG_FILE" 2>/dev/null || true
  fi
  # The log mentions what was configured: keep it away from other local users.
  run_as_root chmod 750 "$log_dir" 2>/dev/null || true
  run_as_root chmod 600 "$LOG_FILE" 2>/dev/null || true
  if [[ -f "$LOG_FILE" ]] && (( ${#PENDING_LOG_LINES[@]} > 0 )); then
    local pending_line=""
    for pending_line in "${PENDING_LOG_LINES[@]}"; do
      log_to_file "$pending_line"
    done
    PENDING_LOG_LINES=()
  fi
}

warn() {
  local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  printf "%b[%s] WARNING: %s%b\n" "$COLOR_WARN" "AURELLE" "$*" "$COLOR_RESET" >&2
  log_to_file "$(printf "[%s] [AURELLE] WARNING: %s" "$timestamp" "$*")"
}

fail() {
  local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  printf "%b[%s] ERROR: %s%b\n" "$COLOR_ERROR" "AURELLE" "$*" "$COLOR_RESET" >&2
  log_to_file "$(printf "[%s] [AURELLE] ERROR: %s" "$timestamp" "$*")"
  exit 1
}

# Wrong command line or environment: exit code 2, nothing has been changed.
usage_fail() {
  local timestamp=""
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  printf "%b[%s] ERROR: %s%b\n" "$COLOR_ERROR" "AURELLE" "$*" "$COLOR_RESET" >&2
  printf "Run with --help for the list of options.\n" >&2
  log_to_file "$(printf "[%s] [AURELLE] ERROR: %s" "$timestamp" "$*")"
  exit "$EXIT_USAGE"
}

# curl for downloads: follow redirects, retry on a flaky link, give up on a dead one.
download() {
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 "$@"
}

# apt-get that never waits for an answer. DPkg::Lock::Timeout makes it wait for the
# dpkg lock; the lists lock ("apt-get update") and the download cache lock are not
# covered by it, see wait_for_package_manager. The timeouts keep one unreachable
# mirror from stalling the whole install: apt would otherwise wait on a dead
# connection for minutes.
apt_get_run() {
  run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 \
    apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confold \
    -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 "$@"
}

# True while another process holds one of the package manager's locks. A new cloud
# server runs apt itself after its first boot (cloud-init, unattended-upgrades) for
# several minutes, and "apt-get update" gives up at once when it finds the lock taken
# ("Could not get lock /var/lib/apt/lists/lock"). lslocks (util-linux) lists the
# locks by file; without it nothing is known and the install just tries.
package_manager_is_busy() {
  have_cmd lslocks || return 1
  lslocks --noheadings --output PATH 2>/dev/null \
    | grep -qE '^/var/(lib/apt/lists/lock|lib/dpkg/lock(-frontend)?|cache/apt/archives/lock)$'
}

# Waits (AURELLE_APT_LOCK_WAIT seconds at most, default 300) until the package manager
# is free. Call it before an apt step, outside run_silent, so that the message is seen.
wait_for_package_manager() {
  local limit="${AURELLE_APT_LOCK_WAIT:-300}"
  local waited=0
  [[ "$limit" =~ ^[0-9]+$ ]] || limit=300
  while package_manager_is_busy; do
    if (( waited >= limit )); then
      warn "Another package manager is still running after ${limit} seconds; trying anyway."
      return 0
    fi
    if (( waited == 0 )); then
      log "Another package manager is running (a new server updates itself after its first boot). Waiting for it, up to ${limit} seconds..."
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 0
}

# The release name ("noble") without lsb_release, which a minimal Debian or Ubuntu
# image does not have until the lsb-release package is installed.
apt_release_codename() {
  local codename=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"
  fi
  if [[ -z "$codename" ]] && have_cmd lsb_release; then
    codename="$(lsb_release -sc 2>/dev/null)"
  fi
  printf '%s' "$codename"
}

# Two installers at once would corrupt each other's work. The lock is a directory
# holding the owner's PID, not a file lock: a file lock would be inherited by every
# daemon the installer starts and stay held for as long as they run.
acquire_install_lock() {
  if [[ "$INSTALL_LOCK_HELD" == "1" ]]; then
    return 0
  fi
  local lock_dir="$INSTALL_LOCK_PATH"
  local holder=""
  if ! run_as_root mkdir "$lock_dir" 2>/dev/null; then
    holder="$(cat "${lock_dir}/pid" 2>/dev/null || true)"
    if [[ "$holder" =~ ^[0-9]+$ && -d "/proc/${holder}" ]]; then
      warn "Another Aurelle install or update is already running (process ${holder}, lock ${lock_dir})."
      return 1
    fi
    # Left behind by a run that was killed.
    run_as_root rm -rf "$lock_dir"
    if ! run_as_root mkdir "$lock_dir" 2>/dev/null; then
      warn "Could not take the install lock ${lock_dir}."
      return 1
    fi
  fi
  printf '%s\n' "$$" | run_as_root tee "${lock_dir}/pid" >/dev/null 2>&1 || true
  INSTALL_LOCK_DIR="$lock_dir"
  INSTALL_LOCK_HELD="1"
  return 0
}

release_install_lock() {
  if [[ "$INSTALL_LOCK_HELD" == "1" && -n "$INSTALL_LOCK_DIR" ]]; then
    run_as_root rm -rf "$INSTALL_LOCK_DIR" 2>/dev/null || true
  fi
  INSTALL_LOCK_HELD="0"
}

terminal_columns() {
  local cols=""
  if cols="$(tput cols 2>/dev/null)" && [[ "$cols" =~ ^[0-9]+$ ]] && (( cols > 0 )); then
    printf "%s" "$cols"
    return 0
  fi
  if [[ "${COLUMNS:-}" =~ ^[0-9]+$ ]] && (( COLUMNS > 0 )); then
    printf "%s" "$COLUMNS"
    return 0
  fi
  printf "80"
}

wrap_success_line() {
  local text="$1"
  local width="$2"
  if (( width < 1 )); then
    printf "%s\n" "$text"
    return 0
  fi
  if [[ -z "$text" ]]; then
    printf "\n"
    return 0
  fi

  local remaining="$text"
  while (( ${#remaining} > width )); do
    local chunk="${remaining:0:width}"
    local break_pos=-1
    local idx=0
    for (( idx=${#chunk}-1; idx>=0; idx-- )); do
      if [[ "${chunk:idx:1}" == " " ]]; then
        break_pos="$idx"
        break
      fi
    done

    if (( break_pos > 0 )); then
      printf "%s\n" "${remaining:0:break_pos}"
      remaining="${remaining:break_pos+1}"
      while [[ "$remaining" == " "* ]]; do
        remaining="${remaining:1}"
      done
    else
      printf "%s\n" "$chunk"
      remaining="${remaining:width}"
    fi
  done

  printf "%s\n" "$remaining"
}

print_plain_success_block() {
  local title="$1"
  shift || true
  local lines=("$@")
  local line=""

  printf "\n%b[AURELLE] %s%b\n" "$COLOR_SUCCESS" "$title" "$COLOR_RESET"
  for line in "${lines[@]}"; do
    if [[ -z "$line" ]]; then
      printf "\n"
    else
      printf "%b%s%b\n" "$COLOR_SUCCESS" "$line" "$COLOR_RESET"
    fi
  done
  printf "\n"
}

print_success_frame() {
  local title="$1"
  shift || true

  local lines=("$@")
  # Kept so it can be shown again on exit: the menu clears the screen and the
  # summary is the one thing the user still needs afterwards.
  if [[ "${SUCCESS_FRAME_LOG:-1}" != "0" ]]; then
    INSTALL_SUMMARY_TITLE="$title"
    INSTALL_SUMMARY_LINES=("${lines[@]}")
  fi
  local terminal_width=""
  terminal_width="$(terminal_columns)"
  local frame_width=$((terminal_width - 4))

  if (( frame_width < 40 )); then
    print_plain_success_block "$title" "${lines[@]}"
    if [[ -f "$LOG_FILE" && "${SUCCESS_FRAME_LOG:-1}" != "0" ]]; then
      local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
      log_to_file "$(printf "[%s] [AURELLE] %s\n" "$timestamp" "$title")"
      local line=""
      for line in "${lines[@]}"; do
        log_to_file "$(printf "[%s] [AURELLE] %s\n" "$timestamp" "$line")"
      done
    fi
    return 0
  fi
  if (( frame_width > 100 )); then
    frame_width=100
  fi

  local content_width=$((frame_width - 4))
  local wrapped_lines=()
  local line=""
  local segment=""
  for line in "${lines[@]}"; do
    while IFS= read -r segment; do
      wrapped_lines+=("$segment")
    done < <(wrap_success_line "$line" "$content_width")
  done

  local border=""
  printf -v border '%*s' "$((content_width + 2))" ""
  border="${border// /-}"

  printf "\n%b+%s+%b\n" "$COLOR_SUCCESS" "$border" "$COLOR_RESET"
  while IFS= read -r segment; do
    printf "%b| %-*s |%b\n" "$COLOR_SUCCESS" "$content_width" "$segment" "$COLOR_RESET"
  done < <(wrap_success_line "$title" "$content_width")
  printf "%b+%s+%b\n" "$COLOR_SUCCESS" "$border" "$COLOR_RESET"
  for line in "${wrapped_lines[@]}"; do
    printf "%b| %-*s |%b\n" "$COLOR_SUCCESS" "$content_width" "$line" "$COLOR_RESET"
  done
  printf "%b+%s+%b\n\n" "$COLOR_SUCCESS" "$border" "$COLOR_RESET"

  if [[ -f "$LOG_FILE" && "${SUCCESS_FRAME_LOG:-1}" != "0" ]]; then
    local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    log_to_file "$(printf "[%s] [AURELLE] %s\n" "$timestamp" "$title")"
    for line in "${lines[@]}"; do
      log_to_file "$(printf "[%s] [AURELLE] %s\n" "$timestamp" "$line")"
    done
  fi
}

# "Visit:" lines for the address(es) the site answers on.
site_visit_lines() {
  local mode="$CERT_MODE"
  local port="$CLIENT_PORT"
  local scheme="http"
  local hosts=()
  local host=""
  if [[ "$TLS_FAILED" == "1" ]]; then
    mode="http"
    port="80"
  fi
  if [[ "$DEPLOY_MODE" == "domain" && ${#DOMAIN_NAMES[@]} -gt 0 ]]; then
    hosts=("${DOMAIN_NAMES[@]}")
  else
    hosts=("${CERTBOT_IP_ADDRESS:-${PUBLIC_IP:-<your-server-ip>}}")
  fi
  if [[ "$mode" != "http" ]]; then
    scheme="https"
  fi
  for host in "${hosts[@]}"; do
    if [[ ( "$scheme" == "https" && "$port" == "443" ) || ( "$scheme" == "http" && "$port" == "80" ) ]]; then
      printf 'Visit: %s://%s\n' "$scheme" "$host"
    else
      printf 'Visit: %s://%s:%s\n' "$scheme" "$host" "$port"
    fi
  done
  if [[ "$mode" == "selfsigned" ]]; then
    printf 'Note: Self-signed cert - accept the browser security warning to proceed.\n'
  fi
}

show_deployment_success_frame() {
  local action="$1"
  local title=""
  local lines=()
  local line=""
  local sudo_prefix=""
  if [[ "$EUID" -ne 0 ]]; then
    sudo_prefix="sudo "
  fi

  case "$action" in
    install)
      title="Aurelle Installation Complete"
      if [[ "$TLS_FAILED" == "1" ]]; then
        lines+=("Aurelle is installed and runs, but HTTPS could not be set up.")
      else
        lines+=("Aurelle has been installed successfully.")
      fi
      ;;
    update)
      title="Aurelle Update Complete"
      lines+=("Aurelle has been updated successfully.")
      lines+=("Service restarted and nginx reloaded.")
      # An update does not ask for the setup again: read it from the files.
      load_deployment_from_existing
      ;;
    current)
      title="Aurelle Is Up To Date"
      lines+=("This installation is already at the newest version; nothing was changed.")
      load_deployment_from_existing
      ;;
    repaired)
      title="Aurelle Is Running Again"
      lines+=("This installation was at the newest version but was not working; it has been repaired.")
      load_deployment_from_existing
      ;;
    *)
      title="Aurelle Success"
      lines+=("Operation completed successfully.")
      ;;
  esac

  if [[ "$action" == "install" || "$action" == "update" || "$action" == "current" || "$action" == "repaired" ]]; then
    if [[ "$DEPLOY_MODE" == "ip" && -z "$CERTBOT_IP_ADDRESS" ]]; then
      detect_public_ip
    fi
    lines+=("")
    lines+=("App:")
    while IFS= read -r line; do
      [[ -n "$line" ]] && lines+=("$line")
    done < <(site_visit_lines)
    if [[ "$TLS_FAILED" == "1" ]]; then
      lines+=("HTTPS is NOT active: the certificate could not be issued. The domain must point at this server and port 80 must be open. Fix that and run the install command again.")
    fi
  fi

  if [[ "$action" == "install" ]]; then
    lines+=("")
    lines+=("First admin account:")
    if [[ -n "$OWNER_CREATED" && "$OWNER_CREATED" != "existing" ]]; then
      lines+=("The owner account ${OWNER_CREATED} was created. Log in with it and open the Admin Panel.")
    elif [[ "$OWNER_CREATED" == "existing" ]]; then
      lines+=("An owner account already exists in the database.")
    elif [[ "$CERT_MODE" == "http" || "$TLS_FAILED" == "1" ]]; then
      # The claim in the browser refuses plain HTTP on a remote host (docs/Admin-Panel.md).
      lines+=("This site is on plain HTTP, and claiming the owner role in the browser needs HTTPS. Create the owner from the shell: ${sudo_prefix}songbird-deploy, then Manage Database, Create user (role owner).")
      lines+=("Or give the site a domain and HTTPS (run the install command again with AURELLE_DOMAIN=your.domain), then register in the browser and claim the owner role at /admin.")
    else
      lines+=("1. Open the site and register an account.")
      lines+=("2. Open /admin on the site and enter the ADMIN_API_TOKEN to claim the owner role. Read the token with: ${sudo_prefix}grep '^ADMIN_API_TOKEN=' ${INSTALL_DIR}/.env")
      lines+=("Or create the owner from the shell: ${sudo_prefix}songbird-deploy, then Manage Database, Create user (role owner).")
    fi
  fi

  if [[ "$action" == "install" || "$action" == "update" || "$action" == "current" || "$action" == "repaired" ]]; then
    lines+=("")
    lines+=("Calls relay (voice and video between different networks):")
    if [[ -n "$CALLS_RELAY_SUMMARY" ]]; then
      lines+=("$CALLS_RELAY_SUMMARY")
    else
      lines+=("$(describe_calls_relay_state)")
    fi
    lines+=("")
    lines+=("Logs:")
    lines+=("Installer: ${LOG_FILE}")
    lines+=("Server: ${sudo_prefix}journalctl -u ${SERVICE_NAME} -f")
    lines+=("Media worker: ${sudo_prefix}journalctl -u ${WORKER_SERVICE_NAME} -f")
    lines+=("nginx: /var/log/nginx/error.log")
    lines+=("")
    lines+=("Update later:")
    lines+=("${sudo_prefix}songbird-deploy opens the menu (Update Aurelle); ${sudo_prefix}songbird-deploy --yes updates without questions. Running the install command again also updates.")
  fi

  lines+=("")
  lines+=("Links:")
  lines+=("GitHub: ${SONGBIRD_SOCIAL_GITHUB}")

  print_success_frame "$title" "${lines[@]}"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

press_enter_to_continue() {
  MENU_ACTION_PAUSED="1"
  if is_unattended; then
    return 0
  fi
  printf "\nPress Enter to return to the main menu..." >&$PROMPT_FD_OUT
  if ! IFS= read -r -u "$PROMPT_FD" _; then
    _=""
  fi
}

run_menu_action() {
  local action="$1"
  shift || true
  MENU_ACTION_PAUSED="0"

  "$action" "$@"
  local status=$?
  if [[ "$status" -eq 0 ]]; then
    return 0
  fi

  if [[ "${MENU_ACTION_PAUSED:-0}" != "1" ]]; then
    warn "Action failed. Review ${LOG_FILE} for details, then retry from the menu."
    press_enter_to_continue
  fi
  return "$status"
}

run_silent() {
  local output
  # Append command being run to log file
  if [[ -f "$LOG_FILE" ]]; then
    log_to_file "$(printf "[%s] Running: %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*")"
  fi

  if ! output="$("$@" 2>&1)"; then
    # Log the failure
    if [[ -f "$LOG_FILE" ]]; then
      log_to_file "$(printf "[%s] FAILED: %s\n%s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" "$output")"
    fi
    # Show error to user
    printf "\n%b[ERROR] Command failed: %s%b\n" "$COLOR_ERROR" "$*" "$COLOR_RESET"
    printf "%s\n" "$output"
    return 1
  else
    # Log success + output
    if [[ -f "$LOG_FILE" ]]; then
      log_to_file "$(printf "[%s] SUCCESS: %s\n%s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" "$output")"
    fi
  fi
}

run_logged_quiet() {
  local output
  if [[ -f "$LOG_FILE" ]]; then
    log_to_file "$(printf "[%s] Running: %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*")"
  fi

  if ! output="$("$@" 2>&1)"; then
    if [[ -f "$LOG_FILE" ]]; then
      log_to_file "$(printf "[%s] FAILED: %s\n%s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" "$output")"
    fi
    return 1
  fi

  if [[ -f "$LOG_FILE" ]]; then
    log_to_file "$(printf "[%s] SUCCESS: %s\n%s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" "$output")"
  fi
}

run_unzip_capture() {
  local output=""
  local status=0
  if output="$(run_as_root "$@" </dev/null 2>&1)"; then
    status=0
  else
    status=$?
  fi
  LAST_UNZIP_OUTPUT="$output"
  LAST_UNZIP_STATUS="$status"
  [[ "$status" -eq 0 ]]
}

output_looks_password_related() {
  local text=""
  text="$(printf "%s" "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "$text" == *password* || "$text" == *encrypted* || "$text" == *"unable to get password"* || "$text" == *"incorrect password"* || "$text" == *"skipping:"* ]]
}


run_as_root() {
  if [[ -n "$SUDO" ]]; then
    $SUDO "$@"
  else
    "$@"
  fi
}

run_as_root_output() {
  if [[ -n "$SUDO" ]]; then
    $SUDO "$@"
  else
    "$@"
  fi
}

bootstrap_data_command_launcher() {
  local launcher_dir=""
  local launcher_source=""
  local remote_script_url=""
  local remote_launcher_url=""
  local temporary_launcher=""

  launcher_dir="$(dirname "$DATA_COMMAND_LAUNCHER")"
  if [[ -n "$CURRENT_SCRIPT_PATH" ]]; then
    launcher_source="$(dirname "$CURRENT_SCRIPT_PATH")/run-data-command.sh"
  fi

  if [[ -f "$launcher_source" ]]; then
    log "Installing missing data command launcher..."
    run_silent run_as_root mkdir -p "$launcher_dir" || return 1
    run_silent run_as_root install -m 755 "$launcher_source" "$DATA_COMMAND_LAUNCHER" || return 1
    return 0
  fi

  remote_script_url="${SCRIPT_REMOTE_URL%%\?*}"
  remote_script_url="${remote_script_url%%\#*}"
  remote_launcher_url="${remote_script_url%/*}/run-data-command.sh"
  temporary_launcher="$(mktemp)" || return 1
  if ! curl -fsSL "$remote_launcher_url" > "$temporary_launcher"; then
    rm -f "$temporary_launcher"
    warn "Data command launcher source is unavailable: ${remote_launcher_url}"
    return 1
  fi
  if [[ ! -s "$temporary_launcher" ]] || ! /bin/bash -n "$temporary_launcher"; then
    rm -f "$temporary_launcher"
    warn "Downloaded data command launcher is invalid: ${remote_launcher_url}"
    return 1
  fi

  log "Installing missing data command launcher..."
  run_silent run_as_root mkdir -p "$launcher_dir" || {
    rm -f "$temporary_launcher"
    return 1
  }
  run_silent run_as_root install -m 755 "$temporary_launcher" "$DATA_COMMAND_LAUNCHER" || {
    rm -f "$temporary_launcher"
    return 1
  }
  rm -f "$temporary_launcher"
}

run_data_command() {
  if [[ -L "$DATA_COMMAND_LAUNCHER" ]]; then
    warn "Data command launcher must not be a symlink: ${DATA_COMMAND_LAUNCHER}"
    return 1
  fi

  if [[ ! -x "$DATA_COMMAND_LAUNCHER" ]]; then
    if [[ -f "$DATA_COMMAND_LAUNCHER" ]]; then
      log "Restoring execute permission on data command launcher..."
      run_silent run_as_root chmod 755 "$DATA_COMMAND_LAUNCHER" || {
        warn "Data command launcher is not executable: ${DATA_COMMAND_LAUNCHER}"
        return 1
      }
    else
      bootstrap_data_command_launcher || {
        warn "Data command launcher not found or not executable: ${DATA_COMMAND_LAUNCHER}"
        return 1
      }
    fi
  fi

  if [[ -n "$SUDO" ]]; then
    $SUDO "$DATA_COMMAND_LAUNCHER" "$@"
  else
    "$DATA_COMMAND_LAUNCHER" "$@"
  fi
}

run_in_install_dir() {
  local path_prefix=""
  local path_export=""
  path_prefix="$(node_tools_path_prefix)"
  if [[ -n "$path_prefix" ]]; then
    path_export="export PATH=$(printf '%q' "$path_prefix"):\$PATH; "
  fi
  # Nobody can type credentials: a repository that asks for them fails at once.
  if is_unattended; then
    path_export="export GIT_TERMINAL_PROMPT=0; ${path_export}"
  fi
  run_silent run_as_root bash -lc "cd '$INSTALL_DIR' && ${path_export}$*"
}

run_in_install_dir_output() {
  local path_prefix=""
  local path_export=""
  path_prefix="$(node_tools_path_prefix)"
  if [[ -n "$path_prefix" ]]; then
    path_export="export PATH=$(printf '%q' "$path_prefix"):\$PATH; "
  fi
  if is_unattended; then
    path_export="export GIT_TERMINAL_PROMPT=0; ${path_export}"
  fi
  if [[ -n "$SUDO" ]]; then
    $SUDO bash -lc "cd '$INSTALL_DIR' && ${path_export}$*"
  else
    bash -lc "cd '$INSTALL_DIR' && ${path_export}$*"
  fi
}

dir_has_entries() {
  local target_dir="$1"
  local first_entry=""
  first_entry="$(run_as_root_output find "$target_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  [[ -n "$first_entry" ]]
}

# Questions are read from the controlling terminal, not from stdin: with
# "curl ... | bash" stdin is the script itself. The test opens /dev/tty for real
# because the device node exists even where there is no controlling terminal
# (CI, "ssh host command" without -t, cron), and opening it then fails.
init_prompt_io() {
  if is_unattended; then
    # Nothing is asked. A question that slips through reads an empty answer.
    exec 3</dev/null
    PROMPT_FD=3
    PROMPT_FD_OUT=2
    return 0
  fi
  if (exec </dev/tty) 2>/dev/null && (exec >/dev/tty) 2>/dev/null; then
    exec 3</dev/tty
    exec 4>/dev/tty
    PROMPT_FD=3
    PROMPT_FD_OUT=4
    return 0
  fi
  if [[ -t 0 ]]; then
    PROMPT_FD=0
    PROMPT_FD_OUT=1
    return 0
  fi
  no_terminal_error
}

# Without a terminal the menu and its questions cannot work. Say how to run
# the installer unattended instead of looping on empty answers.
no_terminal_error() {
  local url="${SCRIPT_REMOTE_URL}"
  printf "%b[AURELLE] ERROR: No terminal is available to ask questions on.%b\n" "$COLOR_ERROR" "$COLOR_RESET" >&2
  printf "This happens in CI, in cron and with 'ssh host command' (no -t). Either:\n" >&2
  printf "  - connect with a terminal (ssh -t host) and run the installer again, or\n" >&2
  printf "  - run it unattended; every question then takes its default or an AURELLE_* value:\n\n" >&2
  printf "    curl -fsSL %s | sudo env AURELLE_YES=1 AURELLE_DOMAIN=chat.example.com AURELLE_EMAIL=you@example.com bash\n\n" "$url" >&2
  printf "    (leave AURELLE_DOMAIN and AURELLE_EMAIL out to serve on the server IP over HTTP)\n" >&2
  exit "$EXIT_USAGE"
}

# The input ended (Ctrl-D, closed terminal) while a question was open. Going on
# with empty answers would loop forever on menus, so stop the whole script.
prompt_input_closed() {
  printf "\n%b[AURELLE] Input closed while waiting for an answer. Stopping.%b\n" "$COLOR_ERROR" "$COLOR_RESET" >&2
  # A question can be asked inside $( ... ): signal the main shell as well.
  if [[ "${ABORT_ON_INPUT_CLOSED:-0}" == "1" ]]; then
    kill -s TERM "$$" 2>/dev/null || true
  fi
  exit 1
}

prompt_read() {
  local __prompt_text="$1"
  local __prompt_result_var="$2"
  local __prompt_value=""
  if is_unattended; then
    log_to_file "$(printf "[%s] [AURELLE] Question not asked in unattended mode, default used: %s" "$(date '+%Y-%m-%d %H:%M:%S')" "$__prompt_text")"
    printf -v "$__prompt_result_var" "%s" ""
    return 0
  fi
  printf "%s" "$__prompt_text" >&$PROMPT_FD_OUT
  if ! IFS= read -r -u "$PROMPT_FD" __prompt_value; then
    prompt_input_closed
  fi
  printf -v "$__prompt_result_var" "%s" "$__prompt_value"
}

prompt_non_empty() {
  local prompt="$1"
  local value=""
  if is_unattended; then
    fail "A value is required for: ${prompt}. Set the matching AURELLE_* variable."
  fi
  while true; do
    prompt_read "$prompt: " value
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ -n "$value" ]]; then
      printf "%s" "$value"
      return 0
    fi
    printf "Please provide a value.\n"
  done
}

prompt_secret() {
  local prompt="$1"
  local value=""
  if is_unattended; then
    fail "A value is required for: ${prompt}. Set the matching AURELLE_* variable."
  fi
  while true; do
    printf "%s: " "$prompt" >&$PROMPT_FD_OUT
    if ! IFS= read -ers -u "$PROMPT_FD" value; then
      prompt_input_closed
    fi
    printf "\n" >&$PROMPT_FD_OUT
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ -n "$value" ]]; then
      printf "%s" "$value"
      return 0
    fi
    printf "Please provide a value.\n"
  done
}

prompt_secret_optional() {
  local prompt="$1"
  local value=""
  if is_unattended; then
    return 0
  fi
  printf "%s: " "$prompt" >&$PROMPT_FD_OUT
  if ! IFS= read -ers -u "$PROMPT_FD" value; then
    prompt_input_closed
  fi
  printf "\n" >&$PROMPT_FD_OUT
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

prompt_yes_no() {
  local prompt="$1"
  local default="$2"
  local value=""
  if is_unattended; then
    log_to_file "$(printf "[%s] [AURELLE] Question not asked in unattended mode, answered %s: %s" "$(date '+%Y-%m-%d %H:%M:%S')" "$default" "$prompt")"
    printf "%s" "$default"
    return 0
  fi
  while true; do
    prompt_read "$prompt [y/n] (default: $default): " value
    value="$(printf "%s" "$value" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "$value" ]]; then
      value="$default"
    fi
    case "$value" in
      y|yes) printf "yes"; return 0 ;;
      n|no) printf "no"; return 0 ;;
      *) printf "Please answer y or n.\n" ;;
    esac
  done
}

prompt_port() {
  local value=""
  while true; do
    prompt_read "Enter server port (default: $DEFAULT_SERVER_PORT): " value
    if [[ -z "$value" ]]; then
      printf "%s" "$DEFAULT_SERVER_PORT"
      return 0
    fi
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )); then
      printf "%s" "$value"
      return 0
    fi
    printf "Port must be an integer between 1 and 65535.\n"
  done
}

prompt_client_port() {
  local default_port="${1:-$DEFAULT_CLIENT_PORT}"
  local value=""
  while true; do
    prompt_read "Enter client (nginx) port (default: $default_port): " value
    if [[ -z "$value" ]]; then
      printf "%s" "$default_port"
      return 0
    fi
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )); then
      printf "%s" "$value"
      return 0
    fi
    printf "Port must be an integer between 1 and 65535.\n"
  done
}

prompt_worker_port() {
  local default_port="${1:-$DEFAULT_WORKER_PORT}"
  local value=""
  while true; do
    prompt_read "Enter media worker port (default: $default_port): " value
    if [[ -z "$value" ]]; then
      printf "%s" "$default_port"
      return 0
    fi
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )); then
      if [[ "$value" == "$SERVER_PORT" || "$value" == "$CLIENT_PORT" ]]; then
        printf "Media worker port cannot conflict with server port (%s) or client port (%s).\n" "$SERVER_PORT" "$CLIENT_PORT"
        continue
      fi
      printf "%s" "$value"
      return 0
    fi
    printf "Port must be an integer between 1 and 65535.\n"
  done
}

normalize_path_input() {
  local value="$1"
  if [[ "$value" == "~"* ]]; then
    printf "%s" "${value/#\~/$HOME}"
    return 0
  fi
  printf "%s" "$value"
}

strip_surrounding_quotes() {
  local value="$1"
  # Strip nested layers (e.g. '"0.11.4"') so copy-pasted quoting still resolves.
  # A lone quote can never be a surrounding pair; guard the substring below.
  while (( ${#value} >= 2 )); do
    local first="${value:0:1}"
    local last="${value: -1}"
    if [[ ( "$first" == "\"" && "$last" == "\"" ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
      value="${value:1:${#value}-2}"
    else
      break
    fi
  done
  printf "%s" "$value"
}

strip_carriage_returns() {
  local value="$1"
  printf "%s" "$value" | tr -d '\r'
}

# Canonical sanitizer: CR-strip -> trim -> unquote -> trim.
sanitize_input_value() {
  local value="$1"
  value="$(strip_carriage_returns "$value")"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="$(strip_surrounding_quotes "$value")"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

file_exists_path() {
  local path="$1"
  if [[ -f "$path" ]]; then
    return 0
  fi
  if [[ -n "$SUDO" ]]; then
    $SUDO test -f "$path"
    return $?
  fi
  return 1
}

resolve_file_path() {
  local raw="$1"
  local value=""
  value="$(sanitize_input_value "$raw")"
  value="$(normalize_path_input "$value")"
  if [[ -z "$value" ]]; then
    return 1
  fi

  if [[ "$value" == /* ]]; then
    if file_exists_path "$value"; then
      printf "%s" "$value"
      return 0
    fi
    return 1
  fi

  local candidates=(
    "$PWD/$value"
    "$HOME/$value"
    "/root/$value"
    "/$value"
  )
  local candidate=""
  for candidate in "${candidates[@]}"; do
    if file_exists_path "$candidate"; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

clear_mirror_values() {
  MIRROR_NODESOURCE=""
  MIRROR_APT_EXTRA=""
  MIRROR_NPM=""
}

configure_mirrors_menu() {
  while true; do
    clear_screen
    show_banner
    printf "\n"
    printf "Configure Mirrors\n"
    printf $'1) 🔗  Set NodeSource mirror (current: %s)\n' "${MIRROR_NODESOURCE:-<default>}"
    printf $'2) 🔗  Set apt mirror source (current: %s)\n' "${MIRROR_APT_EXTRA:-<none>}"
    printf $'3) 🔗  Set npm registry mirror (current: %s)\n' "${MIRROR_NPM:-<default>}"
    printf $'4) 🔄️  Restore defaults (clear mirrors)\n'
    printf $'5) ↩️  Go back\n'
    printf $'0) 🚪  Exit\n\n'

    prompt_read "Choose an option [0-5]: " choice
    case "$choice" in
      1)
        local val=""
        prompt_read "NodeSource mirror base URL (blank to clear): " val
        val="${val#"${val%%[![:space:]]*}"}"
        val="${val%"${val##*[![:space:]]}"}"
        MIRROR_NODESOURCE="$val"
        ;;
      2)
        local val=""
        prompt_read "Extra apt source line for packages (blank to clear): " val
        val="${val#"${val%%[![:space:]]*}"}"
        val="${val%"${val##*[![:space:]]}"}"
        MIRROR_APT_EXTRA="$val"
        ;;
      3)
        local val=""
        prompt_read "npm registry mirror URL (blank to clear): " val
        val="${val#"${val%%[![:space:]]*}"}"
        val="${val%"${val##*[![:space:]]}"}"
        MIRROR_NPM="$val"
        ;;
      4)
        clear_mirror_values
        ;;
      5) return ;;
      0) exit 0 ;;
      *) printf "Invalid choice. Select a number from 0 to 5.\n" ;;
    esac
  done
}

prompt_source_mode() {
  local mode=""
  if is_unattended; then
    SOURCE_MODE="github"
    return 0
  fi
  while true; do
    printf "\n%bSource Mode%b\n" "$COLOR_LOG" "$COLOR_RESET"
    printf "  1) GitHub\n"
    printf "  2) Offline\n"
    prompt_read "Choose an option [1-2]: " mode
    mode="${mode#"${mode%%[![:space:]]*}"}"
    mode="${mode%"${mode##*[![:space:]]}"}"
    case "$mode" in
      1)
        SOURCE_MODE="github"
        break
        ;;
      2)
        SOURCE_MODE="offline"
        break
        ;;
      *) printf "Choose 1 or 2.\n" ;;
    esac
  done
}

prompt_deploy_mode() {
  local mode=""
  while true; do
    printf "\n%bDeploy Mode%b\n" "$COLOR_LOG" "$COLOR_RESET"
    printf "  1) Domain\n"
    printf "  2) IP\n"
    prompt_read "Choose an option [1-2]: " mode
    mode="${mode#"${mode%%[![:space:]]*}"}"
    mode="${mode%"${mode##*[![:space:]]}"}"
    case "$mode" in
      1)
        DEPLOY_MODE="domain"
        break
        ;;
      2)
        DEPLOY_MODE="ip"
        break
        ;;
      *) printf "Choose 1 or 2.\n" ;;
    esac
  done
}

prompt_cert_mode() {
  local mode=""
  while true; do
    local option_one_label="Obtain certificate"
    if [[ "$DEPLOY_MODE" == "domain" ]]; then
      option_one_label="Obtain cert for domain"
    else
      option_one_label="Obtain 6-day cert for IP"
    fi
    printf "\n%bCertificate Mode%b\n" "$COLOR_LOG" "$COLOR_RESET"
    printf "  1) %s\n" "$option_one_label"
    printf "  2) TLS certificate files\n"
    printf "  3) HTTP only\n"
    printf "  4) Self-signed certificate (not recommended)\n"
    prompt_read "Choose an option [1-4]: " mode
    mode="${mode#"${mode%%[![:space:]]*}"}"
    mode="${mode%"${mode##*[![:space:]]}"}"
    case "$mode" in
      1)
        CERT_MODE="certbot"
        break
        ;;
      2)
        CERT_MODE="files"
        break
        ;;
      3)
        CERT_MODE="http"
        break
        ;;
      4)
        CERT_MODE="selfsigned"
        break
        ;;
      *) printf "Choose 1, 2, 3, or 4.\n" ;;
    esac
  done
}

database_backup_extension() {
  if [[ "$DB_CLIENT" == "postgres" || "$DB_CLIENT" == "postgresql" || "$DB_CLIENT" == "pg" ]]; then
    printf ".dump"
    return 0
  fi
  printf ".db"
}

prompt_backup_path() {
  local extension=""
  local backup_input=""
  extension="$(database_backup_extension)"
  while true; do
    prompt_read "Enter the full path to the backup ${extension} file: " backup_input
    if [[ -z "$backup_input" ]]; then
      printf "Please provide a file path.\n"
      continue
    fi
    local resolved=""
    resolved="$(resolve_file_path "$backup_input")" || resolved=""
    if [[ -z "$resolved" ]]; then
      printf "File not found. Tried: %s\n" "$backup_input"
      continue
    fi
    if [[ "${resolved,,}" != *"${extension}" ]]; then
      printf "Backup file must be a %s file.\n" "$extension"
      continue
    fi
    printf "%s" "$resolved"
    return 0
  done
}

select_backup_path() {
  local use_detected=""
  local detected=""
  detected="$(find_restore_backup_path)" || detected=""
  if [[ -n "$detected" ]]; then
    use_detected="$(prompt_yes_no "Use detected backup ${detected}?" "yes")"
    if [[ "$use_detected" == "yes" ]]; then
      printf "%s" "$detected"
      return 0
    fi
  fi

  prompt_backup_path
}

prompt_database_choice() {
  if is_unattended; then
    return 0
  fi
  DB_CLIENT="sqlite3"
  POSTGRES_HOST="$DEFAULT_POSTGRES_HOST"
  POSTGRES_PORT="$DEFAULT_POSTGRES_PORT"
  POSTGRES_DB="$DEFAULT_POSTGRES_DB"
  POSTGRES_USER="$DEFAULT_POSTGRES_USER"
  POSTGRES_PASSWORD="$DEFAULT_POSTGRES_PASSWORD"
  POSTGRES_URL="$DEFAULT_POSTGRES_URL"
  POSTGRES_SSL="$DEFAULT_POSTGRES_SSL"

  printf "\n%bSelect Database Engine:%b\n" "$COLOR_LOG" "$COLOR_RESET"
  printf "  1) SQLite (Default)\n"
  printf "  2) PostgreSQL (Recommended for +500 Users)\n"

  local choice=""
  while true; do
    prompt_read "Choice [1-2] (default 1): " choice
    choice="${choice:-1}"
    case "$choice" in
      1)
        DB_CLIENT="sqlite3"
        break
        ;;
      2)
        DB_CLIENT="postgres"
        prompt_read "PostgreSQL Host or URL [$DEFAULT_POSTGRES_HOST]: " POSTGRES_HOST
        POSTGRES_HOST="${POSTGRES_HOST#"${POSTGRES_HOST%%[![:space:]]*}"}"
        POSTGRES_HOST="${POSTGRES_HOST%"${POSTGRES_HOST##*[![:space:]]}"}"
        POSTGRES_HOST="${POSTGRES_HOST:-$DEFAULT_POSTGRES_HOST}"

        if [[ "$POSTGRES_HOST" =~ ^postgres(ql)?:// ]]; then
          POSTGRES_URL="$POSTGRES_HOST"
          if [[ "$POSTGRES_URL" == *"sslmode=require"* || "$POSTGRES_URL" == *"ssl=true"* ]]; then
            POSTGRES_SSL="true"
          fi
          break
        fi

        prompt_read "PostgreSQL Port [$DEFAULT_POSTGRES_PORT]: " POSTGRES_PORT
        POSTGRES_PORT="${POSTGRES_PORT#"${POSTGRES_PORT%%[![:space:]]*}"}"
        POSTGRES_PORT="${POSTGRES_PORT%"${POSTGRES_PORT##*[![:space:]]}"}"
        POSTGRES_PORT="${POSTGRES_PORT:-$DEFAULT_POSTGRES_PORT}"

        prompt_read "PostgreSQL Database Name [$DEFAULT_POSTGRES_DB]: " POSTGRES_DB
        POSTGRES_DB="${POSTGRES_DB#"${POSTGRES_DB%%[![:space:]]*}"}"
        POSTGRES_DB="${POSTGRES_DB%"${POSTGRES_DB##*[![:space:]]}"}"
        POSTGRES_DB="${POSTGRES_DB:-$DEFAULT_POSTGRES_DB}"

        prompt_read "PostgreSQL Username [$DEFAULT_POSTGRES_USER]: " POSTGRES_USER
        POSTGRES_USER="${POSTGRES_USER#"${POSTGRES_USER%%[![:space:]]*}"}"
        POSTGRES_USER="${POSTGRES_USER%"${POSTGRES_USER##*[![:space:]]}"}"
        POSTGRES_USER="${POSTGRES_USER:-$DEFAULT_POSTGRES_USER}"

        prompt_read "PostgreSQL Password [$DEFAULT_POSTGRES_PASSWORD]: " POSTGRES_PASSWORD
        POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$DEFAULT_POSTGRES_PASSWORD}"

        local default_ssl="no"
        if [[ "$POSTGRES_HOST" != "127.0.0.1" && "$POSTGRES_HOST" != "0.0.0.0" && "$POSTGRES_HOST" != "localhost" ]]; then
          default_ssl="yes"
        fi
        if [[ "$(prompt_yes_no "Enable SSL for PostgreSQL connection?" "$default_ssl")" == "yes" ]]; then
          POSTGRES_SSL="true"
        else
          POSTGRES_SSL="false"
        fi
        break
        ;;
      *) printf "Choose 1 or 2.\n" ;;
    esac
  done
}

prompt_install_backup_restore() {
  local extension=""
  if is_unattended; then
    return 0
  fi
  DB_BACKUP_PATH=""
  extension="$(database_backup_extension)"
  if [[ "$(prompt_yes_no "Restore database from a backup ${extension} file during installation?" "no")" != "yes" ]]; then
    return 0
  fi

  DB_BACKUP_PATH="$(select_backup_path)"
  return 0
}

detect_os() {
  [[ -f /etc/os-release ]] || fail "Cannot detect OS (/etc/os-release missing)."
  # shellcheck disable=SC1091
  source /etc/os-release
  OS_ID="${ID:-}"
  OS_ID_LIKE="${ID_LIKE:-}"

  if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" || "$OS_ID_LIKE" == *"debian"* ]]; then
    return 0
  fi
  fail "Unsupported OS: ${PRETTY_NAME:-unknown}. This script supports Debian/Ubuntu only."
}

ensure_sudo() {
  if [[ "$EUID" -ne 0 ]]; then
    have_cmd sudo || fail "This script needs root privileges. Install sudo or run as root."
    SUDO="sudo"
    if is_unattended; then
      # There is nobody to type a password.
      $SUDO -n true 2>/dev/null || fail "Unattended mode needs root or sudo without a password. Run it as: curl -fsSL ${SCRIPT_REMOTE_URL} | sudo bash -s -- --yes"
    else
      $SUDO -v || fail "sudo did not accept the password."
    fi
  fi
}

install_required_packages() {
  local required_pkgs=(
    git
    curl
    ca-certificates
    gnupg
    lsb-release
    build-essential
    nginx
    ffmpeg
    nano
    zip
    unzip
  )
  if [[ "$DB_CLIENT" == "postgres" || "$DB_CLIENT" == "postgresql" || "$DB_CLIENT" == "pg" ]]; then
    required_pkgs+=(postgresql-client)
  fi
  if [[ "$DB_CLIENT" == "postgres" && -z "$POSTGRES_URL" && ( "$POSTGRES_HOST" == "127.0.0.1" || "$POSTGRES_HOST" == "0.0.0.0" || "$POSTGRES_HOST" == "localhost" ) ]]; then
    required_pkgs+=(postgresql postgresql-contrib)
  fi
  if [[ "$CERT_MODE" == "certbot" && "$DEPLOY_MODE" == "domain" ]]; then
    required_pkgs+=(python3-certbot-nginx)
  fi
  local missing_pkgs=()
  local pkg=""

  for pkg in "${required_pkgs[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing_pkgs+=("$pkg")
    fi
  done

  local codename=""
  codename="$(apt_release_codename)"
  if [[ -n "$MIRROR_APT_EXTRA" && -z "$codename" ]]; then
    warn "The release name of this system could not be found (VERSION_CODENAME in /etc/os-release), which the apt mirror needs."
    return 1
  fi
  wait_for_package_manager
  if [[ -n "$MIRROR_APT_EXTRA" ]]; then
    log "Refreshing apt package index (temporary mirror: ${MIRROR_APT_EXTRA})..."
    if ! run_silent apt_get_run update \
      -o Dir::Etc::sourcelist=/dev/null \
      -o Dir::Etc::sourceparts=/dev/null \
      -o Dir::Etc::sourcelist=- \
      -o Dir::Etc::sourceparts=- <<EOF
deb ${MIRROR_APT_EXTRA} ${codename} main restricted universe multiverse
EOF
    then
      return 1
    fi
  else
    log "Refreshing apt package index..."
    run_silent apt_get_run update || return 1
  fi

  if (( ${#missing_pkgs[@]} > 0 )); then
    log "Installing missing packages: ${missing_pkgs[*]}"
    run_silent apt_get_run install -y --allow-downgrades "${missing_pkgs[@]}" || return 1
  else
    log "All required base packages are already installed."
  fi
}

# True when "24.18.0" or "v24.18.1" is at least NODE_MIN_VERSION (the repository
# requires >= 24.18.0 in package.json, not just any 24.x).
node_version_ok() {
  local version="${1:-}"
  version="${version#v}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || return 1
  version="${version%%[-+]*}"
  dpkg --compare-versions "$version" ge "$NODE_MIN_VERSION"
}

installed_node_version() {
  have_cmd node || return 1
  node -p 'process.versions.node' 2>/dev/null | tr -d '\r\n'
}

# Makes "node" the first acceptable Node.js: the one in PATH, else one in /usr/bin or
# /usr/local/bin (an nvm or distribution node earlier in PATH would hide it). Prints
# nothing; returns 0 when node is now new enough.
use_acceptable_node() {
  local node_dir=""
  hash -r
  if node_version_ok "$(installed_node_version || true)"; then
    return 0
  fi
  for node_dir in /usr/bin /usr/local/bin; do
    [[ -x "${node_dir}/node" ]] || continue
    if node_version_ok "$("${node_dir}/node" -p 'process.versions.node' 2>/dev/null | tr -d '\r\n')"; then
      PATH="${node_dir}:${PATH}"
      NODE_EXEC_PATH=""
      NPM_EXEC_PATH=""
      hash -r
      return 0
    fi
  done
  return 1
}

ensure_nodejs_from_nodesource() {
  local current_version=""
  if use_acceptable_node; then
    log "Node.js $(installed_node_version) already installed. Skipping."
    return 0
  fi
  current_version="$(installed_node_version || true)"
  if [[ -n "$current_version" ]]; then
    log "Node.js ${current_version} is older than the required ${NODE_MIN_VERSION}. Installing Node.js ${NODE_MAJOR}.x..."
  fi
  ensure_nodejs_installed || return 1

  if ! use_acceptable_node; then
    current_version="$(installed_node_version || true)"
    warn "Node.js ${NODE_MIN_VERSION} or newer is required but this server has ${current_version:-no Node.js} after the installation. Check the output above, or point MIRROR_NODESOURCE at a mirror."
    return 1
  fi
  log "Node.js $(installed_node_version) is ready."
}

ensure_nodejs_installed() {
  # The NodeSource setup script runs apt-get update itself.
  wait_for_package_manager
  if [[ -n "$MIRROR_NODESOURCE" ]]; then
    # Detect tarball vs setup-script mirror by checking for .tar.gz suffix
    if [[ "$MIRROR_NODESOURCE" == *.tar.gz ]]; then
      log "Installing Node.js from tarball mirror: ${MIRROR_NODESOURCE}"

      local tmp_dir
      tmp_dir="$(mktemp -d)"
      local tarball="${tmp_dir}/node.tar.gz"

      download "$MIRROR_NODESOURCE" -o "$tarball" || {
        rm -rf "$tmp_dir"
        warn "Could not download Node.js from ${MIRROR_NODESOURCE}."
        return 1
      }

      local install_dir="/usr/local"
      run_silent run_as_root tar -xzf "$tarball" -C "$install_dir" --strip-components=1 || {
        rm -rf "$tmp_dir"
        return 1
      }

      rm -rf "$tmp_dir"

      log "Node.js installed from tarball to ${install_dir}."
      return 0
    else
      # NodeSource-compatible mirror: mirror base URL + /setup_XX.x
      local setup_url="${MIRROR_NODESOURCE%/}/setup_${NODE_MAJOR}.x"
      log "Installing Node.js ${NODE_MAJOR}.x via NodeSource-style mirror: ${setup_url}"
      if [[ -n "$SUDO" ]]; then
        download "$setup_url" | $SUDO -E bash - || return 1
      else
        download "$setup_url" | bash - || return 1
      fi
      run_silent apt_get_run install -y nodejs || return 1
      return 0
    fi
  fi

  # Default: official NodeSource
  local setup_url="https://deb.nodesource.com/setup_${NODE_MAJOR}.x"
  log "Installing Node.js ${NODE_MAJOR}.x via NodeSource..."
  if [[ -n "$SUDO" ]]; then
    download "$setup_url" | $SUDO -E bash - || {
      warn "Could not set up NodeSource. Check the network or use a mirror (MIRROR_NODESOURCE)."
      return 1
    }
  else
    download "$setup_url" | bash - || {
      warn "Could not set up NodeSource. Check the network or use a mirror (MIRROR_NODESOURCE)."
      return 1
    }
  fi
  run_silent apt_get_run install -y nodejs || return 1
}

resolve_node_exec_path() {
  local node_path=""
  if have_cmd node; then
    node_path="$(command -v node)"
  elif have_cmd nodejs; then
    node_path="$(command -v nodejs)"
  elif [[ -f "$SERVICE_FILE" ]]; then
    node_path="$(grep -E '^ExecStart=' "$SERVICE_FILE" | head -n 1 | sed -E 's/^ExecStart=([^[:space:]]+).*/\1/' || true)"
    if [[ ! -x "$node_path" ]]; then
      node_path=""
    fi
  fi

  if [[ -z "$node_path" ]]; then
    warn "Node.js executable not found in PATH after installation."
    return 1
  fi

  NODE_EXEC_PATH="$node_path"
  log "Using Node.js executable for systemd service: ${NODE_EXEC_PATH}"
}

resolve_npm_exec_path() {
  local npm_path=""
  if have_cmd npm; then
    npm_path="$(command -v npm)"
  fi

  if [[ -z "$npm_path" && -z "$NODE_EXEC_PATH" ]]; then
    resolve_node_exec_path >/dev/null 2>&1 || true
  fi

  if [[ -z "$npm_path" && -n "$NODE_EXEC_PATH" && -x "$(dirname "$NODE_EXEC_PATH")/npm" ]]; then
    npm_path="$(dirname "$NODE_EXEC_PATH")/npm"
  elif [[ -z "$npm_path" && -x /usr/bin/npm ]]; then
    npm_path="/usr/bin/npm"
  elif [[ -z "$npm_path" && -x /usr/local/bin/npm ]]; then
    npm_path="/usr/local/bin/npm"
  fi

  if [[ -z "$npm_path" ]]; then
    warn "npm executable not found. Install Node.js/npm or rerun the install/update flow."
    return 1
  fi

  NPM_EXEC_PATH="$npm_path"
}

node_tools_path_prefix() {
  local dirs=()
  local dir=""
  local existing=""

  if [[ -z "$NODE_EXEC_PATH" ]]; then
    resolve_node_exec_path >/dev/null 2>&1 || true
  fi
  if [[ -z "$NPM_EXEC_PATH" ]]; then
    resolve_npm_exec_path >/dev/null 2>&1 || true
  fi

  if [[ -n "$NODE_EXEC_PATH" ]]; then
    dir="$(dirname "$NODE_EXEC_PATH")"
    [[ -d "$dir" ]] && dirs+=("$dir")
  fi
  if [[ -n "$NPM_EXEC_PATH" ]]; then
    dir="$(dirname "$NPM_EXEC_PATH")"
    [[ -d "$dir" ]] && dirs+=("$dir")
  fi

  local unique=()
  for dir in "${dirs[@]}"; do
    local seen="no"
    for existing in "${unique[@]}"; do
      if [[ "$existing" == "$dir" ]]; then
        seen="yes"
        break
      fi
    done
    [[ "$seen" == "no" ]] && unique+=("$dir")
  done

  local prefix=""
  for dir in "${unique[@]}"; do
    if [[ -z "$prefix" ]]; then
      prefix="$dir"
    else
      prefix="${prefix}:${dir}"
    fi
  done
  printf "%s" "$prefix"
}


ensure_service_user_exists() {
  # Create user if it doesn't exist
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating dedicated system user: ${SERVICE_USER}"
    run_silent run_as_root useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" || return 1
  else
    log "Service user ${SERVICE_USER} already exists."
  fi

  # Add the service user to groups needed for log access.
  # adm         — grants read access to /var/log/nginx/* (and other system logs)
  # systemd-journal — grants access to journalctl without root
  local groups_to_add=()
  if getent group adm >/dev/null 2>&1; then
    groups_to_add+=("adm")
  fi
  if getent group systemd-journal >/dev/null 2>&1; then
    groups_to_add+=("systemd-journal")
  fi
  
  for grp in "${groups_to_add[@]}"; do
    if ! id -nG "$SERVICE_USER" 2>/dev/null | grep -qw "$grp"; then
      log "Adding ${SERVICE_USER} to group: ${grp}"
      run_silent run_as_root usermod -aG "$grp" "$SERVICE_USER" || true
    else
      log "User ${SERVICE_USER} already in group: ${grp}"
    fi
  done

  # Install a passwordless sudoers drop-in so the service process can
  # control its own systemd unit and read nginx/service logs via sudo -n.
  local sudoers_drop_in="/etc/sudoers.d/songbird"
  local sudoers_content="# Aurelle — allow the service user to control its own unit
# and read privileged logs without a password.
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${SERVICE_NAME}
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${SERVICE_NAME}
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${WORKER_SERVICE_NAME}
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${WORKER_SERVICE_NAME}
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/journalctl -u ${SERVICE_NAME} *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/journalctl -u ${WORKER_SERVICE_NAME} *
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/cat /var/log/nginx/error.log
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/cat /var/log/nginx/access.log
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/nginx -t
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
"
  
  # Always validate and install/update the sudoers drop-in
  if run_as_root bash -c "printf '%s' $(printf '%q' "$sudoers_content") | visudo -c -f /dev/stdin" >/dev/null 2>&1; then
    # Check if the file exists and has the correct content
    local needs_update="yes"
    if [[ -f "$sudoers_drop_in" ]]; then
      local existing_content=""
      existing_content="$(run_as_root cat "$sudoers_drop_in" 2>/dev/null || true)"
      if [[ "$existing_content" == "$sudoers_content" ]]; then
        needs_update="no"
        log "Sudoers drop-in at ${sudoers_drop_in} is already up to date."
      fi
    fi
    
    if [[ "$needs_update" == "yes" ]]; then
      log "Installing sudoers drop-in at ${sudoers_drop_in}..."
      run_silent run_as_root bash -c "printf '%s' $(printf '%q' "$sudoers_content") > '$sudoers_drop_in'"
      run_silent run_as_root chmod 440 "$sudoers_drop_in" || true
    fi
  else
    warn "Could not validate sudoers drop-in — skipping. Service control from the admin panel may not work."
  fi
}

map_lego_arch() {
  local machine=""
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) printf "amd64" ;;
    aarch64|arm64) printf "arm64" ;;
    armv7l|armv7) printf "armv7" ;;
    armv6l|armv6) printf "armv6" ;;
    i386|i686) printf "386" ;;
    *)
      warn "Unsupported architecture for lego binary install: ${machine}"
      return 1
      ;;
  esac
}

lego_supports_shortlived_profile() {
  [[ -x "$LEGO_BIN" ]] || return 1
  local help_text=""
  help_text="$("$LEGO_BIN" run --help 2>&1 || true)"
  [[ "$help_text" == *"--profile"* ]]
}

ensure_lego_installed() {
  if [[ -x "$LEGO_BIN" ]]; then
    if lego_supports_shortlived_profile; then
      log "lego binary already installed at ${LEGO_BIN}."
      return 0
    fi
    warn "Existing lego binary at ${LEGO_BIN} does not support --profile; upgrading."
  fi

  local latest_url=""
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/go-acme/lego/releases/latest)" || {
    warn "Unable to resolve latest lego release URL."
    return 1
  }
  local latest_tag="${latest_url##*/}"
  if [[ -z "$latest_tag" ]]; then
    warn "Unable to determine latest lego release tag."
    return 1
  fi

  local arch=""
  arch="$(map_lego_arch)" || return 1
  local asset="lego_${latest_tag}_linux_${arch}.tar.gz"
  local download_url="https://github.com/go-acme/lego/releases/download/${latest_tag}/${asset}"
  local tmp_dir=""
  tmp_dir="$(mktemp -d)"

  log "Downloading lego ${latest_tag} for linux/${arch}..."
  curl -fsSL "$download_url" -o "${tmp_dir}/${asset}" || {
    run_silent run_as_root rm -rf "$tmp_dir"
    warn "Unable to download lego binary from ${download_url}"
    return 1
  }

  run_silent run_as_root tar -xzf "${tmp_dir}/${asset}" -C "$tmp_dir" || {
    run_silent run_as_root rm -rf "$tmp_dir"
    return 1
  }
  run_silent run_as_root install -m 755 "${tmp_dir}/lego" "$LEGO_BIN" || {
    run_silent run_as_root rm -rf "$tmp_dir"
    return 1
  }
  run_silent run_as_root rm -rf "$tmp_dir" || return 1
  log "Installed lego at ${LEGO_BIN}."

  if ! lego_supports_shortlived_profile; then
    warn "Installed lego at ${LEGO_BIN} does not support --profile. Please verify the binary and try again."
    return 1
  fi
}

# Runs a command up to three times: one dropped connection should not fail an install.
run_with_retries() {
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if (( attempt >= 3 )); then
      return 1
    fi
    attempt=$((attempt + 1))
    warn "That failed; trying again (attempt ${attempt} of 3)."
    sleep 3
  done
}

# The branch or tag the installation follows: REPO_BRANCH, else the default branch
# of the repository (main on GitHub).
repo_target_ref() {
  local ref="$REPO_BRANCH"
  if [[ -z "$ref" ]]; then
    ref="$(run_in_install_dir_output "git symbolic-ref --quiet --short refs/remotes/origin/HEAD" 2>/dev/null | tr -d '\r\n')" || ref=""
    ref="${ref#origin/}"
  fi
  printf '%s' "${ref:-main}"
}

# The commit the branch (or tag) points at on the remote, after a fetch.
repo_remote_commit() {
  local ref="$1"
  local commit=""
  commit="$(run_in_install_dir_output "git rev-parse origin/${ref}" 2>/dev/null | tr -d '\r\n')" || commit=""
  if [[ -z "$commit" ]]; then
    commit="$(run_in_install_dir_output "git rev-parse 'refs/tags/${ref}^{commit}'" 2>/dev/null | tr -d '\r\n')" || commit=""
  fi
  printf '%s' "$commit"
}

# npm may rewrite the lock files while installing. They are not edits worth keeping,
# and they stop git from moving to a newer commit.
discard_lockfile_changes() {
  # shellcheck disable=SC2016
  run_in_install_dir 'for f in package-lock.json server/package-lock.json worker/package-lock.json client/package-lock.json; do if [ -f "$f" ]; then git checkout -- "$f" 2>/dev/null; fi; done; true' || true
}

# The installer makes tracked files executable (the data command launcher is copied with
# mode 755): without this git reports them as edited and refuses to move to a newer commit.
ignore_checkout_file_modes() {
  run_in_install_dir "git config core.fileMode false" || true
}

# Fetches and moves the checkout to the newest commit of the branch (or to the tag).
sync_repo_to_ref() {
  local ref=""
  ignore_checkout_file_modes
  discard_lockfile_changes
  run_with_retries run_in_install_dir "git fetch --force --prune --tags origin" || return 1
  ref="$(repo_target_ref)"
  if run_in_install_dir_output "git show-ref --verify --quiet 'refs/remotes/origin/${ref}'" >/dev/null 2>&1; then
    run_in_install_dir "git checkout -q -B '${ref}' 'origin/${ref}'" || {
      warn "Could not switch ${INSTALL_DIR} to ${ref}. If files in it were edited by hand, see: git -C ${INSTALL_DIR} status"
      return 1
    }
  elif run_in_install_dir_output "git show-ref --verify --quiet 'refs/tags/${ref}'" >/dev/null 2>&1; then
    run_in_install_dir "git checkout -q --detach 'refs/tags/${ref}'" || return 1
  else
    warn "Neither a branch nor a tag called ${ref} exists in ${REPO_URL}."
    return 1
  fi
  log "Source is at ${ref} ($(run_in_install_dir_output "git rev-parse --short HEAD" 2>/dev/null | tr -d '\r\n'))."
}

clone_repo() {
  run_silent run_as_root mkdir -p "$INSTALL_DIR" || return 1

  if run_as_root test -d "$INSTALL_DIR/.git"; then
    log "Repository exists at ${INSTALL_DIR}. Updating source..."
    ensure_git_safe_directory || return 1
    sync_repo_to_ref || return 1
    return 0
  fi

  if dir_has_entries "$INSTALL_DIR"; then
    if [[ "$(prompt_yes_no "${INSTALL_DIR} exists and is not empty. Delete it and re-clone from GitHub?" "no")" != "yes" ]]; then
      warn "${INSTALL_DIR} exists, is not empty and is not an Aurelle checkout. Move it away (or clear it) and run the installer again."
      return 1
    fi
    run_as_root rm -rf "$INSTALL_DIR" || return 1
    run_silent run_as_root mkdir -p "$INSTALL_DIR" || return 1
  fi

  local clone_args=()
  local clone_env=()
  if [[ -n "$REPO_BRANCH" ]]; then
    clone_args=(--branch "$REPO_BRANCH")
  fi
  if is_unattended; then
    clone_env=(env GIT_TERMINAL_PROMPT=0)
  fi
  log "Cloning Aurelle repository${REPO_BRANCH:+ (${REPO_BRANCH})}..."
  if ! run_with_retries run_silent run_as_root "${clone_env[@]}" git clone "${clone_args[@]}" -- "$REPO_URL" "$INSTALL_DIR"; then
    warn "Could not clone ${REPO_URL}${REPO_BRANCH:+ (${REPO_BRANCH})}. Check the address and the network (a private repository needs credentials, which an unattended run cannot ask for)."
    return 1
  fi
  ignore_checkout_file_modes
}

prepare_install_dir_for_offline() {
  run_silent run_as_root mkdir -p "$INSTALL_DIR"
  if dir_has_entries "$INSTALL_DIR"; then
    warn "${INSTALL_DIR} is not empty. Clear it before installation."
    press_enter_to_continue
    return 1
  fi
  return 0
}

find_offline_source_zip() {
  local zip_name="songbird.zip"
  local candidates=(
    "$(pwd)/${zip_name}"
    "$HOME/${zip_name}"
    "/root/${zip_name}"
    "/${zip_name}"
  )
  local candidate=""
  for candidate in "${candidates[@]}"; do
    if file_exists_path "$candidate"; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

find_restore_backup_path() {
  local extension=""
  extension="$(database_backup_extension)"
  local candidates=(
    "/opt/songbird/data/backups"
    "/root"
  )
  local dir=""
  for dir in "${candidates[@]}"; do
    local found=""
    found="$(run_as_root_output bash -lc "find '$dir' -maxdepth 1 -type f -name 'songbird-backup-*${extension}' -printf '%T@\t%p\n' 2>/dev/null | sort -nr | head -1 | cut -f2-" | tr -d '\r\n')" || found=""
    if [[ -n "$found" && -f "$found" ]]; then
      printf "%s" "$found"
      return 0
    fi
  done
  return 1
}

resolve_offline_source_root() {
  local tmp_dir="$1"
  if [[ -f "$tmp_dir/package.json" && -d "$tmp_dir/server" && -d "$tmp_dir/client" && -d "$tmp_dir/worker" ]]; then
    printf "%s" "$tmp_dir"
    return 0
  fi
  local match=""
  local dir=""
  while IFS= read -r dir; do
    [[ -z "$dir" ]] && continue
    if [[ -f "$dir/package.json" && -d "$dir/server" && -d "$dir/client" && -d "$dir/worker" ]]; then
      if [[ -n "$match" ]]; then
        return 1
      fi
      match="$dir"
    fi
  done < <(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d)

  if [[ -n "$match" ]]; then
    printf "%s" "$match"
    return 0
  fi

  return 1
}

ensure_offline_source_ready() {
  local mode_label="$1"
  local zip_path=""
  zip_path="$(find_offline_source_zip)" || zip_path=""
  if [[ -z "$zip_path" ]]; then
    warn "Offline ${mode_label} requires songbird.zip to be available in the current directory, user home, /root, or /."
    press_enter_to_continue
    return 1
  fi
  SOURCE_ZIP_PATH="$zip_path"
  return 0
}

extract_offline_source_zip() {
  local zip_path="$1"
  local mode_label="$2"
  if ! have_cmd unzip; then
    warn "unzip is required for offline ${mode_label}s. Install it first and retry."
    return 1
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  if ! run_silent run_as_root unzip -q "$zip_path" -d "$tmp_dir"; then
    run_silent run_as_root rm -rf "$tmp_dir"
    return 1
  fi

  local source_root
  source_root="$(resolve_offline_source_root "$tmp_dir")" || {
    run_silent run_as_root rm -rf "$tmp_dir"
    warn "Source zip does not appear to contain Aurelle (missing server/client/worker/package.json)."
    return 1
  }

  printf "%s|%s" "$tmp_dir" "$source_root"
}

read_version_value() {
  local version_file="$1"
  if [[ ! -f "$version_file" ]]; then
    return 1
  fi
  local version=""
  version="$(head -n 1 "$version_file" | tr -d '\r\n' | xargs)"
  if [[ -z "$version" ]]; then
    return 1
  fi
  printf "%s" "$version"
}

compare_offline_source_version() {
  local __cosv_source_root="$1"
  local __cosv_install_root="$2"
  local __cosv_op_or_var="${3:-}"

  local __cosv_source_version_file="${__cosv_source_root}/VERSION"
  local __cosv_install_version_file="${__cosv_install_root}/VERSION"
  local __cosv_source_version=""
  local __cosv_install_version=""

  __cosv_source_version="$(read_version_value "$__cosv_source_version_file")" || {
    warn "Offline source is missing VERSION. Skipping update."
    return 1
  }

  __cosv_install_version="$(read_version_value "$__cosv_install_version_file")" || __cosv_install_version=""
  if [[ -z "$__cosv_install_version" ]]; then
    log "Installed app is missing VERSION. Treating offline source ${__cosv_source_version} as newer."
    case "$__cosv_op_or_var" in
      gt|newer|higher) return 0 ;;
      lt|lower|eq|same|equal) return 1 ;;
      "")
        printf "%s\n" "newer"
        return 0
        ;;
      *)
        printf -v "$__cosv_op_or_var" "%s" "newer"
        return 0
        ;;
    esac
  fi

  local __cosv_relation=""
  if dpkg --compare-versions "$__cosv_source_version" gt "$__cosv_install_version"; then
    log "Offline source version ${__cosv_source_version} is newer than installed version ${__cosv_install_version}."
    __cosv_relation="newer"
  elif dpkg --compare-versions "$__cosv_source_version" lt "$__cosv_install_version"; then
    log "Offline source version ${__cosv_source_version} is lower than installed version ${__cosv_install_version}."
    __cosv_relation="lower"
  elif dpkg --compare-versions "$__cosv_source_version" eq "$__cosv_install_version"; then
    log "Offline source version ${__cosv_source_version} is the same as installed version ${__cosv_install_version}."
    __cosv_relation="same"
  else
    return 1
  fi

  case "$__cosv_op_or_var" in
    gt|newer|higher)
      [[ "$__cosv_relation" == "newer" ]]
      return $?
      ;;
    lt|lower)
      [[ "$__cosv_relation" == "lower" ]]
      return $?
      ;;
    eq|same|equal)
      [[ "$__cosv_relation" == "same" ]]
      return $?
      ;;
    "")
      printf "%s\n" "$__cosv_relation"
      return 0
      ;;
    *)
      printf -v "$__cosv_op_or_var" "%s" "$__cosv_relation"
      return 0
      ;;
  esac
}

offline_source_is_newer() {
  compare_offline_source_version "$1" "$2" "newer"
}

offline_source_is_lower() {
  compare_offline_source_version "$1" "$2" "lower"
}

offline_source_is_same() {
  compare_offline_source_version "$1" "$2" "same"
}

resolve_git_version_ref() {
  local version="$1"
  version="$(sanitize_input_value "$version")"
  if [[ -z "$version" ]]; then
    return 1
  fi

  local escaped_ver=""
  escaped_ver="$(printf '%s' "$version" | tr -d "'")"
  local ref=""

  ref="$(run_in_install_dir_output "git rev-parse --verify --quiet 'refs/tags/${escaped_ver}'" 2>/dev/null | tr -d '\r\n')"
  if [[ -n "$ref" ]]; then
    printf "%s" "refs/tags/${escaped_ver}"
    return 0
  fi

  ref="$(run_in_install_dir_output "git rev-parse --verify --quiet 'refs/tags/v${escaped_ver}'" 2>/dev/null | tr -d '\r\n')"
  if [[ -n "$ref" ]]; then
    printf "%s" "refs/tags/v${escaped_ver}"
    return 0
  fi

  ref="$(run_in_install_dir_output "git rev-parse --verify --quiet '${escaped_ver}'" 2>/dev/null | tr -d '\r\n')"
  if [[ -n "$ref" ]]; then
    printf "%s" "${escaped_ver}"
    return 0
  fi

  return 1
}

install_source_from_zip() {
  local zip_path="$1"
  prepare_install_dir_for_offline || return 1
  local extract_result=""
  extract_result="$(extract_offline_source_zip "$zip_path" "install")" || return 1
  local tmp_dir="${extract_result%%|*}"
  local source_root="${extract_result#*|}"

  run_silent run_as_root cp -a "$source_root"/. "$INSTALL_DIR"/ || {
    run_silent run_as_root rm -rf "$tmp_dir"
    return 1
  }
  if [[ -f "$source_root/.env.example" ]]; then
    run_silent run_as_root cp -a "$source_root/.env.example" "$INSTALL_DIR/.env.example" || {
      run_silent run_as_root rm -rf "$tmp_dir"
      return 1
    }
  fi
  apply_ownership || {
    run_silent run_as_root rm -rf "$tmp_dir"
    return 1
  }
  run_silent run_as_root rm -rf "$tmp_dir" || return 1
  return 0
}

update_source_from_zip() {
  local zip_path="$1"
  local extract_result=""
  extract_result="$(extract_offline_source_zip "$zip_path" "update")" || return 1
  local tmp_dir="${extract_result%%|*}"
  local source_root="${extract_result#*|}"

  run_silent run_as_root cp -a "$source_root"/. "$INSTALL_DIR"/ || {
    run_silent run_as_root rm -rf "$tmp_dir"
    return 1
  }
  if [[ -f "$source_root/.env.example" ]]; then
    run_silent run_as_root cp -a "$source_root/.env.example" "$INSTALL_DIR/.env.example" || {
      run_silent run_as_root rm -rf "$tmp_dir"
      return 1
    }
  fi
  apply_ownership || {
    run_silent run_as_root rm -rf "$tmp_dir"
    return 1
  }
  run_silent run_as_root rm -rf "$tmp_dir" || return 1
}

install_songbird_dependencies() {
  local npm_registry_arg=""
  local package=""
  if [[ -n "$MIRROR_NPM" ]]; then
    npm_registry_arg="--registry $(printf '%q' "$MIRROR_NPM")"
  fi

  # "npm ci" installs exactly what the lock file says and never rewrites it; "npm
  # install" is the fallback for a lock file that is out of step.
  for package in server worker client; do
    log "Installing ${package} dependencies..."
    run_in_install_dir "npm ${npm_registry_arg} --prefix ${package} ci --no-audit --no-fund --loglevel=error || npm ${npm_registry_arg} --prefix ${package} install --no-audit --no-fund --loglevel=error" || return 1
  done
  discard_lockfile_changes

  build_client || return 1
}

# Builds the client. The build before it is kept until the new one exists, so a
# failed build does not take the running site down.
build_client() {
  log "Building client..."
  run_in_install_dir 'if [ -d client/dist ]; then rm -rf client/dist.previous && mv client/dist client/dist.previous; fi; true' || return 1
  if ! run_in_install_dir "npm --prefix client run build"; then
    run_in_install_dir 'rm -rf client/dist; if [ -d client/dist.previous ]; then mv client/dist.previous client/dist; fi; true' || true
    warn "The client build failed; the previous build (if there was one) is back in place."
    return 1
  fi
  run_in_install_dir 'rm -rf client/dist.previous; true' || true
}

# Prints an env file. It holds the secrets of the installation and is not readable by
# every local user (apply_ownership), so a caller that is not root goes through sudo.
read_env_file() {
  cat "$1" 2>/dev/null || run_as_root cat "$1" 2>/dev/null || true
}

get_existing_env_value() {
  local key="$1"
  local default="$2"
  local env_file="$INSTALL_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    printf "%s" "$default"
    return 0
  fi
  local existing
  existing="$(read_env_file "$env_file" | grep -E "^${key}=" | tail -n 1 | cut -d "=" -f 2- || true)"
  if [[ -z "$existing" ]]; then
    printf "%s" "$default"
  else
    printf "%s" "$existing"
  fi
}

get_existing_env_value_with_fallback() {
  local primary="$1"
  local fallback="$2"
  local default="$3"
  local env_file="$INSTALL_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    printf "%s" "$default"
    return 0
  fi
  local existing
  existing="$(read_env_file "$env_file" | grep -E "^${primary}=" | tail -n 1 | cut -d "=" -f 2- || true)"
  if [[ -n "$existing" ]]; then
    printf "%s" "$existing"
    return 0
  fi
  if [[ -n "$fallback" ]]; then
    existing="$(read_env_file "$env_file" | grep -E "^${fallback}=" | tail -n 1 | cut -d "=" -f 2- || true)"
    if [[ -n "$existing" ]]; then
      printf "%s" "$existing"
      return 0
    fi
  fi
  printf "%s" "$default"
}

bytes_to_mb_rounded_up() {
  local bytes="$(printf "%s" "$1" | tr -d '[:space:]')"
  if [[ -z "$bytes" || ! "$bytes" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf "%s" "$(((bytes + 1048576 - 1) / 1048576))"
}

get_existing_env_mb_value_with_fallback() {
  local primary="$1"
  local legacy_bytes_key="$2"
  local default="$3"
  local env_file="$INSTALL_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    printf "%s" "$default"
    return 0
  fi

  local existing
  existing="$(read_env_file "$env_file" | grep -E "^${primary}=" | tail -n 1 | cut -d "=" -f 2- || true)"
  if [[ -n "$existing" ]]; then
    printf "%s" "$existing"
    return 0
  fi

  local legacy_bytes
  legacy_bytes="$(read_env_file "$env_file" | grep -E "^${legacy_bytes_key}=" | tail -n 1 | cut -d "=" -f 2- || true)"
  if [[ -n "$legacy_bytes" ]]; then
    local converted=""
    converted="$(bytes_to_mb_rounded_up "$legacy_bytes")" || converted=""
    if [[ -n "$converted" ]]; then
      printf "%s" "$converted"
      return 0
    fi
  fi

  printf "%s" "$default"
}

replace_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local escaped
  local current_content
  # One line per setting: a line break would start another one.
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    warn "Not writing ${key}: its value has a line break."
    return 1
  fi
  # | is the delimiter of the sed command below, & and \ are special in its replacement.
  escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
  # The content goes through a variable: "grep -q" ends the pipe early and, with
  # pipefail, a cat that was cut off would read as "no such key" and append a duplicate.
  current_content="$(read_env_file "$env_file")"
  if grep -qE "^${key}=" <<< "$current_content"; then
    run_silent run_as_root sed -i "s|^${key}=.*|${key}=${escaped}|" "$env_file"
  else
    # The line is data on stdin, never part of a command string.
    # shellcheck disable=SC2016
    printf '%s\n' "${key}=${value}" | run_silent run_as_root bash -c 'cat >> "$1"' _ "$env_file"
  fi
}

write_env_from_example() {
  local env_file="${INSTALL_DIR}/.env"
  write_env_fallback "$env_file" || return 1
  CURRENT_ENV_FILE="$env_file"
}

# 32 random bytes as lowercase hex.
generate_secret_hex() {
  local value=""
  value="$(od -An -tx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \n' || true)"
  if [[ ! "$value" =~ ^[0-9a-f]{64}$ ]]; then
    return 1
  fi
  printf "%s" "$value"
}

# 32 random bytes as unpadded base64url.
generate_secret_base64url() {
  local value=""
  value="$(head -c 32 /dev/urandom 2>/dev/null | base64 2>/dev/null | tr -d '\n' | tr '+/' '-_' | tr -d '=' || true)"
  if [[ ! "$value" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    return 1
  fi
  printf "%s" "$value"
}

# Query one secret from a PostgreSQL database.
read_postgres_secret() {
  local key="$1"
  local value=""
  local postgres_url
  postgres_url="$(get_existing_env_value "POSTGRES_URL" "${POSTGRES_URL:-}")"
  local ssl_mode="prefer"
  if [[ "$(get_existing_env_value "POSTGRES_SSL" "${POSTGRES_SSL:-false}")" == "true" ]]; then
    ssl_mode="require"
  fi

  if [[ -n "$postgres_url" ]]; then
    value="$(psql "$postgres_url" -tA -c "SELECT value FROM app_settings WHERE key='${key}' LIMIT 1" 2>/dev/null || true)"
  else
    value="$(PGPASSWORD="$POSTGRES_PASSWORD" PGSSLMODE="$ssl_mode" psql \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -tA -c "SELECT value FROM app_settings WHERE key='${key}' LIMIT 1" 2>/dev/null || true)"
  fi
  value="$(printf "%s" "$value" | tr -d '\r\n ' || true)"
  if [[ -z "$value" ]]; then
    return 1
  fi
  printf "%s" "$value"
}

# True when PostgreSQL is reachable.
postgres_is_reachable() {
  local postgres_url
  postgres_url="$(get_existing_env_value "POSTGRES_URL" "${POSTGRES_URL:-}")"
  local ssl_mode="prefer"
  if [[ "$(get_existing_env_value "POSTGRES_SSL" "${POSTGRES_SSL:-false}")" == "true" ]]; then
    ssl_mode="require"
  fi

  if [[ -n "$postgres_url" ]]; then
    psql "$postgres_url" -tA -c "SELECT 1" >/dev/null 2>&1
  else
    PGPASSWORD="$POSTGRES_PASSWORD" PGSSLMODE="$ssl_mode" psql \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -tA -c "SELECT 1" >/dev/null 2>&1
  fi
}

# True when PostgreSQL has existing tables in the public schema.
postgres_has_tables() {
  local count=""
  local postgres_url
  postgres_url="$(get_existing_env_value "POSTGRES_URL" "${POSTGRES_URL:-}")"
  local ssl_mode="prefer"
  if [[ "$(get_existing_env_value "POSTGRES_SSL" "${POSTGRES_SSL:-false}")" == "true" ]]; then
    ssl_mode="require"
  fi

  if [[ -n "$postgres_url" ]]; then
    count="$(psql "$postgres_url" -tA -c "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' LIMIT 1" 2>/dev/null || true)"
  else
    count="$(PGPASSWORD="$POSTGRES_PASSWORD" PGSSLMODE="$ssl_mode" psql \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -tA -c "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' LIMIT 1" 2>/dev/null || true)"
  fi
  count="$(printf "%s" "$count" | tr -d '\r\n ' || true)"
  [[ "$count" == "1" ]]
}

is_postgres_client() {
  [[ "$DB_CLIENT" == "postgres" || "$DB_CLIENT" == "postgresql" || "$DB_CLIENT" == "pg" ]]
}

# Ensure one secret exists in .env without ever rotating a live value.
# Generation happens only when no keyed source exists anywhere:
#  - a non-empty .env value always wins (never rotate live secrets);
#  - a restored backup is authoritative (the server restores from the DB);
#  - a reachable database holding the key is adopted, not replaced;
#  - an existing database with tables is left for the server to restore from;
#  - otherwise the database must be provably fresh (absent sqlite file, or
#    reachable postgres with no tables).
# Anything uncertain is left empty for the server, which applies the same
ensure_env_secret() {
  local key="$1"
  local format="$2"
  local env_file="${INSTALL_DIR}/.env"
  local current=""
  current="$(get_existing_env_value "$key" "")"
  if [[ -n "$current" ]]; then
    return 0
  fi

  local generated=""
  if is_postgres_client; then
    local db_value=""
    if db_value="$(read_postgres_secret "$key")"; then
      replace_env_value "$env_file" "$key" "$db_value" || return 1
      log "Adopted existing ${key} from the database."
      return 0
    fi
    if postgres_has_tables; then
      log "Existing PostgreSQL tables found; leaving ${key} for the server to restore from it."
      return 0
    fi
    # Reachable and confirmed empty of tables means provably fresh.
    if postgres_is_reachable; then
      if [[ "$format" == "hex" ]]; then
        generated="$(generate_secret_hex || true)"
      else
        generated="$(generate_secret_base64url || true)"
      fi
    else
      log "PostgreSQL is not reachable; leaving ${key} for the server to resolve on first boot."
      return 0
    fi
  else
    local data_dir=""
    data_dir="$(get_existing_env_value "DATA_DIR" "${INSTALL_DIR}/data")"
    if [[ -f "${data_dir}/songbird.db" ]]; then
      log "Existing SQLite database found; leaving ${key} for the server to restore from it."
      return 0
    fi
    if [[ "$format" == "hex" ]]; then
      generated="$(generate_secret_hex || true)"
    else
      generated="$(generate_secret_base64url || true)"
    fi
  fi

  if [[ -z "$generated" ]]; then
    warn "Could not generate ${key}; leaving it for the server to resolve on first boot."
    return 0
  fi
  replace_env_value "$env_file" "$key" "$generated" || return 1
  log "Generated ${key} during install."
  return 0
}

# Pre-generate server secrets into .env .
pregenerate_missing_secrets() {
  if [[ -n "${DB_BACKUP_PATH:-}" ]]; then
    log "Backup was restored; leaving secrets for the server to restore from the database."
    return 0
  fi
  ensure_env_secret "STORAGE_ENCRYPTION_KEY" "base64url" || true
  ensure_env_secret "WEBHOOK_SECRET" "hex" || true
  ensure_env_secret "ADMIN_API_TOKEN" "base64url" || true
  return 0
}

# Keys the generated .env has a line for. Any other key in an existing file (the
# calls relay, a push proxy, tuning the owner did by hand) is carried over.
ENV_TEMPLATE_KEYS=" SERVER_PORT CLIENT_PORT APP_ENV DB_CLIENT POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD POSTGRES_URL POSTGRES_SSL STORAGE_ENCRYPTION_KEY ADMIN_API_TOKEN WEBHOOK_SECRET VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT WORKER_PORT WORKER_URL WEBHOOK_URL PORT "

# Prints the KEY=value lines of an env file that the generated file would lose.
collect_preserved_env_lines() {
  local env_file="$1"
  local line=""
  local key=""
  run_as_root test -f "$env_file" || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    if [[ "$ENV_TEMPLATE_KEYS" != *" ${key} "* ]]; then
      printf '%s\n' "$line"
    fi
  done < <(run_as_root cat "$env_file" 2>/dev/null)
}

write_env_fallback() {
  local env_file="$1"
  local preserved_lines=""
  local existing_storage_encryption_key
  local existing_admin_api_token
  local existing_webhook_secret
  local existing_public_key
  local existing_private_key
  local existing_subject
  existing_storage_encryption_key="$(get_existing_env_value "STORAGE_ENCRYPTION_KEY" "")"
  existing_admin_api_token="$(get_existing_env_value "ADMIN_API_TOKEN" "")"
  existing_webhook_secret="$(get_existing_env_value "WEBHOOK_SECRET" "")"
  existing_public_key="$(get_existing_env_value "VAPID_PUBLIC_KEY" "")"
  existing_private_key="$(get_existing_env_value "VAPID_PRIVATE_KEY" "")"
  existing_subject="$(get_existing_env_value "VAPID_SUBJECT" "mailto:admin@example.com")"
  preserved_lines="$(collect_preserved_env_lines "$env_file")"
  # One setting per line: a value with a line break would add settings of its own.
  local checked_value=""
  for checked_value in "$SERVER_PORT" "$CLIENT_PORT" "$WORKER_PORT" "${DB_CLIENT:-}" "${POSTGRES_HOST:-}" "${POSTGRES_PORT:-}" \
      "${POSTGRES_DB:-}" "${POSTGRES_USER:-}" "${POSTGRES_PASSWORD:-}" "${POSTGRES_URL:-}" "${POSTGRES_SSL:-}" "$existing_subject"; do
    if [[ "$checked_value" == *[[:cntrl:]]* ]]; then
      warn "Not writing ${env_file}: one of the settings has a line break or control character in it."
      return 1
    fi
  done
  # The text goes to a root shell on stdin, so no value in it can be read as a command (the
  # old form built one shell string around it). The file is created private: it holds keys.
  local env_content=""
  env_content="$(cat <<EOF
# Server Configuration
SERVER_PORT=${SERVER_PORT}
CLIENT_PORT=${CLIENT_PORT}

# Application Settings
APP_ENV=production

# Database Configuration
DB_CLIENT=${DB_CLIENT:-sqlite3}
POSTGRES_HOST=${POSTGRES_HOST:-127.0.0.1}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_DB=${POSTGRES_DB:-songbird}
POSTGRES_USER=${POSTGRES_USER:-postgres}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}
POSTGRES_URL=${POSTGRES_URL:-}
POSTGRES_SSL=${POSTGRES_SSL:-false}

# Security & Encryption
# Generated during install when safe to do so, otherwise auto-generated by
# the server on first boot if left empty. Never edited while set: rotating
# these would orphan encrypted data and desync the media worker.
STORAGE_ENCRYPTION_KEY=${existing_storage_encryption_key}
# Token gating the local-only admin endpoint. Same generation rules as above.
ADMIN_API_TOKEN=${existing_admin_api_token}
# Shared secret authenticating server <-> media worker callbacks.
WEBHOOK_SECRET=${existing_webhook_secret}

# Push Notifications
VAPID_PUBLIC_KEY=${existing_public_key}
VAPID_PRIVATE_KEY=${existing_private_key}
VAPID_SUBJECT=${existing_subject}

# Media Processing Worker
WORKER_PORT=${WORKER_PORT}
WORKER_URL=http://127.0.0.1:${WORKER_PORT}
WEBHOOK_URL=http://127.0.0.1:${SERVER_PORT}/api/uploads/webhook/processed

# NOTE: All other application settings (sign-up, file uploads, retention,
# limits, remote channel, client tuning, push proxy, etc.) are configured from
# the in-app Admin Panel after installation.
EOF
)"
  # shellcheck disable=SC2016
  printf '%s\n' "$env_content" | run_silent run_as_root bash -c 'umask 077; cat > "$1"' _ "$env_file" || return 1
  if [[ -n "$preserved_lines" ]]; then
    printf '\n# Kept from the previous .env\n%s\n' "$preserved_lines" | run_as_root tee -a "$env_file" >/dev/null || return 1
    log "Kept $(printf '%s\n' "$preserved_lines" | wc -l | tr -d ' ') setting(s) from the previous .env."
  fi
  if [[ -n "$CERTBOT_EMAIL" ]]; then
    replace_env_value "$env_file" "VAPID_SUBJECT" "mailto:${CERTBOT_EMAIL}" || return 1
  fi
  log "Wrote environment config to ${env_file}."
}

ensure_vapid_keys() {
  local env_file="${INSTALL_DIR}/.env"
  local public_key
  local private_key
  public_key="$(get_existing_env_value "VAPID_PUBLIC_KEY" "")"
  private_key="$(get_existing_env_value "VAPID_PRIVATE_KEY" "")"
  if [[ -n "$public_key" && -n "$private_key" ]]; then
    log "VAPID keys already present. Skipping generation."
    return 0
  fi
  if [[ -n "${DB_BACKUP_PATH:-}" ]]; then
    log "Backup was restored; leaving VAPID keys for the server to restore from the database."
    return 0
  fi
  if is_postgres_client && postgres_has_tables; then
    log "Existing PostgreSQL tables found; leaving VAPID keys for the server to restore from the database."
    return 0
  fi
  local data_dir=""
  data_dir="$(get_existing_env_value "DATA_DIR" "${INSTALL_DIR}/data")"
  if ! is_postgres_client && [[ -f "${data_dir}/songbird.db" ]]; then
    log "Existing SQLite database found; leaving VAPID keys for the server to restore from the database."
    return 0
  fi
  log "Generating VAPID keys..."
  local keys
  local path_prefix=""
  local path_export=""
  path_prefix="$(node_tools_path_prefix)"
  if [[ -n "$path_prefix" ]]; then
    path_export="export PATH=$(printf '%q' "$path_prefix"):\$PATH; "
  fi
  local stdout_file=""
  local stderr_file=""
  local generate_command=""
  stdout_file="$(mktemp)" || return 1
  stderr_file="$(mktemp)" || {
    rm -f "$stdout_file"
    return 1
  }
  generate_command="cd '$INSTALL_DIR/server' && ${path_export}node --input-type=module -e \"import pkg from 'web-push'; const { generateVAPIDKeys } = pkg; const k = generateVAPIDKeys(); console.log(k.publicKey); console.log(k.privateKey);\""
  if [[ -f "$LOG_FILE" ]]; then
    log_to_file "$(printf "[%s] Running: generate VAPID keys\n" "$(date '+%Y-%m-%d %H:%M:%S')")"
  fi
  if ! run_as_root bash -lc "$generate_command" >"$stdout_file" 2>"$stderr_file"; then
    local vapid_error=""
    vapid_error="$(cat "$stderr_file" "$stdout_file" 2>/dev/null || true)"
    if [[ -f "$LOG_FILE" ]]; then
      log_to_file "$(printf "[%s] FAILED: generate VAPID keys\n%s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$vapid_error")"
    fi
    [[ -n "$vapid_error" ]] && printf "%s\n" "$vapid_error"
    rm -f "$stdout_file" "$stderr_file"
    warn "Failed to generate VAPID keys. Make sure server dependencies are installed."
    return 1
  fi
  keys="$(cat "$stdout_file" 2>/dev/null || true)"
  rm -f "$stdout_file" "$stderr_file"
  local new_public=""
  local new_private=""
  new_public="$(printf "%s\n" "$keys" | sed -n '1p' | tr -d '\r')"
  new_private="$(printf "%s\n" "$keys" | sed -n '2p' | tr -d '\r')"
  if [[ -z "$new_public" || -z "$new_private" ]]; then
    if [[ -f "$LOG_FILE" ]]; then
      log_to_file "$(printf "[%s] FAILED: generate VAPID keys\nExpected public/private key output, but received incomplete output. Raw key output redacted.\n" "$(date '+%Y-%m-%d %H:%M:%S')")"
    fi
    warn "VAPID key generation returned incomplete output."
    return 1
  fi
  if [[ -f "$LOG_FILE" ]]; then
    log_to_file "$(printf "[%s] SUCCESS: generate VAPID keys\n(output redacted)\n" "$(date '+%Y-%m-%d %H:%M:%S')")"
  fi
  replace_env_value "$env_file" "VAPID_PUBLIC_KEY" "$new_public" || return 1
  replace_env_value "$env_file" "VAPID_PRIVATE_KEY" "$new_private" || return 1
  log "VAPID keys generated and saved to ${env_file}."
}

open_env_editor() {
  local env_file="$1"
  local editor_cmd="${EDITOR:-nano}"
  if ! have_cmd "$editor_cmd"; then
    editor_cmd="vi"
  fi

  log "Opening ${env_file} with ${editor_cmd}. Save and close to continue."

  if [[ -n "$SUDO" ]]; then
    $SUDO -t "$editor_cmd" "$env_file"
  else
    "$editor_cmd" "$env_file"
  fi

  clear_screen
}

sync_values_from_env() {
  local env_file="$INSTALL_DIR/.env"
  SERVER_PORT="$(get_existing_env_value_with_fallback "SERVER_PORT" "PORT" "$DEFAULT_SERVER_PORT")"
  CLIENT_PORT="$(get_existing_env_value "CLIENT_PORT" "$DEFAULT_CLIENT_PORT")"
  FILE_UPLOAD="$(get_existing_env_value "FILE_UPLOAD" "$DEFAULT_FILE_UPLOAD")"
  MAX_UPLOAD_MB="$(get_existing_env_mb_value_with_fallback "FILE_UPLOAD_MAX_TOTAL_SIZE_MB" "FILE_UPLOAD_MAX_TOTAL_SIZE" "$DEFAULT_MAX_UPLOAD_MB")"
  RETENTION_DAYS="$(get_existing_env_value "MESSAGE_FILE_RETENTION" "$DEFAULT_RETENTION_DAYS")"
  TEXT_RETENTION_DAYS="$(get_existing_env_value "MESSAGE_TEXT_RETENTION" "$DEFAULT_TEXT_RETENTION_DAYS")"
  ACCOUNT_CREATION="$(get_existing_env_value_with_fallback "SIGN_UP" "ACCOUNT_CREATION" "$DEFAULT_SIGN_UP")"
  DB_CLIENT="$(get_existing_env_value "DB_CLIENT" "$DEFAULT_DB_CLIENT")"
  POSTGRES_HOST="$(get_existing_env_value "POSTGRES_HOST" "$DEFAULT_POSTGRES_HOST")"
  POSTGRES_PORT="$(get_existing_env_value "POSTGRES_PORT" "$DEFAULT_POSTGRES_PORT")"
  POSTGRES_DB="$(get_existing_env_value "POSTGRES_DB" "$DEFAULT_POSTGRES_DB")"
  POSTGRES_USER="$(get_existing_env_value "POSTGRES_USER" "$DEFAULT_POSTGRES_USER")"
  POSTGRES_PASSWORD="$(get_existing_env_value "POSTGRES_PASSWORD" "$DEFAULT_POSTGRES_PASSWORD")"
  POSTGRES_URL="$(get_existing_env_value "POSTGRES_URL" "$DEFAULT_POSTGRES_URL")"
  POSTGRES_SSL="$(get_existing_env_value "POSTGRES_SSL" "$DEFAULT_POSTGRES_SSL")"
  CURRENT_ENV_FILE="$env_file"
}

ensure_local_postgres_setup() {
  sync_values_from_env
  if [[ "$DB_CLIENT" != "postgres" && "$DB_CLIENT" != "postgresql" && "$DB_CLIENT" != "pg" ]]; then
    return 0
  fi
  if [[ -n "$POSTGRES_URL" ]]; then
    if [[ "$POSTGRES_URL" != *"@127.0.0.1"* && "$POSTGRES_URL" != *"@localhost"* && "$POSTGRES_URL" != *"@0.0.0.0"* ]]; then
      return 0
    fi
  fi
  if [[ "$POSTGRES_HOST" != "127.0.0.1" && "$POSTGRES_HOST" != "0.0.0.0" && "$POSTGRES_HOST" != "localhost" ]]; then
    return 0
  fi

  log "Enabling local PostgreSQL service and database configuration..."
  if have_cmd systemctl; then
    run_silent run_as_root systemctl enable --now postgresql || true
  fi

  local pg_ready=false
  local i
  for (( i=1; i<=10; i++ )); do
    if run_as_root sudo -u postgres psql -c '\q' >/dev/null 2>&1; then
      pg_ready=true
      break
    fi
    sleep 1
  done

  if [[ "$pg_ready" != "true" ]]; then
    warn "Local PostgreSQL server is not responding to psql."
    return 1
  fi

  local safe_user safe_pass safe_db safe_user_literal safe_db_literal
  safe_user="$(printf '%s' "$POSTGRES_USER" | sed 's/"/""/g')"
  safe_pass="$(printf '%s' "$POSTGRES_PASSWORD" | sed "s/'/''/g")"
  safe_db="$(printf '%s' "$POSTGRES_DB" | sed 's/"/""/g')"
  safe_user_literal="$(printf '%s' "$POSTGRES_USER" | sed "s/'/''/g")"
  safe_db_literal="$(printf '%s' "$POSTGRES_DB" | sed "s/'/''/g")"

  # Create role if it does not exist
  local role_exists
  role_exists="$(run_as_root sudo -u postgres psql -t -A -c \
    "SELECT 1 FROM pg_roles WHERE rolname = '${safe_user_literal}';" 2>/dev/null || true)"
  role_exists="$(printf '%s' "$role_exists" | tr -d '[:space:]')"
  if [[ "$role_exists" != "1" ]]; then
    run_silent run_as_root sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
      "CREATE ROLE \"${safe_user}\" WITH LOGIN PASSWORD '${safe_pass}';" || return 1
  else
    # Ensure password is set / updated for existing role
    run_silent run_as_root sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
      "ALTER ROLE \"${safe_user}\" WITH LOGIN PASSWORD '${safe_pass}';" || return 1
  fi

  # Create database if it does not exist
  local db_exists
  db_exists="$(run_as_root sudo -u postgres psql -t -A -c \
    "SELECT 1 FROM pg_database WHERE datname = '${safe_db_literal}';" 2>/dev/null || true)"
  db_exists="$(printf '%s' "$db_exists" | tr -d '[:space:]')"
  if [[ "$db_exists" != "1" ]]; then
    run_silent run_as_root sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
      "CREATE DATABASE \"${safe_db}\" OWNER \"${safe_user}\";" || return 1
  fi

  # Grant privileges on database to role
  run_silent run_as_root sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
    "GRANT ALL PRIVILEGES ON DATABASE \"${safe_db}\" TO \"${safe_user}\";" || return 1

  # Ensure role has permissions on public schema in the target database (PostgreSQL 15+)
  run_silent run_as_root sudo -u postgres psql -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c \
    "GRANT ALL ON SCHEMA public TO \"${safe_user}\";" 2>/dev/null || true

  log "Local PostgreSQL database '${POSTGRES_DB}' and user '${POSTGRES_USER}' configured."
}

parse_domain_input() {
  local raw="$1"
  DOMAIN_NAMES=()
  DOMAIN_GROUPS=()
  local seen_names=""
  local IFS=','
  local d
  for d in $raw; do
    d="${d#"${d%%[![:space:]]*}"}"
    d="${d%"${d##*[![:space:]]}"}"
    d="${d#http://}"
    d="${d#https://}"
    d="${d%%/*}"
    d="${d%.}"
    d="$(printf '%s' "$d" | tr '[:upper:]' '[:lower:]')"
    if [[ -n "$d" && "$seen_names" != *"|${d}|"* ]]; then
      DOMAIN_NAMES+=("$d")
      seen_names="${seen_names}|${d}|"
    fi
  done
  # Restore default word-splitting before build_domain_groups runs. Its
  # www/apex pairing logic relies on space-joined membership checks
  # (" ${DOMAIN_NAMES[*]} "), which break while IFS is still a comma.
  unset IFS
  build_domain_groups
  NGINX_SERVER_NAME="${DOMAIN_NAMES[*]}"
}

build_domain_groups() {
  DOMAIN_GROUPS=()

  if (( ${#DOMAIN_NAMES[@]} == 0 )); then
    return 0
  fi

  local grouped_names="|"
  local domain=""
  for domain in "${DOMAIN_NAMES[@]}"; do
    if [[ "$grouped_names" == *"|${domain}|"* ]]; then
      continue
    fi

    local partner=""
    if [[ "$domain" == www.* ]]; then
      partner="${domain#www.}"
      if [[ -n "$partner" && "$grouped_names" != *"|${partner}|"* && " ${DOMAIN_NAMES[*]} " == *" ${partner} "* ]]; then
        DOMAIN_GROUPS+=("${partner},${domain}")
        grouped_names="${grouped_names}${partner}|${domain}|"
        continue
      fi
    else
      partner="www.${domain}"
      if [[ "$grouped_names" != *"|${partner}|"* && " ${DOMAIN_NAMES[*]} " == *" ${partner} "* ]]; then
        DOMAIN_GROUPS+=("${domain},${partner}")
        grouped_names="${grouped_names}${domain}|${partner}|"
        continue
      fi
    fi

    DOMAIN_GROUPS+=("${domain}")
    grouped_names="${grouped_names}${domain}|"
  done
}

group_csv_to_space_list() {
  local csv="${1:-}"
  printf '%s' "${csv//,/ }"
}

group_primary_domain() {
  local csv="${1:-}"
  printf '%s' "${csv%%,*}"
}

manual_cert_group_install_dir() {
  local group_csv="${1:-}"
  local primary_domain=""
  primary_domain="$(group_primary_domain "$group_csv")"
  printf '%s/%s' "$CERT_INSTALL_DIR" "$primary_domain"
}

manual_group_fullchain_path() {
  local group_csv="${1:-}"
  printf '%s/fullchain.pem' "$(manual_cert_group_install_dir "$group_csv")"
}

manual_group_privkey_path() {
  local group_csv="${1:-}"
  printf '%s/privkey.pem' "$(manual_cert_group_install_dir "$group_csv")"
}

log_domain_groups() {
  if (( ${#DOMAIN_GROUPS[@]} == 0 )); then
    return 0
  fi

  local idx=1
  local group_csv=""
  for group_csv in "${DOMAIN_GROUPS[@]}"; do
    log "Detected domain group ${idx}: $(group_csv_to_space_list "$group_csv")"
    idx=$((idx + 1))
  done
}

build_domain_cert_groups() {
  local __result_var="$1"
  local serialized=""

  if [[ ! "$__result_var" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    return 1
  fi

  eval "$__result_var=()"

  if [[ "$DEPLOY_MODE" != "domain" ]]; then
    return 0
  fi

  serialized="$(declare -p DOMAIN_GROUPS)"
  serialized="${serialized#declare -a DOMAIN_GROUPS=}"
  eval "$__result_var=$serialized"
}


collect_install_options() {
  if is_unattended; then
    # resolve_unattended_options already filled everything in.
    return 0
  fi
  prompt_deploy_mode

  if [[ "$DEPLOY_MODE" == "domain" ]]; then
    local raw_domains=""
    while true; do
      prompt_read "Enter your domain(s), comma-separated (e.g. example.com, www.example.com): " raw_domains
      raw_domains="${raw_domains#"${raw_domains%%[![:space:]]*}"}"
      raw_domains="${raw_domains%"${raw_domains##*[![:space:]]}"}"
      if [[ -n "$raw_domains" ]]; then
        parse_domain_input "$raw_domains"
        local bad_domain=""
        local typed_domain=""
        for typed_domain in "${DOMAIN_NAMES[@]}"; do
          if ! is_valid_domain_name "$typed_domain"; then
            bad_domain="$typed_domain"
            break
          fi
        done
        if [[ -n "$bad_domain" ]]; then
          # The names end up in the nginx configuration and in certificate requests.
          printf "%s is not a valid domain name (letters, digits, dots and hyphens only).\n" "${bad_domain//[^[:print:]]/?}"
          continue
        fi
        if (( ${#DOMAIN_NAMES[@]} > 0 )); then
          log_domain_groups
          break
        fi
      fi
      printf "Please enter at least one domain.\n"
    done
  else
    NGINX_SERVER_NAME="_"
  fi

  prompt_cert_mode

  case "$CERT_MODE" in
    certbot)
      while true; do
        CERTBOT_EMAIL="$(prompt_non_empty "Enter email for Let's Encrypt renewal notices")"
        if is_valid_email "$CERTBOT_EMAIL"; then
          break
        fi
        printf "That is not an email address (letters, digits and . _ + - before the @).\n"
      done
      if [[ "$DEPLOY_MODE" == "ip" ]]; then
        while true; do
          CERTBOT_IP_ADDRESS="$(prompt_non_empty "Enter the public IP address for the TLS certificate")"
          if is_valid_ipv4 "$CERTBOT_IP_ADDRESS"; then
            break
          fi
          printf "That is not an IPv4 address (for example 203.0.113.7).\n"
        done
        NGINX_SERVER_NAME="$CERTBOT_IP_ADDRESS"
      fi
      ;;
    files)
      MANUAL_CERT_GROUP_FULLCHAIN_PATHS=()
      MANUAL_CERT_GROUP_PRIVKEY_PATHS=()
      if [[ "$DEPLOY_MODE" == "domain" ]]; then
        local group_csv=""
        for group_csv in "${DOMAIN_GROUPS[@]}"; do
          while true; do
            MANUAL_CERT_FULLCHAIN_PATH="$(prompt_non_empty "Enter path to fullchain.pem for $(group_csv_to_space_list "$group_csv")")"
            MANUAL_CERT_FULLCHAIN_PATH="$(resolve_file_path "$MANUAL_CERT_FULLCHAIN_PATH")" || MANUAL_CERT_FULLCHAIN_PATH=""
            if [[ -n "$MANUAL_CERT_FULLCHAIN_PATH" ]]; then
              MANUAL_CERT_GROUP_FULLCHAIN_PATHS+=("$MANUAL_CERT_FULLCHAIN_PATH")
              break
            fi
            printf "Could not find that fullchain.pem file.\n"
          done
          while true; do
            MANUAL_CERT_PRIVKEY_PATH="$(prompt_non_empty "Enter path to privkey.pem for $(group_csv_to_space_list "$group_csv")")"
            MANUAL_CERT_PRIVKEY_PATH="$(resolve_file_path "$MANUAL_CERT_PRIVKEY_PATH")" || MANUAL_CERT_PRIVKEY_PATH=""
            if [[ -n "$MANUAL_CERT_PRIVKEY_PATH" ]]; then
              MANUAL_CERT_GROUP_PRIVKEY_PATHS+=("$MANUAL_CERT_PRIVKEY_PATH")
              break
            fi
            printf "Could not find that privkey.pem file.\n"
          done
        done
      else
        while true; do
          MANUAL_CERT_FULLCHAIN_PATH="$(prompt_non_empty "Enter path to fullchain.pem")"
          MANUAL_CERT_FULLCHAIN_PATH="$(resolve_file_path "$MANUAL_CERT_FULLCHAIN_PATH")" || MANUAL_CERT_FULLCHAIN_PATH=""
          if [[ -n "$MANUAL_CERT_FULLCHAIN_PATH" ]]; then
            break
          fi
          printf "Could not find that fullchain.pem file.\n"
        done
        while true; do
          MANUAL_CERT_PRIVKEY_PATH="$(prompt_non_empty "Enter path to privkey.pem")"
          MANUAL_CERT_PRIVKEY_PATH="$(resolve_file_path "$MANUAL_CERT_PRIVKEY_PATH")" || MANUAL_CERT_PRIVKEY_PATH=""
          if [[ -n "$MANUAL_CERT_PRIVKEY_PATH" ]]; then
            break
          fi
          printf "Could not find that privkey.pem file.\n"
        done
      fi
      ;;
  esac


  SERVER_PORT="$(prompt_port)"
  if [[ "$CERT_MODE" == "http" ]]; then
    CLIENT_PORT="$(prompt_client_port "$DEFAULT_CLIENT_PORT")"
  else
    CLIENT_PORT="$(prompt_client_port "443")"
  fi
  WORKER_PORT="$(prompt_worker_port "$DEFAULT_WORKER_PORT")"
  if [[ "$CERT_MODE" != "http" ]]; then
    log "Using HTTP redirect on port 80 and HTTPS on port ${CLIENT_PORT}."
  fi

}

write_full_env_with_defaults() {
  run_silent run_as_root mkdir -p "$INSTALL_DIR" || return 1
  write_env_from_example || return 1
}

apply_ownership() {
  log "Ensuring service user file ownership..."
  run_silent run_as_root chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$INSTALL_DIR" || return 1
  # The settings file holds the encryption key, the admin token and the relay secret:
  # the service user and root read it, other local users do not.
  if run_as_root test -f "${INSTALL_DIR}/.env"; then
    run_silent run_as_root chmod 640 "${INSTALL_DIR}/.env" || return 1
  fi
  ensure_git_safe_directory || return 1
}

# Root runs git in a directory the service user owns: git refuses that unless the
# directory is listed. Listed once, not once per run.
ensure_git_safe_directory() {
  local listed=""
  listed="$(run_as_root git config --global --get-all safe.directory 2>/dev/null || true)"
  if grep -qxF "$INSTALL_DIR" <<< "$listed"; then
    return 0
  fi
  run_silent run_as_root git config --global --add safe.directory "$INSTALL_DIR"
}

# Wait for the server to materialize generated secrets on first boot.
wait_for_server_secrets() {
  local env_file="${INSTALL_DIR}/.env"
  local timeout="${1:-90}"
  local waited=0
  log "Waiting for the server to generate shared secrets..."
  while (( waited < timeout )); do
    if run_as_root test -f "$env_file" \
      && run_as_root grep -qE '^STORAGE_ENCRYPTION_KEY=.+' "$env_file" 2>/dev/null \
      && run_as_root grep -qE '^WEBHOOK_SECRET=.+' "$env_file" 2>/dev/null; then
      log "Shared secrets are present. Starting the media worker."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  warn "Timed out waiting for secrets in ${env_file}. The media worker will start without encryption keys and pick them up on its next restart once the server is healthy."
  return 1
}

configure_systemd_service() {
  log "Creating systemd service at ${SERVICE_FILE}..."
  if [[ -z "$NODE_EXEC_PATH" ]]; then
    resolve_node_exec_path || return 1
  fi
  if ! run_silent run_as_root tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Aurelle server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
EnvironmentFile=${INSTALL_DIR}/.env
WorkingDirectory=${INSTALL_DIR}/server
ExecStart=${NODE_EXEC_PATH} ${INSTALL_DIR}/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  then
    return 1
  fi

  log "Creating worker systemd service at ${WORKER_SERVICE_FILE}..."
  if ! run_silent run_as_root tee "$WORKER_SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Aurelle media worker
After=network.target ${SERVICE_NAME}.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
EnvironmentFile=${INSTALL_DIR}/.env
WorkingDirectory=${INSTALL_DIR}/worker
ExecStart=${NODE_EXEC_PATH} ${INSTALL_DIR}/worker/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  then
    return 1
  fi

  run_as_root systemctl daemon-reload || return 1
  run_as_root systemctl enable songbird.service || return 1
  run_as_root systemctl enable songbird-worker.service || return 1
  run_as_root systemctl restart songbird.service || return 1
  if [[ -n "${DB_BACKUP_PATH:-}" ]]; then
    wait_for_server_secrets 600 || true
  else
    wait_for_server_secrets || true
  fi
  run_as_root systemctl restart songbird-worker.service || return 1
}

write_nginx_site_config() {
  local mode="${1:-http}"
  local cert_path="${2:-}"
  local key_path="${3:-}"
  local ssl_block=""
  local acme_block=""
  local redirect_server_block=""
  local config_body=""
  local listen_line="listen ${CLIENT_PORT} default_server;"
  local alternate_listen_line="listen ${CLIENT_PORT};"
  local domain_group_csv=""
  local domain_group_names=""
  local primary_domain=""
  local cert_line_path="$cert_path"
  local key_line_path="$key_path"
  local current_listen_line=""
  # The names of the plain-HTTP server that redirects to HTTPS.
  local server_name_line="server_name ${NGINX_SERVER_NAME};"
  if [[ "$DEPLOY_MODE" == "domain" && ${#DOMAIN_NAMES[@]} -gt 0 ]]; then
    server_name_line="server_name ${DOMAIN_NAMES[*]};"
  fi

  # Before the certificate exists a site that will use TLS is served on port 80:
  # that is where the certificate authority checks the domain or the IP, and where
  # the HTTPS redirect will live. Only a plain HTTP site uses the client port.
  if [[ "$mode" == "http" && "$CERT_MODE" != "http" ]]; then
    listen_line="listen 80 default_server;"
    alternate_listen_line="listen 80;"
  fi

  if [[ "$mode" == "ssl" ]]; then
    listen_line="listen ${CLIENT_PORT} ssl default_server;"
    alternate_listen_line="listen ${CLIENT_PORT} ssl;"
    ssl_block=$(cat <<EOF
  ssl_certificate ${cert_path};
  ssl_certificate_key ${key_path};
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
EOF
)

    if [[ "$DEPLOY_MODE" == "ip" && "$CERT_MODE" == "certbot" ]]; then
      redirect_server_block=$(cat <<EOF

server {
  listen 80;
  ${server_name_line}
  location /.well-known/acme-challenge/ {
    root ${ACME_WEBROOT};
    default_type "text/plain";
  }
  if (\$request_uri !~ "^/\\.well-known/acme-challenge/") {
    return 301 https://\$host$( [[ "$CLIENT_PORT" == "443" ]] && printf "" || printf ":%s" "$CLIENT_PORT" )\$request_uri;
  }
}
EOF
)
    elif [[ "$CLIENT_PORT" == "443" ]]; then
      redirect_server_block=$(cat <<EOF

server {
  listen 80;
  ${server_name_line}
  return 301 https://\$host\$request_uri;
}
EOF
)
    elif [[ "$CLIENT_PORT" != "80" ]]; then
      redirect_server_block=$(cat <<EOF

server {
  listen 80;
  ${server_name_line}
  return 301 https://\$host:${CLIENT_PORT}\$request_uri;
}
EOF
)
    fi
  fi

  if [[ "$mode" == "http" && "$DEPLOY_MODE" == "ip" && "$CERT_MODE" == "certbot" ]]; then
    run_silent run_as_root mkdir -p "$ACME_WEBROOT"
    acme_block=$(cat <<EOF

  location /.well-known/acme-challenge/ {
    root ${ACME_WEBROOT};
    default_type "text/plain";
  }
EOF
)
  fi

  log "Creating Nginx config at ${NGINX_SITE_FILE}..."
  if [[ "$DEPLOY_MODE" == "domain" ]]; then
    local domain_cert_groups=()
    build_domain_cert_groups domain_cert_groups

    for domain_group_csv in "${domain_cert_groups[@]}"; do
      if [[ -z "$config_body" ]]; then
        current_listen_line="$listen_line"
      else
        current_listen_line="$alternate_listen_line"
      fi

      domain_group_names="$(group_csv_to_space_list "$domain_group_csv")"
      primary_domain="$(group_primary_domain "$domain_group_csv")"

      if [[ "$mode" == "ssl" && "$CERT_MODE" == "certbot" ]]; then
        cert_line_path="/etc/letsencrypt/live/${primary_domain}/fullchain.pem"
        key_line_path="/etc/letsencrypt/live/${primary_domain}/privkey.pem"
        ssl_block=$(cat <<EOF
  ssl_certificate ${cert_line_path};
  ssl_certificate_key ${key_line_path};
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
EOF
)
      elif [[ "$mode" == "ssl" && "$CERT_MODE" == "files" ]]; then
        cert_line_path="$(manual_group_fullchain_path "$domain_group_csv")"
        key_line_path="$(manual_group_privkey_path "$domain_group_csv")"
        ssl_block=$(cat <<EOF
  ssl_certificate ${cert_line_path};
  ssl_certificate_key ${key_line_path};
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
EOF
)
      fi

      config_body+=$(cat <<EOF
server {
  ${current_listen_line}
  server_name ${domain_group_names};
  client_max_body_size ${MAX_UPLOAD_MB}m;
${ssl_block}

  location /api/events {
    proxy_pass http://127.0.0.1:${SERVER_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_buffering off;
    proxy_cache off;
    add_header X-Accel-Buffering no;
  }

  location / {
    proxy_pass http://127.0.0.1:${SERVER_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_cache_bypass \$http_upgrade;
  }
}

EOF
)
    done
  else
    config_body=$(cat <<EOF
server {
  ${listen_line}
  server_name ${NGINX_SERVER_NAME};
  client_max_body_size ${MAX_UPLOAD_MB}m;
${ssl_block}
${acme_block}

  location /api/events {
    proxy_pass http://127.0.0.1:${SERVER_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_buffering off;
    proxy_cache off;
    add_header X-Accel-Buffering no;
  }

  location / {
    proxy_pass http://127.0.0.1:${SERVER_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_cache_bypass \$http_upgrade;
  }
}
EOF
)
  fi

  run_silent run_as_root tee "$NGINX_SITE_FILE" >/dev/null <<EOF
${config_body}${redirect_server_block}
EOF
}

configure_nginx() {
  log "Preparing initial HTTP nginx configuration..."
  write_nginx_site_config "http" || return 1

  run_as_root ln -sfn "$NGINX_SITE_FILE" "$NGINX_ENABLED_FILE" || return 1
  if run_as_root test -f /etc/nginx/sites-enabled/default; then
    run_as_root rm -f /etc/nginx/sites-enabled/default || return 1
  fi

  log "Testing nginx configuration..."
  run_as_root nginx -t || return 1
  log "Reloading nginx..."
  run_logged_quiet run_as_root systemctl enable nginx || true
  reload_nginx || {
    warn "nginx could not be reloaded or started. Is another web server using port 80 or ${CLIENT_PORT}? See: sudo ss -ltnp | grep -E ':(80|${CLIENT_PORT}) '"
    return 1
  }
  log "Initial nginx configuration is active."
}

install_ssl_files_into_nginx() {
  local cert_path="$1"
  local key_path="$2"

  write_nginx_site_config "ssl" "$cert_path" "$key_path" || return 1
  run_as_root nginx -t || return 1
  reload_nginx || return 1
  log "Nginx SSL configured."
}

configure_manual_ssl_files() {
  if [[ "$DEPLOY_MODE" == "domain" ]]; then
    local idx=0
    local group_csv=""
    run_silent run_as_root mkdir -p "$CERT_INSTALL_DIR" || return 1
    for group_csv in "${DOMAIN_GROUPS[@]}"; do
      local source_fullchain="${MANUAL_CERT_GROUP_FULLCHAIN_PATHS[$idx]:-}"
      local source_privkey="${MANUAL_CERT_GROUP_PRIVKEY_PATHS[$idx]:-}"
      local install_dir=""
      install_dir="$(manual_cert_group_install_dir "$group_csv")"
      local installed_fullchain=""
      installed_fullchain="$(manual_group_fullchain_path "$group_csv")"
      local installed_privkey=""
      installed_privkey="$(manual_group_privkey_path "$group_csv")"

      if [[ ! -f "$source_fullchain" || ! -f "$source_privkey" ]]; then
        warn "Manual certificate files were not found for group: $(group_csv_to_space_list "$group_csv")"
        return 1
      fi

      run_silent run_as_root mkdir -p "$install_dir" || return 1
      run_silent run_as_root rm -f "$installed_fullchain" "$installed_privkey" || return 1
      run_silent run_as_root cp -Lf "$source_fullchain" "$installed_fullchain" || return 1
      run_silent run_as_root cp -Lf "$source_privkey" "$installed_privkey" || return 1
      run_silent run_as_root chmod 644 "$installed_fullchain" || return 1
      run_silent run_as_root chmod 600 "$installed_privkey" || return 1
      idx=$((idx + 1))
    done

    write_nginx_site_config "ssl" || return 1
    run_as_root nginx -t || return 1
    reload_nginx || return 1
    log "Nginx SSL configured."
    return 0
  fi

  if [[ ! -f "$MANUAL_CERT_FULLCHAIN_PATH" || ! -f "$MANUAL_CERT_PRIVKEY_PATH" ]]; then
    warn "Manual certificate files were not found."
    return 1
  fi

  run_silent run_as_root mkdir -p "$CERT_INSTALL_DIR" || return 1
  run_silent run_as_root rm -f "$CERT_INSTALL_DIR/fullchain.pem" "$CERT_INSTALL_DIR/privkey.pem" || return 1
  run_silent run_as_root cp -Lf "$MANUAL_CERT_FULLCHAIN_PATH" "$CERT_INSTALL_DIR/fullchain.pem" || return 1
  run_silent run_as_root cp -Lf "$MANUAL_CERT_PRIVKEY_PATH" "$CERT_INSTALL_DIR/privkey.pem" || return 1
  run_silent run_as_root chmod 644 "$CERT_INSTALL_DIR/fullchain.pem" || return 1
  run_silent run_as_root chmod 600 "$CERT_INSTALL_DIR/privkey.pem" || return 1

  install_ssl_files_into_nginx "$CERT_INSTALL_DIR/fullchain.pem" "$CERT_INSTALL_DIR/privkey.pem" || return 1
}

install_lego_certificate_files() {
  local cert_name="$1"
  local cert_file="${LEGO_STATE_DIR}/certificates/${cert_name}.crt"
  local issuer_file="${LEGO_STATE_DIR}/certificates/${cert_name}.issuer.crt"
  local key_file="${LEGO_STATE_DIR}/certificates/${cert_name}.key"

  if [[ ! -f "$cert_file" ]]; then
    warn "lego certificate file not found: ${cert_file}"
    return 1
  fi
  if [[ ! -f "$key_file" ]]; then
    warn "lego private key file not found: ${key_file}"
    return 1
  fi

  run_silent run_as_root mkdir -p "$CERT_INSTALL_DIR" || return 1
  run_silent run_as_root env CERT_FILE="$cert_file" ISSUER_FILE="$issuer_file" FULLCHAIN_FILE="$CERT_INSTALL_DIR/fullchain.pem" bash -lc '
    cat "$CERT_FILE" > "$FULLCHAIN_FILE"
    if [[ -f "$ISSUER_FILE" ]]; then
      cat "$ISSUER_FILE" >> "$FULLCHAIN_FILE"
    fi
  ' || {
    warn "Unable to assemble fullchain.pem from lego certificate files."
    return 1
  }
  run_silent run_as_root cp -Lf "$key_file" "$CERT_INSTALL_DIR/privkey.pem" || return 1
  run_silent run_as_root chmod 644 "$CERT_INSTALL_DIR/fullchain.pem" || return 1
  run_silent run_as_root chmod 600 "$CERT_INSTALL_DIR/privkey.pem" || return 1

  install_ssl_files_into_nginx "$CERT_INSTALL_DIR/fullchain.pem" "$CERT_INSTALL_DIR/privkey.pem" || return 1
}

configure_lego_ip_ssl() {
  if [[ -z "$CERTBOT_IP_ADDRESS" ]]; then
    warn "Missing public IP address for Certbot IP certificate setup."
    return 1
  fi

  ensure_lego_installed || return 1
  run_silent run_as_root mkdir -p "$ACME_WEBROOT/.well-known/acme-challenge" || return 1
  run_silent run_as_root mkdir -p "$LEGO_STATE_DIR" || return 1

  log "Requesting 6-day IP certificate for ${CERTBOT_IP_ADDRESS} with lego..."
  run_logged_quiet run_as_root "$LEGO_BIN" \
    --accept-tos \
    --email "$CERTBOT_EMAIL" \
    --path "$LEGO_STATE_DIR" \
    --disable-cn \
    --http \
    --http.webroot "$ACME_WEBROOT" \
    --domains "$CERTBOT_IP_ADDRESS" \
    run \
    --profile shortlived || {
      warn "ERROR: lego failed for IP ${CERTBOT_IP_ADDRESS}"
      return 1
    }

  install_lego_certificate_files "$CERTBOT_IP_ADDRESS" || return 1
  configure_lego_renewal_timer || return 1
  log "Nginx SSL configured for IP ${CERTBOT_IP_ADDRESS}."
}

configure_lego_renewal_timer() {
  if [[ ! -x "$LEGO_BIN" ]]; then
    warn "lego binary not found at ${LEGO_BIN}."
    return 1
  fi
  log "Creating lego renewal service at ${LEGO_RENEW_SERVICE_FILE}..."
  if ! run_silent run_as_root tee "$LEGO_RENEW_SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Renew Aurelle IP certificate with lego
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=oneshot
User=root
Group=root
ExecStart=${LEGO_BIN} --accept-tos --email ${CERTBOT_EMAIL} --path ${LEGO_STATE_DIR} --disable-cn --http --http.webroot ${ACME_WEBROOT} --domains ${CERTBOT_IP_ADDRESS} renew --dynamic --profile shortlived
ExecStartPost=/bin/bash -lc 'cat "${LEGO_STATE_DIR}/certificates/${CERTBOT_IP_ADDRESS}.crt" > "${CERT_INSTALL_DIR}/fullchain.pem" && if [[ -f "${LEGO_STATE_DIR}/certificates/${CERTBOT_IP_ADDRESS}.issuer.crt" ]]; then cat "${LEGO_STATE_DIR}/certificates/${CERTBOT_IP_ADDRESS}.issuer.crt" >> "${CERT_INSTALL_DIR}/fullchain.pem"; fi && cp -Lf "${LEGO_STATE_DIR}/certificates/${CERTBOT_IP_ADDRESS}.key" "${CERT_INSTALL_DIR}/privkey.pem" && chmod 644 "${CERT_INSTALL_DIR}/fullchain.pem" && chmod 600 "${CERT_INSTALL_DIR}/privkey.pem" && systemctl reload nginx'

[Install]
WantedBy=multi-user.target
EOF
  then
    return 1
  fi

  log "Creating lego renewal timer at ${LEGO_RENEW_TIMER_FILE}..."
  if ! run_silent run_as_root tee "$LEGO_RENEW_TIMER_FILE" >/dev/null <<EOF
[Unit]
Description=Run Aurelle lego renewal twice daily

[Timer]
OnBootSec=10m
OnUnitActiveSec=12h
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  then
    return 1
  fi

  run_as_root systemctl daemon-reload || return 1
  run_as_root systemctl enable --now songbird-lego-renew.timer || return 1
}

configure_selfsigned_ssl() {
  # Determine the CN: prefer the first domain name, fall back to the IP address,
  # fall back to "localhost" as a last resort.
  local cn="localhost"
  if [[ "${#DOMAIN_NAMES[@]}" -gt 0 && -n "${DOMAIN_NAMES[0]}" ]]; then
    cn="${DOMAIN_NAMES[0]}"
  elif [[ -n "$CERTBOT_IP_ADDRESS" ]]; then
    cn="$CERTBOT_IP_ADDRESS"
  fi

  local gen_script="${INSTALL_DIR}/scripts/gen-certs.sh"
  if [[ ! -f "$gen_script" ]]; then
    warn "gen-certs.sh not found at ${gen_script}."
    return 1
  fi

  log "Running gen-certs.sh for CN=${cn}..."
  # gen-certs.sh writes to <repo>/certs/ by default, but for a bare-metal install
  # we want the certs in CERT_INSTALL_DIR (/etc/ssl/songbird). We temporarily
  # override the output directory by symlinking, then copy to the final location.
  run_silent run_as_root mkdir -p "$CERT_INSTALL_DIR" || return 1

  # Run gen-certs.sh — it handles openssl installation automatically if missing.
  # It writes certs/cert.pem and certs/key.pem relative to the repo root.
  run_silent run_as_root bash "$gen_script" "$cn" || return 1

  local repo_cert="${INSTALL_DIR}/certs/cert.pem"
  local repo_key="${INSTALL_DIR}/certs/key.pem"

  run_silent run_as_root cp -f "$repo_cert" "$CERT_INSTALL_DIR/fullchain.pem" || return 1
  run_silent run_as_root cp -f "$repo_key"  "$CERT_INSTALL_DIR/privkey.pem"  || return 1
  run_silent run_as_root chmod 644 "$CERT_INSTALL_DIR/fullchain.pem" || return 1
  run_silent run_as_root chmod 600 "$CERT_INSTALL_DIR/privkey.pem"  || return 1

  install_ssl_files_into_nginx "$CERT_INSTALL_DIR/fullchain.pem" "$CERT_INSTALL_DIR/privkey.pem" || return 1
  log "Self-signed certificate installed."
}

configure_ssl_if_needed() {
  case "$CERT_MODE" in
    http)
      log "HTTP-only mode selected. Skipping TLS setup."
      return 0
      ;;
    selfsigned)
      log "Generating self-signed TLS certificate..."
      configure_selfsigned_ssl || return 1
      return 0
      ;;
    files)
      log "Installing TLS certificate files into nginx..."
      configure_manual_ssl_files || return 1
      return 0
      ;;
  esac

  if [[ "$DEPLOY_MODE" == "ip" ]]; then
    configure_lego_ip_ssl || return 1
    return 0
  fi

  local domain_group_csv=""
  for domain_group_csv in "${DOMAIN_GROUPS[@]}"; do
    local cert_name
    cert_name="$(group_primary_domain "$domain_group_csv")"
    local group_names=()
    local domain_entry=""
    IFS=',' read -r -a group_names <<< "$domain_group_csv"

    local group_covered="yes"
    local cert_details=""
    cert_details="$(run_as_root certbot certificates --cert-name "$cert_name" 2>/dev/null || true)"
    if [[ -z "$cert_details" ]]; then
      group_covered="no"
    fi

    for domain_entry in "${group_names[@]}"; do
      local escaped
      escaped="$(printf '%s' "$domain_entry" | sed 's/[.[\*^$]/\\&/g')"
      if [[ "$group_covered" == "yes" ]] && ! echo "$cert_details" | grep -qP "^\s+Domains:.*\b${escaped}\b"; then
        group_covered="no"
        break
      fi
    done

    if [[ "$group_covered" == "yes" ]]; then
      log "Certificate ${cert_name} already covers: $(group_csv_to_space_list "$domain_group_csv")"
      continue
    fi

    local certbot_d_args=()
    for domain_entry in "${group_names[@]}"; do
      certbot_d_args+=(-d "$domain_entry")
    done
    # An address is optional for Let's Encrypt; without one there are no expiry notices.
    local certbot_email_args=(--email "$CERTBOT_EMAIL")
    if [[ -z "$CERTBOT_EMAIL" ]]; then
      certbot_email_args=(--register-unsafely-without-email)
      warn "No email address was given: Let's Encrypt cannot send certificate expiry notices."
    fi

    log "Requesting SSL certificate for group: $(group_csv_to_space_list "$domain_group_csv")"
    run_as_root certbot certonly \
      --nginx \
      --cert-name "$cert_name" \
      --https-port "$CLIENT_PORT" \
      --non-interactive \
      --agree-tos \
      "${certbot_email_args[@]}" \
      "${certbot_d_args[@]}" || {
        warn "Certbot could not issue a certificate for $(group_csv_to_space_list "$domain_group_csv"). The domain must point at this server (DNS A record) and port 80 must be reachable from the internet."
        return 1
      }
  done

  # certbot renews on its own; nginx has to be told to use the new certificate.
  install_certbot_deploy_hook "$(group_primary_domain "${DOMAIN_GROUPS[0]}")" \
    || warn "Could not install the certbot renewal hook; reload nginx after each renewal."

  write_nginx_site_config "ssl" || return 1
  run_as_root nginx -t || return 1
  reload_nginx || return 1
  log "Nginx SSL configured for domain groups: ${DOMAIN_GROUPS[*]}"
}

restore_backup_if_provided() {
  if [[ -z "$DB_BACKUP_PATH" ]]; then
    return 0
  fi
  if [[ ! -f "$DB_BACKUP_PATH" ]]; then
    warn "Backup file not found: $DB_BACKUP_PATH"
    return 1
  fi
  if [[ ! -d "$INSTALL_DIR/server" ]]; then
    warn "Server directory not found at ${INSTALL_DIR}/server. Cannot restore backup."
    return 1
  fi

  log "Restoring database from backup: $DB_BACKUP_PATH"
  local cmd=(npm --prefix server run db:restore -- -y --file "$DB_BACKUP_PATH")

  if [[ "${RESTORE_BACKUP_QUIET:-no}" == "yes" ]]; then
    if ! run_db_command_logged_quiet "${cmd[@]}"; then
      return 1
    fi
    return 0
  fi

  if ! run_db_command "${cmd[@]}"; then
    return 1
  fi
}

backup_database() {
  if [[ ! -d "$INSTALL_DIR/server" ]]; then
    warn "Server directory not found; skipping DB backup."
    return 0
  fi
  log "Backing up database before update..."
  if ! run_in_install_dir "npm --prefix server run db:backup"; then
    warn "DB backup command failed. Update aborted."
    return 1
  fi
}

preserve_backup_and_restore_data() {
  log "Data directory (${INSTALL_DIR}/data) remains untouched during update."
}

run_migrations() {
  if [[ ! -d "$INSTALL_DIR/server" ]]; then
    warn "Server directory not found; skipping DB migrations."
    return 0
  fi
  log "Running database migrations..."
  run_in_install_dir "npm --prefix server run db:migrate" || return 1
}

songbird_service_is_running() {
  if have_cmd systemctl && systemctl is-active --quiet songbird.service 2>/dev/null; then
    return 0
  fi
  return 1
}

songbird_healthcheck_responds() {
  local port="$1"

  if have_cmd curl; then
    curl --fail --silent --show-error --max-time 1 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1
    return $?
  fi

  if have_cmd wget; then
    wget -q -T 1 -O /dev/null "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1
    return $?
  fi

  if have_cmd node; then
    node -e '
const http = require("node:http");
const port = Number(process.argv[1]);
if (!Number.isFinite(port) || port <= 0) process.exit(1);
const req = http.request(
  {
    hostname: "127.0.0.1",
    port,
    path: "/api/health",
    method: "GET",
    timeout: 600,
  },
  (res) => {
    res.resume();
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  },
);
req.on("timeout", () => req.destroy());
req.on("error", () => process.exit(1));
req.end();
setTimeout(() => process.exit(1), 800).unref();
' "$port" >/dev/null 2>&1
    return $?
  fi

  return 1
}

ensure_songbird_stopped_for_update() {
  local port=""
  port="$(get_existing_env_value_with_fallback "SERVER_PORT" "PORT" "$DEFAULT_SERVER_PORT")"
  port="$(sanitize_input_value "$port")"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    port="$DEFAULT_SERVER_PORT"
  fi

  log "Checking whether Aurelle is running before update..."

  if songbird_service_is_running; then
    log "Aurelle service is running. Stopping it before update..."
    if ! run_as_root systemctl stop songbird.service; then
      warn "Failed to stop Aurelle service. Stop it manually before updating."
      press_enter_to_continue
      return 1
    fi
    if have_cmd systemctl && systemctl is-active --quiet songbird-worker.service 2>/dev/null; then
      run_as_root systemctl stop songbird-worker.service || true
    fi
    UPDATE_STOPPED_SERVICES="yes"
    log "Aurelle service stopped."
  fi

  if songbird_healthcheck_responds "$port"; then
    warn "Aurelle is still running on port ${port}. Stop it before updating."
    press_enter_to_continue
    return 1
  fi

  return 0
}

update_nginx_runtime_values() {
  if [[ ! -f "$NGINX_SITE_FILE" ]]; then
    warn "Nginx site config not found at ${NGINX_SITE_FILE}. Skipping nginx update."
    return 1
  fi

  local backup_file="${NGINX_SITE_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  run_silent run_as_root cp "$NGINX_SITE_FILE" "$backup_file"

  run_silent run_as_root sed -i -E \
    "s|proxy_pass http://127\\.0\\.0\\.1:[0-9]+;|proxy_pass http://127.0.0.1:${SERVER_PORT};|g" \
    "$NGINX_SITE_FILE"

  local existing_cert=""
  local existing_key=""
  existing_cert="$(run_as_root_output grep -E '^\s*ssl_certificate ' "$NGINX_SITE_FILE" | head -n 1 | sed -E 's/^\s*ssl_certificate\s+([^;]+);/\1/' | tr -d '\r\n')" || existing_cert=""
  existing_key="$(run_as_root_output grep -E '^\s*ssl_certificate_key ' "$NGINX_SITE_FILE" | head -n 1 | sed -E 's/^\s*ssl_certificate_key\s+([^;]+);/\1/' | tr -d '\r\n')" || existing_key=""

  if [[ -n "$existing_cert" && -n "$existing_key" ]]; then
    write_nginx_site_config "ssl" "$existing_cert" "$existing_key"
  else
    write_nginx_site_config "http"
  fi

  if run_as_root nginx -t; then
    reload_nginx
    log "Nginx updated with SERVER_PORT=${SERVER_PORT}, CLIENT_PORT=${CLIENT_PORT}, MAX_UPLOAD_MB=${MAX_UPLOAD_MB}."
    log "Backup saved at ${backup_file}."
    return 0
  fi

  warn "Nginx config test failed. Restoring previous config."
  run_silent run_as_root cp "$backup_file" "$NGINX_SITE_FILE"
  run_as_root nginx -t || true
  return 1
}

rebuild_and_restart_after_settings_change() {
  local needs_nginx="${1:-no}"
  sync_values_from_env
  log "Rebuilding client after settings change..."
  run_in_install_dir "npm --prefix client run build" || return 1

  log "Restarting Aurelle service..."
  run_as_root systemctl restart songbird.service || return 1
  if have_cmd systemctl && systemctl list-unit-files | grep -q "^songbird-worker.service"; then
    run_as_root systemctl restart songbird-worker.service || true
  fi

  if [[ "$needs_nginx" == "yes" ]]; then
    log "Updating Nginx config for SERVER_PORT/CLIENT_PORT/MAX_UPLOAD_MB changes..."
    update_nginx_runtime_values || return 1
  else
    log "Nginx update not required (SERVER_PORT/CLIENT_PORT/MAX_UPLOAD_MB unchanged)."
  fi
}

# An update installs the calls relay only when it was asked for (AURELLE_CALLS_RELAY):
# an installation that never had one is not changed behind its owner's back.
install_calls_relay_if_requested() {
  if [[ "$STRICT_CHECKS" == "1" && ( "$CALLS_RELAY_MODE" == "yes" || "$CALLS_RELAY_MODE" == "force" ) ]]; then
    load_deployment_from_existing
    install_calls_relay || true
  fi
}

# Restarts the app and the worker and reloads nginx after new files are in place.
# In a real run it also waits for the app to answer: a restart that crashes must not
# end in a "successfully updated" message.
restart_services_after_update() {
  log "Restarting Aurelle service..."
  run_as_root systemctl restart songbird.service || return 1
  if have_cmd systemctl && systemctl list-unit-files | grep -q "^songbird-worker.service"; then
    run_as_root systemctl restart songbird-worker.service || true
  fi
  UPDATE_STOPPED_SERVICES="no"
  reload_nginx || return 1
  if [[ "$STRICT_CHECKS" == "1" ]]; then
    confirm_app_started || return 1
  fi
}

# The update stops Aurelle first. Whatever ends it early (nothing new to install, a
# failed download, a declined question) must not leave the site down.
update_songbird() {
  acquire_install_lock || return 1
  update_songbird_run
  local update_status=$?
  if [[ "$UPDATE_STOPPED_SERVICES" == "yes" ]]; then
    warn "The update ended before Aurelle was restarted. Starting it again..."
    run_as_root systemctl start songbird.service || true
    if have_cmd systemctl && systemctl list-unit-files | grep -q "^songbird-worker.service"; then
      run_as_root systemctl start songbird-worker.service || true
    fi
    UPDATE_STOPPED_SERVICES="no"
  fi
  return "$update_status"
}

update_songbird_run() {
  if [[ ! -d "$INSTALL_DIR" ]]; then
    warn "No Aurelle install found at ${INSTALL_DIR}."
    press_enter_to_continue
    return 0
  fi

  # The database and ports in use, not the defaults of a fresh shell.
  sync_values_from_env

  # A new release can need a newer Node.js: find out before the site is stopped.
  ensure_nodejs_from_nodesource || return 1

  ensure_songbird_stopped_for_update || return 1

  local backup_default="no"
  if is_truthy "$AURELLE_BACKUP"; then
    backup_default="yes"
  fi
  if [[ "$(prompt_yes_no "Create a database backup before updating?" "$backup_default")" == "yes" ]]; then
    backup_database || return 1
  else
    log "Skipping pre-update backup."
  fi

  prompt_source_mode

  if [[ "$SOURCE_MODE" == "offline" ]]; then
    ensure_offline_source_ready "update" || return 0

    local offline_zip_path="$SOURCE_ZIP_PATH"
    local extract_result=""
    extract_result="$(extract_offline_source_zip "$offline_zip_path" "update")" || return 1
    local tmp_dir="${extract_result%%|*}"
    local source_root="${extract_result#*|}"

    local source_ver=""
    local install_ver=""
    source_ver="$(read_version_value "$source_root/VERSION")" || source_ver=""
    install_ver="$(read_version_value "$INSTALL_DIR/VERSION")" || install_ver=""

    local is_downgrade="no"
    local version_rel=""
    if ! compare_offline_source_version "$source_root" "$INSTALL_DIR" version_rel; then
      run_silent run_as_root rm -rf "$tmp_dir"
      press_enter_to_continue
      return 0
    fi

    case "$version_rel" in
      newer)
        log "Offline update available. Preparing to update Aurelle..."
        ;;
      lower)
        local should_downgrade=""
        should_downgrade="$(prompt_yes_no "Local zip version (${source_ver}) is lower than installed version (${install_ver}). Do you want to downgrade to version ${source_ver}?" "no")"
        if [[ "$should_downgrade" != "yes" ]]; then
          run_silent run_as_root rm -rf "$tmp_dir"
          log "Aurelle is already up to date. No rebuild needed."
          press_enter_to_continue
          return 0
        fi
        is_downgrade="yes"
        log "Offline downgrade requested. Preparing to downgrade Aurelle to ${source_ver}..."
        ;;
      same)
        local should_update=""
        should_update="$(prompt_yes_no "Local zip version (${source_ver}) is the same as installed version (${install_ver}). Do you want to update to version ${source_ver}?" "no")"
        if [[ "$should_update" != "yes" ]]; then
          run_silent run_as_root rm -rf "$tmp_dir"
          log "Aurelle is already up to date. No rebuild needed."
          press_enter_to_continue
          return 0
        fi
        log "Offline update requested. Preparing to update Aurelle to ${source_ver}..."
        ;;
      *)
        run_silent run_as_root rm -rf "$tmp_dir"
        log "Aurelle is already up to date. No rebuild needed."
        press_enter_to_continue
        return 0
        ;;
    esac

    run_silent run_as_root rm -rf "$tmp_dir"

    preserve_backup_and_restore_data
    update_source_from_zip "$offline_zip_path" || return 1

    log "Installing dependencies..."
    install_songbird_dependencies || return 1
    ensure_vapid_keys || return 1

    log "Synchronizing database schema with latest version..."
    run_migrations || return 1

    ensure_service_user_exists || return 1
    apply_ownership || return 1
    if install_global_command_from_path "$INSTALL_DIR/scripts/install.sh"; then
      log "Global command synchronized from updated install script."
    else
      warn "Failed to synchronize global command after update."
    fi

    # Unit files are fully generated: refresh them on every update.
    if have_cmd systemctl && [[ -f "$SERVICE_FILE" ]]; then
      log "Refreshing systemd services..."
      configure_systemd_service || true
    fi

    restart_services_after_update || return 1
    install_calls_relay_if_requested

    show_deployment_success_frame "update"
    press_enter_to_continue
    return 0
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    :
  else
    warn "No git checkout found at ${INSTALL_DIR}. Update requires GitHub mode."
    press_enter_to_continue
    return 0
  fi

  # Fetch latest from remote
  log "Checking for updates..."
  if ! run_in_install_dir "git fetch --all --prune --tags"; then
    warn "Failed to fetch from remote. Check your network and credentials."
    press_enter_to_continue
    return 1
  fi

  # Get local and remote commit hashes
  local local_commit remote_commit target_branch
  local_commit="$(run_in_install_dir_output "git rev-parse HEAD" | tr -d '\r\n')"
  target_branch="$(repo_target_ref)"
  remote_commit="$(repo_remote_commit "$target_branch")"

  if [[ -z "$local_commit" || -z "$remote_commit" ]]; then
    warn "Failed to determine current version. Check git repository status."
    press_enter_to_continue
    return 1
  fi

  local is_downgrade="no"
  local target_ref="$target_branch"
  local target_version=""

  # Check if update is available
  if [[ "$local_commit" == "$remote_commit" ]]; then
    log "Aurelle is already up to date."
    local should_downgrade=""
    should_downgrade="$(prompt_yes_no "Do you want to downgrade?" "no")"
    if [[ "$should_downgrade" != "yes" ]]; then
      log "No rebuild needed."
      press_enter_to_continue
      return 0
    fi

    prompt_read "Enter version number to install: " target_version
    target_version="$(sanitize_input_value "$target_version")"

    if [[ -z "$target_version" ]]; then
      warn "No version specified. Downgrade canceled."
      press_enter_to_continue
      return 0
    fi

    target_ref="$(resolve_git_version_ref "$target_version")" || target_ref=""
    if [[ -z "$target_ref" ]]; then
      warn "Version '${target_version}' not found in repository."
      press_enter_to_continue
      return 1
    fi

    is_downgrade="yes"
  fi

  if [[ "$is_downgrade" == "yes" ]]; then
    log "Downgrade requested. Preparing to downgrade Aurelle to ${target_version}..."
    preserve_backup_and_restore_data

    if ! run_in_install_dir "git checkout ${target_ref}"; then
      warn "Failed to checkout ${target_version}."
      press_enter_to_continue
      return 1
    fi
  else
    # Update is available - proceed with safe update
    log "Update available. Preparing to update Aurelle..."
    preserve_backup_and_restore_data

    # Move to the newest commit of the branch (or tag) that is followed
    if ! sync_repo_to_ref; then
      warn "Failed to update the source. See the message above."
      press_enter_to_continue
      return 1
    fi
  fi

  log "Installing dependencies..."
  install_songbird_dependencies || return 1
  ensure_vapid_keys || return 1
  
  log "Synchronizing database schema with latest version..."
  run_migrations || return 1

  ensure_service_user_exists || return 1
  apply_ownership || return 1
  if install_global_command_from_path "$INSTALL_DIR/scripts/install.sh"; then
    log "Global command synchronized from updated install script."
  else
    warn "Failed to synchronize global command after update."
  fi

  # Unit files are fully generated: refresh them on every update.
  if have_cmd systemctl && [[ -f "$SERVICE_FILE" ]]; then
    log "Refreshing systemd services..."
    configure_systemd_service || true
  fi

  restart_services_after_update || return 1
  install_calls_relay_if_requested

  show_deployment_success_frame "update"
  press_enter_to_continue
}

restart_songbird() {
  log "Restarting Aurelle service..."
  run_as_root systemctl restart songbird.service || return 1
  if have_cmd systemctl && systemctl list-unit-files | grep -q "^songbird-worker.service"; then
    run_as_root systemctl restart songbird-worker.service || true
  fi
  reload_nginx || return 1

  log "Aurelle restarted successfully."
  press_enter_to_continue
}

edit_settings() {
  local env_file="${INSTALL_DIR}/.env"
  if [[ ! -f "$env_file" ]]; then
    warn "No .env found at ${env_file}. Run install first."
    press_enter_to_continue
    return 0
  fi

  local legacy_port existing_server existing_client
  legacy_port="$(get_existing_env_value "PORT" "")"
  existing_server="$(get_existing_env_value "SERVER_PORT" "")"
  existing_client="$(get_existing_env_value "CLIENT_PORT" "")"
  if [[ -n "$legacy_port" && -z "$existing_server" ]]; then
    replace_env_value "$env_file" "SERVER_PORT" "$legacy_port"
  fi
  if [[ -z "$existing_client" ]]; then
    replace_env_value "$env_file" "CLIENT_PORT" "$DEFAULT_CLIENT_PORT"
  fi

  local before_server before_client before_max
  before_server="$(get_existing_env_value_with_fallback "SERVER_PORT" "PORT" "$DEFAULT_SERVER_PORT")"
  before_client="$(get_existing_env_value "CLIENT_PORT" "$DEFAULT_CLIENT_PORT")"
  before_max="$(get_existing_env_mb_value_with_fallback "FILE_UPLOAD_MAX_TOTAL_SIZE_MB" "FILE_UPLOAD_MAX_TOTAL_SIZE" "$DEFAULT_MAX_UPLOAD_MB")"

  local before after
  before="$(run_as_root sha256sum "$env_file" | awk '{print $1}')"

  open_env_editor "$env_file"

  after="$(run_as_root sha256sum "$env_file" | awk '{print $1}')"

  if [[ "$before" == "$after" ]]; then
    log "No changes detected in .env. Skipping rebuild."
    return 0
  fi

  local after_server after_client after_max
  after_server="$(get_existing_env_value_with_fallback "SERVER_PORT" "PORT" "$DEFAULT_SERVER_PORT")"
  after_client="$(get_existing_env_value "CLIENT_PORT" "$DEFAULT_CLIENT_PORT")"
  after_max="$(get_existing_env_mb_value_with_fallback "FILE_UPLOAD_MAX_TOTAL_SIZE_MB" "FILE_UPLOAD_MAX_TOTAL_SIZE" "$DEFAULT_MAX_UPLOAD_MB")"

  local needs_nginx="no"
  if [[ "$before_server" != "$after_server" || "$before_client" != "$after_client" || "$before_max" != "$after_max" ]]; then
    needs_nginx="yes"
  fi

  log "Changes detected. Applying updates..."
  ensure_local_postgres_setup || return 1
  rebuild_and_restart_after_settings_change "$needs_nginx"
  log "Settings applied."
  press_enter_to_continue
}

# Print PIDs listening on a TCP port (empty when free). Requires ss.
pids_listening_on_port() {
  local port="$1"
  run_as_root ss -ltnp "sport = :${port}" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
}

# Ensure nothing still holds a service port.
free_service_port() {
  local port="$1"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    warn "Skipping port cleanup for invalid port value: ${port:-<empty>}."
    return 0
  fi

  if ! have_cmd ss; then
    warn "ss not available; cannot verify port ${port} is free."
    return 0
  fi

  local pids=""
  pids="$(pids_listening_on_port "$port")"

  if [[ -z "${pids//[[:space:]]/}" ]]; then
    return 0
  fi

  local summary=""
  summary="$(run_as_root ps -o pid=,comm=,args= -p $(printf "%s" "$pids" | tr '\n' ',' | sed 's/,$//') 2>/dev/null | tr '\n' ';' || true)"
  
  log "Port ${port} still in use (${summary:-PIDs: $pids}); terminating..."
  run_as_root kill $pids 2>/dev/null || true
  sleep 2

  local remaining=""
  remaining="$(pids_listening_on_port "$port")"

  if [[ -n "${remaining//[[:space:]]/}" ]]; then
    warn "Port ${port} still held after SIGTERM (${remaining}); escalating to SIGKILL."
    run_as_root kill -9 $remaining 2>/dev/null || true
    sleep 1
    remaining="$(pids_listening_on_port "$port")"
  fi

  if [[ -n "${remaining//[[:space:]]/}" ]]; then
    warn "Port ${port} is still occupied (${remaining}) after SIGKILL. Reboot or investigate manually."
    return 1
  fi
  
  log "Port ${port} is free."
  return 0
}

remove_songbird() {
  if [[ ! -d "$INSTALL_DIR" ]]; then
    warn "No install found at ${INSTALL_DIR}."
    press_enter_to_continue
    return 0
  fi

  if [[ "$(prompt_yes_no "This will remove Aurelle from this server. Continue?" "no")" != "yes" ]]; then
    log "Removal canceled."
    return 0
  fi

  # Capture ports for later.
  local server_port worker_port
  server_port="$(get_existing_env_value "SERVER_PORT" "$DEFAULT_SERVER_PORT")"
  worker_port="$(get_existing_env_value "WORKER_PORT" "$DEFAULT_WORKER_PORT")"

  if run_as_root systemctl list-unit-files | grep -q "^songbird.service"; then
    run_as_root systemctl disable --now songbird.service || true
  fi
  if run_as_root systemctl list-unit-files | grep -q "^songbird-worker.service"; then
    run_as_root systemctl disable --now songbird-worker.service || true
  fi
  if run_as_root systemctl list-unit-files | grep -q "^songbird-lego-renew.timer"; then
    run_as_root systemctl disable --now songbird-lego-renew.timer || true
  fi
  run_as_root rm -f "$SERVICE_FILE" "$WORKER_SERVICE_FILE"
  run_as_root rm -f "$LEGO_RENEW_SERVICE_FILE" "$LEGO_RENEW_TIMER_FILE"
  run_as_root systemctl daemon-reload

  free_service_port "$server_port" || true
  free_service_port "$worker_port" || true

  run_as_root rm -f "$NGINX_ENABLED_FILE"
  run_as_root rm -f "$NGINX_SITE_FILE"
  if run_as_root nginx -t >/dev/null 2>&1; then
    reload_nginx
  fi

  if [[ -d "$INSTALL_DIR" ]]; then
    run_as_root rm -rf "$INSTALL_DIR"
  fi
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    run_as_root userdel "$SERVICE_USER" || true
  fi

  log "Aurelle removed."
  # The remembered install summary no longer describes anything.
  INSTALL_SUMMARY_TITLE=""
  INSTALL_SUMMARY_LINES=()

  if [[ -f "$GLOBAL_COMMAND_PATH" ]]; then
    if [[ "$(prompt_yes_no "Remove global command (songbird-deploy) as well?" "no")" == "yes" ]]; then
      run_as_root rm -f "$GLOBAL_COMMAND_PATH"
      log "Global command removed."
    fi
  fi

  press_enter_to_continue
}

configure_push_proxy() {
  local env_file="$INSTALL_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    warn ".env file not found. Install Aurelle first."
    press_enter_to_continue
    return 1
  fi

  clear_screen
  show_banner
  printf "\n"
  printf "Configure Push Notification Proxy\n"
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
  
  local current_proxy=""
  current_proxy="$(get_existing_env_value "PUSH_PROXY_URL" "")"
  
  if [[ -n "$current_proxy" ]]; then
    printf "Current proxy: %s\n\n" "$current_proxy"
  else
    printf "No proxy currently configured.\n\n"
  fi
  
  printf "Use a proxy when your server cannot directly reach push service endpoints:\n"
  printf "  • fcm.googleapis.com (Chrome/Edge)\n"
  printf "  • *.push.services.mozilla.com (Firefox)\n"
  printf "  • web.push.apple.com (Safari)\n\n"
  
  printf "Proxy URL formats:\n"
  printf "  • HTTP: http://proxy.example.com:3128\n"
  printf "  • With auth: http://user:pass@proxy.example.com:8080\n"
  printf "  • SOCKS5: socks5://proxy.example.com:1080\n\n"
  
  local proxy_url=""
  prompt_read "Enter proxy URL (leave blank to disable proxy): " proxy_url
  proxy_url="${proxy_url#"${proxy_url%%[![:space:]]*}"}"
  proxy_url="${proxy_url%"${proxy_url##*[![:space:]]}"}"
  
  if [[ -z "$proxy_url" ]]; then
    log "Clearing proxy configuration..."
    replace_env_value "$env_file" "PUSH_PROXY_URL" ""
  else
    # Test proxy connectivity if curl is available
    if have_cmd curl; then
      printf "\nTesting proxy connectivity...\n"
      if curl -x "$proxy_url" -s -o /dev/null -w "%{http_code}" --connect-timeout 5 https://fcm.googleapis.com 2>/dev/null | grep -q "200\|301\|302"; then
        printf "✓ Proxy is reachable!\n"
      else
        warn "Could not verify proxy connectivity. Proceeding anyway..."
      fi
    fi
    
    log "Setting proxy to: $proxy_url"
    replace_env_value "$env_file" "PUSH_PROXY_URL" "$proxy_url"
  fi
  
  log "Installing dependencies..."
  if ! run_in_install_dir "cd server && npm install"; then
    warn "Failed to install dependencies."
    press_enter_to_continue
    return 1
  fi
  
  log "Restarting Aurelle service..."
  if ! run_logged_quiet run_as_root systemctl restart songbird; then
    warn "Failed to restart service."
    press_enter_to_continue
    return 1
  fi
  
  printf "\n"
  log "Proxy configuration applied successfully!"
  
  press_enter_to_continue
}

install_songbird() {
  acquire_install_lock || return 1
  prompt_source_mode
  collect_install_options
  prompt_database_choice
  prompt_install_backup_restore
  prompt_calls_relay_choice
  TLS_FAILED="0"
  check_system_requirements || return 1
  install_required_packages || return 1
  ensure_nodejs_from_nodesource || return 1
  ensure_service_user_exists || return 1
  if [[ "$SOURCE_MODE" == "offline" ]]; then
    ensure_offline_source_ready "install" || return 0
    install_source_from_zip "$SOURCE_ZIP_PATH" || return 1
  else
    clone_repo || {
      warn "Failed to clone repository. Installation canceled."
      press_enter_to_continue
      return 1
    }
  fi
  ensure_log_dir || return 1
  write_full_env_with_defaults || return 1
  ensure_local_postgres_setup || return 1
  install_songbird_dependencies || return 1
  RESTORE_BACKUP_QUIET="yes"
  if ! restore_backup_if_provided; then
    RESTORE_BACKUP_QUIET="no"
    warn "Backup restore failed. Installation aborted. Review ${LOG_FILE} for details."
    press_enter_to_continue
    return 1
  fi
  RESTORE_BACKUP_QUIET="no"
  ensure_vapid_keys || return 1
  pregenerate_missing_secrets || true
  apply_ownership || return 1
  configure_systemd_service || return 1
  confirm_app_started || return 1
  log "Starting nginx setup..."
  configure_nginx || return 1
  log "Starting TLS setup..."
  if ! configure_ssl_if_needed; then
    # The site already answers over HTTP: keep it, say what failed, finish the rest.
    TLS_FAILED="1"
    warn "TLS setup failed, so Aurelle is served over plain HTTP for now (see the message above). Fix the cause and run the installer again."
  fi
  configure_firewall
  install_calls_relay || true

  if install_global_command_from_path "$INSTALL_DIR/scripts/install.sh"; then
    log "Global command synchronized to script version ${LAST_GLOBAL_COMMAND_VERSION:-$SCRIPT_VERSION}."
  else
    warn "Failed to synchronize global command after install. You can retry from the menu."
  fi

  create_owner_user || warn "The owner account was not created. Create it from the menu: Manage Database, Create user."

  show_deployment_success_frame "install"
  press_enter_to_continue
}

install_global_command_from_path() {
  local source_path="$1"
  [[ -n "$source_path" && -f "$source_path" ]] || return 1
  local install_version=""
  install_version="$(resolve_script_version_for_path "$source_path" 2>/dev/null || printf "%s" "$SCRIPT_VERSION")"

  local temp_target=""
  temp_target="$(mktemp)"
  cp "$source_path" "$temp_target" || {
    rm -f "$temp_target"
    return 1
  }

  if ! sed -i "1s|^# songbird-deploy-version:.*$|# songbird-deploy-version: ${install_version}|" "$temp_target"; then
    rm -f "$temp_target"
    return 1
  fi

  if ! run_silent run_as_root install -m 755 "$temp_target" "$GLOBAL_COMMAND_PATH"; then
    rm -f "$temp_target"
    return 1
  fi

  rm -f "$temp_target"
  LAST_GLOBAL_COMMAND_VERSION="$install_version"
  return 0
}

install_global_command_from_remote() {
  local install_version="$SCRIPT_VERSION"
  local temp_target=""
  local remote_version=""
  temp_target="$(mktemp)"
  if ! download "$SCRIPT_REMOTE_URL" > "$temp_target"; then
    rm -f "$temp_target"
    return 1
  fi
  # Stamp the version the downloaded script has, not the 0.0.0 of a piped run.
  remote_version="$(read_script_version_header "$temp_target" 2>/dev/null || true)"
  if [[ -n "$remote_version" ]]; then
    install_version="$remote_version"
  fi
  if ! sed -i "1s|^# songbird-deploy-version:.*$|# songbird-deploy-version: ${install_version}|" "$temp_target"; then
    rm -f "$temp_target"
    return 1
  fi
  if ! run_silent run_as_root install -m 755 "$temp_target" "$GLOBAL_COMMAND_PATH"; then
    rm -f "$temp_target"
    return 1
  fi
  rm -f "$temp_target"
  LAST_GLOBAL_COMMAND_VERSION="$install_version"
  return 0
}

install_global_command_core() {
  local source_path="${1:-$CURRENT_SCRIPT_PATH}"
  if [[ -n "$source_path" && -f "$source_path" ]]; then
    install_global_command_from_path "$source_path"
    return $?
  fi

  log "Script source path is not a regular file. Installing global command from remote..."
  install_global_command_from_remote
}

fetch_remote_installer_script() {
  local target_file="$1"
  if ! have_cmd curl; then
    return 1
  fi
  curl -fsSL --connect-timeout 10 --max-time 30 "$SCRIPT_REMOTE_URL" > "$target_file" || return 1
  [[ -s "$target_file" ]] || return 1
}

update_menu() {
  log "Checking for menu updates from GitHub..."

  local temp_remote=""
  temp_remote="$(mktemp)"

  if ! fetch_remote_installer_script "$temp_remote"; then
    rm -f "$temp_remote"
    warn "Failed to fetch installer script from GitHub."
    local reinstall_choice=""
    reinstall_choice="$(prompt_yes_no "Do you want to reinstall the current menu again?" "no")"
    if [[ "$reinstall_choice" == "yes" ]]; then
      if install_global_command_core "$CURRENT_SCRIPT_PATH"; then
        log "Menu reinstalled successfully (version ${LAST_GLOBAL_COMMAND_VERSION:-$SCRIPT_VERSION})."
      else
        warn "Failed to reinstall menu."
      fi
    else
      log "Reinstall canceled."
    fi
    press_enter_to_continue
    return 0
  fi

  local remote_version=""
  remote_version="$(read_script_version_header "$temp_remote" 2>/dev/null || true)"
  if [[ -z "$remote_version" ]]; then
    rm -f "$temp_remote"
    warn "Could not determine remote script version from GitHub."
    local reinstall_choice=""
    reinstall_choice="$(prompt_yes_no "Do you want to reinstall the current menu again?" "no")"
    if [[ "$reinstall_choice" == "yes" ]]; then
      if install_global_command_core "$CURRENT_SCRIPT_PATH"; then
        log "Menu reinstalled successfully (version ${LAST_GLOBAL_COMMAND_VERSION:-$SCRIPT_VERSION})."
      else
        warn "Failed to reinstall menu."
      fi
    else
      log "Reinstall canceled."
    fi
    press_enter_to_continue
    return 0
  fi

  if dpkg --compare-versions "$remote_version" gt "$SCRIPT_VERSION"; then
    log "Newer version available (${remote_version} > ${SCRIPT_VERSION}). Updating menu..."
    if ! run_silent run_as_root install -m 755 "$temp_remote" "$GLOBAL_COMMAND_PATH"; then
      rm -f "$temp_remote"
      warn "Failed to update menu."
      press_enter_to_continue
      return 1
    fi
    rm -f "$temp_remote"
    LAST_GLOBAL_COMMAND_VERSION="$remote_version"
    log "Menu updated to version ${remote_version}."
    log "Run it from anywhere with: songbird-deploy"
    press_enter_to_continue
    return 0
  fi

  rm -f "$temp_remote"
  log "Menu is already up to date (version ${SCRIPT_VERSION})."
  local reinstall_choice=""
  reinstall_choice="$(prompt_yes_no "Do you want to reinstall the current menu again?" "no")"
  if [[ "$reinstall_choice" == "yes" ]]; then
    if install_global_command_core "$CURRENT_SCRIPT_PATH"; then
      log "Menu reinstalled successfully (version ${LAST_GLOBAL_COMMAND_VERSION:-$SCRIPT_VERSION})."
    else
      warn "Failed to reinstall menu."
    fi
  else
    log "Reinstall canceled."
  fi
  press_enter_to_continue
  return 0
}

install_global_command() {
  update_menu
}

installed_global_command_version() {
  local version=""
  version="$(run_as_root bash -lc "if [[ -f '$GLOBAL_COMMAND_PATH' ]]; then grep -E '^# songbird-deploy-version:' '$GLOBAL_COMMAND_PATH' | head -n 1 | cut -d ':' -f 2- | xargs; fi" 2>/dev/null || true)"
  if [[ -z "$version" || "$version" == "auto" ]]; then
    return 1
  fi
  printf "%s" "$version"
}

ensure_global_command_on_first_run() {
  local installed_version=""
  local source_path="$CURRENT_SCRIPT_PATH"
  local source_version="$SCRIPT_VERSION"

  if [[ -z "$source_path" ]]; then
    # Piped from curl there is no script file. The copy that comes with the installed
    # sources is the right one; before the first install the install step puts it in place.
    if [[ -f "$INSTALL_DIR/scripts/install.sh" ]]; then
      source_path="$INSTALL_DIR/scripts/install.sh"
      source_version="$(resolve_script_version_for_path "$source_path" 2>/dev/null || printf "%s" "$SCRIPT_VERSION")"
    else
      return 0
    fi
  fi

  if ! run_as_root test -x "$GLOBAL_COMMAND_PATH"; then
    log "Global command not found. Installing it automatically..."
    if ! install_global_command_core "$source_path"; then
      warn "Automatic global command installation failed. You can retry from the menu."
    fi
    return 0
  fi

  installed_version="$(installed_global_command_version 2>/dev/null || true)"
  if [[ -z "$installed_version" ]]; then
    log "Global command version could not be determined. Reinstalling it automatically..."
    if ! install_global_command_core "$source_path"; then
      warn "Automatic global command reinstall failed. You can retry from the menu."
    fi
    return 0
  fi

  if dpkg --compare-versions "$installed_version" lt "$source_version"; then
    log "Global command version ${installed_version} is older than script version ${source_version}. Updating it automatically..."
    if ! install_global_command_core "$source_path"; then
      warn "Automatic global command update failed. You can retry from the menu."
    fi
  fi
}

show_logs() {
  if [[ -f "$LOG_FILE" ]]; then
    clear_screen
    printf "\n  Last %s lines of script log:\n\n" "$LOG_LINES"
    tail -n "$LOG_LINES" "$LOG_FILE"
  else
    printf "\n  No script log found at: %s\n" "$LOG_FILE"
  fi
  press_enter_to_continue
}

show_service_logs() {
  if systemctl list-units --type=service --all | grep songbird; then
    clear_screen
    printf "\n  Last %s lines of songbird service log:\n\n" "$LOG_LINES"
    run_as_root journalctl -u songbird --no-pager -n "$LOG_LINES"
  else
    printf "\n  Aurelle service not found.\n"
  fi
  press_enter_to_continue
}

show_worker_service_logs() {
  if systemctl list-units --type=service --all | grep songbird-worker; then
    clear_screen
    printf "\n  Last %s lines of songbird-worker service log:\n\n" "$LOG_LINES"
    run_as_root journalctl -u songbird-worker --no-pager -n "$LOG_LINES"
  else
    printf "\n  Aurelle worker service not found.\n"
  fi
  press_enter_to_continue
}

show_nginx_access_logs() {
  local log_file="/var/log/nginx/access.log"

  if [[ -f "$log_file" ]]; then
    clear_screen
    printf "\n  Last %s lines of nginx access log:\n\n" "$LOG_LINES"
    run_as_root tail -n "$LOG_LINES" "$log_file"
  else
    printf "\n  Nginx access log not found: %s\n" "$log_file"
  fi
  press_enter_to_continue
}

show_nginx_error_logs() {
  local log_file="/var/log/nginx/error.log"

  if [[ -f "$log_file" ]]; then
    clear_screen
    printf "\n  Last %s lines of nginx error log:\n\n" "$LOG_LINES"
    run_as_root tail -n "$LOG_LINES" "$log_file"
  else
    printf "\n  Nginx error log not found: %s\n" "$log_file"
  fi
  press_enter_to_continue
}


show_banner() {
  printf '\033[1;38;2;42;186;130m'   # bold Aurelle green (#2ABA82)
  cat << 'EOF'
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║          █████╗ ██╗   ██╗██████╗ ███████╗██╗     ██╗     ███████╗         ║
║         ██╔══██╗██║   ██║██╔══██╗██╔════╝██║     ██║     ██╔════╝         ║
║         ███████║██║   ██║██████╔╝█████╗  ██║     ██║     █████╗           ║
║         ██╔══██║██║   ██║██╔══██╗██╔══╝  ██║     ██║     ██╔══╝           ║
║         ██║  ██║╚██████╔╝██║  ██║███████╗███████╗███████╗███████╗         ║
║         ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚══════╝         ║
║                                                                           ║
║                           D E P L O Y   T O O L                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
EOF
  printf 'Script Version: %s\n' "$SCRIPT_VERSION"
  printf '\033[0m'      # reset
}


show_menu() {
  clear_screen
  show_banner
  printf "\n"
  printf "Aurelle Deploy Menu\n"
  printf $'1) 📥  Install Aurelle\n'
  printf $'2) 🔄️  Update Aurelle\n'
  printf $'3) ♻️  Restart Aurelle\n'
  printf $'4) ⚙️  Edit Settings (.env)\n'
  printf $'5) 🗃️  Manage Database\n'
  printf $'6) 🗑️  Remove Aurelle\n'
  printf $'7) 🔄️  Update menu\n'
  printf $'8) 🌐  Configure mirrors\n'
  printf $'9) 📋  View Logs\n'
  printf $'10) 📞  Calls relay (coturn)\n'
  printf $'0) 🚪  Exit\n\n'
}

show_logs_menu() {
  while true; do
    clear_screen
    show_banner
    printf "\n"
    printf "Logs Menu\n"
    printf $'1) 📋  View script logs\n'
    printf $'2) 📋  View service logs\n'
    printf $'3) 📋  View worker service logs\n'
    printf $'4) 📋 View nginx access logs\n'
    printf $'5) 📋  View nginx error logs\n'
    printf $'6) ↩️  Go back\n'
    printf $'0) 🚪  Exit\n\n'

    prompt_read "Choose an option [0-6]: " choice
    case "$choice" in
      1) show_logs ;;
      2) show_service_logs ;;
      3) show_worker_service_logs ;;
      4) show_nginx_access_logs ;;
      5) show_nginx_error_logs ;;
      6) return ;;
      0) exit 0 ;;
      *) printf "Invalid choice. Select a number from 0 to 6.\n" ;;
    esac
  done
}

run_db_command_with_runner() {
  local command_runner="$1"
  shift
  local args=("$@")
  local escaped=""
  local part=""
  local path_prefix=""
  local path_export=""
  if [[ "${args[0]:-}" == "npm" ]]; then
    resolve_npm_exec_path || return 1
    args[0]="$NPM_EXEC_PATH"
  elif [[ "${args[0]:-}" == "node" ]]; then
    resolve_node_exec_path || return 1
    args[0]="$NODE_EXEC_PATH"
  fi
  path_prefix="$(node_tools_path_prefix)"
  if [[ -n "$path_prefix" ]]; then
    path_export="export PATH=$(printf '%q' "$path_prefix"):\$PATH; "
  fi
  for part in "${args[@]}"; do
    escaped+=" $(printf '%q' "$part")"
  done
  "$command_runner" bash -lc "cd '$INSTALL_DIR' && ${path_export}${escaped:1} </dev/null"
}

run_db_command() {
  run_db_command_with_runner run_data_command "$@"
}

run_db_command_interactive() {
  local args=("$@")
  local escaped=""
  local part=""
  local path_prefix=""
  local path_export=""
  if [[ "${args[0]:-}" == "npm" ]]; then
    resolve_npm_exec_path || return 1
    args[0]="$NPM_EXEC_PATH"
  elif [[ "${args[0]:-}" == "node" ]]; then
    resolve_node_exec_path || return 1
    args[0]="$NODE_EXEC_PATH"
  fi
  path_prefix="$(node_tools_path_prefix)"
  if [[ -n "$path_prefix" ]]; then
    path_export="export PATH=$(printf '%q' "$path_prefix"):\$PATH; "
  fi
  for part in "${args[@]}"; do
    escaped+=" $(printf '%q' "$part")"
  done
  run_data_command bash -lc "cd '$INSTALL_DIR' && ${path_export}${escaped:1} </dev/tty >/dev/tty 2>&1"
}

run_db_command_logged_quiet() {
  local args=("$@")
  local escaped=""
  local part=""
  local path_prefix=""
  local path_export=""
  if [[ "${args[0]:-}" == "npm" ]]; then
    resolve_npm_exec_path || return 1
    args[0]="$NPM_EXEC_PATH"
  elif [[ "${args[0]:-}" == "node" ]]; then
    resolve_node_exec_path || return 1
    args[0]="$NODE_EXEC_PATH"
  fi
  path_prefix="$(node_tools_path_prefix)"
  if [[ -n "$path_prefix" ]]; then
    path_export="export PATH=$(printf '%q' "$path_prefix"):\$PATH; "
  fi
  for part in "${args[@]}"; do
    escaped+=" $(printf '%q' "$part")"
  done
  run_logged_quiet run_data_command bash -lc "cd '$INSTALL_DIR' && ${path_export}${escaped:1} </dev/null"
}

split_db_selector_input() {
  local input="$1"
  local __result_var="$2"

  if [[ ! "$__result_var" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    return 1
  fi

  input="$(printf "%s" "$input" | tr ',' ' ')"
  input="${input#"${input%%[![:space:]]*}"}"
  input="${input%"${input##*[![:space:]]}"}"
  read -r -a "$__result_var" <<< "$input"
}

resolve_chat_visibility_for_script() {
  local chat_selector="$1"
  [[ -n "$chat_selector" ]] || return 1
  local path_prefix=""
  path_prefix="$(node_tools_path_prefix)"

  run_data_command env INSTALL_DIR="$INSTALL_DIR" CHAT_SELECTOR="$chat_selector" NODE_TOOLS_PATH_PREFIX="$path_prefix" bash -lc '
    if [[ -n "$NODE_TOOLS_PATH_PREFIX" ]]; then
      export PATH="$NODE_TOOLS_PATH_PREFIX:$PATH"
    fi
    cd "$INSTALL_DIR" || exit 1
    node --input-type=module -e "
      import { pathToFileURL } from \"node:url\";
      const rootUrl = pathToFileURL(process.cwd() + \"/\");
      const { openDatabase } = await import(new URL(\"./server/scripts/_db-admin.js\", rootUrl));
      const { resolveChatRow } = await import(new URL(\"./server/lib/dbToolHelpers.js\", rootUrl));
      const dbApi = await openDatabase();
      try {
        const chat = await resolveChatRow(dbApi, String(process.env.CHAT_SELECTOR || \"\").trim());
        if (!chat?.id) {
          process.exit(2);
        }
        process.stdout.write(String(chat.group_visibility || \"public\").trim().toLowerCase() || \"public\");
      } finally {
        await dbApi?.close();
      }
    "
  '
}

# Check whether any user with role='owner' exists in the database.
# Exits 0 if owner exists, 1 if not (or if check fails).
check_owner_exists() {
  run_db_command_logged_quiet npm --prefix server run db:owner:check
}

# After installation, offer to create an owner user if none exists. Unattended, the
# account is created only when AURELLE_OWNER_USERNAME and AURELLE_OWNER_PASSWORD are set.
create_owner_user() {
  local nickname=""
  local username=""
  local password=""

  if check_owner_exists; then
    OWNER_CREATED="existing"
    return 0
  fi

  if is_unattended; then
    if [[ -z "$AURELLE_OWNER_USERNAME" ]]; then
      log "No owner account yet. The summary below says how to create it."
      return 0
    fi
    username="$AURELLE_OWNER_USERNAME"
    nickname="${AURELLE_OWNER_NICKNAME:-$AURELLE_OWNER_USERNAME}"
    log "Creating the owner account ${username}..."
    run_db_command npm --silent --prefix server run db:user:create -- \
      --nickname "$nickname" \
      --username "$username" \
      --password "$AURELLE_OWNER_PASSWORD" \
      --role owner || return 1
    OWNER_CREATED="$username"
    return 0
  fi

  printf "\n"
  log "No owner user found in the database."
  if [[ "$(prompt_yes_no "Would you like to create an owner user now?" "yes")" != "yes" ]]; then
    return 0
  fi

  nickname="$(prompt_non_empty "Nickname")"
  username="$(prompt_non_empty "Username (lowercase letters, numbers, ., _)")"
  password="$(prompt_secret "Password")"

  run_db_command npm --silent --prefix server run db:user:create -- \
    --nickname "$nickname" \
    --username "$username" \
    --password "$password" \
    --role owner || return 1
  OWNER_CREATED="$username"
}

print_db_script_help() {
  cat <<'EOF'
Aurelle Script Database Menu

The installer collects every required value before running DB commands, then
passes those values as CLI flags/arguments with stdin closed so the nested
command cannot ask hidden follow-up questions.

Inspect:
  1-4   Inspect database/chats/users/files
        Prompts: row limit
        Passes: --limit

Backup & repair:
  5     Backup database
        Prompts: none
        Passes: (no arguments)
  6     Restore backup
        Prompts: backup .db (SQLite) or .dump (PostgreSQL) path, restore confirmation
        Passes: -y --file
  7     Vacuum database
        Prompts: confirmation
        Passes: -y
  8     Reset database
        Prompts: confirmation, recreate yes/no
        Passes: -y --recreate or -y --no-recreate
  9     Delete database
        Prompts: confirmation
        Passes: -y

User and chat management:
  10    Create user
        Prompts: nickname, username, password, role (user/admin/owner, default: user)
        Passes: --nickname --username --password --role
  11    Generate users in bulk
        Prompts: count, password, nickname prefix, username prefix
        Passes: --count --password --nickname-prefix --username-prefix
  12    Edit user
        Prompts: user selector and optional profile fields and role
        Passes: selector plus any changed --username/--nickname/--avatar-url/--status/--color/--role
  13    Ban/unban user
        Prompts: user selector, confirmation
        Passes: -y selector
  14    Verify/unverify user
        Prompts: user selector, confirmation
        Passes: selector
  15    Create group/channel
        Prompts: type, name, username, visibility, owner, optional members
        For channels: optional remote channel configuration (Telegram source, sync metadata, stream media)
        Passes: --type --name --owner --username --visibility --users [--remote-channel --sync-metadata --stream-media]
  16    Add members to chat
        Prompts: chat selector, all-users yes/no, or user selectors
        Passes: chat selector plus --all or user selectors
  17    Edit chat
        Prompts: chat selector and optional profile/settings fields
        For channels with remote channel: menu with 9 actions (update source, toggle settings, enable/disable, pause/resume queue, skip queue items)
        Passes: selector plus any changed --name/--username/--visibility/--color/--owner/invite flag
        Or: --remote-channel --sync-metadata/--no-sync-metadata --stream-media/--no-stream-media
        Or: --enable-remote/--disable-remote --pause-queue/--resume-queue --skip-queue/--skip-all-queue
  18    Verify/unverify chat
        Prompts: chat selector, confirmation
        Passes: selector

Remote channel configuration:
  19    Configure Remote Channel
        Prompts: Telegram API ID/hash, proxy URL, phone number, optional 2FA password
        Passes: --api-id --api-hash --proxy-url/--no-proxy --phone-number [--password]

Destructive actions:
  20    Delete chats
        Prompts: chat ids/usernames or "all"
        Passes: -y selectors or --all -y
  21    Delete users
        Prompts: user ids/usernames or "all"
        Passes: -y selectors or --all -y
  22    Delete files
        Prompts: file ids/stored names or "all"
        Passes: -y selectors or --all -y

Notes:
  - "all" is explicit for chat/user/file delete actions.
  - "Ban/unban user" is a toggle and expires that user's sessions.
  - "Verify/unverify user" is a toggle: run it again to remove verification.
  - "Verify/unverify chat" is a toggle: run it again to remove verification.
  - Public chats always allow member invites. Invite settings only apply to private chats.
  - Backups are timestamped .db copies for SQLite or .dump archives for PostgreSQL, saved to data/backups/.
  - Restore replaces the active database with the selected backup format.
EOF
}

db_backup() {
  log "Creating database backup..."
  run_db_command npm --prefix server run db:backup
  press_enter_to_continue
}

db_help() {
  clear_screen
  show_banner
  printf "\n"
  print_db_script_help
  press_enter_to_continue
}

db_vacuum() {
  if [[ "$(prompt_yes_no "This will run VACUUM and rewrite the database file. Continue?" "no")" != "yes" ]]; then
    log "VACUUM canceled."
    press_enter_to_continue
    return 0
  fi
  run_db_command npm --prefix server run db:vacuum -- -y
  press_enter_to_continue
}

db_restore() {
  local backup_path=""

  backup_path="$(select_backup_path)"
  if [[ "$(prompt_yes_no "This will replace the current database with ${backup_path}. Continue?" "yes")" != "yes" ]]; then
    log "Restore canceled."
    press_enter_to_continue
    return 0
  fi
  run_db_command npm --prefix server run db:restore -- -y --file "$backup_path"
  press_enter_to_continue
}

db_inspect() {
  local kind="$1"
  local limit=""
  prompt_read "Enter row limit (default: 25): " limit
  limit="${limit#"${limit%%[![:space:]]*}"}"
  limit="${limit%"${limit##*[![:space:]]}"}"
  [[ -z "$limit" ]] && limit="25"

  case "$kind" in
    all) run_db_command npm --prefix server run db:inspect -- --limit "$limit" ;;
    chat) run_db_command npm --prefix server run db:chat:inspect -- --limit "$limit" ;;
    user) run_db_command npm --prefix server run db:user:inspect -- --limit "$limit" ;;
    file) run_db_command npm --prefix server run db:file:inspect -- --limit "$limit" ;;
  esac
  press_enter_to_continue
}

db_reset() {
  if [[ "$(prompt_yes_no "This will reset database and delete uploads. Continue?" "no")" != "yes" ]]; then
    log "Reset canceled."
    press_enter_to_continue
    return 0
  fi
  local recreate="yes"
  if [[ "$(prompt_yes_no "Recreate a fresh database after reset?" "yes")" != "yes" ]]; then
    recreate="no"
  fi

  if [[ "$recreate" == "yes" ]]; then
    run_db_command npm --prefix server run db:reset -- -y --recreate
  else
    run_db_command npm --prefix server run db:reset -- -y --no-recreate
  fi
  press_enter_to_continue
}

db_delete() {
  if [[ "$(prompt_yes_no "This will permanently delete database and uploads. Continue?" "no")" != "yes" ]]; then
    log "Delete canceled."
    press_enter_to_continue
    return 0
  fi
  run_db_command npm --prefix server run db:delete -- -y
  press_enter_to_continue
}

db_chat_delete() {
  local input=""
  local selectors=()
  prompt_read "Enter chat IDs or group/channel usernames (comma/space separated), or type 'all': " input
  split_db_selector_input "$input" selectors

  if [[ "${#selectors[@]}" -eq 0 ]]; then
    printf "No input provided.\n"
    press_enter_to_continue
    return 0
  fi

  if [[ "${#selectors[@]}" -eq 1 && "${selectors[0],,}" == "all" ]]; then
    run_db_command npm --prefix server run db:chat:delete -- --all -y
  else
    run_db_command npm --prefix server run db:chat:delete -- -y "${selectors[@]}"
  fi
  press_enter_to_continue
}

db_file_delete() {
  local input=""
  local selectors=()
  prompt_read "Enter file IDs or stored names (comma/space separated) or type 'all': " input
  split_db_selector_input "$input" selectors

  if [[ "${#selectors[@]}" -eq 0 ]]; then
    printf "No input provided.\n"
    press_enter_to_continue
    return 0
  fi

  if [[ "${#selectors[@]}" -eq 1 && "${selectors[0],,}" == "all" ]]; then
    run_db_command npm --prefix server run db:file:delete -- --all -y
  else
    run_db_command npm --prefix server run db:file:delete -- -y "${selectors[@]}"
  fi
  press_enter_to_continue
}

db_user_delete() {
  local input=""
  local selectors=()
  prompt_read "Enter user IDs or usernames (comma/space separated) or type 'all': " input
  split_db_selector_input "$input" selectors

  if [[ "${#selectors[@]}" -eq 0 ]]; then
    printf "No input provided.\n"
    press_enter_to_continue
    return 0
  fi

  if [[ "${#selectors[@]}" -eq 1 && "${selectors[0],,}" == "all" ]]; then
    run_db_command npm --prefix server run db:user:delete -- --all -y
  else
    run_db_command npm --prefix server run db:user:delete -- -y "${selectors[@]}"
  fi
  press_enter_to_continue
}

db_user_create() {
  local nickname=""
  local username=""
  local password=""
  local role=""

  nickname="$(prompt_non_empty "Nickname")"
  username="$(prompt_non_empty "Username (lowercase letters, numbers, ., _)")"
  password="$(prompt_secret "Password")"

  while true; do
    prompt_read "Role (user/admin/owner, default: user): " role
    role="${role#"${role%%[![:space:]]*}"}"
    role="${role%"${role##*[![:space:]]}"}"
    [[ -z "$role" ]] && role="user"
    case "$role" in
      user|admin|owner) break ;;
      *) printf "Invalid role. Choose: user, admin, or owner.\n" ;;
    esac
  done

  run_db_command npm --silent --prefix server run db:user:create -- \
    --nickname "$nickname" \
    --username "$username" \
    --password "$password" \
    --role "$role"
  press_enter_to_continue
}

db_user_generate() {
  local count=""
  local password=""
  local nickname_prefix=""
  local username_prefix=""

  prompt_read "How many users to create? (default: 10): " count
  count="${count#"${count%%[![:space:]]*}"}"
  count="${count%"${count##*[![:space:]]}"}"
  [[ -z "$count" ]] && count="10"

  password="$(prompt_secret_optional "Password for generated users? (default: Passw0rd!)")"
  [[ -z "$password" ]] && password="Passw0rd!"

  prompt_read "Nickname prefix (default: User): " nickname_prefix
  nickname_prefix="${nickname_prefix#"${nickname_prefix%%[![:space:]]*}"}"
  nickname_prefix="${nickname_prefix%"${nickname_prefix##*[![:space:]]}"}"
  [[ -z "$nickname_prefix" ]] && nickname_prefix="User"

  prompt_read "Username prefix (default: user): " username_prefix
  username_prefix="${username_prefix#"${username_prefix%%[![:space:]]*}"}"
  username_prefix="${username_prefix%"${username_prefix##*[![:space:]]}"}"
  [[ -z "$username_prefix" ]] && username_prefix="user"

  run_db_command npm --prefix server run db:user:generate -- \
    --count "$count" \
    --password "$password" \
    --nickname-prefix "$nickname_prefix" \
    --username-prefix "$username_prefix"
  press_enter_to_continue
}

db_chat_create() {
  local type=""
  local name=""
  local username=""
  local visibility=""
  local owner=""
  local members=""
  local configure_remote="no"
  local remote_source=""
  local sync_metadata="no"
  local stream_media="no"

  prompt_read "Type (group/channel, default: group): " type
  type="${type#"${type%%[![:space:]]*}"}"
  type="${type%"${type##*[![:space:]]}"}"
  [[ -z "$type" ]] && type="group"

  name="$(prompt_non_empty "Chat name")"
  username="$(prompt_non_empty "Chat username/handle (without @)")"
  prompt_read "Visibility (public/private, default: public): " visibility
  visibility="${visibility#"${visibility%%[![:space:]]*}"}"
  visibility="${visibility%"${visibility##*[![:space:]]}"}"
  [[ -z "$visibility" ]] && visibility="public"
  owner="$(prompt_non_empty "Owner username or id")"
  prompt_read "Add members (comma separated usernames/ids, optional): " members

  local args=(
    --type "$type"
    --name "$name"
    --owner "$owner"
    --username "$username"
    --visibility "$visibility"
    --users "$members"
  )

  # Only offer remote channel configuration for channels
  if [[ "${type,,}" == "channel" ]]; then
    configure_remote="$(prompt_yes_no "Configure remote channel for this channel?" "no")"
    
    if [[ "$configure_remote" == "yes" ]]; then
      local remote_enabled="$(get_existing_env_value "REMOTE_CHANNEL" "false")"
      remote_enabled="${remote_enabled,,}"
      if [[ "$remote_enabled" != "true" ]]; then
        warn "Remote channel feature is disabled. Configure it first."
        press_enter_to_continue
        return 1
      fi
      
      remote_source="$(prompt_non_empty "Telegram source (username, t.me link, or chat ID)")"
      sync_metadata="$(prompt_yes_no "Sync metadata (name/avatar) from Telegram?" "yes")"
      stream_media="$(prompt_yes_no "Stream media files from Telegram?" "yes")"
      
      args+=(--remote-channel "$remote_source")
      [[ "$sync_metadata" == "yes" ]] && args+=(--sync-metadata)
      [[ "$stream_media" == "yes" ]] && args+=(--stream-media)
    fi
  fi

  run_db_command npm --prefix server run db:chat:create -- "${args[@]}"
  press_enter_to_continue
}

db_chat_add() {
  local chat=""
  local users=""
  local user_selectors=()
  local add_all="no"

  chat="$(prompt_non_empty "Chat id or username")"
  add_all="$(prompt_yes_no "Add all users in the database to this chat?" "no")"

  if [[ "$add_all" == "yes" ]]; then
    run_db_command npm --prefix server run db:chat:add -- "$chat" --all
    press_enter_to_continue
    return 0
  fi

  users="$(prompt_non_empty "Usernames or ids (comma separated)")"
  split_db_selector_input "$users" user_selectors
  if [[ "${#user_selectors[@]}" -eq 0 ]]; then
    printf "No users provided.\n"
    press_enter_to_continue
    return 0
  fi
  run_db_command npm --prefix server run db:chat:add -- "$chat" "${user_selectors[@]}"
  press_enter_to_continue
}

db_chat_edit() {
  local chat=""
  local name=""
  local username=""
  local visibility=""
  local color=""
  local owner=""
  local invites=""
  local effective_visibility=""
  local configure_remote="no"
  local remote_action=""
  local remote_source=""
  local sync_metadata=""
  local stream_media=""
  local args=()

  chat="$(prompt_non_empty "Chat id or username")"
  
  configure_remote="$(prompt_yes_no "Update remote channel configuration?" "no")"
  
  if [[ "$configure_remote" == "yes" ]]; then
    local remote_enabled="$(get_existing_env_value "REMOTE_CHANNEL" "false")"
    remote_enabled="${remote_enabled,,}"
    if [[ "$remote_enabled" != "true" ]]; then
      warn "Remote channel feature is disabled. Configure it first."
      press_enter_to_continue
      return 1
    fi
    
    args+=("$chat")
    
    printf "\n Remote channel Actions:\n"
    printf "  1. Update Telegram source\n"
    printf "  2. Toggle sync metadata\n"
    printf "  3. Toggle stream media\n"
    printf "  4. Enable remote channel\n"
    printf "  5. Disable remote channel\n"
    printf "  6. Pause queue\n"
    printf "  7. Resume queue\n"
    printf "  8. Skip current queue item\n"
    printf "  9. Skip all queue items\n"
    printf "\n"
    
    prompt_read "Select action (1-9, or leave blank to cancel): " remote_action
    
    case "$remote_action" in
      1)
        remote_source="$(prompt_non_empty "New Telegram source (username, t.me link, or chat ID)")"
        args+=(--remote-channel "$remote_source")
        ;;
      2)
        prompt_read "Sync metadata? (yes/no): " sync_metadata
        if [[ "${sync_metadata,,}" == "yes" ]]; then
          args+=(--sync-metadata)
        elif [[ "${sync_metadata,,}" == "no" ]]; then
          args+=(--no-sync-metadata)
        fi
        ;;
      3)
        prompt_read "Stream media? (yes/no): " stream_media
        if [[ "${stream_media,,}" == "yes" ]]; then
          args+=(--stream-media)
        elif [[ "${stream_media,,}" == "no" ]]; then
          args+=(--no-stream-media)
        fi
        ;;
      4)
        args+=(--enable-remote)
        ;;
      5)
        args+=(--disable-remote)
        ;;
      6)
        args+=(--pause-queue)
        ;;
      7)
        args+=(--resume-queue)
        ;;
      8)
        args+=(--skip-queue)
        ;;
      9)
        args+=(--skip-all-queue)
        ;;
      *)
        log "No action selected. Canceled."
        press_enter_to_continue
        return 0
        ;;
    esac
    
    run_db_command npm --prefix server run db:chat:edit -- "${args[@]}"
    press_enter_to_continue
    return 0
  fi

  prompt_read "New chat name (optional): " name
  prompt_read "New chat username/handle (optional, without @): " username
  prompt_read "Visibility (public/private, optional): " visibility
  prompt_read "Color hex (optional, example: #10b981): " color
  prompt_read "New owner username or id (optional): " owner

  args+=("$chat")
  [[ -n "$name" ]] && args+=(--name "$name")
  [[ -n "$username" ]] && args+=(--username "$username")
  [[ -n "$visibility" ]] && args+=(--visibility "$visibility")
  [[ -n "$color" ]] && args+=(--color "$color")
  [[ -n "$owner" ]] && args+=(--owner "$owner")

  if [[ -n "$visibility" ]]; then
    effective_visibility="${visibility,,}"
  else
    effective_visibility="$(resolve_chat_visibility_for_script "$chat" 2>/dev/null || true)"
  fi

  if [[ "$effective_visibility" == "private" ]]; then
    prompt_read "Member invites setting for this private chat (allow/deny, default: allow): " invites
    invites="${invites#"${invites%%[![:space:]]*}"}"
    invites="${invites%"${invites##*[![:space:]]}"}"
    [[ -z "$invites" ]] && invites="allow"
  else
    log "Skipping member invites prompt because public chats always allow invites."
  fi

  if [[ "${invites,,}" == "allow" ]]; then
    args+=(--allow-member-invites)
  elif [[ "${invites,,}" == "deny" || "${invites,,}" == "disallow" ]]; then
    args+=(--disallow-member-invites)
  fi

  run_db_command npm --prefix server run db:chat:edit -- "${args[@]}"
  press_enter_to_continue
}

db_chat_verify() {
  local chat=""
  chat="$(prompt_non_empty "Chat id or username")"
  if [[ "$(prompt_yes_no "Toggle verification state for ${chat} ?" "no")" != "yes" ]]; then
    log "Verify/unverify canceled."
    press_enter_to_continue
    return 0
  fi
  run_db_command npm --prefix server run db:chat:verify -- "$chat"
  press_enter_to_continue
}

db_user_edit() {
  local user=""
  local username=""
  local nickname=""
  local avatar_url=""
  local status=""
  local color=""
  local role=""
  local args=()

  user="$(prompt_non_empty "User id or username")"
  prompt_read "New username (optional): " username
  prompt_read "New display name (optional): " nickname
  prompt_read "Avatar URL (optional): " avatar_url
  prompt_read "Status (online/invisible, optional): " status
  prompt_read "Color hex (optional, example: #10b981): " color

  while true; do
    prompt_read "Role (user/admin/owner, optional — leave blank to keep current): " role
    role="${role#"${role%%[![:space:]]*}"}"
    role="${role%"${role##*[![:space:]]}"}"
    if [[ -z "$role" ]]; then
      break
    fi
    case "$role" in
      user|admin|owner) break ;;
      *) printf "Invalid role. Choose: user, admin, owner, or leave blank.\n" ;;
    esac
  done

  args+=("$user")
  [[ -n "$username" ]] && args+=(--username "$username")
  [[ -n "$nickname" ]] && args+=(--nickname "$nickname")
  [[ -n "$avatar_url" ]] && args+=(--avatar-url "$avatar_url")
  [[ -n "$status" ]] && args+=(--status "$status")
  [[ -n "$color" ]] && args+=(--color "$color")
  [[ -n "$role" ]] && args+=(--role "$role")

  run_db_command npm --prefix server run db:user:edit -- "${args[@]}"
  press_enter_to_continue
}

db_user_ban() {
  local user=""
  user="$(prompt_non_empty "User id or username")"
  if [[ "$(prompt_yes_no "Toggle ban state for ${user} ?" "no")" != "yes" ]]; then
    log "Ban/unban canceled."
    press_enter_to_continue
    return 0
  fi
  run_db_command npm --prefix server run db:user:ban -- -y "$user"
  press_enter_to_continue
}

db_remote_configure() {
  local current_api_id=""
  local current_api_hash=""
  local current_proxy_url=""
  local api_id=""
  local api_hash=""
  local proxy_url=""
  local phone_number=""
  local two_step_password=""
  local force_sms="no"
  local args=()

  if [[ ! -d "${INSTALL_DIR}/server" ]]; then
    warn "Aurelle server directory not found at ${INSTALL_DIR}/server."
    press_enter_to_continue
    return 1
  fi

  current_api_id="$(sanitize_input_value "$(get_existing_env_value "REMOTE_CHANNEL_TELEGRAM_API_ID" "")")"
  current_api_hash="$(sanitize_input_value "$(get_existing_env_value "REMOTE_CHANNEL_TELEGRAM_API_HASH" "")")"
  current_proxy_url="$(sanitize_input_value "$(get_existing_env_value "REMOTE_CHANNEL_TELEGRAM_PROXY_URL" "$(get_existing_env_value "REMOTE_CHANNEL_PROXY_URL" "")")")"
  [[ "$current_api_id" == "0" ]] && current_api_id=""

  while true; do
    if [[ -n "$current_api_id" ]]; then
      prompt_read "Telegram API ID (default: ${current_api_id}): " api_id
      [[ -z "$api_id" ]] && api_id="$current_api_id"
    else
      prompt_read "Telegram API ID: " api_id
    fi
    api_id="${api_id#"${api_id%%[![:space:]]*}"}"
    api_id="${api_id%"${api_id##*[![:space:]]}"}"
    if [[ "$api_id" =~ ^[0-9]+$ && "$api_id" -gt 0 ]]; then
      break
    fi
    printf "Please enter a positive numeric Telegram API ID.\n"
  done

  if [[ -n "$current_api_hash" ]]; then
    api_hash="$(prompt_secret_optional "Telegram API hash (leave blank to keep existing)")"
    [[ -z "$api_hash" ]] && api_hash="$current_api_hash"
  else
    api_hash="$(prompt_secret "Telegram API hash")"
  fi

  if [[ -n "$current_proxy_url" ]]; then
    prompt_read "Telegram proxy URL (optional; default: ${current_proxy_url}; type none to clear): " proxy_url
    [[ -z "$proxy_url" ]] && proxy_url="$current_proxy_url"
  else
    prompt_read "Telegram proxy URL (optional): " proxy_url
  fi
  proxy_url="${proxy_url#"${proxy_url%%[![:space:]]*}"}"
  proxy_url="${proxy_url%"${proxy_url##*[![:space:]]}"}"
  if [[ "${proxy_url,,}" == "none" || "${proxy_url,,}" == "no" || "${proxy_url,,}" == "direct" ]]; then
    proxy_url=""
  fi

  phone_number="$(prompt_non_empty "Telegram phone number (with country code)")"
  two_step_password="$(prompt_secret_optional "Telegram two-step password (leave blank if disabled)")"
  force_sms="$(prompt_yes_no "Force SMS delivery for the login code?" "no")"

  printf "\nTelegram will send a login code now. Enter that code when the helper asks for it.\n"
  args=(
    node server/scripts/configure-remote-channel.js
    --env-file "${INSTALL_DIR}/.env"
    --api-id "$api_id"
    --api-hash "$api_hash"
    --phone-number "$phone_number"
  )
  if [[ -n "$proxy_url" ]]; then
    args+=(--proxy-url "$proxy_url")
  else
    args+=(--no-proxy)
  fi
  if [[ -n "$two_step_password" ]]; then
    args+=(--password "$two_step_password")
  fi
  if [[ "$force_sms" == "yes" ]]; then
    args+=(--force-sms)
  fi

  if ! run_db_command_interactive "${args[@]}"; then
    press_enter_to_continue
    return 1
  fi

  press_enter_to_continue
}

db_restore_backup() {
  local resolved=""
  resolved="$(select_backup_path)"

  if [[ "$(prompt_yes_no "This will replace the current database with ${resolved}. Continue?" "no")" != "yes" ]]; then
    log "Restore canceled."
    return 0
  fi

  DB_BACKUP_PATH="$resolved"
  restore_backup_if_provided
  press_enter_to_continue
}

db_user_verify() {
  local user=""
  user="$(prompt_non_empty "User id or username")"
  if [[ "$(prompt_yes_no "Toggle verification state for ${user} ?" "no")" != "yes" ]]; then
    log "Verify/unverify canceled."
    press_enter_to_continue
    return 0
  fi
  run_db_command npm --prefix server run db:user:verify -- "$user"
  press_enter_to_continue
}

show_db_menu() {
  sync_values_from_env
  while true; do
    clear_screen
    show_banner
    printf "\n"

    printf "Manage Database\n"
    printf "┌──── Inspect ─────────────────────────────────┐\n"
    printf "│                                              │\n"
    printf "│  1) 👁️  Inspect database (summary)           │\n"
    printf "│  2) 👁️  Inspect chats metadata               │\n"
    printf "│  3) 👁️  Inspect users                        │\n"
    printf "│  4) 👁️  Inspect files                        │\n"
    printf "│                                              │\n"
    printf "├──── Backup & Repair ─────────────────────────┤\n"
    printf "│                                              │\n"
    printf "│  5) 📤  Backup database                      │\n"
    printf "│  6) ♻️  Restore backup                       │\n"
    printf "│  7) 🧹  Vacuum database                      │\n"
    printf "│  8) 🔄️  Reset database                       │\n"
    printf "│  9) 🗑️  Delete database                      │\n"
    printf "│                                              │\n"
    printf "├──── User & Chat Management ──────────────────┤\n"
    printf "│                                              │\n"
    printf "│  10) 👤  Create user                         │\n"
    printf "│  11) 👥  Generate users (bulk)               │\n"
    printf "│  12) ✏️  Edit user                           │\n"
    printf "│  13) 🚫  Ban/unban user                      │\n"
    printf "│  14) ✅  Verify/unverify user                │\n"
    printf "│  15) 💬  Create group/channel                │\n"
    printf "│  16) ➕  Add members to chat                 │\n"
    printf "│  17) ✏️  Edit chat                           │\n"
    printf "│  18) ✅  Verify/unverify chat                │\n"
    printf "│                                              │\n"
    printf "├──── Remote Channels ─────────────────────────┤\n"
    printf "│                                              │\n"
    printf "│  19) 📡  Configure Remote Channel            │\n"
    printf "│                                              │\n"
    printf "├──── Destructive Actions ─────────────────────┤\n"
    printf "│                                              │\n"
    printf "│  20) 🗑️  Delete chats                        │\n"
    printf "│  21) 🗑️  Delete users                        │\n"
    printf "│  22) 🗑️  Delete files                        │\n"
    printf "│                                              │\n"
    printf "├──── Help & Navigation ───────────────────────┤\n"
    printf "│                                              │\n"
    printf "│  23) ❔  Show help                           │\n"
    printf "│  24) ↩️  Go back                             │\n"
    printf "│  0) 🚪  Exit                                 │\n"
    printf "│                                              │\n"
    printf "└──────────────────────────────────────────────┘\n\n"

    prompt_read "Choose an option [0-24]: " choice
    case "$choice" in
      1) db_inspect "all" ;;
      2) db_inspect "chat" ;;
      3) db_inspect "user" ;;
      4) db_inspect "file" ;;
      5) db_backup ;;
      6) db_restore ;;
      7) db_vacuum ;;
      8) db_reset ;;
      9) db_delete ;;
      10) db_user_create ;;
      11) db_user_generate ;;
      12) db_user_edit ;;
      13) db_user_ban ;;
      14) db_user_verify ;;
      15) db_chat_create ;;
      16) db_chat_add ;;
      17) db_chat_edit ;;
      18) db_chat_verify ;;
      19) db_remote_configure ;;
      20) db_chat_delete ;;
      21) db_user_delete ;;
      22) db_file_delete ;;
      23) db_help ;;
      24) return ;;
      0) exit 0 ;;
      *) printf "Invalid choice. Select a number from 0 to 24.\n" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Command line and unattended mode
# ---------------------------------------------------------------------------

print_usage() {
  cat <<EOF
Aurelle deploy tool (version ${SCRIPT_VERSION})

Usage: install.sh [options]

Without options the interactive menu opens. With --yes nothing is asked: every
value comes from a flag, an AURELLE_* variable or a default, and the script
installs Aurelle (or updates an installation that is already there).

One line, unattended:

  curl -fsSL ${SCRIPT_REMOTE_URL} | sudo env AURELLE_YES=1 AURELLE_DOMAIN=chat.example.com AURELLE_EMAIL=me@example.com bash
  curl -fsSL ${SCRIPT_REMOTE_URL} | sudo bash -s -- --yes --domain chat.example.com --email me@example.com

Options (the variable that does the same is in brackets):
  -y, --yes                Install or update without questions [AURELLE_YES=1]
      --domain NAMES       Serve on these comma-separated domains [AURELLE_DOMAIN]; without one the server IP is used
      --email ADDRESS      Contact for Let's Encrypt and push notifications [AURELLE_EMAIL]
      --tls MODE           auto (default: HTTPS for a domain, HTTP for an IP), certbot, selfsigned, files, http [AURELLE_TLS]
      --tls-cert FILE      fullchain.pem for --tls files [AURELLE_TLS_CERT]
      --tls-key FILE       privkey.pem for --tls files [AURELLE_TLS_KEY]
      --ip ADDRESS         This server's public IPv4, when it cannot be detected [AURELLE_PUBLIC_IP]
      --server-port N      Port of the Aurelle server, default ${DEFAULT_SERVER_PORT} [AURELLE_SERVER_PORT]
      --client-port N      Port nginx listens on, default 80 (443 with TLS) [AURELLE_CLIENT_PORT]
      --worker-port N      Port of the media worker, default ${DEFAULT_WORKER_PORT} [AURELLE_WORKER_PORT]
      --calls-relay        Install the voice and video calls relay (coturn), the default [AURELLE_CALLS_RELAY=1]
      --no-calls-relay     Do not install it [AURELLE_CALLS_RELAY=0]
      --action ACTION      auto (default: install, or update when installed), install or update [AURELLE_ACTION]
      --branch REF         Branch or tag to install, default is the repository's default branch [REPO_BRANCH]
      --repo URL           Git repository to install from [REPO_URL]
  -v, --version            Print the version of this script
  -h, --help               Print this help

More variables: AURELLE_DB (sqlite3 or postgres), AURELLE_POSTGRES_URL, AURELLE_BACKUP=1
(back up the database before an update), AURELLE_RESTORE_BACKUP (file to restore on a new
install), AURELLE_OWNER_USERNAME / AURELLE_OWNER_PASSWORD / AURELLE_OWNER_NICKNAME (create the
first owner account), AURELLE_RELAY_PORT, AURELLE_RELAY_MIN_PORT, AURELLE_RELAY_MAX_PORT,
MIRROR_NODESOURCE, MIRROR_NPM and MIRROR_APT_EXTRA (restricted networks).

Exit codes: 0 done, 1 failed, ${EXIT_USAGE} wrong usage or no terminal to ask on,
${EXIT_TLS_FAILED} installed but the TLS certificate could not be issued (the site works over HTTP).
EOF
}

# Stores one valued flag in the variable that the unattended mode reads.
set_cli_option() {
  local flag="$1"
  local value="$2"
  case "$flag" in
    --domain) AURELLE_DOMAIN="$value" ;;
    --email) AURELLE_EMAIL="$value" ;;
    --tls) AURELLE_TLS="$value" ;;
    --tls-cert) AURELLE_TLS_CERT="$value" ;;
    --tls-key) AURELLE_TLS_KEY="$value" ;;
    --ip) AURELLE_PUBLIC_IP="$value" ;;
    --server-port) AURELLE_SERVER_PORT="$value" ;;
    --client-port) AURELLE_CLIENT_PORT="$value" ;;
    --worker-port) AURELLE_WORKER_PORT="$value" ;;
    --calls-relay) AURELLE_CALLS_RELAY="$value" ;;
    --action) AURELLE_ACTION="$value" ;;
    --branch) REPO_BRANCH="$value" ;;
    --repo) REPO_URL="$value" ;;
    *) usage_fail "Unknown option: ${flag}" ;;
  esac
}

parse_cli_args() {
  local arg=""
  local value=""
  while (( $# > 0 )); do
    arg="$1"
    case "$arg" in
      -y|--yes|--unattended|--non-interactive)
        AURELLE_YES="1"
        shift
        ;;
      -h|--help)
        print_usage
        SKIP_CLEAR_ON_EXIT="1"
        exit 0
        ;;
      -v|--version)
        SHOW_VERSION="1"
        shift
        ;;
      --no-calls-relay)
        AURELLE_CALLS_RELAY="0"
        shift
        ;;
      --calls-relay)
        # A bare --calls-relay means yes; an explicit yes/no/force may follow.
        if [[ "${2:-}" =~ ^(1|0|yes|no|true|false|force)$ ]]; then
          AURELLE_CALLS_RELAY="$2"
          shift 2
        else
          AURELLE_CALLS_RELAY="1"
          shift
        fi
        ;;
      --calls-relay=*)
        AURELLE_CALLS_RELAY="${arg#*=}"
        shift
        ;;
      --domain|--email|--tls|--tls-cert|--tls-key|--ip|--server-port|--client-port|--worker-port|--action|--branch|--repo)
        if (( $# < 2 )); then
          usage_fail "${arg} needs a value."
        fi
        value="$2"
        set_cli_option "$arg" "$value"
        shift 2
        ;;
      --domain=*|--email=*|--tls=*|--tls-cert=*|--tls-key=*|--ip=*|--server-port=*|--client-port=*|--worker-port=*|--action=*|--branch=*|--repo=*)
        set_cli_option "${arg%%=*}" "${arg#*=}"
        shift
        ;;
      --)
        shift
        break
        ;;
      *)
        usage_fail "Unknown option: ${arg}"
        ;;
    esac
  done
  if (( $# > 0 )); then
    usage_fail "Unexpected argument: $1"
  fi
  validate_repo_settings
  if is_truthy "$AURELLE_YES"; then
    UNATTENDED="1"
  fi
}

lowercase() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

# Stores a port from a flag or variable, or the default, in the variable named by
# the first argument; anything else is a usage error. It does not print its
# result so that the error exits the script and not a subshell.
unattended_port() {
  local __result_var="$1"
  local name="$2"
  local value=""
  value="$(sanitize_input_value "${3:-}")"
  local default="$4"
  if [[ -z "$value" ]]; then
    printf -v "$__result_var" '%s' "$default"
    return 0
  fi
  # 10# keeps a leading zero (0080) from being read as octal.
  if [[ "$value" =~ ^0*[0-9]{1,5}$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )); then
    printf -v "$__result_var" '%s' "$((10#$value))"
    return 0
  fi
  usage_fail "${name} must be a port between 1 and 65535 (got: ${value//[^[:print:]]/?})."
}

is_valid_domain_name() {
  local name="${1:-}"
  [[ ${#name} -le 253 ]] || return 1
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$ ]]
}

# A plain address: letters, digits and . _ + - in the part before the @, a host name
# with a top-level domain after it. The address is written into a systemd unit, into
# the .env file and passed to certbot, so shell, sed, systemd (% and $) and .env (#, =)
# characters, quotes and line breaks are not allowed at all.
is_valid_email() {
  local address="${1:-}"
  (( ${#address} <= 254 )) || return 1
  [[ "$address" =~ ^[A-Za-z0-9_][A-Za-z0-9._+-]*@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$ ]]
}

# A branch or tag name that is safe to put into a git command line and into shell
# strings: letters, digits and . _ - / +, no option look-alike, none of the sequences git
# itself refuses (.., //, a trailing / or .lock).
is_valid_git_ref_name() {
  local name="${1:-}"
  [[ -n "$name" && ${#name} -le 200 ]] || return 1
  [[ "$name" =~ ^[A-Za-z0-9_][A-Za-z0-9._/+-]*$ ]] || return 1
  [[ "$name" != *..* && "$name" != *//* && "$name" != */ && "$name" != *.lock && "$name" != *.lock/* && "$name" != *. ]] || return 1
  return 0
}

# Refuses a REPO_BRANCH or REPO_URL that could be read as something other than a name or
# an address. Both come from the environment or the command line.
validate_repo_settings() {
  if [[ -n "$REPO_BRANCH" ]] && ! is_valid_git_ref_name "$REPO_BRANCH"; then
    usage_fail "REPO_BRANCH (--branch) is not a branch or tag name: letters, digits and . _ - / + only (got: ${REPO_BRANCH//[^[:print:]]/?})."
  fi
  if [[ "$REPO_URL" == -* || "$REPO_URL" == *[[:cntrl:]]* ]]; then
    usage_fail "REPO_URL (--repo) is not a repository address (got: ${REPO_URL//[^[:print:]]/?})."
  fi
}

is_valid_ipv4() {
  local ip="${1:-}"
  [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  local octet=""
  local IFS=.
  for octet in $ip; do
    (( 10#$octet <= 255 )) || return 1
  done
  return 0
}

# Addresses that cannot be reached from the internet: private, loopback, link-local, CGNAT.
is_private_ipv4() {
  local ip="${1:-}"
  is_valid_ipv4 "$ip" || return 1
  local a="" b=""
  IFS=. read -r a b _ _ <<< "$ip"
  a=$((10#$a))
  b=$((10#$b))
  (( a == 10 || a == 127 || a == 0 )) && return 0
  (( a == 172 && b >= 16 && b <= 31 )) && return 0
  (( a == 192 && b == 168 )) && return 0
  (( a == 169 && b == 254 )) && return 0
  (( a == 100 && b >= 64 && b <= 127 )) && return 0
  return 1
}

# Turns the AURELLE_* values into the variables the interactive questions fill.
resolve_unattended_options() {
  local domain_raw=""
  local tls_choice=""
  local domain=""

  unattended_port SERVER_PORT AURELLE_SERVER_PORT "$AURELLE_SERVER_PORT" "$DEFAULT_SERVER_PORT"
  unattended_port WORKER_PORT AURELLE_WORKER_PORT "$AURELLE_WORKER_PORT" "$DEFAULT_WORKER_PORT"

  CERTBOT_EMAIL="$(sanitize_input_value "$AURELLE_EMAIL")"
  if [[ -n "$CERTBOT_EMAIL" ]] && ! is_valid_email "$CERTBOT_EMAIL"; then
    usage_fail "AURELLE_EMAIL is not an email address: ${CERTBOT_EMAIL}"
  fi

  domain_raw="$(sanitize_input_value "$AURELLE_DOMAIN")"
  if [[ -n "$domain_raw" ]]; then
    DEPLOY_MODE="domain"
    parse_domain_input "$domain_raw"
    if (( ${#DOMAIN_NAMES[@]} == 0 )); then
      usage_fail "AURELLE_DOMAIN has no usable domain name (got: ${domain_raw})."
    fi
    for domain in "${DOMAIN_NAMES[@]}"; do
      if ! is_valid_domain_name "$domain"; then
        usage_fail "AURELLE_DOMAIN contains an invalid domain name: ${domain}"
      fi
    done
    log_domain_groups
  else
    DEPLOY_MODE="ip"
    DOMAIN_NAMES=()
    DOMAIN_GROUPS=()
    NGINX_SERVER_NAME="_"
  fi

  if [[ -n "$AURELLE_PUBLIC_IP" ]] && ! is_valid_ipv4 "$AURELLE_PUBLIC_IP"; then
    usage_fail "AURELLE_PUBLIC_IP is not an IPv4 address: ${AURELLE_PUBLIC_IP}"
  fi

  tls_choice="$(lowercase "$(sanitize_input_value "$AURELLE_TLS")")"
  case "$tls_choice" in
    ""|auto)
      # A domain gets a real certificate. A bare IP stays on HTTP: an IP
      # certificate lives six days and needs the address to be reachable.
      if [[ "$DEPLOY_MODE" == "domain" ]]; then
        CERT_MODE="certbot"
      else
        CERT_MODE="http"
      fi
      ;;
    certbot|letsencrypt|acme) CERT_MODE="certbot" ;;
    selfsigned|self-signed) CERT_MODE="selfsigned" ;;
    files|file) CERT_MODE="files" ;;
    http|none|off) CERT_MODE="http" ;;
    *) usage_fail "AURELLE_TLS must be auto, certbot, selfsigned, files or http (got: ${tls_choice})." ;;
  esac

  if [[ "$DEPLOY_MODE" == "ip" ]]; then
    # The address is the one to visit, and the one an IP certificate is issued for.
    detect_public_ip
    CERTBOT_IP_ADDRESS="$PUBLIC_IP"
    if [[ "$CERT_MODE" == "certbot" ]]; then
      if [[ -z "$CERTBOT_IP_ADDRESS" ]]; then
        usage_fail "An IP certificate needs the server's public IPv4 and it could not be detected: set AURELLE_PUBLIC_IP."
      fi
      if [[ -z "$CERTBOT_EMAIL" ]]; then
        usage_fail "An IP certificate needs AURELLE_EMAIL."
      fi
      NGINX_SERVER_NAME="$CERTBOT_IP_ADDRESS"
    fi
  fi

  if [[ "$CERT_MODE" == "files" ]]; then
    local cert_path="" key_path=""
    cert_path="$(resolve_file_path "$AURELLE_TLS_CERT")" || cert_path=""
    key_path="$(resolve_file_path "$AURELLE_TLS_KEY")" || key_path=""
    if [[ -z "$cert_path" || -z "$key_path" ]]; then
      usage_fail "AURELLE_TLS=files needs AURELLE_TLS_CERT and AURELLE_TLS_KEY to point at existing files."
    fi
    MANUAL_CERT_FULLCHAIN_PATH="$cert_path"
    MANUAL_CERT_PRIVKEY_PATH="$key_path"
    MANUAL_CERT_GROUP_FULLCHAIN_PATHS=()
    MANUAL_CERT_GROUP_PRIVKEY_PATHS=()
    local group_csv=""
    for group_csv in "${DOMAIN_GROUPS[@]}"; do
      # One certificate for every group: it has to cover all the names.
      MANUAL_CERT_GROUP_FULLCHAIN_PATHS+=("$cert_path")
      MANUAL_CERT_GROUP_PRIVKEY_PATHS+=("$key_path")
    done
  fi

  if [[ "$CERT_MODE" == "http" ]]; then
    unattended_port CLIENT_PORT AURELLE_CLIENT_PORT "$AURELLE_CLIENT_PORT" "$DEFAULT_CLIENT_PORT"
  else
    unattended_port CLIENT_PORT AURELLE_CLIENT_PORT "$AURELLE_CLIENT_PORT" "443"
  fi
  if [[ "$WORKER_PORT" == "$SERVER_PORT" || "$WORKER_PORT" == "$CLIENT_PORT" ]]; then
    usage_fail "The media worker port (${WORKER_PORT}) cannot be the same as the server port (${SERVER_PORT}) or the client port (${CLIENT_PORT})."
  fi

  case "$(lowercase "$(sanitize_input_value "$AURELLE_DB")")" in
    ""|sqlite|sqlite3) DB_CLIENT="sqlite3" ;;
    postgres|postgresql|pg)
      DB_CLIENT="postgres"
      POSTGRES_URL="$(sanitize_input_value "$AURELLE_POSTGRES_URL")"
      if [[ -n "$POSTGRES_URL" ]]; then
        if [[ ! "$POSTGRES_URL" =~ ^postgres(ql)?:// ]]; then
          usage_fail "AURELLE_POSTGRES_URL must start with postgres:// or postgresql://."
        fi
        # The URL becomes one line of the .env file: no line break, space, quote, backtick or
        # backslash. Characters in a password are written as %XX in a URL anyway.
        if [[ "$POSTGRES_URL" == *[[:space:][:cntrl:]\'\"\`\\]* ]]; then
          usage_fail "AURELLE_POSTGRES_URL must not contain spaces, line breaks, quotes, backticks or backslashes; write such characters in the password as %XX."
        fi
        if [[ "$POSTGRES_URL" == *"sslmode=require"* || "$POSTGRES_URL" == *"ssl=true"* ]]; then
          POSTGRES_SSL="true"
        fi
      else
        # A local database gets its own password instead of the well-known default.
        POSTGRES_PASSWORD="$(get_existing_env_value "POSTGRES_PASSWORD" "")"
        if [[ -z "$POSTGRES_PASSWORD" || "$POSTGRES_PASSWORD" == "$DEFAULT_POSTGRES_PASSWORD" ]]; then
          POSTGRES_PASSWORD="$(generate_secret_hex || true)"
          POSTGRES_PASSWORD="${POSTGRES_PASSWORD:0:32}"
        fi
        [[ -n "$POSTGRES_PASSWORD" ]] || usage_fail "Could not generate a password for the local PostgreSQL database."
      fi
      ;;
    *) usage_fail "AURELLE_DB must be sqlite3 or postgres." ;;
  esac

  if [[ -n "$AURELLE_RESTORE_BACKUP" ]]; then
    DB_BACKUP_PATH="$(resolve_file_path "$AURELLE_RESTORE_BACKUP")" || usage_fail "AURELLE_RESTORE_BACKUP is not a file: ${AURELLE_RESTORE_BACKUP}"
  fi

  if [[ -n "$AURELLE_OWNER_USERNAME" || -n "$AURELLE_OWNER_PASSWORD" ]]; then
    if [[ -z "$AURELLE_OWNER_USERNAME" || -z "$AURELLE_OWNER_PASSWORD" ]]; then
      usage_fail "AURELLE_OWNER_USERNAME and AURELLE_OWNER_PASSWORD go together."
    fi
  fi
  if [[ "$AURELLE_OWNER_USERNAME" == *[[:cntrl:]]* || "$AURELLE_OWNER_NICKNAME" == *[[:cntrl:]]* || "$AURELLE_OWNER_PASSWORD" == *[[:cntrl:]]* ]]; then
    usage_fail "AURELLE_OWNER_USERNAME, AURELLE_OWNER_NICKNAME and AURELLE_OWNER_PASSWORD must not contain line breaks or control characters."
  fi

  resolve_calls_relay_mode
  validate_relay_port_settings
  SOURCE_MODE="github"
}

# What AURELLE_CALLS_RELAY asks for: yes, no, force, or empty when it was not set.
resolve_calls_relay_mode() {
  local value=""
  value="$(lowercase "$(sanitize_input_value "$AURELLE_CALLS_RELAY")")"
  case "$value" in
    "") CALLS_RELAY_MODE="" ;;
    1|true|yes|y|on) CALLS_RELAY_MODE="yes" ;;
    0|false|no|n|off) CALLS_RELAY_MODE="no" ;;
    force) CALLS_RELAY_MODE="force" ;;
    *) usage_fail "AURELLE_CALLS_RELAY must be 1, 0 or force (got: ${value})." ;;
  esac
}

# ---------------------------------------------------------------------------
# Public address, host firewall
# ---------------------------------------------------------------------------

# The IPv4 address this server uses to reach the internet (may be a private one
# behind NAT).
detect_local_ipv4() {
  local ip=""
  if have_cmd ip; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
  fi
  if ! is_valid_ipv4 "$ip" && have_cmd hostname; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if is_valid_ipv4 "$ip"; then
    printf '%s' "$ip"
  fi
}

# Sets PUBLIC_IP: AURELLE_PUBLIC_IP, else what an outside service sees, else the
# local address when that one is public. Empty when it cannot be found.
detect_public_ip() {
  if [[ -n "$PUBLIC_IP" ]]; then
    return 0
  fi
  if [[ -n "$AURELLE_PUBLIC_IP" ]] && is_valid_ipv4 "$AURELLE_PUBLIC_IP"; then
    PUBLIC_IP="$AURELLE_PUBLIC_IP"
    return 0
  fi
  local url="" ip=""
  if have_cmd curl; then
    for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com https://checkip.amazonaws.com; do
      ip="$(curl -fsS4 --max-time 4 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_valid_ipv4 "$ip" && ! is_private_ipv4 "$ip"; then
        PUBLIC_IP="$ip"
        return 0
      fi
    done
  fi
  ip="$(detect_local_ipv4)"
  if [[ -n "$ip" ]] && ! is_private_ipv4 "$ip"; then
    PUBLIC_IP="$ip"
  fi
  return 0
}

# IPv4 addresses a name resolves to, separated by spaces.
resolve_domain_ipv4() {
  local name="${1:-}"
  [[ -n "$name" ]] || return 0
  getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

# Opens ports in whichever host firewall is switched on. Never switches one on:
# that could lock the owner out of SSH. Arguments look like 80/tcp or 49160-49260/udp.
firewall_open_ports() {
  local spec=""
  local status=""
  local opened=()
  if have_cmd ufw; then
    status="$(run_as_root ufw status 2>/dev/null || true)"
    if [[ "$status" == *"Status: active"* ]]; then
      for spec in "$@"; do
        # ufw writes a port range as 49160:49260.
        if run_logged_quiet run_as_root ufw allow "${spec//-/:}"; then
          opened+=("$spec")
        else
          warn "ufw could not allow ${spec}. Open it by hand: sudo ufw allow ${spec//-/:}"
        fi
      done
      if (( ${#opened[@]} > 0 )); then
        log "ufw is active: opened ${opened[*]}."
      fi
      return 0
    fi
  fi
  if have_cmd firewall-cmd && run_as_root firewall-cmd --state >/dev/null 2>&1; then
    for spec in "$@"; do
      if run_logged_quiet run_as_root firewall-cmd --permanent --add-port="$spec"; then
        opened+=("$spec")
      else
        warn "firewalld could not allow ${spec}. Open it by hand: sudo firewall-cmd --permanent --add-port=${spec}"
      fi
    done
    run_logged_quiet run_as_root firewall-cmd --reload || true
    if (( ${#opened[@]} > 0 )); then
      log "firewalld is active: opened ${opened[*]}."
    fi
    return 0
  fi
  log "No active host firewall (ufw or firewalld) found, so nothing to open here. If your hosting provider has its own firewall, allow: $*"
}

# The ports nginx needs: 80 for the redirect and for certificate renewal, and
# the client port.
configure_firewall() {
  local ports=("${CLIENT_PORT}/tcp")
  if [[ "$CERT_MODE" != "http" && "$CLIENT_PORT" != "80" ]]; then
    ports=("80/tcp" "${CLIENT_PORT}/tcp")
  fi
  firewall_open_ports "${ports[@]}"
}

# ---------------------------------------------------------------------------
# Voice and video calls relay (coturn)
# ---------------------------------------------------------------------------

COTURN_MARKER="# Managed by the Aurelle installer"
# Where the distribution's coturn package keeps its files (the tests point these elsewhere).
COTURN_CONFIG_PRIMARY="/etc/turnserver.conf"
COTURN_CONFIG_ALTERNATE="/etc/coturn/turnserver.conf"
COTURN_CERT_DIR="/etc/coturn/certs"
COTURN_DEFAULTS_FILE="/etc/default/coturn"
CERTBOT_HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"

# Addresses a relay must never forward to, exactly as docs/Calls-and-Video-Messages.md
# lists them. Never write ::-:: here: that range is the whole IPv4 space.
COTURN_DENIED_PEERS=(
  "0.0.0.0-0.255.255.255"
  "10.0.0.0-10.255.255.255"
  "100.64.0.0-100.127.255.255"
  "127.0.0.0-127.255.255.255"
  "169.254.0.0-169.254.255.255"
  "172.16.0.0-172.31.255.255"
  "192.168.0.0-192.168.255.255"
  "::1-::1"
  "::ffff:0:0-::ffff:ffff:ffff"
  "64:ff9b::-64:ff9b::ffff:ffff"
  "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
  "fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
)

# The name to put in CALLS_TURN_URLS. A domain only when it points straight at
# this server: behind Cloudflare's proxy (orange cloud) a name resolves to
# Cloudflare, which carries web traffic and never TURN, so the raw IP is used.
# Arguments: domain (may be empty), public IP (may be empty), the IPs the domain
# resolves to (space separated).
relay_host_for() {
  local domain="${1:-}"
  local public_ip="${2:-}"
  local resolved="${3:-}"
  local ip=""
  if [[ -z "$domain" ]]; then
    printf '%s' "$public_ip"
    return 0
  fi
  if [[ -z "$public_ip" ]]; then
    printf '%s' "$domain"
    return 0
  fi
  for ip in $resolved; do
    if [[ "$ip" == "$public_ip" ]]; then
      printf '%s' "$domain"
      return 0
    fi
  done
  printf '%s' "$public_ip"
}

# CALLS_TURN_URLS for the app: STUN and TURN on the one port, TURN again over TCP
# (the app adds the TCP twin itself; writing it out keeps it when
# CALLS_TURN_TCP_FALLBACK is switched off), and turns: when the relay has TLS.
# Arguments: host, port, TLS port (empty without TLS).
build_calls_turn_urls() {
  local host="$1"
  local port="$2"
  local tls_port="${3:-}"
  local urls="stun:${host}:${port},turn:${host}:${port},turn:${host}:${port}?transport=tcp"
  if [[ -n "$tls_port" ]]; then
    urls="${urls},turns:${host}:${tls_port}"
  fi
  printf '%s' "$urls"
}

# The coturn configuration, on stdout. It follows the documented setup (use-auth-secret
# with one shared secret, the peer deny list, no multicast) and docker-compose.yaml.
# Arguments: realm, secret, public IP, local IP, port, relay min port, relay max port,
# then optionally TLS port, certificate file and key file (all three or none).
render_coturn_config() {
  local realm="$1"
  local secret="$2"
  local public_ip="${3:-}"
  local local_ip="${4:-}"
  local port="${5:-3478}"
  local min_port="${6:-49160}"
  local max_port="${7:-49260}"
  local tls_port="${8:-}"
  local tls_cert="${9:-}"
  local tls_key="${10:-}"
  local range=""

  printf '%s\n' "$COTURN_MARKER"
  printf '%s\n' "# (scripts/install.sh). Running the installer again rewrites this file."
  printf '%s\n' "# See docs/Calls-and-Video-Messages.md for what each line is for."
  printf '\n'
  printf 'realm=%s\n' "$realm"
  printf 'listening-port=%s\n' "$port"
  if [[ -n "$tls_port" && -n "$tls_cert" && -n "$tls_key" ]]; then
    printf 'tls-listening-port=%s\n' "$tls_port"
    printf 'cert=%s\n' "$tls_cert"
    printf 'pkey=%s\n' "$tls_key"
  fi
  printf '\n'
  printf '%s\n' "# Short-lived per-user credentials; the app signs them with the same secret"
  printf '%s\n' "# (CALLS_TURN_SECRET in its .env file)."
  printf '%s\n' "use-auth-secret"
  printf 'static-auth-secret=%s\n' "$secret"
  if [[ -n "$public_ip" ]]; then
    printf '\n'
    if [[ -n "$local_ip" && "$local_ip" != "$public_ip" ]]; then
      printf '%s\n' "# Behind NAT the relay advertises the public address."
      printf 'external-ip=%s/%s\n' "$public_ip" "$local_ip"
    else
      printf 'external-ip=%s\n' "$public_ip"
    fi
  fi
  printf '\n'
  printf 'min-port=%s\n' "$min_port"
  printf 'max-port=%s\n' "$max_port"
  printf '\n'
  printf '%s\n' "fingerprint"
  printf '%s\n' "no-cli"
  printf '%s\n' "no-software-attribute"
  printf '%s\n' "no-tlsv1"
  printf '%s\n' "no-tlsv1_1"
  printf '%s\n' "no-rfc5780"
  printf '%s\n' "no-stun-backward-compatibility"
  printf '%s\n' "response-origin-only-with-rfc5780"
  printf '%s\n' "syslog"
  printf '\n'
  printf '%s\n' "# Never relay to private networks or to this machine itself."
  printf '%s\n' "no-multicast-peers"
  for range in "${COTURN_DENIED_PEERS[@]}"; do
    printf 'denied-peer-ip=%s\n' "$range"
  done
  printf '\n'
  printf '%s\n' "# Keep one user from exhausting the relay."
  printf '%s\n' "user-quota=6"
  printf '%s\n' "total-quota=200"
  printf '%s\n' "max-bps=262144"
}

# Where the distribution's coturn package reads its configuration.
coturn_config_path() {
  if [[ ! -f "$COTURN_CONFIG_PRIMARY" && -f "$COTURN_CONFIG_ALTERNATE" ]]; then
    printf '%s' "$COTURN_CONFIG_ALTERNATE"
    return 0
  fi
  printf '%s' "$COTURN_CONFIG_PRIMARY"
}

# True when the file holds a coturn setup that somebody else wrote: active
# settings beyond the distribution's defaults and none of our marker. Replacing it
# could break another service that uses the same coturn.
coturn_config_is_unmanaged() {
  local conf_file="$1"
  [[ -f "$conf_file" ]] || return 1
  if grep -qF "$COTURN_MARKER" "$conf_file" 2>/dev/null; then
    return 1
  fi
  local line=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    case "$line" in
      syslog|no-rfc5780|no-stun-backward-compatibility|response-origin-only-with-rfc5780) ;;
      *) return 0 ;;
    esac
  done < "$conf_file"
  return 1
}

# A certbot deploy hook: after every renewal nginx reloads and, when the calls relay has
# its own copy of the certificate (COTURN_CERT_DIR exists), coturn gets the new one. The
# relay part is always written and checks at run time, so the hook stays right whichever
# step wrote it last. Argument: certificate name.
install_certbot_deploy_hook() {
  local cert_name="$1"
  local hook_dir="$CERTBOT_HOOK_DIR"
  local hook_file="${hook_dir}/aurelle-reload.sh"
  local tmp_file=""
  tmp_file="$(mktemp)" || return 1
  {
    printf '%s\n' "#!/bin/sh"
    printf '%s\n' "# Installed by the Aurelle installer: use a renewed certificate."
    printf '%s\n' "systemctl reload nginx >/dev/null 2>&1 || true"
    printf '%s\n' "if [ \"\$RENEWED_LINEAGE\" = \"/etc/letsencrypt/live/${cert_name}\" ] && [ -d ${COTURN_CERT_DIR} ]; then"
    printf '%s\n' "  cp -L \"\$RENEWED_LINEAGE/fullchain.pem\" ${COTURN_CERT_DIR}/fullchain.pem"
    printf '%s\n' "  cp -L \"\$RENEWED_LINEAGE/privkey.pem\" ${COTURN_CERT_DIR}/privkey.pem"
    printf '%s\n' "  chown root:turnserver ${COTURN_CERT_DIR}/fullchain.pem ${COTURN_CERT_DIR}/privkey.pem"
    printf '%s\n' "  chmod 640 ${COTURN_CERT_DIR}/fullchain.pem ${COTURN_CERT_DIR}/privkey.pem"
    printf '%s\n' "  systemctl restart coturn >/dev/null 2>&1 || true"
    printf '%s\n' "fi"
  } > "$tmp_file"
  if ! run_logged_quiet run_as_root mkdir -p "$hook_dir"; then
    rm -f "$tmp_file"
    return 1
  fi
  if ! run_logged_quiet run_as_root install -m 755 "$tmp_file" "$hook_file"; then
    rm -f "$tmp_file"
    return 1
  fi
  rm -f "$tmp_file"
}

# True once something accepts connections on the port (127.0.0.1), waiting up to
# the given number of seconds.
wait_for_tcp_port() {
  local port="$1"
  local timeout="${2:-15}"
  local waited=0
  while (( waited < timeout )); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Copies the certificate coturn should present into a folder it can read (it runs
# as its own user and cannot read the web server's private key).
stage_coturn_certificate() {
  local source_cert="$1"
  local source_key="$2"
  local cert_dir="$COTURN_CERT_DIR"
  run_logged_quiet run_as_root mkdir -p "$cert_dir" || return 1
  run_logged_quiet run_as_root cp -Lf "$source_cert" "${cert_dir}/fullchain.pem" || return 1
  run_logged_quiet run_as_root cp -Lf "$source_key" "${cert_dir}/privkey.pem" || return 1
  run_logged_quiet run_as_root chown root:turnserver "$cert_dir" "${cert_dir}/fullchain.pem" "${cert_dir}/privkey.pem" || return 1
  run_logged_quiet run_as_root chmod 750 "$cert_dir" || return 1
  run_logged_quiet run_as_root chmod 640 "${cert_dir}/fullchain.pem" "${cert_dir}/privkey.pem" || return 1
}

# Paths of the certificate the web server uses for a domain, empty when there is none
# that a relay could use (self-signed and IP certificates do not suit a TURN host name).
relay_certificate_files() {
  local domain="$1"
  local cert=""
  local key=""
  case "$CERT_MODE" in
    certbot)
      cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
      key="/etc/letsencrypt/live/${domain}/privkey.pem"
      ;;
    files)
      cert="$(manual_group_fullchain_path "${DOMAIN_GROUPS[0]:-$domain}")"
      key="$(manual_group_privkey_path "${DOMAIN_GROUPS[0]:-$domain}")"
      ;;
    *) return 1 ;;
  esac
  if run_as_root test -f "$cert" && run_as_root test -f "$key"; then
    printf '%s\n%s\n' "$cert" "$key"
    return 0
  fi
  return 1
}

is_valid_port_range() {
  local port="$1"
  local min_port="$2"
  local max_port="$3"
  local value=""
  for value in "$port" "$min_port" "$max_port"; do
    [[ "$value" =~ ^0*[0-9]{1,5}$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )) || return 1
  done
  (( 10#$min_port < 10#$max_port )) || return 1
  return 0
}

# The calls relay ports from AURELLE_RELAY_PORT, _MIN_PORT and _MAX_PORT, checked before
# anything is changed (a bad value would otherwise show up half way through an install,
# as a skipped relay). They are written in decimal into the coturn configuration.
validate_relay_port_settings() {
  case "$(lowercase "$(sanitize_input_value "$AURELLE_CALLS_RELAY")")" in
    0|false|no|n|off) return 0 ;;
  esac
  AURELLE_RELAY_PORT="$(sanitize_input_value "$AURELLE_RELAY_PORT")"
  AURELLE_RELAY_MIN_PORT="$(sanitize_input_value "$AURELLE_RELAY_MIN_PORT")"
  AURELLE_RELAY_MAX_PORT="$(sanitize_input_value "$AURELLE_RELAY_MAX_PORT")"
  if ! is_valid_port_range "$AURELLE_RELAY_PORT" "$AURELLE_RELAY_MIN_PORT" "$AURELLE_RELAY_MAX_PORT"; then
    usage_fail "AURELLE_RELAY_PORT, AURELLE_RELAY_MIN_PORT and AURELLE_RELAY_MAX_PORT must be ports between 1 and 65535, and the minimum below the maximum (got: port ${AURELLE_RELAY_PORT//[^[:print:]]/?}, range ${AURELLE_RELAY_MIN_PORT//[^[:print:]]/?}-${AURELLE_RELAY_MAX_PORT//[^[:print:]]/?})."
  fi
  AURELLE_RELAY_PORT="$((10#$AURELLE_RELAY_PORT))"
  AURELLE_RELAY_MIN_PORT="$((10#$AURELLE_RELAY_MIN_PORT))"
  AURELLE_RELAY_MAX_PORT="$((10#$AURELLE_RELAY_MAX_PORT))"
}

# Explains a failed relay check; the install itself is fine without a working relay.
# Third argument: "yes" when the relay answered on the server's own address (so coturn
# works and the way in from outside is what fails), "no" when it did not.
advise_relay_problems() {
  local host="$1"
  local port="$2"
  local answers_locally="${3:-no}"
  local step=1
  warn "The calls relay is installed but the check from this server failed. The rest of Aurelle works; calls between different networks may not connect until this is fixed."
  log "What to check:"
  if [[ "$answers_locally" == "yes" ]]; then
    log "  ${step}. coturn itself works: it answers on this server's own address. What fails is the way in through ${host}."
    step=$((step + 1))
  fi
  log "  ${step}. Your hosting provider's firewall (security group): allow ${port}/tcp, ${port}/udp and ${AURELLE_RELAY_MIN_PORT}-${AURELLE_RELAY_MAX_PORT}/udp to this server."
  step=$((step + 1))
  if ! is_valid_ipv4 "$host"; then
    log "  ${step}. ${host} must be a DNS-only record. If it is on Cloudflare, switch the orange cloud to grey: the proxy never carries TURN. Or put the server IP in CALLS_TURN_URLS."
    step=$((step + 1))
  fi
  if [[ "$answers_locally" != "yes" ]]; then
    log "  ${step}. The relay log: journalctl -u coturn -n 50"
    step=$((step + 1))
  fi
  log "  ${step}. Run the check again after the fix: sudo bash ${INSTALL_DIR}/scripts/check-relay.sh (a server behind NAT may not reach its own public address; then run it from another machine)."
}

# Runs scripts/check-relay.sh and reports; a failure is only ever a warning. When the
# check against the public address fails, the same check against the server's own
# address tells "coturn is broken" apart from "the way in from outside is blocked".
# Arguments: relay host, port, the server's own address (may be empty).
check_calls_relay() {
  local host="$1"
  local port="$2"
  local private_ip="${3:-}"
  local check_script="${INSTALL_DIR}/scripts/check-relay.sh"
  local output=""
  local status=0
  local answers_locally="no"
  if [[ ! -f "$check_script" ]]; then
    warn "scripts/check-relay.sh is missing, so the relay was not tested."
    return 0
  fi
  log "Testing the relay with scripts/check-relay.sh (this takes up to a minute)..."
  output="$(run_as_root bash "$check_script" "${INSTALL_DIR}/.env" 2>&1)" || status=$?
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output" | sed 's/^/    /'
    log_to_file "$output"
  fi
  if (( status == 0 )); then
    log "The relay works from this server."
    return 0
  fi
  if [[ -n "$private_ip" && "$private_ip" != "$host" ]]; then
    log "Testing the relay on this server's own address (${private_ip})..."
    if run_as_root env "CALLS_TURN_URLS=turn:${private_ip}:${port}" bash "$check_script" "${INSTALL_DIR}/.env" >/dev/null 2>&1; then
      answers_locally="yes"
    fi
  fi
  advise_relay_problems "$host" "$port" "$answers_locally"
  return 1
}

# Installs coturn, writes its configuration and the matching app settings, opens
# the ports, restarts the app and tests the relay. Every problem here is a warning:
# calls between different networks need the relay, the rest of Aurelle does not.
install_calls_relay() {
  local env_file="${INSTALL_DIR}/.env"
  local conf_file=""
  local relay_domain=""
  local resolved=""
  local relay_host=""
  local private_ip=""
  local secret=""
  local realm=""
  local tls_port=""
  local tls_cert=""
  local tls_key=""
  local urls=""
  local existing_urls=""
  local relay_port="$AURELLE_RELAY_PORT"
  local tls_files=()
  local firewall_ports=()
  CALLS_RELAY_SUMMARY=""

  if [[ "$CALLS_RELAY_MODE" != "yes" && "$CALLS_RELAY_MODE" != "force" ]]; then
    CALLS_RELAY_SUMMARY="$(describe_calls_relay_state)"
    return 0
  fi
  if [[ ! -f "$env_file" ]]; then
    warn "No .env found at ${env_file}; the calls relay was skipped."
    CALLS_RELAY_SUMMARY="Skipped: no .env file."
    return 0
  fi
  if ! is_valid_port_range "$relay_port" "$AURELLE_RELAY_MIN_PORT" "$AURELLE_RELAY_MAX_PORT"; then
    warn "The relay ports are not valid (port ${relay_port}, range ${AURELLE_RELAY_MIN_PORT}-${AURELLE_RELAY_MAX_PORT}); the calls relay was skipped."
    CALLS_RELAY_SUMMARY="Skipped: invalid relay ports."
    return 0
  fi

  log "Setting up the calls relay (coturn)..."

  # The address people will use to reach the relay.
  detect_public_ip
  private_ip="$(detect_local_ipv4)"
  if [[ "$DEPLOY_MODE" == "domain" && ${#DOMAIN_GROUPS[@]} -gt 0 ]]; then
    relay_domain="$(group_primary_domain "${DOMAIN_GROUPS[0]}")"
    resolved="$(resolve_domain_ipv4 "$relay_domain")"
  fi
  relay_host="$(relay_host_for "$relay_domain" "$PUBLIC_IP" "$resolved")"
  if [[ -z "$relay_host" ]]; then
    warn "This server's public address could not be found, so the calls relay was skipped. Set AURELLE_PUBLIC_IP and run again."
    CALLS_RELAY_SUMMARY="Skipped: public IP unknown (set AURELLE_PUBLIC_IP)."
    return 0
  fi
  if [[ -n "$relay_domain" && "$relay_host" != "$relay_domain" ]]; then
    if [[ -n "$resolved" ]]; then
      log "${relay_domain} resolves to ${resolved}, not to this server (${PUBLIC_IP}); behind Cloudflare's proxy? The relay address will be the server IP, because a proxy never carries TURN."
    else
      log "${relay_domain} does not resolve yet, so the relay address will be the server IP (${PUBLIC_IP})."
    fi
  fi

  # The package.
  if ! dpkg -s coturn >/dev/null 2>&1 || ! have_cmd turnutils_uclient; then
    log "Installing coturn..."
    wait_for_package_manager
    if ! run_silent apt_get_run install -y coturn openssl; then
      warn "coturn could not be installed, so the calls relay was skipped. Calls between different networks will not connect until a relay exists: fix the apt error above and run again, or follow docs/Calls-and-Video-Messages.md."
      CALLS_RELAY_SUMMARY="Skipped: coturn could not be installed."
      return 0
    fi
  fi

  # A coturn that somebody set up for another purpose stays as it is.
  conf_file="$(coturn_config_path)"
  existing_urls="$(get_existing_env_value "CALLS_TURN_URLS" "")"
  if [[ "$CALLS_RELAY_MODE" != "force" ]]; then
    if coturn_config_is_unmanaged "$conf_file"; then
      warn "${conf_file} already holds a coturn setup that this installer did not write, so it was left alone. To let Aurelle manage coturn (the old file is kept as a backup) run with AURELLE_CALLS_RELAY=force; or add use-auth-secret and static-auth-secret to it and set CALLS_TURN_URLS and CALLS_TURN_SECRET in ${env_file}."
      CALLS_RELAY_SUMMARY="Left your existing coturn configuration (${conf_file}) alone."
      return 0
    fi
    if [[ -n "$existing_urls" ]] && ! grep -qF "$COTURN_MARKER" "$conf_file" 2>/dev/null; then
      warn "CALLS_TURN_URLS is already set in ${env_file} (${existing_urls}), so the calls relay was left alone. Use AURELLE_CALLS_RELAY=force to replace it."
      CALLS_RELAY_SUMMARY="Kept the relay already set in .env (${existing_urls})."
      return 0
    fi
  fi

  # One secret in both places.
  secret="$(get_existing_env_value "CALLS_TURN_SECRET" "")"
  if [[ -z "$secret" ]]; then
    secret="$(generate_secret_hex || true)"
  fi
  if [[ -z "$secret" ]]; then
    warn "Could not generate a relay secret; the calls relay was skipped."
    CALLS_RELAY_SUMMARY="Skipped: no secret could be generated."
    return 0
  fi

  # TLS only where a certificate for the relay's name exists.
  if [[ -n "$relay_domain" && "$relay_host" == "$relay_domain" ]]; then
    mapfile -t tls_files < <(relay_certificate_files "$relay_domain" || true)
    if (( ${#tls_files[@]} == 2 )); then
      if stage_coturn_certificate "${tls_files[0]}" "${tls_files[1]}"; then
        tls_port="5349"
        tls_cert="${COTURN_CERT_DIR}/fullchain.pem"
        tls_key="${COTURN_CERT_DIR}/privkey.pem"
        if [[ "$CERT_MODE" == "certbot" ]]; then
          install_certbot_deploy_hook "$relay_domain" || warn "Could not install the certbot renewal hook for the relay certificate."
        fi
      else
        warn "The certificate could not be copied for coturn; the relay runs without TLS (turns:)."
      fi
    fi
  fi

  if [[ -n "$relay_domain" ]]; then
    realm="$relay_domain"
  else
    realm="$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)"
    [[ "$realm" =~ ^[A-Za-z0-9.-]+$ ]] || realm="aurelle"
  fi

  # Write the configuration (a configuration that is not ours is kept as a backup).
  local tmp_conf=""
  tmp_conf="$(mktemp)" || return 0
  render_coturn_config "$realm" "$secret" "$PUBLIC_IP" "$private_ip" "$relay_port" "$AURELLE_RELAY_MIN_PORT" "$AURELLE_RELAY_MAX_PORT" "$tls_port" "$tls_cert" "$tls_key" > "$tmp_conf"
  if [[ -f "$conf_file" ]] && ! grep -qF "$COTURN_MARKER" "$conf_file" 2>/dev/null; then
    run_logged_quiet run_as_root cp -a "$conf_file" "${conf_file}.bak.$(date +%Y%m%d%H%M%S)" || true
  fi
  # The file holds the secret: it gets its owner and mode before anything is written.
  local conf_group="turnserver"
  getent group turnserver >/dev/null 2>&1 || conf_group="root"
  if ! { [[ -e "$conf_file" ]] || run_logged_quiet run_as_root install -m 640 -o root -g "$conf_group" /dev/null "$conf_file"; } \
    || ! run_logged_quiet run_as_root chown "root:${conf_group}" "$conf_file" \
    || ! run_logged_quiet run_as_root chmod 640 "$conf_file" \
    || ! run_as_root tee "$conf_file" < "$tmp_conf" >/dev/null; then
    rm -f "$tmp_conf"
    warn "Could not write ${conf_file}; the calls relay was skipped."
    CALLS_RELAY_SUMMARY="Skipped: could not write ${conf_file}."
    return 0
  fi
  rm -f "$tmp_conf"
  log "Wrote ${conf_file}."

  # Older Debian and Ubuntu releases keep coturn switched off until this is set.
  if [[ -f "$COTURN_DEFAULTS_FILE" ]] && grep -qE '^[[:space:]]*#[[:space:]]*TURNSERVER_ENABLED=1' "$COTURN_DEFAULTS_FILE"; then
    run_logged_quiet run_as_root sed -i -E 's/^[[:space:]]*#[[:space:]]*(TURNSERVER_ENABLED=1)/\1/' "$COTURN_DEFAULTS_FILE" || true
  fi
  run_logged_quiet run_as_root systemctl enable coturn || true
  if ! run_logged_quiet run_as_root systemctl restart coturn; then
    warn "coturn did not start. See: journalctl -u coturn -n 50"
    CALLS_RELAY_SUMMARY="coturn is configured but did not start (journalctl -u coturn)."
    return 0
  fi
  if ! wait_for_tcp_port "$relay_port" 15; then
    warn "coturn is running but nothing answers on port ${relay_port}. See: journalctl -u coturn -n 50"
  fi

  # Ports: the relay and its media range, and the app's settings.
  firewall_ports=("${relay_port}/tcp" "${relay_port}/udp" "${AURELLE_RELAY_MIN_PORT}-${AURELLE_RELAY_MAX_PORT}/udp")
  if [[ -n "$tls_port" ]]; then
    firewall_ports+=("${tls_port}/tcp" "${tls_port}/udp")
  fi
  firewall_open_ports "${firewall_ports[@]}"

  urls="$(build_calls_turn_urls "$relay_host" "$relay_port" "$tls_port")"
  replace_env_value "$env_file" "CALLS_TURN_URLS" "$urls" || return 0
  replace_env_value "$env_file" "CALLS_TURN_SECRET" "$secret" || return 0
  log "Wrote CALLS_TURN_URLS and CALLS_TURN_SECRET to ${env_file}."

  log "Restarting Aurelle so it uses the relay..."
  if ! run_as_root systemctl restart songbird.service; then
    warn "Aurelle did not restart; restart it by hand: sudo systemctl restart songbird"
  elif ! wait_for_app_health "$SERVER_PORT" 90; then
    warn "Aurelle did not answer after the restart. See: journalctl -u songbird -n 50"
  fi

  if check_calls_relay "$relay_host" "$relay_port" "$private_ip"; then
    CALLS_RELAY_SUMMARY="coturn on ${relay_host}:${relay_port} (UDP and TCP) works from this server. Also allow ${relay_port}/tcp, ${relay_port}/udp and ${AURELLE_RELAY_MIN_PORT}-${AURELLE_RELAY_MAX_PORT}/udp in your hosting provider's firewall."
  else
    CALLS_RELAY_SUMMARY="coturn on ${relay_host}:${relay_port} is installed but its check failed: see the advice above. Ports to allow: ${relay_port}/tcp, ${relay_port}/udp, ${AURELLE_RELAY_MIN_PORT}-${AURELLE_RELAY_MAX_PORT}/udp."
  fi
  return 0
}

# Asks (default yes) unless AURELLE_CALLS_RELAY already decided.
prompt_calls_relay_choice() {
  if [[ -n "$CALLS_RELAY_MODE" ]]; then
    return 0
  fi
  if is_unattended; then
    CALLS_RELAY_MODE="yes"
    return 0
  fi
  printf "\n%bVoice and video calls relay%b\n" "$COLOR_LOG" "$COLOR_RESET"
  printf "  Calls between people on different networks (mobile data, strict firewalls) need a\n"
  printf "  relay. This installs coturn from apt, configures it and opens its ports.\n"
  CALLS_RELAY_MODE="$(prompt_yes_no "Install the calls relay (coturn)?" "yes")"
}

# ---------------------------------------------------------------------------
# Checks before and after an install
# ---------------------------------------------------------------------------

# Free space and memory: a build that runs out of either fails half way and leaves
# a half installed system, so say so before anything is changed.
check_system_requirements() {
  local target="$INSTALL_DIR"
  local free_mb=""
  local mem_mb=""
  local swap_mb=""

  while [[ ! -d "$target" && "$target" != "/" ]]; do
    target="$(dirname "$target")"
  done
  free_mb="$(df -Pm "$target" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [[ "$free_mb" =~ ^[0-9]+$ ]] && (( free_mb < MIN_FREE_DISK_MB )); then
    warn "Only ${free_mb} MB are free on the disk that holds ${INSTALL_DIR}; at least ${MIN_FREE_DISK_MB} MB are needed for the packages, dependencies and the build. Free some space and run the installer again."
    return 1
  fi

  mem_mb="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
  swap_mb="$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
  if [[ "$mem_mb" =~ ^[0-9]+$ ]] && (( mem_mb + ${swap_mb:-0} < MIN_MEMORY_MB )); then
    warn "This server has ${mem_mb} MB of memory and ${swap_mb:-0} MB of swap. Building the client needs about ${MIN_MEMORY_MB} MB and the build may be killed. Adding swap helps: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
  fi

  if [[ ! -d /run/systemd/system ]]; then
    warn "systemd does not seem to be running on this machine (a container, or WSL without systemd?). The services will be written but cannot be started here."
  fi
  return 0
}

# True when a file exists, also where only root may look.
path_exists_as_root() {
  run_as_root test -e "$1" 2>/dev/null
}

# A finished installation: sources, settings, services and the web server site.
installation_is_complete() {
  path_exists_as_root "$INSTALL_DIR/.git" \
    && path_exists_as_root "$INSTALL_DIR/.env" \
    && path_exists_as_root "$INSTALL_DIR/server/node_modules" \
    && path_exists_as_root "$SERVICE_FILE" \
    && path_exists_as_root "$NGINX_SITE_FILE"
}

# Waits until the server answers its health check. Seconds default to
# AURELLE_HEALTH_TIMEOUT (90); 0 only checks once.
wait_for_app_health() {
  local port="${1:-$SERVER_PORT}"
  local timeout="${2:-${AURELLE_HEALTH_TIMEOUT:-90}}"
  local waited=0
  # Used in arithmetic below: anything but a plain number would be evaluated by bash.
  [[ "$timeout" =~ ^[0-9]{1,6}$ ]] || timeout=90
  timeout=$((10#$timeout))
  while true; do
    if songbird_healthcheck_responds "$port"; then
      return 0
    fi
    if (( waited >= timeout )); then
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

# Fails the step with the last lines of the service log when the server is not up.
confirm_app_started() {
  if wait_for_app_health "$SERVER_PORT"; then
    log "Aurelle answers on port ${SERVER_PORT}."
    return 0
  fi
  warn "Aurelle does not answer on port ${SERVER_PORT}. The last lines of its log:"
  run_as_root journalctl -u songbird.service --no-pager -n 20 2>/dev/null | sed 's/^/    /' >&2 || true
  warn "Look at the whole log with: journalctl -u songbird -e"
  return 1
}

# Reloads nginx; starts it when it is not running (a reload of a stopped unit fails).
reload_nginx() {
  if run_as_root systemctl reload nginx; then
    return 0
  fi
  log "nginx did not reload; starting it..."
  run_as_root systemctl restart nginx
}

# Reads what an existing installation uses (names, certificate, ports) from the
# files the installer wrote, for updates and for steps added later.
load_deployment_from_existing() {
  local names=""
  local cert_path=""
  local name=""
  sync_values_from_env
  WORKER_PORT="$(get_existing_env_value "WORKER_PORT" "$DEFAULT_WORKER_PORT")"
  DEPLOY_MODE="ip"
  CERT_MODE="http"
  DOMAIN_NAMES=()
  DOMAIN_GROUPS=()
  NGINX_SERVER_NAME="_"
  if ! path_exists_as_root "$NGINX_SITE_FILE"; then
    return 0
  fi
  names="$(run_as_root_output grep -E '^[[:space:]]*server_name[[:space:]]' "$NGINX_SITE_FILE" 2>/dev/null \
    | sed -E 's/^[[:space:]]*server_name[[:space:]]+([^;]+);.*/\1/' | tr '\n' ' ')" || names=""
  cert_path="$(run_as_root_output grep -E '^[[:space:]]*ssl_certificate[[:space:]]' "$NGINX_SITE_FILE" 2>/dev/null \
    | head -n 1 | sed -E 's/^[[:space:]]*ssl_certificate[[:space:]]+([^;]+);.*/\1/' | tr -d '\r\n')" || cert_path=""

  local domains=()
  for name in $names; do
    if [[ "$name" != "_" ]] && ! is_valid_ipv4 "$name"; then
      domains+=("$name")
    elif is_valid_ipv4 "$name"; then
      CERTBOT_IP_ADDRESS="$name"
    fi
  done
  if (( ${#domains[@]} > 0 )); then
    DEPLOY_MODE="domain"
    local csv=""
    csv="$(IFS=,; printf '%s' "${domains[*]}")"
    parse_domain_input "$csv"
  fi

  case "$cert_path" in
    "") CERT_MODE="http" ;;
    /etc/letsencrypt/*) CERT_MODE="certbot" ;;
    *) CERT_MODE="files" ;;
  esac
}

# A short note on the calls relay for the summary of an update that did not touch it.
describe_calls_relay_state() {
  local urls=""
  urls="$(get_existing_env_value "CALLS_TURN_URLS" "")"
  if [[ -n "$urls" ]]; then
    printf 'Configured: CALLS_TURN_URLS in %s/.env' "$INSTALL_DIR"
  else
    printf 'Not installed. Calls between different networks need it: sudo env AURELLE_CALLS_RELAY=1 songbird-deploy --yes'
  fi
}

# ---------------------------------------------------------------------------
# Unattended run
# ---------------------------------------------------------------------------

resolve_unattended_update_options() {
  resolve_calls_relay_mode
  load_deployment_from_existing
  SOURCE_MODE="github"
}

# True when this run asks for a setup that differs from the one installed: another
# domain, HTTPS where there is none, other ports. The same command run again after a
# failure (or with a changed value) then reconfigures instead of only updating.
# Leaves the requested setup in the variables when it returns 0.
unattended_request_differs_from_installed() {
  local asked_for_setup="no"
  local existing_mode="" existing_domains="" existing_tls="" existing_server="" existing_client="" existing_worker=""
  local requested_domains=""

  if [[ -n "$AURELLE_DOMAIN" || -n "$AURELLE_SERVER_PORT" || -n "$AURELLE_CLIENT_PORT" || -n "$AURELLE_WORKER_PORT" || "$(lowercase "$AURELLE_TLS")" != "auto" ]]; then
    asked_for_setup="yes"
  fi
  if [[ "$asked_for_setup" == "no" ]]; then
    return 1
  fi

  load_deployment_from_existing
  existing_mode="$DEPLOY_MODE"
  existing_domains="${DOMAIN_NAMES[*]:-}"
  existing_tls="yes"
  [[ "$CERT_MODE" == "http" ]] && existing_tls="no"
  existing_server="$SERVER_PORT"
  existing_client="$CLIENT_PORT"
  existing_worker="$WORKER_PORT"

  resolve_unattended_options
  requested_domains="${DOMAIN_NAMES[*]:-}"

  [[ "$existing_mode" != "$DEPLOY_MODE" ]] && return 0
  [[ "$existing_domains" != "$requested_domains" ]] && return 0
  if [[ "$existing_tls" == "yes" && "$CERT_MODE" == "http" ]] || [[ "$existing_tls" == "no" && "$CERT_MODE" != "http" ]]; then
    return 0
  fi
  [[ -n "$AURELLE_SERVER_PORT" && "$existing_server" != "$SERVER_PORT" ]] && return 0
  [[ -n "$AURELLE_CLIENT_PORT" && "$existing_client" != "$CLIENT_PORT" ]] && return 0
  [[ -n "$AURELLE_WORKER_PORT" && "$existing_worker" != "$WORKER_PORT" ]] && return 0
  return 1
}

# Why update_is_needed said yes: "newer" (a newer commit, or the remote could not be read),
# "build" (no client build) or "down" (the app does not answer).
UPDATE_REASON="newer"

# Returns 0 when an update has something to do: a newer commit upstream, or an
# installation that does not answer or has no client build (a repair); 1 when there is
# nothing to do; 2 when the answer is not known because the source cannot be reached.
# Nothing has been stopped or changed at that point.
update_is_needed() {
  local local_commit="" remote_commit="" ref=""
  UPDATE_REASON="newer"
  if ! run_with_retries run_in_install_dir "git fetch --force --prune --tags origin"; then
    # The checkout follows the address it was cloned from, which is what failed.
    local origin_url=""
    origin_url="$(run_in_install_dir_output "git remote get-url origin" 2>/dev/null | tr -d '\r\n')"
    warn "Could not reach ${origin_url:-$REPO_URL} to look for updates. Nothing was changed; check the network and run the same command again."
    return 2
  fi
  ref="$(repo_target_ref)"
  local_commit="$(run_in_install_dir_output "git rev-parse HEAD" 2>/dev/null | tr -d '\r\n')"
  remote_commit="$(repo_remote_commit "$ref")"
  if [[ -z "$remote_commit" || "$local_commit" != "$remote_commit" ]]; then
    return 0
  fi
  if ! path_exists_as_root "$INSTALL_DIR/client/dist/index.html"; then
    log "The client build is missing: rebuilding."
    UPDATE_REASON="build"
    return 0
  fi
  if ! songbird_healthcheck_responds "$SERVER_PORT"; then
    log "Aurelle is not answering on port ${SERVER_PORT}: repairing."
    UPDATE_REASON="down"
    return 0
  fi
  return 1
}

# An installation that is at the newest version but does not work: rebuild the client
# when it is missing and start everything again. Nothing else is touched.
repair_installation() {
  acquire_install_lock || return 1
  sync_values_from_env
  if [[ "$UPDATE_REASON" == "build" ]]; then
    install_songbird_dependencies || return 1
    apply_ownership || return 1
  fi
  restart_services_after_update || return 1
  install_calls_relay_if_requested
  show_deployment_success_frame "repaired"
}

run_unattended() {
  local action=""
  action="$(lowercase "$(sanitize_input_value "$AURELLE_ACTION")")"
  case "$action" in
    ""|auto) action="auto" ;;
    install|update) ;;
    *) usage_fail "AURELLE_ACTION must be auto, install or update (got: ${AURELLE_ACTION})." ;;
  esac

  local setup_resolved="no"
  if [[ "$action" == "auto" ]]; then
    if installation_is_complete; then
      action="update"
      if unattended_request_differs_from_installed; then
        action="install"
        setup_resolved="yes"
        log "This run asks for a different setup than the installed one: reconfiguring."
      fi
    else
      action="install"
    fi
  fi

  if [[ "$action" == "install" ]]; then
    log "Unattended install (nothing will be asked)."
    if [[ "$setup_resolved" == "no" ]]; then
      resolve_unattended_options
    fi
    install_songbird || return 1
  else
    if ! installation_is_complete; then
      warn "AURELLE_ACTION=update, but there is no complete installation in ${INSTALL_DIR}. Use install."
      return 1
    fi
    log "Aurelle is installed in ${INSTALL_DIR}: updating it (nothing will be asked)."
    resolve_unattended_update_options
    acquire_install_lock || return 1
    local update_state=0
    update_is_needed || update_state=$?
    case "$update_state" in
      0)
        if [[ "$UPDATE_REASON" == "newer" ]]; then
          update_songbird || return 1
        else
          repair_installation || return 1
        fi
        ;;
      1)
        log "Aurelle is already up to date."
        install_calls_relay_if_requested
        show_deployment_success_frame "current"
        ;;
      *)
        return 1
        ;;
    esac
  fi

  if [[ "$TLS_FAILED" == "1" ]]; then
    warn "Aurelle is installed and answers over HTTP, but the TLS certificate could not be issued. Fix the cause above and run the same command again."
    return "$EXIT_TLS_FAILED"
  fi
  return 0
}

# Menu entry: set up (or refresh) the calls relay on an installed server.
setup_calls_relay_menu() {
  if ! installation_is_complete; then
    warn "Aurelle is not installed yet. Install it first."
    press_enter_to_continue
    return 0
  fi
  acquire_install_lock || return 1
  load_deployment_from_existing
  printf "\n  Calls between people on different networks need a relay. This installs coturn from\n"
  printf "  apt, writes its configuration, opens its ports and points Aurelle at it.\n\n"
  CALLS_RELAY_MODE="$(prompt_yes_no "Set up the calls relay (coturn) now?" "yes")"
  if [[ "$CALLS_RELAY_MODE" != "yes" ]]; then
    log "Calls relay not changed."
    return 0
  fi
  install_calls_relay || true
  printf "\n  %s\n" "${CALLS_RELAY_SUMMARY:-Done.}"
  press_enter_to_continue
}

main() {
  parse_cli_args "$@"
  if [[ "$SHOW_VERSION" == "1" ]]; then
    SKIP_CLEAR_ON_EXIT="1"
    printf "%s\n" "$SCRIPT_VERSION"
    return 0
  fi

  STRICT_CHECKS="1"
  ABORT_ON_INPUT_CLOSED="1"
  validate_relay_port_settings
  init_prompt_io
  detect_os
  ensure_sudo

  if is_unattended; then
    run_unattended
    return $?
  fi

  ensure_global_command_on_first_run

  local choice=""
  while true; do
    show_menu
    prompt_read "Choose an option [0-10]: " choice
    case "$choice" in
      1) run_menu_action install_songbird ;;
      2) run_menu_action update_songbird ;;
      3) run_menu_action restart_songbird ;;
      4) run_menu_action edit_settings ;;
      5) run_menu_action show_db_menu ;;
      6) run_menu_action remove_songbird ;;
      7) run_menu_action update_menu ;;
      8) run_menu_action configure_mirrors_menu ;;
      9) run_menu_action show_logs_menu ;;
      10) run_menu_action setup_calls_relay_menu ;;
      0) break ;;
      *) printf "Invalid choice. Select a number from 0 to 10.\n" ;;
    esac
  done
}

# Keep this the last line: a download that is cut short never reaches it, so a broken
# "curl ... | bash" does nothing instead of running half a script.
main "$@"
