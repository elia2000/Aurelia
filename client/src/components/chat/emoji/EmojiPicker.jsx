import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CATEGORY_ORDER,
  SKIN_TONES,
  addRecent,
  applySkinTone,
  buildEmojiIndex,
  loadRecent,
  searchEmoji,
} from "../../../emoji/emojiData.js";
import { EMOJI_IMAGE_BASE } from "../../../emoji/emojiImages.js";
import GifsPanel from "../gifs/GifsPanel.jsx";
import PickerTabs from "../gifs/PickerTabs.jsx";

const TONE_KEY = "aurelle-emoji-skin-tone";
const TAB_KEY = "aurelle-picker-tab";

const loadTab = () => {
  try {
    return localStorage.getItem(TAB_KEY) === "gifs" ? "gifs" : "emoji";
  } catch (_) {
    return "emoji";
  }
};

const loadTone = () => {
  try {
    const id = localStorage.getItem(TONE_KEY);
    return SKIN_TONES.some((t) => t.id === id) ? id : "default";
  } catch (_) {
    return "default";
  }
};

function EmojiButton({ emoji, onPick }) {
  return (
    <button
      type="button"
      aria-label={emoji.shortName}
      title={`:${emoji.shortName}:`}
      onClick={() => onPick(emoji.char)}
      className="flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:hover:bg-emerald-500/20"
    >
      <img
        className="emoji-pick"
        src={`${EMOJI_IMAGE_BASE}${emoji.image}`}
        alt={emoji.char}
        loading="lazy"
        draggable="false"
        width="26"
        height="26"
        style={{ width: 26, height: 26 }}
      />
    </button>
  );
}

/**
 * Emoji picker like Telegram's: frequently used, categories, search and skin
 * tones, with Apple-style pictures. The (large) emoji data is only fetched when
 * the picker is opened.
 *
 * With `onSendGif` it gets an "Emoji | GIFs" switch; the GIFs tab shows the
 * person's own saved GIFs and sends the one that is tapped.
 */
