# Security Headers

Aurelle sends its browser security headers **itself**, from the Node server. That is why they are identical for every kind of install (Docker, manual, the deployment script with Nginx, Railway/Render) and why you do **not** need to add anything to your Nginx or CDN configuration.

The most important one is the **Content-Security-Policy (CSP)**: a list, sent with every page, of the places the page may load scripts, styles, pictures, media and connections from. If an attacker ever got a piece of script into a page (for example through a bug in message rendering), a strict policy stops the browser from running it or sending your data anywhere.

## What is sent

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | see [the policy](#the-content-security-policy) | Blocks injected script, framing, form hijacking and data leaving to other sites. |
| `X-Content-Type-Options` | `nosniff` | The browser must believe the `Content-Type` of a response (an uploaded file can never be "sniffed" into a script). |
| `X-Frame-Options` | `DENY` | Nobody can put Aurelle in a frame (click-jacking). Same as `frame-ancestors 'none'` for older browsers. |
| `Referrer-Policy` | `no-referrer` | No link or picture request tells another site which page you came from. |
| `Cross-Origin-Opener-Policy` | `same-origin` | A window opened by another site gets no handle on Aurelle's window. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other sites cannot embed Aurelle's API answers, uploads or avatars. |
| `Permissions-Policy` | camera, microphone, display capture, picture-in-picture, fullscreen, autoplay and screen wake lock for the page itself; geolocation, payment, USB, serial, HID, MIDI, motion sensors, topics and idle detection **off** | Calls and recording need the first group; nothing needs the second. |
| `Strict-Transport-Security` | `max-age=15552000` (180 days) | **Only on an HTTPS request.** The browser then refuses plain HTTP for this site. No `includeSubDomains` and no `preload`: those affect other sites on your domain and cannot be undone quickly, so they stay your decision. |

Aurelle also no longer announces `X-Powered-By: Express`.

:::info HTTPS detection

"An HTTPS request" means the connection itself is TLS **or** your reverse proxy sent `X-Forwarded-Proto: https` (the Nginx configs in these docs and the deployment script do). Behind a proxy that does not send it, Aurelle sees plain HTTP and sends no HSTS and no `upgrade-insecure-requests`; the rest of the policy is unaffected.

:::

## The Content-Security-Policy

The policy for a page served at `https://chat.example.com`:

```txt
default-src 'self';
script-src 'self';
script-src-attr 'none';
style-src 'self';
img-src 'self' data: blob:;
media-src 'self' blob:;
font-src 'self';
connect-src 'self' wss://chat.example.com https://api.github.com;
worker-src 'self';
manifest-src 'self';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

| Directive | Meaning |
|---|---|
| `script-src 'self'` | Only script files from Aurelle itself. **No `'unsafe-inline'`, no `'unsafe-eval'`, no hashes.** The one small script that used to sit inside `index.html` (it puts the dark theme on before the first paint, so a dark-theme user never sees a white flash) is now the file `/theme-init.js`. |
| `style-src 'self'` | Only the one built stylesheet. **No inline `<style>` and no `style="..."` attributes in markup.** Aurelle's interface sets its dynamic styles from script through the browser's style object (`element.style.x = ...`), which CSP does not restrict, so `'unsafe-inline'` was never needed. |
| `img-src 'self' data: blob:` | Pictures from Aurelle (uploads, avatars, emoji pictures, link-preview pictures served by your own server), `data:` and `blob:` (the preview of a file before it is sent, a recorded video message). |
| `media-src 'self' blob:` | Audio and video from Aurelle and local recordings. |
| `font-src 'self'` | The fonts are files of Aurelle. |
| `connect-src` | Aurelle's own API, the live connection (`wss://` for this host; older Safari does not count it as "self") and `https://api.github.com`, used by exactly one thing: the admin panel's **Check for updates** button asks GitHub for the newest release from the administrator's browser. |
| `worker-src 'self'` | The service worker (`/sw.js`). The app starts no other workers. |
| `manifest-src 'self'` | The web app manifest. |
| `frame-src 'none'`, `object-src 'none'` | The app embeds nothing. |
| `base-uri 'none'` | An injected `<base>` tag cannot redirect relative links. |
| `form-action 'self'` | A form can only be sent to Aurelle. |
| `frame-ancestors 'none'` | No site may frame Aurelle. |
| `upgrade-insecure-requests` | **Only over HTTPS.** Any stray `http://` sub-resource is fetched over HTTPS instead. |

Calls do not need an entry: WebRTC media goes to your TURN relay and peers outside of CSP, and the call set-up travels over the normal API.

Responses Express itself generates for errors (a plain 404 or a 400 for broken JSON) carry Express's own, even stricter `default-src 'none'` instead; every other security header is still there.

## `CSP_MODE`: enforce, report-only, off

| Value | What happens |
|---|---|
| `enforce` | The policy is enforced. **Default when `APP_ENV=production`** (which is the default of `APP_ENV`). |
| `report-only` | Nothing is blocked. Aurelle sends the same policy under `Content-Security-Policy-Report-Only`, and the browser writes every violation to its console (*DevTools → Console*, "[Report Only] Refused to ..."). |
| `off` | No CSP header at all. Default when `APP_ENV` is anything but `production` (the Vite dev server and tests are not affected by a policy). |

Set it in `.env` (or the container environment) and **restart**:

```bash
CSP_MODE=report-only
```

```bash
# systemd install
sudo systemctl restart songbird
# Docker
docker compose -f docker-compose.yaml up -d
```

`enforce` is the default because the policy is the product of testing the whole app with it on (chat, composer, voice and video messages, calls and screen sharing, emoji, GIFs, link previews, uploads, avatars, the service worker, the admin panel and the install banner raised no violation). `report-only` and `off` are the escape hatch: if a deployment of yours turns out to need something the policy does not allow, you can get the page back in a minute and fix the cause afterwards. The other headers are not affected by `CSP_MODE`.

A value that is none of the three is ignored with a warning in the server log and the default is used.

## Object storage and CDN setups

When `STORAGE_DRIVER=remote`, the **browser** talks to the bucket directly: presigned `PUT` uploads, and downloads, pictures and videos from a presigned URL or from your CDN. So the policy must allow those origins in `img-src`, `media-src` and `connect-src`. Aurelle works them out from your settings, nothing to add:

| Setting | Origin added |
|---|---|
| `STORAGE_ENDPOINT` | its origin, for example `https://<account>.r2.cloudflarestorage.com` |
| `STORAGE_ENDPOINT` with `STORAGE_FORCE_PATH_STYLE=false` and a `STORAGE_BUCKET` | also `https://<bucket>.<endpoint host>` (virtual-hosted style) |
| no `STORAGE_ENDPOINT`, a `STORAGE_BUCKET` and a real `STORAGE_REGION` | the AWS hosts for that region |
| `STORAGE_PUBLIC_URL` (a CDN or custom domain) | its origin, for example `https://media.example.com` |

For anything else (a second CDN host, files that sit on a different domain than `STORAGE_PUBLIC_URL`, a bucket that answers from a redirect to another host) list the origins in `CSP_EXTRA_SOURCES`, **comma-separated**:

```bash
CSP_EXTRA_SOURCES=https://cdn.example.com,https://*.r2.dev
```

Rules, enforced when the server starts:

- Each entry is `scheme://host` with an optional `:port`, scheme `https`, `http`, `wss` or `ws`. `https://*.example.com` (one wildcard label at the front) is allowed.
- **Separate entries with commas.** An entry with a space, a semicolon, a quote, a line break or a path (`https://cdn.example.com/media`), a bare `*`, a bare scheme such as `https:` or `data:`, or a host without a scheme is **ignored**, and the server logs `CSP_EXTRA_SOURCES: ignored ...`. This keeps a typo or a pasted value from adding a directive or a keyword such as `'unsafe-inline'` to the policy.
- The sources are added to `img-src`, `media-src` and `connect-src` only. Scripts, styles, fonts, frames and forms cannot be widened.

The bucket must also allow your site in its own **CORS** rules; that is separate from CSP, see [Object Storage](./Object-Storage.md#cloudflare-r2-s3-cors-configuration-requirements).

:::tip

The media worker (`WORKER_URL`) is contacted by your **server**, never by the browser, so it needs no entry.

:::

## Troubleshooting

### A blank page after upgrading or enabling the policy

1. Open the page, press `F12` and look at the **Console**. A blocked request reads like `Refused to load the image 'https://media.example.com/...' because it violates the following Content Security Policy directive: "img-src 'self' data: blob:"`. The directive and the blocked address say what to allow.
2. To get working again right away, set `CSP_MODE=report-only` (or `off`) and restart. Nothing is blocked, and the console shows what *would* have been.
3. Fix the cause:
   - a CDN or bucket origin → put it in `CSP_EXTRA_SOURCES` (or set `STORAGE_PUBLIC_URL` / `STORAGE_ENDPOINT`), then go back to `enforce`;
   - something injected by a proxy (see below) → switch that feature off at the proxy;
   - an `https://` origin that is spelled with a path, a space or a semicolon → read the server log for `CSP_EXTRA_SOURCES: ignored`.
4. Check the headers the browser really receives: `curl -sI https://chat.example.com/ | grep -i -E 'content-security|strict-transport'`. **Exactly one** `Content-Security-Policy` line must appear.

### Pictures or videos from the bucket do not load, uploads fail

Console: `Refused to connect to 'https://<bucket host>/...'` or `Refused to load media ...`. Same cause: the bucket's origin is not in the policy. It is added automatically from `STORAGE_ENDPOINT` / `STORAGE_PUBLIC_URL`; if your files come from yet another host, add it to `CSP_EXTRA_SOURCES`. If the console shows a **CORS** error instead, the problem is the bucket's CORS rules, not CSP.

### Something a proxy injects is blocked

Cloudflare *Rocket Loader*, *Email Address Obfuscation*, *Web Analytics* (the `beacon.min.js` script), *Auto Minify* of HTML and similar features rewrite pages or add inline script. A strict policy blocks inline script, so the console shows `Refused to execute inline script`. Aurelle works without these features; turn them off for the Aurelle hostname.

### The update check in the admin panel fails

The check calls `https://api.github.com` from your browser. If you changed the policy by hand somewhere in front of Aurelle, or the browser cannot reach GitHub (a restricted network), the button reports *Check failed*. Everything else is unaffected.

### The site is on a subpath

`client/index.html` loads `/theme-init.js` with a root-relative path. Adjust it together with the other hard-coded paths described in [Subpath Hosting](./Subpath-Hosting.md).

## Do not add the same headers in Nginx or your CDN

:::warning Duplicate headers are not harmless

If Aurelle **and** your reverse proxy or CDN each send a `Content-Security-Policy`, the browser enforces **both** and allows only what *both* allow. Whatever is stricter wins, so a policy that is right for Aurelle can be narrowed by a second one into a blank page, and you would not see the cause in Aurelle's settings. Other duplicated headers (`X-Frame-Options`, `Strict-Transport-Security`, ...) are at best noise.

:::

- The Nginx configurations in these docs, the one the deployment script writes and `nginx/nginx.conf` of the Docker setup add **no** security header (only `X-Accel-Buffering` for the live-update stream). Do not paste a "hardening" snippet with `add_header Content-Security-Policy ...`, `add_header X-Frame-Options ...` or similar into them. A test in the repository fails if one of those files gains such a line.
- **Cloudflare**: leave *Transform Rules → Modify Response Header*, *Managed Transforms → Add security headers* and *SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS)* off for the Aurelle hostname, or make sure they do not set a `Content-Security-Policy`. (Cloudflare's HSTS setting is harmless next to Aurelle's, a browser uses the first one, but there is no reason to run two.)
- Other CDNs and WAFs (Arvan Cloud, Fastly, BunnyCDN, AWS CloudFront response-header policies, ModSecurity rules): same rule, no `Content-Security-Policy` of their own for Aurelle.
- If you want a different policy, do not stack one on top: set `CSP_MODE=off` in Aurelle and send your own from the proxy. Then you own it, including the object storage origins above.

## Checking it yourself

```bash
# the headers on the page
curl -sI https://chat.example.com/

# the policy only, one directive per line
curl -sI https://chat.example.com/ | grep -i '^content-security-policy' | tr ';' '\n'

# the page has no inline script or style
curl -s https://chat.example.com/ | grep -c -i -E '<script[^>]*>[^<]|<style'   # expect 0
```

Browsers' own DevTools (*Application → Frames*, *Security*) and tools such as [Mozilla Observatory](https://developer.mozilla.org/en-US/observatory) show the same headers.
