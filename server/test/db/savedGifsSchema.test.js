import { describe, expect, test, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createRawTestDb, createTestDb, migrations } from "./testDbHelper.js";

describe("Saved GIFs schema (migration 048)", () => {
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

  const seedUsers = () => {
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [alice, "alice", "h"]);
    dbHelper.run("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [bob, "bob", "h"]);
    return { alice, bob };
  };

  const insertGif = (userId, extra = {}) => {
    const id = extra.id ?? crypto.randomUUID();
    dbHelper.run(
      `INSERT INTO user_gifs
         (id, user_id, storage_key, storage_driver, mime, width, height, frames, size_bytes, sha256, created_at,
          source_message_id, source_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        extra.storageKey ?? `gifs/${userId}/${id}.gif`,
        extra.storageDriver ?? "local",
        extra.mime ?? "image/gif",
        extra.width ?? 320,
        extra.height ?? 200,
        extra.frames ?? 12,
        extra.size ?? 1024,
        extra.sha ?? crypto.randomBytes(32).toString("hex"),
        extra.createdAt ?? new Date().toISOString(),
        extra.sourceMessageId ?? null,
        extra.sourceFileId ?? null,
      ],
    );
    return id;
  };

  const countGifs = () => dbHelper.getRow("SELECT COUNT(*) AS n FROM user_gifs").n;

  test("migration 48 is registered once and is the latest", () => {
    expect(migrations.filter((m) => m.version === 48)).toHaveLength(1);
    expect(Math.max(...migrations.map((m) => m.version))).toBeGreaterThanOrEqual(48);
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("has the documented columns", () => {
    const info = dbHelper.getAll("PRAGMA table_info(user_gifs)");
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        "created_at",
        "frames",
        "height",
        "id",
        "mime",
        "sha256",
        "size_bytes",
        "source_file_id",
        "source_message_id",
        "storage_driver",
        "storage_key",
        "user_id",
        "width",
      ].sort(),
    );
    expect(byName.id.pk).toBe(1);
    for (const required of ["user_id", "storage_key", "storage_driver", "mime", "size_bytes", "sha256", "created_at"]) {
      expect(byName[required].notnull, required).toBe(1);
    }
    for (const optional of ["width", "height", "frames", "source_message_id", "source_file_id"]) {
      expect(byName[optional].notnull, `${optional} must be nullable`).toBe(0);
    }
  });

  test("is indexed for the access patterns: a person's GIFs by age, duplicates and keys", () => {
    const indexes = dbHelper.getAll("PRAGMA index_list(user_gifs)");
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_user_gifs_user_created");
    expect(names).toContain("idx_user_gifs_user_sha256");
    expect(names).toContain("idx_user_gifs_storage_key");

    const columnsOf = (name) =>
      dbHelper.getAll(`PRAGMA index_info(${name})`).sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
    expect(columnsOf("idx_user_gifs_user_created")).toEqual(["user_id", "created_at"]);
    expect(columnsOf("idx_user_gifs_user_sha256")).toEqual(["user_id", "sha256"]);
    expect(indexes.find((i) => i.name === "idx_user_gifs_user_sha256").unique).toBe(1);
    expect(indexes.find((i) => i.name === "idx_user_gifs_storage_key").unique).toBe(1);
  });

  test("the same person cannot hold the same picture twice, but two people can", () => {
    const { alice, bob } = seedUsers();
    const sha = "ab".repeat(32);
    insertGif(alice, { sha });
    expect(() => insertGif(alice, { sha })).toThrow();
    insertGif(bob, { sha });
    expect(countGifs()).toBe(2);
  });

  test("a storage key can only ever belong to one row", () => {
    const { alice, bob } = seedUsers();
    insertGif(alice, { storageKey: "gifs/shared/key.gif" });
    expect(() => insertGif(bob, { storageKey: "gifs/shared/key.gif" })).toThrow();
  });

  test("a GIF needs an existing person", () => {
    expect(() => insertGif(crypto.randomUUID())).toThrow();
  });

  test("GIFs disappear with the person who saved them, and only theirs", () => {
    const { alice, bob } = seedUsers();
    insertGif(alice);
    insertGif(alice);
    const bobGif = insertGif(bob);
    dbHelper.run("DELETE FROM users WHERE id = ?", [alice]);
    expect(dbHelper.getAll("SELECT id FROM user_gifs")).toEqual([{ id: bobGif }]);
  });

  test("the source message is only a note: deleting the message leaves the GIF alone", () => {
    const { alice } = seedUsers();
    const chat = crypto.randomUUID();
    const message = crypto.randomUUID();
    dbHelper.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [chat, "c", "group"]);
    dbHelper.run(
      "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      [message, chat, alice, "gif", "2026-01-01 00:00:00"],
    );
    insertGif(alice, { sourceMessageId: message, sourceFileId: "7" });
    dbHelper.run("DELETE FROM chat_messages WHERE id = ?", [message]);
    expect(countGifs()).toBe(1);
  });

  test("message files gain an is_animated flag that defaults to 0", () => {
    const info = dbHelper.getAll("PRAGMA table_info(chat_message_files)");
    const column = info.find((c) => c.name === "is_animated");
    expect(column).toBeTruthy();
    expect(column.notnull).toBe(1);
    expect(String(column.dflt_value)).toBe("0");

    const { alice } = seedUsers();
    const chat = crypto.randomUUID();
    const message = crypto.randomUUID();
    dbHelper.run("INSERT INTO chats (id, name, type) VALUES (?, ?, ?)", [chat, "c", "group"]);
    dbHelper.run(
      "INSERT INTO chat_messages (id, chat_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      [message, chat, alice, "file", "2026-01-01 00:00:00"],
    );
    dbHelper.run(
      `INSERT INTO chat_message_files (message_id, kind, original_name, stored_name, mime_type, size_bytes)
       VALUES (?, 'media', 'a.gif', 'a.gif', 'image/gif', 10)`,
      [message],
    );
    expect(dbHelper.getRow("SELECT is_animated FROM chat_message_files").is_animated).toBe(0);
  });

  test("upgrading a version 47 database creates the table and the column, and re-running is a no-op", async () => {
    const raw = await createRawTestDb();
    try {
      const sorted = [...migrations].sort((a, b) => a.version - b.version);
      for (const migration of sorted.filter((m) => m.version <= 47)) {
        await migration.up(raw.migrationContext);
        raw.setSchemaVersion(migration.version);
      }
      expect(raw.tableExists("user_gifs")).toBe(false);
      expect(raw.hasColumn("chat_message_files", "is_animated")).toBe(false);

      const m48 = sorted.find((m) => m.version === 48);
      await m48.up(raw.migrationContext);
      expect(raw.tableExists("user_gifs")).toBe(true);
      expect(raw.hasColumn("chat_message_files", "is_animated")).toBe(true);

      await m48.up(raw.migrationContext);
      expect(raw.tableExists("user_gifs")).toBe(true);
      expect(raw.hasColumn("chat_message_files", "is_animated")).toBe(true);
    } finally {
      raw.close();
    }
  });
});
