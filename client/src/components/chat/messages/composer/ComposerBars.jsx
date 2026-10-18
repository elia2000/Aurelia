import { Close, File, ImageIcon, Mic, Paperclip, Pencil, Play, Reply, Video } from "../../../../icons/lucide.js";
import { hasPersian } from "../../../../utils/fontUtils.js";
import { renderMarkdownInlinePlain } from "../../../../utils/markdown.js";
import VerifiedBadge from "../../../common/VerifiedBadge.jsx";
import UserRoleBadge from "../../../common/UserRoleBadge.jsx";
import Tooltip from "../../../common/Tooltip.jsx";
import { formatVoiceDuration, normalizeComposerBody } from "./composerText.js";

// The strips above the input row: reply / edit, a recorded voice message and files
// waiting to be sent (and the upload progress line). They are kept slim (about 40 px, 56 px
// thumbnails) so the conversation keeps the room.

const BAR =
  "flex h-10 items-center gap-2 rounded-xl border-l-[3px] border-emerald-500 bg-emerald-50/70 pl-2 pr-1 dark:bg-slate-950/70";
const BAR_ICON = "shrink-0 text-emerald-600 dark:text-emerald-300";
const CLOSE_BUTTON =
  "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-rose-600 transition hover:bg-rose-50 after:absolute after:-inset-1 after:content-[''] dark:text-rose-200 dark:hover:bg-rose-500/10";

export function EditBar({ editTarget, onCancel, guard }) {
  const body = normalizeComposerBody(editTarget?.body);
  return (
    <div className={BAR}>
      <Pencil size={18} className={BAR_ICON} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span
          className={`truncate text-[11px] font-semibold text-emerald-700 dark:text-emerald-200 ${
            hasPersian("Edit Message") ? "font-fa" : ""
          }`}
          dir="auto"
          style={{ unicodeBidi: "isolate" }}
        >
          Edit Message
        </span>
        <span
          className={`min-w-0 truncate text-xs text-slate-600 dark:text-slate-300 ${hasPersian(body) ? "font-fa" : ""}`}
          dir="auto"
          style={{ unicodeBidi: "isolate" }}
        >
          {body || "Message"}
        </span>
      </div>
      <button type="button" {...guard(onCancel)} className={CLOSE_BUTTON} aria-label="Cancel edit">
        <Close size={18} />
      </button>
    </div>
  );
}

export function ReplyBar({ replyTarget, onCancel, guard }) {
  const bodyText = normalizeComposerBody(replyTarget?.body);
  const normalized = String(bodyText || "").trim();
  const isPluralMediaSummary = /^Sent \d+ (files|photos|videos|documents|media files)$/i.test(normalized);
  const isGenericMedia =
    /^Sent (a media file|a file|a photo|a video|a document|\d+ (files|photos|videos|documents|media files))$/i.test(
      normalized,
    );
  const isGenericVoice = /^Sent (a voice message|\d+ voice messages)$/i.test(normalized);
  const icon = (() => {
    if (replyTarget.icon) return replyTarget.icon;
    if (/^Sent \d+ media files/i.test(bodyText)) return "image";
    if (/^Sent (a voice message|\d+ voice messages)/i.test(bodyText)) return "voice";
    if (/^Sent (a video|\d+ videos)/i.test(bodyText)) return "video";
    if (/^Sent (a photo|\d+ photos)/i.test(bodyText)) return "image";
    if (/^Sent a media file/i.test(bodyText)) return "image";
    if (/^Sent (a file|a document|\d+ documents|\d+ files)/i.test(bodyText)) return "document";
    return null;
  })();
  const text =
    icon === "voice"
      ? isGenericVoice
        ? "Sent a voice message"
        : bodyText || "Message"
      : icon === "video"
        ? isGenericMedia && !isPluralMediaSummary
          ? "Sent a video"
          : bodyText || "Message"
        : icon === "image"
          ? isGenericMedia && !isPluralMediaSummary
            ? "Sent a photo"
            : bodyText || "Message"
          : bodyText || "Message";
  const html = renderMarkdownInlinePlain(text);
  const name = replyTarget.displayName || replyTarget.username || "message";
  const iconClass = "shrink-0 text-slate-500 dark:text-slate-400";
  return (
    <div className={BAR}>
      <Reply size={18} className={BAR_ICON} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <Tooltip label={name} asChild>
          <span className="flex items-center gap-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-200" dir="ltr">
            <span
              className={`truncate ${hasPersian(name) ? "font-fa" : ""}`}
              dir="auto"
              style={{ unicodeBidi: "isolate" }}
            >
              Reply to {name}
            </span>
            {Boolean(replyTarget.verified) && <VerifiedBadge size={13} />}
            <UserRoleBadge role={replyTarget.role} size={13} />
          </span>
        </Tooltip>
        <span
          className="flex min-w-0 items-center gap-1 text-xs text-slate-600 dark:text-slate-300"
          dir="ltr"
          style={{ unicodeBidi: "isolate" }}
        >
          {icon === "voice" ? (
            <Mic size={12} className={iconClass} />
          ) : icon === "video" ? (
            <Video size={12} className={iconClass} />
          ) : icon === "image" ? (
            <ImageIcon size={12} className={iconClass} />
          ) : icon === "document" ? (
            <File size={12} className={iconClass} />
          ) : null}
          <span
            className={`min-w-0 truncate ${hasPersian(text) ? "font-fa" : ""}`}
            dir="auto"
            style={{ unicodeBidi: "isolate" }}
            dangerouslySetInnerHTML={{ __html: String(html || "") }}
          />
        </span>
      </div>
      <button type="button" {...guard(onCancel)} className={CLOSE_BUTTON} aria-label="Cancel reply">
        <Close size={18} />
      </button>
    </div>
  );
}

