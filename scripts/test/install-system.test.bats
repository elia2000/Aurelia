#!/usr/bin/env bats
# What scripts/install.sh does to the machine around the app, with real git where git is
# the point: getting the source (default branch, a branch, a tag, an update that has to
# move over local changes), waiting for apt, the Node.js version, the build, the checks
# before anything is changed.
#
# Commands that need root or the network are stubs (see helpers/installer.bash); apt-get
# and npm are scripts in PATH that record their arguments.

load 'helpers/installer'

setup() {
  load_installer
  sleep() { return 0; }

  mkdir -p "$TEST_DIR/bin" "$TEST_DIR/home"
  export CALLS_LOG="$TEST_DIR/calls.log"
  : > "$CALLS_LOG"
  # The global git settings of whoever runs the tests are not ours to change.
  export HOME="$TEST_DIR/home"
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_TERMINAL_PROMPT=0

  cat > "$TEST_DIR/bin/apt-get" <<'EOF'
#!/bin/bash
echo "apt-get[$DEBIAN_FRONTEND] $*" >> "$CALLS_LOG"
exit "${FAKE_APT_STATUS:-0}"
EOF
  cat > "$TEST_DIR/bin/npm" <<'EOF'
#!/bin/bash
echo "npm $*" >> "$CALLS_LOG"
if [[ "$*" == *"run build"* ]]; then
  if [[ "${FAKE_BUILD_STATUS:-0}" != "0" ]]; then
    exit "$FAKE_BUILD_STATUS"
  fi
  mkdir -p client/dist
  echo "new build" > client/dist/index.html
fi
exit 0
EOF
  chmod +x "$TEST_DIR/bin/apt-get" "$TEST_DIR/bin/npm"
  export PATH="$TEST_DIR/bin:$PATH"
  NODE_EXEC_PATH="$TEST_DIR/bin/node"
  NPM_EXEC_PATH="$TEST_DIR/bin/npm"
}

teardown() {
  unload_installer
}

git_in() {
  git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false "$@"
}

# A repository with main (two commits), a branch "feature" and a tag "v1.0.0" on the
# first commit, published as a bare repository the installer can clone.
make_remote() {
  local work="$TEST_DIR/work"
  REMOTE="$TEST_DIR/remote.git"
  git init -q "$work"
  git_in -C "$work" checkout -q -b main
  mkdir -p "$work/scripts" "$work/server" "$work/client"
  printf '{"lockfileVersion":3}\n' > "$work/package-lock.json"
  printf '{"lockfileVersion":3}\n' > "$work/server/package-lock.json"
  printf '#!/bin/bash\necho launcher\n' > "$work/scripts/run-data-command.sh"
  printf 'one\n' > "$work/VERSION"
  git_in -C "$work" add -A
  git_in -C "$work" commit -q -m "first"
  git_in -C "$work" tag v1.0.0
  git_in -C "$work" checkout -q -b feature
  printf 'feature\n' > "$work/FEATURE"
  git_in -C "$work" add -A
  git_in -C "$work" commit -q -m "feature work"
  git_in -C "$work" checkout -q main
  printf 'two\n' > "$work/VERSION"
  git_in -C "$work" commit -q -am "second"
  git clone -q --bare "$work" "$REMOTE"
  git -C "$REMOTE" symbolic-ref HEAD refs/heads/main
  REPO_URL="$REMOTE"
  WORK="$work"
}

# Publishes one more commit on main.
push_new_commit() {
  printf '%s\n' "$1" > "$WORK/VERSION"
  git_in -C "$WORK" commit -q -am "$1"
  git_in -C "$WORK" push -q "$REMOTE" main
}

head_branch() {
  git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD
}

# ===========================================================================
# Getting the source
# ===========================================================================

@test "clone_repo: without REPO_BRANCH it takes the default branch of the repository" {
  make_remote
  clone_repo
  [ "$(head_branch)" = "main" ]
  [ "$(cat "$INSTALL_DIR/VERSION")" = "two" ]
}

@test "clone_repo: a local path and a file:// URL both work" {
  make_remote
  REPO_URL="file://$REMOTE"
  clone_repo
  [ "$(head_branch)" = "main" ]
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  REPO_URL="$WORK"
  clone_repo
  [ -d "$INSTALL_DIR/.git" ]
}

