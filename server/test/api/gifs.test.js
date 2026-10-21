import { describe, test, expect } from "vitest";
import request from "supertest";
import {
  ALICE_ID,
  BOB_ID,
  CAROL_ID,
  CHAT_ID,
  FOREIGN_MSG_ID,
  MSG_ID,
  MSG_ID_2,
  flush,
  makeGifApp,
} from "../helpers/savedGifFixture.js";
import { buildGif, buildJpeg, buildPng, buildWebp } from "../helpers/imageBytes.js";
import { MAX_FRAMES } from "../../lib/animatedImage.js";

const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";

async function setup(options = {}) {
  const ctx = makeGifApp(options);
  const cookies = {
    alice: await ctx.login("alice"),
    bob: await ctx.login("bob"),
    carol: await ctx.login("carol"),
  };
  const as = (who) => ({
    get: (url) => request(ctx.app).get(url).set("Cookie", cookies[who]),
    post: (url) => request(ctx.app).post(url).set("Cookie", cookies[who]),
    delete: (url) => request(ctx.app).delete(url).set("Cookie", cookies[who]),
  });
  return { ...ctx, cookies, as };
}

// Distinct pictures: the frame count changes the bytes.
const gif = (n = 2) => buildGif({ frames: n });

describe("authentication", () => {
  test.each([
    ["get", "/api/gifs"],
    ["post", "/api/gifs"],
    ["post", "/api/gifs/upload"],
    ["delete", `/api/gifs/${UNKNOWN_ID}`],
    ["get", `/api/gifs/${UNKNOWN_ID}/file`],
  ])("%s %s needs a session", async (method, url) => {
    const { app } = await setup();
    const res = await request(app)[method](url).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated." });
  });

  test("a body is not read for somebody who is not signed in", async () => {
    const { app, storage } = await setup();
    const res = await request(app)
      .post("/api/gifs/upload")
      .attach("file", gif(3), { filename: "a.gif", contentType: "image/gif" });
    expect(res.status).toBe(401);
    expect(storage.calls.writeGif).toEqual([]);
  });

  test("a supplied username must be the signed-in person's", async () => {
    const { as, storage } = await setup();
    const res = await as("alice").post("/api/gifs").send({ username: "bob", messageId: MSG_ID });
    expect(res.status).toBe(403);
    expect(storage.calls.writeGif).toEqual([]);
    const list = await as("alice").get("/api/gifs?username=bob");
    expect(list.status).toBe(403);
  });

  test("a banned account is refused even with a live session", async () => {
    const { as, userStore } = await setup();
    userStore.users.get("alice").banned = 1;
    for (const res of [
      await as("alice").get("/api/gifs"),
      await as("alice").post("/api/gifs").send({ messageId: MSG_ID }),
      await as("alice").delete(`/api/gifs/${UNKNOWN_ID}`),
      await as("alice").get(`/api/gifs/${UNKNOWN_ID}/file`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Account is banned." });
    }
  });
});

describe("GET /api/gifs", () => {
  test("an empty collection", async () => {
    const { as } = await setup();
    const res = await as("alice").get("/api/gifs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gifs: [], limit: 50, count: 0 });
  });

  test("lists the newest first, with exactly the documented fields", async () => {
    const { as, addFile } = await setup();
    const first = addFile(MSG_ID, buildGif({ frames: 2, width: 40, height: 30 }));
    const second = addFile(MSG_ID, buildGif({ frames: 3, width: 64, height: 48 }));
    const a = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: first.id });
    const b = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: second.id });
    expect([a.status, b.status]).toEqual([201, 201]);

    const res = await as("alice").get("/api/gifs");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.count).toBe(2);
    expect(res.body.gifs.map((g) => g.id)).toEqual([b.body.gif.id, a.body.gif.id]);
    expect(Object.keys(res.body.gifs[0]).sort()).toEqual(
      ["createdAt", "height", "id", "mime", "size", "thumbUrl", "url", "width"].sort(),
    );
    expect(res.body.gifs[0]).toMatchObject({
      url: `/api/gifs/${b.body.gif.id}/file`,
      thumbUrl: null,
      width: 64,
      height: 48,
      mime: "image/gif",
    });
    expect(res.body.gifs[0].size).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(res.body.gifs[0].createdAt))).toBe(false);
  });

  test("never reveals storage keys, owners, hashes or where a GIF came from", async () => {
    const { as, addFile, gifStore } = await setup();
    const file = addFile(MSG_ID, gif(2));
    await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    const text = JSON.stringify((await as("alice").get("/api/gifs")).body);
    const row = gifStore.rows[0];
    for (const secret of [row.storage_key, row.sha256, ALICE_ID, MSG_ID, "storage", "sha256", "user_id"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("shows each person only their own collection", async () => {
    const { as, addFile } = await setup();
    const fileA = addFile(MSG_ID, gif(2));
    const fileB = addFile(MSG_ID, gif(3));
    const mine = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: fileA.id });
    const his = await as("bob").post("/api/gifs").send({ messageId: MSG_ID, fileId: fileB.id });

    const alices = (await as("alice").get("/api/gifs")).body;
    const bobs = (await as("bob").get("/api/gifs")).body;
    const carols = (await as("carol").get("/api/gifs")).body;
    expect(alices.gifs.map((g) => g.id)).toEqual([mine.body.gif.id]);
    expect(bobs.gifs.map((g) => g.id)).toEqual([his.body.gif.id]);
    expect(carols).toEqual({ gifs: [], limit: 50, count: 0 });
  });

  test("the limit follows the admin setting, live", async () => {
    const { as } = await setup({ settings: { MAX_SAVED_GIFS: 7 } });
    expect((await as("alice").get("/api/gifs")).body.limit).toBe(7);
  });

  test("a silly setting is clamped to 1-200", async () => {
    expect((await (await setup({ settings: { MAX_SAVED_GIFS: 9999 } })).as("alice").get("/api/gifs")).body.limit).toBe(200);
    expect((await (await setup({ settings: { MAX_SAVED_GIFS: 0 } })).as("alice").get("/api/gifs")).body.limit).toBe(1);
  });

  test("is rate limited per person", async () => {
    const { as } = await setup();
    let last;
    for (let i = 0; i < 61; i += 1) last = await as("alice").get("/api/gifs");
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/too many/i);
    // Somebody else is not affected.
    expect((await as("bob").get("/api/gifs")).status).toBe(200);
  });
});

