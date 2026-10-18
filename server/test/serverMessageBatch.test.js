import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The real server (index.js with its real database and wiring), driven over
// HTTP and listening to the real event stream: the API tests inject their own
// database functions, so only this proves that forwarding and deleting many
// messages at once is connected end to end (the bulk lookups, the order the
// messages are written in, the events people receive).
//
// It runs on SQLite. To run the same flow on PostgreSQL, point POSTGRES_HOST,
// POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB at a scratch
// database and set SONGBIRD_TEST_DB_CLIENT=postgres.

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

describe("forwarding and deleting many messages on the real server", () => {
  let child;
  let dataDir;
  let base;
  let log = "";
  const people = {};
  const events = { alice: [], bob: [], carol: [] };
  const streams = [];
  let src; // group: alice (owner), bob
  let dst; // group: alice (owner), bob
  let bobsGroup; // group: bob (owner), alice
  let carolsGroup; // group: carol
  let channel; // channel: alice (owner), bob subscribes
  let dm; // alice and bob
  let sent = []; // ids of alice's/bob's messages in src, in the order they were sent
  let carolMessage;

  async function api(method, url, who, body) {
    const res = await fetch(base + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(who ? { Cookie: people[who].cookie } : {}),
      },
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

  async function register(username) {
    const res = await api("POST", "/api/register", null, {
      username,
      password: "secret123",
      nickname: username,
    });
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

  const newGroup = async (who, name, members, type = "group") => {
    const res = await api("POST", "/api/chats", who, {
      name,
      type,
      creator: people[who].username,
      members: members.map((m) => people[m].username),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.id;
  };

  const say = async (who, chatId, body) => {
    const res = await api("POST", "/api/messages", who, { chatId, username: people[who].username, body });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.id;
  };

  const messages = async (who, chatId) => {
    const res = await api("GET", `/api/messages?chatId=${chatId}&username=${people[who].username}&limit=200`, who);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.messages;
  };

  const forward = (who, body) =>
    api("POST", "/api/messages/forward", who, { username: people[who].username, ...body });
  const remove = (who, chatId, body) =>
    api("POST", "/api/messages/delete", who, { username: people[who].username, chatId, ...body });

  const eventsOf = (who, type, chatId) =>
    events[who].filter((e) => e.type === type && (!chatId || e.chatId === chatId));

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songbird-message-batch-"));
    child = spawn(process.execPath, ["index.js"], {
      cwd: serverDir,
      env: {
        ...process.env,
        SERVER_PORT: String(port),
        BIND_ADDRESS: "127.0.0.1",
        DATA_DIR: dataDir,
        DB_CLIENT: process.env.SONGBIRD_TEST_DB_CLIENT || "sqlite3",
        NODE_ENV: "development",
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

    for (const name of ["alice", "bob", "carol"]) people[name] = await register(`${name}_mb`);
    src = await newGroup("alice", "Source", ["bob"]);
    dst = await newGroup("alice", "Target", ["bob"]);
    bobsGroup = await newGroup("bob", "Bob's", ["alice"]);
    carolsGroup = await newGroup("carol", "Carol's", []);
    channel = await newGroup("alice", "News", ["bob"], "channel");
    dm = (await api("POST", "/api/chats/dm", "alice", { from: "alice_mb", to: "bob_mb" })).json.id;

    // Two messages in one second, a pause, two more: the chat orders them by
    // time and then by id, and the copies must come out the same way.
    sent = [];
    sent.push(await say("alice", src, "m1 from alice"));
    sent.push(await say("bob", src, "m2 from bob"));
    await sleep(1100);
    sent.push(await say("alice", src, "m3 from alice"));
    sent.push(await say("bob", src, "m4 from bob"));
    carolMessage = await say("carol", carolsGroup, "carol's own");

    for (const name of ["alice", "bob", "carol"]) streams.push(await listen(people[name], events[name]));
    await sleep(300);
  }, 90_000);

  afterAll(async () => {
    streams.forEach((req) => req.destroy());
    child?.kill("SIGTERM");
    await sleep(300);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // The order the chat itself shows the source messages in.
  const shownOrder = async () => {
    const shown = await messages("alice", src);
    return shown.filter((m) => sent.includes(m.id)).map((m) => m.id);
  };

  test("the single request still answers { ok, ids } and creates one forwarded message", async () => {
    const res = await forward("alice", { sourceMessageId: sent[0], targetChatIds: [dm], body: "m1 from alice" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.ids).toHaveLength(1);
    const copy = (await messages("bob", dm)).find((m) => m.id === res.json.ids[0]);
    expect(copy.body).toBe("m1 from alice");
    expect(copy.forwarded_from_username).toBe("alice_mb");
  });

  test("several messages arrive in their original order, whatever order they were asked for, as separate messages with their origin", async () => {
    const shown = await shownOrder();
    expect(shown).toHaveLength(4);
    const asked = [shown[3], shown[1], shown[0], shown[2]];
    const before = eventsOf("bob", "chat_message", dst).length;

    const res = await forward("alice", { sourceMessageIds: asked, targetChatIds: [dst] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.failed).toEqual([]);
    expect(res.json.forwarded.map((m) => m.sourceMessageId)).toEqual(shown);

    const inTarget = await messages("bob", dst);
    expect(inTarget.map((m) => m.id)).toEqual(res.json.forwarded.map((m) => m.id));
    expect(inTarget.map((m) => m.body)).toEqual(
      shown.map((id) => ["m1 from alice", "m2 from bob", "m3 from alice", "m4 from bob"][sent.indexOf(id)]),
    );
    // Each remembers who wrote it, not who forwarded it.
    expect(inTarget.map((m) => m.forwarded_from_username)).toEqual(
      shown.map((id) => (sent.indexOf(id) % 2 === 0 ? "alice_mb" : "bob_mb")),
    );
    expect(inTarget.every((m) => m.username === "alice_mb")).toBe(true);

    await sleep(300);
    // Bob heard about exactly these, once each, in this order.
    const heard = eventsOf("bob", "chat_message", dst).slice(before);
    expect(heard.map((e) => e.messageId)).toEqual(res.json.forwarded.map((m) => m.id));
    expect(eventsOf("carol", "chat_message", dst)).toHaveLength(0);
  }, 30_000);

  test("when some of the messages cannot be forwarded the rest still go, each failure has a code, and nobody is told about the failures", async () => {
    const gone = await say("bob", src, "will be deleted");
    expect((await remove("bob", src, { messageId: gone, scope: "everyone" })).status).toBe(200);
    const missing = crypto.randomUUID();
    const before = eventsOf("bob", "chat_message", bobsGroup).length;

    const res = await forward("alice", {
      sourceMessageIds: [carolMessage, sent[2], gone, missing, sent[0]],
      targetChatIds: [bobsGroup],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.forwarded.map((m) => m.sourceMessageId)).toEqual([sent[0], sent[2]]);
    expect(res.json.failed.map((f) => [f.sourceMessageId, f.code])).toEqual([
      [carolMessage, "forbidden"],
      [gone, "gone"],
      [missing, "not_found"],
    ]);
    await sleep(300);
    expect(eventsOf("bob", "chat_message", bobsGroup).length - before).toBe(2);
    // Carol's message was not copied anywhere.
    expect((await messages("bob", bobsGroup)).some((m) => m.body === "carol's own")).toBe(false);
  }, 30_000);

  test("a request that cannot forward anything is an error that explains each message", async () => {
    const res = await forward("alice", { sourceMessageIds: [carolMessage], targetChatIds: [dst] });
    expect(res.status).toBe(403);
    expect(res.json.forwarded).toEqual([]);
    expect(res.json.failed).toEqual([
      expect.objectContaining({ sourceMessageId: carolMessage, code: "forbidden" }),
    ]);
  });

  test("a target the sender may not write to refuses the whole request, and nothing is written", async () => {
    const before = (await messages("carol", carolsGroup)).length;
    const toCarol = await forward("alice", { sourceMessageIds: sent, targetChatIds: [dst, carolsGroup] });
    expect(toCarol.status).toBe(403);
    const toBobsChannel = await forward("bob", { sourceMessageIds: [sent[1]], targetChatIds: [channel] });
    expect(toBobsChannel.status).toBe(403);
    expect(toBobsChannel.json.error).toMatch(/channels you own/);
    expect((await messages("carol", carolsGroup)).length).toBe(before);
  });

  test("a message cannot be forwarded by somebody outside its chat, however it is asked for", async () => {
    const single = await forward("carol", { sourceMessageId: sent[0], targetChatIds: [carolsGroup], body: "stolen" });
    expect(single.status).toBe(403);
    const many = await forward("carol", { sourceMessageIds: sent, targetChatIds: [carolsGroup] });
    expect(many.status).toBe(403);
    expect(many.json.failed).toHaveLength(4);
    expect(many.json.failed.every((f) => f.code === "forbidden")).toBe(true);
    expect(eventsOf("carol", "chat_message", carolsGroup).filter((e) => e.body === "m1 from alice")).toHaveLength(0);
  });

  test("the limits: 1 to 100 messages, valid ids, and not both fields", async () => {
    expect((await forward("alice", { sourceMessageIds: [], targetChatIds: [dst] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect((await forward("alice", { sourceMessageIds: tooMany, targetChatIds: [dst] })).status).toBe(400);
    expect((await forward("alice", { sourceMessageIds: ["x"], targetChatIds: [dst] })).status).toBe(400);
    expect((await forward("alice", { sourceMessageId: sent[0], sourceMessageIds: [sent[1]], targetChatIds: [dst] })).status).toBe(400);
    expect((await remove("alice", src, { messageIds: [] })).status).toBe(400);
    expect((await remove("alice", src, { messageIds: tooMany })).status).toBe(400);
    expect((await remove("alice", src, { messageId: sent[0], messageIds: [sent[1]] })).status).toBe(400);
  });

  test("deleting for me only: just my view changes and nobody else hears about it", async () => {
    const mine = [sent[1], sent[3]];
    const before = events.alice.length;
    const res = await remove("bob", src, { messageIds: mine });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ results: mine.map((messageId) => ({ messageId, ok: true })) });

    const bobSees = (await messages("bob", src)).map((m) => m.id);
    expect(mine.some((id) => bobSees.includes(id))).toBe(false);
    const aliceSees = (await messages("alice", src)).map((m) => m.id);
    expect(mine.every((id) => aliceSees.includes(id))).toBe(true);
    await sleep(300);
    expect(events.alice.slice(before).filter((e) => e.type === "chat_message_deleted")).toHaveLength(0);

    // A message removed from my own view is not mine to forward any more.
    const again = await forward("bob", { sourceMessageIds: [sent[1]], targetChatIds: [dst] });
    expect(again.status).toBe(410);
    expect(again.json.failed[0].code).toBe("gone");
    // Also when it is asked for together with others (the bulk lookup).
    const together = await forward("bob", { sourceMessageIds: [sent[1], sent[0], sent[3]], targetChatIds: [dst] });
    expect(together.status).toBe(200);
    expect(together.json.forwarded.map((m) => m.sourceMessageId)).toEqual([sent[0]]);
    expect(together.json.failed.map((f) => [f.sourceMessageId, f.code])).toEqual([
      [sent[1], "gone"],
      [sent[3], "gone"],
    ]);
  });

  test("deleting for everyone: the owner removes several at once, the chat is told once, a pinned one is unpinned", async () => {
    const pin = await api("POST", `/api/chats/${src}/pins`, "alice", { messageId: sent[2] });
    expect(pin.status, JSON.stringify(pin.json)).toBeLessThan(300);
    await sleep(200);
    const before = events.bob.length;

    const asked = [sent[0], sent[2], carolMessage, sent[3]];
    const res = await remove("alice", src, { messageIds: asked, scope: "everyone" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.results).toEqual([
      { messageId: sent[0], ok: true },
      { messageId: sent[2], ok: true },
      { messageId: carolMessage, ok: false, code: "not_found", error: "Message not found." },
      { messageId: sent[3], ok: true },
    ]);
    await sleep(400);

    const heard = events.bob.slice(before);
    const deleted = heard.filter((e) => e.type === "chat_message_deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ chatId: src, messageIds: [sent[0], sent[2], sent[3]] });
    const unpinned = heard.filter((e) => e.type === "message_unpinned");
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]).toMatchObject({ chatId: src, messageId: sent[2] });

    const left = (await messages("bob", src)).map((m) => m.id);
    expect(left).not.toContain(sent[0]);
    expect(left).not.toContain(sent[2]);
    expect((await api("GET", `/api/chats/${src}/pins`, "bob")).json.pins).toEqual([]);
    // Carol's message, in a chat alice cannot write to, is untouched.
    expect((await messages("carol", carolsGroup)).map((m) => m.id)).toContain(carolMessage);
  }, 30_000);

  test("deleting for everyone: a member can only remove their own, and says which others it could not", async () => {
    const mine = await say("bob", src, "bob again");
    const hers = await say("alice", src, "alice again");
    const res = await remove("bob", src, { messageIds: [mine, hers], scope: "everyone" });
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([
      { messageId: mine, ok: true },
      { messageId: hers, ok: false, code: "forbidden", error: "You cannot delete this message for everyone." },
    ]);
    const left = (await messages("alice", src)).map((m) => m.id);
    expect(left).not.toContain(mine);
    expect(left).toContain(hers);
  });

  test("the single delete request keeps its answers", async () => {
    const id = await say("alice", src, "single");
    const self = await remove("alice", src, { messageId: id });
    expect(self.json).toEqual({ ok: true, scope: "self", id });
    const everyone = await remove("alice", src, { messageId: id, scope: "everyone" });
    expect(everyone.json).toEqual({ ok: true, scope: "everyone", id });
    const outsider = await remove("carol", src, { messageId: id });
    expect(outsider.status).toBe(403);
    expect(outsider.json).toEqual({ error: "Not a member of this chat." });
  });
});