@test "clone_repo: REPO_BRANCH can be a branch" {
  make_remote
  REPO_BRANCH="feature"
  clone_repo
  [ "$(head_branch)" = "feature" ]
  [ -f "$INSTALL_DIR/FEATURE" ]
}

@test "clone_repo: REPO_BRANCH can be a tag" {
  make_remote
  REPO_BRANCH="v1.0.0"
  clone_repo
  [ "$(cat "$INSTALL_DIR/VERSION")" = "one" ]
}

@test "clone_repo: an address that does not exist fails and names it" {
  REPO_URL="$TEST_DIR/nothing-here.git"
  run clone_repo
  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not clone ${REPO_URL}"* ]]
}

@test "clone_repo: a branch that does not exist fails and names it" {
  make_remote
  REPO_BRANCH="no-such-branch"
  run clone_repo
  [ "$status" -eq 1 ]
  [[ "$output" == *"(no-such-branch)"* ]]
}

@test "clone_repo: unattended it never waits for git credentials, interactively it may ask" {
  make_remote
  real_git="$(command -v git)"
  printf '#!/bin/bash\necho "GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT:-unset} $*" >> "$CALLS_LOG"\nexec %s "$@"\n' "$real_git" > "$TEST_DIR/bin/git"
  chmod +x "$TEST_DIR/bin/git"
  hash -r
  unset GIT_TERMINAL_PROMPT
  UNATTENDED=1
  clone_repo
  grep -q '^GIT_TERMINAL_PROMPT=0 clone ' "$CALLS_LOG"

  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  : > "$CALLS_LOG"
  UNATTENDED=0
  clone_repo
  grep -q '^GIT_TERMINAL_PROMPT=unset clone ' "$CALLS_LOG"
}

@test "sync_repo_to_ref: unattended the fetch never waits for git credentials" {
  make_remote
  clone_repo
  real_git="$(command -v git)"
  printf '#!/bin/bash\necho "GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT:-unset} $*" >> "$CALLS_LOG"\nexec %s "$@"\n' "$real_git" > "$TEST_DIR/bin/git"
  chmod +x "$TEST_DIR/bin/git"
  hash -r
  unset GIT_TERMINAL_PROMPT
  UNATTENDED=1
  sync_repo_to_ref
  grep -q '^GIT_TERMINAL_PROMPT=0 fetch ' "$CALLS_LOG"
}

@test "clone_repo: a folder with something else in it is not deleted unattended" {
  make_remote
  UNATTENDED=1
  printf 'precious\n' > "$INSTALL_DIR/notes.txt"
  run clone_repo
  [ "$status" -eq 1 ]
  [[ "$output" == *"is not an Aurelle checkout"* ]]
  [ -f "$INSTALL_DIR/notes.txt" ]
}

@test "clone_repo: an existing checkout is updated, not cloned again" {
  make_remote
  clone_repo
  push_new_commit "three"
  clone_repo
  [ "$(cat "$INSTALL_DIR/VERSION")" = "three" ]
}

@test "sync_repo_to_ref: moves to the newest commit although npm rewrote a lock file" {
  make_remote
  clone_repo
  printf '{"lockfileVersion":3,"changed":true}\n' > "$INSTALL_DIR/package-lock.json"
  printf '{"lockfileVersion":3,"changed":true}\n' > "$INSTALL_DIR/server/package-lock.json"
  # The upstream changed the same files, which is what makes git refuse to move.
  printf '{"lockfileVersion":3,"upstream":true}\n' > "$WORK/package-lock.json"
  git_in -C "$WORK" commit -q -am "lock file"
  git_in -C "$WORK" push -q "$REMOTE" main
  sync_repo_to_ref
  [ "$(cat "$INSTALL_DIR/package-lock.json")" = '{"lockfileVersion":3,"upstream":true}' ]
  [ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]
}

