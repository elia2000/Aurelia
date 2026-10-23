# Account Security

Two things protect your Aurelle account beyond the password: you can **see and end every sign-in** (active sessions), and you can add a **second step** with an authenticator app (two-factor authentication, 2FA). Both live in **Settings → Security**, in the desktop dialog and in the mobile panel.

:::tip

Two-factor authentication is **optional** and per person. It needs nothing from the administrator except that the server has its normal secret key (`STORAGE_ENCRYPTION_KEY`, created on first start). There is **no email recovery** in Aurelle: read [If you lose your authenticator](#if-you-lose-your-authenticator) before you turn it on.

:::

## Active sessions

**Settings → Security → Active sessions** lists every browser or app that is signed in to your account:

- **This device** is always first and has a **This device** badge. It has no *Sign out* button (use **Log out** in the menu).
- Every row shows the **browser and system** ("Firefox on Linux"), **when it was last active** ("5 minutes ago", "yesterday"), **when it signed in**, and how it signed in (password, password and code, recovery code, or when the account was created).
- **Sign out** next to a row ends that session. **Sign out all other devices** (it asks first) ends every session except this one.

### What happens to a device you sign out

Signing a session out takes effect **at once**, not at the next refresh:

| What | Result |
|---|---|
| The session | Deleted. Every request that browser sends from now on is answered **401 Not authenticated**. |
| Live connection | The browser's open realtime connection (SSE or WebSocket) is told it was signed out and then **closed**, so it stops receiving messages immediately. |
| The browser | If it is open it lands on the **sign-in page** with a note: *You were signed out from another device.* |
| Push notifications | The notification subscriptions that browser registered are **removed**, so it stops getting notifications. |
| Encryption key | The end-to-end encryption **device key** that browser registered is **revoked** (see [Encryption Protocol](./E2EE-Protocol.md)). Other people stop encrypting new video messages for it. If that browser signs in again it registers a fresh device key. |

A normal **Log out** on a device ends only that session and removes its push subscriptions; it keeps the device key, because the same browser signs in again as a matter of course.

Other things that end sessions the same way:

- **Changing your password** signs out **all your other devices** (this one stays). The password form says nothing extra; the other devices land on the sign-in page.
- An **administrator banning you**, **resetting your password** or **resetting your two-factor** ends all your sessions. Deleting the account ends them too.
- A session is also **valid for 14 days** from sign-in (the lifetime of the cookie). After that it is rejected by the server and removed, even if somebody kept a copy of the cookie.

### Privacy: what a session remembers

A session stores **the browser family and the operating system only** ("Chrome on Android"), taken from your browser's `User-Agent` header at sign-in. It stores **no IP address**, no version numbers and not the raw header. Aurelle shows no location: a truncated IP is still personal data, there is no GeoIP database in a self-hosted install, and a vague guess would add little. Rate limiting uses the IP in memory only and never writes it to the database. (The optional fail2ban log is a separate, opt-in feature; see the administrator's notes.)

The list is only ever **your own** sessions. Asking to sign out somebody else's session, or one that does not exist, gives the same "Session not found" answer.

## Two-factor authentication (TOTP)

Aurelle uses the standard **time-based one-time password** (RFC 6238, the same as Google Authenticator, Aegis, 1Password, Bitwarden, Authy ...): 6 digits, every 30 seconds, with a tolerance of one step either way for a slightly wrong clock.

### Turn it on

1. **Settings → Security → Two-factor authentication → Turn on.**
2. Enter your **current password** (asked again so nobody on an unlocked device can switch this on).
3. **Scan the QR code** with your authenticator app, or press **Open in authenticator app**, or type the **setup key** by hand.
4. Enter the **6-digit code** the app now shows and press **Turn on**. Nothing is active until this one code is right.
5. Aurelle shows **10 recovery codes**. **Copy or download them now: they are shown once.** Tick *I saved my recovery codes* and press **Done**.

### Signing in with 2FA

1. Enter your username and password as usual.
2. If the password is right, Aurelle does **not** sign you in yet. It shows **Two-step verification**: enter the current code from your app.
3. You are signed in. The code works **once**: a code (or an older one inside the tolerance window) that was already used is refused.

Limits: you get **5 wrong codes per sign-in attempt**; after that you must enter your password again. The wrong codes of an account also add up across attempts (an account that collects too many is paused for about 15 minutes). The password step itself is rate limited (see below). The step between password and code lasts **5 minutes**.

### Recovery codes

- You get **10** codes, each shaped `XXXXX-XXXXX`. Each works **exactly once**, as a replacement for an authenticator code at sign-in, to turn 2FA off, or to get new recovery codes. Case, dashes and spaces do not matter.
- Aurelle keeps only a **keyed hash** of each code. It cannot show them to you again; **Get new recovery codes** (password and a code) replaces the whole set, and the old codes stop working.
- The Security panel shows how many are left and warns when two or fewer remain.

### Turn it off

**Settings → Security → Two-factor authentication → Turn off** asks for your **password and a code** (an authenticator code or a recovery code). The secret and all recovery codes are deleted.

### Other actions that ask for your code

