import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import realFs from "node:fs";
import realPath from "node:path";
import os from "node:os";
import bcrypt from "bcryptjs";
import { makeApp, makeUserStore } from "../helpers/makeApp.js";
import { buildGif, buildJpeg, buildPng, buildWebp } from "../helpers/imageBytes.js";

const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const CHAT_ID = "c0c0c0c0-d1d1-4e2e-af3f-060606060606";
const TARGET_CHAT_ID = "c1c1c1c1-d2d2-4f3f-b040-171717171717";
const MSG_ID = "d0d0d0d0-e1e1-4f2f-b040-171717171717";
const NEW_MSG_ID = "d1d1d1d1-e2e2-4030-c151-282828282828";

const alice = () => ({
  id: ALICE_ID,
  username: "alice",
  password_hash: bcrypt.hashSync("secret123", 4),
  nickname: "Alice",
  avatar_url: null,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
});

const inferMime = (name) => {
  const ext = realPath.extname(String(name || "")).toLowerCase();
  return { ".gif": "image/gif", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4" }[ext] || "";
};

/**
 * POST /api/messages/upload with local files. The multer stand-in writes the
 * given files into a temporary folder and hands them to the route the way
 * multer does.
 */
describe("POST /api/messages/upload: animated pictures", () => {
  let tmpDir;
  let incoming;
  let cookie;
  let ctx;
  let createMessageFiles;
  let events;
  let openSpy;

  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(realPath.join(os.tmpdir(), "sb-anim-test-"));
    incoming = [];
    events = [];
    createMessageFiles = vi.fn().mockReturnValue([]);
    openSpy = vi.fn((...args) => realFs.promises.open(...args));
    const fsWithSpy = { ...realFs, promises: { ...realFs.promises, open: openSpy } };

    const userStore = makeUserStore([alice()]);
    ctx = makeApp({
      userStore,
      settings: { FILE_UPLOAD: true, FILE_UPLOAD_TRANSCODE_VIDEOS: false },
      deps: {
        emitChatEvent: (_chatId, payload) => events.push(payload),
        fs: fsWithSpy,
        path: realPath,
        uploadRootDir: tmpDir,
        MESSAGE_FILE_LIMITS: { maxFiles: 10, maxFileSizeBytes: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 },
        findChatById: () => ({ id: CHAT_ID, type: "group", name: "Test" }),
        isMember: () => true,
        createOrReuseMessage: () => ({ id: NEW_MSG_ID, deduped: false }),
        createMessageFiles,
        listMessageFilesByMessageIds: () => [],
        hydrateMissingVideoMetadata: (rows) => Promise.resolve(rows || []),
        isVideoFileProcessing: () => false,
        enqueueVideoTranscodeJob: () => {},
        probeVideoMetadata: async () => ({ widthPx: null, heightPx: null, durationSeconds: null }),
        computeExpiryIso: () => null,
        inferMimeFromFilename: inferMime,
        decodeOriginalFilename: (f) => f,
        isDangerousUploadFile: () => false,
        hasEnoughFreeDiskSpace: () => true,
        sanitizePositiveInt: (v) => (Number(v) > 0 ? Number(v) : null),
        sanitizeDurationSeconds: (v) => (Number(v) >= 0 ? Number(v) : null),
        parseUploadFileMetadata: (raw) => {
          try {
            return JSON.parse(raw || "[]");
          } catch {
            return [];
          }
        },
        getUploadKind: () => "media",
        listChatMembers: () => [],
        listMutedUserIdsForChat: () => [],
        removeUploadedFiles: () => {},
        uploadFiles: {
          array: () => (req, _res, next) => {
            req.files = incoming.map((file, index) => {
              const storedName = `stored-${index}${realPath.extname(file.name)}`;
              const filePath = realPath.join(tmpDir, storedName);
              realFs.writeFileSync(filePath, file.bytes);
              return {
                originalname: file.name,
                mimetype: file.type,
                filename: storedName,
                path: filePath,
                size: file.bytes.length,
              };
            });
            next();
          },
        },
        ...({}),
      },
    });
    ctx.sessionStore.createSession(ALICE_ID, "anim-token");
    cookie = ["sid=anim-token"];
  });

  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The stand-in for multer hands over the files; the fields travel as JSON.
  const upload = (fields = {}) =>
    request(ctx.app)
      .post("/api/messages/upload")
      .set("Cookie", cookie)
      .send({ chatId: CHAT_ID, username: "alice", uploadType: "media", ...fields });

  test("an animated GIF is stored with the flag, answered and announced as a GIF", async () => {
    incoming = [{ name: "party.gif", type: "image/gif", bytes: buildGif({ frames: 4 }) }];
    const res = await upload();
    expect(res.status).toBe(200);

    expect(createMessageFiles).toHaveBeenCalledTimes(1);
    expect(createMessageFiles.mock.calls[0][1][0]).toMatchObject({ mimeType: "image/gif", isAnimated: true });
    expect(res.body.files[0]).toMatchObject({ isAnimated: true, gif: true, mimeType: "image/gif" });
    expect(events[0].files[0]).toMatchObject({ isAnimated: true, gif: true });
    expect(events[0].summaryText).toBe("Sent a GIF");
    // The stored text is the generic placeholder clients already hide.
    expect(events[0].body).toBe("Sent a media file");
  });

  test("the file itself is stored untouched: animation is never flattened on the way in", async () => {
    const bytes = buildGif({ frames: 6, width: 33, height: 21 });
    incoming = [{ name: "party.gif", type: "image/gif", bytes }];
    const res = await upload();
    expect(res.status).toBe(200);
    const stored = realFs.readFileSync(realPath.join(tmpDir, "stored-0.gif"));
    expect(stored.equals(bytes)).toBe(true);
  });

  test.each([
    ["an animated WebP is flagged", () => buildWebp({ animated: true, frames: 3 }), "anim.webp", "image/webp", true],
    ["an animated PNG is flagged", () => buildPng({ animated: true, frames: 3 }), "anim.png", "image/png", true],
    ["a still GIF is not", () => buildGif({ frames: 1 }), "still.gif", "image/gif", false],
    ["a still WebP is not", () => buildWebp({ animated: false }), "still.webp", "image/webp", false],
    ["a plain PNG is not", () => buildPng(), "plain.png", "image/png", false],
    ["HTML named .gif is not", () => Buffer.from("<html><script>1</script></html>"), "evil.gif", "image/gif", false],
  ])("%s", async (_label, build, name, type, expected) => {
    incoming = [{ name, type, bytes: build() }];
    const res = await upload();
    expect(res.status).toBe(200);
    expect(res.body.files[0].isAnimated).toBe(expected);
    expect(res.body.files[0].gif).toBe(expected);
    expect(createMessageFiles.mock.calls[0][1][0].isAnimated).toBe(expected);
  });

  test("the bytes decide: an animated GIF sent as application/octet-stream with a .bin name is not scanned", async () => {
    incoming = [{ name: "blob.bin", type: "application/octet-stream", bytes: buildGif({ frames: 3 }) }];
    const res = await upload();
    expect(res.status).toBe(200);
    expect(res.body.files[0].isAnimated).toBe(false);
  });

  test("a client cannot claim a file is animated: the flag it sends in the file metadata is ignored", async () => {
    incoming = [{ name: "still.png", type: "image/png", bytes: buildPng() }];
    const res = await upload({
      fileMeta: JSON.stringify([{ isAnimated: true, gif: true, is_animated: 1, width: 4, height: 4 }]),
    });
    expect(res.status).toBe(200);
    expect(res.body.files[0].isAnimated).toBe(false);
    expect(createMessageFiles.mock.calls[0][1][0].isAnimated).toBe(false);
  });

  test("photos, videos and documents are not even opened", async () => {
    incoming = [
      { name: "photo.jpg", type: "image/jpeg", bytes: buildJpeg() },
      { name: "clip.mp4", type: "video/mp4", bytes: Buffer.from("not really a video") },
      { name: "notes.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4") },
    ];
    const res = await upload();
    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.isAnimated)).toEqual([false, false, false]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  test("with several files, each is judged on its own and the summary says what they are", async () => {
    incoming = [
      { name: "a.gif", type: "image/gif", bytes: buildGif({ frames: 3 }) },
      { name: "b.jpg", type: "image/jpeg", bytes: buildJpeg() },
    ];
    const res = await upload();
    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.isAnimated)).toEqual([true, false]);
    expect(events[0].summaryText).toBe("Sent 2 photos");

    createMessageFiles.mockClear();
    events.length = 0;
    incoming = [
      { name: "a.gif", type: "image/gif", bytes: buildGif({ frames: 3 }) },
      { name: "b.gif", type: "image/gif", bytes: buildGif({ frames: 5 }) },
    ];
    const both = await upload();
    expect(both.body.files.map((f) => f.isAnimated)).toEqual([true, true]);
    expect(events[0].summaryText).toBe("Sent 2 GIFs");
  });

  test("a still image keeps its old summary", async () => {
    incoming = [{ name: "plain.png", type: "image/png", bytes: buildPng() }];
    const res = await upload();
    expect(res.status).toBe(200);
    expect(events[0].summaryText).toBe("Sent a photo");
  });

  test("a file that cannot be read for the check is simply not marked: the message still goes out", async () => {
    incoming = [{ name: "party.gif", type: "image/gif", bytes: buildGif({ frames: 4 }) }];
    openSpy.mockRejectedValue(new Error("EMFILE"));
    const res = await upload();
    expect(res.status).toBe(200);
    expect(res.body.files[0].isAnimated).toBe(false);
  });
});