describe("POST /api/gifs (save from a message)", () => {
  test("copies the GIF into the person's own storage and answers with the documented shape", async () => {
    const { as, addFile, storage, gifStore, userEvents } = await setup();
    const bytes = buildGif({ frames: 4, width: 320, height: 200 });
    const file = addFile(MSG_ID, bytes);

    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      gif: {
        id: expect.any(String),
        url: expect.stringMatching(/^\/api\/gifs\/[0-9a-f-]{36}\/file$/),
        thumbUrl: null,
        width: 320,
        height: 200,
        mime: "image/gif",
        size: bytes.length,
        createdAt: expect.any(String),
      },
      evicted: [],
      limit: 50,
      count: 1,
    });

    // A copy, under the person's own key, never the message's file.
    const [key] = [...storage.gifs.keys()];
    expect(key).toBe(`gifs/${ALICE_ID}/${res.body.gif.id}.gif`);
    expect(storage.gifs.get(key).equals(bytes)).toBe(true);
    expect(gifStore.rows[0]).toMatchObject({
      user_id: ALICE_ID,
      storage_key: key,
      source_message_id: MSG_ID,
      source_file_id: String(file.id),
      frames: 4,
    });
    expect(storage.messageFiles.has(`*:${file.stored_name}`)).toBe(true);
    expect(key).not.toContain(file.stored_name);

    await flush();
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].username).toBe("alice");
    expect(userEvents[0].payload).toEqual({
      type: "saved_gif_added",
      gif: res.body.gif,
      evicted: [],
      limit: 50,
      count: 1,
    });
  });

  test("the file can be named by id, by index, or left out (the first one)", async () => {
    const { as, addFile } = await setup();
    const first = addFile(MSG_ID_2, gif(2));
    const second = addFile(MSG_ID_2, gif(3));

    const byId = await as("bob").post("/api/gifs").send({ messageId: MSG_ID_2, fileId: second.id });
    const byIndex = await as("bob").post("/api/gifs").send({ messageId: MSG_ID_2, fileIndex: 0 });
    const byDefault = await as("alice").post("/api/gifs").send({ messageId: MSG_ID_2 });
    expect([byId.status, byIndex.status, byDefault.status]).toEqual([201, 201, 201]);

    const bobsSizes = (await as("bob").get("/api/gifs")).body.gifs.map((g) => g.size).sort();
    expect(bobsSizes).toEqual([gif(2).length, gif(3).length].sort());
    expect((await as("alice").get("/api/gifs")).body.gifs[0].size).toBe(gif(2).length);
    expect(first.id).toBeLessThan(second.id);
  });

  test("saving the same file again returns the same GIF, with no eviction and no second copy", async () => {
    const { as, addFile, storage } = await setup({ settings: { MAX_SAVED_GIFS: 1 } });
    const file = addFile(MSG_ID, gif(3));
    const first = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    const again = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ gif: first.body.gif, evicted: [], limit: 1, count: 1, existing: true });
    expect(storage.calls.writeGif).toHaveLength(1);
    expect(storage.calls.removeGifs).toEqual([]);
  });

  test("the same picture from another message is the same GIF, too", async () => {
    const { as, addFile, storage } = await setup({ settings: { MAX_SAVED_GIFS: 2 } });
    const bytes = gif(3);
    const one = addFile(MSG_ID, bytes);
    const two = addFile(MSG_ID_2, bytes); // forwarded copy: other file row, same bytes
    const first = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: one.id });
    const again = await as("alice").post("/api/gifs").send({ messageId: MSG_ID_2, fileId: two.id });
    expect(again.status).toBe(200);
    expect(again.body.gif.id).toBe(first.body.gif.id);
    expect(again.body.evicted).toEqual([]);
    expect(storage.calls.writeGif).toHaveLength(1);
  });

  test("animated WebP and animated PNG are saved too, with their own type", async () => {
    const { as, addFile, storage } = await setup();
    const webp = addFile(MSG_ID, buildWebp({ animated: true, frames: 3 }), { mime_type: "image/webp", original_name: "a.webp" });
    const png = addFile(MSG_ID, buildPng({ animated: true, frames: 3 }), { mime_type: "image/png", original_name: "a.png" });
    const a = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: webp.id });
    const b = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: png.id });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.gif.mime).toBe("image/webp");
    expect(b.body.gif.mime).toBe("image/png");
    expect([...storage.gifs.keys()].map((k) => k.split(".").pop()).sort()).toEqual(["png", "webp"]);
  });

  test("the type is decided by the bytes: a GIF named .jpg with the wrong content type is still a GIF", async () => {
    const { as, addFile } = await setup();
    const file = addFile(MSG_ID, gif(3), { mime_type: "image/gif", original_name: "photo.jpg" });
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(201);
    expect(res.body.gif.mime).toBe("image/gif");
  });

  test.each([
    ["a still GIF", () => buildGif({ frames: 1 }), {}, "gif_not_animated"],
    ["a still WebP", () => buildWebp({ animated: false }), { mime_type: "image/webp" }, "gif_not_animated"],
    ["a plain PNG", () => buildPng(), { mime_type: "image/png" }, "gif_not_animated"],
    ["a JPEG", () => buildJpeg(), { mime_type: "image/jpeg", original_name: "p.jpg" }, "gif_unsupported"],
    ["a video", () => Buffer.from("video bytes"), { mime_type: "video/mp4", original_name: "v.mp4" }, "gif_unsupported"],
    ["a PDF", () => Buffer.from("%PDF-1.4"), { mime_type: "application/pdf", original_name: "d.pdf" }, "gif_unsupported"],
    ["HTML dressed up as a GIF", () => Buffer.from("<html><script>alert(1)</script></html>"), {}, "gif_unsupported"],
    ["an SVG dressed up as a GIF", () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), {}, "gif_unsupported"],
    ["a GIF with too many frames", () => buildGif({ frames: MAX_FRAMES + 1 }), {}, "gif_too_many_frames"],
    ["a GIF with absurd dimensions", () => buildGif({ width: 60000, height: 60000, frames: 2 }), {}, "gif_dimensions"],
  ])("refuses %s", async (_label, build, overrides, code) => {
    const { as, addFile, storage, gifStore } = await setup();
    const file = addFile(MSG_ID, build(), overrides);
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe("string");
    expect(storage.calls.writeGif).toEqual([]);
    expect(gifStore.rows).toEqual([]);
  });

  test("a file announced as larger than 20 MB is refused without being read", async () => {
    const { as, addFile, storage } = await setup();
    const file = addFile(MSG_ID, gif(2), { size_bytes: 20 * 1024 * 1024 + 1 });
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("gif_too_large");
    expect(storage.calls.writeGif).toEqual([]);
  });

  test("the server's own per-file limit applies when it is lower than 20 MB", async () => {
    const small = {
      MESSAGE_FILE_LIMITS: { maxFiles: 10, maxFileSizeBytes: 1000, maxTotalBytes: 100000 },
    };
    const { as, addFile, storage } = await setup({ deps: small });
    const file = addFile(MSG_ID, buildGif({ frames: 2, padTo: 2000 }));
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("gif_too_large");
    expect(storage.calls.writeGif).toEqual([]);
  });

  test("files that cannot be pictures are never even read", async () => {
    const { as, addFile, storage } = await setup();
    let reads = 0;
    const original = storage.readMessageFile;
    storage.readMessageFile = async (...args) => {
      reads += 1;
      return original(...args);
    };
    const file = addFile(MSG_ID, Buffer.from("x"), { mime_type: "video/mp4", original_name: "clip.mp4" });
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(400);
    expect(reads).toBe(0);
  });

  describe("who may save what", () => {
    test("somebody outside the chat gets the same answer as for a message that does not exist", async () => {
      const { as, addFile } = await setup();
      const file = addFile(MSG_ID, gif(2));
      const outsider = await as("carol").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      const missing = await as("carol").post("/api/gifs").send({ messageId: UNKNOWN_ID, fileId: file.id });
      expect(outsider.status).toBe(404);
      expect(outsider.body).toEqual({ error: "Message not found." });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual(outsider.body);
    });

    test("nothing is stored or read for an outsider", async () => {
      const { as, addFile, storage, gifStore } = await setup();
      const file = addFile(MSG_ID, gif(2));
      await as("carol").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      expect(storage.calls.writeGif).toEqual([]);
      expect(gifStore.rows).toEqual([]);
    });

    test("a message of another chat is not reachable by a member of this one", async () => {
      const { as, addFile } = await setup();
      const file = addFile(FOREIGN_MSG_ID, gif(2));
      const res = await as("alice").post("/api/gifs").send({ messageId: FOREIGN_MSG_ID, fileId: file.id });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Message not found." });
    });

    test("somebody who left the chat can no longer save from it", async () => {
      const { as, addFile, chatMembers } = await setup();
      const file = addFile(MSG_ID, gif(2));
      const before = await as("bob").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      expect(before.status).toBe(201);
      chatMembers.splice(
        chatMembers.findIndex((m) => m.id === BOB_ID),
        1,
      );
      const other = addFile(MSG_ID, gif(3));
      const after = await as("bob").post("/api/gifs").send({ messageId: MSG_ID, fileId: other.id });
      expect(after.status).toBe(404);
      // What they saved while they were a member stays theirs.
      expect((await as("bob").get("/api/gifs")).body.count).toBe(1);
    });

    test("a message deleted for everyone is gone", async () => {
      const { as, addFile, messages } = await setup();
      const file = addFile(MSG_ID, gif(2));
      messages.get(MSG_ID).hidden_everyone_at = "2026-01-01 00:00:00";
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      expect(res.status).toBe(404);
    });

    test("a message the person deleted for themselves is gone for them only", async () => {
      const { as, addFile, hide } = await setup();
      const file = addFile(MSG_ID, gif(2));
      hide(MSG_ID, ALICE_ID);
      expect((await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id })).status).toBe(404);
      expect((await as("bob").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id })).status).toBe(201);
    });

    test("an end-to-end encrypted message holds no picture the server can read", async () => {
      const { as, addFile, messages } = await setup();
      const file = addFile(MSG_ID, gif(2));
      messages.get(MSG_ID).e2ee_envelope = '{"v":1}';
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("gif_unsupported");
    });

    test("a file id that belongs to another message is not found", async () => {
      const { as, addFile } = await setup();
      addFile(MSG_ID, gif(2));
      const elsewhere = addFile(MSG_ID_2, gif(3));
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: elsewhere.id });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "File not found." });
    });

    test("an index beyond the message's files, and a message without files, are not found", async () => {
      const { as, addFile } = await setup();
      addFile(MSG_ID, gif(2));
      expect((await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileIndex: 1 })).status).toBe(404);
      expect((await as("alice").post("/api/gifs").send({ messageId: MSG_ID_2 })).status).toBe(404);
    });

    test("a file past its retention date is not found even if the bytes are still on disk", async () => {
      const { as, addFile } = await setup();
      const file = addFile(MSG_ID, gif(2), { expires_at: new Date(Date.now() - 1000).toISOString() });
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "File not found." });
    });

    test("a file whose bytes are gone is not found", async () => {
      const { as, addFile, storage } = await setup();
      const file = addFile(MSG_ID, gif(2));
      storage.messageFiles.clear();
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "File not found." });
    });
  });

  test("is refused while file uploads are switched off", async () => {
    const { as, addFile } = await setup({ settings: { FILE_UPLOAD: false } });
    const file = addFile(MSG_ID, gif(2));
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "File uploads are disabled on this server." });
  });

  test.each([
    ["no body", undefined],
    ["no message id", {}],
    ["a message id that is not a UUID", { messageId: "nope" }],
    ["a message id that is an array", { messageId: [MSG_ID] }],
    ["both a file id and an index", { messageId: MSG_ID, fileId: 1, fileIndex: 0 }],
    ["a negative index", { messageId: MSG_ID, fileIndex: -1 }],
    ["a file id that is an object", { messageId: MSG_ID, fileId: { $gt: 0 } }],
  ])("is refused with %s", async (_label, body) => {
    const { as } = await setup();
    const req = as("alice").post("/api/gifs");
    const res = await (body === undefined ? req : req.send(body));
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  describe("the limit", () => {
    test("the oldest GIF is removed, its file deleted, and the answer says so", async () => {
      const { as, addFile, storage, gifStore, userEvents } = await setup({ settings: { MAX_SAVED_GIFS: 2 } });
      const files = [addFile(MSG_ID, gif(2)), addFile(MSG_ID, gif(3)), addFile(MSG_ID, gif(4))];
      const saved = [];
      for (const file of files.slice(0, 2)) {
        saved.push((await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id })).body.gif);
      }
      const oldestKey = gifStore.rows[0].storage_key;
      userEvents.length = 0;

      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: files[2].id });
      expect(res.status).toBe(201);
      expect(res.body.evicted).toEqual([{ id: saved[0].id }]);
      expect(res.body.limit).toBe(2);
      expect(res.body.count).toBe(2);

      expect(storage.gifs.has(oldestKey)).toBe(false);
      expect(storage.calls.removeGifs.at(-1)).toEqual([saved[0].id]);
      const list = (await as("alice").get("/api/gifs")).body;
      expect(list.gifs.map((g) => g.id)).toEqual([res.body.gif.id, saved[1].id]);

      await flush();
      expect(userEvents.at(-1).payload).toMatchObject({
        type: "saved_gif_added",
        evicted: [{ id: saved[0].id }],
        limit: 2,
        count: 2,
      });
    });

    test("with a limit of 50, the 51st pushes out the first", async () => {
      const { as, addFile } = await setup();
      const ids = [];
      for (let i = 0; i < 50; i += 1) {
        const file = addFile(MSG_ID, buildGif({ frames: 2, width: 10 + i, height: 10 }));
        const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
        // The write throttle allows 60 a minute; this stays under it.
        expect(res.status).toBe(201);
        ids.push(res.body.gif.id);
      }
      expect((await as("alice").get("/api/gifs")).body.count).toBe(50);
      const extra = addFile(MSG_ID, buildGif({ frames: 2, width: 200, height: 10 }));
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: extra.id });
      expect(res.body.evicted).toEqual([{ id: ids[0] }]);
      expect(res.body.limit).toBe(50);
      expect(res.body.count).toBe(50);
    });

    test("only the person who is over the limit loses GIFs", async () => {
      const { as, addFile } = await setup({ settings: { MAX_SAVED_GIFS: 1 } });
      const f1 = addFile(MSG_ID, gif(2));
      const f2 = addFile(MSG_ID, gif(3));
      const bobs = await as("bob").post("/api/gifs").send({ messageId: MSG_ID, fileId: f1.id });
      await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: f1.id });
      const second = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: f2.id });
      expect(second.body.evicted).toHaveLength(1);
      expect((await as("bob").get("/api/gifs")).body.gifs.map((g) => g.id)).toEqual([bobs.body.gif.id]);
    });

    test("an outdated file on disk does not block the new GIF: eviction cleanup failures are not the user's problem", async () => {
      const { as, addFile, storage } = await setup({ settings: { MAX_SAVED_GIFS: 1 } });
      const f1 = addFile(MSG_ID, gif(2));
      const f2 = addFile(MSG_ID, gif(3));
      await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: f1.id });
      storage.removeGifs = async () => {
        throw new Error("bucket unreachable");
      };
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: f2.id });
      expect(res.status).toBe(201);
      expect(res.body.evicted).toHaveLength(1);
    });
  });

  describe("when something fails", () => {
    test("a failing write stores nothing and evicts nothing", async () => {
      const { as, addFile, storage, gifStore } = await setup({ settings: { MAX_SAVED_GIFS: 1 } });
      const f1 = addFile(MSG_ID, gif(2));
      const f2 = addFile(MSG_ID, gif(3));
      await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: f1.id });
      storage.state.failWrite = true;
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: f2.id });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Unable to save the GIF." });
      expect(gifStore.rows).toHaveLength(1);
      expect(storage.calls.removeGifs).toEqual([]);
    });

    test("a failing database write removes the bytes that were just stored", async () => {
      const { as, addFile, storage, gifStore } = await setup();
      const file = addFile(MSG_ID, gif(2));
      gifStore.failNextInsert = true;
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      expect(res.status).toBe(500);
      expect(storage.gifs.size).toBe(0);
    });

    test("a request that lost a race for the same bytes removes its own copy", async () => {
      const { as, addFile, storage, gifStore } = await setup();
      const file = addFile(MSG_ID, gif(2));
      const first = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
      // The duplicate check missed (it ran before the other request committed)...
      const lookup = gifStore.findSavedGifByHash;
      gifStore.findSavedGifByHash = () => null;
      const other = addFile(MSG_ID_2, gif(2));
      // ...but the transaction knows better.
      const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID_2, fileId: other.id });
      gifStore.findSavedGifByHash = lookup;
      expect(res.status).toBe(200);
      expect(res.body.gif.id).toBe(first.body.gif.id);
      expect(storage.gifs.size).toBe(1);
    });
  });

  test("is rate limited per person", async () => {
    const { as, addFile } = await setup({ settings: { MAX_SAVED_GIFS: 200 } });
    const file = addFile(MSG_ID, gif(2));
    let last;
    for (let i = 0; i < 61; i += 1) last = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/too many/i);
    expect((await as("bob").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id })).status).toBe(201);
  });
});

