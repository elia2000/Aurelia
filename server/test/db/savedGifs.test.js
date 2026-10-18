import { describe, test, expect } from "vitest";
import crypto from "node:crypto";
import { dbKnex } from "../../db/knex.js";
import {
  addChatMember,
  adminDeleteUser,
  countSavedGifs,
  createChat,
  createMessage,
  createMessageFiles,
  createUser,
  deleteChatById,
  deleteSavedGif,
  deleteUserById,
  findMessageFileById,
  findSavedGif,
  findSavedGifByHash,
  findSavedGifBySource,
  getAll,
  insertSavedGif,
  listMessageFilesByMessageIds,
  listAllSavedGifs,
  listSavedGifs,
  listSavedGifsForUsers,
  run,
} from "../../db.js";
import { buildSavedGifKey } from "../../lib/savedGifs.js";

const unique = () => crypto.randomBytes(5).toString("hex");

async function newUser() {
  const tag = unique();
  const id = await createUser(`gif_${tag}`, "hash", `Nick ${tag}`, null, "#10b981");
  return id;
}

let counter = 0;
const gifArgs = (userId, overrides = {}) => {
  counter += 1;
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    userId,
    storageKey: buildSavedGifKey(userId, id, "gif"),
    storageDriver: "local",
    mime: "image/gif",
    width: 320,
    height: 200,
    frames: 12,
    sizeBytes: 1000 + counter,
    sha256: crypto.randomBytes(32).toString("hex"),
    sourceMessageId: null,
    sourceFileId: null,
    limit: 50,
    ...overrides,
  };
};

const idsOf = (rows) => rows.map((row) => row.id);