export default function EmojiPicker({ onSelect, onClose, autoFocusSearch = false, onSendGif = null }) {
  const [index, setIndex] = useState(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(loadTone);
  const [toneMenu, setToneMenu] = useState(false);
  const [recent, setRecent] = useState(() => loadRecent());
  const [savedTab, setSavedTab] = useState(loadTab);
  const scrollRef = useRef(null);
  const rootRef = useRef(null);
  // The menu of a GIF handles Escape itself while it is open.
  const gifMenuOpenRef = useRef(false);

  const gifsEnabled = typeof onSendGif === "function";
  const tab = gifsEnabled && savedTab === "gifs" ? "gifs" : "emoji";

  const chooseTab = useCallback((id) => {
    setSavedTab(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch (_) {
      // not remembered: it still applies until the picker closes
    }
  }, []);

  const sendGif = useCallback(
    (gif) => {
      onSendGif?.(gif);
      onClose?.();
    },
    [onSendGif, onClose],
  );

  const onGifMenuOpenChange = useCallback((open) => {
    gifMenuOpenRef.current = open;
  }, []);

  useEffect(() => {
    let cancelled = false;
    import("emoji-datasource-apple/emoji.json")
      .then((module) => {
        if (!cancelled) setIndex(buildEmojiIndex(module.default || module));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // First in line (capture on window): Escape closes the picker and nothing
    // else, in particular not the open chat.
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (gifMenuOpenRef.current) return; // closes the GIF menu first
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const pick = useCallback(
    (char) => {
      setRecent(addRecent(char));
      onSelect?.(char);
    },
    [onSelect],
  );

  const chooseTone = (id) => {
    setTone(id);
    setToneMenu(false);
    try {
      localStorage.setItem(TONE_KEY, id);
    } catch (_) {
      // not remembered: it still applies until the page closes
    }
  };

  const withTone = useCallback((emoji) => applySkinTone(emoji, tone), [tone]);

  // The pictures the "frequently used" row needs (they are characters).
  const recentEmoji = useMemo(() => {
    if (!index) return [];
    const byChar = new Map();
    for (const category of index.categories) {
      for (const emoji of category.emojis) {
        byChar.set(emoji.char, emoji);
        for (const variation of Object.values(emoji.skins || {})) {
          byChar.set(variation.char, { ...emoji, char: variation.char, image: variation.image });
        }
      }
    }
    return recent.map((char) => byChar.get(char)).filter(Boolean);
  }, [index, recent]);

  const results = useMemo(() => (index && query.trim() ? searchEmoji(index, query).map(withTone) : []), [index, query, withTone]);
  const searching = Boolean(query.trim());

  const currentTone = SKIN_TONES.find((t) => t.id === tone) || SKIN_TONES[0];

  const scrollTo = (id) => {
    const el = scrollRef.current?.querySelector(`[data-emoji-section="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: "start" });
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={gifsEnabled ? "Emoji and GIFs" : "Emoji"}
      className={`flex w-[min(21rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-emerald-200 bg-white text-slate-700 shadow-xl shadow-emerald-950/10 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100 ${
        gifsEnabled ? "h-[24rem]" : "h-[22rem]"
      }`}
    >
      {gifsEnabled ? <PickerTabs value={tab} onChange={chooseTab} /> : null}

      {tab === "gifs" ? (
        <div
          role="tabpanel"
          id="picker-panel-gifs"
          aria-labelledby="picker-tab-gifs"
          className="flex min-h-0 flex-1 flex-col"
        >
          <GifsPanel onSend={sendGif} onMenuOpenChange={onGifMenuOpenChange} />
        </div>
      ) : (
      <div
        {...(gifsEnabled
          ? { role: "tabpanel", id: "picker-panel-emoji", "aria-labelledby": "picker-tab-emoji" }
          : {})}
        className="flex min-h-0 flex-1 flex-col"
      >
      <div className="flex items-center gap-2 border-b border-emerald-100 p-2 dark:border-emerald-500/20">
        <input
          type="search"
          role="searchbox"
          aria-label="Search emoji"
          placeholder="Search emoji"
          value={query}
          autoFocus={autoFocusSearch}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 min-w-0 flex-1 rounded-xl border border-emerald-200 bg-white px-3 text-sm outline-hidden focus:border-emerald-400 focus:ring-2 focus:ring-emerald-300/60 dark:border-emerald-500/30 dark:bg-slate-950"
        />
        <div className="relative">
          <button
            type="button"
            aria-label={`Skin tone: ${currentTone.label}`}
            aria-haspopup="menu"
            aria-expanded={toneMenu}
            onClick={() => setToneMenu((open) => !open)}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-200 hover:bg-emerald-50 dark:border-emerald-500/30 dark:hover:bg-emerald-500/10"
          >
            <img
              className="emoji-pick"
              alt=""
              width="22"
              height="22"
              style={{ width: 22, height: 22 }}
              src={`${EMOJI_IMAGE_BASE}${currentTone.code ? `1f44b-${currentTone.code.toLowerCase()}` : "1f44b"}.png`}
            />
          </button>
          {toneMenu ? (
            <div
              role="menu"
              aria-label="Skin tone"
              className="absolute right-0 top-10 z-10 flex gap-1 rounded-xl border border-emerald-200 bg-white p-1.5 shadow-lg dark:border-emerald-500/30 dark:bg-slate-900"
            >
              {SKIN_TONES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-label={t.label}
                  aria-checked={t.id === tone}
                  onClick={() => chooseTone(t.id)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg hover:bg-emerald-100 dark:hover:bg-emerald-500/20 ${
                    t.id === tone ? "ring-2 ring-emerald-400" : ""
                  }`}
                >
                  <img
                    className="emoji-pick"
                    alt=""
                    width="22"
                    height="22"
                    style={{ width: 22, height: 22 }}
                    src={`${EMOJI_IMAGE_BASE}${t.code ? `1f44b-${t.code.toLowerCase()}` : "1f44b"}.png`}
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div ref={scrollRef} className="chat-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {failed ? (
          <p className="p-4 text-center text-sm text-slate-500">Emoji could not be loaded.</p>
        ) : !index ? (
          <p className="p-4 text-center text-sm text-slate-500" role="status">
            Loading…
          </p>
        ) : searching ? (
          results.length ? (
            <div className="flex flex-wrap">
              {results.map((emoji) => (
                <EmojiButton key={emoji.shortName} emoji={emoji} onPick={pick} />
              ))}
            </div>
          ) : (
            <p className="p-4 text-center text-sm text-slate-500">No emoji found</p>
          )
        ) : (
          <>
            {recentEmoji.length ? (
              <section data-emoji-section="recent">
                <h3 className="px-1 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Frequently used</h3>
                <div className="flex flex-wrap">
                  {recentEmoji.map((emoji) => (
                    <EmojiButton key={emoji.char} emoji={emoji} onPick={pick} />
                  ))}
                </div>
              </section>
            ) : null}
            {index.categories.map((category) => (
              <section key={category.id} data-emoji-section={category.id}>
                <h3 className="px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{category.id}</h3>
                <div className="flex flex-wrap">
                  {category.emojis.map((emoji) => (
                    <EmojiButton key={emoji.shortName} emoji={withTone(emoji)} onPick={pick} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      <div role="tablist" aria-label="Emoji categories" className="flex items-center justify-between border-t border-emerald-100 px-1.5 py-1 dark:border-emerald-500/20">
        {CATEGORY_ORDER.map((id) => {
          const first = index?.categories.find((c) => c.id === id)?.emojis[0];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-label={id}
              aria-selected="false"
              title={id}
              disabled={!first || searching}
              onClick={() => scrollTo(id)}
              className="flex h-8 w-8 items-center justify-center rounded-lg opacity-70 transition hover:bg-emerald-100 hover:opacity-100 disabled:opacity-30 dark:hover:bg-emerald-500/20"
            >
              {first ? (
                <img className="emoji-pick" alt="" width="20" height="20" style={{ width: 20, height: 20 }} src={`${EMOJI_IMAGE_BASE}${first.image}`} />
              ) : null}
            </button>
          );
        })}
      </div>
      </div>
      )}
    </div>
  );
}