describe("POST /api/gifs/upload (add from the device)", () => {
  const upload = (as, who, bytes, { filename = "funny.gif", contentType = "image/gif", field = "file" } = {}) =>
    as(who).post("/api/gifs/upload").attach(field, bytes, { filename, contentType });

  test("stores an animated GIF and answers like a save does", async () => {
    const { as, storage, gifStore, userEvents } = await setup();
    const bytes = buildGif({ frames: 5, width: 120, height: 90 });
    const res = await upload(as, "alice", bytes);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      gif: {
        id: expect.any(String),
        url: `/api/gifs/${res.body.gif.id}/file`,
        thumbUrl: null,
        width: 120,
        height: 90,
        mime: "image/gif",
        size: bytes.length,
        createdAt: expect.any(String),
      },
      evicted: [],
      limit: 50,
      count: 1,
    });
    expect(storage.gifs.get(`gifs/${ALICE_ID}/${res.body.gif.id}.gif`).equals(bytes)).toBe(true);
    expect(gifStore.rows[0]).toMatchObject({ source_message_id: null, source_file_id: null, frames: 5 });
    await flush();
    expect(userEvents.at(-1).payload.type).toBe("saved_gif_added");
  });

  test("the name and content type the browser sent decide nothing", async () => {
    const { as, storage } = await setup();
    const res = await upload(as, "alice", buildGif({ frames: 3 }), { filename: "../../evil.html", contentType: "text/html" });
    expect(res.status).toBe(201);
    expect(res.body.gif.mime).toBe("image/gif");
    expect([...storage.gifs.keys()][0]).toMatch(/^gifs\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.gif$/);
  });

  test("an animated WebP and an animated PNG are fine", async () => {
    const { as } = await setup();
    expect((await upload(as, "alice", buildWebp({ animated: true, frames: 3 }), { filename: "a.webp", contentType: "image/webp" })).body.gif.mime).toBe("image/webp");
    expect((await upload(as, "alice", buildPng({ animated: true, frames: 3 }), { filename: "a.png", contentType: "image/png" })).body.gif.mime).toBe("image/png");
  });

  test.each([
    ["a still GIF", () => buildGif({ frames: 1 }), "gif_not_animated"],
    ["a JPEG", () => buildJpeg(), "gif_unsupported"],
    ["an HTML page named .gif", () => Buffer.from("<html><body>hi</body></html>"), "gif_unsupported"],
    ["too many frames", () => buildGif({ frames: MAX_FRAMES + 1 }), "gif_too_many_frames"],
    ["absurd dimensions", () => buildGif({ width: 60000, height: 60000, frames: 2 }), "gif_dimensions"],
    ["an empty file", () => Buffer.alloc(0), "gif_empty"],
  ])("refuses %s", async (_label, build, code) => {
    const { as, storage, gifStore } = await setup();
    const res = await upload(as, "alice", build());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(storage.calls.writeGif).toEqual([]);
    expect(gifStore.rows).toEqual([]);
  });

  test("the server's own per-file limit applies to uploads too, when it is lower than 20 MB", async () => {
    const { as, storage } = await setup({
      deps: { MESSAGE_FILE_LIMITS: { maxFiles: 10, maxFileSizeBytes: 1000, maxTotalBytes: 100000 } },
    });
    const res = await upload(as, "alice", buildGif({ frames: 2, padTo: 2000 }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("gif_too_large");
    expect(storage.calls.writeGif).toEqual([]);
    expect((await upload(as, "alice", buildGif({ frames: 2 }))).status).toBe(201);
  });

  test("refuses a file over 20 MB", async () => {
    const { as, storage } = await setup();
    const big = Buffer.concat([buildGif({ frames: 2 }), Buffer.alloc(20 * 1024 * 1024)]);
    const res = await upload(as, "alice", big);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("gif_too_large");
    expect(res.body.error).toMatch(/20 MB/);
    expect(storage.calls.writeGif).toEqual([]);
  });

  test("a file of exactly 20 MB is accepted", async () => {
    const { as } = await setup();
    const exactly = buildGif({ frames: 2, padTo: 20 * 1024 * 1024 });
    expect(exactly.length).toBe(20 * 1024 * 1024);
    const res = await upload(as, "alice", exactly);
    expect(res.status).toBe(201);
  });

  test("needs a file, in the field 'file', and only one", async () => {
    const { as } = await setup();
    const none = await as("alice").post("/api/gifs/upload").field("note", "hi");
    expect(none.status).toBe(400);
    expect(none.body.code).toBe("gif_missing");

    const wrongField = await upload(as, "alice", gif(3), { field: "gif" });
    expect(wrongField.status).toBe(400);

    const two = await as("alice")
      .post("/api/gifs/upload")
      .attach("file", gif(3), { filename: "a.gif", contentType: "image/gif" })
      .attach("file", gif(4), { filename: "b.gif", contentType: "image/gif" });
    expect(two.status).toBe(400);
  });

  test("not enough free space on the server: nothing is stored (as for every other upload)", async () => {
    const { as, storage, gifStore } = await setup({ deps: { hasEnoughFreeDiskSpace: () => false } });
    const res = await upload(as, "alice", gif(3));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Not enough free storage space on server." });
    expect(storage.calls.writeGif).toEqual([]);
    expect(gifStore.rows).toEqual([]);
  });

  test("the free space asked for is the size of the file", async () => {
    const asked = [];
    const bytes = gif(3);
    const { as } = await setup({ deps: { hasEnoughFreeDiskSpace: (n) => { asked.push(n); return true; } } });
    expect((await upload(as, "alice", bytes)).status).toBe(201);
    expect(asked).toEqual([bytes.length]);
  });

  test("a picture that is already saved needs no space", async () => {
    const { as, deps } = await setup();
    const bytes = gif(3);
    expect((await upload(as, "alice", bytes)).status).toBe(201);
    deps.hasEnoughFreeDiskSpace = () => false;
    expect((await upload(as, "alice", bytes)).status).toBe(200);
  });

  test("saving from a message is held to the same free-space check", async () => {
    const { as, addFile, storage, gifStore, deps } = await setup();
    const file = addFile(MSG_ID, buildGif({ frames: 3 }));
    deps.hasEnoughFreeDiskSpace = () => false;
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Not enough free storage space on server." });
    expect(storage.calls.writeGif).toEqual([]);
    expect(gifStore.rows).toEqual([]);
  });

  test("with remote storage there is no local disk to protect", async () => {
    const { as } = await setup({
      deps: { hasEnoughFreeDiskSpace: () => false, storageProvider: { type: "s3" } },
    });
    expect((await upload(as, "alice", gif(3))).status).toBe(201);
  });

  test("saving the same file twice is a no-op", async () => {
    const { as, storage } = await setup({ settings: { MAX_SAVED_GIFS: 1 } });
    const bytes = gif(3);
    const first = await upload(as, "alice", bytes);
    const again = await upload(as, "alice", bytes);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ gif: first.body.gif, evicted: [], limit: 1, count: 1, existing: true });
    expect(storage.calls.writeGif).toHaveLength(1);
  });

  test("a message the person saved and the same file uploaded from the device are one GIF", async () => {
    const { as, addFile } = await setup();
    const bytes = gif(3);
    const file = addFile(MSG_ID, bytes);
    const fromMessage = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    const fromDevice = await upload(as, "alice", bytes);
    expect(fromDevice.body.gif.id).toBe(fromMessage.body.gif.id);
  });

  test("the limit applies: the oldest goes", async () => {
    const { as, storage } = await setup({ settings: { MAX_SAVED_GIFS: 2 } });
    const a = await upload(as, "alice", gif(2));
    await upload(as, "alice", gif(3));
    const c = await upload(as, "alice", gif(4));
    expect(c.status).toBe(201);
    expect(c.body.evicted).toEqual([{ id: a.body.gif.id }]);
    expect(storage.gifs.size).toBe(2);
  });

  test("is refused while file uploads are switched off", async () => {
    const { as } = await setup({ settings: { FILE_UPLOAD: false } });
    const res = await upload(as, "alice", gif(2));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "File uploads are disabled on this server." });
  });

  test("uploading is rate limited more tightly than saving", async () => {
    const { as } = await setup({ settings: { MAX_SAVED_GIFS: 200 } });
    let last;
    for (let i = 0; i < 11; i += 1) last = await upload(as, "alice", buildGif({ frames: 2, width: 10 + i, height: 10 }));
    expect(last.status).toBe(429);
    expect((await upload(as, "bob", gif(2))).status).toBe(201);
  });
});

