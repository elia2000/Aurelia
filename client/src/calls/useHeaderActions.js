import { useCalls } from "./callContext.js";
import { isE2eeSupported } from "../e2ee/support.js";
import { CHAT_PAGE_CONFIG } from "../settings/chatPageConfig.js";

export const HEADER_BUTTON_PX = 32;
export const HEADER_BUTTON_GAP_PX = 6;

/**
 * Which encryption/calling controls the header of a direct chat shows for
 * `peer`, so the title spacer and the buttons always agree.
 */
export function useHeaderActions(peer) {
  const { supported } = useCalls();
  const usable = Boolean(peer?.id) && !peer?.isDeleted;
  const calls = usable && supported && CHAT_PAGE_CONFIG.callsEnabled !== false;
  const verify = usable && isE2eeSupported();
  const count = (calls ? 2 : 0) + (verify ? 1 : 0);
  return {
    calls,
    verify,
    count,
    width: count ? count * HEADER_BUTTON_PX + (count - 1) * HEADER_BUTTON_GAP_PX : 0,
  };
}
