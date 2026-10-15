import { describe, expect, test, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createTestDb } from "./testDbHelper.js";

describe("E2EE schema (migrations 042 and 043)", () => {
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

  const columns = (table) =>
    dbHelper.getAll(`PRAGMA table_info(${table})`).map((c) => c.name);

  test("e2ee_devices stores public keys only and has a per-user lookup index", () => {
    expect(columns("e2ee_devices").sort()).toEqual(
      [
        "created_at",
        "ecdh_public",
        "ecdsa_public",
        "id",
        "label",
        "last_seen_at",
        "revoked_at",
        "user_id",
      ].sort(),
    );
    const indexes = dbHelper
      .getAll("PRAGMA index_list(e2ee_devices)")
      .map((i) => i.name);
    expect(indexes).toContain("idx_e2ee_devices_user");
  });

  test("chat_messages has a nullable e2ee_envelope column", () => {
    expect(columns("chat_messages")).toContain("e2ee_envelope");
    const userId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [userId, "alice", "h"]);
    dbHelper.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [chatId, "c", "dm"]);
    dbHelper.run(
      "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      [messageId, chatId, userId, "x", "2025-01-01 00:00:00"],
    );
    expect(
      dbHelper.getRow("SELECT e2ee_envelope FROM chat_messages WHERE id = ?", [messageId]).e2ee_envelope,
    ).toBeNull();
    dbHelper.run("UPDATE chat_messages SET e2ee_envelope = ? WHERE id = ?", ['{"v":1}', messageId]);
    expect(
      dbHelper.getRow("SELECT e2ee_envelope FROM chat_messages WHERE id = ?", [messageId]).e2ee_envelope,
    ).toBe('{"v":1}');
  });

  test("migrations 42 and 43 are registered", async () => {
    const { migrations } = await import("./testDbHelper.js");
    const m42 = migrations.find((m) => m.version === 42);
    const m43 = migrations.find((m) => m.version === 43);
    expect(m42).toBeTruthy();
    expect(m43).toBeTruthy();
  });
});
