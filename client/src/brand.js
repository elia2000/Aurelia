// The product name and credits in one place. Internal identifiers (cookie,
// storage keys, event names, Docker images) deliberately keep their original
// "songbird" spelling so existing installations and data keep working.

export const BRAND = Object.freeze({
  name: "Aurelle",
  tagline: "Private self-hosted messaging with end-to-end encrypted calls and video messages",
  repository: "https://github.com/elia2000/Aurelle",
  upstream: Object.freeze({
    name: "Songbird",
    repository: "https://github.com/bllackbull/Songbird",
    license: "MIT",
  }),
});