@test "sync_repo_to_ref: moves although the installer made a tracked script executable" {
  make_remote
  clone_repo
  # A checkout made by an older installer does not have the setting yet.
  git -C "$INSTALL_DIR" config --unset core.fileMode
  chmod 755 "$INSTALL_DIR/scripts/run-data-command.sh"
  printf '#!/bin/bash\necho launcher v2\n' > "$WORK/scripts/run-data-command.sh"
  git_in -C "$WORK" commit -q -am "launcher"
  git_in -C "$WORK" push -q "$REMOTE" main
  sync_repo_to_ref
  grep -q 'launcher v2' "$INSTALL_DIR/scripts/run-data-command.sh"
}

@test "sync_repo_to_ref: follows a branch, then a tag, then the default branch again" {
  make_remote
  clone_repo
  REPO_BRANCH="feature"
  sync_repo_to_ref
  [ "$(head_branch)" = "feature" ]
  REPO_BRANCH="v1.0.0"
  sync_repo_to_ref
  [ "$(cat "$INSTALL_DIR/VERSION")" = "one" ]
  REPO_BRANCH=""
  sync_repo_to_ref
  [ "$(head_branch)" = "main" ]
  [ "$(cat "$INSTALL_DIR/VERSION")" = "two" ]
}

@test "sync_repo_to_ref: a name that is neither a branch nor a tag fails and says so" {
  make_remote
  clone_repo
  REPO_BRANCH="v9.9.9"
  run sync_repo_to_ref
  [ "$status" -eq 1 ]
  [[ "$output" == *"Neither a branch nor a tag called v9.9.9"* ]]
}

@test "repo_target_ref: REPO_BRANCH, else the remote's default branch" {
  make_remote
  clone_repo
  [ "$(repo_target_ref)" = "main" ]
  REPO_BRANCH="feature"
  [ "$(repo_target_ref)" = "feature" ]
}

@test "repo_remote_commit: the commit of a branch or a tag on the remote" {
  make_remote
  clone_repo
  run_in_install_dir "git fetch --force --prune --tags origin"
  [ "$(repo_remote_commit main)" = "$(git -C "$REMOTE" rev-parse main)" ]
  [ "$(repo_remote_commit feature)" = "$(git -C "$REMOTE" rev-parse feature)" ]
  [ "$(repo_remote_commit v1.0.0)" = "$(git -C "$REMOTE" rev-parse 'v1.0.0^{commit}')" ]
  [ -z "$(repo_remote_commit nothing)" ]
}

@test "update_is_needed: with the real repository" {
  make_remote
  clone_repo
  path_exists_as_root() { return 0; }
  songbird_healthcheck_responds() { return 0; }
  run update_is_needed
  [ "$status" -eq 1 ]
  push_new_commit "three"
  update_is_needed
  [ "$UPDATE_REASON" = "newer" ]
}

@test "update_is_needed: a repository that cannot be reached is a failure to find out, not an update" {
  make_remote
  clone_repo
  git -C "$INSTALL_DIR" remote set-url origin "$TEST_DIR/gone.git"
  run update_is_needed
  [ "$status" -eq 2 ]
}

@test "update_is_needed: the message names the address the checkout follows, not REPO_URL" {
  make_remote
  clone_repo
  git -C "$INSTALL_DIR" remote set-url origin "$TEST_DIR/gone.git"
  REPO_URL="$TEST_DIR/some-other.git"
  run update_is_needed
  [ "$status" -eq 2 ]
  [[ "$output" == *"$TEST_DIR/gone.git"* ]]
  [[ "$output" != *"some-other.git"* ]]
}

# ===========================================================================
# The settings file holds secrets: only root and the service user read it
# ===========================================================================

@test "apply_ownership: .env is readable by the service user and root only (mode 640)" {
  printf 'ADMIN_API_TOKEN=secret\n' > "$INSTALL_DIR/.env"
  chmod 644 "$INSTALL_DIR/.env"
  chown() { return 0; }
  ensure_git_safe_directory() { return 0; }
  apply_ownership
  [ "$(stat -c %a "$INSTALL_DIR/.env")" = "640" ]
}

@test "write_env_fallback: a new .env is never created readable by other users" {
  SERVER_PORT=5174 CLIENT_PORT=80 WORKER_PORT=8080
  write_env_fallback "$INSTALL_DIR/.env"
  [ -f "$INSTALL_DIR/.env" ]
  [ "$(stat -c %a "$INSTALL_DIR/.env")" = "600" ]
}

