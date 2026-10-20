import { describe, test, expect } from "vitest";
import request from "supertest";
import { makeApp } from "../helpers/makeApp.js";

// ─── /api/app/info ────────────────────────────────────────────────────────────
//
// Every setting that the admin panel can change must be reflected in the
// /api/app/info response so that client-side code can pick it up on page load
// without needing a rebuild or server restart (for non-restart-required keys).
//
// Tests are grouped by the SettingsTab group they belong to.

describe("GET /api/app/build", () => {
  test("says which client build the server is serving, never cached", async () => {
    const files = { "/test/client/dist/build-id.txt": "abc123-lq1x\n" };
    const { app } = makeApp({
      deps: {
        fs: {
          readFileSync: (file) => {
            if (file in files) return files[file];
            throw new Error("ENOENT");
          },
          existsSync: (file) => file in files,
        },
      },
    });
    const res = await request(app).get("/api/app/build");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ buildId: "abc123-lq1x" });
    const info = await request(app).get("/api/app/info");
    expect(info.body.buildId).toBe("abc123-lq1x");
  });

  test("an unbuilt client has no build id", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/app/build");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buildId: "" });
  });
});

describe("theme palette in /api/app/info", () => {
  test("clients get the admin's palette", async () => {
    const { app } = makeApp({ settings: { THEME_PALETTE: "#FF0000, #00ff00 #0f0" } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.themePalette).toEqual(["#ff0000", "#00ff00"]);
  });

  test("without one they get the 30 built-in colours", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/app/info");
    expect(res.body.themePalette).toHaveLength(30);
  });
});

describe("theme default in /api/app/info", () => {
  test("is Random unless the admin chose something else", async () => {
    const { app } = makeApp();
    expect((await request(app).get("/api/app/info")).body.themeDefault).toBe("random");
  });
  test("is whatever the admin set, cleaned up", async () => {
    expect((await request(makeApp({ settings: { THEME_DEFAULT: "#2563EB" } }).app).get("/api/app/info")).body.themeDefault).toBe("#2563eb");
    expect((await request(makeApp({ settings: { THEME_DEFAULT: "default" } }).app).get("/api/app/info")).body.themeDefault).toBe("default");
    expect((await request(makeApp({ settings: { THEME_DEFAULT: "garbage" } }).app).get("/api/app/info")).body.themeDefault).toBe("random");
  });
});

