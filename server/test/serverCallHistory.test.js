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
// HTTP: the unit and API tests inject their own database functions, so only
// this proves that the history entry of a call is really connected end to end.

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

const p256 = () => {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
};
const b64u = (length) => Buffer.alloc(length, 7).toString("base64url");

describe("call history entries on the real server", () => {
  let child;
  let dataDir;
  let base;
  let log = "";
  const people = {};
  const events = { alice: [], bob: [], carol: [] };
  const streams = [];
  let dm;
  let dmCarol;

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
    const device = await api("POST", "/api/e2ee/devices", cookie, {
      ecdhPublic: p256(),
      ecdsaPublic: p256(),
      label: "test",
    });
    expect(device.status).toBe(201);
    return { id: res.json.id, username, cookie, deviceId: device.json.device.id };
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

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "songbird-call-history-"));
    child = spawn(process.execPath, ["index.js"], {
      cwd: serverDir,
      env: {
        ...process.env,
        SERVER_PORT: String(port),
        BIND_ADDRESS: "127.0.0.1",
        DATA_DIR: dataDir,
        DB_CLIENT: "sqlite3",
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

    for (const name of ["alice", "bob", "carol"]) people[name] = await register(`${name}_ch`);
    dm = (await api("POST", "/api/chats/dm", people.alice.cookie, { from: "alice_ch", to: "bob_ch" })).json.id;
    dmCarol = (await api("POST", "/api/chats/dm", people.carol.cookie, { from: "carol_ch", to: "bob_ch" })).json.id;
    for (const name of ["alice", "bob", "carol"]) streams.push(await listen(people[name], events[name]));
    await sleep(300);
  }, 60_000);

  afterAll(async () => {
    streams.forEach((req) => req.destroy());
    child?.kill("SIGTERM");
    await sleep(300);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const invite = (who, chatId, kind, callId) => ({
    callId,
    chatId,
    kind,
    invite: { deviceId: people[who].deviceId, commit: b64u(32), ts: Date.now(), sig: b64u(64) },
  });
  const accept = (callId) =>
    api("POST", `/api/calls/${callId}/accept`, people.bob.cookie, {
      accept: { deviceId: people.bob.deviceId, eph: p256(), sig: b64u(64) },
    });
  const end = (who, callId, body = {}) => api("POST", `/api/calls/${callId}/end`, people[who].cookie, body);
  const messages = async (who, chatId) =>
    (await api("GET", `/api/messages?chatId=${chatId}&username=${people[who].username}`, people[who].cookie)).json
      .messages;
  const entryFor = async (who, chatId, callId) =>
    (await messages(who, chatId)).find((m) => m.call?.callId === callId);
  const chatRow = async (who, chatId) =>
    (await api("GET", `/api/chats?username=${people[who].username}`, people[who].cookie)).json.chats.find(
      (c) => c.id === chatId,
    );
  // created_at has a resolution of one second; keep calls apart so the timeline order is certain.
  const nextSecond = () => sleep(1100);

  test("a call that was answered, connected and hung up by both at once leaves one completed entry", async () => {
    const callId = crypto.randomUUID();
    expect((await api("POST", "/api/calls", people.alice.cookie, invite("alice", dm, "video", callId))).status).toBe(201);
    expect((await accept(callId)).status).toBe(200);
    expect((await api("POST", `/api/calls/${callId}/connected`, people.alice.cookie, {})).status).toBe(200);
    await sleep(2300);
    const [a, b] = await Promise.all([
      end("alice", callId, { durationMs: 2100 }),
      end("bob", callId, { durationMs: 2200 }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await sleep(300);

    const all = (await messages("bob", dm)).filter((m) => m.call?.callId === callId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      type: "call",
      messageType: "call",
      body: "",
      username: "alice_ch",
      read_by_me: true,
      call: { callId, kind: "video", outcome: "completed", durationSec: 2 },
    });
    expect(all[0]).not.toHaveProperty("call_id");
    expect((await entryFor("alice", dm, callId)).read_by_me).toBe(true);

    // Both people were told, exactly once; the third person was not.
    const told = (name) =>
      events[name].filter((e) => e.type === "chat_message" && e.call?.callId === callId);
    expect(told("alice")).toHaveLength(1);
    expect(told("bob")).toHaveLength(1);
    expect(told("bob")[0]).toMatchObject({
      chatId: dm,
      messageType: "call",
      countsAsUnread: false,
      call: { outcome: "completed", durationSec: 2 },
    });
    expect(told("carol")).toHaveLength(0);
    await nextSecond();
  }, 30_000);

  test("declined and cancelled calls, each with its own entry and a worded chat-list preview", async () => {
    const declined = crypto.randomUUID();
    await api("POST", "/api/calls", people.alice.cookie, invite("alice", dm, "audio", declined));
    await end("bob", declined);
    await sleep(300);
    expect((await entryFor("alice", dm, declined)).call.outcome).toBe("declined");
    await nextSecond();

    const cancelled = crypto.randomUUID();
    await api("POST", "/api/calls", people.alice.cookie, invite("alice", dm, "audio", cancelled));
    await end("alice", cancelled);
    await sleep(300);
    expect((await entryFor("bob", dm, cancelled)).call.outcome).toBe("cancelled");

    const forAlice = await chatRow("alice", dm);
    const forBob = await chatRow("bob", dm);
    expect(forAlice).toMatchObject({
      last_message_type: "call",
      last_message: "Cancelled call",
      last_call: { callId: cancelled, kind: "audio", outcome: "cancelled", durationSec: null },
    });
    expect(forBob.last_message).toBe("Cancelled call");
    // Nothing waits to be read.
    expect(Number(forBob.unread_count)).toBe(0);
    expect(Number(forAlice.unread_count)).toBe(0);
    await nextSecond();
  }, 30_000);

  // (Ringing is limited to 5 calls per two minutes per person and conversation,
  // so the tests below spread their calls over the two conversations.)
  test("a call that was answered but never connected failed", async () => {
    const callId = crypto.randomUUID();
    await api("POST", "/api/calls", people.carol.cookie, invite("carol", dmCarol, "audio", callId));
    await accept(callId);
    await end("bob", callId, { reason: "connect_failed" });
    await sleep(300);
    expect((await entryFor("carol", dmCarol, callId)).call).toMatchObject({
      outcome: "failed",
      durationSec: null,
    });
    expect((await chatRow("carol", dmCarol)).last_message).toBe("Call failed");
    await nextSecond();
  }, 30_000);

  test("ringing someone who is in a call leaves a busy entry, once, written by the caller", async () => {
    const running = crypto.randomUUID();
    await api("POST", "/api/calls", people.alice.cookie, invite("alice", dm, "audio", running));
    const busy = crypto.randomUUID();
    const first = await api("POST", "/api/calls", people.carol.cookie, invite("carol", dmCarol, "video", busy));
    expect(first.status).toBe(409);
    expect(first.json.code).toBe("busy");
    await api("POST", "/api/calls", people.carol.cookie, invite("carol", dmCarol, "video", busy));
    await sleep(300);
    const all = (await messages("bob", dmCarol)).filter((m) => m.call?.callId === busy);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ username: "carol_ch", call: { kind: "video", outcome: "busy" } });
    await end("alice", running);
    await sleep(300);
    await nextSecond();
  }, 30_000);

  test("a call entry can be hidden for yourself, and is not a message you can edit, react to, pin or delete for all", async () => {
    const callId = crypto.randomUUID();
    await api("POST", "/api/calls", people.carol.cookie, invite("carol", dmCarol, "audio", callId));
    await end("carol", callId);
    await sleep(300);
    const entry = await entryFor("bob", dmCarol, callId);

    const edit = await api("POST", "/api/messages/edit", people.carol.cookie, {
      chatId: dmCarol,
      username: "carol_ch",
      messageId: entry.id,
      body: "I never called",
    });
    expect(edit.status).toBe(400);
    const react = await api("POST", "/api/messages/react", people.bob.cookie, {
      chatId: dmCarol,
      username: "bob_ch",
      messageId: entry.id,
      emoji: "\u{1F44D}",
    });
    expect(react.status).toBe(400);
    const pin = await api("POST", `/api/chats/${dmCarol}/pins`, people.bob.cookie, { messageId: entry.id });
    expect(pin.status).toBe(400);
    const forward = await api("POST", "/api/messages/forward", people.bob.cookie, {
      username: "bob_ch",
      sourceMessageId: entry.id,
      targetChatIds: [dmCarol],
      body: "call",
    });
    expect(forward.status).toBe(400);
    const reply = await api("POST", "/api/messages", people.bob.cookie, {
      chatId: dmCarol,
      username: "bob_ch",
      body: "sorry",
      replyToMessageId: entry.id,
    });
    expect(reply.status).toBe(400);
    const everyone = await api("POST", "/api/messages/delete", people.carol.cookie, {
      chatId: dmCarol,
      username: "carol_ch",
      messageId: entry.id,
      scope: "everyone",
    });
    expect(everyone.status).toBe(400);
    expect(everyone.json.code).toBe("call_message_self_only");

    const hide = await api("POST", "/api/messages/delete", people.bob.cookie, {
      chatId: dmCarol,
      username: "bob_ch",
      messageId: entry.id,
      scope: "self",
    });
    expect(hide.status).toBe(200);
    expect(await entryFor("bob", dmCarol, callId)).toBeUndefined();
    expect(await entryFor("carol", dmCarol, callId)).toBeTruthy();
  }, 30_000);

  test("a stranger can neither end nor read anything about someone else's call", async () => {
    const callId = crypto.randomUUID();
    await api("POST", "/api/calls", people.alice.cookie, invite("alice", dm, "audio", callId));
    expect((await end("carol", callId)).status).toBe(403);
    const peek = await api(
      "GET",
      `/api/messages?chatId=${dm}&username=carol_ch`,
      people.carol.cookie,
    );
    expect(peek.status).toBe(403);
    await end("alice", callId);
  }, 30_000);
});