@test "read_env_file: falls back to the privileged reader when the file cannot be read directly" {
  run_as_root() { printf 'FROM_ROOT=1\n'; }
  run read_env_file "$TEST_DIR/not-readable.env"
  [[ "$output" == *"FROM_ROOT=1"* ]]
}

@test "get_existing_env_value and replace_env_value work through the privileged reader" {
  printf 'CALLS_TURN_SECRET=abc\nSERVER_PORT=5174\n' > "$INSTALL_DIR/.env"
  read_env_file() { cat "$1"; }
  [ "$(get_existing_env_value CALLS_TURN_SECRET "")" = "abc" ]
  replace_env_value "$INSTALL_DIR/.env" CALLS_TURN_SECRET def
  replace_env_value "$INSTALL_DIR/.env" NEW_KEY value
  [ "$(grep -c '^CALLS_TURN_SECRET=' "$INSTALL_DIR/.env")" -eq 1 ]
  [ "$(get_existing_env_value CALLS_TURN_SECRET "")" = "def" ]
  [ "$(get_existing_env_value NEW_KEY "")" = "value" ]
}

@test "ensure_git_safe_directory: listed once, however often it runs" {
  ensure_git_safe_directory
  ensure_git_safe_directory
  ensure_git_safe_directory
  [ "$(git config --global --get-all safe.directory | grep -cxF "$INSTALL_DIR")" -eq 1 ]
}

# ===========================================================================
# Dependencies and the build
# ===========================================================================

@test "install_songbird_dependencies: npm ci from the lock files, then one build" {
  mkdir -p "$INSTALL_DIR/server" "$INSTALL_DIR/worker" "$INSTALL_DIR/client"
  git init -q "$INSTALL_DIR"
  install_songbird_dependencies
  grep -q 'npm .*--prefix server ci' "$CALLS_LOG"
  grep -q 'npm .*--prefix worker ci' "$CALLS_LOG"
  grep -q 'npm .*--prefix client ci' "$CALLS_LOG"
  grep -q 'npm --prefix client run build' "$CALLS_LOG"
  [ -f "$INSTALL_DIR/client/dist/index.html" ]
}

@test "install_songbird_dependencies: the mirror registry is used for every package" {
  mkdir -p "$INSTALL_DIR/server" "$INSTALL_DIR/worker" "$INSTALL_DIR/client"
  git init -q "$INSTALL_DIR"
  MIRROR_NPM="https://registry.example.com"
  install_songbird_dependencies
  [ "$(grep -c -- '--registry https://registry.example.com' "$CALLS_LOG")" -ge 3 ]
}

@test "build_client: a failed build puts the previous build back and fails" {
  mkdir -p "$INSTALL_DIR/client/dist"
  echo "old build" > "$INSTALL_DIR/client/dist/index.html"
  export FAKE_BUILD_STATUS=1
  run build_client
  [ "$status" -eq 1 ]
  [[ "$output" == *"previous build"* ]]
  [ "$(cat "$INSTALL_DIR/client/dist/index.html")" = "old build" ]
  [ ! -e "$INSTALL_DIR/client/dist.previous" ]
}

@test "build_client: a good build replaces the previous one and leaves nothing behind" {
  mkdir -p "$INSTALL_DIR/client/dist"
  echo "old build" > "$INSTALL_DIR/client/dist/index.html"
  build_client
  [ "$(cat "$INSTALL_DIR/client/dist/index.html")" = "new build" ]
  [ ! -e "$INSTALL_DIR/client/dist.previous" ]
}

@test "build_client: a first build that fails leaves no half-built folder" {
  export FAKE_BUILD_STATUS=1
  run build_client
  [ "$status" -eq 1 ]
  [ ! -e "$INSTALL_DIR/client/dist" ]
}

# ===========================================================================
# The .env file
# ===========================================================================

