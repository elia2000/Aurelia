import { Close, Shield, ShieldAlert, ShieldCheck, ShieldOff } from "../../../icons/lucide.js";
import { hasPersian } from "../../../utils/fontUtils.js";
import { getKeyNoticeStore } from "../../../e2ee/keyChangeNotices.js";
import { requestSafetyNumber } from "../../../e2ee/safetyNumberRequests.js";

const TONE = {
  calm: {
    box: "rounded-full border border-emerald-200/60 bg-white/90 text-emerald-700 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200",
    icon: "text-emerald-600 dark:text-emerald-300",
    button:
      "border-emerald-200 bg-white text-emerald-700 hover:border-emerald-300 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200",
  },
  warning: {
    box: "rounded-2xl border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-950 dark:text-amber-100",
    icon: "text-amber-600 dark:text-amber-300",
    button:
      "border-amber-300 bg-white text-amber-900 hover:border-amber-400 dark:border-amber-400/40 dark:bg-slate-950 dark:text-amber-100",
  },
  danger: {
    box: "rounded-2xl border border-rose-300 border-s-4 border-s-rose-500 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:border-s-rose-400 dark:bg-rose-950 dark:text-rose-100",
    icon: "text-rose-600 dark:text-rose-300",
    button:
      "border-rose-300 bg-white text-rose-800 hover:border-rose-400 dark:border-rose-400/40 dark:bg-slate-950 dark:text-rose-100",
  },
};

/** A sentence with `{name}` in it, the name drawn on its own so it keeps its own script and direction. */
function Sentence({ text, name }) {
  const parts = text.split("{name}");
  return parts.map((part, index) => (
    <span key={index}>
      {index > 0 ? (
        <bdi dir="auto" className={hasPersian(name) ? "font-fa" : ""}>
          {name}
        </bdi>
      ) : null}
      {part}
    </span>
  ));
}

/**
 * The centered line of a direct chat that says a contact's devices or keys
 * changed ("Alice added a new device. Verify the safety number"). It lives on
 * this device only; "Verify" opens the safety number of the chat.
 *
 * @param {object} event   the `_systemEvent` of the line (see keyChangeNotices.js)
 * @param {boolean} [interactive=true]  false while messages are being selected
 */
export default function KeyChangeNotice({ event, interactive = true }) {
  const notice = event?.notice;
  if (!notice) return null;
  const template = notice.template || { severity: "warning", headline: "", detail: "" };
  const name = event.peerName || "Your contact";
  const tone = TONE[template.severity] || TONE.warning;
  const isOpen = notice.state === "open";
  const Icon =
    template.severity === "danger"
      ? ShieldAlert
      : template.severity === "warning"
        ? ShieldOff
        : notice.resolution === "verified"
          ? ShieldCheck
          : Shield;

  const dismiss = () => getKeyNoticeStore().dismiss(event.selfUserId, notice.userId, notice.id);

  return (
    <div
      data-key-notice={notice.kind}
      data-severity={template.severity}
      data-state={notice.state}
      className={`flex max-w-[min(100%,28rem)] items-center gap-2 px-3 py-1.5 text-[11px] leading-snug ${tone.box}`}
    >
      <Icon size={14} className={`shrink-0 ${tone.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-start" dir="auto">
        <p className={template.severity === "calm" ? "font-semibold" : "font-bold"}>
          <Sentence text={template.headline} name={name} />
        </p>
        {template.detail ? (
          <p className="mt-0.5">
            <Sentence text={template.detail} name={name} />
          </p>
        ) : null}
      </div>
      {interactive && isOpen ? (
        <button
          type="button"
          onClick={() => requestSafetyNumber(event.chatId)}
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${tone.button}`}
        >
          Verify
        </button>
      ) : null}
      {interactive && notice.dismissible ? (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss this notice"
          title="Dismiss"
          className="shrink-0 rounded-full p-1 opacity-70 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-emerald-500"
        >
          <Close size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
