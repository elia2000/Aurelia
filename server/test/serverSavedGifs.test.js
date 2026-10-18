import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGif, buildJpeg } from "./helpers/imageBytes.js";

// The real server (index.js with its real database, storage and wiring),
// driven over HTTP: the unit and API tests inject their own database and
// storage, so only this proves that GIFs are connected end to end - uploaded
// and kept animated, saved per person, evicted oldest first, sent as copies and
// deleted with the account.

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const LIMIT = 3;

describe("saved GIFs on the real server", () => {
  let child;
  let dataDir;
  let base;
  let log = "";
  const people = {};
  const events = { alice: [], bob: [], carol: [] };
  const streams = [];
  let dm;

  async function api(method, url, cookie, body) {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // no body
    }
    return { status: res.status, json, headers: res.headers };
  }

  async function bytes(url, cookie) {
    const res = await fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }

  async function register(username) {
    const res = await api("POST", "/api/register", null, { username, password: "secret123", nickname: username });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { id: res.json.id, username, cookie };
  }

  function listen(person, into) {
    return new Promise((resolve) => {
      const req = http.get(
        `${base}/api/events?username=${person.username}`,
        { headers: { Cookie: person.cookie } },
        (res) => {
          res.setEncoding("utf8");
          let buffer = "";
          res.on("data", (chunk) => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const line = frame.split("\n").find((l) => l.startsWith("data: "));
              if (line) {
                try {
                  into.push(JSON.parse(line.slice(6)));
                } catch {
                  // not JSON: a comment or a ping
                }
              }
            }
          });
          resolve(req);
        },
      );
      req.on("error", () => {});
    });
  }

  const uploadToGifs = async (who, data, name = "funny.gif", type = "image/gif") => {
    const form = new FormData();
    form.append("file", new Blob([data], { type }), name);
    const res = await fetch(`${base}/api/gifs/upload`, { method: "POST", headers: { Cookie: people[who].cookie }, body: form });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const uploadAsMessage = async (who, chatId, data, name, type) => {
    const form = new FormData();
    form.append("chatId", chatId);
    form.append("username", people[who].username);
    form.append("uploadType", "media");
    form.append("files", new Blob([data], { type }), name);
    const res = await fetch(`${base}/api/messages/upload`, { method: "POST", headers: { Cookie: people[who].cookie }, body: form });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const messages = async (who, chatId) =>
    (await api("GET", `/api/messages?chatId=${chatId}&username=${people[who].username}`, people[who].cookie)).json.messages;

  const gifFolder = (who) => path.join(dataDir, "uploads", "gifs", people[who].id);

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songbird-saved-gifs-"));
    child = spawn(process.execPath, ["index.js"], {
      cwd: serverDir,
      env: {
        ...process.env,
        SERVER_PORT: String(port),
        BIND_ADDRESS: "127.0.0.1",
        DATA_DIR: dataDir,
        DB_CLIENT: "sqlite3",
        NODE_ENV: "development",
        MAX_SAVED_GIFS: String(LIMIT),
        STORAGE_DRIVER: "local",
        STORAGE_ENCRYPTION_KEY: "an-end-to-end-test-secret-key-0123456789",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));

    const started = Date.now();
    while (!log.includes("Aurelle server running")) {
      if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
      if (Date.now() - started > 40_000) throw new Error(`server did not start:\n${log}`);
      await sleep(100);
    }

    for (const name of ["alice", "bob", "carol"]) people[name] = await register(`${name}_gif`);
    dm = (await api("POST", "/api/chats/dm", people.alice.cookie, { from: "alice_gif", to: "bob_gif" })).json.id;
    for (const name of ["alice", "bob", "carol"]) streams.push(await listen(people[name], events[name]));
    await sleep(300);
  }, 60_000);

  afterAll(async () => {
    streams.forEach((req) => req.destroy());
    child?.kill("SIGTERM");
    await sleep(300);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const original = buildGif({ frames: 6, width: 90, height: 60 });
  let messageId;
  let fileId;
  let bobsGif;

  test("the app info says how many GIFs a person can keep", async () => {
    const info = await api("GET", "/api/app/info");
    expect(info.json.maxSavedGifs).toBe(LIMIT);
  });

  test("a GIF sent as a file stays a GIF: same bytes, flagged animated, in every payload", async () => {
    const sent = await uploadAsMessage("alice", dm, original, "party.gif", "image/gif");
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    messageId = sent.json.id;
    fileId = sent.json.files[0].id;
    expect(sent.json.files[0]).toMatchObject({ mimeType: "image/gif", isAnimated: true, gif: true, width: null });

    await sleep(200);
    const seen = events.bob.find((e) => e.type === "chat_message" && e.messageId === messageId);
    expect(seen.files[0]).toMatchObject({ isAnimated: true, gif: true });
    expect(seen.summaryText).toBe("Sent a GIF");

    const listed = (await messages("bob", dm)).find((m) => m.id === messageId);
    expect(listed.files[0]).toMatchObject({ isAnimated: true, gif: true, mimeType: "image/gif" });
    // Served back byte for byte (stored encrypted at rest, decrypted on the way out).
    const served = await bytes(listed.files[0].url, people.bob.cookie);
    expect(served.status).toBe(200);
    expect(served.body.equals(original)).toBe(true);

    const chats = (await api("GET", `/api/chats?username=bob_gif`, people.bob.cookie)).json.chats;
    expect(chats.find((c) => c.id === dm).last_message_files[0]).toMatchObject({ isAnimated: true, gif: true });
  });

  test("a still picture is not flagged", async () => {
    const sent = await uploadAsMessage("alice", dm, buildJpeg(), "photo.jpg", "image/jpeg");
    expect(sent.status).toBe(200);
    expect(sent.json.files[0]).toMatchObject({ isAnimated: false, gif: false });
  });

  test("Bob saves the GIF from the chat: a private copy, listed, and served only to him", async () => {
    const saved = await api("POST", "/api/gifs", people.bob.cookie, { messageId, fileId });
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    expect(saved.json).toMatchObject({ evicted: [], limit: LIMIT, count: 1 });
    bobsGif = saved.json.gif;
    expect(bobsGif).toMatchObject({ width: 90, height: 60, mime: "image/gif", size: original.length, thumbUrl: null });

    const list = (await api("GET", "/api/gifs", people.bob.cookie)).json;
    expect(list).toMatchObject({ limit: LIMIT, count: 1 });
    expect(list.gifs[0].id).toBe(bobsGif.id);

    const file = await bytes(bobsGif.url, people.bob.cookie);
    expect(file.status).toBe(200);
    expect(file.body.equals(original)).toBe(true);
    expect(file.headers.get("content-type")).toBe("image/gif");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");

    // On disk under Bob's own folder, as ciphertext (a key is set).
    const [name] = fs.readdirSync(gifFolder("bob"));
    expect(name).toBe(`${bobsGif.id}.gif`);
    expect(fs.readFileSync(path.join(gifFolder("bob"), name)).subarray(0, 5).toString()).toBe("SBENC");

    // Saving it again changes nothing.
    const again = await api("POST", "/api/gifs", people.bob.cookie, { messageId, fileId });
    expect(again.status).toBe(200);
    expect(again.json.gif.id).toBe(bobsGif.id);
    expect(again.json.count).toBe(1);
  });

  test("nobody else can see, fetch, delete, save from or send it", async () => {
    // Alice sent the GIF but never saved it.
    expect((await api("GET", "/api/gifs", people.alice.cookie)).json).toMatchObject({ gifs: [], count: 0 });
    expect((await api("GET", "/api/gifs", people.carol.cookie)).json.gifs).toEqual([]);

    for (const who of ["alice", "carol"]) {
      expect((await bytes(bobsGif.url, people[who].cookie)).status).toBe(404);
      expect((await api("DELETE", `/api/gifs/${bobsGif.id}`, people[who].cookie)).status).toBe(404);
      const send = await api("POST", "/api/messages", people[who].cookie, {
        chatId: dm,
        username: people[who].username,
        savedGifId: bobsGif.id,
      });
      expect([403, 404]).toContain(send.status);
    }
    // Carol is not in the chat, so she cannot save from it either.
    const stolen = await api("POST", "/api/gifs", people.carol.cookie, { messageId, fileId });
    expect(stolen.status).toBe(404);
    expect((await bytes(bobsGif.url, null)).status).toBe(401);

    // Still all there for Bob.
    expect((await api("GET", "/api/gifs", people.bob.cookie)).json.count).toBe(1);
    expect(events.carol.filter((e) => /saved_gif/.test(e.type))).toEqual([]);
    expect(events.alice.filter((e) => /saved_gif/.test(e.type))).toEqual([]);
  });

  test("past the limit the oldest GIF goes, its file is deleted and Bob is told", async () => {
    const second = await uploadToGifs("bob", buildGif({ frames: 3 }), "two.gif");
    const third = await uploadToGifs("bob", buildGif({ frames: 4 }), "three.gif", "application/octet-stream");
    expect([second.status, third.status]).toEqual([201, 201]);
    expect(third.json).toMatchObject({ evicted: [], count: 3, limit: LIMIT });
    expect(fs.readdirSync(gifFolder("bob"))).toHaveLength(3);

    await sleep(300); // let the events of the uploads above arrive first
    events.bob.length = 0;
    const fourth = await uploadToGifs("bob", buildGif({ frames: 5 }), "four.gif");
    expect(fourth.status).toBe(201);
    expect(fourth.json.evicted).toEqual([{ id: bobsGif.id }]);
    expect(fourth.json.count).toBe(3);

    // The oldest is gone from the list, from the file endpoint and from disk.
    const list = (await api("GET", "/api/gifs", people.bob.cookie)).json;
    expect(list.gifs.map((g) => g.id)).not.toContain(bobsGif.id);
    expect(list.gifs[0].id).toBe(fourth.json.gif.id);
    expect((await bytes(bobsGif.url, people.bob.cookie)).status).toBe(404);
    const onDisk = fs.readdirSync(gifFolder("bob"));
    expect(onDisk).toHaveLength(3);
    expect(onDisk).not.toContain(`${bobsGif.id}.gif`);

    await sleep(300);
    const told = events.bob.filter((e) => e.type === "saved_gif_added");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ evicted: [{ id: bobsGif.id }], limit: LIMIT, count: 3 });
    bobsGif = fourth.json.gif;
  });

  test("the device upload checks the bytes, whatever the browser says", async () => {
    expect((await uploadToGifs("bob", buildJpeg(), "photo.jpg", "image/gif")).status).toBe(400);
    expect((await uploadToGifs("bob", buildGif({ frames: 1 }), "still.gif")).status).toBe(400);
    expect((await uploadToGifs("bob", Buffer.from("<html></html>"), "x.gif")).json.code).toBe("gif_unsupported");
    expect((await api("GET", "/api/gifs", people.bob.cookie)).json.count).toBe(3);
  });

  test("sending a saved GIF puts an ordinary animated attachment in the chat, a copy that outlives nothing it should not", async () => {
    events.alice.length = 0;
    const res = await api("POST", "/api/messages", people.bob.cookie, {
      chatId: dm,
      username: "bob_gif",
      savedGifId: bobsGif.id,
      body: "look!",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.files[0]).toMatchObject({ isAnimated: true, gif: true, mimeType: "image/gif", name: "animation.gif" });

    await sleep(300);
    const seen = events.alice.find((e) => e.type === "chat_message" && e.messageId === res.json.id);
    expect(seen).toMatchObject({ body: "look!", userId: people.bob.id, summaryText: "Sent a GIF" });
    expect(seen.files[0]).toMatchObject({ isAnimated: true, gif: true });
    const wire = JSON.stringify([seen, res.json]);
    expect(wire).not.toContain(bobsGif.id);
    expect(wire).not.toContain("savedGifId");
    expect(wire).not.toContain(`gifs/${people.bob.id}`);

    const received = (await messages("alice", dm)).find((m) => m.id === res.json.id);
    expect(received.files[0]).toMatchObject({ isAnimated: true, gif: true });
    const served = await bytes(received.files[0].url, people.alice.cookie);
    expect(served.status).toBe(200);
    expect(served.body.length).toBeGreaterThan(0);
    expect(served.body.subarray(0, 6).toString("latin1")).toBe("GIF89a");

    // It lives with the messages, apart from Bob's collection.
    expect(received.files[0].url).toMatch(/^\/api\/uploads\/messages\//);
    expect(fs.readdirSync(gifFolder("bob"))).toHaveLength(3);
  });

  test("someone else's saved GIF id cannot be sent by Alice", async () => {
    const before = (await messages("alice", dm)).length;
    const res = await api("POST", "/api/messages", people.alice.cookie, {
      chatId: dm,
      username: "alice_gif",
      savedGifId: bobsGif.id,
    });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "GIF not found." });
    expect((await messages("alice", dm)).length).toBe(before);
  });

  test("Bob deletes one GIF: gone from the list and from disk", async () => {
    const list = (await api("GET", "/api/gifs", people.bob.cookie)).json;
    const victim = list.gifs.at(-1);
    const res = await api("DELETE", `/api/gifs/${victim.id}`, people.bob.cookie);
    expect(res.json).toEqual({ ok: true, id: victim.id, limit: LIMIT, count: 2 });
    expect(fs.existsSync(path.join(gifFolder("bob"), `${victim.id}.gif`))).toBe(false);
    expect(fs.readdirSync(gifFolder("bob"))).toHaveLength(2);
  });

  test("deleting the account removes the collection and its files, and leaves what Bob sent", async () => {
    const sentBefore = (await messages("alice", dm)).filter((m) => m.username === "bob_gif" && m.files?.length);
    expect(sentBefore.length).toBeGreaterThan(0);
    const keepUrl = sentBefore[0].files[0].url;

    const res = await api("POST", "/api/profile/delete", people.bob.cookie, { username: "bob_gif", password: "secret123" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    expect(fs.existsSync(gifFolder("bob"))).toBe(false);
    // Alice and Carol are untouched, and the picture Bob had sent is still in the chat.
    expect((await api("GET", "/api/gifs", people.alice.cookie)).json.count).toBe(0);
    expect((await bytes(keepUrl, people.alice.cookie)).status).toBe(200);
  }, 30_000);
});