@test "collect_preserved_env_lines: keeps the settings the generated file has no line for" {
  cat > "$INSTALL_DIR/.env" <<'EOF'
# a comment
SERVER_PORT=5174
ADMIN_API_TOKEN=abc
CALLS_TURN_URLS=turn:x:3478
CALLS_TURN_SECRET=s3cret
THEME_MODE=random

EMPTY_LINE_ABOVE=1
EOF
  run collect_preserved_env_lines "$INSTALL_DIR/.env"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CALLS_TURN_URLS=turn:x:3478"* ]]
  [[ "$output" == *"CALLS_TURN_SECRET=s3cret"* ]]
  [[ "$output" == *"THEME_MODE=random"* ]]
  [[ "$output" == *"EMPTY_LINE_ABOVE=1"* ]]
  [[ "$output" != *"SERVER_PORT"* ]]
  [[ "$output" != *"ADMIN_API_TOKEN"* ]]
  [[ "$output" != *"comment"* ]]
}

@test "write_env_fallback: writing the file again keeps the relay settings and the secrets" {
  cat > "$INSTALL_DIR/.env" <<'EOF'
SERVER_PORT=5174
STORAGE_ENCRYPTION_KEY=keepkey
ADMIN_API_TOKEN=keeptoken
CALLS_TURN_URLS=turn:x:3478
CALLS_TURN_SECRET=s3cret
EOF
  write_env_fallback "$INSTALL_DIR/.env"
  grep -qx 'CALLS_TURN_URLS=turn:x:3478' "$INSTALL_DIR/.env"
  grep -qx 'CALLS_TURN_SECRET=s3cret' "$INSTALL_DIR/.env"
  grep -qx 'STORAGE_ENCRYPTION_KEY=keepkey' "$INSTALL_DIR/.env"
  grep -qx 'ADMIN_API_TOKEN=keeptoken' "$INSTALL_DIR/.env"
  [ "$(grep -c '^CALLS_TURN_URLS=' "$INSTALL_DIR/.env")" -eq 1 ]
}

# ===========================================================================
# Node.js
# ===========================================================================

@test "node_version_ok: the repository's minimum is 24.18.0, not just any 24" {
  node_version_ok "24.18.0"
  node_version_ok "v24.18.0"
  node_version_ok "24.22.1"
  node_version_ok "25.0.0"
  node_version_ok "v26.1.0-nightly2026"
  refute node_version_ok "24.17.9"
  refute node_version_ok "24.0.0"
  refute node_version_ok "22.22.0"
  refute node_version_ok "18.20.4"
  refute node_version_ok ""
  refute node_version_ok "not a version"
}

@test "NODE_MIN_VERSION follows engines.node in package.json" {
  engines="$(sed -n 's/.*"node": *">=\([0-9.]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -n 1)"
  [ -n "$engines" ]
  [ "$NODE_MIN_VERSION" = "$engines" ]
}

@test "installed_node_version: asks the node in PATH" {
  node() { printf '24.18.2\n'; }
  [ "$(installed_node_version)" = "24.18.2" ]
}

@test "use_acceptable_node: fine when the node in PATH is new enough" {
  node() { printf '24.20.0\n'; }
  use_acceptable_node
}

@test "ensure_nodejs_from_nodesource: installs nothing when Node.js is new enough" {
  use_acceptable_node() { return 0; }
  installed_node_version() { printf '24.20.0'; }
  ensure_nodejs_installed() { echo "INSTALLED" >> "$CALLS_LOG"; }
  run ensure_nodejs_from_nodesource
  [ "$status" -eq 0 ]
  [[ "$output" == *"already installed"* ]]
  refute grep -q INSTALLED "$CALLS_LOG"
}

@test "ensure_nodejs_from_nodesource: an old Node.js is replaced, and the result is checked" {
  attempts=0
  use_acceptable_node() { attempts=$((attempts + 1)); (( attempts > 1 )); }
  installed_node_version() { printf '22.22.0'; }
  ensure_nodejs_installed() { echo "INSTALLED" >> "$CALLS_LOG"; }
  run ensure_nodejs_from_nodesource
  [ "$status" -eq 0 ]
  [[ "$output" == *"older than the required 24.18.0"* ]]
  grep -q INSTALLED "$CALLS_LOG"
}

