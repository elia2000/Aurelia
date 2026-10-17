import { describe, expect, test, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createRawTestDb, createTestDb, migrations } from "./testDbHelper.js";

describe("Chat pins schema (migration 046)", () => {
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
    const other = crypto.randomUUID();
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [alice, "alice", "h"]);
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [bob, "bob", "h"]);
    dbHelper.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [chat, "c", "group"]);
    dbHelper.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [other, "d", "group"]);
    return { alice, bob, chat, other };
  };

  const pin = (userId, chatId, position = 0, at = new Date().toISOString()) =>
    dbHelper.run(
      "INSERT INTO chat_pins (user_id, chat_id, position, pinned_at) VALUES (?, ?, ?, ?)",
      [userId, chatId, position, at],
    );
  const countRows = () => dbHelper.getRow("SELECT COUNT(*) AS n FROM chat_pins").n;

  test("migration 46 is registered once", () => {
    expect(migrations.find((m) => m.version === 46)).toBeTruthy();
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("has the expected columns, composite primary key and indexes", () => {
    const info = dbHelper.getAll("PRAGMA table_info(chat_pins)");
    expect(info.map((c) => c.name).sort()).toEqual(["chat_id", "pinned_at", "position", "user_id"]);
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(["user_id", "chat_id"]);
    // Every column is mandatory.
    for (const column of info) expect(column.notnull).toBe(1);

    const indexes = dbHelper.getAll("PRAGMA index_list(chat_pins)").map((i) => i.name);
    expect(indexes).toContain("idx_chat_pins_user_position");
    expect(indexes).toContain("idx_chat_pins_chat");

    const orderIndex = dbHelper
      .getAll("PRAGMA index_info(idx_chat_pins_user_position)")
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    expect(orderIndex).toEqual(["user_id", "position"]);
  });

  test("a chat can be pinned by a person only once, but by different people", () => {
    const { alice, bob, chat } = seed();
    pin(alice, chat);
    expect(() => pin(alice, chat, 1)).toThrow();
    pin(bob, chat);
    expect(countRows()).toBe(2);
  });

  test("a pin needs an existing person and an existing chat", () => {
    const { alice, chat } = seed();
    expect(() => pin(crypto.randomUUID(), chat)).toThrow();
    expect(() => pin(alice, crypto.randomUUID())).toThrow();
    expect(countRows()).toBe(0);
  });

  test("pins disappear with their chat", () => {
    const { alice, bob, chat, other } = seed();
    pin(alice, chat);
    pin(bob, chat);
    pin(alice, other, 1);
    dbHelper.run("DELETE FROM chats WHERE id = ?", [chat]);
    expect(dbHelper.getAll("SELECT user_id, chat_id FROM chat_pins")).toEqual([
      { user_id: alice, chat_id: other },
    ]);
  });

  test("pins disappear with their person and leave other people's pins alone", () => {
    const { alice, bob, chat } = seed();
    pin(alice, chat);
    pin(bob, chat);
    dbHelper.run("DELETE FROM users WHERE id = ?", [alice]);
    expect(dbHelper.getAll("SELECT user_id FROM chat_pins")).toEqual([{ user_id: bob }]);
  });

  test("upgrading a version 45 database creates the table, and re-running is safe", async () => {
    const raw = await createRawTestDb();
    try {
      const sorted = [...migrations].sort((a, b) => a.version - b.version);
      for (const migration of sorted.filter((m) => m.version <= 45)) {
        await migration.up(raw.migrationContext);
        raw.setSchemaVersion(migration.version);
      }
      expect(raw.tableExists("chat_pins")).toBe(false);

      const m46 = sorted.find((m) => m.version === 46);
      await m46.up(raw.migrationContext);
      expect(raw.tableExists("chat_pins")).toBe(true);

      await m46.up(raw.migrationContext);
      expect(raw.tableExists("chat_pins")).toBe(true);
    } finally {
      raw.close();
    }
  });
});
