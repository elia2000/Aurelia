# Link Previews

A link preview is a small card under a message that contains a link: the site's name, the page title in bold, two lines of description and, when the page has one, a small picture (Telegram style). Previews are **off by default** and **private by design**: the people reading a chat never contact the linked site, the **server** does.

:::tip

Turn them on with [`LINK_PREVIEWS=true`](./Environment-Variables.md) in `.env`, or with the **Link previews** switch under *Client Behavior* in the [Admin Panel](./Admin-Panel.md). The switch applies without a restart. Until an admin turns it on, nothing in the app changes and `/api/link-preview` answers `404`.

:::

## What people see

- The card sits **under the text** of the message, for the **first link** of the message (as the message shows it). The time moves to its own row below the card.
- Click or tap the card to open the link in a new tab (`rel="noopener noreferrer"`), the same as a link in the text.
- A message gets **no card** when the link is inside a code block, points into Aurelle itself, is an `ftp:`, `mailto:` or other non-web link, or has a user name or password in it. An end-to-end encrypted message, a message that is still sending or has failed, and call and service lines never get one either.
- Edit the link out of a message and its card goes away on every screen. A reply quote never shows a card, only the message itself does.
- The card is **not part of selected or copied text** (see [Selecting Messages](./Selecting-Messages.md)).
- A page that cannot be fetched, is not a web page, or has no title and no description shows **nothing**: the message looks as it always did. Persian pages get a right-to-left card in the Persian font.

### The per-person switch

*Settings → Appearance → **Show link previews*** is shown only when the server has previews on. Until a person chooses, it follows the server (on). The choice is remembered on that device. A person who turns it off sees no cards and their device asks the server for none.

## Privacy

| Who | What they learn |
|---|---|
| The people reading the chat | Nothing about the linked site: their browser only talks to your Aurelle server. The card's picture is served from `/api/link-preview/image/...` on your server, never hot-linked. |
| The linked site | One request from **your server's IP address**, with the fixed `User-Agent: AurelleLinkPreview/1.0`. No cookies, no `Referer`, no request body, no compression asked for. It is not told who looked at the link. |
| Your server | The address of a link goes to it in the body of a `POST` (not in a URL, so it stays out of access logs) when a message with a link comes near the screen. The server already stores the message text. |

Two things follow from "the server fetches":

- **Anybody who can send a message can make your server contact a site** (once per link per day, because answers are cached). That is why the fetcher is strict (below) and why each person is rate limited.
- The server needs to reach the public internet **directly** on ports 80 and 443. It does not use `HTTP_PROXY`/`HTTPS_PROXY`; a server that can only get out through a proxy simply shows no previews.

## How the server fetches a page

Everything that opens a connection lives in one module (`server/lib/linkPreview/guardedFetch.js`), written so a link cannot be used to reach anything but a public web server (SSRF) or to tie the server up:

| Rule | Detail |
|---|---|
| Links | `http` and `https` only, at most 2048 characters, no user name or password, no control characters, **ports 80 and 443 only**. Host names that only mean something on a private network (`localhost`, `.local`, `.internal`, `.lan`, `.home.arpa` ...) are refused without a lookup. Odd spellings of an address (`http://2130706433/`, `http://0x7f.1/`, `http://017700000001/`) are read by the URL parser as the address they really are and judged by it. |
| Addresses | The server resolves the name **itself**, and **every** address it gets must be public. It then connects to that exact address (the socket's own lookup is replaced), so a DNS answer that changes between the check and the connection (DNS rebinding) cannot matter. |
| Refused ranges | IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (carrier-grade NAT), `127/8`, `169.254/16` (link-local and the cloud metadata address `169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, multicast `224/4` and reserved `240/4`. IPv6: everything outside global unicast `2000::/3`, which leaves out `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4, Teredo and documentation ranges. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is judged by the IPv4 address inside. |
| Redirects | At most **3**, and every hop goes through the same checks again (address, port, scheme). A loop is refused. |
| Time | One deadline of **5 seconds** for the **whole preview**: the page and its (up to two) pictures share it, so a site that drips bytes (slow loris) holds a fetch slot for 5 seconds at most, not 5 seconds per request. The host name is looked up with the c-ares resolver (a real 2 second timeout, cancelled the moment the deadline passes), **not** the operating system's thread-pool lookup, which cannot be cancelled: a name server that never answers must not be able to hold up every other name lookup of the server (web push, webhooks, object storage). |
| Page | Only `text/html`, a plain `200`, no compression. At most **512 KB** is read, then the download stops. |
| Reading | A small hardened reader looks only at `<title>` and `<meta>` in the head. It builds no DOM and runs nothing. Text is entity-decoded once, control and bidirectional-override characters are removed, white space is collapsed and the length is limited: title 120, description 240, site name 60 characters. |
| Picture | The `og:image` / `twitter:image` goes through the **same** guarded fetcher. At most **400 KB**, and it must really be a **PNG, JPEG, WebP or GIF** by its first bytes (the `Content-Type` is ignored); its size is read from the header and anything over **2048 × 2048 pixels** (4 megapixels, and at most 10000 on a side) is refused: the card draws the picture 64 px wide, but every reader's browser would still decode all of it. **SVG is never accepted.** It is kept in memory and served by `GET /api/link-preview/image/:id` with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and the type the bytes proved to be. |
| Cache | In memory only, nothing is written to disk and a restart empties it. A result is kept **24 hours**, a failure **1 hour**, so one site is not asked again and again; a timeout, a name that did not resolve or a network error is remembered for only **1 minute**, because that says something about the moment, not about the site. At most 1000 results and 300 pictures (48 MB). Two people asking for the same link at once cause one fetch. At most **8** fetches run at the same time, and one person may have at most **2** of them. |

Whatever goes wrong with a site (blocked address, timeout, wrong type, nothing to show) the person gets the same answer, so a preview cannot be used to find out what is on the server's network.

## Limits per person

| What | Limit |
|---|---|
| Fetching a site that is not in the cache | **30 a minute** and **300 a day** per signed-in person |
| Any preview request, cached or not | 240 a minute |
| Pictures | 300 a minute |
| Fetches running at the same time | **2** per person (8 for the whole server) |

Past the rate limits the server answers `429` and the app shows no cards for a minute. Answers served from the cache do not use up the fetch limits.

When the person (or the server) already has enough previews loading, the answer is `503` `busy` with `Retry-After: 5`: nothing is wrong, nothing is used up, and the app simply asks again later without pausing. The app itself never asks for more than 2 previews at a time.

## API

All of these need a session. They answer `404` (`link_previews_disabled`) while the setting is off.

| Request | Answer |
|---|---|
| `POST /api/link-preview` with `{ "url": "https://..." }` (`GET /api/link-preview?url=` also works) | `200` `{ url, title, description, siteName, image: { url, width, height } \| null }`; `400` `invalid_url` for a link that may not be fetched; `422` `preview_unavailable`; `429` `rate_limited` (this person asks too fast); `503` `busy` (too many previews loading right now, try again shortly) |
| `GET /api/link-preview/image/:id` | The picture, or `404` |

The app uses `POST`, so the address of the link stays out of server and proxy logs.

## For developers

The server tests use injection points instead of the network (`resolve`, `transport` and `fetcher` of `createLinkPreviewService` / `createGuardedFetcher`). For a real-browser check against a page on `127.0.0.1` (blocked on purpose) there is one test hook: `LINK_PREVIEW_ALLOW_PRIVATE_FOR_TESTS=1` lifts the address and port checks, but only when `APP_ENV` is set to something other than `production`; the server treats a missing `APP_ENV` as production, so a real deployment ignores it (a test proves it). Never set it on a server people use.