@test "ensure_nodejs_from_nodesource: if it is still too old afterwards it fails and says what to do" {
  use_acceptable_node() { return 1; }
  installed_node_version() { printf '22.22.0'; }
  ensure_nodejs_installed() { return 0; }
  run ensure_nodejs_from_nodesource
  [ "$status" -eq 1 ]
  [[ "$output" == *"24.18.0 or newer is required"* ]]
  [[ "$output" == *"MIRROR_NODESOURCE"* ]]
}

@test "ensure_nodejs_installed: a download that fails is reported and fails" {
  MIRROR_NODESOURCE="https://mirror.example.com/node.tar.gz"
  download() { return 22; }
  run ensure_nodejs_installed
  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not download Node.js from https://mirror.example.com/node.tar.gz"* ]]
}

@test "ensure_nodejs_installed: NodeSource unreachable is reported with the mirror hint" {
  download() { return 22; }
  run ensure_nodejs_installed
  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not set up NodeSource"* ]]
  [[ "$output" == *"MIRROR_NODESOURCE"* ]]
}

# ===========================================================================
# apt
# ===========================================================================

@test "apt_get_run: never asks a question and waits for the dpkg lock" {
  apt_get_run install -y something
  run cat "$CALLS_LOG"
  [[ "$output" == *"apt-get[noninteractive] "* ]]
  [[ "$output" == *"DPkg::Lock::Timeout=300"* ]]
  [[ "$output" == *"--force-confold"* ]]
  [[ "$output" == *"Acquire::Retries=3"* ]]
  [[ "$output" == *"install -y something"* ]]
}

@test "package_manager_is_busy: apt's lock files held by someone mean busy" {
  lslocks() { printf '%s\n' "/var/lib/apt/lists/lock"; }
  package_manager_is_busy
  lslocks() { printf '%s\n' "/var/lib/dpkg/lock-frontend"; }
  package_manager_is_busy
  lslocks() { printf '%s\n' "/var/cache/apt/archives/lock"; }
  package_manager_is_busy
}

@test "package_manager_is_busy: other locks, no locks, or no lslocks mean free" {
  lslocks() { printf '%s\n' "/tmp/something/LOCK" "/var/lib/apt/lists/partial/x"; }
  refute package_manager_is_busy
  lslocks() { return 0; }
  refute package_manager_is_busy
  unset -f lslocks
  have_cmd() { [[ "$1" != "lslocks" ]]; }
  refute package_manager_is_busy
}

