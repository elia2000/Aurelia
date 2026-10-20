# Deployment Script

The deployment script (`songbird-deploy`) is the recommended way to install and manage Aurelle. It is an interactive, menu-driven tool that handles dependencies, builds, Nginx, SSL certificates, environment configuration, database management, and updates, so you do not have to run those steps by hand.

:::info

The script targets Ubuntu (22.04+) and needs root privileges (it uses `sudo` automatically when not run as root). For Docker-based or fully manual setups, see [Install via Docker](./Installation-Docker.md) and [Manual Installation](./Manual-Installation.md).

:::

## First run

Run the one-liner on your server:

```bash
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | bash
```

This downloads the script, opens the menu, and installs a global `songbird-deploy` command. From then on, launch it anytime with:

```bash
songbird-deploy
```

## Unattended install

The one-liner above opens the menu, which needs a terminal. For provisioning scripts, cloud-init, CI, or `ssh host 'curl ... | bash'` (no `-t`) there is a mode that asks nothing: every answer comes from a flag, an `AURELLE_*` variable, or a default.

```bash
# On the server IP, over HTTP
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | sudo env AURELLE_YES=1 bash

# On a domain, with a Let's Encrypt certificate
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | sudo env AURELLE_YES=1 AURELLE_DOMAIN=chat.example.com AURELLE_EMAIL=you@example.com bash

# The same with flags instead of variables
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | sudo bash -s -- --yes --domain chat.example.com --email you@example.com
```

