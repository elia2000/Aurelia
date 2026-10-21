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

  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-330 flex flex-col items-center gap-2 px-4"
      style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          className={`max-w-full rounded-full border px-4 py-2 text-xs font-semibold shadow-lg ${
            toast.tone === "error"
              ? "border-rose-300/70 bg-rose-500 text-white shadow-rose-500/30"
              : "border-emerald-300/70 bg-emerald-500 text-white shadow-emerald-500/30"
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
