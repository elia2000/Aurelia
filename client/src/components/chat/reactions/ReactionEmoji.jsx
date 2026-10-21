import { EMOJI_IMAGE_BASE, emojiFilename } from "../../../emoji/emojiImages.js";

/**
 * One emoji as the Apple-style picture the rest of the app uses. Where the
 * picture is missing the browser shows the alt text, which is the emoji itself.
 */
export default function ReactionEmoji({ emoji, size = 16, className = "" }) {
  return (
    <img
      className={`emoji ${className}`}
      alt={emoji}
      src={`${EMOJI_IMAGE_BASE}${emojiFilename(emoji)}`}
      draggable="false"
      width={size}
      height={size}
      style={{ width: size, height: size, margin: 0, verticalAlign: "middle" }}
    />
  );
}