export function PendingVoiceBar({ pendingVoiceMessage, onCancel, guard }) {
  return (
    <div className={BAR}>
      <Mic size={18} className={BAR_ICON} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[11px] font-semibold text-emerald-700 dark:text-emerald-200">Voice message</span>
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {formatVoiceDuration(pendingVoiceMessage.durationSeconds || 0)}
        </span>
      </div>
      <button type="button" {...guard(onCancel)} className={CLOSE_BUTTON} aria-label="Cancel voice message">
        <Close size={18} />
      </button>
    </div>
  );
}

const SMALL_PILL =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition";

export function PendingUploads({
  files,
  type,
  fileUploadEnabled,
  onAdd,
  onClear,
  onRemove,
  onThumbLoaded,
  guard,
}) {
  return (
    <div className="flex items-stretch gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/70 p-1.5 dark:border-emerald-500/30 dark:bg-slate-950/70">
      {/* Not .chat-scroll: that one only allows vertical panning, and this row scrolls sideways. */}
      <div
        data-touch-scroll=""
        className="flex min-w-0 flex-1 touch-pan-x gap-1.5 overflow-x-auto overscroll-x-contain"
      >
        {files.map((item) => {
          const forceDoc = type === "document";
          const isImage = !forceDoc && item.mimeType?.startsWith("image/");
          const isVideo = !forceDoc && item.mimeType?.startsWith("video/");
          const isMedia = isImage || isVideo;
          return (
            <div
              key={item.id}
              className={`relative h-14 shrink-0 overflow-hidden rounded-lg border border-emerald-200/70 bg-white dark:border-emerald-500/30 dark:bg-slate-900/70 ${
                isMedia ? "w-14" : "w-36"
              }`}
              title={item.name}
            >
              {isImage ? (
                <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
              ) : isVideo ? (
                <>
                  {item.previewUrl ? (
                    <video
                      src={item.previewUrl}
                      muted
                      playsInline
                      preload="auto"
                      onLoadedMetadata={onThumbLoaded}
                      onLoadedData={onThumbLoaded}
                      onCanPlay={onThumbLoaded}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full bg-slate-200/80 dark:bg-slate-800/80" />
                  )}
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/45 text-white">
                      <Play size={11} className="translate-x-px" />
                    </span>
                  </span>
                </>
              ) : (
                <div className="flex h-full items-center gap-2 px-2 pr-6 text-emerald-700 dark:text-emerald-200">
                  <File size={18} className="shrink-0" />
                  <p className="truncate text-[11px] text-slate-700 dark:text-slate-200">{item.name}</p>
                </div>
              )}
              {isMedia ? <span className="sr-only">{item.name}</span> : null}
              <button
                type="button"
                {...guard(() => onRemove?.(item.id))}
                className="absolute right-0.5 top-0.5 z-20 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white after:absolute after:-inset-1 after:content-['']"
                aria-label="Remove file"
              >
                <Close size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-col items-end justify-between gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-200">
        <span>
          {type === "media" ? "Photo or Video" : "Document"} ({files.length})
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!fileUploadEnabled}
            {...guard(() => {
              if (fileUploadEnabled) onAdd?.();
            })}
            className={`${SMALL_PILL} ${
              fileUploadEnabled
                ? "border-emerald-200/70 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-500/30 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
                : "cursor-not-allowed border-slate-300 text-slate-400 dark:border-slate-700 dark:text-slate-500"
            }`}
          >
            <Paperclip size={12} />
            Add
          </button>
          <button
            type="button"
            {...guard(onClear)}
            className={`${SMALL_PILL} border-rose-200/70 text-rose-600 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-900/30`}
          >
            <Close size={12} />
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

// A thin line along the top edge of the composer. It is laid over the edge
// instead of added to the column, so a voice message or a file going up never
// makes the composer taller and shorter again; the words are for screen readers.
export function UploadProgressBar({ percent }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="pointer-events-none absolute inset-x-0 top-0 h-[3px] overflow-hidden bg-emerald-100 dark:bg-slate-800"
    >
      <div
        className="h-full bg-emerald-500 transition-[width] duration-150"
        style={{ width: `${value}%` }}
      />
      <span className="sr-only">Uploading files...</span>
      <span className="sr-only">{value}%</span>
    </div>
  );
}
