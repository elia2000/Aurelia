# Fail2ban files for Aurelle

Filters and jails that ban addresses which guess passwords or flood the server. The full guide (which address Aurelle sees behind nginx or a CDN, Docker and ufw, testing, unbanning) is in [`docs/Fail2ban.md`](../../docs/Fail2ban.md).

```
filter.d/aurelle-auth.conf         failed sign-ins, from the app's `[auth] auth_failed ip=...` log line
filter.d/aurelle-nginx-4xx.conf    a flood of 4xx responses in nginx's access log
filter.d/aurelle-coturn.conf       one address opening many call-relay sessions (needs `verbose` in coturn)
jail.d/aurelle.local               the jails; `aurelle-auth` is on, the others are off until you enable them
```

`nginx-limit-req`, used by the `aurelle-nginx-limit-req` jail, is a filter that ships with fail2ban itself.

## Install (manual; the installer does not do this)

```bash
sudo apt install fail2ban
sudo cp filter.d/*.conf /etc/fail2ban/filter.d/
sudo cp jail.d/aurelle.local /etc/fail2ban/jail.d/aurelle.local
# edit ignoreip and enabled = ... in /etc/fail2ban/jail.d/aurelle.local
sudo fail2ban-client reload
sudo fail2ban-client status aurelle-auth
```

**Before enabling a jail**, sign in with a wrong password from a phone on mobile data and check that `sudo journalctl -u songbird -n 5 | grep auth_failed` shows that phone's public address in `ip=`. If it shows `127.0.0.1`, a Docker address or a CDN address, fix that first (see the guide), or one bad visitor will get your proxy banned.

## Test a filter

```bash
fail2ban-regex /var/log/nginx/access.log filter.d/aurelle-nginx-4xx.conf
fail2ban-regex systemd-journal filter.d/aurelle-auth.conf --journalmatch '_SYSTEMD_UNIT=songbird.service'
```

## The log line

Written by `server/lib/authFailureLog.js` for every wrong password or 2FA code:

```
2026-10-23T11:30:25.646Z [auth] auth_failed ip=203.0.113.9 user=b5fcabbe2af0 reason=credentials
```

`ip` is `req.ip` (the server runs with `trust proxy` = 1), or `unknown` if that is not a valid address; `user` is a keyed hash of the account name (never the name or the password). Tests: `server/test/lib/authFailureLog.test.js` and `server/test/api/authFailureLog.test.js`. If you change the format, change `aurelle-auth.conf` and those tests together.
