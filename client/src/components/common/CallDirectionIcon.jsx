import { ArrowDownLeft, ArrowUpRight } from "../../icons/lucide.js";

/**
 * The small arrow of a call entry or of the chat list line about one: up and
 * to the right for a call I made, down and to the left for one I received.
 */
export default function CallDirectionIcon({ direction, size = 14, className = "" }) {
  const Arrow = direction === "in" ? ArrowDownLeft : ArrowUpRight;
  return (
    <Arrow
      size={size}
      strokeWidth={2.5}
      className={`shrink-0 ${className}`}
      aria-hidden="true"
      data-call-direction={direction === "in" ? "in" : "out"}
    />
  );
}
