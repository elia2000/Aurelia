import { afterEach, describe, expect, test, vi } from "vitest";
import http from "node:http";
import request from "supertest";
import { makeAccountApp, signIn } from "../helpers/accountFixtures.js";

const servers = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(server.address().port);
    });
  });
}

/** Opens /api/events and collects what arrives; resolves `closed` when the server ends the stream. */
function openStream(port, cookie, username = "alice") {
  const chunks = [];
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const req = http.get({ host: "127.0.0.1", port, path: `/api/events?username=${username}`, headers: { Cookie: cookie } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolveClosed(true));
    res.on("close", () => resolveClosed(true));
  });
  req.on("error", () => resolveClosed(true));
  return { chunks, closed, text: () => chunks.join(""), req };
}

describe("GET /api/events and session revocation", () => {
  test("registers the stream with the id of the session that opened it", async () => {
    const addSseClient = vi.fn();
    const { app } = makeAccountApp({ deps: { addSseClient } });
    const { cookie } = await signIn(app, "alice");
    const publicId = (await request(app).get("/api/sessions").set("Cookie", cookie)).body.sessions[0].id;
    const port = await listen(app);
    const stream = openStream(port, cookie);
    await vi.waitFor(() => expect(addSseClient).toHaveBeenCalled());
    expect(addSseClient).toHaveBeenCalledWith("alice", expect.anything(), publicId);
    stream.req.destroy();
  });

  test("a stream whose session disappears is told and closed within one ping", async () => {
    const { app, sessionStore } = makeAccountApp({ deps: { eventsRecheckIntervalMs: 40 } });
    const { cookie, sid } = await signIn(app, "alice");
    const port = await listen(app);
    const stream = openStream(port, cookie);
    await vi.waitFor(() => expect(stream.text()).toContain('"type":"connected"'));

    // ended some other way than through this process's own revoke hooks (CLI, another instance, expiry)
    sessionStore.sessions.delete(sid);

    await vi.waitFor(() => expect(stream.text()).toContain('"type":"session_revoked"'), { timeout: 3000 });
    expect(await stream.closed).toBe(true);
  });

  test("a stream whose session is still valid stays open past several pings", async () => {
    const { app } = makeAccountApp({ deps: { eventsRecheckIntervalMs: 30 } });
    const { cookie } = await signIn(app, "alice");
    const port = await listen(app);
    const stream = openStream(port, cookie);
    await vi.waitFor(() => expect(stream.text()).toContain('"type":"connected"'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stream.text()).not.toContain("session_revoked");
    const pings = stream.text().split(": ping").length - 1;
    expect(pings).toBeGreaterThanOrEqual(3);
    stream.req.destroy();
  });

  test("a revoked cookie can not open a stream at all", async () => {
    const { app } = makeAccountApp();
    const laptop = await signIn(app, "alice");
    const phone = await signIn(app, "alice");
    const phoneId = (await request(app).get("/api/sessions").set("Cookie", laptop.cookie)).body.sessions.find((s) => !s.current).id;
    await request(app).delete(`/api/sessions/${phoneId}`).set("Cookie", laptop.cookie);
    const res = await request(app).get("/api/events?username=alice").set("Cookie", phone.cookie);
    expect(res.status).toBe(401);
  });
});