`sudo env` is what hands the variables to the script (`sudo` drops them otherwise). As root, leave `sudo` out. Without `AURELLE_YES` and without a terminal the script stops at once (exit code 2) and prints this command instead of waiting for answers nobody can give.

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `AURELLE_YES` | `-y`, `--yes` | `0` | Turn unattended mode on. |
| `AURELLE_DOMAIN` | `--domain` | empty | Comma-separated domain names. Empty serves on the server's public IP. |
| `AURELLE_EMAIL` | `--email` | empty | Contact for Let's Encrypt and push notifications. Without it certbot registers without an email (no expiry notices). |
| `AURELLE_TLS` | `--tls` | `auto` | `auto` (HTTPS for a domain, HTTP for a bare IP), `certbot`, `selfsigned`, `files`, `http`. |
| `AURELLE_TLS_CERT`, `AURELLE_TLS_KEY` | `--tls-cert`, `--tls-key` | empty | `fullchain.pem` and `privkey.pem` for `AURELLE_TLS=files`. |
| `AURELLE_PUBLIC_IP` | `--ip` | detected | The server's public IPv4, when it cannot be detected (NAT, no outbound access). |
| `AURELLE_SERVER_PORT`, `AURELLE_WORKER_PORT` | `--server-port`, `--worker-port` | `5174`, `8080` | Ports of the app and of the media worker. |
| `AURELLE_CLIENT_PORT` | `--client-port` | `80` (`443` with TLS) | Port nginx listens on. |
| `AURELLE_CALLS_RELAY` | `--calls-relay`, `--no-calls-relay` | `1` on a new install | `1`, `0` or `force`. See [Calls relay](#calls-relay). |
| `AURELLE_DB` | none | `sqlite3` | `sqlite3` or `postgres` (with `AURELLE_POSTGRES_URL`, or a local PostgreSQL). |
| `AURELLE_OWNER_USERNAME`, `AURELLE_OWNER_PASSWORD`, `AURELLE_OWNER_NICKNAME` | none | empty | Create the first owner account. Without them the summary says how to create it. |
| `AURELLE_ACTION` | `--action` | `auto` | `auto` installs, or updates when Aurelle is already installed; `install` or `update` forces one. |
| `REPO_BRANCH` | `--branch` | the repository's default branch | Branch or tag to install and follow on updates. |
| `REPO_URL` | `--repo` | the official repository | Git address to install from. |
| `AURELLE_BACKUP` | none | `0` | `1` backs up the database before an update. |
| `AURELLE_RESTORE_BACKUP` | none | empty | Database backup file to restore on a new install. |
| `AURELLE_APT_LOCK_WAIT`, `AURELLE_HEALTH_TIMEOUT`, `AURELLE_MIN_FREE_DISK_MB` | none | `300`, `90`, `2048` | Seconds to wait for another apt, seconds to wait for the app to answer, free disk needed in MB (`0` skips the check). |

Run `bash install.sh --help` for the complete list, including the `MIRROR_*` variables for restricted networks.

Values are checked before anything is changed, and a wrong one stops the script with exit code 2 and a message that names the variable. Nothing you pass is ever run as a command or added to a generated file as a new line:

- `AURELLE_DOMAIN`: host names only (letters, digits, hyphens, dots). `AURELLE_PUBLIC_IP`: an IPv4 address.
- `AURELLE_EMAIL`: letters, digits and `. _ + -` before the `@`, a host name after it. Characters such as `; | $ % # & < > ' "` are refused.
- `AURELLE_POSTGRES_URL`: starts with `postgres://` or `postgresql://` and has no space, line break, quote, backtick or backslash. Write special characters of the password as `%XX` (for example `@` as `%40`).
- Ports (`AURELLE_*PORT`): whole numbers from 1 to 65535. For the relay the minimum must be below the maximum.
- `REPO_BRANCH`: letters, digits and `. _ - / +` only; `REPO_URL` must not start with `-`.
- `AURELLE_OWNER_*`: no line breaks or control characters.

What it does for you:

- Waits for another package manager (a new cloud server runs `apt` by itself for several minutes after its first boot), retries a dropped download, and checks free disk space and memory before changing anything.
- Installs dependencies with `npm ci` (exactly what the lock files say), requires Node.js 24.18 or newer, and keeps the previous client build until the new one exists.
- Stops with a clear message when a step fails (exit code 1). Every step can be repeated: fix the cause and run the same command again.
- Never clears the screen and never prints secrets to the log (`/opt/songbird/logs/install.log` hides tokens, keys and passwords). The summary with the address to visit stays at the end of the output.
- Keeps the site working when the certificate cannot be issued: Aurelle runs over HTTP and the script exits with code 3. The domain must point at the server and port 80 must be open; fix that and run the same command again.

**Exit codes:** `0` done, `1` a step failed, `2` wrong usage or no terminal to ask on, `3` installed, but the TLS certificate could not be issued.

:::tip First admin account

Registering in the browser and claiming the owner role at `/admin` needs HTTPS. On a plain HTTP install, set `AURELLE_OWNER_USERNAME` and `AURELLE_OWNER_PASSWORD`, or create the owner from the menu (**Manage Database**, **Create user**, role `owner`).

:::

## Calls relay (coturn) {#calls-relay}

Calls between people on different networks (mobile data, strict firewalls) need a relay. A fresh unattended install sets one up by default; the interactive install asks (default yes), and menu option 10 sets it up on an installed server. The step:

1. Installs `coturn` from apt and writes `/etc/turnserver.conf` (mode `640`, group `turnserver`). The file starts with `# Managed by the Aurelle installer` and follows [Calls & Video Messages](./Calls-and-Video-Messages.md): short-lived credentials from one shared secret, private networks and the server itself denied as relay targets, per-user quotas.
2. Writes the matching `CALLS_TURN_URLS` and `CALLS_TURN_SECRET` to the app's `.env` (the same secret on both sides) and restarts Aurelle.
3. Opens the relay ports in `ufw` or `firewalld` when one is active. It never switches a firewall on.
4. Tests the relay from the server with `scripts/check-relay.sh`. A failed test is a warning, not a failed install: the rest of Aurelle works and the output says what to check.

The relay address is the domain when it points straight at the server, and the server IP otherwise (behind Cloudflare's orange cloud a name resolves to Cloudflare, which never carries TURN). With a domain and a certificate, the relay also listens with TLS on `5349` (`turns:`); the certificate is copied to `/etc/coturn/certs` and a certbot deploy hook refreshes it after each renewal.

`AURELLE_CALLS_RELAY` values: `1` set it up, `0` skip it, `force` replace a coturn configuration that this installer did not write (the old file is kept as `/etc/turnserver.conf.bak.<timestamp>`). Without `force`, a coturn that somebody else configured, or a `CALLS_TURN_URLS` already set in `.env`, is left alone. When the variable is not set, an update does not install a relay behind its owner's back; to add one later: `sudo env AURELLE_CALLS_RELAY=1 songbird-deploy --yes`. Ports can be changed with `AURELLE_RELAY_PORT` (default `3478`), `AURELLE_RELAY_MIN_PORT` and `AURELLE_RELAY_MAX_PORT` (default `49160`-`49260`).

## Firewall ports

The script opens ports only in an active `ufw` or `firewalld`. A cloud provider's own firewall (security group) is outside its reach: open these there yourself.

| Port | Protocol | Used for |
|---|---|---|
| `80` | TCP | The site over HTTP, the HTTPS redirect and certificate checks. |
| `443` | TCP | The site over HTTPS (domain, or `AURELLE_TLS` other than `http`). |
| `3478` | TCP and UDP | Calls relay (STUN and TURN). |
| `49160`-`49260` | UDP | Calls relay media. |
| `5349` | TCP and UDP | Calls relay over TLS (`turns:`), only when the relay has a certificate. |

The app (`5174`) and the media worker (`8080`) listen for nginx and each other and do not need to be reachable from outside.

## Main menu

| Option | Action | Description |
|---|---|---|
| 1 | 📥 Install Aurelle | Full guided install: dependencies, build, Nginx, SSL, and `.env`. |
| 2 | 🔄 Update Aurelle | Update to latest version or downgrade to a specific version, rebuild, and restart (optional pre-update backup). |
| 3 | ♻️ Restart Aurelle | Restart the `songbird.service`. |
| 4 | ⚙️ Edit Settings (.env) | Change ports, uploads, retention, sign-up, and other env values, then rebuild/apply. |
| 5 | 🗃️ Manage Database | Open the database submenu (see below). |
| 6 | 🗑️ Remove Aurelle | Uninstall Aurelle, optionally removing the global command. |
| 7 | 🔄 Update menu | Check GitHub for newer script versions and update the global command (or reinstall current). |
| 8 | 🌐 Configure mirrors | Set NodeSource, apt, and npm registry mirrors for restricted networks. |
| 9 | 📋 View Logs | Open the logs submenu (script, service, Nginx access/error). |
| 10 | 📞 Calls relay (coturn) | Install or refresh the voice and video calls relay (see [Calls relay](#calls-relay)). |
| 0 | 🚪 Exit | Leave the menu. |

## Installation flow

When you choose **Install**, the script walks you through a series of prompts:

### 1. Source mode

| Mode | Description |
|---|---|
| GitHub | Clone the project from the official GitHub repository. |
| Offline | Install from a local source zip (useful for air-gapped servers). |

### 2. Deploy mode

| Mode | Description |
|---|---|
| Domain | Serve Aurelle on a domain name (e.g. `example.com`). |
| IP | Serve Aurelle directly on the server's public IP. |

### 3. Certificate mode

| Mode | Description |
|---|---|
| Obtain certificate | Automatically request a certificate. For domains this uses Certbot (Let's Encrypt); for IPs it requests a short-lived 6-day certificate via `lego`. |
| TLS certificate files | Use your own existing `fullchain.pem` and `privkey.pem`. |
| HTTP only | Skip TLS and serve over plain HTTP. |
| Self-signed certificate | Generate a self-signed certificate. Not recommended. |

:::info

HTTPS is required for push notifications (except on `localhost`). Choose a certificate mode other than HTTP only if you want push to work.

:::

### 4. Database engine selection

| Option | Description |
|---|---|
| SQLite (Default) | In-memory SQLite database with debounced disk persistence (`better-sqlite3`). Best for small to medium instances. |
| PostgreSQL | External PostgreSQL database engine. Recommended for larger instances (+500 users). Prompts for PostgreSQL host, port, database name, username, and password. |

### 5. Environment prompts

During install the script asks for core settings and writes them into `.env`:

| Prompt | Env variable | Default |
|---|---|---|
| Server port | `SERVER_PORT` | `5174` |
| Client port | `CLIENT_PORT` | `80` |
| Media worker port | `WORKER_PORT` | `8080` |
| Email for Let's Encrypt notices (certbot mode) | — | — |

Encryption and push keys (`STORAGE_ENCRYPTION_KEY`, `VAPID_*`) are generated automatically. The full list of variables you can tune later lives in [Environment Variables](./Environment-Variables.md).

### 6. First-run owner creation

After installation completes and the service starts, you'll be prompted to create an owner user on first access. This owner account has full admin panel access for managing users, chats, and system settings. See [Admin Panel](./Admin-Panel.md) for details.

## Database submenu

Option **5** opens a full database manager that wraps the [database commands](./Database-Commands.md) with guided prompts, so you do not need to remember flags:

| Group | Actions |
|---|---|
| Inspect | Database summary, chats, users, files |
| Backup & Repair | Backup, restore, vacuum, reset, delete |
| User & Chat Management | Create user, generate users, edit user, ban/unban, create group/channel, add members, edit chat |
| Remote Channels | Configure Remote Channel |
| Destructive Actions | Delete chats, delete users, delete files |
| Help & Navigation | Show help, go back, exit |

## Updating and downgrading

Choose **Update Aurelle** (Option 2) from the menu to update or downgrade your installation:

1. **Database backup**: The script offers to create a timestamped backup before touching application files.
2. **GitHub mode**:
   - **Update**: If the branch or tag the installation follows (`REPO_BRANCH`, otherwise the repository's default branch) has a newer commit, the script moves the checkout to it, installs dependencies (`npm ci`), runs database migrations, rebuilds the client, and restarts services. It asks the source first: if it cannot be reached, nothing is stopped or changed.
   - **Downgrade**: If the repository is already up to date, it prompts `Do you want to downgrade? [y/N]`. If confirmed, you can specify any valid version (semver tag like `v0.11.4`, custom tag, branch, or commit SHA). The script checks out that reference, runs migrations, and rebuilds.
3. **Offline mode**:
   - **Update**: If the `VERSION` file in the provided zip archive is newer than the installed version, it updates files and rebuilds.
   - **Downgrade**: If the archive `VERSION` is the same or lower than the installed version, it prompts for confirmation before downgrading.

### Updating without questions

Running the one-liner again on a server that already has Aurelle updates it (the same as `AURELLE_ACTION=update`), and so does `songbird-deploy --yes` once the global command is installed:

```bash
sudo songbird-deploy --yes
# or, without the global command
curl -fsSL https://raw.githubusercontent.com/elia2000/Aurelia/main/scripts/install.sh | sudo env AURELLE_YES=1 bash
```

- Already at the newest version: nothing is changed (a missing client build or an app that does not answer is repaired, and the services are started again).
- Your `.env` is kept, including settings the installer did not write (such as `CALLS_TURN_URLS`). An update also tightens the `.env` mode to `640` (the file holds the encryption key, the admin token and the relay secret).
- `AURELLE_BACKUP=1` backs up the database first. If the update ends before Aurelle restarts, the script starts the old version again instead of leaving the site down.
- Giving a different domain, TLS mode, or port than the installed one reconfigures the installation (nginx, certificate) instead of only updating it.
- The calls relay is touched only when `AURELLE_CALLS_RELAY` is set.

See [Updating & Downgrading](./Updating.md) for full details and manual alternatives.

## Updating the deployment menu

Choose **Update menu** (Option 7) to check for updates to the `songbird-deploy` script itself:

1. **Check for updates**: The script queries the official GitHub repository to check if a newer version of `scripts/install.sh` is available.
2. **Automatic update**: If a newer version is found, it downloads and replaces the global `songbird-deploy` command (`/usr/local/bin/songbird-deploy`), updating it to the latest version.
3. **Reinstall prompt**: If the menu is already up to date, or if fetching from GitHub fails (such as in restricted network environments), it prompts:
   ```txt
   Do you want to reinstall the current menu again? [y/N]
   ```
   Selecting `yes` reinstalls the global command using the existing local script.

## Mirrors for restricted networks

If your server has limited access to default package sources, use **Configure mirrors** to set:

| Mirror | Purpose |
|---|---|
| NodeSource mirror | Alternate source for the Node.js apt setup. |
| apt mirror source | Extra apt mirror for base packages. |
| npm registry mirror | Alternate npm registry for installing dependencies. |

You can also restore defaults (clear all mirrors) from the same menu.

:::tip

You can use these mirrors in Iran's restricted environment:
- NodeSource:
```
https://mirror-nodejs.runflare.com/dist/v24.18.0/node-v24.18.0-linux-x64.tar.gz
```
- APT:
```
http://ubuntu.pars.host/ubuntu/
```
- NPM:
```
https://package-mirror.liara.ir/repository/npm/
```

:::

## Logs

The **View Logs** submenu surfaces the most useful logs without remembering paths:

| Option | Source |
|---|---|
| Script logs | The installer's own log at `/opt/songbird/logs/install.log`. |
| Service logs | `journalctl` output for `songbird.service`. |
| Nginx access logs | Nginx access log. |
| Nginx error logs | Nginx error log. |

For more on diagnosing problems, see [Troubleshooting](./Troubleshooting.md).
