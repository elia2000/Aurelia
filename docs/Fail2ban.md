# Fail2ban

[Fail2ban](https://github.com/fail2ban/fail2ban) reads logs and bans an address in the firewall when it fails too often. For Aurelle it stops a script that guesses passwords, and a client that floods nginx or the call relay with requests.

Aurelle ships the files in `deploy/fail2ban/`. The installer does **not** set fail2ban up for you: copy the files by hand, as below. Use it on a server that is reachable from the internet; on a private network you probably do not need it.

| Jail | Reads | What it bans | On by default |
|---|---|---|---|
| `aurelle-auth` | The app's log (systemd journal of `songbird.service`) | 6 wrong passwords or 2FA codes in 15 minutes | Yes |
| `aurelle-auth-docker` | The app's log in Docker's container logs | Same, for Docker Compose installs | No |
| `aurelle-nginx-4xx` | `/var/log/nginx/access.log` | 200 error responses (400, 403, 404, 405, 408, 414, 429) in a minute | No |
| `aurelle-nginx-limit-req` | `/var/log/nginx/error.log` | 30 requests refused by an nginx `limit_req` rate limit in a minute | No |
| `aurelle-coturn` | The journal of `coturn.service` | 60 call-relay sessions from one address in a minute | No |

:::warning Check the address first

Fail2ban bans **the address that is in the log**. If that is your CDN's or reverse proxy's address instead of the visitor's, one bad visitor gets the whole CDN banned and everybody is locked out. Read [Which address does Aurelle see](#which-address-does-aurelle-see) and do the check at its end before you turn any jail on.

:::

## Install

Fail2ban 0.11 or newer is needed. Debian 12 and Ubuntu 24.04 ship 1.0 and already use the systemd journal and nftables by default.

```bash
sudo apt install fail2ban

cd /opt/songbird          # the folder you installed Aurelle into
sudo cp deploy/fail2ban/filter.d/*.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/aurelle.local /etc/fail2ban/jail.d/aurelle.local
```

Open `/etc/fail2ban/jail.d/aurelle.local` and:

1. Add your own addresses to `ignoreip` (your office, your VPN), so you can never ban yourself.
2. Set `enabled = true` for the jails you want, and `enabled = false` for the ones you do not.
3. Check the `port` lines if you do not use 80 and 443.

Then load it:

```bash
sudo fail2ban-client reload
sudo fail2ban-client status
sudo fail2ban-client status aurelle-auth
```

If a jail shows an error instead, `sudo journalctl -u fail2ban -n 50` says why (usually a log path that does not exist).

## What Aurelle writes to the log

Every wrong password and every wrong 2FA code makes the server print one line to its standard output, which systemd stores in the journal of `songbird.service` and Docker stores in the container log:

```txt
2026-10-23T11:30:25.646Z [auth] auth_failed ip=203.0.113.9 user=b5fcabbe2af0 reason=credentials
```

- `ip` is the visitor's address as the server works it out (next section). When that is not a valid address it says `unknown` and fail2ban ignores the line.
- `user` is a short hash of the account name that was tried. The password and the name are never written, not even for accounts that do not exist. The hash is the same for the same name until the server restarts, so you can see whether one account is being targeted.
- A request that the server itself refuses because of too many earlier failures (HTTP 429) is not logged again, so keep `maxretry` low, as in the file (6), or fail2ban would never see enough lines.

Read them with `sudo journalctl -u songbird | grep auth_failed`, or `docker compose logs songbird | grep auth_failed`.

## Which address does Aurelle see

The server runs with `trust proxy` set to **1**: it believes the **last** entry of the `X-Forwarded-For` header, which is the address the first proxy in front of it (nginx) saw connecting. That is the visitor only if nginx itself talks to the visitor. Checked against the real Express behaviour:

| Setup | Address in the log | What you must do |
|---|---|---|
| nginx from the installer, visitors connect to it directly | The visitor | Nothing. |
| Docker Compose with the bundled nginx | The visitor, **if** `nginx/nginx.conf` sets `X-Forwarded-For` (it does since this version) | Update and run `docker compose up -d` again. Earlier versions did not set the header, so every visitor looked like the nginx container. |
| Behind Cloudflare or another CDN | The CDN's address (nginx sees the CDN as the client) | Make nginx use the real address: see below. |
| A second proxy or load balancer in front of nginx | That proxy's address | Same as for a CDN. |
| The app port is open to the internet and nginx is not used (`BIND_ADDRESS=0.0.0.0`) | Whatever the visitor writes in `X-Forwarded-For` | Do not run it like this: put nginx in front and keep `BIND_ADDRESS=localhost`. Fail2ban cannot be trusted here, since anybody can name any address, yours included. |

### Behind Cloudflare or another CDN

Without extra setup nginx sees only the CDN, so the app, its login limits and fail2ban all see the CDN's address. Tell nginx to take the visitor's address from the CDN's header, but only for connections that come from the CDN's own ranges. For Cloudflare this is the `set_real_ip_from ...` list and `real_ip_header CF-Connecting-IP;` in [Running behind a CDN](./CDN-Setup.md) (step 5). After `sudo nginx -t && sudo systemctl reload nginx`, `$remote_addr` is the visitor, nginx forwards it, and the app, the log line and the nginx access log all carry the visitor's address. For another proxy in front of nginx use `real_ip_header X-Forwarded-For;` with `real_ip_recursive on;` and its address in `set_real_ip_from`.

Even with the right address in the log, a ban in the **server's** firewall does not help against a visitor behind a proxying CDN: the visitor never connects to your server, the CDN does, so the packets that arrive carry the CDN's address. Use the CDN's own firewall or rate-limit rules for visitors, or an action that talks to the CDN (fail2ban ships `cloudflare-token`, which needs an API token; read `/etc/fail2ban/action.d/cloudflare-token.conf` first; not tested here). Without such an action, keep fail2ban for what connects directly: the call relay and SSH. The app's own limit on wrong passwords (HTTP 429) works per visitor address and keeps working once nginx forwards the real address.

### Check it before you enable a jail

1. From a phone on mobile data (not your own network), sign in with a wrong password.
2. Run `sudo journalctl -u songbird -n 5 | grep auth_failed`.
3. `ip=` must be the phone's public address (look it up on any "what is my IP" site). If it is `127.0.0.1`, a Docker address (`172.x`) or a CDN address, fix the setup above first.

## Test the filters

`fail2ban-regex` runs a filter over a log and says how many lines it matched, without banning anything:

```bash
# the app, on the journal
sudo fail2ban-regex systemd-journal /etc/fail2ban/filter.d/aurelle-auth.conf \
  --journalmatch '_SYSTEMD_UNIT=songbird.service'

# the app, on a Docker container log
sudo fail2ban-regex "$(docker inspect --format '{{.LogPath}}' songbird)" /etc/fail2ban/filter.d/aurelle-auth.conf

# nginx
sudo fail2ban-regex /var/log/nginx/access.log /etc/fail2ban/filter.d/aurelle-nginx-4xx.conf
sudo fail2ban-regex /var/log/nginx/error.log nginx-limit-req
```

Add `-v --print-all-matched` to see the matched lines and the address taken from each. After a few wrong logins the first command should list them as matched.

## Unban and allow-list

```bash
sudo fail2ban-client status aurelle-auth                    # who is banned
sudo fail2ban-client set aurelle-auth unbanip 203.0.113.9   # let one address in
sudo fail2ban-client unban 203.0.113.9                      # from every jail
```

To never ban an address, add it to `ignoreip` in `aurelle.local` and run `sudo fail2ban-client reload`. A banned address gets longer bans each time it comes back (`bantime.increment`, up to one week).

## Ports, ufw and Docker

The jails ban in the firewall that fail2ban is set up to use (`banaction`).

- **Debian 12 / Ubuntu 24.04** use nftables by default; nothing to set.
- **ufw**: add `banaction = ufw` to the `[DEFAULT]` section of `aurelle.local`. ufw does not control ports that Docker publishes.
- **Docker Compose**: published ports are routed around the normal INPUT rules, so a ban must go in the `DOCKER-USER` chain. The `aurelle-auth-docker` jail already sets `chain = DOCKER-USER`; do the same for any other jail you use with Docker (`banaction = iptables-multiport` plus `chain = DOCKER-USER`). The jail reads `/var/lib/docker/containers/*/*-json.log` and only reacts to lines with `[auth] auth_failed`. If you use another Docker log driver (journald, for example), point the jail at that instead.

## nginx rate limit (optional)

The nginx configuration the installer writes has **no** rate limit, so the `aurelle-nginx-limit-req` jail has nothing to read until you add one. Put this in its own file; the `http` context is the right place, it applies to every site on the machine and it survives running the installer again (which rewrites the site file):

```nginx
# /etc/nginx/conf.d/aurelle-limits.conf
limit_req_zone $binary_remote_addr zone=aurelle_req:10m rate=20r/s;
limit_req zone=aurelle_req burst=60 nodelay;
limit_req_status 429;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

A page load fetches a few dozen files at once, which the burst of 60 absorbs. nginx writes a refused request to `/var/log/nginx/error.log` as `limiting requests, excess: ... by zone "aurelle_req", client: 203.0.113.9`, which the filter that comes with fail2ban (`nginx-limit-req`) understands. With Docker, put the file into the `nginx` container's `/etc/nginx/conf.d/` and read the container's log instead.

## The call relay (coturn)

The relay is protected first by what it is: credentials are made by the app per user and expire, and `user-quota`, `total-quota` and `max-bps` in its configuration limit what one user can take. A log-based ban is a second layer, and it is weaker than for the web app:

- **coturn does not write the client's address when a login fails.** Checked with coturn 4.6.1: the lines are `check_stun_auth: Cannot find credentials of user <...>` and `incoming packet ... processed, error 401: Unauthorized`, and neither has an address.
- The one line with an address is written when a session ends, and only if coturn runs with `verbose`:

  ```txt
  session 003000000000000003: closed (2nd stage), user <1792791167:mallory> realm <aurelle> origin <>, local 192.0.2.10:3478, remote 203.0.113.9:43994, reason: allocation watchdog determined stale session state
  ```

  A failed login and a normal call end in the same kind of line, so the `aurelle-coturn` jail counts **sessions per address**, with a high limit (60 in a minute), and catches floods, not single wrong passwords.
- Most call-relay traffic is UDP, and a UDP source address can be forged. Somebody who knows your friend's address can make it look like it opened too many sessions. That is why the jail bans only the relay ports and not the whole machine, and why the limit is high.

To use it, add `verbose` to the relay's configuration (`/etc/turnserver.conf`; the installer writes `syslog` there but not `verbose`), restart it with `sudo systemctl restart coturn`, and enable the jail. Re-running the installer rewrites that file, so add the line again afterwards. With Docker, add `- "--verbose"` to the `coturn` command in `docker-compose.yaml`, point the jail at the container's log as above, and change `port` if you use another relay port.

Besides fail2ban, a plain firewall limit on the relay port is the usual protection against a flood. For example with ufw: `sudo ufw limit 3478`.

## How this was checked

The filters were run with `fail2ban-regex` (fail2ban 1.0.2) over real output: the app's lines came from a running Aurelle server and real failed sign-ins, the nginx lines from a running nginx (default `combined` log format, `limit_req`), and the coturn lines from a running turnserver 4.6.1. A full fail2ban server was also started on the app's log and banned the address of seven failed sign-ins that had come in through `X-Forwarded-For`. The systemd-journal and Docker forms of the lines were tested with sample lines in those formats, not against a real journal or Docker daemon.
