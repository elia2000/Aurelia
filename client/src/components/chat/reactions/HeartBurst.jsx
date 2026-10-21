import { useEffect, useState } from "react";
import ReactionEmoji from "./ReactionEmoji.jsx";
import { HEART_REACTION } from "../../../utils/reactions.js";
import "./reactions.css";

/**
 * A heart that rises over a bubble. Change `burst` (a counter) to play it once;
 * it removes itself when done.
 */
export default function HeartBurst({ burst }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!burst) return undefined;
    setShown(burst);
    const timer = window.setTimeout(() => setShown(0), 820);
    return () => window.clearTimeout(timer);
  }, [burst]);
  if (!shown) return null;
  return (
    <span key={shown} aria-hidden="true" data-heart-burst className="sb-heart-burst">
      <ReactionEmoji emoji={HEART_REACTION} size={54} />
    </span>
  );
}