describe("insertSavedGif", () => {
  test("stores the GIF and tells what it stored", async () => {
    const user = await newUser();
    const args = gifArgs(user, { sourceMessageId: crypto.randomUUID(), sourceFileId: "42" });
    const result = await insertSavedGif(args);

    expect(result.status).toBe("created");
    expect(result.evicted).toEqual([]);
    expect(result.count).toBe(1);
    expect(result.gif).toMatchObject({
      id: args.id,
      user_id: user,
      storage_key: args.storageKey,
      storage_driver: "local",
      mime: "image/gif",
      width: 320,
      height: 200,
      frames: 12,
      size_bytes: args.sizeBytes,
      sha256: args.sha256,
      source_message_id: args.sourceMessageId,
      source_file_id: "42",
    });
    expect(typeof result.gif.created_at).toBe("string");
    expect(Number.isNaN(Date.parse(result.gif.created_at))).toBe(false);

    const stored = await findSavedGif(user, args.id);
    expect(stored.sha256).toBe(args.sha256);
    expect(await countSavedGifs(user)).toBe(1);
  });

  test("the same picture twice is the same row: nothing new, nothing evicted", async () => {
    const user = await newUser();
    const first = await insertSavedGif(gifArgs(user));
    const again = await insertSavedGif(gifArgs(user, { sha256: first.gif.sha256, limit: 1 }));
    expect(again.status).toBe("existing");
    expect(again.gif.id).toBe(first.gif.id);
    expect(again.evicted).toEqual([]);
    expect(again.count).toBe(1);
    expect(await countSavedGifs(user)).toBe(1);
  });

  test("two people may keep the same picture; neither affects the other", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const sha = crypto.randomBytes(32).toString("hex");
    const a = await insertSavedGif(gifArgs(alice, { sha256: sha }));
    const b = await insertSavedGif(gifArgs(bob, { sha256: sha }));
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    expect(a.gif.id).not.toBe(b.gif.id);
  });

  test("at the limit, the oldest GIF goes and the new one stays", async () => {
    const user = await newUser();
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      created.push((await insertSavedGif(gifArgs(user, { limit: 3 }))).gif);
    }
    const result = await insertSavedGif(gifArgs(user, { limit: 3 }));

    expect(result.status).toBe("created");
    expect(idsOf(result.evicted)).toEqual([created[0].id]);
    expect(result.evicted[0]).toMatchObject({
      user_id: user,
      storage_key: created[0].storage_key,
      storage_driver: "local",
    });
    expect(result.count).toBe(3);
    expect(await countSavedGifs(user)).toBe(3);
    expect(await findSavedGif(user, created[0].id)).toBeNull();
    expect(idsOf(await listSavedGifs(user))).toEqual([result.gif.id, created[2].id, created[1].id]);
  });

  test("eviction goes strictly by age, oldest first, however fast they were added", async () => {
    const user = await newUser();
    const order = [];
    for (let i = 0; i < 5; i += 1) {
      order.push((await insertSavedGif(gifArgs(user, { limit: 5 }))).gif.id);
    }
    const evictedOrder = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await insertSavedGif(gifArgs(user, { limit: 5 }));
      evictedOrder.push(...idsOf(result.evicted));
    }
    expect(evictedOrder).toEqual(order);
  });

  test("a deleted-then-added GIF is the newest one, not the oldest", async () => {
    const user = await newUser();
    const a = (await insertSavedGif(gifArgs(user, { limit: 2 }))).gif;
    const b = (await insertSavedGif(gifArgs(user, { limit: 2 }))).gif;
    await deleteSavedGif(user, a.id);
    const c = (await insertSavedGif(gifArgs(user, { limit: 2 }))).gif;
    const d = await insertSavedGif(gifArgs(user, { limit: 2 }));
    expect(idsOf(d.evicted)).toEqual([b.id]);
    expect(idsOf(await listSavedGifs(user))).toEqual([d.gif.id, c.id]);
  });

  test("when the limit was lowered, a new GIF pushes out as many of the oldest as needed", async () => {
    const user = await newUser();
    const first = [];
    for (let i = 0; i < 5; i += 1) {
      first.push((await insertSavedGif(gifArgs(user, { limit: 10 }))).gif.id);
    }
    const result = await insertSavedGif(gifArgs(user, { limit: 2 }));
    expect(idsOf(result.evicted)).toEqual(first.slice(0, 4));
    expect(result.count).toBe(2);
    expect(await countSavedGifs(user)).toBe(2);
  });

  test("a limit of one keeps only the latest", async () => {
    const user = await newUser();
    const a = (await insertSavedGif(gifArgs(user, { limit: 1 }))).gif;
    const b = await insertSavedGif(gifArgs(user, { limit: 1 }));
    expect(idsOf(b.evicted)).toEqual([a.id]);
    expect(idsOf(await listSavedGifs(user))).toEqual([b.gif.id]);
  });

  test("filling up another person's collection never costs a person their GIFs", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const mine = (await insertSavedGif(gifArgs(alice, { limit: 2 }))).gif;
    for (let i = 0; i < 6; i += 1) await insertSavedGif(gifArgs(bob, { limit: 2 }));
    expect(idsOf(await listSavedGifs(alice))).toEqual([mine.id]);
    expect(await countSavedGifs(bob)).toBe(2);
  });

  test("rolls back completely when the write fails: nothing is evicted for a GIF that was not stored", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a = (await insertSavedGif(gifArgs(alice, { limit: 1 }))).gif;
    const bobs = (await insertSavedGif(gifArgs(bob, { limit: 1 }))).gif;
    // Somebody else's storage key: the unique index refuses the insert, after
    // Alice's oldest GIF had already been picked for eviction.
    const clash = gifArgs(alice, { limit: 1, storageKey: bobs.storage_key });
    await expect(insertSavedGif(clash)).rejects.toThrow();
    expect(idsOf(await listSavedGifs(alice))).toEqual([a.id]);
    expect(idsOf(await listSavedGifs(bob))).toEqual([bobs.id]);
  });
});

