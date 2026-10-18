import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { buildGif } from "../helpers/imageBytes.js";

const serverDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

const run = (args, dataDir) =>
  execFileSync(process.execPath, args, {
    cwd: serverDir,
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: dataDir, DB_CLIENT: "sqlite3", SERVER_PORT: "0" },
  });

const evalInDb = (dataDir, body) =>
  run(
    [
      "--input-type=module",
      "--eval",
      `
      import { openDatabase } from "./scripts/_db-admin.js";
      const db = await openDatabase();
      ${body}
      await db.save();
      await db.close();
    `,
    ],
    dataDir,
  );

describe("db:user:delete and saved GIFs", () => {
  test("deleting a user removes their GIF rows and local files, and nobody else's", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "songbird-delete-user-gifs-"));
    const dataDir = path.join(tempDir, "data");
    const aliceGif = crypto.randomUUID();
    const bobGif = crypto.randomUUID();
    const bytes = buildGif({ frames: 3 }).toString("base64");

    try {
      run(["scripts/create-user.js", "--nickname", "Alice", "--username", "alice", "--password", "pw-alice-1"], dataDir);
      run(["scripts/create-user.js", "--nickname", "Bob", "--username", "bob", "--password", "pw-bob-1"], dataDir);

      // One GIF each, rows and local files.
      evalInDb(
        dataDir,
        `
        import fs from "node:fs";
        import path from "node:path";
        const alice = (await db.getRow("SELECT id FROM users WHERE username = 'alice'")).id;
        const bob = (await db.getRow("SELECT id FROM users WHERE username = 'bob'")).id;
        const put = async (userId, gifId) => {
          const key = "gifs/" + userId + "/" + gifId + ".gif";
          const file = path.join(process.env.DATA_DIR, "uploads", key);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from("${bytes}", "base64"));
          await db.run(
            "INSERT INTO user_gifs (id, user_id, storage_key, storage_driver, mime, size_bytes, sha256, created_at) VALUES (?, ?, ?, 'local', 'image/gif', 10, ?, ?)",
            [gifId, userId, key, gifId, new Date().toISOString()],
          );
        };
        await put(alice, "${aliceGif}");
        await put(bob, "${bobGif}");
        `,
      );

      const output = run(["scripts/delete-user.js", "alice", "-y"], dataDir);
      expect(output).toContain("Users deleted: 1");
      expect(output).toContain("Saved GIF files removed: 1");

      const rows = JSON.parse(
        run(
          [
            "--input-type=module",
            "--eval",
            `
            import { openDatabase } from "./scripts/_db-admin.js";
            const db = await openDatabase();
            const rows = await db.getAll("SELECT id FROM user_gifs");
            await db.close();
            process.stdout.write(JSON.stringify(rows));
          `,
          ],
          dataDir,
        ),
      );
      expect(rows).toEqual([{ id: bobGif }]);

      const gifsRoot = path.join(dataDir, "uploads", "gifs");
      const left = fs.readdirSync(gifsRoot);
      expect(left).toHaveLength(1);
      expect(fs.readdirSync(path.join(gifsRoot, left[0]))).toEqual([`${bobGif}.gif`]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
