import { describe, expect, test, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createRawTestDb, createTestDb, migrations } from "./testDbHelper.js";

describe("Call history entries schema (migration 047)", () => {
  let dbHelper;

  beforeEach(async () => {
    dbHelper = await createTestDb();
  });
  afterEach(() => {
    try {
      dbHelper?.close();
    } catch {}
    dbHelper = null;
  });

  const seed = () => {
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const chat = crypto.randomUUID();
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [alice, "alice", "h"]);
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [bob, "bob", "h"]);
    dbHelper.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [chat, "c", "dm"]);
    return { alice, bob, chat };
  };

  const insertCall = (chat, user, callId, extra = {}) => {
    const id = crypto.randomUUID();
    dbHelper.run(
      `INSERT INTO chat_messages
         (id, chat_id, user_id, body, created_at, call_id, call_kind, call_outcome, call_duration_sec)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
      [
        id,
        chat,
        user,
        "2026-10-17 10:00:00",
        callId,
        extra.kind ?? "audio",
        extra.outcome ?? "completed",
        extra.duration ?? 12,
      ],
    );
    return id;
  };

  test("migration 47 is registered once and is the latest", () => {
    expect(migrations.filter((m) => m.version === 47)).toHaveLength(1);
    expect(Math.max(...migrations.map((m) => m.version))).toBeGreaterThanOrEqual(47);
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("messages gain four nullable call columns", () => {
    const info = dbHelper.getAll("PRAGMA table_info(chat_messages)");
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));
    for (const column of ["call_id", "call_kind", "call_outcome", "call_duration_sec"]) {
      expect(byName[column], column).toBeTruthy();
      expect(byName[column].notnull, `${column} must be nullable`).toBe(0);
      expect(byName[column].dflt_value).toBeNull();
    }
    expect(byName.call_duration_sec.type.toUpperCase()).toBe("INTEGER");
    for (const column of ["call_id", "call_kind", "call_outcome"]) {
      expect(byName[column].type.toUpperCase()).toBe("TEXT");
    }
  });

  test("ordinary messages are untouched: all call columns stay null", () => {
    const { alice, chat } = seed();
    dbHelper.run(
      "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      [crypto.randomUUID(), chat, alice, "hi", "2025-01-01 00:00:00"],
    );
    expect(
      dbHelper.getRow(
        "SELECT call_id, call_kind, call_outcome, call_duration_sec FROM chat_messages WHERE body = 'hi'",
      ),
    ).toEqual({ call_id: null, call_kind: null, call_outcome: null, call_duration_sec: null });
  });

  test("a call id can have only one entry", () => {
    const { alice, bob, chat } = seed();
    const callId = crypto.randomUUID();
    insertCall(chat, alice, callId);
    expect(() => insertCall(chat, bob, callId)).toThrow();
    expect(dbHelper.getRow("SELECT COUNT(*) AS n FROM chat_messages WHERE call_id = ?", [callId]).n).toBe(1);
  });

  test("any number of ordinary messages may share the empty call id", () => {
    const { alice, chat } = seed();
    for (let i = 0; i < 3; i += 1) {
      dbHelper.run(
        "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        [crypto.randomUUID(), chat, alice, `m${i}`, "2025-01-01 00:00:00"],
      );
    }
    expect(dbHelper.getRow("SELECT COUNT(*) AS n FROM chat_messages WHERE call_id IS NULL").n).toBe(3);
  });

  test("the call id is indexed uniquely, so looking it up is cheap and the guard is real", () => {
    const indexes = dbHelper.getAll("PRAGMA index_list(chat_messages)");
    const index = indexes.find((i) => i.name === "idx_chat_messages_call_id");
    expect(index).toBeTruthy();
    expect(index.unique).toBe(1);
    const columns = dbHelper
      .getAll("PRAGMA index_info(idx_chat_messages_call_id)")
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    expect(columns).toEqual(["call_id"]);
  });

  test("the guard works with ON CONFLICT DO NOTHING, the way the server writes", () => {
    const { alice, bob, chat } = seed();
    const callId = crypto.randomUUID();
    insertCall(chat, alice, callId);
    dbHelper.run(
      `INSERT INTO chat_messages (id, chat_id, user_id, body, created_at, call_id)
       VALUES (?, ?, ?, '', '2026-10-17 10:00:01', ?)
       ON CONFLICT (call_id) DO NOTHING`,
      [crypto.randomUUID(), chat, bob, callId],
    );
    expect(dbHelper.getRow("SELECT COUNT(*) AS n FROM chat_messages WHERE call_id = ?", [callId]).n).toBe(1);
  });

  test("entries disappear with their chat like every other message", () => {
    const { alice, chat } = seed();
    const callId = crypto.randomUUID();
    insertCall(chat, alice, callId);
    dbHelper.run("DELETE FROM chat_messages WHERE chat_id = ?", [chat]);
    // The id is free again once its entry is gone.
    expect(() => insertCall(chat, alice, callId)).not.toThrow();
  });

  test("migration is safe to run again", async () => {
    const migration = migrations.find((m) => m.version === 47);
    await migration.up(dbHelper.migrationContext);
    await migration.up(dbHelper.migrationContext);
    const names = dbHelper.getAll("PRAGMA table_info(chat_messages)").map((c) => c.name);
    expect(names.filter((n) => n === "call_id")).toHaveLength(1);
  });

  test("a database from before 47 gets the columns and keeps its messages", async () => {
    const raw = await createRawTestDb();
    try {
      const before = [...migrations].filter((m) => m.version < 47).sort((a, b) => a.version - b.version);
      for (const migration of before) {
        await migration.up(raw.migrationContext);
        raw.setSchemaVersion(migration.version);
      }
      const alice = crypto.randomUUID();
      const chat = crypto.randomUUID();
      raw.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [alice, "alice", "h"]);
      raw.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [chat, "c", "dm"]);
      raw.run(
        "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        [crypto.randomUUID(), chat, alice, "old", "2025-01-01 00:00:00"],
      );
      expect(raw.getAll("PRAGMA table_info(chat_messages)").some((c) => c.name === "call_id")).toBe(false);

      await migrations.find((m) => m.version === 47).up(raw.migrationContext);

      expect(raw.getAll("PRAGMA table_info(chat_messages)").some((c) => c.name === "call_id")).toBe(true);
      expect(raw.getRow("SELECT body, call_id FROM chat_messages")).toEqual({ body: "old", call_id: null });
    } finally {
      raw.close();
    }
  });
});