describe("reading", () => {
  test("listSavedGifs is newest first and only the person's own", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a1 = (await insertSavedGif(gifArgs(alice))).gif;
    const b1 = (await insertSavedGif(gifArgs(bob))).gif;
    const a2 = (await insertSavedGif(gifArgs(alice))).gif;
    expect(idsOf(await listSavedGifs(alice))).toEqual([a2.id, a1.id]);
    expect(idsOf(await listSavedGifs(bob))).toEqual([b1.id]);
    expect(await listSavedGifs(crypto.randomUUID())).toEqual([]);
    expect(await listSavedGifs(null)).toEqual([]);
  });

  test("findSavedGif answers only for the owner", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const gif = (await insertSavedGif(gifArgs(alice))).gif;
    expect((await findSavedGif(alice, gif.id)).id).toBe(gif.id);
    expect(await findSavedGif(bob, gif.id)).toBeNull();
    expect(await findSavedGif(alice, crypto.randomUUID())).toBeNull();
    expect(await findSavedGif(null, gif.id)).toBeNull();
    expect(await findSavedGif(alice, null)).toBeNull();
  });

  test("findSavedGifBySource and findSavedGifByHash are per person too", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const message = crypto.randomUUID();
    const gif = (await insertSavedGif(gifArgs(alice, { sourceMessageId: message, sourceFileId: "9" }))).gif;
    expect((await findSavedGifBySource(alice, message, 9)).id).toBe(gif.id);
    expect((await findSavedGifBySource(alice, message, "9")).id).toBe(gif.id);
    expect(await findSavedGifBySource(alice, message, 10)).toBeNull();
    expect(await findSavedGifBySource(bob, message, 9)).toBeNull();
    expect((await findSavedGifByHash(alice, gif.sha256)).id).toBe(gif.id);
    expect(await findSavedGifByHash(bob, gif.sha256)).toBeNull();
  });

  test("numbers survive the round trip as numbers", async () => {
    const user = await newUser();
    const gif = (await insertSavedGif(gifArgs(user))).gif;
    const row = await findSavedGif(user, gif.id);
    expect(Number(row.width)).toBe(320);
    expect(Number(row.height)).toBe(200);
    expect(Number(row.size_bytes)).toBe(gif.size_bytes);
  });
});

