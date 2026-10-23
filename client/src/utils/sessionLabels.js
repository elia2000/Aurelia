const METHOD_LABELS = {
  password: "Signed in with a password",
  password_2fa: "Signed in with a password and a code",
  recovery_code: "Signed in with a recovery code",
  registration: "Signed in when the account was created",
};

/** How a session was created, as a sentence ("" when unknown). */
export function methodLabel(session) {
  return METHOD_LABELS[session?.method] || "";
}

/** "JBSWY3DPEHPK3PXP" -> "JBSW Y3DP EHPK 3PXP": the setup key as people copy it by eye. */
export function groupSecret(secret) {
  return String(secret || "").replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
