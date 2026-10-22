import { memo, useState } from "react";
import { hasPersian } from "../../../utils/fontUtils.js";

// Telegram-style: a 2px bar in the accent colour, the site's name, the title
// in bold, two lines of description and, when the page has one, a small
// picture. The text is the page's own, so it is always drawn as TEXT.
//
// The picture comes from OUR server (/api/link-preview/image/:id), never from
// the linked site: opening a chat does not tell that site anything. A click
// opens the link in a new tab like any other link of the message, and the card
// is marked data-no-select so it is left out of selected and copied text.
// The keyboard focus ring is the 700 shade (300 in dark mode), not the usual
// 500: it is drawn on a bubble, which on your own side is tinted with the
// accent, and 500 would be about 2:1 there (see "ring-on-bubble" in themeContrast.js).
const TONE = {
  own: {
    bar: "bg-emerald-700 dark:bg-emerald-100",
    site: "text-emerald-800 dark:text-emerald-50/70",
    title: "text-emerald-950 dark:text-white",
    description: "text-emerald-900/70 dark:text-emerald-50/70",
  },
  other: {
    bar: "bg-emerald-500",
    site: "text-emerald-700 dark:text-emerald-300",
    title: "text-slate-900 dark:text-slate-100",
    description: "text-slate-600 dark:text-slate-300",
  },
};

const LinkPreviewCard = memo(function LinkPreviewCard({ url, preview, isOwn = false }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!preview || !url) return null;
  const tone = isOwn ? TONE.own : TONE.other;
  const { siteName, title, description, image } = preview;
  const showImage = Boolean(image?.url) && !imageFailed;
  const persian = hasPersian(`${siteName} ${title} ${description}`);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      draggable="false"
      dir="auto"
      data-link-preview
      data-no-select
      className={`mt-1.5 flex w-72 max-w-full items-stretch gap-2 rounded-md text-start no-underline transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 dark:hover:bg-white/5 dark:focus-visible:outline-emerald-300 ${
        persian ? "font-fa" : ""
      }`}
    >
      <span aria-hidden="true" className={`w-0.5 shrink-0 self-stretch rounded-full ${tone.bar}`} />
      <span className="min-w-0 flex-1 py-0.5">
        {siteName ? (
          <span className={`block truncate text-xs font-semibold leading-snug ${tone.site}`}>{siteName}</span>
        ) : null}
        {title ? (
          <span className={`line-clamp-2 break-words text-[13px] font-bold leading-snug ${tone.title}`}>
            {title}
          </span>
        ) : null}
        {description ? (
          <span className={`line-clamp-2 break-words text-xs leading-snug ${tone.description}`}>
            {description}
          </span>
        ) : null}
      </span>
      {showImage ? (
        <img
          src={image.url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable="false"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className="h-16 w-16 shrink-0 self-center rounded-lg object-cover"
        />
      ) : null}
    </a>
  );
});

export default LinkPreviewCard;
