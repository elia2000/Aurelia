import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { PASSWORD, makeAccountApp } from "../helpers/accountFixtures.js";

// Failed sign-ins write one `auth_failed` line to stdout (lib/authFailureLog.js)
// for fail2ban. These tests drive the real route and read what it printed.

let logged;

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logged.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const authLines = () => logged.filter((line) => line.includes("[auth] auth_failed"));
const login = (app, body, headers = {}) => {
  let req = request(app).post("/api/login");
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return req.send(body);
};

describe("auth_failed log line", () => {
  test("a wrong password writes exactly one line with the address, a hashed name and no secrets", async () => {
    const { app } = makeAccountApp();
    const res = await login(app, { username: "alice", password: "definitely-wrong" });
    expect(res.status).toBe(401);

    const lines = authLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[auth\] auth_failed ip=127\.0\.0\.1 user=[0-9a-f]{12} reason=credentials$/,
    );
    expect(lines[0]).not.toContain("alice");
    expect(lines[0]).not.toContain("definitely-wrong");
  });

  test("an unknown account is logged like a known one, hashed and never verbatim", async () => {
    const { app } = makeAccountApp();
    const res = await login(app, { username: "ghost-user", password: "hunter2" });
    expect(res.status).toBe(401);

    const lines = authLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ user=[0-9a-f]{12} /);
    expect(lines[0]).not.toContain("ghost");
    expect(lines[0]).not.toContain("hunter2");
  });

  test("the same account gets the same hash every time, a different account a different one", async () => {
    const { app } = makeAccountApp();
    await login(app, { username: "alice", password: "x" });
    await login(app, { username: "Alice ", password: "y" });
    await login(app, { username: "bob", password: "z" });
    const users = authLines().map((line) => /user=(\S+)/.exec(line)[1]);
    expect(users[0]).toBe(users[1]);
    expect(users[2]).not.toBe(users[0]);
  });

  test("a good sign-in writes nothing", async () => {
    const { app } = makeAccountApp();
    const res = await login(app, { username: "alice", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(authLines()).toHaveLength(0);
  });

  test("a request that is blocked by the limit is not a new failure line", async () => {
    const { app } = makeAccountApp();
    for (let i = 0; i < 8; i += 1) await login(app, { username: "alice", password: `wrong-${i}` });
    expect((await login(app, { username: "alice", password: "wrong-again" })).status).toBe(429);
    expect(authLines()).toHaveLength(8);
  });

  test("behind one trusted proxy (as in production) the address is the one the proxy added", async () => {
    const { app } = makeAccountApp();
    app.set("trust proxy", 1);
    // the first entry is whatever the client claimed; nginx appends the address it really saw
    await login(app, { username: "alice", password: "x" }, { "X-Forwarded-For": "198.51.100.7, 203.0.113.9" });
    expect(authLines()[0]).toContain(" ip=203.0.113.9 ");
  });

  test("without a trusted proxy a forged X-Forwarded-For header is ignored", async () => {
    const { app } = makeAccountApp();
    await login(app, { username: "alice", password: "x" }, { "X-Forwarded-For": "203.0.113.9" });
    expect(authLines()[0]).toContain(" ip=127.0.0.1 ");
  });

  test("a header that is not an address can not forge fields or a second line", async () => {
    const { app } = makeAccountApp();
    app.set("trust proxy", 1);
    await login(
      app,
      { username: "alice", password: "x" },
      { "X-Forwarded-For": "1.2.3.4 auth_failed ip=5.6.7.8 user=aaaaaaaaaaaa reason=credentials" },
    );
    const lines = authLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" ip=unknown ");
    expect(lines[0]).not.toContain("5.6.7.8");
  });
});
