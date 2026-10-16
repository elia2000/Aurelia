/* global __BUILD_ID__ */
// The id of this client build, stamped in by Vite (see vite.config.js). The
// server reports the id of the build it is serving; a page that was loaded
// before the latest build asks to be reloaded instead of running old code.
export const CLIENT_BUILD_ID = typeof __BUILD_ID__ === "undefined" ? "" : String(__BUILD_ID__);

/** True only when both builds are known and differ. */
export function isStaleBuild(clientId, serverId) {
  const client = String(clientId || "");
  const server = String(serverId || "");
  return Boolean(client && server && client !== server);
}
