/**
 * The small "GIF" tag drawn on a picture that moves (top left, like Telegram).
 * It is only a label: it takes no clicks, so the picture below it opens as usual.
 */
export default function GifBadge({ className = "" }) {
  return (
    <span
      aria-hidden="true"
      data-testid="gif-badge"
      className={`pointer-events-none absolute left-1.5 top-1.5 z-10 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-white backdrop-blur-sm ${className}`}
    >
      GIF
    </span>
  );
}
