import { describe, expect, test, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createRawTestDb, createTestDb, migrations } from "./testDbHelper.js";

describe("Message reactions schema (migration 044)", () => {
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

  const react = (messageId, userId, emoji) =>
    dbHelper.run(
      "INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
      [messageId, userId, emoji, new Date().toISOString()],
    );
  const countRows = () =>
    dbHelper.getRow("SELECT COUNT(*) AS n FROM message_reactions").n;

  test("migration 44 is registered and is the latest", () => {
    const m44 = migrations.find((m) => m.version === 44);
    expect(m44).toBeTruthy();
    expect(Math.max(...migrations.map((m) => m.version))).toBeGreaterThanOrEqual(44);
  });

  test("has the expected columns, composite primary key and a message index", () => {
    const info = dbHelper.getAll("PRAGMA table_info(message_reactions)");
    expect(info.map((c) => c.name).sort()).toEqual(
      ["created_at", "emoji", "message_id", "user_id"].sort(),
    );
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(["message_id", "user_id", "emoji"]);
    const indexes = dbHelper
      .getAll("PRAGMA index_list(message_reactions)")
      .map((i) => i.name);
    expect(indexes).toContain("idx_message_reactions_message");
    expect(indexes).toContain("idx_message_reactions_user");
  });

  test("the same person cannot add the same emoji twice, but may add different ones", () => {
    const { alice, bob, message } = seed();
    react(message, alice, "\u{1F44D}");
    expect(() => react(message, alice, "\u{1F44D}")).toThrow();
    react(message, alice, "❤️");
    react(message, bob, "\u{1F44D}");
    expect(countRows()).toBe(3);
  });

  test("a reaction needs an existing message and an existing person", () => {
    const { alice, message } = seed();
    expect(() => react(crypto.randomUUID(), alice, "\u{1F44D}")).toThrow();
    expect(() => react(message, crypto.randomUUID(), "\u{1F44D}")).toThrow();
  });

  test("reactions disappear with their message", () => {
    const { alice, bob, message } = seed();
    react(message, alice, "\u{1F44D}");
    react(message, bob, "\u{1F44D}");
    dbHelper.run("DELETE FROM chat_messages WHERE id = ?", [message]);
    expect(countRows()).toBe(0);
  });

  test("reactions disappear with the person who made them", () => {
    const { alice, bob, message } = seed();
    react(message, alice, "\u{1F44D}");
    react(message, bob, "\u{1F44D}");
    dbHelper.run("DELETE FROM users WHERE id = ?", [bob]);
    const left = dbHelper.getAll("SELECT user_id FROM message_reactions");
    expect(left).toEqual([{ user_id: alice }]);
  });

  test("upgrading a version 43 database creates the table", async () => {
    const raw = await createRawTestDb();
    try {
      const sorted = [...migrations].sort((a, b) => a.version - b.version);
      for (const migration of sorted.filter((m) => m.version <= 43)) {
        await migration.up(raw.migrationContext);
        raw.setSchemaVersion(migration.version);
      }
      expect(raw.tableExists("message_reactions")).toBe(false);
      const m44 = sorted.find((m) => m.version === 44);
      await m44.up(raw.migrationContext);
      expect(raw.tableExists("message_reactions")).toBe(true);
      // Re-running is a no-op.
      await m44.up(raw.migrationContext);
      expect(raw.tableExists("message_reactions")).toBe(true);
    } finally {
      raw.close();
    }
  });
});