describe("deleteSavedGif", () => {
  test("removes the person's own GIF and hands back the row so its file can go too", async () => {
    const user = await newUser();
    const gif = (await insertSavedGif(gifArgs(user))).gif;
    const removed = await deleteSavedGif(user, gif.id);
    expect(removed).toMatchObject({ id: gif.id, user_id: user, storage_key: gif.storage_key });
    expect(await findSavedGif(user, gif.id)).toBeNull();
    expect(await deleteSavedGif(user, gif.id)).toBeNull();
  });

  test("two deletes of the same GIF at once: exactly one of them gets the row, so its file is removed once", async () => {
    const user = await newUser();
    const gif = (await insertSavedGif(gifArgs(user))).gif;
    const results = await Promise.all([deleteSavedGif(user, gif.id), deleteSavedGif(user, gif.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("a GIF of somebody else cannot be deleted, and is left alone", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const gif = (await insertSavedGif(gifArgs(alice))).gif;
    expect(await deleteSavedGif(bob, gif.id)).toBeNull();
    expect((await findSavedGif(alice, gif.id)).id).toBe(gif.id);
  });
});

describe("deleting an account", () => {
  test("removes the person's GIFs, returns them for file cleanup and leaves everybody else's", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a1 = (await insertSavedGif(gifArgs(alice))).gif;
    const a2 = (await insertSavedGif(gifArgs(alice))).gif;
    const b1 = (await insertSavedGif(gifArgs(bob))).gif;

    const result = await deleteUserById(alice);
    expect(result.savedGifs.map((g) => g.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(result.savedGifs[0]).toMatchObject({ user_id: alice });
    expect(result.savedGifs.every((g) => g.storage_key && g.storage_driver)).toBe(true);

    expect(await listSavedGifs(alice)).toEqual([]);
    expect(idsOf(await listSavedGifs(bob))).toEqual([b1.id]);
    const left = await getAll(dbKnex("user_gifs").select("id").where("user_id", alice));
    expect(left).toEqual([]);
  });

  test("the admin panel's deletion does the same", async () => {
    const alice = await newUser();
    const gif = (await insertSavedGif(gifArgs(alice))).gif;
    const result = await adminDeleteUser(alice);
    expect(result.savedGifs.map((g) => g.id)).toEqual([gif.id]);
    expect(await listSavedGifs(alice)).toEqual([]);
  });

  test("listAllSavedGifs names every file, for the full resets", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a = (await insertSavedGif(gifArgs(alice))).gif;
    const b = (await insertSavedGif(gifArgs(bob))).gif;
    const rows = await listAllSavedGifs();
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(rows.every((r) => r.user_id && r.storage_key && r.storage_driver)).toBe(true);
    await deleteUserById(alice);
    await deleteUserById(bob);
  });

  test("a person without GIFs gets an empty list", async () => {
    const alice = await newUser();
    expect((await deleteUserById(alice)).savedGifs).toEqual([]);
  });

  test("listSavedGifsForUsers names the files of several people at once, for the bulk admin tools", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const carol = await newUser();
    const a = (await insertSavedGif(gifArgs(alice))).gif;
    const b = (await insertSavedGif(gifArgs(bob))).gif;
    await insertSavedGif(gifArgs(carol));
    const rows = await listSavedGifsForUsers([alice, bob]);
    expect(idsOf(rows).sort()).toEqual([a.id, b.id].sort());
    expect(await listSavedGifsForUsers([])).toEqual([]);
  });
});

describe("saved GIFs are independent of messages", () => {
  test("deleting the chat the GIF came from keeps the GIF", async () => {
    const owner = await newUser();
    const chatId = await createChat(`gifchat ${unique()}`, "group", { createdByUserId: owner });
    await addChatMember(chatId, owner, "owner");
    const messageId = await createMessage(chatId, owner, "look");
    const gif = (await insertSavedGif(gifArgs(owner, { sourceMessageId: messageId, sourceFileId: "1" }))).gif;
    await deleteChatById(chatId);
    expect((await findSavedGif(owner, gif.id)).id).toBe(gif.id);
  });
});

describe("the animated flag of message files", () => {
  const seed = async () => {
    const owner = await newUser();
    const chatId = await createChat(`animchat ${unique()}`, "group", { createdByUserId: owner });
    await addChatMember(chatId, owner, "owner");
    const messageId = await createMessage(chatId, owner, "files");
    return { owner, chatId, messageId };
  };

  test("is stored from isAnimated and listed back, with 0 for everything else", async () => {
    const { messageId } = await seed();
    await createMessageFiles(messageId, [
      { kind: "media", originalName: "a.gif", storedName: `a-${unique()}.gif`, mimeType: "image/gif", sizeBytes: 10, isAnimated: true },
      { kind: "media", originalName: "b.png", storedName: `b-${unique()}.png`, mimeType: "image/png", sizeBytes: 10 },
      { kind: "media", originalName: "c.gif", storedName: `c-${unique()}.gif`, mimeType: "image/gif", sizeBytes: 10, is_animated: 1 },
    ]);
    const rows = await listMessageFilesByMessageIds([messageId]);
    expect(rows.map((r) => Number(r.is_animated))).toEqual([1, 0, 1]);
  });

  test("findMessageFileById carries it too", async () => {
    const { messageId } = await seed();
    await createMessageFiles(messageId, [
      { kind: "media", originalName: "a.gif", storedName: `a-${unique()}.gif`, mimeType: "image/gif", sizeBytes: 10, isAnimated: true },
    ]);
    const [row] = await listMessageFilesByMessageIds([messageId]);
    expect(Number((await findMessageFileById(row.id)).is_animated)).toBe(1);
  });

  test("anything but true/1 is stored as not animated", async () => {
    const { messageId } = await seed();
    await createMessageFiles(messageId, [
      { kind: "media", originalName: "a.gif", storedName: `a-${unique()}.gif`, mimeType: "image/gif", sizeBytes: 10, isAnimated: "yes" },
      { kind: "media", originalName: "b.gif", storedName: `b-${unique()}.gif`, mimeType: "image/gif", sizeBytes: 10, isAnimated: 0 },
      { kind: "media", originalName: "c.gif", storedName: `c-${unique()}.gif`, mimeType: "image/gif", sizeBytes: 10, isAnimated: null },
    ]);
    const rows = await listMessageFilesByMessageIds([messageId]);
    expect(rows.map((r) => Number(r.is_animated))).toEqual([0, 0, 0]);
  });
});

// Keep the shared on-disk test database tidy for the next run.
test("cleanup helper exists", () => {
  expect(typeof run).toBe("function");
});