@test "wait_for_package_manager: free means no message and no wait" {
  package_manager_is_busy() { return 1; }
  run wait_for_package_manager
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "wait_for_package_manager: waits while busy, says why once, and goes on when free" {
  AURELLE_APT_LOCK_WAIT=60
  polls=0
  package_manager_is_busy() { polls=$((polls + 1)); (( polls < 4 )); }
  wait_for_package_manager > "$TEST_DIR/out"
  [ "$polls" -eq 4 ]
  [ "$(grep -c 'Another package manager is running' "$TEST_DIR/out")" -eq 1 ]
}

@test "wait_for_package_manager: gives up after the limit and tries anyway" {
  AURELLE_APT_LOCK_WAIT=10
  package_manager_is_busy() { return 0; }
  run wait_for_package_manager
  [ "$status" -eq 0 ]
  [[ "$output" == *"still running after 10 seconds"* ]]
}

@test "wait_for_package_manager: a limit that is not a number falls back to the default" {
  AURELLE_APT_LOCK_WAIT="soon"
  package_manager_is_busy() { return 1; }
  run wait_for_package_manager
  [ "$status" -eq 0 ]
}

@test "apt_release_codename: from /etc/os-release, without lsb_release" {
  [[ -r /etc/os-release ]] || skip "no /etc/os-release"
  expected="$(. /etc/os-release; printf '%s' "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"
  [ -n "$expected" ] || skip "this system has no VERSION_CODENAME"
  unset -f lsb_release
  have_cmd() { [[ "$1" != "lsb_release" ]]; }
  [ "$(apt_release_codename)" = "$expected" ]
}

@test "install_required_packages: works on an image without lsb_release (minimal Debian)" {
  lsb_release() { echo "lsb_release: command not found" >&2; return 127; }
  have_cmd() { [[ "$1" != "lsb_release" ]]; }
  dpkg() { return 1; }
  run install_required_packages
  [ "$status" -eq 0 ]
  grep -q 'apt-get.* update' "$CALLS_LOG"
  grep -q 'install -y --allow-downgrades git curl' "$CALLS_LOG"
}

@test "install_required_packages: waits for the package manager before the first apt command" {
  dpkg() { return 0; }
  wait_for_package_manager() { echo "WAIT" >> "$CALLS_LOG"; }
  install_required_packages
  [ "$(head -n 1 "$CALLS_LOG")" = "WAIT" ]
  grep -q 'apt-get.* update' "$CALLS_LOG"
}

@test "install_required_packages: a failing apt update fails the step" {
  dpkg() { return 0; }
  export FAKE_APT_STATUS=100
  run install_required_packages
  [ "$status" -eq 1 ]
}

@test "install_required_packages: Postgres packages only for a local Postgres" {
  dpkg() { return 1; }
  DB_CLIENT="postgres"
  POSTGRES_URL=""
  POSTGRES_HOST="127.0.0.1"
  install_required_packages
  grep -q 'postgresql postgresql-contrib' "$CALLS_LOG"
  : > "$CALLS_LOG"
  POSTGRES_URL="postgresql://db.example.com/aurelle"
  install_required_packages
  refute grep -q 'postgresql-contrib' "$CALLS_LOG"
  grep -q 'postgresql-client' "$CALLS_LOG"
}

# ===========================================================================
# Before anything is changed
# ===========================================================================

@test "check_system_requirements: enough disk passes" {
  df() { printf 'Filesystem 1M-blocks Used Available Capacity Mounted\n/dev/x 50000 1000 40000 3%% /\n'; }
  run check_system_requirements
  [ "$status" -eq 0 ]
}

@test "check_system_requirements: too little disk stops before anything is installed" {
  df() { printf 'Filesystem 1M-blocks Used Available Capacity Mounted\n/dev/x 50000 49000 500 99%% /\n'; }
  run check_system_requirements
  [ "$status" -eq 1 ]
  [[ "$output" == *"Only 500 MB are free"* ]]
  [[ "$output" == *"at least ${MIN_FREE_DISK_MB} MB"* ]]
}

@test "check_system_requirements: asks about the nearest folder that exists" {
  INSTALL_DIR="$TEST_DIR/not/yet/created"
  df() { printf '%s\n' "Filesystem 1M-blocks Used Available Capacity Mounted" "/dev/x 50000 1000 40000 3% /"; echo "$@" >> "$CALLS_LOG"; }
  check_system_requirements
  grep -q -- "-Pm $TEST_DIR" "$CALLS_LOG"
}

@test "check_system_requirements: an unreadable df is not a reason to stop" {
  df() { return 1; }
  run check_system_requirements
  [ "$status" -eq 0 ]
}

# ===========================================================================
# Starting nginx and the app
# ===========================================================================

@test "reload_nginx: starts nginx when a reload is refused (it was not running)" {
  systemctl() {
    echo "systemctl $*" >> "$CALLS_LOG"
    [[ "$1" != "reload" ]]
  }
  run reload_nginx
  [ "$status" -eq 0 ]
  grep -qx 'systemctl reload nginx' "$CALLS_LOG"
  grep -qx 'systemctl restart nginx' "$CALLS_LOG"
}

@test "reload_nginx: a plain reload is enough when nginx runs" {
  systemctl() { echo "systemctl $*" >> "$CALLS_LOG"; }
  reload_nginx
  refute grep -q 'restart nginx' "$CALLS_LOG"
}

@test "wait_for_app_health: answers at once, or times out" {
  songbird_healthcheck_responds() { return 0; }
  wait_for_app_health 5174 10
  songbird_healthcheck_responds() { return 1; }
  run wait_for_app_health 5174 0
  [ "$status" -eq 1 ]
}

@test "confirm_app_started: a server that does not answer fails the step and shows its log" {
  wait_for_app_health() { return 1; }
  run_as_root() {
    if [[ "$1" == "journalctl" ]]; then echo "Error: listen EADDRINUSE :::5174"; return 0; fi
    "$@"
  }
  run confirm_app_started
  [ "$status" -eq 1 ]
  [[ "$output" == *"does not answer on port"* ]]
  [[ "$output" == *"EADDRINUSE"* ]]
  [[ "$output" == *"journalctl -u songbird"* ]]
}

@test "restart_services_after_update: restarts the app, reloads nginx, and in a real run waits for the app" {
  systemctl() { echo "systemctl $*" >> "$CALLS_LOG"; }
  STRICT_CHECKS="1"
  confirm_app_started() { echo "CONFIRM" >> "$CALLS_LOG"; }
  UPDATE_STOPPED_SERVICES="yes"
  restart_services_after_update
  grep -qx 'systemctl restart songbird.service' "$CALLS_LOG"
  grep -qx 'systemctl reload nginx' "$CALLS_LOG"
  grep -qx 'CONFIRM' "$CALLS_LOG"
  [ "$UPDATE_STOPPED_SERVICES" = "no" ]
}

@test "restart_services_after_update: an app that does not come back is a failed update" {
  systemctl() { return 0; }
  STRICT_CHECKS="1"
  confirm_app_started() { return 1; }
  run restart_services_after_update
  [ "$status" -eq 1 ]
}

@test "update_songbird: whatever ends the update early starts the stopped app again" {
  acquire_install_lock() { return 0; }
  systemctl() { echo "systemctl $*" >> "$CALLS_LOG"; }
  update_songbird_run() { UPDATE_STOPPED_SERVICES="yes"; return 1; }
  run update_songbird
  [ "$status" -eq 1 ]
  [[ "$output" == *"Starting it again"* ]]
  grep -qx 'systemctl start songbird.service' "$CALLS_LOG"
}

@test "update_songbird: a finished update leaves the app alone" {
  acquire_install_lock() { return 0; }
  systemctl() { echo "systemctl $*" >> "$CALLS_LOG"; }
  update_songbird_run() { UPDATE_STOPPED_SERVICES="no"; return 0; }
  update_songbird
  refute grep -q 'systemctl start' "$CALLS_LOG"
}

# ===========================================================================
# The command people run later
# ===========================================================================

@test "install_global_command_from_remote: stamps the version of the downloaded script" {
  download() { printf '#!/usr/bin/env bash\n# songbird-deploy-version: 9.9.9\necho hi\n'; }
  install_global_command_from_remote
  [ "$LAST_GLOBAL_COMMAND_VERSION" = "9.9.9" ]
  [ -x "$GLOBAL_COMMAND_PATH" ]
  [ "$(sed -n 2p "$GLOBAL_COMMAND_PATH")" = "# songbird-deploy-version: 9.9.9" ]
}

@test "install_global_command_from_remote: a download that fails installs nothing" {
  download() { return 22; }
  run install_global_command_from_remote
  [ "$status" -eq 1 ]
  [ ! -e "$GLOBAL_COMMAND_PATH" ]
}

@test "ensure_global_command_on_first_run: piped from curl it takes the copy that comes with the sources, or does nothing" {
  CURRENT_SCRIPT_PATH=""
  run ensure_global_command_on_first_run
  [ "$status" -eq 0 ]
  [ ! -e "$GLOBAL_COMMAND_PATH" ]

  mkdir -p "$INSTALL_DIR/scripts"
  printf '#!/usr/bin/env bash\n# songbird-deploy-version: 1.2.3\n' > "$INSTALL_DIR/scripts/install.sh"
  ensure_global_command_on_first_run
  [ -x "$GLOBAL_COMMAND_PATH" ]
  grep -q 'songbird-deploy-version: 1.2.3' "$GLOBAL_COMMAND_PATH"
}

@test "resolve_current_script_path: no script file when the script comes from a pipe" {
  run bash -c 'cat "$1" | bash -s -- --version' _ "$INSTALL_SCRIPT"
  [ "$status" -eq 0 ]
  # The version of a piped run is a version number, never the name of a file.
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "the version header, the global command and --version agree" {
  header="$(sed -n '2s/^# songbird-deploy-version: //p' "$INSTALL_SCRIPT")"
  [ -n "$header" ]
  run bash "$INSTALL_SCRIPT" --version
  [ "$status" -eq 0 ]
  [ "$output" = "$header" ]
}
