import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import realFs from "node:fs";
import realPath from "node:path";
import os from "node:os";
import { makeApp, makeUserStore } from "../helpers/makeApp.js";
import { makeP256PublicKey, b64u } from "../helpers/p256.js";

const ALICE_ID = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
const BOB_ID = "b0b0b0b0-c1c1-4d2d-9e3e-f5f5f5f5f5f5";
const CHAT_ID = "c0c0c0c0-d1d1-4e2e-af3f-060606060606";
const MSG_ID = "d0d0d0d0-e1e1-4f2f-b040-171717171717";

const userRow = (id, username) => ({
  id,
  username,
  password_hash: "x",
  nickname: username,
  avatar_url: null,
  color: "#10b981",
  status: "online",
  role: "user",
  banned: false,
});

function makeEnvelope(senderDeviceId, recipientDeviceId) {
  return {
    v: 1,
    kind: "video_note",
    senderDeviceId,
    iv: b64u(12),
    durationMs: 9000,
    mime: "video/mp4",
    poster: { iv: b64u(12), ct: b64u(500) },
    keys: [
      { deviceId: senderDeviceId, epk: b64u(65), iv: b64u(12), ct: b64u(48) },
      { deviceId: recipientDeviceId, epk: b64u(65), iv: b64u(12), ct: b64u(48) },
    ],
    sig: b64u(64),
  };
}

function makeUploadMiddleware(tmpDir, fileCount = 1) {
  return {
    array: () => (req, _res, next) => {
      req.files = Array.from({ length: fileCount }, (_, i) => {
        const filename = `ciphertext-${i}.bin`;
        const filePath = realPath.join(tmpDir, filename);
        realFs.writeFileSync(filePath, Buffer.alloc(256, 0x5a));
        return {
          originalname: "video-note.bin",
          mimetype: "application/octet-stream",
          filename,
          path: filePath,
          size: 256,
        };
      });
      req.body = req.body || {};
      req.body.chatId = CHAT_ID;
      req.body.username = "alice";
      req.body.uploadType = "document";
      next();
    },
  };
}

describe("POST /api/messages/upload with an E2EE video-note envelope", () => {
  let tmpDir;
  let ctx;
  let aliceDevice;
  let bobDevice;
  let createMessageFiles;
  let setMessageE2eeEnvelope;
  let enqueueVideoTranscodeJob;
  let emitChatEvent;
  let removeUploadedFiles;

  const build = ({ chatType = "dm", fileCount = 1 } = {}) => {
    createMessageFiles = vi.fn().mockReturnValue([]);
    setMessageE2eeEnvelope = vi.fn();
    enqueueVideoTranscodeJob = vi.fn();
    emitChatEvent = vi.fn();
    removeUploadedFiles = vi.fn();
    const userStore = makeUserStore([userRow(ALICE_ID, "alice"), userRow(BOB_ID, "bob")]);
    ctx = makeApp({
      userStore,
      settings: { FILE_UPLOAD: true, FILE_UPLOAD_TRANSCODE_VIDEOS: true },
      deps: {
        fs: realFs,
        path: realPath,
        uploadRootDir: tmpDir,
        storageProcessingMode: "sync",
        MESSAGE_FILE_LIMITS: { maxFiles: 10, maxTotalBytes: 100 * 1024 * 1024 },
        findChatById: () => ({ id: CHAT_ID, type: chatType, name: "Chat" }),
        isMember: () => true,
        getChatMemberRole: () => "owner",
        createOrReuseMessage: () => ({ id: MSG_ID, deduped: false }),
        createMessageFiles,
        setMessageE2eeEnvelope,
        enqueueVideoTranscodeJob,
        emitChatEvent,
        removeUploadedFiles,
        listMessageFilesByMessageIds: () => [],
        hydrateMissingVideoMetadata: async (rows) => rows || [],
        isVideoFileProcessing: () => false,
        probeVideoMetadata: async () => ({}),
        computeExpiryIso: () => null,
        inferMimeFromFilename: () => "",
        decodeOriginalFilename: (f) => f,
        isDangerousUploadFile: () => false,
        hasEnoughFreeDiskSpace: () => true,
        sanitizePositiveInt: (v) => v || null,
        sanitizeDurationSeconds: (v) => v || null,
        parseUploadFileMetadata: () => ({}),
        getUploadKind: () => "document",
        uploadFiles: makeUploadMiddleware(tmpDir, fileCount),
        listChatMembers: () => [userRow(ALICE_ID, "alice"), userRow(BOB_ID, "bob")],
        listMutedUserIdsForChat: () => [],
        storageEncryption: null,
      },
    });
    ctx.sessionStore.createSession(ALICE_ID, "tok-alice");
    aliceDevice = ctx.e2eeStore.createE2eeDevice({
      userId: ALICE_ID, ecdhPublic: makeP256PublicKey(), ecdsaPublic: makeP256PublicKey(),
    });
    bobDevice = ctx.e2eeStore.createE2eeDevice({
      userId: BOB_ID, ecdhPublic: makeP256PublicKey(), ecdsaPublic: makeP256PublicKey(),
    });
  };

  const upload = (envelope) =>
    request(ctx.app)
      .post("/api/messages/upload")
      .set("Cookie", ["sid=tok-alice"])
      .send({ e2eeEnvelope: JSON.stringify(envelope) });

  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(realPath.join(os.tmpdir(), "sb-e2ee-vn-"));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stores the envelope, skips transcoding and announces a video message", async () => {
    build();
    const envelope = makeEnvelope(aliceDevice.id, bobDevice.id);
    const res = await upload(envelope);

    expect(res.status).toBe(200);
    expect(res.body.e2ee.senderDeviceId).toBe(aliceDevice.id);

    expect(setMessageE2eeEnvelope).toHaveBeenCalledTimes(1);
    const [messageId, json] = setMessageE2eeEnvelope.mock.calls[0];
    expect(messageId).toBe(MSG_ID);
    expect(JSON.parse(json).keys).toHaveLength(2);

    const [, files] = createMessageFiles.mock.calls[0];
    expect(files[0].mimeType).toBe("application/octet-stream");
    expect(files[0].kind).toBe("document");
    expect(enqueueVideoTranscodeJob).not.toHaveBeenCalled();

    const event = emitChatEvent.mock.calls.find(([, p]) => p.type === "chat_message")[1];
    expect(event.summaryText).toBe("Sent a video message");
    expect(event.body).toBe("Sent a video message");
    expect(event.e2ee.durationMs).toBe(9000);
  });

  test("rejects a malformed envelope and removes the uploaded file", async () => {
    build();
    const res = await upload({ ...makeEnvelope(aliceDevice.id, bobDevice.id), keys: [] });
    expect(res.status).toBe(400);
    expect(removeUploadedFiles).toHaveBeenCalled();
    expect(setMessageE2eeEnvelope).not.toHaveBeenCalled();
  });

  test("rejects a sender device that is not the caller's", async () => {
    build();
    const res = await upload(makeEnvelope(bobDevice.id, aliceDevice.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/device/i);
    expect(setMessageE2eeEnvelope).not.toHaveBeenCalled();
  });

  test("rejects a revoked sender device", async () => {
    build();
    ctx.e2eeStore.revokeE2eeDevice(ALICE_ID, aliceDevice.id);
    const res = await upload(makeEnvelope(aliceDevice.id, bobDevice.id));
    expect(res.status).toBe(400);
  });

  test("is not available in broadcast channels", async () => {
    build({ chatType: "channel" });
    const res = await upload(makeEnvelope(aliceDevice.id, bobDevice.id));
    expect(res.status).toBe(400);
    expect(setMessageE2eeEnvelope).not.toHaveBeenCalled();
  });

  test("accepts exactly one file", async () => {
    build({ fileCount: 2 });
    const res = await upload(makeEnvelope(aliceDevice.id, bobDevice.id));
    expect(res.status).toBe(400);
  });

  test("works in groups and the saved-messages chat too", async () => {
    for (const type of ["group", "saved"]) {
      build({ chatType: type });
      const res = await upload(makeEnvelope(aliceDevice.id, bobDevice.id));
      expect(res.status).toBe(200);
    }
  });
});

