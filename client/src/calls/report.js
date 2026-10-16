// The text a person can copy from a call that could not connect and send to
// whoever runs the server. It carries the kind of candidates and the state of
// the connection, never addresses or credentials.

export function buildCallReport({ reason, lines = [], buildId, userAgent } = {}) {
  return [
    "Aurelle call report",
    buildId ? `Build: ${buildId}` : null,
    reason ? `Result: ${reason}` : null,
    userAgent ? `Browser: ${userAgent}` : null,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Copies `text`; resolves true when it was copied. */
export async function copyText(
  text,
  {
    clipboard = typeof navigator === "undefined" ? null : navigator.clipboard,
    doc = typeof document === "undefined" ? null : document,
  } = {},
) {
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // Not allowed here (an insecure page, a denied permission): try the old way.
  }
  if (!doc) return false;
  let field = null;
  try {
    field = doc.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.setAttribute("aria-hidden", "true");
    field.setAttribute("tabindex", "-1");
    Object.assign(field.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
    doc.body.appendChild(field);
    field.select();
    return Boolean(doc.execCommand("copy"));
  } catch (_) {
    return false;
  } finally {
    try {
      field?.remove();
    } catch (_) {
      // Nothing left to clean up.
    }
  }
}