When 2FA is on, **changing your password** and **deleting your account** ask for the password **and a code** too. The form shows an *Authentication code* field the first time the server asks.

### If you lose your authenticator

1. **You still have a recovery code:** sign in with the password, press **Use a recovery code instead**, enter it. Then turn 2FA off and on again to get a new secret (or just get new recovery codes).
2. **You have neither the app nor a recovery code:** there is no email reset. Ask an **administrator** to reset your two-factor (**Admin panel → Users → Edit user → Two-factor authentication → Reset two-factor**). That removes the secret and the recovery codes and **signs you out everywhere**. Then you sign in with your password only and can set 2FA up again. The administrator cannot see your password and cannot sign in as you; a reset only removes the second step, and it is recorded in the audit log as `user.reset_2fa`.
3. **You are the owner and the only admin:** an admin cannot reset the owner's 2FA, so keep your recovery codes. As a last resort the owner's account can be recovered from the server with the [database commands](./Database-Commands.md).

## How it is protected (for administrators)

- **Secret at rest.** The TOTP secret (160 random bits) is stored **encrypted** with AES-256-GCM. The key is derived (HKDF-SHA-256) from `STORAGE_ENCRYPTION_KEY`, the secret Aurelle already generates on first start and uses for message storage, with a purpose label of its own so it is not the same key that protects messages. The owner's user id is part of the authenticated data, so a database row copied to another user does not decrypt. If `STORAGE_ENCRYPTION_KEY` is missing, 2FA cannot be turned on (it never stores a secret in clear text). **Keep that key:** if it is lost, stored secrets cannot be read and 2FA users need an admin reset (their recovery codes would not work either).
- **Recovery codes** are stored as HMAC-SHA-256 under a key derived from the same secret, so a stolen copy of the database cannot be used to guess them offline. They are single use, spent atomically.
- **Replay protection.** The time step of the last accepted code is stored; a code is accepted only for a **later** step.
- **The challenge.** After a right password the server returns a signed, **5-minute**, single-purpose token (HMAC) instead of a session. It is not a cookie and no other endpoint accepts it. It is burned after one successful use and locked after 5 wrong codes.
- **Constant time.** Codes and tokens are compared in constant time. An unknown username still costs one password hash comparison, so response time does not reveal which accounts exist; the error is the same `Invalid credentials.`.
- **Rate limiting.** Failed password and code checks are limited per IP and account, per account, and per IP (about 8, 30 and 60 failures in 15 minutes) and answer `429 Too many attempts` with `Retry-After`. The same limit protects the password change, account deletion and the 2FA routes, so a stolen session cookie cannot be used to guess the password. State is in memory and per process.
- **Ban state.** A banned account is reported as banned only after the right password; a wrong password gets the normal `Invalid credentials.`.
- **Fresh session id.** Every sign-in creates a new random token (192 bits). A token supplied by the browser is never adopted, and the session the browser held before is removed.
- **Cookie.** `sid` is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 14 days, and `Secure` over HTTPS (when `APP_ENV` is production, the default).
- **Logs.** With `APP_DEBUG` on, request and response bodies are logged **with passwords, codes, recovery codes, challenges and secrets masked**.

### Database

Migration **050** adds `sessions.public_id` (the random id the API shows instead of the token), `user_agent` and `auth_method`, and links push subscriptions and E2EE devices to the session that registered them. Migration **051** adds `user_two_factor` and `user_recovery_codes`. Both are safe to re-run and work on SQLite and PostgreSQL.

## API summary

All routes need a signed-in session unless noted; bodies are JSON.

| Route | Purpose |
|---|---|
| `GET /api/sessions` | Your sessions: `id`, `current`, `device`, `browser`, `os`, `method`, `viaPassword`, `createdAt`, `lastSeenAt`. Never tokens. |
| `DELETE /api/sessions/:id` | Sign one out. `404` if it is not yours. The current one is a normal log out. |
| `POST /api/sessions/revoke-others` | Sign out every session except this one. |
| `GET /api/2fa` | `{ available, enabled, enabledAt, recoveryCodesRemaining }` |
| `POST /api/2fa/setup` | `{ password }` → `{ secret, otpauthUri, ... }` (not active yet) |
| `POST /api/2fa/enable` | `{ code }` → `{ recoveryCodes }` (shown once) |
| `POST /api/2fa/recovery-codes` | `{ password, code or recoveryCode }` → new codes |
| `POST /api/2fa/disable` | `{ password, code or recoveryCode }` |
| `POST /api/login` | No session cookie for a 2FA account: `{ twoFactorRequired: true, challenge }` |
| `POST /api/login/2fa` | `{ challenge, code or recoveryCode }` → signs in (no auth needed) |
| `PUT /api/password`, `POST /api/profile/delete` | With 2FA on they answer `401 { twoFactorRequired: true }` until `code` or `recoveryCode` is sent. |
| `POST /api/admin/users/:id/reset-2fa` | Admin: remove a user's 2FA and end their sessions. |

The administrator's user list also shows a key icon next to people who have 2FA on. See [Admin Panel](./Admin-Panel.md#users-tab).