describe("E2EE envelopes in message lists and forwarding", () => {
  const envelope = makeEnvelope("a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5", "b1b1b1b1-c2c2-4d3d-8e4e-f5f5f5f5f5f5");

  const baseRow = (overrides = {}) => ({
    id: MSG_ID,
    chat_id: CHAT_ID,
    user_id: ALICE_ID,
    username: "alice",
    nickname: "Alice",
    avatar_url: null,
    color: "#10b981",
    body: "Sent a video message",
    created_at: new Date().toISOString(),
    edited: 0,
    read_at: null,
    read_by_user_id: null,
    expires_at: null,
    client_request_id: null,
    reply_to_message_id: null,
    reply_id: null,
    hidden_everyone_at: null,
    ...overrides,
  });

  const makeSession = (deps) => {
    const userStore = makeUserStore([userRow(ALICE_ID, "alice"), userRow(BOB_ID, "bob")]);
    const ctx = makeApp({
      userStore,
      deps: {
        isMember: () => true,
        findChatById: () => ({ id: CHAT_ID, type: "dm" }),
        getMessageReadByUser: () => [],
        getMessageReadCounts: () => [],
        listMessageFilesByMessageIds: () => [],
        hydrateMissingVideoMetadata: async (rows) => rows,
        ...deps,
      },
    });
    ctx.sessionStore.createSession(ALICE_ID, "tok-alice");
    return ctx;
  };

  test("GET /api/messages returns the parsed envelope and never the raw column", async () => {
    const ctx = makeSession({
      getMessages: () => ({
        messages: [baseRow({ e2ee_envelope: JSON.stringify(envelope) }), baseRow({ id: "e0e0e0e0-f1f1-4020-c151-282828282828" })],
        hasMore: false,
      }),
    });
    const res = await request(ctx.app)
      .get("/api/messages")
      .set("Cookie", ["sid=tok-alice"])
      .query({ chatId: CHAT_ID, username: "alice" });
    expect(res.status).toBe(200);
    expect(res.body.messages[0].e2ee.kind).toBe("video_note");
    expect(res.body.messages[0].e2ee_envelope).toBeUndefined();
    expect(res.body.messages[1].e2ee).toBeNull();
  });

  test("encrypted messages cannot be forwarded", async () => {
    const ctx = makeSession({
      findMessageById: () => baseRow({ e2ee_envelope: JSON.stringify(envelope) }),
    });
    const res = await request(ctx.app)
      .post("/api/messages/forward")
      .set("Cookie", ["sid=tok-alice"])
      .send({
        username: "alice",
        sourceMessageId: MSG_ID,
        targetChatIds: [CHAT_ID],
        body: "fwd",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end-to-end/i);
  });
});