describe("GET /api/app/info", () => {
  // ── Shape ──────────────────────────────────────────────────────────────────

  test("returns 200 with all expected fields present", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/app/info");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      // Registration
      accountCreationEnabled: expect.any(Boolean),
      // Limits
      messageMaxChars: expect.any(Number),
      usernameMaxChars: expect.any(Number),
      nicknameMaxChars: expect.any(Number),
      // File uploads
      fileUploadEnabled: expect.any(Boolean),
      fileUploadMaxFiles: expect.any(Number),
      fileUploadMaxSizeMb: expect.any(Number),
      fileUploadMaxTotalSizeMb: expect.any(Number),
      // Client behaviour
      chatMessageFetchLimit: expect.any(Number),
      chatMessagePageSize: expect.any(Number),
      chatCacheTtlHours: expect.any(Number),
      // Remote channels object
      remoteChannels: expect.any(Object),
    });
  });

  // ── Reactions ──────────────────────────────────────────────────────────────

  test('MAX_REACTIONS_PER_USER is exposed as maxReactionsPerUser, default 1', async () => {
    const res = await request(makeApp().app).get("/api/app/info");
    expect(res.body.maxReactionsPerUser).toBe(1);
  });

  test('MAX_REACTIONS_PER_USER=3 → maxReactionsPerUser is 3, and is always clamped to 1-3', async () => {
    const three = await request(makeApp({ settings: { MAX_REACTIONS_PER_USER: 3 } }).app).get("/api/app/info");
    expect(three.body.maxReactionsPerUser).toBe(3);
    const big = await request(makeApp({ settings: { MAX_REACTIONS_PER_USER: 40 } }).app).get("/api/app/info");
    expect(big.body.maxReactionsPerUser).toBe(3);
  });

  // ── Pinned messages ────────────────────────────────────────────────────────

  test('MAX_PINNED_MESSAGES is exposed as maxPinnedMessages, default 20', async () => {
    const res = await request(makeApp().app).get("/api/app/info");
    expect(res.body.maxPinnedMessages).toBe(20);
  });

  test('MAX_PINNED_MESSAGES=5 → maxPinnedMessages is 5, and is always clamped to 1-100', async () => {
    const five = await request(makeApp({ settings: { MAX_PINNED_MESSAGES: 5 } }).app).get("/api/app/info");
    expect(five.body.maxPinnedMessages).toBe(5);
    const big = await request(makeApp({ settings: { MAX_PINNED_MESSAGES: 4000 } }).app).get("/api/app/info");
    expect(big.body.maxPinnedMessages).toBe(100);
    const small = await request(makeApp({ settings: { MAX_PINNED_MESSAGES: 0 } }).app).get("/api/app/info");
    expect(small.body.maxPinnedMessages).toBe(1);
  });

  // ── Pinned chats ───────────────────────────────────────────────────────────

  test('MAX_PINNED_CHATS is exposed as maxPinnedChats, default 5', async () => {
    const res = await request(makeApp().app).get("/api/app/info");
    expect(res.body.maxPinnedChats).toBe(5);
  });

  test('MAX_PINNED_CHATS=8 → maxPinnedChats is 8, and is always clamped to 1-30', async () => {
    const eight = await request(makeApp({ settings: { MAX_PINNED_CHATS: 8 } }).app).get("/api/app/info");
    expect(eight.body.maxPinnedChats).toBe(8);
    const big = await request(makeApp({ settings: { MAX_PINNED_CHATS: 4000 } }).app).get("/api/app/info");
    expect(big.body.maxPinnedChats).toBe(30);
    const small = await request(makeApp({ settings: { MAX_PINNED_CHATS: 0 } }).app).get("/api/app/info");
    expect(small.body.maxPinnedChats).toBe(1);
  });

  // ── Saved GIFs ─────────────────────────────────────────────────────────────

  test('MAX_SAVED_GIFS is exposed as maxSavedGifs, default 50', async () => {
    const res = await request(makeApp().app).get("/api/app/info");
    expect(res.body.maxSavedGifs).toBe(50);
  });

  test('MAX_SAVED_GIFS=80 → maxSavedGifs is 80, and is always clamped to 1-200', async () => {
    const eighty = await request(makeApp({ settings: { MAX_SAVED_GIFS: 80 } }).app).get("/api/app/info");
    expect(eighty.body.maxSavedGifs).toBe(80);
    const big = await request(makeApp({ settings: { MAX_SAVED_GIFS: 4000 } }).app).get("/api/app/info");
    expect(big.body.maxSavedGifs).toBe(200);
    const small = await request(makeApp({ settings: { MAX_SAVED_GIFS: 0 } }).app).get("/api/app/info");
    expect(small.body.maxSavedGifs).toBe(1);
  });

  // ── Registration ───────────────────────────────────────────────────────────

  test('SIGN_UP=false → accountCreationEnabled is false', async () => {
    const { app } = makeApp({ settings: { SIGN_UP: false } });
    const res = await request(app).get("/api/app/info");
    expect(res.status).toBe(200);
    expect(res.body.accountCreationEnabled).toBe(false);
  });

  test('SIGN_UP=true → accountCreationEnabled is true', async () => {
    const { app } = makeApp({ settings: { SIGN_UP: true } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.accountCreationEnabled).toBe(true);
  });

  // ── Limits ─────────────────────────────────────────────────────────────────

  test('MESSAGE_MAX_CHARS=500 → messageMaxChars is 500', async () => {
    const { app } = makeApp({ settings: { MESSAGE_MAX_CHARS: 500 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.messageMaxChars).toBe(500);
  });

  test('USERNAME_MAX_CHARS=20 → usernameMaxChars is 20', async () => {
    const { app } = makeApp({ settings: { USERNAME_MAX_CHARS: 20 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.usernameMaxChars).toBe(20);
  });

  test('NICKNAME_MAX_CHARS=30 → nicknameMaxChars is 30', async () => {
    const { app } = makeApp({ settings: { NICKNAME_MAX_CHARS: 30 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.nicknameMaxChars).toBe(30);
  });

  // ── File uploads ───────────────────────────────────────────────────────────

  test('FILE_UPLOAD=false → fileUploadEnabled is false', async () => {
    const { app } = makeApp({ settings: { FILE_UPLOAD: false } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.fileUploadEnabled).toBe(false);
  });

  test('FILE_UPLOAD=true → fileUploadEnabled is true', async () => {
    const { app } = makeApp({ settings: { FILE_UPLOAD: true } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.fileUploadEnabled).toBe(true);
  });

  test('FILE_UPLOAD_MAX_FILES=3 → fileUploadMaxFiles is 3', async () => {
    const { app } = makeApp({ settings: { FILE_UPLOAD_MAX_FILES: 3 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.fileUploadMaxFiles).toBe(3);
  });

  test('FILE_UPLOAD_MAX_SIZE_MB=50 → fileUploadMaxSizeMb is 50', async () => {
    const { app } = makeApp({ settings: { FILE_UPLOAD_MAX_SIZE_MB: 50 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.fileUploadMaxSizeMb).toBe(50);
  });

  test('FILE_UPLOAD_MAX_TOTAL_SIZE_MB=200 → fileUploadMaxTotalSizeMb is 200', async () => {
    const { app } = makeApp({ settings: { FILE_UPLOAD_MAX_TOTAL_SIZE_MB: 200 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.fileUploadMaxTotalSizeMb).toBe(200);
  });

  // ── Client behaviour ───────────────────────────────────────────────────────

  test('CHAT_MESSAGE_FETCH_LIMIT=30 → chatMessageFetchLimit is 30', async () => {
    const { app } = makeApp({ settings: { CHAT_MESSAGE_FETCH_LIMIT: 30 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.chatMessageFetchLimit).toBe(30);
  });

  test('CHAT_MESSAGE_PAGE_SIZE=20 → chatMessagePageSize is 20', async () => {
    const { app } = makeApp({ settings: { CHAT_MESSAGE_PAGE_SIZE: 20 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.chatMessagePageSize).toBe(20);
  });

  test('CHAT_CACHE_TTL=48 → chatCacheTtlHours is 48', async () => {
    const { app } = makeApp({ settings: { CHAT_CACHE_TTL: 48 } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.chatCacheTtlHours).toBe(48);
  });

  // ── Remote channels ────────────────────────────────────────────────────────

  test("remoteChannels.enabled is false when REMOTE_CHANNELS dep is disabled", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/app/info");
    expect(res.body.remoteChannels.enabled).toBe(false);
  });

  test('REMOTE_CHANNEL_UI=true → remoteChannels.uiEnabled is true', async () => {
    const { app } = makeApp({ settings: { REMOTE_CHANNEL_UI: true } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.remoteChannels.uiEnabled).toBe(true);
  });

  test('REMOTE_CHANNEL_UI=false → remoteChannels.uiEnabled is false', async () => {
    const { app } = makeApp({ settings: { REMOTE_CHANNEL_UI: false } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.remoteChannels.uiEnabled).toBe(false);
  });

  test('REMOTE_CHANNEL_MEDIA_STREAM=true → remoteChannels.mediaStreamEnabled is true', async () => {
    const { app } = makeApp({ settings: { REMOTE_CHANNEL_MEDIA_STREAM: true } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.remoteChannels.mediaStreamEnabled).toBe(true);
  });

  test('REMOTE_CHANNEL_MEDIA_STREAM=false → remoteChannels.mediaStreamEnabled is false', async () => {
    const { app } = makeApp({ settings: { REMOTE_CHANNEL_MEDIA_STREAM: false } });
    const res = await request(app).get("/api/app/info");
    expect(res.body.remoteChannels.mediaStreamEnabled).toBe(false);
  });
});

describe("GET /api/app/info calls flag", () => {
  test("callsEnabled follows CALLS_ENABLED so the client can hide call buttons", async () => {
    const on = makeApp({ deps: { callsConfig: () => ({ enabled: true }) } });
    expect((await request(on.app).get("/api/app/info")).body.callsEnabled).toBe(true);
    const off = makeApp({ deps: { callsConfig: () => ({ enabled: false }), callSweepIntervalMs: 0 } });
    expect((await request(off.app).get("/api/app/info")).body.callsEnabled).toBe(false);
  });
});