describe("DELETE /api/gifs/:id", () => {
  async function withOne(options) {
    const ctx = await setup(options);
    const file = ctx.addFile(MSG_ID, gif(3));
    const saved = await ctx.as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    ctx.userEvents.length = 0;
    return { ...ctx, saved: saved.body.gif };
  }

  test("removes the GIF and its file, and tells the person's other devices", async () => {
    const { as, saved, storage, userEvents } = await withOne();
    const res = await as("alice").delete(`/api/gifs/${saved.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: saved.id, limit: 50, count: 0 });
    expect(storage.gifs.size).toBe(0);
    expect((await as("alice").get("/api/gifs")).body.count).toBe(0);
    await flush();
    expect(userEvents).toEqual([
      { username: "alice", payload: { type: "saved_gif_removed", gifId: saved.id, limit: 50, count: 0 } },
    ]);
  });

  test("somebody else's GIF is not found, exactly like one that never existed, and stays", async () => {
    const { as, saved, storage, userEvents } = await withOne();
    const intruder = await as("bob").delete(`/api/gifs/${saved.id}`);
    const missing = await as("bob").delete(`/api/gifs/${UNKNOWN_ID}`);
    expect(intruder.status).toBe(404);
    expect(intruder.body).toEqual({ error: "GIF not found." });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(intruder.body);
    expect(storage.gifs.size).toBe(1);
    expect((await as("alice").get("/api/gifs")).body.count).toBe(1);
    expect(userEvents).toEqual([]);
  });

  test("deleting twice: the second time it is not found", async () => {
    const { as, saved } = await withOne();
    expect((await as("alice").delete(`/api/gifs/${saved.id}`)).status).toBe(200);
    expect((await as("alice").delete(`/api/gifs/${saved.id}`)).status).toBe(404);
  });

  test("an id that is not a UUID is a bad request", async () => {
    const { as } = await withOne();
    const res = await as("alice").delete("/api/gifs/not-a-uuid");
    expect(res.status).toBe(400);
  });

  test("a failing file removal does not bring the GIF back", async () => {
    const { as, saved, storage } = await withOne();
    storage.removeGifs = async () => {
      throw new Error("bucket unreachable");
    };
    const res = await as("alice").delete(`/api/gifs/${saved.id}`);
    expect(res.status).toBe(200);
    expect((await as("alice").get("/api/gifs")).body.count).toBe(0);
  });

  test("makes room: after a delete the next save evicts nothing", async () => {
    const { as, addFile } = await withOne({ settings: { MAX_SAVED_GIFS: 1 } });
    const list = (await as("alice").get("/api/gifs")).body;
    await as("alice").delete(`/api/gifs/${list.gifs[0].id}`);
    const file = addFile(MSG_ID, gif(5));
    const res = await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    expect(res.body.evicted).toEqual([]);
  });
});

describe("GET /api/gifs/:id/file", () => {
  async function withOne(options) {
    const ctx = await setup(options);
    const bytes = buildGif({ frames: 3, width: 33, height: 22 });
    const file = ctx.addFile(MSG_ID, bytes);
    const saved = await ctx.as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id });
    return { ...ctx, bytes, saved: saved.body.gif };
  }

  test("streams the bytes to the owner with safe headers", async () => {
    const { as, saved, bytes } = await withOne();
    const res = await as("alice").get(`/api/gifs/${saved.id}/file`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(bytes)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/gif");
    expect(res.headers["content-length"]).toBe(String(bytes.length));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toMatch(/private/);
    expect(res.headers["cache-control"]).not.toMatch(/public/);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  test("somebody else gets nothing: the answer is the same as for an id that does not exist", async () => {
    const { as, saved } = await withOne();
    const intruder = await as("bob").get(`/api/gifs/${saved.id}/file`);
    const missing = await as("bob").get(`/api/gifs/${UNKNOWN_ID}/file`);
    expect(intruder.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(intruder.body).toEqual({ error: "GIF not found." });
    expect(missing.body).toEqual(intruder.body);
    expect(intruder.headers["content-type"]).toMatch(/json/);
  });

  test("a GIF whose bytes are gone is not found", async () => {
    const { as, saved, storage } = await withOne();
    storage.gifs.clear();
    const res = await as("alice").get(`/api/gifs/${saved.id}/file`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "GIF file not found." });
  });

  test("the content type comes from a short list, whatever the row says", async () => {
    const { as, saved, gifStore } = await withOne();
    gifStore.rows[0].mime = "text/html";
    const res = await as("alice").get(`/api/gifs/${saved.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe("attachment");
  });

  test("a row that points at another person's file is never served", async () => {
    const { as, saved, gifStore, storage } = await withOne();
    // Bob keeps a GIF of his own; Alice's row is tampered to point at it.
    const bobFile = (await setupBobFile(as, storage));
    gifStore.rows[0].storage_key = bobFile.key;
    const res = await as("alice").get(`/api/gifs/${saved.id}/file`);
    expect(res.status).toBe(404);
  });

  test("an id that is not a UUID is a bad request", async () => {
    const { as } = await withOne();
    expect((await as("alice").get("/api/gifs/../file")).status).toBeGreaterThanOrEqual(400);
    expect((await as("alice").get("/api/gifs/not-a-uuid/file")).status).toBe(400);
  });

  test("is rate limited per person, generously", async () => {
    const { as, saved } = await withOne();
    let last;
    for (let i = 0; i < 301; i += 1) last = await as("alice").get(`/api/gifs/${saved.id}/file`);
    expect(last.status).toBe(429);
  }, 30000);
});

async function setupBobFile(as, storage) {
  // Bob saves a GIF of his own through the real route.
  const { default: crypto } = await import("node:crypto");
  const key = `gifs/${BOB_ID}/${crypto.randomUUID()}.gif`;
  storage.gifs.set(key, buildGif({ frames: 6 }));
  return { key };
}

describe("everything is per person: Bob cannot reach Alice's collection in any way", () => {
  test("list, file, delete and send are all closed to him", async () => {
    const { as, addFile, storage, gifStore } = await setup();
    const file = addFile(MSG_ID, gif(3));
    const saved = (await as("alice").post("/api/gifs").send({ messageId: MSG_ID, fileId: file.id })).body.gif;

    expect((await as("bob").get("/api/gifs")).body.gifs).toEqual([]);
    expect((await as("bob").get(`/api/gifs/${saved.id}/file`)).status).toBe(404);
    expect((await as("bob").delete(`/api/gifs/${saved.id}`)).status).toBe(404);
    const send = await as("bob").post("/api/messages").send({ chatId: CHAT_ID, username: "bob", savedGifId: saved.id });
    expect(send.status).toBe(404);
    expect(send.body).toEqual({ error: "GIF not found." });

    // Still all there for Alice.
    expect(gifStore.rows).toHaveLength(1);
    expect(storage.gifs.size).toBe(1);
    expect(storage.calls.writeMessageCopy).toEqual([]);
    expect((await as("alice").get(`/api/gifs/${saved.id}/file`)).status).toBe(200);
  });

  test("and Carol, who is in none of the chats, saved nothing and sees nothing", async () => {
    const { as } = await setup();
    expect((await as("carol").get("/api/gifs")).body).toEqual({ gifs: [], limit: 50, count: 0 });
    expect(CAROL_ID).toBeTruthy();
  });
});
