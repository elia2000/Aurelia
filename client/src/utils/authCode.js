/**
 * What a person typed into an "authentication code" box, as the field the
 * server expects: six digits are an authenticator code, anything else is read
 * as a recovery code (XXXXX-XXXXX).
 */
export function splitAuthCode(value) {
  const text = String(value ?? "").trim();
  if (!text) return {};
  if (/^\d{3}\s?\d{3}$/.test(text)) return { code: text.replace(/\s+/g, "") };
  return { recoveryCode: text };
}
