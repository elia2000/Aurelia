import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getLinkPreviewPrefs, subscribeLinkPreviewPrefs } from "../../utils/linkPreviewPrefs.js";
import { findPreviewUrl } from "../../utils/linkPreviewUrl.js";
import { loadLinkPreview, peekLinkPreview } from "../../utils/linkPreviewStore.js";
import { useKeepAtBottomOnGrowth } from "./useKeepAtBottomOnGrowth.js";

/** { serverEnabled, choice, enabled }: whether link previews are shown on this device. */
export function useLinkPreviewPrefs() {
  return useSyncExternalStore(subscribeLinkPreviewPrefs, getLinkPreviewPrefs, getLinkPreviewPrefs);
}

// True from the moment the element has come near the screen (and for good
// after that). Without IntersectionObserver there is nothing to wait for.
function useSeenOnce(elementRef, active) {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!active || seen) return undefined;
    const element = elementRef.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, seen, elementRef]);
  return seen;
}

/**
 * The link preview of a message, or null: `{ url, preview }` for the first link
 * in the message's finished HTML.
 *
 * Nothing is asked of the server until the message is near the screen, and a
 * link asked about before (anywhere in this tab) is answered from memory. While
 * the feature is off, for the server or for this person, or on any error, the
 * result is null and the message looks as it always did.
 *
 * @param {object}  options
 * @param {string}  options.html        the message body as shown (see utils/markdown.js)
 * @param {{current: Element|null}} options.elementRef  what to wait for: the message text
 * @param {{current: Element|null}} [options.bubbleRef]  the message bubble: a card that arrives
 *                                      after the message is in place must not push the end of a
 *                                      chat that is scrolled to the bottom out of view
 * @param {boolean} [options.skip]      true for a message that must never get a card
 */
export function useLinkPreview({ html, elementRef, bubbleRef = null, skip = false }) {
  const prefs = useLinkPreviewPrefs();
  const active = prefs.enabled && !skip;
  const url = useMemo(() => (active ? findPreviewUrl(html) : ""), [active, html]);
  const seen = useSeenOnce(elementRef, Boolean(url));
  const [loaded, setLoaded] = useState(null); // { url, preview }
  // Only a message with a link can gain a card, so only those are watched.
  const noRef = useRef(null);
  useKeepAtBottomOnGrowth(bubbleRef || noRef, Boolean(bubbleRef) && Boolean(url));

  useEffect(() => {
    if (!url || !seen || peekLinkPreview(url) !== undefined) return undefined;
    let cancelled = false;
    loadLinkPreview(url).then((preview) => {
      if (!cancelled) setLoaded({ url, preview });
    });
    return () => {
      cancelled = true;
    };
  }, [url, seen]);

  if (!url) return null;
  const known = peekLinkPreview(url);
  const preview = known !== undefined ? known : loaded?.url === url ? loaded.preview : null;
  return preview ? { url, preview } : null;
}
