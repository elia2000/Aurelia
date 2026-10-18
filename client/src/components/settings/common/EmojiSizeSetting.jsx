import { memo, useId } from "react";
import { EMOJI_IMAGE_BASE, MAX_JUMBO_EMOJI, emojiFilename } from "../../../emoji/emojiImages.js";
import { EMOJI_SIZE_CHOICES, setEmojiSize } from "../../../emoji/emojiSize.js";
import { useEmojiSize } from "../../../hooks/useEmojiSize.js";

const SAMPLE = "😀";

/**
 * How big a message of only a few emoji is drawn: Large, Medium or Normal (the
 * size of the text). Each choice shows a sample emoji at its own size, drawn
 * with the same rules as in a chat. The choice applies at once and is
 * remembered on this device.
 */
const EmojiSizeSetting = memo(function EmojiSizeSetting({ variant = "desktop" }) {
  const size = useEmojiSize();
  const name = useId();
  const isMobile = variant === "mobile";

  return (
    <fieldset className="border-t border-emerald-100/70 pt-4 dark:border-emerald-500/20">
      <legend className={`mb-1 font-semibold text-slate-700 dark:text-slate-200 ${isMobile ? "text-xs" : "text-sm"}`}>
        {`Emoji-only messages (up to ${MAX_JUMBO_EMOJI} emoji)`}
      </legend>
      <p className="mb-2 text-[11px] text-slate-500 dark:text-slate-400">
        How big a message of nothing but emoji looks in chats. Longer messages, and messages with text, stay as they are.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {EMOJI_SIZE_CHOICES.map((choice) => (
          <label key={choice.id} data-emoji-size={choice.id} className="block cursor-pointer">
            <input
              type="radio"
              name={name}
              value={choice.id}
              checked={size === choice.id}
              onChange={() => setEmojiSize(choice.id)}
              className="peer sr-only"
            />
            <span
              className={`flex flex-col items-center gap-1 rounded-2xl border border-emerald-200/70 bg-white/90 px-2 py-2 text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 peer-checked:border-emerald-400 peer-checked:bg-emerald-50 peer-checked:ring-2 peer-checked:ring-emerald-300 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400 dark:border-emerald-500/30 dark:bg-slate-900/50 dark:text-emerald-200 dark:hover:bg-emerald-500/10 dark:peer-checked:bg-emerald-500/10 ${
                isMobile ? "text-xs" : "text-sm"
              }`}
            >
              <span className="flex h-16 items-center justify-center" aria-hidden="true">
                <img
                  className="emoji emoji-jumbo"
                  alt={SAMPLE}
                  src={`${EMOJI_IMAGE_BASE}${emojiFilename(SAMPLE)}`}
                  draggable="false"
                />
              </span>
              <span className="font-semibold">{choice.label}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
});

export default EmojiSizeSetting;
