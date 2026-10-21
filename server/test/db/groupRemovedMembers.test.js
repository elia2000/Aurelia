import { describe, test, expect } from "vitest";
import crypto from "node:crypto";
import {
  clearGroupMemberRemoved,
  isGroupMemberRemoved,
  markGroupMemberRemoved,
} from "../../db.js";
import { createRawTestDb, migrations } from "./testDbHelper.js";

// Removing a member from a group writes a marker that keeps them from joining
// again on their own (only the owner can re-add them). Migration 036 rebuilt the
// table on SQLite without the column that records who removed them, and the
// write failed with "no column named removed_by_user_id": the marker was never
// stored, so the removed person could rejoin at once.
describe("group_removed_members", () => {
  const ids = () => ({
    chat: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    member: crypto.randomUUID(),
  });

  test("a removed member is marked (and the mark can be renewed and cleared)", async () => {
    const { chat, owner, member } = ids();
    expect(await isGroupMemberRemoved(chat, member)).toBe(false);
    await markGroupMemberRemoved(chat, member, owner);
    expect(await isGroupMemberRemoved(chat, member)).toBe(true);
    // removed again later (re-added, then removed once more): the mark is renewed
    await markGroupMemberRemoved(chat, member, owner);
    expect(await isGroupMemberRemoved(chat, member)).toBe(true);
    // only that person in that chat
    expect(await isGroupMemberRemoved(chat, owner)).toBe(false);
    expect(await isGroupMemberRemoved(crypto.randomUUID(), member)).toBe(false);
    await clearGroupMemberRemoved(chat, member);
    expect(await isGroupMemberRemoved(chat, member)).toBe(false);
  });
});

describe("group_removed_members schema (migration 049)", () => {
  test("migration 49 is registered once", () => {
    expect(migrations.filter((m) => m.version === 49)).toHaveLength(1);
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("a database upgraded from 48 gets the column back, and re-running is a no-op", async () => {
    const raw = await createRawTestDb();
    try {
      const sorted = [...migrations].sort((a, b) => a.version - b.version);
      for (const migration of sorted.filter((m) => m.version <= 48)) {
        await migration.up(raw.migrationContext);
        raw.setSchemaVersion(migration.version);
      }
      // what migration 036 left on SQLite
      expect(raw.tableExists("group_removed_members")).toBe(true);
      expect(raw.hasColumn("group_removed_members", "removed_by_user_id")).toBe(false);

      const m49 = sorted.find((m) => m.version === 49);
      await m49.up(raw.migrationContext);
      expect(raw.hasColumn("group_removed_members", "removed_by_user_id")).toBe(true);
      await m49.up(raw.migrationContext);
      expect(raw.hasColumn("group_removed_members", "removed_by_user_id")).toBe(true);

      // rows that were written before keep working
      raw.run("INSERT INTO group_removed_members (chat_id, user_id, removed_at) VALUES (?, ?, ?)", ["c", "u", "2026-01-01 00:00:00"]);
      expect(raw.getRow("SELECT removed_by_user_id FROM group_removed_members").removed_by_user_id).toBeNull();
    } finally {
      raw.close();
    }
  });
});
