// Where the card of the message menu goes on the screen, and how tall it may
// be. The quick reaction bar sits on top of the card (or under it when there is
// no room above), so the card has to leave that much room; in a window too
// short for both (a phone held sideways) the card scrolls instead of running
// off the screen, and never lies under the bar.

export const MENU_SCREEN_GAP = 12;
const MIN_CARD_HEIGHT = 96;

/**
 * @param {object} params
 * @param {number} params.pointY      where the person pressed
 * @param {number} params.cardHeight  the height the whole card would have
 * @param {number} [params.reserveTop] the bar's height plus its gap (0 for no bar)
 * @param {number} params.viewportHeight
 * @returns {{ y: number, maxHeight: number, below: boolean, scrolls: boolean }}
 */
export function placeMenuCard({ pointY, cardHeight, reserveTop = 0, viewportHeight }) {
  const gap = MENU_SCREEN_GAP;
  const topLimit = gap + reserveTop;
  const maxHeight = Math.max(MIN_CARD_HEIGHT, viewportHeight - gap - topLimit);
  const height = Math.min(cardHeight, maxHeight);
  const below = pointY + height + gap <= viewportHeight;
  let y = below ? pointY : Math.max(gap, pointY - height);
  if (reserveTop > 0 && y < topLimit) {
    // The bar goes above the card, or under it when it fits there.
    const barFitsBelow = y + height + reserveTop + gap <= viewportHeight;
    if (!barFitsBelow) y = topLimit;
  }
  return { y, maxHeight, below, scrolls: cardHeight > maxHeight };
}
