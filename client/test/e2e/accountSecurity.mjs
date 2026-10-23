// Real-browser check of active sessions and two-factor sign-in.
//
//   node client/test/e2e/accountSecurity.mjs http://127.0.0.1:5602
//
// Needs a running Aurelle server with sign-up on and an empty (or at least
// fresh) database, and the Chromium that Playwright uses (CHROMIUM_PATH
// overrides the default location). Restart the server between runs: the
// sign-in limiter keeps its counters in memory.
//
// Two browser contexts act as two devices of one account:
//   1. both are listed; signing out the other one lands it on the sign-in page with a note
//   2. "Sign out all other devices" does the same
//   3. changing the password signs the other device out
//   4. 2FA is turned on with a code computed here (an independent TOTP
//      implementation), a login then needs the code, a used code is refused,
//      a recovery code works once, five wrong codes lock the challenge
//   5. 2FA is turned off again

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:5602";
const SHOTS = process.env.SHOT_DIR || path.join(process.cwd(), ".e2e-shots");
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
fs.mkdirSync(SHOTS, { recursive: true });

const UA_LAPTOP = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const UA_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const PASSWORD = "Passw0rd!xyz";
const NEW_PASSWORD = "An0ther!Passw0rd";

let failed = 0;
let total = 0;
function check(name, ok, detail = "") {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── An independent TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──────────────────
function base32Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text.replace(/[\s=]/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}
const wrongCodeFor = (secret) => {
  const valid = new Set([-1, 0, 1, 2].map((d) => totp(secret, Date.now() + d * 30000)));
  for (let i = 0; i < 1000; i += 1) { const c = String(100000 + i); if (!valid.has(c)) return c; }
  return "000000";
};

// ─── Helpers ────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ["--no-sandbox"] });
const username = "sec" + String(Date.now() % 1_000_000);
let shot = 0;
const snap = async (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`) });

async function newDevice(userAgent) {
  const context = await browser.newContext({ baseURL: BASE, userAgent, viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  return { context, page };
}
const dismissIntro = (page) => page.getByRole("button", { name: "Got it!" }).click({ timeout: 4000 }).catch(() => {});

async function uiLogin(page, password = PASSWORD) {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
// The settings menu stays open behind the dialog it opened, so only press the
// gear when the menu is not showing.
async function ensureSettingsMenu(page) {
  const logout = page.getByRole("button", { name: "Log out", exact: true });
  if (await logout.first().isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "Open settings" }).click({ timeout: 8000 });
}
async function openSecurity(page) {
  await ensureSettingsMenu(page);
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await page.getByText("Active sessions", { exact: true }).waitFor({ timeout: 10000 });
}
async function closeSettings(page) {
  // the dialog's own close button is the only one with the Close icon in the header
  await page.keyboard.press("Escape").catch(() => {});
  const close = page.locator("div.fixed h3 + button").first();
  if (await close.count()) await close.click().catch(() => {});
}
async function logoutUi(page) {
  await ensureSettingsMenu(page);
  const logout = page.getByRole("button", { name: "Log out", exact: true });
  try {
    await logout.first().click({ timeout: 8000 });
  } catch (error) {
    await snap(page, "logout-failed");
    throw error;
  }
  await page.locator('input[name="username"]').waitFor({ timeout: 10000 });
}
const meStatus = async (context) => (await context.request.get("/api/me")).status();
const sidCookie = async (context) => (await context.cookies()).find((c) => c.name === "sid");

// ─── 1. two devices, one account ────────────────────────────────────────────
const laptop = await newDevice(UA_LAPTOP);
const registered = await laptop.context.request.post("/api/register", { data: { username, password: PASSWORD, nickname: "Sec Tester" } });
check("account registered (laptop is signed in by registration)", registered.ok(), String(registered.status()));
await laptop.page.goto("/chat");
await dismissIntro(laptop.page);

const phone = await newDevice(UA_PHONE);
await uiLogin(phone.page);
await phone.page.waitForURL("**/chat", { timeout: 15000 });
await dismissIntro(phone.page);
check("phone signed in through the login page", (await meStatus(phone.context)) === 200);

await openSecurity(laptop.page);
const rows = laptop.page.getByTestId("session-row");
await rows.nth(1).waitFor({ timeout: 10000 });
check("the list shows both devices", (await rows.count()) === 2, `rows=${await rows.count()}`);
const firstRow = (await rows.first().innerText()).replace(/\s+/g, " ");
check("this device is first, with the badge, browser + OS and no IP", /Firefox on Linux/.test(firstRow) && /This device/.test(firstRow) && !/\d+\.\d+\.\d+\.\d+/.test(firstRow), firstRow);
const secondRow = (await rows.nth(1).innerText()).replace(/\s+/g, " ");
check("the other device is Chrome on Android with its last activity", /Chrome on Android/.test(secondRow) && /(Last active|just now)/.test(secondRow), secondRow);
check("this device has no per-row Sign out button", (await laptop.page.getByRole("button", { name: "Sign out Firefox on Linux" }).count()) === 0);
await snap(laptop.page, "laptop-sessions-two-devices");

// ─── 2. sign the phone out from the laptop ──────────────────────────────────
await laptop.page.getByRole("button", { name: "Sign out Chrome on Android" }).click();
await phone.page.getByTestId("auth-notice").waitFor({ timeout: 15000 }).catch(() => {});
const phoneNotice = await phone.page.getByTestId("auth-notice").innerText().catch(() => "");
check("the signed-out phone lands on the login page with a note", /signed out from another device/i.test(phoneNotice) && /\/login/.test(phone.page.url()), `${phone.page.url()} :: ${phoneNotice}`);
check("every API call of the phone answers 401 now", (await meStatus(phone.context)) === 401);
await snap(phone.page, "phone-after-signout");
check("the laptop's list lost the row", (await rows.count()) === 1);
check("the laptop itself is still signed in", (await meStatus(laptop.context)) === 200);

// ─── 3. sign out all other devices ──────────────────────────────────────────
await uiLogin(phone.page);
await phone.page.waitForURL("**/chat", { timeout: 15000 });
await dismissIntro(phone.page);
await laptop.page.bringToFront();
await laptop.page.reload();
await dismissIntro(laptop.page);
await openSecurity(laptop.page);
await rows.nth(1).waitFor({ timeout: 10000 });
await laptop.page.getByRole("button", { name: "Sign out all other devices" }).click();
check("a confirmation comes first", await laptop.page.getByRole("dialog").isVisible());
await snap(laptop.page, "laptop-confirm-sign-out-all");
await laptop.page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
await phone.page.getByTestId("auth-notice").waitFor({ timeout: 15000 }).catch(() => {});
check("the other device is signed out again", (await meStatus(phone.context)) === 401 && /\/login/.test(phone.page.url()));
check("this device stays", (await meStatus(laptop.context)) === 200 && (await rows.count()) === 1);

// ─── 4. changing the password signs the other device out ────────────────────
await uiLogin(phone.page);
await phone.page.waitForURL("**/chat", { timeout: 15000 });
await dismissIntro(phone.page);
await laptop.page.getByLabel("Current password").first().fill(PASSWORD);
await laptop.page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
await laptop.page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
await laptop.page.getByRole("button", { name: "Update password" }).click();
await phone.page.getByTestId("auth-notice").waitFor({ timeout: 15000 }).catch(() => {});
const pwNotice = await phone.page.getByTestId("auth-notice").innerText().catch(() => "");
check("a password change signs the other device out, with its own note", /password was changed/i.test(pwNotice), pwNotice);
check("the device that changed the password stays signed in", (await meStatus(laptop.context)) === 200);
const oldPw = await phone.context.request.post("/api/login", { data: { username, password: PASSWORD } });
check("the old password no longer works", oldPw.status() === 401);

// From here on the password is NEW_PASSWORD.
// ─── 5. turn on two-factor ──────────────────────────────────────────────────
await laptop.page.reload();
await dismissIntro(laptop.page);
await openSecurity(laptop.page);
await laptop.page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
await laptop.page.locator("#tf-setup-password").fill(NEW_PASSWORD);
await laptop.page.getByRole("button", { name: "Continue" }).click();
await laptop.page.getByTestId("totp-secret").waitFor({ timeout: 10000 });
const secret = (await laptop.page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "");
check("the setup key is 32 base32 characters", /^[A-Z2-7]{32}$/.test(secret), secret);
check("a QR code is drawn", (await laptop.page.getByRole("img", { name: /QR code/ }).count()) === 1);
const uri = await laptop.page.getByRole("link", { name: "Open in authenticator app" }).getAttribute("href");
check("the otpauth link carries the same key", uri.startsWith("otpauth://totp/") && uri.includes(`secret=${secret}`), uri);
await snap(laptop.page, "laptop-2fa-setup");
await laptop.page.locator("#tf-confirm-code").fill(wrongCodeFor(secret));
await laptop.page.getByRole("button", { name: "Turn on", exact: true }).click();
await laptop.page.getByText(/That code is not right/).waitFor({ timeout: 10000 });
check("a wrong code does not turn it on", true);
await laptop.page.locator("#tf-confirm-code").fill(totp(secret));
await laptop.page.getByRole("button", { name: "Turn on", exact: true }).click();
await laptop.page.getByTestId("recovery-codes").waitFor({ timeout: 10000 });
const recoveryCodes = await laptop.page.getByTestId("recovery-codes").locator("li").allInnerTexts();
check("ten recovery codes are shown once", recoveryCodes.length === 10 && recoveryCodes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)), recoveryCodes.join(" "));
await snap(laptop.page, "laptop-recovery-codes");
await laptop.page.getByLabel("I saved my recovery codes").check();
await laptop.page.getByRole("button", { name: "Done" }).click();
await laptop.page.getByText(/^On since/).waitFor({ timeout: 10000 });
check("the panel says it is on, with the count", /10 recovery codes left/.test(await laptop.page.getByTestId("recovery-remaining").innerText()));
await closeSettings(laptop.page);

// ─── 6. sign in with the code ───────────────────────────────────────────────
await logoutUi(laptop.page);
check("log out removed the session cookie value on the server", (await meStatus(laptop.context)) === 401);

const wrongBox = '#login-two-factor-code';
async function passwordStep(page) {
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator(wrongBox).waitFor({ timeout: 10000 });
}
await passwordStep(laptop.page);
check("the right password asks for a code and gives no session yet", (await meStatus(laptop.context)) === 401 && !(await sidCookie(laptop.context)));
await snap(laptop.page, "laptop-login-second-step");
await laptop.page.locator(wrongBox).fill(wrongCodeFor(secret));
await laptop.page.getByRole("button", { name: "Verify" }).click();
await laptop.page.getByRole("alert").waitFor({ timeout: 10000 });
check("a wrong code says how many tries are left", /Invalid code\. 4 tries left/.test(await laptop.page.getByRole("alert").innerText()));
// the code of the NEXT time step is accepted (clock drift window) and is not the one used to enable
const loginCode = totp(secret, Date.now() + 30000);
await laptop.page.locator(wrongBox).fill(loginCode);
await laptop.page.getByRole("button", { name: "Verify" }).click();
await laptop.page.waitForURL("**/chat", { timeout: 15000 });
check("the right code signs in", (await meStatus(laptop.context)) === 200);
await dismissIntro(laptop.page);
await openSecurity(laptop.page);
const method = (await laptop.page.getByTestId("session-row").first().innerText()).replace(/\s+/g, " ");
check("the session says it was made with a password and a code", /password and a code/.test(method), method);
await closeSettings(laptop.page);

// ─── 7. a used code is refused; a recovery code works once ──────────────────
await logoutUi(laptop.page);
await passwordStep(laptop.page);
await laptop.page.locator(wrongBox).fill(loginCode);
await laptop.page.getByRole("button", { name: "Verify" }).click();
await laptop.page.getByRole("alert").waitFor({ timeout: 10000 });
check("the same code a second time is refused (replay)", /Invalid code/.test(await laptop.page.getByRole("alert").innerText()) && (await meStatus(laptop.context)) === 401);
await laptop.page.getByRole("button", { name: "Use a recovery code" }).click();
await laptop.page.locator(wrongBox).fill(recoveryCodes[0]);
await laptop.page.getByRole("button", { name: "Verify" }).click();
await laptop.page.waitForURL("**/chat", { timeout: 15000 });
check("a recovery code signs in", (await meStatus(laptop.context)) === 200);
await dismissIntro(laptop.page);
await logoutUi(laptop.page);
await passwordStep(laptop.page);
await laptop.page.getByRole("button", { name: "Use a recovery code" }).click();
await laptop.page.locator(wrongBox).fill(recoveryCodes[0]);
await laptop.page.getByRole("button", { name: "Verify" }).click();
await laptop.page.getByRole("alert").waitFor({ timeout: 10000 });
check("the same recovery code a second time is refused", /Invalid code/.test(await laptop.page.getByRole("alert").innerText()));

// ─── 8. five wrong codes lock the challenge ─────────────────────────────────
let lastText = "";
for (let i = 0; i < 4; i += 1) {
  await laptop.page.locator(wrongBox).fill("ZZZZZ-ZZZZZ");
  await laptop.page.getByRole("button", { name: "Verify" }).click();
  await sleep(400);
}
// the 5th wrong try (one was already used above) ends the challenge: back to the password form
await laptop.page.locator('input[name="password"]').waitFor({ timeout: 10000 }).catch(() => {});
lastText = (await laptop.page.locator("body").innerText()).replace(/\s+/g, " ");
check("after five wrong codes the sign-in restarts at the password with a message", /Too many wrong codes/.test(lastText) && (await laptop.page.locator('input[name="password"]').count()) === 1, lastText.slice(0, 200));
check("still no session", (await meStatus(laptop.context)) === 401);
await snap(laptop.page, "laptop-challenge-locked");

// ─── 9. the password step is rate limited ───────────────────────────────────
const ghost = "ghost" + Date.now();
let statuses = [];
for (let i = 0; i < 10; i += 1) {
  statuses.push((await laptop.context.request.post("/api/login", { data: { username: ghost, password: "wrong-password" } })).status());
}
check("ten wrong passwords: 401 x8 then 429", statuses.slice(0, 8).every((s) => s === 401) && statuses.slice(8).every((s) => s === 429), statuses.join(","));

// ─── 10. finish with a recovery code, then turn 2FA off ─────────────────────
await laptop.page.goto("/login");
await passwordStep(laptop.page).catch(async () => {
  // the pair is limited after the wrong codes above: say so and finish through the API
  check("(login limiter engaged after the wrong codes - expected, finishing via API)", true);
});
if (await laptop.page.locator(wrongBox).count()) {
  await laptop.page.getByRole("button", { name: "Use a recovery code" }).click();
  await laptop.page.locator(wrongBox).fill(recoveryCodes[1]);
  await laptop.page.getByRole("button", { name: "Verify" }).click();
  await laptop.page.waitForURL("**/chat", { timeout: 15000 }).catch(() => {});
}
if ((await meStatus(laptop.context)) === 200) {
  await dismissIntro(laptop.page);
  await openSecurity(laptop.page);
  await laptop.page.getByRole("button", { name: "Turn off" }).click();
  await laptop.page.locator("#tf-disable-password").fill(NEW_PASSWORD);
  await laptop.page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await laptop.page.locator("#tf-disable-code").fill(recoveryCodes[2]);
  await laptop.page.getByRole("button", { name: "Turn off" }).last().click();
  await laptop.page.getByRole("button", { name: "Turn on two-factor authentication" }).waitFor({ timeout: 10000 });
  check("2FA turned off with password + a recovery code", true);
  const status = await (await laptop.context.request.get("/api/2fa")).json();
  check("the server agrees: off", status.enabled === false);
} else {
  check("signed in again to turn 2FA off (needs the limiter window to allow it)", false, "login did not complete");
}

await browser.close();
console.log(`\n${total - failed}/${total} checks passed; screenshots in ${SHOTS}`);
process.exitCode = failed ? 1 : 0;
