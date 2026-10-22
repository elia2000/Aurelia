import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Text for a screen-reader-only status line: `say("Microphone muted")` makes it
 * read out, however the change was made (a key press does not move the focus to
 * the button whose label changed). The text clears itself, and saying the same
 * thing twice is read out twice.
 * @returns {[string, (message: string) => void]}
 */
export function useAnnouncer(clearAfterMs = 4000) {
  const [text, setText] = useState("");
  const timers = useRef([]);
  const say = useCallback(
    (message) => {
      timers.current.forEach(clearTimeout);
      // Cleared first, so that a message identical to the last one is a change again.
      setText("");
      timers.current = [setTimeout(() => setText(message), 60), setTimeout(() => setText(""), clearAfterMs)];
    },
    [clearAfterMs],
  );
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return [text, say];
}
