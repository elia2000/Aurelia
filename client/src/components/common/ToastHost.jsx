import { useEffect, useRef, useState } from "react";
import { TOAST_EVENT } from "../../utils/toast.js";

const MAX_TOASTS = 3;

/**
 * Shows the messages sent with showToast() (utils/toast.js) as small pills
 * above the composer. Mount it once, inside the chat window.
 */
export default function ToastHost() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);
  const timers = useRef(new Map());

  useEffect(() => {
    const pending = timers.current;
    const dismiss = (id) => {
      window.clearTimeout(pending.get(id));
      pending.delete(id);
      setToasts((list) => list.filter((toast) => toast.id !== id));
    };
    const onToast = (event) => {
      const { message, tone, durationMs } = event.detail || {};
      if (!message) return;
      const id = nextId.current++;
      setToasts((list) => [...list.filter((t) => t.message !== message), { id, message, tone }].slice(-MAX_TOASTS));
      pending.set(id, window.setTimeout(() => dismiss(id), Math.max(1200, Number(durationMs) || 3600)));
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      pending.forEach((timer) => window.clearTimeout(timer));
      pending.clear();
    };
  }, []);

  // The two live regions stay on the page whether or not there is a toast: a
  // screen reader announces text put into a region that already exists far
  // more reliably than a region that appears together with its text. Errors
  // go to the assertive one, everything else to the polite one.
  const pill = (toast) => (
    <div
      key={toast.id}
      className={`mt-2 max-w-full rounded-full border px-4 py-2 text-xs font-semibold shadow-lg ${
        toast.tone === "error"
          ? "border-rose-300/70 bg-rose-500 text-white shadow-rose-500/30"
          : "border-emerald-300/70 bg-emerald-500 text-white shadow-emerald-500/30"
      }`}
    >
      {toast.message}
    </div>
  );
  return (
    <div
      // On a wide screen the chat list takes the left 35% (ChatSidebar); the
      // toasts belong to the chat beside it, so they centre over that part.
      className="pointer-events-none fixed inset-x-0 z-330 flex flex-col items-center px-4 md:left-[35%]"
      style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
    >
      <div role="status" className="flex max-w-full flex-col items-center">
        {toasts.filter((toast) => toast.tone !== "error").map(pill)}
      </div>
      <div role="alert" className="flex max-w-full flex-col items-center">
        {toasts.filter((toast) => toast.tone === "error").map(pill)}
      </div>
    </div>
  );
}
