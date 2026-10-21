import { normalizeUuid } from "./uuidUtils.js";

/**
 * The server's id of a message row, or null while the server has not
 * acknowledged it. A message the person just sent keeps its temporary id in
 * `id` and gets the real one in `_serverId`, so every request and every
 * lookup that names a message must go through here.
 */
export function serverIdOfMessage(msg) {
  return normalizeUuid(msg?._serverId) || normalizeUuid(msg?.id) || null;
}
