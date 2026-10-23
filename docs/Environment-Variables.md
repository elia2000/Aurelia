# Environment Variables

:::tip

You can easily configure most of these variables via the admin panel without touching the `.env` file. Visit [Admin Panel](./Admin-Panel.md) for more information.

:::

You can configure environment variables to customize app behavior.

```bash
cd /opt/songbird
cp .env.example .env
nano .env
```

## Configurable values

| Variable | Type | Default | Description |
|---|---|---:|---|
| `SERVER_PORT` | `integer` | `5174` | API server port. (`PORT` is supported as a legacy fallback.) |
| `CLIENT_PORT` | `integer` | `80` | Nginx listen port (what users connect to). |
| `BIND_ADDRESS` | `string` | `localhost` | Network interface to bind to. Use `localhost` for VPS/private networks to avoid exposing backend when firewall is disabled; use `0.0.0.0` for Docker containers. |
| `DATA_DIR` | `string` | `<project_root>/data` | Absolute path to the data directory (database, uploads, backups). Override this on cloud platforms (Railway, Render, Fly.io) to point at the platform's persistent volume mount. |
| `DB_CLIENT` | `string` | `sqlite3` | Database driver client (`sqlite3` or `postgres`). |
| `POSTGRES_HOST` | `string` | `127.0.0.1` | PostgreSQL database host. |
| `POSTGRES_PORT` | `integer` | `5432` | PostgreSQL database port. |
| `POSTGRES_USER` | `string` | `postgres` | PostgreSQL username. |
| `POSTGRES_PASSWORD` | `string` | `postgres` | PostgreSQL password. |
| `POSTGRES_DB` | `string` | `songbird` | PostgreSQL database name. |
| `POSTGRES_URL` | `string` | `null` | Optional full PostgreSQL connection string URL. |
| `POSTGRES_SSL` | `boolean` | `false` | Enable SSL for PostgreSQL connections. |
| `NODE_EXTRA_CA_CERTS` | `string` | `""` | Absolute path to an additional trusted PEM CA certificate bundle or file (required for managed PostgreSQL databases with custom/self-signed CAs like Aiven or AWS RDS). |
| `REDIS_HOST` | `string` | `""` | Optional Redis host. If set, Aurelle uses Redis for BullMQ background job queues (media processing), session storage, and pub/sub instead of in-process fallback. |
| `REDIS_PORT` | `integer` | `6379` | Optional Redis port. |
| `REDIS_URL` | `string` | `""` | Optional Redis connection URL (e.g. `redis://user:pass@host:port`). |
| `APP_ENV` | `string` | `production` | Server runtime mode (`production` recommended/default). |
| `APP_DEBUG` | `boolean` | `false` | Enable verbose server debug logs in terminal/stdout (`[app-debug]` lines for message send/upload/transcode/metadata events). |
| `SIGN_UP` | `boolean` | `true` | Allow new accounts to be created via the website (`/signup`). (`ACCOUNT_CREATION` is supported as a legacy fallback.) |
| `ADMIN_PANEL` | `boolean` | `true` | Enable the admin panel interface. When `false`, the admin panel is completely disabled and inaccessible. |
| `CSP_MODE` | `string` | `enforce` (`off` when `APP_ENV` is not `production`) | The browser's Content-Security-Policy: `enforce` blocks anything the policy does not allow, `report-only` allows everything but logs each violation in the browser console, `off` sends no CSP header. The other security headers are always sent. Restart to apply. Use `report-only` or `off` to get a broken deployment back while you fix the cause. See [Security Headers](./Security-Headers.md). |
| `CSP_EXTRA_SOURCES` | `string` | `""` | Extra origins the page may load pictures and media from and connect to, **comma-separated**, for example `https://cdn.example.com,https://*.r2.dev`. Origins of `STORAGE_ENDPOINT` and `STORAGE_PUBLIC_URL` are added automatically. An entry with a space, a semicolon, a quote, a path or without `https://`/`http://` is ignored with a warning. See [Security Headers](./Security-Headers.md#object-storage-and-cdn-setups). |
| `FILE_UPLOAD` | `boolean` | `true` | Enable/disable all uploads globally (chat files + avatars). |
| `FILE_UPLOAD_MAX_SIZE_MB` | `integer` | `25` | Per-file upload max size (MB). (`FILE_UPLOAD_MAX_SIZE` is supported as a legacy fallback in bytes.) |
| `FILE_UPLOAD_MAX_TOTAL_SIZE_MB` | `integer` | `75` | Per-message total upload size cap (MB). (`FILE_UPLOAD_MAX_TOTAL_SIZE` is supported as a legacy fallback in bytes.) |
| `FILE_UPLOAD_MAX_FILES` | `integer` | `10` | Max uploaded files in one message. |
| `FILE_UPLOAD_TRANSCODE_VIDEOS` | `boolean` | `true` | Convert uploaded videos to H.264/AAC MP4 and keep only the converted file. Requires `ffmpeg`. |
| `STORAGE_DRIVER` | `string` | `local` | Pluggable storage driver (`local` for local disk, `remote` for remote object storage). See [Object Storage](./Object-Storage.md). |
| `STORAGE_ENDPOINT` | `string` | `""` | S3-compatible service URL (AWS S3, Cloudflare R2, MinIO, ArvanCloud, Wasabi, etc.). |
| `STORAGE_BUCKET` | `string` | `""` | Storage bucket name. |
| `STORAGE_REGION` | `string` | `auto` | Storage bucket region (e.g. `us-east-1`, `eu-central-1`). |
| `STORAGE_ACCESS_KEY_ID` | `string` | `""` | Storage Access Key ID. |
| `STORAGE_SECRET_ACCESS_KEY` | `string` | `""` | Storage Secret Access Key. |
| `STORAGE_PUBLIC_URL` | `string` | `""` | Optional custom CDN domain URL prefix (e.g. `https://cdn.example.com`). |
| `APP_PUBLIC_URL` | `string` | `""` | Public origin(s) of the app UI (comma-separated) allowed to upload straight to the bucket. Auto-detected when empty. |
| `STORAGE_AUTO_CORS` | `boolean` | `false` | Configure bucket CORS for browser uploads automatically. |
| `STORAGE_EXPIRES_IN` | `integer` | `3600` | Expiration time in seconds for presigned URLs. |
| `STORAGE_FORCE_PATH_STYLE` | `boolean` | `true` | Enable path-style URL syntax (`true` recommended for MinIO, R2, ArvanCloud, etc.). |
| `STORAGE_PROXY_URL` | `string` | `""` | Optional HTTP/HTTPS proxy URL for object storage requests. |
| `WORKER_URL` | `string` | `""` | External media processing worker base URL for HTTP push transcoding (e.g. `https://worker.example.com`). |
| `WORKER_PORT` | `integer` | `8080` | Port for the standalone Media Worker service (`worker/`). Aurelle uses this port to construct the default local Media Worker URL (`http://127.0.0.1:8080`) when `WORKER_URL` is omitted. |
| `STORAGE_PROCESSING_MODE` | `string` | `auto` | Media processing workflow mode (`auto`, `local`, `remote`). |
| `STORAGE_PROCESSING_TIMEOUT_MS` | `integer` | `120000` | Total retry timeout in milliseconds when dispatching transcode jobs to the remote worker before falling back to the local worker (in `auto` mode) or failing the dispatch (in `remote` mode). |
| `WEBHOOK_SECRET` | `string` | *(Auto-generated)* | Secret token (`x-songbird-webhook-secret`) to authenticate dispatch and callback requests between Aurelle and the Media Worker. |
| `WEBHOOK_URL` | `string` | `""` | Aurelle public webhook callback URL sent to external workers (e.g. `https://songbird.example.com/api/uploads/webhook/processed`). |
| `STORAGE_ENCRYPTION_MODE` | `string` | `remote` | Storage encryption strategy (`remote` for provider-side SSE-S3, `local` for application-level encryption). |
| `MESSAGE_FILE_RETENTION` | `integer` | `7` | Auto-delete uploaded message files after N days (`0` disables). |
| `MESSAGE_TEXT_RETENTION` | `integer` | `0` | Auto-delete text-only messages after N days (`0` disables). |
| `MESSAGE_MAX_CHARS` | `integer` | `4000` | Max message length. |
| `MAX_REACTIONS_PER_USER` | `integer` | `1` | How many different emoji one person can react with on a single message (`1`-`3`). With `1`, reacting with another emoji replaces the previous one (like Telegram); sending the same emoji again removes it. |
| `MAX_PINNED_MESSAGES` | `integer` | `20` | How many messages can be pinned at once in one chat (`1`-`100`). A chat that is full refuses another pin until one is unpinned. |
| `MAX_PINNED_CHATS` | `integer` | `5` | How many chats one person can pin to the top of their own chat list (`1`-`30`). Pins are private to each person. Someone who already has more keeps them but cannot pin another one until they are under the limit. |
| `MAX_SAVED_GIFS` | `integer` | `50` | How many GIFs one person can keep in their own GIF collection (`1`-`200`). The collection is private to each person and is not touched by message retention. When someone saves another GIF past the limit, their oldest GIF is removed automatically and they are told. Lowering the limit takes effect the next time a person saves a GIF. A GIF can be up to 20 MB, so the most one person can store is `MAX_SAVED_GIFS` × 20 MB (1 GB at the default); keep that in mind on a small disk. Saving a GIF is refused, like any upload, when the server's disk is nearly full. |
| `REMOTE_CHANNEL` | `boolean` | `false` | Enable the server-side Remote Channel worker. |
| `REMOTE_CHANNEL_UI` | `boolean` | `true` | Show Remote Channel settings to channel owners in the UI. When `false`, the section is hidden from regular users (and user API calls are rejected) — only server admins can configure mirroring via the admin panel. |
| `REMOTE_CHANNEL_MEDIA_STREAM` | `boolean` | `true` | Allow channel owners to enable the "Stream Media Files" option in the UI. When `false`, the option is disabled and locked for all channels. |
| `REMOTE_CHANNEL_TELEGRAM_API_ID` | `integer` | `0` | Telegram API ID. |
| `REMOTE_CHANNEL_TELEGRAM_API_HASH` | `string` | `""` | Telegram API hash. |
| `REMOTE_CHANNEL_TELEGRAM_SESSION_STRING` | `string` | `""` | Telegram StringSession. Treat it like a password. |
| `REMOTE_CHANNEL_TELEGRAM_PROXY_URL` | `string` | `""` | Telegram MTProto proxy URL. (`REMOTE_CHANNEL_PROXY_URL` is supported as a legacy fallback.) |
| `REMOTE_CHANNEL_SONGBIRD_PROXY_URL` | `string` | `""` | HTTP/HTTPS proxy for outbound requests from this server to remote Aurelle servers. |
| `REMOTE_CHANNEL_TICK_MODE` | `boolean` | `false` | When `true`, background poll loops stay off so a serverless host can sleep. |
| `REMOTE_CHANNEL_CRON_SECRET` | `string` | *(Auto-generated)* | Shared secret for the tick endpoint. |
| `REMOTE_CHANNEL_POLL_INTERVAL_MS` | `integer` | `5000` | How often the poller checks enabled Remote Channel sources (`1000`-`900000`). |
| `REMOTE_CHANNEL_TELEGRAM_POLL_LIMIT` | `integer` | `50` | Max Telegram posts fetched per poll for each source (`1`-`100`). |
| `REMOTE_CHANNEL_QUEUE_INTERVAL_MS` | `integer` | `1000` | How often the mirror queue worker processes pending remote posts. |
| `REMOTE_CHANNEL_QUEUE_MAX_ATTEMPTS` | `integer` | `10` | Max retry attempts before a queued remote post is marked failed. |
| `REMOTE_CHANNEL_QUEUE_BATCH_SIZE` | `integer` | `10` | Max queued remote posts processed per worker tick (`1`-`50`). |
| `REMOTE_CHANNEL_QUEUE_CONCURRENCY` | `integer` | `3` | How many queued items are processed concurrently per worker tick. Also controls how many sources are polled in parallel. |
| `REMOTE_CHANNEL_QUEUE_STALE_LOCK_MS` | `integer` | `300000` | Age after which an in-progress queue lock is considered stale and can be retried. |
| `CHAT_PENDING_TEXT_TIMEOUT` | `integer` | `300000` | Mark pending text message as failed after this timeout (milliseconds). |
| `CHAT_PENDING_FILE_TIMEOUT` | `integer` | `1200000` | Mark pending file message as failed / XHR timeout for uploads (milliseconds). |
| `CHAT_PENDING_RETRY_INTERVAL` | `integer` | `4000` | Retry cadence for pending sends while connected (milliseconds). |
| `CHAT_PENDING_STATUS_CHECK_INTERVAL` | `integer` | `1000` | How often pending messages are checked for timeout (milliseconds). |
| `CHAT_CACHE_TTL` | `integer` | `24` | Local cache time-to-live for chat lists and message caches (hours). |
| `THEME_DEFAULT` | `string` | `random` | The theme colour people get until they choose one: `random` (the shared colour of the day, from `THEME_PALETTE`), `default` (the built-in green) or one hex colour such as `"#2563eb"` for everybody. Anybody can still pick another colour in *Settings → Appearance*. Also editable in the admin panel (*Appearance*), unless it is set in `.env`. |
| `THEME_PALETTE` | `string` | `""` | Up to 30 hex colours (comma, space or line separated, for example `THEME_PALETTE="#10b981, #2563eb, #db2777"`). **Write the colours in quotes**: in a `.env` file an unquoted `#` starts a comment, so `THEME_PALETTE=#10b981, #2563eb` is read as empty (the same goes for `THEME_DEFAULT`). Everyone can pick their theme colour in *Settings → Appearance*; choosing **Random** gives everybody the same colour of this palette on the same day, moving to the next at midnight UTC. Empty uses a built-in palette of 30 colours. Also editable in the admin panel (*Appearance*). |
| `LINK_PREVIEWS` | `boolean` | `false` | Show a title, description and small picture under messages that contain a link ([Link Previews](./Link-Previews.md)). The **server** fetches the linked page (and its picture) itself, so the people reading a chat never contact the linked site; the site only sees your server's IP address and the fixed `User-Agent: AurelleLinkPreview/1.0`. Only public web servers are fetched (`http`/`https`, ports 80 and 443, no private, loopback, link-local or cloud-metadata addresses, at most 3 redirects, 5 seconds in all, 512 KB of page, 400 KB PNG/JPEG/WebP/GIF picture of at most 2048 × 2048 pixels) and each person is limited to 30 fetches a minute and 300 a day. Off by default; when it is on, each person can still switch it off in *Settings → Appearance*. Also editable in the admin panel (*Client Behavior*), unless it is set in `.env`; applies without a restart. |
| `CHAT_MESSAGE_FETCH_LIMIT` | `integer` | `60` | Max messages requested per chat fetch (initial/latest window). |
| `CHAT_MESSAGE_PAGE_SIZE` | `integer` | `60` | Page size for loading older messages when scrolling to top. |
| `CHAT_LIST_REFRESH_INTERVAL` | `integer` | `20000` | Chats list background refresh interval (milliseconds). |
| `CHAT_HEALTH_CHECK_INTERVAL` | `integer` | `10000` | Connection health check interval (milliseconds). |
| `CHAT_SSE_RECONNECT_DELAY` | `integer` | `2000` | Delay before reconnecting SSE after error (milliseconds). |
| `WS_HEARTBEAT_INTERVAL_MS` | `integer` | `30000` | Frequency of WebSocket heartbeat ping frames sent to clients. |
| `WS_HEARTBEAT_TIMEOUT_MS` | `integer` | `10000` | Grace period before terminating un-responsive WebSocket clients. |
| `CHAT_SEARCH_MAX_RESULTS` | `integer` | `5` | Max users shown in search results. |
| `CHAT_VOICE_WAVEFORM_MAX_DECODE_MB` | `integer` | `5` | Max audio file size (MB) allowed for client-side waveform decode. (`CHAT_VOICE_WAVEFORM_MAX_DECODE_BYTES` is supported as a legacy fallback in bytes.) |
| `CHAT_VOICE_WAVEFORM_MAX_DECODE_SECONDS` | `integer` | `480` | Max audio duration (seconds) allowed for client-side waveform decode. |
| `NICKNAME_MAX_CHARS` | `integer` | `24` | Max nickname length for users and groups. (`NICKNAME_MAX` is supported as a legacy fallback.) |
| `USERNAME_MAX_CHARS` | `integer` | `16` | Max username length for users and groups. (`USERNAME_MAX` is supported as a legacy fallback.) |
| `STORAGE_ENCRYPTION_KEY` | `string` | *(Auto-generated)* | Persistent encryption-at-rest key. Once stored in the database, a different env value is a fatal startup error. Rotate only by re-encrypting old data first. |
| `ADMIN_API_TOKEN` | `string` | *(Auto-generated)* | Authentication token for local admin API endpoints. |
| `VAPID_PUBLIC_KEY` | `string` | *(Auto-generated)* | Web Push public key (required for push notifications). A different env value after the first run is a fatal startup error. |
| `VAPID_PRIVATE_KEY` | `string` | *(Auto-generated)* | Web Push private key (required for push notifications). A different env value after the first run is a fatal startup error. |
| `VAPID_SUBJECT` | `string` | *(Auto-generated)* | Contact for VAPID (email or URL). Used by push providers. |
| `PUSH_PROXY_URL` | `string` | `""` | Proxy URL for push notification delivery. Use when your server cannot directly reach push service endpoints. |

:::info

**Push notifications require HTTPS** (except `localhost` for development). iOS requires an installed PWA (iOS 16.4+).

:::

:::info

**Encryption at rest:** Aurelle auto-generates `STORAGE_ENCRYPTION_KEY` on first run and saves it into `.env`. Keep that value stable. On startup, the server backfills existing stored messages, message-upload files, and avatar files into encrypted form when needed.

:::

## Theme colour and readability {#theme-colour}

`THEME_DEFAULT`, `THEME_PALETTE` and *Settings → Appearance* accept **any** colour, so Aurelle checks every one of them before it paints with it. The pairs of colours the interface really puts together (white text on buttons, badges and the unread counter, accent text and chips on white, on the light-tinted areas and on the dark panels, text in your own message bubbles, focus rings, icons and dots, the encrypted chip on the call screen over a dark video and over the brightest frame a video can show) are measured against the WCAG minimums, in light **and** dark mode: **4.5:1 for text, 3:1 for icons, rings and the bold label on a filled button**. The one softer rule is a 2:1 floor for the white label on the lighter hover fill of a button, a momentary pointer-only state.

- A colour that already passes is used exactly as it is.
- A colour that does not (a bright yellow, cyan or white, a very dark navy or black) is **eased**: only its lightness changes, in small fixed steps, only for the shades that fail, and its hue stays. So the colour you pick can look a little deeper or lighter in the app than the swatch you picked it from; the swatches in *Appearance* already show the eased colour.
- Easing is a plain function of the colour, never of the day, the device or the order of choices. It works in OKLCH: a shade that fails a pair moves in fixed steps of 0.004 lightness until every pair it belongs to clears its minimum with a small margin, and the shades stay in order from 50 to 950. The same colour gives the same shades everywhere, and with **Random** everybody still shares the colour of the day.
- The built-in green follows the same rules, so it reads like any other accent.

In the interface the shades have fixed jobs: **500** is for fills, icons and dots (never for text), accent text uses **600/700** on light surfaces and **200 to 400** on dark ones, and keyboard focus rings use **500** (300 or 400 on the always-dark call screen). The white label on a **500** fill is held to 3:1 (the floor for bold labels and UI components); a small badge such as the unread counter uses the stronger **600** fill and gets 4.5:1. Links and mentions in messages are a fixed blue (dark on light surfaces, light on dark ones); in your own bubble, whose colour follows the accent, they take the bubble's text colour and stay underlined. The soft halo around a focused text field and the decorative borders are not part of the audit.

The audit table lives in `client/src/utils/themeContrast.js`; `client/test/utils/themeContrast.test.js` runs all 30 palette colours and about 200 more (every hue, extreme lightness and saturation, `#fff`, `#000`, `#ff0`, `#0ff`) through it. When you add a new accent-coloured combination to the interface, add its pair to that table.

## Calls

Settings for [voice and video calls](./Calls-and-Video-Messages.md). They are read by the server at request time; a restart is needed after editing `.env`.

| Variable | Type | Default | Description |
|---|---|---:|---|
| `CALLS_ENABLED` | `boolean` | `true` | Turn calling on or off for everyone. When off, the call buttons are hidden. |
| `CALLS_TURN_URLS` | `string` | `""` | Comma-separated `stun:`, `turn:` or `turns:` URLs of your relay, for example `stun:turn.example.com:3478,turn:turn.example.com:3478`. Every `turn:` address is also offered over TCP (see `CALLS_TURN_TCP_FALLBACK`). |
| `CALLS_TURN_SECRET` | `string` | `""` | The relay's `static-auth-secret`. Short-lived per-user credentials are derived from it. Without it no relay is offered. |
| `CALLS_TURN_CREDENTIAL_TTL_SECONDS` | `integer` | `21600` | Lifetime of the relay credentials, in seconds. Values below 60 are ignored and the default (21600, six hours) is used. Keep it longer than your longest calls. |
| `CALLS_STUN_URLS` | `string` | `""` | Optional extra STUN servers. Empty by default so peer IP addresses are not sent to a third party. |
| `CALLS_TURN_TCP_FALLBACK` | `boolean` | `true` | Also offer every `turn:` address of `CALLS_TURN_URLS` over TCP (an address with no transport, or with `transport=udp`, gets a `transport=tcp` twin). VPNs, proxies and censored networks often carry only TCP, and without a TCP address a call between such devices stays on *Connecting…*. Set to `false` to use the URLs exactly as written. |
| `CALLS_FORCE_RELAY` | `boolean` | `false` | Send **all** call media through the relay so the two people never learn each other's IP address. Needs a working relay: without one, calls are **refused** (a warning is logged at start-up) rather than falling back to a direct connection. |
| `CALLS_TURN_EXTERNAL_IP` | `string` | `""` | Bundled coturn only: the server's public IPv4 address. **Required** for the bundled relay; it will not start without it. |
| `CALLS_TURN_REALM` | `string` | `aurelle` | Bundled coturn only: the realm. |
| `CALLS_TURN_PORT` | `integer` | `3478` | Bundled coturn only: listening port. |
| `CALLS_TURN_MIN_PORT` / `CALLS_TURN_MAX_PORT` | `integer` | `49160` / `49260` | Bundled coturn only: UDP relay port range. Open it in your firewall. |
| `CALLS_TURN_USER_QUOTA` | `integer` | `6` | Bundled coturn only: concurrent relay allocations per user. |
| `CALLS_TURN_TOTAL_QUOTA` | `integer` | `200` | Bundled coturn only: concurrent relay allocations in total. |
| `CALLS_TURN_MAX_BPS` | `integer` | `262144` | Bundled coturn only: bandwidth cap per session, in bytes per second. |

## Apply Changes

:::tip

You can easily edit your .env file via the [Deployment Script](./Deployment-Script.md) and it would automatically apply and rebuild the app for you!

:::

**1. Docker deployment:**

```bash
cd /opt/songbird
# Apply updated runtime env vars from .env
docker compose -f docker-compose.yaml up -d --force-recreate songbird
```

If your change affects build-time client values, rebuild the image too:

```bash
cd /opt/songbird
docker compose -f docker-compose.yaml up -d --build --force-recreate songbird
```

**2. Manual (systemd) deployment:**

Rebuild client:

```bash
cd /opt/songbird/client
npm run build
```

Restart systemd service:

```bash
sudo systemctl restart songbird
```

**3. Reload Nginx:**

```bash
sudo systemctl reload nginx
```