describe("POST /api/messages/upload: files uploaded straight to the bucket", () => {
  let ctx;
  let cookie;
  let createMessageFiles;
  let detectStoredAnimation;
  let events;

  const send = (item, extra = {}) =>
    request(ctx.app)
      .post("/api/messages/upload")
      .set("Cookie", cookie)
      .send({ chatId: CHAT_ID, username: "alice", storageKeys: [item], ...extra });

  beforeEach(() => {
    events = [];
    createMessageFiles = vi.fn().mockReturnValue([]);
    detectStoredAnimation = vi.fn(async () => true);
    ctx = makeApp({
      userStore: makeUserStore([alice()]),
      deps: {
        isMember: () => true,
        findChatById: () => ({ id: CHAT_ID, type: "group", name: "Test" }),
        emitChatEvent: (_c, payload) => events.push(payload),
        createMessageFiles,
        storageProvider: { type: "s3", getDownloadUrl: async (key) => `https://bucket.test/${key}` },
        savedGifStorage: { detectStoredAnimation },
        MESSAGE_FILE_LIMITS: { maxFiles: 3, maxFileSizeBytes: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 },
        inferMimeFromFilename: inferMime,
        isDangerousUploadFile: () => false,
      },
    });
    ctx.sessionStore.createSession(ALICE_ID, "anim-token-2");
    cookie = ["sid=anim-token-2"];
  });

  test("the bucket object is inspected and the answer is stored", async () => {
    const res = await send({
      storageKey: "uploads/messages/party.gif",
      originalName: "party.gif",
      mimeType: "image/gif",
      sizeBytes: 2048,
    });
    expect(res.status).toBe(200);
    expect(detectStoredAnimation).toHaveBeenCalledWith({
      storageKey: "uploads/messages/party.gif",
      storageDriver: "s3",
      mimeType: "image/gif",
      name: "party.gif",
      budget: expect.objectContaining({ remaining: expect.any(Number) }),
    });
    expect(createMessageFiles.mock.calls[0][1][0].isAnimated).toBe(true);
    expect(res.body.files[0]).toMatchObject({ isAnimated: true, gif: true });
    expect(events[0].files[0]).toMatchObject({ isAnimated: true, gif: true });
  });

  test("an answer of 'cannot tell' or 'no' is not animated", async () => {
    for (const answer of [null, false]) {
      detectStoredAnimation.mockResolvedValueOnce(answer);
      const res = await send({
        storageKey: "uploads/messages/x.gif",
        originalName: "x.gif",
        mimeType: "image/gif",
        sizeBytes: 100,
      });
      expect(res.status).toBe(200);
      expect(res.body.files[0].isAnimated).toBe(false);
    }
  });

  test("a failing check never stops the message", async () => {
    detectStoredAnimation.mockRejectedValueOnce(new Error("bucket down"));
    const res = await send({
      storageKey: "uploads/messages/x.gif",
      originalName: "x.gif",
      mimeType: "image/gif",
      sizeBytes: 100,
    });
    expect(res.status).toBe(200);
    expect(res.body.files[0].isAnimated).toBe(false);
  });

  test("the flag the client sends along is ignored", async () => {
    detectStoredAnimation.mockResolvedValueOnce(false);
    const res = await send({
      storageKey: "uploads/messages/x.png",
      originalName: "x.png",
      mimeType: "image/png",
      sizeBytes: 100,
      isAnimated: true,
      gif: true,
    });
    expect(res.body.files[0].isAnimated).toBe(false);
    expect(createMessageFiles.mock.calls[0][1][0].isAnimated).toBe(false);
  });

  // The check reads from the bucket, and what is in the bucket is the sender's
  // own doing: one request must not be able to make the server read it again
  // and again.
  test("the same bucket object listed several times is inspected once", async () => {
    const entry = { storageKey: "uploads/messages/party.gif", originalName: "party.gif", mimeType: "image/gif", sizeBytes: 2048 };
    const res = await request(ctx.app)
      .post("/api/messages/upload")
      .set("Cookie", cookie)
      .send({ chatId: CHAT_ID, username: "alice", storageKeys: [entry, entry, entry] });
    expect(res.status).toBe(200);
    expect(detectStoredAnimation).toHaveBeenCalledTimes(1);
    expect(createMessageFiles.mock.calls[0][1].map((file) => file.isAnimated)).toEqual([true, true, true]);
  });

  test("every file of a request spends from the same scan budget", async () => {
    const entry = (n) => ({ storageKey: `uploads/messages/p${n}.gif`, originalName: `p${n}.gif`, mimeType: "image/gif", sizeBytes: 2048 });
    const res = await request(ctx.app)
      .post("/api/messages/upload")
      .set("Cookie", cookie)
      .send({ chatId: CHAT_ID, username: "alice", storageKeys: [entry(1), entry(2), entry(3)] });
    expect(res.status).toBe(200);
    expect(detectStoredAnimation).toHaveBeenCalledTimes(3);
    const budgets = detectStoredAnimation.mock.calls.map(([args]) => args.budget);
    expect(budgets[0]).toBe(budgets[1]);
    expect(budgets[1]).toBe(budgets[2]);
    expect(budgets[0].remaining).toBeGreaterThan(0);
    expect(budgets[0].remaining).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  test("a new request starts with a full budget", async () => {
    detectStoredAnimation.mockImplementation(async ({ budget }) => {
      budget.remaining = 0; // the first request spends it all
      return null;
    });
    for (const n of [1, 2]) {
      await send({ storageKey: `uploads/messages/q${n}.gif`, originalName: `q${n}.gif`, mimeType: "image/gif", sizeBytes: 100 });
    }
    const [first, second] = detectStoredAnimation.mock.calls.map(([args]) => args.budget);
    expect(first).not.toBe(second);
  });

  test("videos, photos and documents are not looked at", async () => {
    for (const [name, type] of [["clip.mp4", "video/mp4"], ["p.jpg", "image/jpeg"], ["d.pdf", "application/pdf"]]) {
      const res = await send({ storageKey: `uploads/messages/${name}`, originalName: name, mimeType: type, sizeBytes: 100 });
      expect(res.status).toBe(200);
    }
    expect(detectStoredAnimation).not.toHaveBeenCalled();
  });
});

describe("the animated flag in what clients read", () => {
  const rawMessage = (id) => ({
    id,
    user_id: ALICE_ID,
    username: "alice",
    nickname: "Alice",
    body: "x",
    created_at: "2026-10-18 10:00:00",
    edited: 0,
    expires_at: null,
    hidden_everyone_at: null,
  });

  const gifRow = (overrides = {}) => ({
    id: 7,
    message_id: MSG_ID,
    kind: "media",
    original_name: "party.gif",
    stored_name: "party.gif",
    mime_type: "image/gif",
    size_bytes: 10,
    storage_driver: "local",
    is_animated: 1,
    ...overrides,
  });

  async function login(app) {
    const res = await request(app).post("/api/login").send({ username: "alice", password: "secret123" });
    return res.headers["set-cookie"];
  }

  test("GET /api/messages: files carry isAnimated and gif", async () => {
    const { app } = makeApp({
      userStore: makeUserStore([alice()]),
      deps: {
        isMember: () => true,
        findChatById: () => ({ id: CHAT_ID, type: "group", name: "T" }),
        getMessages: () => ({ messages: [rawMessage(MSG_ID)], hasMore: false }),
        getMessageReadByUser: () => [],
        getMessageReadCounts: () => [],
        listMessageFilesByMessageIds: () => [
          gifRow(),
          gifRow({ id: 8, original_name: "p.png", stored_name: "p.png", mime_type: "image/png", is_animated: 0 }),
          gifRow({ id: 9, original_name: "old.gif", stored_name: "old.gif", is_animated: null }),
        ],
        hydrateMissingVideoMetadata: async (list) => list,
      },
    });
    const cookie = await login(app);
    const res = await request(app).get("/api/messages").set("Cookie", cookie).query({ chatId: CHAT_ID, username: "alice" });
    expect(res.status).toBe(200);
    const files = res.body.messages[0].files;
    expect(files.map((f) => [f.isAnimated, f.gif])).toEqual([
      [true, true],
      [false, false],
      [false, false],
    ]);
  });

  test("GET /api/chats: last_message_files carry them too", async () => {
    const { app } = makeApp({
      userStore: makeUserStore([alice()]),
      deps: {
        listChatsForUser: () => [{ id: CHAT_ID, type: "group", name: "T", last_message_id: MSG_ID }],
        listChatMembersForChats: () => new Map(),
        listMessageFilesByMessageIds: () => [gifRow()],
        hydrateMissingVideoMetadata: async (list) => list,
        cleanupMissingMessageFiles: () => ({ changed: false }),
      },
    });
    const cookie = await login(app);
    const res = await request(app).get("/api/chats").set("Cookie", cookie).query({ username: "alice" });
    expect(res.status).toBe(200);
    expect(res.body.chats[0].last_message_files[0]).toMatchObject({ isAnimated: true, gif: true });
  });

  test("forwarding keeps the flag of the files it carries along", async () => {
    const tmp = realFs.mkdtempSync(realPath.join(os.tmpdir(), "sb-anim-fwd-"));
    try {
      realFs.writeFileSync(realPath.join(tmp, "party.gif"), buildGif({ frames: 3 }));
      const createMessageFiles = vi.fn().mockReturnValue([]);
      const user = { id: ALICE_ID, username: "alice", nickname: "Alice", role: "user", banned: false };
      const { app, sessionStore } = makeApp({
        userStore: makeUserStore([user]),
        deps: {
          fs: realFs,
          path: realPath,
          uploadRootDir: tmp,
          findMessageById: () => ({ id: MSG_ID, chat_id: CHAT_ID, user_id: ALICE_ID, body: "x" }),
          findChatById: (id) => ({ id, type: "group", name: "T" }),
          isMember: () => true,
          listMessageFilesByMessageIds: () => [gifRow()],
          createMessage: () => NEW_MSG_ID,
          createMessageFiles,
          setMessageForwardOrigin: () => {},
          findUserById: () => user,
        },
      });
      sessionStore.createSession(ALICE_ID, "fwd-token");
      const res = await request(app)
        .post("/api/messages/forward")
        .set("Cookie", "sid=fwd-token")
        .send({ username: "alice", sourceMessageId: MSG_ID, targetChatIds: [TARGET_CHAT_ID], body: "x" });
      expect(res.status).toBe(200);
      expect(createMessageFiles).toHaveBeenCalledTimes(1);
      expect(createMessageFiles.mock.calls[0][1][0]).toMatchObject({ mimeType: "image/gif", isAnimated: true });
    } finally {
      realFs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
