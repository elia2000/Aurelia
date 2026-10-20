import { describe, expect, test, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createRawTestDb, createTestDb, migrations } from "./testDbHelper.js";

describe("Message pins schema (migration 045)", () => {
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
    const message = crypto.randomUUID();
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [alice, "alice", "h"]);
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [bob, "bob", "h"]);
    dbHelper.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [chat, "c", "group"]);
    dbHelper.run(
      "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      [message, chat, alice, "hi", "2025-01-01 00:00:00"],
    );
    return { alice, bob, chat, message };
  };

  const pin = (chatId, messageId, userId, at = new Date().toISOString()) =>
    dbHelper.run(
      "INSERT INTO chat_pinned_messages (chat_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)",
      [chatId, messageId, userId, at],
    );
  const countRows = () => dbHelper.getRow("SELECT COUNT(*) AS n FROM chat_pinned_messages").n;

  test("migration 45 is registered and is the latest", () => {
    expect(migrations.find((m) => m.version === 45)).toBeTruthy();
    expect(Math.max(...migrations.map((m) => m.version))).toBeGreaterThanOrEqual(45);
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("has the expected columns, composite primary key and indexes", () => {
    const info = dbHelper.getAll("PRAGMA table_info(chat_pinned_messages)");
    expect(info.map((c) => c.name).sort()).toEqual(
      ["chat_id", "message_id", "pinned_at", "pinned_by"].sort(),
    );
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(["chat_id", "message_id"]);

    const indexes = dbHelper.getAll("PRAGMA index_list(chat_pinned_messages)").map((i) => i.name);
    expect(indexes).toContain("idx_chat_pinned_messages_chat_time");
    expect(indexes).toContain("idx_chat_pinned_messages_message");
    expect(indexes).toContain("idx_chat_pinned_messages_user");

    const timeIndex = dbHelper
      .getAll("PRAGMA index_info(idx_chat_pinned_messages_chat_time)")
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    expect(timeIndex).toEqual(["chat_id", "pinned_at"]);
  });

  test("a message can be pinned in its chat only once", () => {
    const { alice, bob, chat, message } = seed();
    pin(chat, message, alice);
    expect(() => pin(chat, message, bob)).toThrow();
    expect(countRows()).toBe(1);
  });

  test("a pin needs an existing chat and an existing message", () => {
    const { alice, chat, message } = seed();
    expect(() => pin(crypto.randomUUID(), message, alice)).toThrow();
    expect(() => pin(chat, crypto.randomUUID(), alice)).toThrow();
    expect(countRows()).toBe(0);
  });

  test("pinned_by is required to exist but may be null", () => {
    const { chat, message } = seed();
    pin(chat, message, null);
    expect(dbHelper.getRow("SELECT pinned_by FROM chat_pinned_messages").pinned_by).toBeNull();
    const other = crypto.randomUUID();
    dbHelper.run(
      "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, NULL, ?, ?)",
      [other, chat, "x", "2025-01-01 00:00:00"],
    );
    expect(() => pin(chat, other, crypto.randomUUID())).toThrow();
  });

  test("pins disappear with their message", () => {
    const { alice, chat, message } = seed();
    pin(chat, message, alice);
    dbHelper.run("DELETE FROM chat_messages WHERE id = ?", [message]);
    expect(countRows()).toBe(0);
  });

  test("pins disappear with their chat", () => {
    const { alice, chat, message } = seed();
    pin(chat, message, alice);
    dbHelper.run("DELETE FROM chat_messages WHERE chat_id = ?", [chat]);
    dbHelper.run("DELETE FROM chats WHERE id = ?", [chat]);
    expect(countRows()).toBe(0);
  });

  test("a pin outlives the person who made it", () => {
    const { alice, bob, chat, message } = seed();
    pin(chat, message, bob);
    dbHelper.run("DELETE FROM users WHERE id = ?", [bob]);
    expect(dbHelper.getAll("SELECT pinned_by FROM chat_pinned_messages")).toEqual([
      { pinned_by: null },
    ]);
    expect(alice).toBeTruthy();
  });

  test("chats get the members-can-pin setting, off by default", () => {
    const { chat } = seed();
    const columns = dbHelper.getAll("PRAGMA table_info(chats)");
    const column = columns.find((c) => c.name === "allow_member_pins");
    expect(column).toBeTruthy();
    expect(dbHelper.getRow("SELECT allow_member_pins AS v FROM chats WHERE id = ?", [chat]).v).toBe(0);
  });

  test("upgrading a version 44 database creates the table and the column, and re-running is safe", async () => {
    const raw = await createRawTestDb();
    try {
      const sorted = [...migrations].sort((a, b) => a.version - b.version);
      for (const migration of sorted.filter((m) => m.version <= 44)) {
        await migration.up(raw.migrationContext);
        raw.setSchemaVersion(migration.version);
      }
      expect(raw.tableExists("chat_pinned_messages")).toBe(false);
      expect(raw.hasColumn("chats", "allow_member_pins")).toBe(false);

      const m45 = sorted.find((m) => m.version === 45);
      await m45.up(raw.migrationContext);
      expect(raw.tableExists("chat_pinned_messages")).toBe(true);
      expect(raw.hasColumn("chats", "allow_member_pins")).toBe(true);

      await m45.up(raw.migrationContext);
      expect(raw.tableExists("chat_pinned_messages")).toBe(true);
    } finally {
      raw.close();
    }
  });
});
