import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import initSqlJs from "sql.js";
import Database from "better-sqlite3";
import { dbKnex } from "./db/knex.js";
import { normalizeSqlForPostgres } from "./lib/sqlNormalizer.js";
import { migrations } from "./migrations/index.js";
import { setUserColor } from "./settings/colors.js";
import { generateOrderedUuid, generateUuid, isValidUuid } from "./lib/uuidUtils.js";
import { storageEncryption } from "./lib/storageEncryption.js";
import { ensureSystemSecrets } from "./lib/secrets.js";
import { REACTION_USERS_CAP, planReactionChange } from "./lib/reactions.js";
import { animationFlags } from "./lib/animatedImage.js";
import {
  decideChatPin,
  planCompaction as planPinCompaction,
  planReorder as planPinReorder,
} from "./lib/chatPins.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRootDir = path.resolve(serverDir, "..");
dotenv.config({ path: path.join(projectRootDir, ".env"), quiet: true });
dotenv.config({ path: path.join(serverDir, ".env"), quiet: true });
const dataDir = path.resolve(process.env.DATA_DIR || path.resolve(serverDir, "..", "data"));
const dbPath = path.join(dataDir, "songbird.db");
const backupDir = path.join(dataDir, "backups");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const REMOTE_MESSAGE_CLIENT_REQUEST_SQL =
  "LOWER(COALESCE(client_request_id, '')) LIKE 'remote:%'";

export const isRemoteMessageClientRequestId = (value) =>
  /^remote:/i.test(String(value || "").trim());

export const isRemoteMessageRow = (row) =>
  isRemoteMessageClientRequestId(row?.client_request_id || row?.clientRequestId);

function isPostgresMode() {
  const client = (process.env.DB_CLIENT || "sqlite3").toLowerCase();
  return client === "postgres" || client === "postgresql" || client === "pg";
}

function getPostgresRows(result) {
  const rows = Array.isArray(result) ? result : result?.rows || [];
  return rows.length === 1 && Array.isArray(rows[0]?.rows) ? rows[0].rows : rows;
}

let betterDb = null;
let SQL = null;
let db = null;

if (!isPostgresMode()) {
  try {
    betterDb = new Database(dbPath);
    betterDb.pragma("journal_mode = WAL");
  } catch (err) {
    // fallback to sql.js if better-sqlite3 cannot be initialized
    betterDb = null;
  }

  if (!betterDb) {
    SQL = await initSqlJs({
      locateFile: (file) =>
        path.resolve(serverDir, "node_modules", "sql.js", "dist", file),
    });

    const fileExists = fs.existsSync(dbPath);
    const fileBuffer = fileExists ? fs.readFileSync(dbPath) : null;
    db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();
  }
}

const fileExists = fs.existsSync(dbPath);
const DB_SAVE_DEBOUNCE_MS = Math.max(
  0,
  Number(process.env.DB_SAVE_DEBOUNCE_MS || 150),
);
let pendingSaveTimer = null;
let databaseDirty = false;

function writeDatabaseToDisk() {
  if (db && typeof db.export === "function") {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }
  databaseDirty = false;
}

// Reload the in-memory database from the file on disk. Used after a restore
// replaces songbird.db underneath the running process. Cancels any pending
// debounced save first so we never overwrite the freshly restored file.
function reloadDatabaseFromDisk() {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  databaseDirty = false;
  if (!fs.existsSync(dbPath)) {
    throw new Error("Database file not found on disk.");
  }
  if (betterDb) {
    try {
      betterDb.close();
    } catch {}
    try {
      betterDb = new Database(dbPath);
      betterDb.pragma("journal_mode = WAL");
    } catch {}
  }
  if (SQL) {
    const buffer = fs.readFileSync(dbPath);
    const next = new SQL.Database(buffer);
    try {
      if (db) db.close();
    } catch {}
    db = next;
  }
}

function createPreMigrationBackup(fromVersion, toVersion) {
  if (!fileExists || !fs.existsSync(dbPath)) return null;

  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      backupDir,
      `songbird-pre-migration-v${fromVersion}-to-v${toVersion}-${stamp}.db`,
    );
    fs.copyFileSync(dbPath, backupPath);
    return backupPath;
  } catch (error) {
    throw new Error(
      `Unable to create pre-migration database backup: ${
        error?.message || error
      }`,
    );
  }
}

function saveDatabase() {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  if (!databaseDirty && fileExists) return;
  writeDatabaseToDisk();
}

function scheduleDatabaseSave() {
  databaseDirty = true;
  if (pendingSaveTimer) return;
  if (DB_SAVE_DEBOUNCE_MS <= 0) {
    saveDatabase();
    return;
  }
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    if (!databaseDirty) return;
    writeDatabaseToDisk();
  }, DB_SAVE_DEBOUNCE_MS);
  if (typeof pendingSaveTimer?.unref === "function") {
    pendingSaveTimer.unref();
  }
}

function extractSqlAndParams(sqlOrBuilder, params = []) {
  if (sqlOrBuilder && typeof sqlOrBuilder.toSQL === "function") {
    const compiled = sqlOrBuilder.toSQL();
    return { sql: compiled.sql, params: compiled.bindings || [] };
  }
  return { sql: sqlOrBuilder, params };
}

export function getRow(sqlOrBuilder, params = []) {
  const { sql, params: normParamsInput } = extractSqlAndParams(sqlOrBuilder, params);
  if (isPostgresMode()) {
    const { sql: normSql, params: normParams } = normalizeSqlForPostgres(sql, normParamsInput);
    const result = dbKnex.raw(normSql, normParams);
    if (result && typeof result.then === "function") {
      return result.then((res) => {
        const rows = getPostgresRows(res);
        return rows[0] || null;
      });
    }
    const rows = getPostgresRows(result);
    return rows[0] || null;
  }

  const normalizedParams = Array.isArray(normParamsInput) ? normParamsInput : [normParamsInput];

  if (betterDb) {
    const stmt = betterDb.prepare(sql);
    return stmt.get(...normalizedParams) || null;
  }

  if (!db) return null;

  const stmt = db.prepare(sql);
  stmt.bind(normalizedParams);

  const row = stmt.step() ? stmt.getAsObject() : null;

  stmt.free();

  return row;
}

export function getAll(sqlOrBuilder, params = []) {
  const { sql, params: normParamsInput } = extractSqlAndParams(sqlOrBuilder, params);
  if (isPostgresMode()) {
    const { sql: normSql, params: normParams } = normalizeSqlForPostgres(sql, normParamsInput);
    const result = dbKnex.raw(normSql, normParams);
    if (result && typeof result.then === "function") {
      return result.then(getPostgresRows);
    }
    return getPostgresRows(result);
  }

  const normalizedParams = Array.isArray(normParamsInput) ? normParamsInput : [normParamsInput];

  if (betterDb) {
    const stmt = betterDb.prepare(sql);
    return stmt.all(...normalizedParams);
  }

  if (!db) return [];

  const stmt = db.prepare(sql);
  stmt.bind(normalizedParams);

  const rows = [];

  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.free();

  return rows;
}

export function run(sqlOrBuilder, params = []) {
  const { sql, params: normParamsInput } = extractSqlAndParams(sqlOrBuilder, params);
  if (isPostgresMode()) {
    const { sql: normSql, params: normParams } = normalizeSqlForPostgres(sql, normParamsInput);
    const result = dbKnex.raw(normSql, normParams);
    if (result && typeof result.then === "function") {
      return result.then((res) => {
        if (typeof res?.rowCount === "number") return res.rowCount;
        const rows = getPostgresRows(res);
        return rows.length;
      });
    }
    if (typeof result?.rowCount === "number") return result.rowCount;
    const rows = getPostgresRows(result);
    return rows.length;
  }

  const normalizedParams = Array.isArray(normParamsInput) ? normParamsInput : [normParamsInput];

  if (betterDb) {
    const stmt = betterDb.prepare(sql);
    const info = stmt.run(...normalizedParams);
    return info.changes;
  }

  if (!db) return 0;

  const stmt = db.prepare(sql);

  stmt.bind(normalizedParams);
  stmt.step();
  stmt.free();

  const changedRows =
    typeof db.getRowsModified === "function" ? Number(db.getRowsModified()) : 1;
  if (changedRows > 0) {
    scheduleDatabaseSave();
  }
  return changedRows;
}

function runWithoutSave(sqlOrBuilder, params = []) {
  if (isPostgresMode()) {
    return run(sqlOrBuilder, params);
  }
  const { sql, params: normParamsInput } = extractSqlAndParams(sqlOrBuilder, params);
  const normalizedParams = Array.isArray(normParamsInput) ? normParamsInput : [normParamsInput];
  if (betterDb) {
    const stmt = betterDb.prepare(sql);
    stmt.run(...normalizedParams);
    return;
  }
  const stmt = db.prepare(sql);

  stmt.bind(normalizedParams);
  stmt.step();
  stmt.free();
}

function getLastInsertId() {
  const raw = getRow("SELECT last_insert_rowid() AS id");
  if (raw && typeof raw.then === "function") {
    return raw.then((row) => (row?.id ? Number(row.id) : null));
  }
  return raw?.id ? Number(raw.id) : null;
}

function decryptMessageRow(row) {
  if (!row) return row;

  const next = { ...row };

  if (typeof next.edited_body === "string") {
    next.edited_body = storageEncryption.decryptText(next.edited_body);
  }

  if (typeof next.body === "string") {
    next.body = storageEncryption.decryptText(next.body);
  }

  if (typeof next.last_message === "string") {
    next.last_message = storageEncryption.decryptText(next.last_message);
  }

  if (typeof next.reply_body === "string") {
    next.reply_body = storageEncryption.decryptText(next.reply_body);
  }

  return next;
}

function getVisibleMessageFilterSql(alias = "chat_messages", viewerClause = "") {
  const safeAlias = alias || "chat_messages";
  return `${safeAlias}.hidden_everyone_at IS NULL
    AND ${safeAlias}.id NOT IN (
      SELECT hidden_chat_messages.message_id
      FROM hidden_chat_messages
      ${viewerClause}
    )`;
}

function updateSchemaSetsFromSql(sql, tablesSet, columnsSet) {
  if (!sql || typeof sql !== "string") return;

  const statements = sql.split(";");
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;

    const createMatch = trimmed.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?([a-zA-Z0-9_]+)["`']?\s*\(([\s\S]+)\)/i,
    );
    if (createMatch) {
      const tableName = createMatch[1].toLowerCase();
      tablesSet.add(tableName);
      const body = createMatch[2];
      const lines = body.split(",");
      for (const line of lines) {
        const colTrimmed = line.trim();
        if (!colTrimmed) continue;
        if (
          /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(
            colTrimmed,
          )
        ) {
          continue;
        }
        const colMatch = colTrimmed.match(/^["`']?([a-zA-Z0-9_]+)["`']?/);
        if (colMatch) {
          const colName = colMatch[1].toLowerCase();
          columnsSet.add(`${tableName}.${colName}`);
        }
      }
    }

    const alterMatch = trimmed.match(
      /ALTER\s+TABLE\s+["`']?([a-zA-Z0-9_]+)["`']?\s+ADD\s+(?:COLUMN\s+)?["`']?([a-zA-Z0-9_]+)["`']?/i,
    );
    if (alterMatch) {
      const tableName = alterMatch[1].toLowerCase();
      const colName = alterMatch[2].toLowerCase();
      tablesSet.add(tableName);
      columnsSet.add(`${tableName}.${colName}`);
    }
  }
}

function tableExists(name) {
  if (isPostgresMode()) {
    const row = getRow(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?",
      [name],
    );
    if (row && typeof row.then === "function") {
      return row.then((r) => Boolean(r));
    }
    return Boolean(row);
  }
  return Boolean(
    getRow("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
      name,
    ]),
  );
}

function hasColumn(tableName, columnName) {
  if (isPostgresMode()) {
    const row = getRow(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? AND column_name = ?",
      [tableName, columnName],
    );
    if (row && typeof row.then === "function") {
      return row.then((r) => Boolean(r));
    }
    return Boolean(row);
  }
  const rows = getAll(`PRAGMA table_info('${tableName}')`);
  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.some((col) => col.name === columnName);
}

async function getSchemaVersion() {
  if (isPostgresMode()) {
    try {
      const row = await getRow("SELECT value FROM meta WHERE key = 'user_version'");
      return Number(row?.value || 0);
    } catch {
      return 0;
    }
  }
  const row = getRow("PRAGMA user_version");
  return Number(row?.user_version || 0);
}

async function setSchemaVersion(version) {
  if (isPostgresMode()) {
    await run(
      "INSERT INTO meta (key, value) VALUES ('user_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [String(version)],
    );
    return;
  }
  if (betterDb) {
    betterDb.pragma(`user_version = ${Number(version) || 0}`);
  } else if (db) {
    db.run(`PRAGMA user_version = ${Number(version) || 0}`);
  }
}

async function runDatabaseMigrations() {
  const tablesSet = new Set();
  const columnsSet = new Set();

  if (isPostgresMode()) {
    try {
      await dbKnex.raw(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const colRes = await dbKnex.raw(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public';
      `);
      const rows = Array.isArray(colRes) ? colRes : colRes?.rows || [];
      for (const r of rows) {
        const tName = String(r.table_name || "").toLowerCase();
        const cName = String(r.column_name || "").toLowerCase();
        tablesSet.add(tName);
        columnsSet.add(`${tName}.${cName}`);
      }
    } catch (err) {
      console.error("[db-migrations] Error initializing Postgres schema sets:", err);
    }
  }

  function syncTableExists(name) {
    if (isPostgresMode()) {
      return tablesSet.has(String(name || "").toLowerCase());
    }
    return tableExists(name);
  }

  function syncHasColumn(tableName, columnName) {
    if (isPostgresMode()) {
      return columnsSet.has(
        `${String(tableName || "").toLowerCase()}.${String(columnName || "").toLowerCase()}`,
      );
    }
    return hasColumn(tableName, columnName);
  }

  let migrationPromiseChain = Promise.resolve();

  const migrationContext = {
    isPostgres: isPostgresMode(),
    db: {
      run: (sql, params = []) => {
        if (!isPostgresMode()) {
          return run(sql, params);
        }
        const p = migrationPromiseChain.then(async () => {
          const res = await run(sql, params);
          updateSchemaSetsFromSql(sql, tablesSet, columnsSet);
          return res;
        });
        migrationPromiseChain = p.catch(() => {});
        return p;
      },
      exec: (sql) => {
        if (!isPostgresMode()) {
          return betterDb ? betterDb.exec(sql) : db?.exec(sql);
        }
        const p = migrationPromiseChain.then(async () => {
          // Normalize SQLite dialect (e.g. datetime('now')) just like db.run
          // so DDL executed via exec gets working Postgres defaults.
          const { sql: normSql } = normalizeSqlForPostgres(sql, []);
          const res = await dbKnex.raw(normSql);
          updateSchemaSetsFromSql(sql, tablesSet, columnsSet);
          return res;
        });
        migrationPromiseChain = p.catch(() => {});
        return p;
      },
      prepare: (sql) => (betterDb ? betterDb.prepare(sql) : db?.prepare(sql)),
    },
    getAll: (sql, params = []) => {
      if (!isPostgresMode()) {
        return getAll(sql, params);
      }
      const p = migrationPromiseChain.then(() => getAll(sql, params));
      migrationPromiseChain = p.catch(() => {});
      return p;
    },
    tableExists: syncTableExists,
    hasColumn: syncHasColumn,
    setUserColor,
  };

  const orderedMigrations = [...migrations].sort(
    (a, b) => a.version - b.version,
  );
  const latestVersion = orderedMigrations.length
    ? Math.max(
        ...orderedMigrations.map((migration) => Number(migration.version) || 0),
      )
    : 0;
  const startingVersion = await getSchemaVersion();

  if (startingVersion < latestVersion && !isPostgresMode()) {
    createPreMigrationBackup(startingVersion, latestVersion);
  }

  let appliedMigration = false;

  for (const migration of orderedMigrations) {
    const currentVersion = await getSchemaVersion();
    if (currentVersion >= migration.version) continue;

    await migration.up(migrationContext);
    await migrationPromiseChain;
    await setSchemaVersion(migration.version);
    appliedMigration = true;
  }

  // Self-heal schemas where PRAGMA user_version advanced but tables are missing.
  // All migrations are written to be idempotent (CREATE IF NOT EXISTS / guarded ALTERs),
  // so re-applying ensures critical tables exist.
  for (const migration of orderedMigrations) {
    await migration.up(migrationContext);
    await migrationPromiseChain;
  }

  const currentVersion = await getSchemaVersion();
  if (currentVersion < latestVersion) {
    await setSchemaVersion(latestVersion);
    appliedMigration = true;
  }

  if (appliedMigration) {
    databaseDirty = true;
  }
}

await runDatabaseMigrations();

await ensureSystemSecrets({
  dbRun: run,
  dbGetRow: getRow,
  projectRootDir,
  fsImpl: fs,
  pathImpl: path,
  cryptoImpl: crypto,
});

saveDatabase();

process.once("beforeExit", () => {
  saveDatabase();
});

process.once("exit", () => {
  saveDatabase();
});

export function getCurrentSchemaVersion() {
  return getSchemaVersion();
}

export function findUserByUsername(username) {
  if (!username) return isPostgresMode() ? Promise.resolve(null) : null;
  return getRow(
    dbKnex("users")
      .select("id", "username", "nickname", "avatar_url", "color", "status", "password_hash", "banned", "role", "verified")
      .where("username", String(username || "").toLowerCase()),
  );
}

export function findUserById(id) {
  if (!id) return isPostgresMode() ? Promise.resolve(null) : null;
  return getRow(
    dbKnex("users")
      .select("id", "username", "nickname", "avatar_url", "color", "status", "password_hash", "banned", "role", "verified")
      .where("id", id),
  );
}

export function listUsers(excludeUsername) {
  const qb = dbKnex("users")
    .select("id", "username", "nickname", "avatar_url", "color", "role", "verified", "status", "banned")
    .orderBy("username", "asc");
  if (excludeUsername) {
    qb.where("username", "!=", String(excludeUsername).toLowerCase());
  }
  return getAll(qb);
}

export function searchUsers(query, excludeUsername) {
  const like = `%${query}%`;
  const qb = dbKnex("users")
    .select("id", "username", "nickname", "avatar_url", "color", "role", "verified", "status", "banned")
    .where((builder) => {
      builder.where("username", "like", like).orWhere("nickname", "like", like);
    })
    .orderBy("username", "asc");
  if (excludeUsername) {
    qb.where("username", "!=", String(excludeUsername).toLowerCase());
  }
  return getAll(qb);
}

export function createUser(
  username,
  passwordHash,
  nickname = null,
  avatarUrl = null,
  color = null,
  options = {},
) {
  const id = generateUuid();
  const nextColor = color || setUserColor();
  const role = typeof options === "string" ? options : (options?.role || "user");
  const verified = typeof options === "object" && options?.verified ? 1 : 0;
  const status = (typeof options === "object" && options?.status) || "online";

  const res = run(
    dbKnex("users").insert({
      id,
      username,
      nickname,
      avatar_url: avatarUrl,
      color: nextColor,
      password_hash: passwordHash,
      role,
      verified,
      status,
      last_seen: dbKnex.raw("datetime('now')"),
    }),
  );

  if (res && typeof res.then === "function") {
    return res.then(() => id);
  }

  return id;
}

export function findDmChat(userId, otherUserId) {
  if (!userId || !otherUserId) {
    return isPostgresMode() ? Promise.resolve(null) : null;
  }

  const row = getRow(
    dbKnex("chats as c")
      .select("c.id")
      .join("chat_members as m1", function () {
        this.on("m1.chat_id", "=", "c.id").andOn("m1.user_id", "=", dbKnex.raw("?", [userId]));
      })
      .join("chat_members as m2", function () {
        this.on("m2.chat_id", "=", "c.id").andOn("m2.user_id", "=", dbKnex.raw("?", [otherUserId]));
      })
      .where("c.type", "dm")
      .orderByRaw("(SELECT COUNT(*) FROM chat_messages WHERE chat_id = c.id) DESC")
      .orderByRaw("(SELECT created_at FROM chat_messages WHERE chat_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) DESC")
      .orderBy("c.id", "desc")
      .first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => r?.id || null);
  }
  return row?.id || null;
}

export function createChat(name, type = "dm", options = {}) {
  const id = generateUuid();
  const normalizedType = String(type || "dm");
  const normalizedName =
    normalizedType === "dm"
      ? String(name || "").trim() || "dm"
      : String(name || "").trim() || null;
  const groupUsername =
    normalizedType === "group" || normalizedType === "channel"
      ? String(options.groupUsername || "")
          .trim()
          .toLowerCase() || null
      : null;
  const groupVisibility =
    normalizedType === "saved"
      ? "private"
      : (normalizedType === "group" || normalizedType === "channel") &&
          String(options.groupVisibility || "").toLowerCase() === "private"
        ? "private"
        : "public";
  const inviteToken =
    normalizedType === "group" || normalizedType === "channel"
      ? String(options.inviteToken || "").trim() || null
      : null;
  const createdByUserId = options.createdByUserId || null;
  const groupColor =
    normalizedType === "group" || normalizedType === "channel"
      ? String(options.groupColor || "").trim() || setUserColor()
      : null;
  const allowMemberInvites =
    (normalizedType === "group" || normalizedType === "channel") &&
    options.allowMemberInvites === false
      ? 0
      : 1;
  const groupAvatarUrl =
    normalizedType === "group" || normalizedType === "channel"
      ? String(options.groupAvatarUrl || "").trim() || null
      : null;
  const verified = options.verified ? 1 : 0;
  const autoAddNewUsers =
    groupVisibility === "private"
      ? 0
      : (options.auto_add_new_users || options.autoAddNewUsers)
        ? 1
        : 0;

  const res = run(
    dbKnex("chats").insert({
      id,
      name: normalizedName,
      type: normalizedType,
      group_username: groupUsername,
      group_visibility: groupVisibility,
      invite_token: inviteToken,
      created_by_user_id: createdByUserId,
      group_color: groupColor,
      allow_member_invites: allowMemberInvites,
      group_avatar_url: groupAvatarUrl,
      verified,
      auto_add_new_users: autoAddNewUsers,
    }),
  );

  if (res && typeof res.then === "function") {
    return res.then(() => id);
  }
  return id;
}

export function addChatMember(chatId, userId, role = "member") {
  return run(
    dbKnex("chat_members")
      .insert({ chat_id: chatId, user_id: userId, role })
      .onConflict(["chat_id", "user_id"])
      .ignore(),
  );
}

/**
 * Adds users eligible for the admin Add all action. The eligibility criteria
 * intentionally match `db:chat:add <chat> --all`: existing members and users
 * with either persisted or legacy left-chat markers are excluded.
 */
export function addAllEligibleChatMembers(chatId) {
  const leftMessagePattern = "[[system:left:%";
  const addedUsersQb = dbKnex("users")
    .select("users.id", "users.username", "users.nickname")
    .whereNotExists(function () {
      this.select(1).from("chat_members").whereRaw("chat_members.chat_id = ?", [chatId]).whereRaw("chat_members.user_id = users.id");
    })
    .whereNotExists(function () {
      this.select(1).from("chat_left_members").whereRaw("chat_left_members.chat_id = ?", [chatId]).whereRaw("chat_left_members.user_id = users.id");
    })
    .whereNotExists(function () {
      this.select(1).from("chat_messages").whereRaw("chat_messages.chat_id = ?", [chatId]).whereRaw("chat_messages.user_id = users.id").where("chat_messages.body", "like", leftMessagePattern);
    })
    .orderBy("users.id", "asc");

  const rawAddedUsers = getAll(addedUsersQb);

  const skippedLeftQb = dbKnex("users")
    .count("* as count")
    .whereNotExists(function () {
      this.select(1).from("chat_members").whereRaw("chat_members.chat_id = ?", [chatId]).whereRaw("chat_members.user_id = users.id");
    })
    .andWhere((builder) => {
      builder
        .whereExists(function () {
          this.select(1).from("chat_left_members").whereRaw("chat_left_members.chat_id = ?", [chatId]).whereRaw("chat_left_members.user_id = users.id");
        })
        .orWhereExists(function () {
          this.select(1).from("chat_messages").whereRaw("chat_messages.chat_id = ?", [chatId]).whereRaw("chat_messages.user_id = users.id").where("chat_messages.body", "like", leftMessagePattern);
        });
    });

  const rawSkippedLeftRow = getRow(skippedLeftQb);

  if (rawAddedUsers && typeof rawAddedUsers.then === "function") {
    return Promise.all([rawAddedUsers, rawSkippedLeftRow]).then(
      async ([addedUsers, skippedLeftRow]) => {
        const users = addedUsers || [];
        for (const user of users) {
          const res = addChatMember(chatId, user.id, "member");
          if (res && typeof res.then === "function") await res;
        }
        return {
          addedUsers: users,
          skippedLeftCount: Number(skippedLeftRow?.count || 0),
        };
      },
    );
  }

  const addedUsers = rawAddedUsers || [];
  addedUsers.forEach((user) => {
    addChatMember(chatId, user.id, "member");
  });

  return {
    addedUsers,
    skippedLeftCount: Number(rawSkippedLeftRow?.count || 0),
  };
}

export function searchPublicGroups(query, viewerUserId, limit = 20) {
  const like = `%${String(query || "").trim()}%`;
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const qb = dbKnex("chats as c")
    .select(
      "c.id", "c.name", "c.group_username", "c.group_color", "c.group_avatar_url", "c.invite_token", "c.verified",
      dbKnex.raw("(SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) AS members_count"),
      dbKnex.raw(
        "EXISTS(SELECT 1 FROM chat_members vm WHERE vm.chat_id = c.id AND vm.user_id = ?) AS is_member",
        [viewerUserId],
      ),
    )
    .where("c.type", "group")
    .andWhere((builder) => {
      builder.where("c.group_visibility", "public").orWhereExists(function () {
        this.select(1).from("chat_members as vm").whereRaw("vm.chat_id = c.id").where("vm.user_id", viewerUserId);
      });
    })
    .andWhere((builder) => {
      builder.where("c.name", "like", like).orWhere("c.group_username", "like", like);
    })
    .orderByRaw("CASE WHEN c.group_username LIKE ? THEN 0 ELSE 1 END, c.name ASC", [like])
    .limit(safeLimit);

  return getAll(qb);
}

export function searchPublicChannels(query, viewerUserId, limit = 20) {
  const like = `%${String(query || "").trim()}%`;
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const qb = dbKnex("chats as c")
    .select(
      "c.id", "c.name", "c.group_username", "c.group_color", "c.group_avatar_url", "c.invite_token", "c.verified",
      dbKnex.raw("(SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) AS members_count"),
      dbKnex.raw(
        "EXISTS(SELECT 1 FROM chat_members vm WHERE vm.chat_id = c.id AND vm.user_id = ?) AS is_member",
        [viewerUserId],
      ),
    )
    .where("c.type", "channel")
    .andWhere((builder) => {
      builder.where("c.group_visibility", "public").orWhereExists(function () {
        this.select(1).from("chat_members as vm").whereRaw("vm.chat_id = c.id").where("vm.user_id", viewerUserId);
      });
    })
    .andWhere((builder) => {
      builder.where("c.name", "like", like).orWhere("c.group_username", "like", like);
    })
    .orderByRaw("CASE WHEN c.group_username LIKE ? THEN 0 ELSE 1 END, c.name ASC", [like])
    .limit(safeLimit);

  return getAll(qb);
}

const normalizeRemoteSourceUsername = (value) =>
  String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase() || null;

const normalizeRemoteSourceChatId = (value) => {
  const raw = String(value || "").trim();
  return raw || null;
};

export function getRemoteChannelSourceByChatId(chatId) {
  return getRow(
    `SELECT id, chat_id, provider, source_raw, source_chat_id, source_username,
            source_url, source_title, source_avatar_url, last_remote_message_id,
            enabled, paused, source_version, sync_metadata, stream_media,
            last_error, last_seen_at, created_at, updated_at
     FROM remote_channel_sources
     WHERE chat_id = ?`,
    [chatId],
  );
}

export function getRemoteChannelSourceById(sourceId) {
  const id = Number(sourceId);
  // Guard against undefined/NaN ids (e.g. from an un-awaited upsert result).
  // Postgres rejects `WHERE id = 'NaN'` with "invalid input syntax for type
  // integer", so return null instead of issuing the query.
  if (!Number.isFinite(id) || id <= 0) {
    return isPostgresMode() ? Promise.resolve(null) : null;
  }
  return getRow(
    dbKnex("remote_channel_sources")
      .select(
        "id", "chat_id", "provider", "source_raw", "source_chat_id", "source_username",
        "source_url", "source_title", "source_avatar_url", "last_remote_message_id",
        "enabled", "paused", "source_version", "sync_metadata", "stream_media",
        "last_error", "last_seen_at", "created_at", "updated_at"
      )
      .where("id", id)
      .first(),
  );
}

export function upsertRemoteChannelSource(payload = {}) {
  const chatId = payload.chatId || null;
  if (!chatId) return null;

  const provider = String(payload.provider || "telegram").toLowerCase();
  const sourceRaw = String(payload.sourceRaw || "").trim() || null;
  const sourceChatId = normalizeRemoteSourceChatId(payload.sourceChatId);
  const sourceUsername = normalizeRemoteSourceUsername(payload.sourceUsername);
  const sourceUrl = String(payload.sourceUrl || "").trim() || null;
  const enabled = payload.enabled ? 1 : 0;
  const syncMetadata = payload.syncMetadata ? 1 : 0;
  const streamMedia = payload.streamMedia ? 1 : 0;
  const upsertSql = `INSERT INTO remote_channel_sources (
       chat_id, provider, source_raw, source_chat_id, source_username,
       source_url, source_version, sync_metadata, stream_media, enabled,
       last_error, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET
       provider = excluded.provider,
       source_title = CASE
         WHEN COALESCE(remote_channel_sources.source_raw, '') != COALESCE(excluded.source_raw, '')
           OR COALESCE(remote_channel_sources.source_chat_id, '') != COALESCE(excluded.source_chat_id, '')
           OR COALESCE(remote_channel_sources.source_username, '') != COALESCE(excluded.source_username, '')
           OR COALESCE(remote_channel_sources.source_url, '') != COALESCE(excluded.source_url, '')
           OR remote_channel_sources.provider != excluded.provider
         THEN NULL
         ELSE remote_channel_sources.source_title
       END,
       source_avatar_url = CASE
         WHEN COALESCE(remote_channel_sources.source_raw, '') != COALESCE(excluded.source_raw, '')
           OR COALESCE(remote_channel_sources.source_chat_id, '') != COALESCE(excluded.source_chat_id, '')
           OR COALESCE(remote_channel_sources.source_username, '') != COALESCE(excluded.source_username, '')
           OR COALESCE(remote_channel_sources.source_url, '') != COALESCE(excluded.source_url, '')
           OR remote_channel_sources.provider != excluded.provider
         THEN NULL
         ELSE remote_channel_sources.source_avatar_url
       END,
       last_remote_message_id = CASE
         WHEN COALESCE(remote_channel_sources.source_raw, '') != COALESCE(excluded.source_raw, '')
           OR COALESCE(remote_channel_sources.source_chat_id, '') != COALESCE(excluded.source_chat_id, '')
           OR COALESCE(remote_channel_sources.source_username, '') != COALESCE(excluded.source_username, '')
           OR COALESCE(remote_channel_sources.source_url, '') != COALESCE(excluded.source_url, '')
           OR remote_channel_sources.provider != excluded.provider
         THEN NULL
         ELSE remote_channel_sources.last_remote_message_id
       END,
       source_raw = excluded.source_raw,
       source_chat_id = excluded.source_chat_id,
       source_username = excluded.source_username,
       source_url = excluded.source_url,
       source_version = excluded.source_version,
       sync_metadata = excluded.sync_metadata,
       stream_media = excluded.stream_media,
       enabled = excluded.enabled,
       last_error = NULL,
       updated_at = datetime('now')`;

  // Runs the INSERT/UPSERT and the follow-up queue cleanup against a resolved
  // `current` row. Awaits each write when the driver is async (Postgres) so
  // the final SELECT cannot race ahead of the INSERT.
  const applyUpsert = (resolvedCurrent) => {
    const sourceChanged = Boolean(
      resolvedCurrent?.id &&
        (String(resolvedCurrent.source_raw || "") !== String(sourceRaw || "") ||
          String(resolvedCurrent.source_chat_id || "") !== String(sourceChatId || "") ||
          String(resolvedCurrent.source_username || "") !== String(sourceUsername || "") ||
          String(resolvedCurrent.source_url || "") !== String(sourceUrl || "") ||
          String(resolvedCurrent.provider || "telegram") !== provider),
    );
    const currentSourceVersion = Math.max(
      1,
      Number(resolvedCurrent?.source_version || 1) || 1,
    );
    const sourceVersion = sourceChanged
      ? currentSourceVersion + 1
      : currentSourceVersion;

    const write = run(upsertSql, [
      chatId,
      provider,
      sourceRaw,
      sourceChatId,
      sourceUsername,
      sourceUrl,
      sourceVersion,
      syncMetadata,
      streamMedia,
      enabled,
    ]);

    const afterWrite = () => {
      const skipStaleQueue = () => {
        if (!(resolvedCurrent?.id && (sourceChanged || !enabled))) return null;
        return run(
          `UPDATE remote_channel_queue
           SET status = 'skipped',
               locked_at = NULL,
               lock_owner = NULL,
               last_error = ?,
               processed_at = datetime('now')
           WHERE source_id = ?
             AND status IN ('pending', 'retry', 'processing')`,
          [
            sourceChanged
              ? "Remote source changed before this item was mirrored."
              : "Remote Channel was disabled before this item was mirrored.",
            Number(resolvedCurrent.id),
          ],
        );
      };

      const afterSkip = () => {
        saveDatabase();
        return getRemoteChannelSourceByChatId(chatId);
      };

      const skip = skipStaleQueue();
      if (skip && typeof skip.then === "function") return skip.then(afterSkip);
      return afterSkip();
    };

    if (write && typeof write.then === "function") return write.then(afterWrite);
    return afterWrite();
  };

  const current = getRemoteChannelSourceByChatId(chatId);
  if (current && typeof current.then === "function") {
    return current.then(applyUpsert);
  }
  return applyUpsert(current);
}

export function listEnabledRemoteChannelSources(provider = "telegram") {
  return getAll(
    dbKnex("remote_channel_sources")
      .select(
        "id", "chat_id", "provider", "source_raw", "source_chat_id", "source_username",
        "source_url", "source_title", "source_avatar_url", "last_remote_message_id",
        "enabled", "paused", "source_version", "sync_metadata", "stream_media",
        "last_error", "last_seen_at", "created_at", "updated_at"
      )
      .where("provider", String(provider || "telegram"))
      .where("enabled", 1)
      .where("paused", 0)
      .orderBy("id", "asc"),
  );
}

export function updateRemoteChannelSourceSeen(sourceId, payload = {}) {
  const id = Number(sourceId || 0);
  if (!id) return 0;

  const current = getRemoteChannelSourceById(id);
  if (current && typeof current.then === "function") {
    return current.then((resolved) =>
      applyRemoteChannelSourceSeen(id, resolved, payload),
    );
  }
  return applyRemoteChannelSourceSeen(id, current, payload);
}

function applyRemoteChannelSourceSeen(id, current, payload = {}) {
  if (!current?.id) return 0;

  const sourceChatId = normalizeRemoteSourceChatId(payload.sourceChatId);
  const sourceUsername = normalizeRemoteSourceUsername(payload.sourceUsername);
  const hasSourceTitle = Object.prototype.hasOwnProperty.call(
    payload,
    "sourceTitle",
  );
  const sourceTitle = hasSourceTitle
    ? String(payload.sourceTitle || "").trim() || null
    : undefined;
  const hasSourceAvatarUrl = Object.prototype.hasOwnProperty.call(
    payload,
    "sourceAvatarUrl",
  );
  const sourceAvatarUrl = hasSourceAvatarUrl
    ? String(payload.sourceAvatarUrl || "").trim() || null
    : undefined;
  const hasLastRemoteMessageId = Number.isFinite(
    Number(payload.lastRemoteMessageId),
  );
  const lastRemoteMessageId = hasLastRemoteMessageId
    ? Math.max(0, Math.trunc(Number(payload.lastRemoteMessageId)))
    : null;
  const currentLastRemoteMessageId =
    Number(current.last_remote_message_id || 0) || 0;
  const sourceChatIdChanged =
    Boolean(sourceChatId) &&
    String(current.source_chat_id || "") !== String(sourceChatId || "");
  const sourceUsernameChanged =
    Boolean(sourceUsername) &&
    String(current.source_username || "") !== String(sourceUsername || "");
  const sourceTitleChanged =
    hasSourceTitle &&
    String(current.source_title || "") !== String(sourceTitle || "");
  const sourceAvatarUrlChanged =
    hasSourceAvatarUrl &&
    String(current.source_avatar_url || "") !== String(sourceAvatarUrl || "");
  const lastRemoteMessageIdAdvanced =
    hasLastRemoteMessageId && lastRemoteMessageId > currentLastRemoteMessageId;
  const shouldTouch = payload.touch !== false;
  const shouldClearError =
    payload.clearError !== false && Boolean(String(current.last_error || ""));
  const shouldUpdate =
    shouldTouch ||
    shouldClearError ||
    sourceChatIdChanged ||
    sourceUsernameChanged ||
    sourceTitleChanged ||
    sourceAvatarUrlChanged ||
    lastRemoteMessageIdAdvanced;

  if (!shouldUpdate) return 0;

  return run(
    `UPDATE remote_channel_sources
     SET source_chat_id = CASE WHEN ? THEN ? ELSE source_chat_id END,
         source_username = CASE WHEN ? THEN ? ELSE source_username END,
         source_title = CASE WHEN ? THEN ? ELSE source_title END,
         source_avatar_url = CASE WHEN ? THEN ? ELSE source_avatar_url END,
         last_remote_message_id = CASE
           WHEN ? THEN ? ELSE last_remote_message_id
         END,
         last_seen_at = CASE WHEN ? THEN datetime('now') ELSE last_seen_at END,
         last_error = CASE WHEN ? THEN NULL ELSE last_error END,
         updated_at = datetime('now')
     WHERE id = ?`,
    [
      sourceChatIdChanged ? 1 : 0,
      sourceChatId,
      sourceUsernameChanged ? 1 : 0,
      sourceUsername,
      sourceTitleChanged ? 1 : 0,
      hasSourceTitle ? sourceTitle : null,
      sourceAvatarUrlChanged ? 1 : 0,
      hasSourceAvatarUrl ? sourceAvatarUrl : null,
      lastRemoteMessageIdAdvanced ? 1 : 0,
      lastRemoteMessageId,
      shouldTouch ? 1 : 0,
      shouldClearError ? 1 : 0,
      id,
    ],
  );
}

export function updateRemoteChannelSourceError(sourceId, error) {
  const id = Number(sourceId || 0);
  if (!id) return 0;

  const nextError = String(error || "").slice(0, 1000) || null;
  const current = getRemoteChannelSourceById(id);
  if (current && typeof current.then === "function") {
    return current.then((resolved) =>
      applyRemoteChannelSourceError(id, resolved, nextError),
    );
  }
  return applyRemoteChannelSourceError(id, current, nextError);
}

function applyRemoteChannelSourceError(id, current, nextError) {
  if (!current?.id) return 0;
  if (String(current.last_error || "") === String(nextError || "")) return 0;

  return run(
    `UPDATE remote_channel_sources
     SET last_error = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [nextError, id],
  );
}

export function updateRemoteChannelSourcePaused(sourceId, paused) {
  const id = Number(sourceId || 0);
  if (!id) return 0;

  return run(
    `UPDATE remote_channel_sources
     SET paused = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [paused ? 1 : 0, id],
  );
}

export function getCurrentRemoteChannelQueueItemId(sourceId) {
  const id = Number(sourceId || 0);
  if (!id) return isPostgresMode() ? Promise.resolve(null) : null;

  const row = getRow(
    `SELECT id FROM remote_channel_queue
     WHERE source_id = ?
       AND status IN ('pending', 'retry', 'processing')
     ORDER BY id ASC
     LIMIT 1`,
    [id],
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => (r ? Number(r.id) : null));
  }
  return row ? Number(row.id) : null;
}

export function skipCurrentRemoteChannelQueueItem(sourceId) {
  const id = Number(sourceId || 0);
  if (!id) return 0;

  return run(
    `UPDATE remote_channel_queue
     SET status = 'skipped',
         locked_at = NULL,
         lock_owner = NULL,
         last_error = 'Manually skipped.',
         processed_at = datetime('now')
     WHERE id = (
       SELECT id FROM remote_channel_queue
       WHERE source_id = ?
         AND status IN ('pending', 'retry', 'processing')
       ORDER BY id ASC
       LIMIT 1
     )`,
    [id],
  );
}

export function skipAllRemoteChannelQueueItems(sourceId) {
  const id = Number(sourceId || 0);
  if (!id) return 0;

  return run(
    `UPDATE remote_channel_queue
     SET status = 'skipped',
         locked_at = NULL,
         lock_owner = NULL,
         last_error = 'Manually skipped.',
         processed_at = datetime('now')
     WHERE source_id = ?
       AND status IN ('pending', 'retry', 'processing')`,
    [id],
  );
}

export function getRemoteChannelProviderState(provider = "telegram") {
  return getRow(
    `SELECT provider, next_update_offset, last_error, last_polled_at, updated_at
     FROM remote_channel_provider_state
     WHERE provider = ?`,
    [String(provider || "telegram")],
  );
}

export function setRemoteChannelProviderState(provider = "telegram", payload = {}) {
  const normalizedProvider = String(provider || "telegram");
  const nextUpdateOffset =
    Number.isFinite(Number(payload.nextUpdateOffset))
      ? Math.trunc(Number(payload.nextUpdateOffset))
      : null;
  const lastError = Object.prototype.hasOwnProperty.call(payload, "lastError")
    ? String(payload.lastError || "").slice(0, 1000) || null
    : undefined;
  const lastPolledAt = Object.prototype.hasOwnProperty.call(payload, "lastPolledAt")
    ? String(payload.lastPolledAt || "").trim() || null
    : undefined;

  const current = getRemoteChannelProviderState(normalizedProvider);
  const nextOffset =
    nextUpdateOffset === null
      ? Number(current?.next_update_offset || 0) || null
      : nextUpdateOffset;
  const nextError =
    lastError === undefined ? current?.last_error || null : lastError;
  const nextPolledAt =
    lastPolledAt === undefined
      ? current?.last_polled_at || null
      : lastPolledAt;

  return run(
    `INSERT INTO remote_channel_provider_state (
       provider, next_update_offset, last_error, last_polled_at, updated_at
     )
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET
       next_update_offset = excluded.next_update_offset,
       last_error = excluded.last_error,
       last_polled_at = excluded.last_polled_at,
       updated_at = datetime('now')`,
    [normalizedProvider, nextOffset, nextError, nextPolledAt],
  );
}

export function enqueueRemoteChannelQueueItem(payload = {}) {
  const sourceId = Number(payload.sourceId || 0);
  if (!sourceId) return null;

  const provider = String(payload.provider || "telegram").toLowerCase();
  const telegramUpdateId = Number.isFinite(Number(payload.telegramUpdateId))
    ? Math.trunc(Number(payload.telegramUpdateId))
    : null;
  const telegramMessageId = Number.isFinite(Number(payload.telegramMessageId))
    ? Math.trunc(Number(payload.telegramMessageId))
    : null;
  const sourceVersion = Math.max(
    1,
    Math.trunc(Number(payload.sourceVersion || 1)) || 1,
  );
  const payloadJson = String(payload.payloadJson || "").trim();
  if (!payloadJson) return null;

  const inserted = run(
    `INSERT OR IGNORE INTO remote_channel_queue (
       source_id, provider, telegram_update_id, telegram_message_id,
       source_version, payload_json, status, next_attempt_at
     )
     VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
    [
      sourceId,
      provider,
      telegramUpdateId,
      telegramMessageId,
      sourceVersion,
      payloadJson,
    ],
  );

  const fetchInsertedRow = () =>
    getRow(
      `SELECT id, source_id, provider, telegram_update_id, telegram_message_id,
              source_version, payload_json, status, attempts, next_attempt_at,
              locked_at, lock_owner, last_error, created_message_id, created_at,
              processed_at
       FROM remote_channel_queue
       WHERE source_id = ?
         AND source_version = ?
         AND (
           (CAST(? AS BIGINT) IS NOT NULL AND telegram_update_id = CAST(? AS BIGINT))
           OR (CAST(? AS BIGINT) IS NOT NULL AND telegram_message_id = CAST(? AS BIGINT))
         )
       ORDER BY id DESC
       LIMIT 1`,
      [
        sourceId,
        sourceVersion,
        telegramUpdateId,
        telegramUpdateId,
        telegramMessageId,
        telegramMessageId,
      ],
    );
    
  if (inserted && typeof inserted.then === "function") {
    return inserted.then((count) => (count ? fetchInsertedRow() : null));
  }
  if (!inserted) return null;
  return fetchInsertedRow();
}

export function getRemoteChannelQueueSummary(sourceId) {
  const rawRows = getAll(
    dbKnex("remote_channel_queue")
      .select("status", dbKnex.raw("COUNT(*) AS count"))
      .where("source_id", Number(sourceId))
      .groupBy("status"),
  );

  const summarize = (rows) =>
    (rows || []).reduce((acc, row) => {
      const status = String(row?.status || "").trim() || "unknown";
      acc[status] = Number(row?.count || 0);
      return acc;
    }, {});

  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then(summarize);
  }
  return summarize(rawRows);
}

export function releaseStaleRemoteChannelQueueItems(staleBeforeIso) {
  run(
    `UPDATE remote_channel_queue
     SET status = 'retry',
         locked_at = NULL,
         lock_owner = NULL,
         next_attempt_at = datetime('now')
     WHERE status = 'processing'
       AND locked_at IS NOT NULL
       AND julianday(locked_at) <= julianday(?)`,
    [String(staleBeforeIso || new Date().toISOString())],
  );
}

export function claimNextRemoteChannelQueueItem(lockOwner, nowIso) {
  const now = String(nowIso || new Date().toISOString());
  const row = getRow(
    `SELECT q.id, q.source_id, q.provider, q.telegram_update_id,
            q.telegram_message_id, q.source_version, q.payload_json, q.status,
            q.attempts, q.next_attempt_at, q.locked_at, q.lock_owner,
            q.last_error, q.created_message_id, q.created_at, q.processed_at,
            s.chat_id, s.source_raw, s.source_chat_id, s.source_username,
            s.source_title, s.source_avatar_url, s.last_remote_message_id,
            s.source_version AS current_source_version, s.sync_metadata,
            s.stream_media,
            c.name AS target_chat_name, c.created_by_user_id
     FROM remote_channel_queue q
     JOIN remote_channel_sources s ON s.id = q.source_id
     JOIN chats c ON c.id = s.chat_id
     WHERE q.provider = s.provider
       AND s.enabled = 1
       AND s.paused = 0
       AND q.source_version = s.source_version
       AND c.type = 'channel'
       AND q.status IN ('pending', 'retry')
       AND (
         q.next_attempt_at IS NULL
         OR q.next_attempt_at = ''
         OR julianday(q.next_attempt_at) <= julianday(?)
       )
     ORDER BY julianday(q.created_at) ASC, q.id ASC
     LIMIT 1`,
    [now],
  );

  const processRow = (r) => {
    if (!r?.id) return null;
    const res = run(
      `UPDATE remote_channel_queue
       SET status = 'processing',
           locked_at = ?,
           lock_owner = ?
       WHERE id = ?
         AND status IN ('pending', 'retry')`,
      [now, String(lockOwner || "remote-channel-worker"), Number(r.id)],
    );
    const item = {
      ...r,
      status: "processing",
      locked_at: now,
      lock_owner: String(lockOwner || "remote-channel-worker"),
    };
    if (res && typeof res.then === "function") {
      return res.then(() => item);
    }
    return item;
  };

  if (row && typeof row.then === "function") {
    return row.then(processRow);
  }
  return processRow(row);
}

export function markRemoteChannelQueueItemDone(id, messageId) {
  return run(
    `UPDATE remote_channel_queue
     SET status = 'done',
         locked_at = NULL,
         lock_owner = NULL,
         last_error = NULL,
         created_message_id = ?,
         processed_at = datetime('now')
     WHERE id = ?`,
    [messageId || null, Number(id)],
  );
}

export function markRemoteChannelQueueItemSkipped(id, reason) {
  return run(
    `UPDATE remote_channel_queue
     SET status = 'skipped',
         locked_at = NULL,
         lock_owner = NULL,
         last_error = ?,
         processed_at = datetime('now')
     WHERE id = ?`,
    [String(reason || "Skipped").slice(0, 1000), Number(id)],
  );
}

export function markRemoteChannelQueueItemRetry(id, payload = {}) {
  return run(
    `UPDATE remote_channel_queue
     SET status = ?,
         attempts = attempts + 1,
         next_attempt_at = ?,
         locked_at = NULL,
         lock_owner = NULL,
         last_error = ?
     WHERE id = ?`,
    [
      payload.failed ? "failed" : "retry",
      payload.failed
        ? null
        : String(payload.nextAttemptAt || new Date().toISOString()),
      String(payload.error || "").slice(0, 1000) || null,
      Number(id),
    ],
  );
}

/**
 * Delete completed (done/skipped/failed) queue rows older than the given ISO
 * timestamp. Prevents the remote_channel_queue table from growing unboundedly.
 */
export function purgeOldRemoteChannelQueueItems(olderThanIso) {
  return run(
    `DELETE FROM remote_channel_queue
     WHERE status IN ('done', 'skipped', 'failed')
       AND processed_at IS NOT NULL
       AND processed_at < ?`,
    [String(olderThanIso)],
  );
}

export function removeChatMember(chatId, userId) {
  const removeMembership = () =>
    run(
      dbKnex("chat_members")
        .where({ chat_id: chatId, user_id: userId })
        .del(),
    );
  // Whoever leaves or is removed loses their pin of the chat with it.
  const removePin = () => deleteChatPinRows(userId, [chatId]);
  if (isPostgresMode()) {
    return Promise.resolve(removePin()).then(removeMembership);
  }
  removePin();
  return removeMembership();
}

export function markChatMemberLeft(chatId, userId) {
  return run(
    dbKnex("chat_left_members")
      .insert({
        chat_id: chatId,
        user_id: userId,
        left_at: dbKnex.raw("datetime('now')"),
      })
      .onConflict(["chat_id", "user_id"])
      .merge({
        left_at: dbKnex.raw("datetime('now')"),
      }),
  );
}

export function clearChatMemberLeft(chatId, userId) {
  return run(
    dbKnex("chat_left_members")
      .where({ chat_id: chatId, user_id: userId })
      .del(),
  );
}

export async function hasChatMemberLeft(chatId, userId) {
  if (!chatId || !userId) {
    return false;
  }
  const row = getRow(
    dbKnex("chat_left_members")
      .select(dbKnex.raw("1 AS left_chat"))
      .where({ chat_id: chatId, user_id: userId })
      .first(),
  );
  const resolved = row && typeof row.then === "function" ? await row : row;
  return Boolean(resolved);
}

export function markGroupMemberRemoved(chatId, userId, removedByUserId) {
  return run(
    dbKnex("group_removed_members")
      .insert({
        chat_id: chatId,
        user_id: userId,
        removed_by_user_id: removedByUserId,
        removed_at: dbKnex.raw("datetime('now')"),
      })
      .onConflict(["chat_id", "user_id"])
      .merge({
        removed_by_user_id: removedByUserId,
        removed_at: dbKnex.raw("datetime('now')"),
      }),
  );
}

export function clearGroupMemberRemoved(chatId, userId) {
  return run(
    dbKnex("group_removed_members")
      .where({ chat_id: chatId, user_id: userId })
      .del(),
  );
}

export async function isGroupMemberRemoved(chatId, userId) {
  if (!chatId || !userId) {
    return false;
  }
  const row = getRow(
    dbKnex("group_removed_members")
      .select(dbKnex.raw("1 AS removed"))
      .where({ chat_id: chatId, user_id: userId })
      .first(),
  );
  const resolved = row && typeof row.then === "function" ? await row : row;
  return Boolean(resolved);
}

export function findChatByGroupUsername(groupUsername) {
  const raw = String(groupUsername || "").trim().toLowerCase();
  if (!raw) return isPostgresMode() ? Promise.resolve(null) : null;
  const normalized = raw.startsWith("@") ? raw.slice(1) : raw;
  const withAt = normalized.startsWith("@") ? normalized : `@${normalized}`;
  return getRow(
    dbKnex("chats")
      .select("id", "name", "type", "group_username", "group_visibility", "invite_token", "group_color", "allow_member_invites", "group_avatar_url", "created_by_user_id", "verified")
      .whereIn("group_username", [normalized, withAt])
      .whereIn("type", ["group", "channel"])
      .first(),
  );
}

export function findChatByInviteToken(inviteToken) {
  const token = String(inviteToken || "").trim();
  if (!token) return isPostgresMode() ? Promise.resolve(null) : null;
  return getRow(
    dbKnex("chats")
      .select("id", "name", "type", "group_username", "group_visibility", "invite_token", "group_color", "allow_member_invites", "group_avatar_url", "created_by_user_id", "verified")
      .where("invite_token", token)
      .whereIn("type", ["group", "channel"])
      .first(),
  );
}

export function findChatById(chatId) {
  if (!chatId) return isPostgresMode() ? Promise.resolve(null) : null;
  const row = getRow(
    dbKnex("chats")
      .select("id", "name", "type", "group_username", "group_visibility", "invite_token", "group_color", "allow_member_invites", "allow_member_pins", "group_avatar_url", "created_by_user_id", "verified", "auto_add_new_users")
      .where("id", chatId)
      .first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => r || null);
  }
  return row || null;
}

export function updateGroupChat(chatId, payload = {}) {
  const name = String(payload?.name || "").trim() || null;
  const groupUsername =
    String(payload?.groupUsername || "")
      .trim()
      .toLowerCase() || null;
  const groupVisibility =
    String(payload?.groupVisibility || "").toLowerCase() === "private"
      ? "private"
      : "public";
  const allowMemberInvites = payload?.allowMemberInvites === false ? 0 : 1;
  const hasGroupAvatarUrl = Object.prototype.hasOwnProperty.call(
    payload || {},
    "groupAvatarUrl",
  );
  const groupAvatarUrl =
    !hasGroupAvatarUrl
      ? null
      : String(payload?.groupAvatarUrl || "").trim() || null;

  const updateData = {
    name,
    group_username: groupUsername,
    group_visibility: groupVisibility,
    allow_member_invites: allowMemberInvites,
  };
  if (hasGroupAvatarUrl) {
    updateData.group_avatar_url = groupAvatarUrl;
  }
  if (payload.auto_add_new_users !== undefined || payload.autoAddNewUsers !== undefined) {
    updateData.auto_add_new_users = payload.auto_add_new_users || payload.autoAddNewUsers ? 1 : 0;
  }
  if (groupVisibility === "private") {
    updateData.auto_add_new_users = 0;
  }
  // Only touched when the caller says so: every other update leaves it alone.
  if (typeof payload?.allowMemberPins === "boolean") {
    updateData.allow_member_pins = payload.allowMemberPins ? 1 : 0;
  }

  return run(
    dbKnex("chats")
      .where({ id: chatId, type: "group" })
      .update(updateData),
  );
}

export function updateChannelChat(chatId, payload = {}) {
  const name = String(payload?.name || "").trim() || null;
  const groupUsername =
    String(payload?.groupUsername || "")
      .trim()
      .toLowerCase() || null;
  const groupVisibility =
    String(payload?.groupVisibility || "").toLowerCase() === "private"
      ? "private"
      : "public";
  const allowMemberInvites = payload?.allowMemberInvites === false ? 0 : 1;
  const hasGroupAvatarUrl = Object.prototype.hasOwnProperty.call(
    payload || {},
    "groupAvatarUrl",
  );
  const groupAvatarUrl =
    !hasGroupAvatarUrl
      ? null
      : String(payload?.groupAvatarUrl || "").trim() || null;

  const updateData = {
    name,
    group_username: groupUsername,
    group_visibility: groupVisibility,
    allow_member_invites: allowMemberInvites,
  };
  if (hasGroupAvatarUrl) {
    updateData.group_avatar_url = groupAvatarUrl;
  }
  if (payload.auto_add_new_users !== undefined || payload.autoAddNewUsers !== undefined) {
    updateData.auto_add_new_users = payload.auto_add_new_users || payload.autoAddNewUsers ? 1 : 0;
  }
  if (groupVisibility === "private") {
    updateData.auto_add_new_users = 0;
  }

  return run(
    dbKnex("chats")
      .where({ id: chatId, type: "channel" })
      .update(updateData),
  );
}

export function updateChat(id, updates = {}) {
  const patch = { ...updates };
  if (patch.visibility !== undefined) {
    patch.group_visibility = patch.visibility;
    delete patch.visibility;
  }
  if (patch.autoAddNewUsers !== undefined) {
    patch.auto_add_new_users = patch.autoAddNewUsers ? 1 : 0;
    delete patch.autoAddNewUsers;
  }
  if (patch.auto_add_new_users !== undefined) {
    patch.auto_add_new_users = patch.auto_add_new_users ? 1 : 0;
  }
  if (patch.group_visibility === "private") {
    patch.auto_add_new_users = 0;
  }
  return run(
    dbKnex("chats")
      .where("id", id)
      .update(patch),
  );
}

export async function getAutoAddPublicChatIds() {
  const query = dbKnex("chats")
    .select("id")
    .whereIn("type", ["group", "channel"])
    .where("group_visibility", "public")
    .where("auto_add_new_users", 1);
  const rows = await getAll(query);
  return (rows || []).map((r) => r.id);
}

export async function bulkAddMemberToChats(userId, chatIds) {
  if (!chatIds || chatIds.length === 0) return [];
  const rows = chatIds.map((chatId) => ({
    chat_id: chatId,
    user_id: userId,
    role: "member",
  }));
  await run(
    dbKnex("chat_members")
      .insert(rows)
      .onConflict(["chat_id", "user_id"])
      .ignore(),
  );
  return chatIds;
}

export function regenerateGroupInviteToken(chatId, inviteToken) {
  return run(
    dbKnex("chats")
      .where("id", chatId)
      .whereIn("type", ["group", "channel"])
      .update({ invite_token: String(inviteToken || "").trim() }),
  );
}

export async function isMember(chatId, userId) {
  if (!chatId || !userId) {
    return false;
  }
  const row = getRow(
    dbKnex("chat_members")
      .select("chat_id")
      .where({ chat_id: chatId, user_id: userId })
      .first(),
  );
  const resolved = row && typeof row.then === "function" ? await row : row;
  return Boolean(resolved);
}

export function listChatMembers(chatId) {
  const rawRows = getAll(
    dbKnex("chat_members")
      .select(
        "users.id", "users.username", "users.nickname", "users.avatar_url", "users.color",
        "users.verified as user_verified",
        "users.role as user_role",
        "users.status as status",
        "chat_members.role",
      )
      .join("users", "users.id", "chat_members.user_id")
      .where("chat_members.chat_id", chatId)
      .orderBy("users.username", "asc"),
  );
  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then((rows) => rows || []);
  }
  return rawRows || [];
}

export function listChatMembersForChats(chatIds = []) {
  const ids = (Array.isArray(chatIds) ? chatIds : []).filter((id) => id);
  if (!ids.length) {
    return isPostgresMode() ? Promise.resolve(new Map()) : new Map();
  }
  const rawRows = getAll(
    dbKnex("chat_members")
      .select(
        "chat_members.chat_id",
        "users.id", "users.username", "users.nickname", "users.avatar_url", "users.color",
        "users.verified as user_verified",
        "users.role as user_role",
        "users.status as status",
        "chat_members.role",
      )
      .join("users", "users.id", "chat_members.user_id")
      .whereIn("chat_members.chat_id", ids)
      .orderBy("chat_members.chat_id", "asc")
      .orderBy("users.username", "asc"),
  );

  const buildMap = (rows) => {
    const map = new Map();
    for (const row of rows || []) {
      const cid = row.chat_id;
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid).push(row);
      const lowerCid = String(cid || "").toLowerCase();
      if (lowerCid !== cid) {
        if (!map.has(lowerCid)) map.set(lowerCid, []);
        map.get(lowerCid).push(row);
      }
    }
    return map;
  };

  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then(buildMap);
  }
  return buildMap(rawRows);
}

export async function getChatMemberRole(chatId, userId) {
  if (!chatId || !userId) {
    return "";
  }
  const row = getRow(
    dbKnex("chat_members")
      .select("role")
      .where({ chat_id: chatId, user_id: userId })
      .first(),
  );
  const resolved = row && typeof row.then === "function" ? await row : row;
  return String(resolved?.role || "");
}

export function setChatMemberRole(chatId, userId, role = "member") {
  run(
    dbKnex("chat_members")
      .where({ chat_id: chatId, user_id: userId })
      .update({ role: String(role || "member") }),
  );
}

export function deleteChatById(chatId) {
  if (isPostgresMode()) return deleteChatByIdPostgres(chatId);
  return deleteChatByIdSqlite(chatId);
}

async function deleteChatByIdPostgres(chatId) {
  if (!chatId) return { storedNames: [] };

  return await dbKnex.transaction(async (trx) => {
    const fileRows = await trx("chat_message_files as cmf")
      .select("cmf.stored_name")
      .join("chat_messages as cm", "cm.id", "cmf.message_id")
      .where("cm.chat_id", chatId);
    const storedNames = fileRows
      .map((row) => String(row?.stored_name || "").trim())
      .filter(Boolean);

    await trx("message_reactions")
      .whereIn("message_id", function () {
        this.select("id").from("chat_messages").where("chat_id", chatId);
      })
      .del();
    await trx("chat_message_reads")
      .whereIn("message_id", function () {
        this.select("id").from("chat_messages").where("chat_id", chatId);
      })
      .del();
    await trx("hidden_chat_messages")
      .whereIn("message_id", function () {
        this.select("id").from("chat_messages").where("chat_id", chatId);
      })
      .del();
    await trx("chat_message_files")
      .whereIn("message_id", function () {
        this.select("id").from("chat_messages").where("chat_id", chatId);
      })
      .del();
    await trx("chat_pinned_messages").where("chat_id", chatId).del();
    await trx("chat_pins").where("chat_id", chatId).del();
    await trx("chat_messages").where("chat_id", chatId).del();
    await trx("chat_members").where("chat_id", chatId).del();
    await trx("hidden_chats").where("chat_id", chatId).del();
    await trx("chat_mutes").where("chat_id", chatId).del();
    await trx("chat_left_members").where("chat_id", chatId).del();
    await trx("group_removed_members").where("chat_id", chatId).del();
    await trx("remote_channel_queue")
      .whereIn("source_id", function () {
        this.select("id").from("remote_channel_sources").where("chat_id", chatId);
      })
      .del();
    await trx("remote_channel_sources").where("chat_id", chatId).del();
    await trx("chats").where("id", chatId).del();

    return { storedNames };
  });
}

function deleteChatByIdSqlite(chatId) {
  if (!chatId) return { storedNames: [] };

  const fileRows = getAll(
    dbKnex("chat_message_files as cmf")
      .select("cmf.stored_name")
      .join("chat_messages as cm", "cm.id", "cmf.message_id")
      .where("cm.chat_id", chatId),
  );
  const storedNames = fileRows
    .map((row) => String(row?.stored_name || "").trim())
    .filter(Boolean);

  const savepoint = `sp_delete_chat_${Date.now()}`;
  runWithoutSave(`SAVEPOINT ${savepoint}`);
  try {
    runWithoutSave(
      dbKnex("message_reactions")
        .whereIn("message_id", function () {
          this.select("id").from("chat_messages").where("chat_id", chatId);
        })
        .del(),
    );
    runWithoutSave(
      dbKnex("chat_message_reads")
        .whereIn("message_id", function () {
          this.select("id").from("chat_messages").where("chat_id", chatId);
        })
        .del(),
    );
    runWithoutSave(
      dbKnex("hidden_chat_messages")
        .whereIn("message_id", function () {
          this.select("id").from("chat_messages").where("chat_id", chatId);
        })
        .del(),
    );
    runWithoutSave(
      dbKnex("chat_message_files")
        .whereIn("message_id", function () {
          this.select("id").from("chat_messages").where("chat_id", chatId);
        })
        .del(),
    );
    runWithoutSave(dbKnex("chat_pinned_messages").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("chat_pins").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("chat_messages").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("chat_members").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("hidden_chats").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("chat_mutes").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("chat_left_members").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("group_removed_members").where("chat_id", chatId).del());
    runWithoutSave(
      dbKnex("remote_channel_queue")
        .whereIn("source_id", function () {
          this.select("id").from("remote_channel_sources").where("chat_id", chatId);
        })
        .del(),
    );
    runWithoutSave(dbKnex("remote_channel_sources").where("chat_id", chatId).del());
    runWithoutSave(dbKnex("chats").where("id", chatId).del());
    runWithoutSave(`RELEASE ${savepoint}`);
    saveDatabase();
  } catch (error) {
    try {
      runWithoutSave(`ROLLBACK TO ${savepoint}`);
      runWithoutSave(`RELEASE ${savepoint}`);
    } catch {
      // ignore rollback failures
    }
    throw error;
  }

  return { storedNames };
}

async function deleteUserByIdPostgres(userId) {
  if (!userId) {
    return { storedNames: [], deletedChatIds: [], transferredChatIds: [], savedGifs: [] };
  }

  const result = await dbKnex.transaction(async (trx) => {
    const ownerChatRows = await trx("chat_members")
      .select("chat_id")
      .where({ role: "owner", user_id: userId });

    const ownerChatIds = Array.from(
      new Set(ownerChatRows.map((row) => row?.chat_id).filter(Boolean)),
    );
    const chatIdsToDelete = [];
    const ownershipTransfers = [];

    for (const chatId of ownerChatIds) {
      const remainingRows = await trx("chat_members")
        .select("user_id")
        .where("chat_id", chatId)
        .where("user_id", "!=", userId);
      const remaining = remainingRows
        .map((row) => row?.user_id)
        .filter(Boolean);
      if (!remaining.length) {
        chatIdsToDelete.push(chatId);
        continue;
      }
      const nextOwnerId = remaining[crypto.randomInt(remaining.length)];
      if (nextOwnerId) ownershipTransfers.push({ chatId, nextOwnerId });
    }

    const uniqueChatDeletes = Array.from(
      new Set(chatIdsToDelete.filter(Boolean)),
    );
    const storedNames = new Set();
    if (uniqueChatDeletes.length) {
      const fileRows = await trx("chat_message_files as cmf")
        .select("cmf.stored_name")
        .join("chat_messages as cm", "cm.id", "cmf.message_id")
        .whereIn("cm.chat_id", uniqueChatDeletes);
      fileRows.forEach((row) => {
        const name = String(row?.stored_name || "").trim();
        if (name) storedNames.add(name);
      });
    }

    for (const chatId of uniqueChatDeletes) {
      await trx("message_reactions")
        .whereIn("message_id", function () {
          this.select("id").from("chat_messages").where("chat_id", chatId);
        })
        .del();
      await trx("chat_message_reads")
        .whereIn("message_id", function () {
          this.select("id").from("chat_messages").where("chat_id", chatId);
        })
        .del();
      await trx("chat_message_files")
        .whereIn("message_id", function () {
          this.select("id").from("chat_messages").where("chat_id", chatId);
        })
        .del();
      await trx("chat_pinned_messages").where("chat_id", chatId).del();
      await trx("chat_pins").where("chat_id", chatId).del();
      await trx("chat_messages").where("chat_id", chatId).del();
      await trx("chat_members").where("chat_id", chatId).del();
      await trx("chat_mutes").where("chat_id", chatId).del();
      await trx("chat_left_members").where("chat_id", chatId).del();
      await trx("group_removed_members").where("chat_id", chatId).del();
      await trx("hidden_chats").where("chat_id", chatId).del();
      await trx("chats").where("id", chatId).del();
    }

    for (const transfer of ownershipTransfers) {
      if (uniqueChatDeletes.includes(transfer.chatId)) continue;
      await trx("chat_members")
        .where({ chat_id: transfer.chatId, user_id: transfer.nextOwnerId })
        .update({ role: "owner" });
    }

    // The person's own GIF collection goes with them; the caller deletes the files.
    const savedGifs = await trx("user_gifs")
      .select("id", "user_id", "storage_key", "storage_driver")
      .where("user_id", userId);
    await trx("user_gifs").where("user_id", userId).del();
    await trx("sessions").where("user_id", userId).del();
    await trx("hidden_chats").where("user_id", userId).del();
    await trx("hidden_chat_messages").where("user_id", userId).del();
    await trx("message_reactions").where("user_id", userId).del();
    // Pins belong to the conversation: they stay when the person who pinned goes.
    await trx("chat_pinned_messages").where("pinned_by", userId).update({ pinned_by: null });
    await trx("chat_pins").where("user_id", userId).del();
    await trx("chat_message_reads").where("user_id", userId).del();
    await trx("push_subscriptions").where("user_id", userId).del();
    await trx("e2ee_devices").where("user_id", userId).del();
    await trx("chat_messages")
      .where("read_by_user_id", userId)
      .update({ read_by_user_id: null });
    await trx("chat_left_members").where("user_id", userId).del();
    await trx("chat_members").where("user_id", userId).del();
    await trx("users").where("id", userId).del();

    return {
      storedNames: Array.from(storedNames),
      deletedChatIds: uniqueChatDeletes,
      transferredChatIds: ownershipTransfers.map((transfer) => transfer.chatId),
      savedGifs,
    };
  });

  return result;
}

export function deleteUserById(userId) {
  if (isPostgresMode()) return deleteUserByIdPostgres(userId);
  return deleteUserByIdSqlite(userId);
}
function deleteUserByIdSqlite(userId) {
  if (!userId) {
    return { storedNames: [], deletedChatIds: [], transferredChatIds: [], savedGifs: [] };
  }

  const ownerChatRows = getAll(
    dbKnex("chat_members")
      .select("chat_id")
      .where({ role: "owner", user_id: userId }),
  );
  const ownerChatIds = Array.from(
    new Set(ownerChatRows.map((row) => row?.chat_id).filter(Boolean)),
  );

  const chatIdsToDelete = [];
  const ownershipTransfers = [];

  ownerChatIds.forEach((chatId) => {
    const remaining = getAll(
      dbKnex("chat_members")
        .select("user_id")
        .where("chat_id", chatId)
        .where("user_id", "!=", userId),
    )
      .map((row) => row?.user_id)
      .filter(Boolean);

    if (!remaining.length) {
      chatIdsToDelete.push(chatId);
      return;
    }

    const nextOwnerId = remaining[crypto.randomInt(remaining.length)];
    if (nextOwnerId) {
      ownershipTransfers.push({
        chatId,
        nextOwnerId,
      });
    }
  });

  const uniqueChatDeletes = Array.from(
    new Set(chatIdsToDelete.filter(Boolean)),
  );

  const storedNames = new Set();

  if (uniqueChatDeletes.length) {
    const chatFileRows = getAll(
      dbKnex("chat_message_files as cmf")
        .select("cmf.stored_name")
        .join("chat_messages as cm", "cm.id", "cmf.message_id")
        .whereIn("cm.chat_id", uniqueChatDeletes),
    );
    chatFileRows.forEach((row) => {
      const name = String(row?.stored_name || "").trim();
      if (name) storedNames.add(name);
    });
  }

  // The person's own GIF collection goes with them; the caller deletes the files.
  const savedGifs = getAll(
    dbKnex("user_gifs")
      .select("id", "user_id", "storage_key", "storage_driver")
      .where("user_id", userId),
  );

  const savepoint = `sp_delete_user_${Date.now()}`;
  runWithoutSave(`SAVEPOINT ${savepoint}`);
  try {
    if (uniqueChatDeletes.length) {
      uniqueChatDeletes.forEach((chatId) => {
        runWithoutSave(
          dbKnex("message_reactions")
            .whereIn("message_id", function () {
              this.select("id").from("chat_messages").where("chat_id", chatId);
            })
            .del(),
        );
        runWithoutSave(
          dbKnex("chat_message_reads")
            .whereIn("message_id", function () {
              this.select("id").from("chat_messages").where("chat_id", chatId);
            })
            .del(),
        );
        runWithoutSave(
          dbKnex("chat_message_files")
            .whereIn("message_id", function () {
              this.select("id").from("chat_messages").where("chat_id", chatId);
            })
            .del(),
        );
        runWithoutSave(dbKnex("chat_pinned_messages").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("chat_pins").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("chat_messages").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("chat_members").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("chat_mutes").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("chat_left_members").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("group_removed_members").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("hidden_chats").where("chat_id", chatId).del());
        runWithoutSave(dbKnex("chats").where("id", chatId).del());
      });
    }

    ownershipTransfers.forEach((transfer) => {
      if (
        uniqueChatDeletes.includes(transfer.chatId) ||
        !transfer.chatId ||
        !transfer.nextOwnerId
      ) {
        return;
      }
      runWithoutSave(
        dbKnex("chat_members")
          .where({ chat_id: transfer.chatId, user_id: transfer.nextOwnerId })
          .update({ role: "owner" }),
      );
    });

    runWithoutSave(dbKnex("user_gifs").where("user_id", userId).del());
    runWithoutSave(dbKnex("sessions").where("user_id", userId).del());
    runWithoutSave(dbKnex("hidden_chats").where("user_id", userId).del());
    runWithoutSave(dbKnex("hidden_chat_messages").where("user_id", userId).del());
    runWithoutSave(dbKnex("message_reactions").where("user_id", userId).del());
    // Pins belong to the conversation: they stay when the person who pinned goes.
    runWithoutSave(
      dbKnex("chat_pinned_messages").where("pinned_by", userId).update({ pinned_by: null }),
    );
    runWithoutSave(dbKnex("chat_pins").where("user_id", userId).del());
    runWithoutSave(dbKnex("chat_message_reads").where("user_id", userId).del());
    runWithoutSave(dbKnex("push_subscriptions").where("user_id", userId).del());
    runWithoutSave(dbKnex("e2ee_devices").where("user_id", userId).del());
    runWithoutSave(
      dbKnex("chat_messages")
        .where("read_by_user_id", userId)
        .update({ read_by_user_id: null }),
    );
    runWithoutSave(dbKnex("chat_left_members").where("user_id", userId).del());
    runWithoutSave(dbKnex("chat_members").where("user_id", userId).del());
    runWithoutSave(dbKnex("users").where("id", userId).del());
    runWithoutSave(`RELEASE ${savepoint}`);
    saveDatabase();
  } catch (error) {
    try {
      runWithoutSave(`ROLLBACK TO ${savepoint}`);
      runWithoutSave(`RELEASE ${savepoint}`);
    } catch {
      // ignore rollback failures
    }
    throw error;
  }

  return {
    storedNames: Array.from(storedNames),
    deletedChatIds: uniqueChatDeletes,
    transferredChatIds: ownershipTransfers.map((t) => t.chatId),
    savedGifs,
  };
}

export function listChatsForUser(userId) {
  if (!userId) {
    return isPostgresMode() ? Promise.resolve([]) : [];
  }

  const memberChats = dbKnex("chats as c")
    .select(
      "c.id",
      "c.name",
      "c.type",
      "c.group_username",
      "c.group_visibility",
      "c.invite_token",
      "c.group_color",
      "c.allow_member_invites",
      "c.allow_member_pins",
      "c.group_avatar_url",
      "c.created_by_user_id",
      "c.created_at",
      "c.verified",
      dbKnex.raw("COALESCE(mu.muted, 0) AS muted"),
    )
    .join("chat_members as m", "m.chat_id", "c.id")
    .leftJoin("chat_mutes as mu", function () {
      this.on("mu.chat_id", "=", "c.id").andOn("mu.user_id", "=", "m.user_id");
    })
    .leftJoin("hidden_chats as h", function () {
      this.on("h.chat_id", "=", "c.id").andOn("h.user_id", "=", "m.user_id");
    })
    .where("m.user_id", userId)
    .whereNull("h.chat_id");

  const lastMessageIdSubquery = dbKnex("chat_messages as last_cm")
    .select("last_cm.id")
    .whereRaw("last_cm.chat_id = mc.id")
    .whereNot("last_cm.body", "like", "[[system:%]]")
    .whereNull("last_cm.hidden_everyone_at")
    .whereNotExists(
      dbKnex("hidden_chat_messages as last_hcm")
        .select(1)
        .where("last_hcm.user_id", userId)
        .whereRaw("last_hcm.message_id = last_cm.id"),
    )
    .orderBy("last_cm.created_at", "desc")
    .orderBy("last_cm.id", "desc")
    .limit(1);

  const outgoingMessageIdSubquery = dbKnex("chat_messages as outgoing_cm")
    .select("outgoing_cm.id")
    .whereRaw("outgoing_cm.chat_id = mc.id")
    .where("outgoing_cm.user_id", userId)
    .whereRaw("NOT (LOWER(COALESCE(outgoing_cm.client_request_id, '')) LIKE ?)", [
      "remote:%",
    ])
    .whereNot("outgoing_cm.body", "like", "[[system:%]]")
    .whereNull("outgoing_cm.hidden_everyone_at")
    .whereNotExists(
      dbKnex("hidden_chat_messages as outgoing_hcm")
        .select(1)
        .where("outgoing_hcm.user_id", userId)
        .whereRaw("outgoing_hcm.message_id = outgoing_cm.id"),
    )
    .orderBy("outgoing_cm.created_at", "desc")
    .orderBy("outgoing_cm.id", "desc")
    .limit(1);

  const unreadCountSubquery = dbKnex("chat_messages as unread_cm")
    .count("*")
    .whereRaw("unread_cm.chat_id = mc.id")
    .whereNot("unread_cm.body", "like", "[[system:%]]")
    .whereNull("unread_cm.hidden_everyone_at")
    .where(function () {
      this.where("unread_cm.user_id", "!=", userId).orWhereRaw(
        "LOWER(COALESCE(unread_cm.client_request_id, '')) LIKE ?",
        ["remote:%"],
      );
    })
    .whereNotExists(
      dbKnex("chat_message_reads as cmr")
        .select(1)
        .where("cmr.user_id", userId)
        .whereRaw("cmr.message_id = unread_cm.id"),
    )
    .whereNotExists(
      dbKnex("hidden_chat_messages as unread_hcm")
        .select(1)
        .where("unread_hcm.user_id", userId)
        .whereRaw("unread_hcm.message_id = unread_cm.id"),
    );

  const query = dbKnex
    .with("member_chats", memberChats)
    .select(
      "mc.id",
      "mc.name",
      "mc.type",
      "mc.group_username",
      "mc.group_visibility",
      "mc.invite_token",
      "mc.group_color",
      "mc.allow_member_invites",
      "mc.allow_member_pins",
      "mc.group_avatar_url",
      "mc.created_by_user_id",
      "mc.verified",
      "mc.muted",
      "cp.position as pin_position",
      dbKnex.raw("COALESCE(rcs.enabled, 0) AS remote_channel_enabled"),
      "last_vm.id as last_message_id",
      dbKnex.raw("COALESCE(last_vm.edited_body, last_vm.body) AS last_message"),
      "last_vm.created_at as last_time",
      "last_vm.user_id as last_sender_id",
      "last_vm.client_request_id as last_message_client_request_id",
      // A call history entry as the last message: the route words its preview.
      "last_vm.call_id as last_call_id",
      "last_vm.call_kind as last_call_kind",
      "last_vm.call_outcome as last_call_outcome",
      "last_vm.call_duration_sec as last_call_duration_sec",
      dbKnex.raw(
        "CASE WHEN last_vm.id IS NULL THEN NULL ELSE COALESCE(last_user.username, 'deleted') END AS last_sender_username",
      ),
      dbKnex.raw(
        "CASE WHEN last_vm.id IS NULL THEN NULL ELSE COALESCE(last_user.nickname, 'Deleted user') END AS last_sender_nickname",
      ),
      "last_user.avatar_url as last_sender_avatar_url",
      "last_vm.read_at as last_message_read_at",
      "last_vm.read_by_user_id as last_message_read_by_user_id",
      "outgoing_vm.created_at as last_outgoing_time",
      dbKnex.raw("COALESCE((?), 0) AS unread_count", [unreadCountSubquery]),
    )
    .from("member_chats as mc")
    .leftJoin("chat_messages as last_vm", "last_vm.id", lastMessageIdSubquery)
    .leftJoin("users as last_user", "last_user.id", "last_vm.user_id")
    .leftJoin("chat_messages as outgoing_vm", "outgoing_vm.id", outgoingMessageIdSubquery)
    .leftJoin("remote_channel_sources as rcs", function () {
      this.on("rcs.chat_id", "=", "mc.id").andOn("rcs.enabled", "=", dbKnex.raw("1"));
    })
    // The person's own pins: one join, no query per chat. member_chats already
    // leaves out chats they left or hid, so only live pins can match.
    .leftJoin("chat_pins as cp", function () {
      this.on("cp.chat_id", "=", "mc.id").andOn("cp.user_id", "=", dbKnex.raw("?", [userId]));
    })
    // Pinned chats first, by position; then the usual order.
    .orderByRaw('CASE WHEN "cp"."position" IS NULL THEN 1 ELSE 0 END ASC')
    .orderBy("cp.position", "asc")
    .orderBy("last_vm.created_at", "desc")
    .orderBy("last_vm.id", "desc")
    .orderBy("mc.created_at", "desc");

  const rawRows = getAll(query);

  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then((rows) => (rows || []).map(decryptMessageRow));
  }

  return (rawRows || []).map(decryptMessageRow);
}

export function createMessage(
  chatId,
  userId,
  body,
  replyToMessageId = null,
  expiresAt = null,
  clientRequestId = null,
  { allowPlaintextSystemMessage = false, id: requestedId = null } = {},
) {
  // created_at has a resolution of one second and a chat sorts equal times by
  // id, so ids grow with time: messages written within the same second keep the
  // order they were written in. A caller that writes several messages at once
  // (multi-select forward) hands in its own ascending ids.
  const id = isValidUuid(requestedId) ? String(requestedId).trim() : generateOrderedUuid();
  const storedBody = storageEncryption.encryptText(body, {
    allowPlaintextSystemMessage,
  });
  // Set created_at explicitly instead of relying on the DB column default:
  // SQLite evaluates DEFAULT (datetime('now')) correctly, but Postgres
  // tables provisioned from the SQLite schema can carry the literal string
  // "datetime('now')" as their default (see migration 039). Space-separated
  // UTC matches the legacy row format so TEXT ordering stays consistent.
  const createdAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const res = run(
    dbKnex("chat_messages").insert({
      id,
      chat_id: chatId,
      user_id: userId,
      body: storedBody,
      created_at: createdAt,
      reply_to_message_id: replyToMessageId || null,
      expires_at: expiresAt || null,
      client_request_id: clientRequestId || null,
    }),
  );

  if (res && typeof res.then === "function") {
    return res.then(() => id);
  }
  return id;
}

export function findMessageIdByClientRequestId(chatId, userId, clientRequestId) {
  const normalized = String(clientRequestId || "").trim();
  if (!normalized) return isPostgresMode() ? Promise.resolve(null) : null;
  const row = getRow(
    dbKnex("chat_messages")
      .select("id")
      .where({
        chat_id: chatId,
        user_id: userId,
        client_request_id: normalized,
      })
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => r?.id || null);
  }
  return row?.id || null;
}

export function createOrReuseMessage(
  chatId,
  userId,
  body,
  replyToMessageId = null,
  expiresAt = null,
  clientRequestId = null,
) {
  const normalizedClientRequestId = String(clientRequestId || "").trim() || null;

  const createAndWrap = () => {
    const rawId = createMessage(
      chatId,
      userId,
      body,
      replyToMessageId,
      expiresAt,
      normalizedClientRequestId,
    );
    if (rawId && typeof rawId.then === "function") {
      return rawId.then((id) => ({ id, deduped: false }));
    }
    return { id: rawId, deduped: false };
  };

  if (normalizedClientRequestId) {
    const rawExisting = findMessageIdByClientRequestId(
      chatId,
      userId,
      normalizedClientRequestId,
    );
    if (rawExisting && typeof rawExisting.then === "function") {
      return rawExisting.then((existingId) => {
        if (existingId) return { id: existingId, deduped: true };
        return createAndWrap();
      });
    }
    if (rawExisting) {
      return { id: rawExisting, deduped: true };
    }
  }

  try {
    return createAndWrap();
  } catch (error) {
    if (!normalizedClientRequestId) {
      throw error;
    }
    const rawFallback = findMessageIdByClientRequestId(
      chatId,
      userId,
      normalizedClientRequestId,
    );
    if (rawFallback && typeof rawFallback.then === "function") {
      return rawFallback.then((existingId) => {
        if (existingId) return { id: existingId, deduped: true };
        throw error;
      });
    }
    if (rawFallback) {
      return { id: rawFallback, deduped: true };
    }
    throw error;
  }
}

// ─── Call history entries ────────────────────────────────────────────────────

function buildCallMessageRow(args, id, createdAt) {
  const duration = Number(args.durationSec);
  return {
    id,
    chat_id: args.chatId,
    user_id: args.callerId,
    body: "",
    created_at: createdAt,
    expires_at: args.expiresAt || null,
    call_id: args.callId,
    call_kind: args.kind,
    call_outcome: args.outcome,
    call_duration_sec:
      args.durationSec === null || args.durationSec === undefined || !Number.isFinite(duration)
        ? null
        : Math.max(0, Math.round(duration)),
    // An entry that needs no attention is read by the callee from the start.
    read_at: args.markReadBy ? createdAt : null,
    read_by_user_id: args.markReadBy || null,
  };
}

function createCallMessageSqlite(args) {
  // An ordered id, like every other message (see createMessage): a call that
  // ends within the second of the messages around it keeps its place.
  const id = generateOrderedUuid();
  const createdAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const savepoint = `sp_call_msg_${crypto.randomBytes(4).toString("hex")}`;
  runWithoutSave(`SAVEPOINT ${savepoint}`);
  try {
    // The unique index on call_id decides: whoever inserts first wins, every
    // other attempt for the same call changes nothing.
    run(
      dbKnex("chat_messages")
        .insert(buildCallMessageRow(args, id, createdAt))
        .onConflict("call_id")
        .ignore(),
    );
    const stored = getRow(
      dbKnex("chat_messages").select("id", "created_at").where({ call_id: args.callId }).first(),
    );
    const created = stored?.id === id;
    if (created && args.markReadBy) {
      run(
        dbKnex("chat_message_reads")
          .insert({ message_id: id, user_id: args.markReadBy, read_at: createdAt })
          .onConflict(["message_id", "user_id"])
          .ignore(),
      );
    }
    runWithoutSave(`RELEASE ${savepoint}`);
    return { id: stored?.id || null, created, createdAt: stored?.created_at || createdAt };
  } catch (error) {
    try {
      runWithoutSave(`ROLLBACK TO ${savepoint}`);
      runWithoutSave(`RELEASE ${savepoint}`);
    } catch {
      // ignore rollback failures
    }
    throw error;
  }
}

async function createCallMessagePostgres(args) {
  const id = generateOrderedUuid();
  const createdAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  return dbKnex.transaction(async (trx) => {
    // A second request for the same call waits here for the first one to
    // finish and then changes nothing.
    await trx("chat_messages")
      .insert(buildCallMessageRow(args, id, createdAt))
      .onConflict("call_id")
      .ignore();
    const stored = await trx("chat_messages")
      .select("id", "created_at")
      .where({ call_id: args.callId })
      .first();
    const created = stored?.id === id;
    if (created && args.markReadBy) {
      await trx("chat_message_reads")
        .insert({ message_id: id, user_id: args.markReadBy, read_at: createdAt })
        .onConflict(["message_id", "user_id"])
        .ignore();
    }
    return { id: stored?.id || null, created, createdAt: stored?.created_at || createdAt };
  });
}

/**
 * Writes the history entry of a call into its direct chat: an empty message
 * from the caller carrying the call columns (migration 047). At most one entry
 * exists per `callId`; asking again returns the existing one with
 * `created: false`, so only the request that really created it announces it.
 *
 * `markReadBy` is the callee for every outcome that needs no attention (it is
 * stored as already read by them), and null for a missed call, which stays
 * unread for the callee until they open the chat.
 *
 * @returns {{ id: string, created: boolean, createdAt: string }}
 */
export function createCallMessage(args) {
  if (isPostgresMode()) return createCallMessagePostgres(args);
  return createCallMessageSqlite(args);
}

export function markMessageRead(messageId, readerId) {
  const processRow = (row) => {
    if (!row) return;
    const isSavedChat = String(row?.chat_type || "").toLowerCase() === "saved";
    if (row?.user_id === readerId && !isRemoteMessageRow(row) && !isSavedChat) {
      return;
    }
    const updateRes = run(
      dbKnex("chat_messages")
        .where("id", messageId)
        .where((builder) => {
          if (isSavedChat) {
            // Allow reader to read own message in saved messages chat
          } else {
            builder.where("user_id", "!=", readerId);
            if (isRemoteMessageRow(row)) {
              builder.orWhereRaw(REMOTE_MESSAGE_CLIENT_REQUEST_SQL);
            }
          }
        })
        .update({
          read_at: dbKnex.raw("datetime('now')"),
          read_by_user_id: readerId,
        }),
    );
    const insertRes = run(
      dbKnex("chat_message_reads")
        .insert({
          message_id: messageId,
          user_id: readerId,
          read_at: dbKnex.raw("datetime('now')"),
        })
        .onConflict(["message_id", "user_id"])
        .ignore(),
    );
    if (isPostgresMode()) {
      return Promise.all([updateRes, insertRes]);
    }
  };

  const rowRes = getRow(
    dbKnex("chat_messages as cm")
      .leftJoin("chats as c", "c.id", "cm.chat_id")
      .select("cm.user_id", "cm.client_request_id", "c.type as chat_type")
      .where("cm.id", messageId)
      .first(),
  );

  if (rowRes && typeof rowRes.then === "function") {
    return rowRes.then(processRow);
  }
  return processRow(rowRes);
}

export function findSavedChatByUserId(userId) {
  const row = getRow(
    dbKnex("chats")
      .select(
        "id",
        "name",
        "type",
        "group_username",
        "group_visibility",
        "invite_token",
        "group_color",
        "allow_member_invites",
        "group_avatar_url",
        "created_by_user_id",
      )
      .where({ type: "saved", created_by_user_id: userId })
      .first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => r || null);
  }
  return row || null;
}

export function ensureSavedChatForUser(userId) {
  const rawExisting = findSavedChatByUserId(userId);

  const processExisting = (existing) => {
    if (existing?.id) {
      const memRes = isMember(existing.id, userId);
      const handleMem = (isMem) => {
        if (!isMem) {
          addChatMember(existing.id, userId, "owner");
        }
        if (String(existing.group_visibility || "").toLowerCase() !== "private") {
          run(
            dbKnex("chats")
              .where("id", existing.id)
              .update({ group_visibility: "private" }),
          );
        }
        return existing;
      };
      if (memRes && typeof memRes.then === "function") {
        return memRes.then(handleMem);
      }
      return handleMem(memRes);
    }
    const rawChatId = createChat("Saved messages", "saved", {
      createdByUserId: userId,
    });

    const handleChatId = (chatId) => {
      if (!chatId) return null;
      const addRes = addChatMember(chatId, userId, "owner");
      const handleAdd = () => findChatById(chatId);
      if (addRes && typeof addRes.then === "function") {
        return addRes.then(handleAdd);
      }
      return handleAdd();
    };

    if (rawChatId && typeof rawChatId.then === "function") {
      return rawChatId.then(handleChatId);
    }
    return handleChatId(rawChatId);
  };

  if (rawExisting && typeof rawExisting.then === "function") {
    return rawExisting.then(processExisting);
  }
  return processExisting(rawExisting);
}

// What a single message lookup returns (findMessageById / findMessagesByIds).
const MESSAGE_LOOKUP_COLUMNS = [
  "id",
  "chat_id",
  "user_id",
  "body",
  "edited",
  "edited_body",
  "hidden_everyone_at",
  "forwarded_from_chat_id",
  "forwarded_from_label",
  "forwarded_from_user_id",
  "forwarded_from_username",
  "forwarded_from_avatar_url",
  "forwarded_from_color",
  "created_at",
  "expires_at",
  "e2ee_envelope",
  "call_id",
  "call_kind",
  "call_outcome",
  "call_duration_sec",
];

export function findMessageById(messageId) {
  const rawRow = getRow(
    dbKnex("chat_messages")
      .select(...MESSAGE_LOOKUP_COLUMNS)
      .where("id", messageId)
      .first(),
  );
  if (rawRow && typeof rawRow.then === "function") {
    return rawRow.then(decryptMessageRow);
  }
  return decryptMessageRow(rawRow);
}

/**
 * Several messages by id in one query (the multi-select forward and delete
 * look up to 100 at once). Same columns as findMessageById, decrypted, in no
 * particular order; ids that do not exist are simply missing. Messages deleted
 * for everyone are included, like findMessageById does: the caller decides.
 */
export function findMessagesByIds(messageIds = []) {
  const ids = Array.from(
    new Set((Array.isArray(messageIds) ? messageIds : []).filter(Boolean)),
  );
  if (!ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  const rawRows = getAll(
    dbKnex("chat_messages")
      .select(...MESSAGE_LOOKUP_COLUMNS)
      .whereIn("id", ids),
  );
  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then((rows) => (rows || []).map(decryptMessageRow));
  }
  return (rawRows || []).map(decryptMessageRow);
}

export function setMessageExpiresAt(messageId, expiresAt = null) {
  run(
    dbKnex("chat_messages")
      .where("id", messageId)
      .update({ expires_at: expiresAt || null }),
  );
}

export function editMessage(messageId, editedBody) {
  run(
    dbKnex("chat_messages")
      .where("id", messageId)
      .update({
        edited: 1,
        edited_body: storageEncryption.encryptText(String(editedBody || "")),
      }),
  );
}

export function hideMessageForUser(messageId, userId) {
  run(
    dbKnex("hidden_chat_messages")
      .insert({
        message_id: messageId,
        user_id: userId,
        hidden_at: dbKnex.raw("datetime('now')"),
      })
      .onConflict(["user_id", "message_id"])
      .merge({
        hidden_at: dbKnex.raw("datetime('now')"),
      }),
  );
}

export function hideMessageForEveryone(messageId) {
  run(
    dbKnex("chat_messages")
      .where("id", messageId)
      .update({
        hidden_everyone_at: dbKnex.raw("datetime('now')"),
      }),
  );
}

export function setMessageForwardOrigin(messageId, payload = {}) {
  return run(
    dbKnex("chat_messages")
      .where("id", messageId)
      .update({
        forwarded_from_chat_id: payload.sourceChatId || null,
        forwarded_from_label: String(payload.label || "").trim() || null,
        forwarded_from_user_id: payload.sourceUserId || null,
        forwarded_from_username: String(payload.sourceUsername || "").trim() || null,
        forwarded_from_avatar_url: String(payload.sourceAvatarUrl || "").trim() || null,
        forwarded_from_color: String(payload.sourceColor || "").trim() || null,
      }),
  );
}

export function createMessageFiles(messageId, files = []) {
  if (messageId === undefined || messageId === null || !Array.isArray(files) || !files.length) {
    return isPostgresMode() ? Promise.resolve([]) : [];
  }

  const queries = files.map((file) => {
    const originalName = file.originalName || file.original_name || "";
    const storedName = file.storedName || file.stored_name || "";
    const mimeType = file.mimeType || file.mime_type || "";
    const sizeBytes = Number(file.sizeBytes || file.size_bytes || 0);
    const widthPx = Number.isFinite(Number(file.widthPx ?? file.width_px))
      ? Number(file.widthPx ?? file.width_px)
      : null;
    const heightPx = Number.isFinite(Number(file.heightPx ?? file.height_px))
      ? Number(file.heightPx ?? file.height_px)
      : null;
    const durationSeconds = Number.isFinite(
      Number(file.durationSeconds ?? file.duration_seconds),
    )
      ? Number(file.durationSeconds ?? file.duration_seconds)
      : null;
    const expiresAt = file.expiresAt || file.expires_at || null;
    const storageDriver =
      file.storageDriver || file.storage_driver || "local";
    const storageKey = file.storageKey || file.storage_key || null;
    const processingStatus =
      file.processingStatus || file.processing_status || "ready";
    const blurhash = file.blurhash || null;
    const waveform = file.waveform || null;
    const thumbStorageKey =
      file.thumbStorageKey || file.thumb_storage_key || null;
    const encryptionType =
      file.encryptionType || file.encryption_type || "none";
    // Decided by the server from the file's bytes (never taken from a client).
    const isAnimated = animationFlags(file).isAnimated ? 1 : 0;

    return run(
      dbKnex("chat_message_files").insert({
        message_id: messageId,
        kind: file.kind,
        original_name: originalName,
        stored_name: storedName,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        width_px: widthPx,
        height_px: heightPx,
        duration_seconds: durationSeconds,
        expires_at: expiresAt,
        storage_driver: storageDriver,
        storage_key: storageKey,
        processing_status: processingStatus,
        blurhash,
        waveform,
        thumb_storage_key: thumbStorageKey,
        encryption_type: encryptionType,
        is_animated: isAnimated,
      }),
    );
  });

  if (isPostgresMode()) {
    return Promise.all(queries);
  }
  return queries;
}

export function recordPendingPresignedUpload({ storageKey, userId = null, expiresAt = null }) {
  if (!storageKey) return null;
  const key = String(storageKey).trim();
  if (!key) return null;
  const nowIso = new Date().toISOString();
  run(
    dbKnex("pending_presigned_uploads").insert({
      storage_key: key,
      user_id: userId || null,
      created_at: nowIso,
      expires_at: expiresAt || null,
    }),
  );
  return { storage_key: key, user_id: userId, created_at: nowIso, expires_at: expiresAt };
}

export function removePendingPresignedUploads(storageKeys = []) {
  const keys = (Array.isArray(storageKeys) ? storageKeys : [storageKeys])
    .map((k) => (typeof k === "string" ? k.trim() : (k?.storageKey || k?.storage_key || k?.key || "")))
    .filter(Boolean);
  if (!keys.length) return 0;
  run(
    dbKnex("pending_presigned_uploads").whereIn("storage_key", keys).del(),
  );
  return keys.length;
}

export function listPendingPresignedUploads(cutoffIso = null) {
  let query = dbKnex("pending_presigned_uploads").select("*");
  if (cutoffIso) {
    query = query.where("created_at", "<=", cutoffIso);
  }
  return getAll(query);
}

/**
 * Rewrite exact storage-key references after the legacy object-storage
 * layout migration (avatars/* + uploads/* → uploads/avatars/* +
 * uploads/messages/*). All SQL lives here per repo convention.
 * @param {Array<{from:string,to:string}>|Array<[string,string]>} pairs
 * @returns {number|Promise<number>} total rows updated
 */
export function rewriteStorageKeys(pairs = []) {
  const normalized = (Array.isArray(pairs) ? pairs : [])
    .map((entry) => {
      if (Array.isArray(entry)) {
        return { from: String(entry[0] || "").trim(), to: String(entry[1] || "").trim() };
      }
      return {
        from: String(entry?.from || entry?.oldKey || entry?.storageKey || "").trim(),
        to: String(entry?.to || entry?.newKey || entry?.key || "").trim(),
      };
    })
    .filter((p) => p.from && p.to && p.from !== p.to);
  if (!normalized.length) return 0;

  const results = [];
  for (const { from, to } of normalized) {
    results.push(
      run(
        dbKnex("chat_message_files").where("storage_key", from).update({ storage_key: to }),
      ),
    );
    results.push(
      run(
        dbKnex("chat_message_files").where("thumb_storage_key", from).update({ thumb_storage_key: to }),
      ),
    );
    results.push(
      run(
        dbKnex("pending_presigned_uploads").where("storage_key", from).update({ storage_key: to }),
      ),
    );
  }

  const hasPromise = results.some((r) => r && typeof r.then === "function");
  if (!hasPromise) {
    return results.reduce((sum, n) => sum + (Number(n) || 0), 0);
  }
  return Promise.all(results).then((counts) =>
    counts.reduce((sum, n) => sum + (Number(n) || 0), 0),
  );
}

function normalizeDbTimestamp(value) {
  const str = String(value || "").trim();
  if (!str) return "";
  if (str.includes("T")) {
    const d = new Date(str);
    if (Number.isFinite(d.getTime())) {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      const hours = String(d.getUTCHours()).padStart(2, "0");
      const mins = String(d.getUTCMinutes()).padStart(2, "0");
      const secs = String(d.getUTCSeconds()).padStart(2, "0");
      return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
    }
    return str.replace("T", " ").replace(/Z$/i, "").trim();
  }
  return str;
}

export function getMessages(chatId, options = {}) {
  const limitRaw = Number(options.limit || 50);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(10000, limitRaw))
    : 50;
  const beforeIdRaw = String(options.beforeId || "").trim();
  const beforeCreatedAtRaw = normalizeDbTimestamp(options.beforeCreatedAt);
  const afterIdRaw = String(options.afterId || "").trim();
  const afterCreatedAtRaw = normalizeDbTimestamp(options.afterCreatedAt);
  const viewerUserIdRaw = String(options.viewerUserId || "").trim();
  const hasViewerUserId = Boolean(viewerUserIdRaw);
  const hasBeforeId = Boolean(beforeIdRaw);
  const hasBeforeCreatedAt = Boolean(beforeCreatedAtRaw);
  const hasBefore = hasBeforeId && hasBeforeCreatedAt;
  const hasAfterId = Boolean(afterIdRaw);
  const hasAfterCreatedAt = Boolean(afterCreatedAtRaw);
  // afterId anchor: fetch messages at or after this message (inclusive), ascending
  const hasAfter = hasAfterId && hasAfterCreatedAt;

  const visibilitySql = hasViewerUserId
    ? `
       AND ${getVisibleMessageFilterSql(
         "chat_messages",
         "WHERE hidden_chat_messages.user_id = ?",
       )}`
    : `
       AND chat_messages.hidden_everyone_at IS NULL`;

  const beforeSql = hasBefore
    ? `
       AND (
         chat_messages.created_at < ?
         OR (
           chat_messages.created_at = ?
           AND chat_messages.id < ?
         )
       )`
    : "";

  // afterSql: inclusive — includes the anchor message itself so the unread
  // divider message is always present in the returned window.
  const afterSql = hasAfter
    ? `
       AND (
         chat_messages.created_at > ?
         OR (
           chat_messages.created_at = ?
           AND chat_messages.id >= ?
         )
       )`
    : "";

  const whereSql = `WHERE chat_messages.chat_id = ?${visibilitySql}${beforeSql}${afterSql}`;
  const replyJoinVisibilitySql = hasViewerUserId
    ? `AND ${getVisibleMessageFilterSql(
        "reply",
        "WHERE hidden_chat_messages.user_id = ?",
      )}`
    : "AND reply.hidden_everyone_at IS NULL";

  const params = [];
  if (hasViewerUserId) {
    params.push(viewerUserIdRaw);
  }
  params.push(chatId);
  if (hasViewerUserId) {
    params.push(viewerUserIdRaw);
  }
  if (hasBefore) {
    params.push(beforeCreatedAtRaw, beforeCreatedAtRaw, beforeIdRaw);
  }
  if (hasAfter) {
    params.push(afterCreatedAtRaw, afterCreatedAtRaw, afterIdRaw);
  }
  params.push(limit + 1);

  // When using afterId we fetch ascending (oldest-first) so we get the window
  // starting from the anchor. Without afterId we keep the existing behaviour
  // of fetching descending (newest-first) and reversing.
  const orderSql = hasAfter
    ? "ORDER BY chat_messages.created_at ASC, chat_messages.id ASC"
    : "ORDER BY chat_messages.created_at DESC, chat_messages.id DESC";

  const rawRows = getAll(
    `
    SELECT chat_messages.id,
      COALESCE(chat_messages.edited_body, chat_messages.body) AS body,
      chat_messages.client_request_id,
      chat_messages.edited,
      chat_messages.edited_body,
      chat_messages.client_request_id,
      chat_messages.forwarded_from_chat_id,
      chat_messages.forwarded_from_label,
      chat_messages.forwarded_from_user_id,
      chat_messages.forwarded_from_username,
      chat_messages.forwarded_from_avatar_url,
      chat_messages.forwarded_from_color,
      chat_messages.created_at,
      chat_messages.expires_at,
      chat_messages.e2ee_envelope,
      chat_messages.call_id,
      chat_messages.call_kind,
      chat_messages.call_outcome,
      chat_messages.call_duration_sec,
      chat_messages.read_at,
      chat_messages.read_by_user_id,
      chat_messages.reply_to_message_id,
      users.id AS user_id,
      COALESCE(users.username, 'deleted') AS username,
      COALESCE(users.nickname, 'Deleted user') AS nickname,
      users.avatar_url, users.color,
      users.role AS user_role,
      users.verified AS user_verified,
      reply.id AS reply_id,
      COALESCE(reply.edited_body, reply.body) AS reply_body,
      reply.created_at AS reply_created_at,
      reply.user_id AS reply_user_id,
      COALESCE(reply_user.username, 'deleted') AS reply_username,
      COALESCE(reply_user.nickname, 'Deleted user') AS reply_nickname,
      reply_user.avatar_url AS reply_avatar_url,
      reply_user.color AS reply_user_color,
      reply_user.verified AS reply_user_verified,
      reply_user.role AS reply_user_role
    FROM chat_messages
    LEFT JOIN users ON users.id = chat_messages.user_id
    LEFT JOIN chat_messages reply
      ON reply.id = chat_messages.reply_to_message_id
      ${replyJoinVisibilitySql}
    LEFT JOIN users reply_user ON reply_user.id = reply.user_id
    ${whereSql}
    ${orderSql}
    LIMIT ?
  `,
    params,
  );

  const processRows = (rowsRaw) => {
    const list = rowsRaw || [];
    const hasMore = list.length > limit;
    const rows = hasAfter
      ? list.slice(0, limit)
      : list.slice(0, limit).reverse();

    return {
      messages: rows.map(decryptMessageRow),
      hasMore,
    };
  };

  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then(processRows);
  }
  return processRows(rawRows);
}

/**
 * Returns the first message in a chat that the given user has not read yet
 * (from another user or a remote message), along with its created_at timestamp.
 * Returns null if there are no unread messages.
 */
export function getFirstUnreadMessage(chatId, viewerUserId) {
  if (!chatId || !viewerUserId) return null;

  const row = getRow(
    `
    SELECT cm.id, cm.created_at
    FROM chat_messages cm
    WHERE cm.chat_id = ?
      AND (
        cm.user_id IS NULL
        OR cm.user_id != ?
        OR LOWER(COALESCE(cm.client_request_id, '')) LIKE 'remote:%'
      )
      AND cm.hidden_everyone_at IS NULL
      AND cm.body NOT LIKE '[[system:%]]'
      AND cm.id NOT IN (
        SELECT hidden_chat_messages.message_id
        FROM hidden_chat_messages
        WHERE hidden_chat_messages.user_id = ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM chat_message_reads cmr
        WHERE cmr.message_id = cm.id
          AND cmr.user_id = ?
      )
    ORDER BY julianday(cm.created_at) ASC, cm.id ASC
    LIMIT 1
    `,
    [chatId, viewerUserId, viewerUserId, viewerUserId],
  );

  if (!row) return null;
  return { id: row.id, created_at: row.created_at };
}

export function findMessageFileById(id) {
  if (!id) return isPostgresMode() ? Promise.resolve(null) : null;
  return (
    getRow(
      dbKnex("chat_message_files")
        .select(
          "id", "message_id", "kind", "original_name", "stored_name", "mime_type",
          "size_bytes", "width_px", "height_px", "duration_seconds", "expires_at", "created_at",
          "storage_driver", "storage_key", "processing_status", "blurhash", "waveform",
          "thumb_storage_key", "encryption_type", "is_animated",
        )
        .where("id", Number(id))
        .first(),
    ) || null
  );
}

export function listMessageFilesByMessageIds(messageIds = []) {
  if (!Array.isArray(messageIds) || !messageIds.length) {
    return isPostgresMode() ? Promise.resolve([]) : [];
  }

  return getAll(
    dbKnex("chat_message_files")
      .select(
        "id", "message_id", "kind", "original_name", "stored_name", "mime_type",
        "size_bytes", "width_px", "height_px", "duration_seconds", "expires_at", "created_at",
        "storage_driver", "storage_key", "processing_status", "blurhash", "waveform",
        "thumb_storage_key", "encryption_type", "is_animated",
      )
      .whereIn("message_id", messageIds)
      .orderBy("id", "asc"),
  );
}

export function listMessageFilesNeedingMetadata(limit = 10000) {
  const safeLimit = Math.max(1, Math.min(200000, Number(limit) || 10000));

  return getAll(
    dbKnex("chat_message_files")
      .select("id", "stored_name", "mime_type", "width_px", "height_px", "duration_seconds", "expires_at")
      .where((builder) => {
        builder.where("mime_type", "like", "image/%").orWhere("mime_type", "like", "video/%");
      })
      .andWhere((builder) => {
        builder
          .whereNull("width_px")
          .orWhereNull("height_px")
          .orWhere(function () {
            this.where("mime_type", "like", "video/%").whereNull("duration_seconds");
          });
      })
      .orderBy("id", "asc")
      .limit(safeLimit),
  );
}

export function updateMessageFileMetadata(fileId, metadata = {}) {
  const widthPx = Number.isFinite(Number(metadata.widthPx))
    ? Number(metadata.widthPx)
    : null;
  const heightPx = Number.isFinite(Number(metadata.heightPx))
    ? Number(metadata.heightPx)
    : null;
  const durationSeconds = Number.isFinite(Number(metadata.durationSeconds))
    ? Number(metadata.durationSeconds)
    : null;

  const updatePayload = {};
  if (widthPx !== null) updatePayload.width_px = widthPx;
  if (heightPx !== null) updatePayload.height_px = heightPx;
  if (durationSeconds !== null) updatePayload.duration_seconds = durationSeconds;

  if (!Object.keys(updatePayload).length) {
    return isPostgresMode() ? Promise.resolve(0) : 0;
  }

  return run(
    dbKnex("chat_message_files")
      .where("id", Number(fileId))
      .update(updatePayload),
  );
}

export function updateUserProfile(userId, arg2, nickname, avatarUrl) {
  const updatePayload =
    typeof arg2 === "object" && arg2 !== null
      ? { username: arg2.username, nickname: arg2.nickname, avatar_url: arg2.avatarUrl }
      : { username: arg2, nickname, avatar_url: avatarUrl };
  return run(
    dbKnex("users")
      .where("id", userId)
      .update(updatePayload),
  );
}

export function updateUserPassword(userId, passwordHash) {
  return run(
    dbKnex("users")
      .where("id", userId)
      .update({ password_hash: passwordHash }),
  );
}

export function updateUserStatus(userId, status) {
  return run(
    dbKnex("users")
      .where("id", userId)
      .update({ status }),
  );
}

export function setUserBanned(userId, banned) {
  return run(
    dbKnex("users")
      .where("id", userId)
      .update({ banned: banned ? 1 : 0 }),
  );
}

export function deleteSessionsByUserId(userId) {
  return run(
    dbKnex("sessions")
      .where("user_id", userId)
      .del(),
  );
}

export function updateLastSeen(userId) {
  if (!userId) {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
  return run(
    dbKnex("users")
      .where("id", userId)
      .update({ last_seen: dbKnex.raw("datetime('now')") }),
  );
}

export function getUserPresence(username) {
  const norm = String(username || "").trim().toLowerCase();
  if (!norm) return isPostgresMode() ? Promise.resolve(null) : null;
  const row = getRow(
    dbKnex("users")
      .select("id", "username", "status", "last_seen")
      .where(dbKnex.raw("LOWER(username) = ?", [norm]))
      .first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => r || null);
  }
  return row || null;
}

export function markMessagesRead(chatId, readerId) {
  if (!chatId || !readerId) return isPostgresMode() ? Promise.resolve() : undefined;

  const updateFn = () =>
    run(
      `
      UPDATE chat_messages
      SET read_at = datetime('now'), read_by_user_id = ?
      WHERE chat_id = ?
        AND (
          user_id != ?
          OR ${REMOTE_MESSAGE_CLIENT_REQUEST_SQL}
          OR EXISTS (SELECT 1 FROM chats WHERE chats.id = ? AND chats.type = 'saved')
        )
        AND read_at IS NULL
    `,
      [readerId, chatId, readerId, chatId],
    );

  const inserted = run(
    `INSERT OR IGNORE INTO chat_message_reads (message_id, user_id, read_at)
     SELECT cm.id, ?, datetime('now')
     FROM chat_messages cm
     WHERE cm.chat_id = ?
       AND (
         cm.user_id != ?
         OR LOWER(COALESCE(cm.client_request_id, '')) LIKE 'remote:%'
         OR EXISTS (SELECT 1 FROM chats WHERE chats.id = ? AND chats.type = 'saved')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM chat_message_reads cmr
         WHERE cmr.message_id = cm.id
           AND cmr.user_id = ?
       )`,
    [readerId, chatId, readerId, chatId, readerId],
  );
  if (inserted && typeof inserted.then === "function") {
    return inserted.then(() => updateFn());
  }

  return updateFn();
}

export function getMessageReadCounts(messageIds = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(messageIds) ? messageIds : [])
        .filter(Boolean),
    ),
  );
  if (!normalized.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("chat_message_reads")
      .select("message_id")
      .count("* as count")
      .whereIn("message_id", normalized)
      .groupBy("message_id"),
  );
}

export function getMessageAuthors(messageIds = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(messageIds) ? messageIds : [])
        .filter(Boolean),
    ),
  );
  if (!normalized.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("chat_messages")
      .select("id", "user_id", "client_request_id")
      .whereIn("id", normalized),
  );
}

export function getMessageReadByUser(messageIds = [], userId) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(messageIds) ? messageIds : [])
        .filter(Boolean),
    ),
  );
  if (!normalized.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("chat_message_reads")
      .select("message_id")
      .where("user_id", userId)
      .whereIn("message_id", normalized),
  );
}

export function recordMessageReads(messageIds = [], readerId) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(messageIds) ? messageIds : [])
        .filter(Boolean),
    ),
  );
  if (!normalized.length) return isPostgresMode() ? Promise.resolve() : undefined;
  const rawRows = getAll(
    dbKnex("chat_messages")
      .select("id", "user_id", "client_request_id")
      .whereIn("id", normalized),
  );
  const processRows = (rows) => {
    const toInsert = (rows || [])
      .filter(
        (row) =>
          row?.user_id !== readerId ||
          isRemoteMessageRow(row),
      )
      .map((row) => row.id)
      .filter(Boolean);
    if (!toInsert.length) return isPostgresMode() ? Promise.resolve() : undefined;
    const chunkSize = 300;
    const promises = [];
    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize);
      const insertItems = chunk.map((id) => ({
        message_id: id,
        user_id: readerId,
        read_at: dbKnex.raw("datetime('now')"),
      }));
      const p = run(
        dbKnex("chat_message_reads")
          .insert(insertItems)
          .onConflict(["message_id", "user_id"])
          .ignore(),
      );
      if (p && typeof p.then === "function") promises.push(p);
    }
    if (promises.length > 0) return Promise.all(promises);
  };

  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then(processRows);
  }
  return processRows(rawRows);
}

// ─── Message reactions ───────────────────────────────────────────────────────

/** True when `userId` removed the message from their own view ("delete for me"). */
export function isMessageHiddenForUser(messageId, userId) {
  if (!messageId || !userId) {
    return isPostgresMode() ? Promise.resolve(false) : false;
  }
  const row = getRow(
    dbKnex("hidden_chat_messages")
      .select("message_id")
      .where({ message_id: messageId, user_id: userId })
      .first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((resolved) => Boolean(resolved));
  }
  return Boolean(row);
}

/**
 * Which of these messages did `userId` remove from their own view? One query:
 * `[{ message_id }]`.
 */
export function listMessageIdsHiddenForUser(messageIds = [], userId) {
  const ids = Array.from(
    new Set((Array.isArray(messageIds) ? messageIds : []).filter(Boolean)),
  );
  if (!userId || !ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("hidden_chat_messages")
      .select("message_id")
      .where("user_id", userId)
      .whereIn("message_id", ids),
  );
}

// Reaction timestamps decide which of a person's reactions is the oldest and
// who reacted first, so they must be strictly increasing even when two
// reactions land in the same millisecond.
let lastReactionTimestampMs = 0;
function nextReactionTimestamp() {
  const now = Date.now();
  lastReactionTimestampMs = now > lastReactionTimestampMs ? now : lastReactionTimestampMs + 1;
  return new Date(lastReactionTimestampMs).toISOString();
}

function toggleMessageReactionSqlite({ messageId, userId, emoji, maxPerUser }) {
  return sqliteWriteTransaction("react", () => {
    const current = getAll(
      dbKnex("message_reactions")
        .select("emoji")
        .where({ message_id: messageId, user_id: userId })
        .orderBy("created_at", "asc")
        .orderBy("emoji", "asc"),
    ).map((row) => row.emoji);
    const plan = planReactionChange(current, emoji, maxPerUser);
    if (plan.remove.length) {
      run(
        dbKnex("message_reactions")
          .where({ message_id: messageId, user_id: userId })
          .whereIn("emoji", plan.remove)
          .del(),
      );
    }
    if (plan.add) {
      run(
        dbKnex("message_reactions").insert({
          message_id: messageId,
          user_id: userId,
          emoji: plan.add,
          created_at: nextReactionTimestamp(),
        }),
      );
    }
    return { added: plan.add, removed: plan.remove };
  });
}

async function toggleMessageReactionPostgres({ messageId, userId, emoji, maxPerUser }) {
  return dbKnex.transaction(async (trx) => {
    // Serialise one person's reactions on one message so two quick taps cannot
    // both pass the "room left" check and exceed the limit.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
      `message-reaction:${messageId}:${userId}`,
    ]);
    const rows = await trx("message_reactions")
      .select("emoji")
      .where({ message_id: messageId, user_id: userId })
      .orderBy("created_at", "asc")
      .orderBy("emoji", "asc");
    const plan = planReactionChange(
      rows.map((row) => row.emoji),
      emoji,
      maxPerUser,
    );
    if (plan.remove.length) {
      await trx("message_reactions")
        .where({ message_id: messageId, user_id: userId })
        .whereIn("emoji", plan.remove)
        .del();
    }
    if (plan.add) {
      await trx("message_reactions").insert({
        message_id: messageId,
        user_id: userId,
        emoji: plan.add,
        created_at: nextReactionTimestamp(),
      });
    }
    return { added: plan.add, removed: plan.remove };
  });
}

/**
 * Applies one react request atomically (Telegram semantics, see
 * planReactionChange): the same emoji again removes it, a new emoji beyond
 * `maxPerUser` pushes out the oldest one, `emoji = null` removes everything the
 * person has on the message. Returns { added, removed[] }.
 */
export function toggleMessageReaction({ messageId, userId, emoji = null, maxPerUser = 1 }) {
  const args = { messageId, userId, emoji, maxPerUser };
  if (isPostgresMode()) return toggleMessageReactionPostgres(args);
  return toggleMessageReactionSqlite(args);
}

/**
 * One batched query for a whole page of messages: a row per (message, emoji)
 * with the number of people, the time of the first reaction and whether
 * `viewerUserId` is one of them. Group and order with summarizeReactionRows().
 */
export function listMessageReactionSummaries(messageIds = [], viewerUserId = null) {
  const ids = Array.from(
    new Set((Array.isArray(messageIds) ? messageIds : []).filter(Boolean)),
  );
  if (!ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("message_reactions")
      .select("message_id", "emoji")
      .count({ count: "*" })
      .min({ first_at: "created_at" })
      .select(
        dbKnex.raw("MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted", [
          viewerUserId || "",
        ]),
      )
      .whereIn("message_id", ids)
      .groupBy("message_id", "emoji"),
  );
}

/**
 * The people behind the reactions of one message, oldest reaction first,
 * optionally for one emoji. Capped (default and maximum 200 rows).
 */
export function listMessageReactionUsers(messageId, { emoji = null, limit = REACTION_USERS_CAP } = {}) {
  if (!messageId) return isPostgresMode() ? Promise.resolve([]) : [];
  const safeLimit = Math.max(1, Math.min(REACTION_USERS_CAP, Math.trunc(Number(limit)) || REACTION_USERS_CAP));
  let query = dbKnex("message_reactions as mr")
    .select(
      "mr.emoji",
      "mr.created_at",
      "users.id",
      "users.username",
      "users.nickname",
      "users.avatar_url",
      "users.color",
    )
    .join("users", "users.id", "mr.user_id")
    .where("mr.message_id", messageId);
  if (emoji) query = query.andWhere("mr.emoji", emoji);
  return getAll(
    query
      .orderBy("mr.created_at", "asc")
      .orderBy("users.username", "asc")
      .limit(safeLimit),
  );
}

// ─── Pinned messages ─────────────────────────────────────────────────────────

// Pins are listed newest first, so their timestamps must be strictly
// increasing even when two land in the same millisecond.
let lastPinTimestampMs = 0;
function nextPinTimestamp() {
  const now = Date.now();
  lastPinTimestampMs = now > lastPinTimestampMs ? now : lastPinTimestampMs + 1;
  return new Date(lastPinTimestampMs).toISOString();
}

function pinMessageSqlite({ chatId, messageId, userId, max }) {
  return sqliteWriteTransaction("pin", () => {
    const existing = getRow(
      dbKnex("chat_pinned_messages")
        .select("pinned_at")
        .where({ chat_id: chatId, message_id: messageId })
        .first(),
    );
    if (existing) return { status: "already", pinnedAt: existing.pinned_at };
    const counted = getRow(
      dbKnex("chat_pinned_messages").count({ n: "*" }).where({ chat_id: chatId }).first(),
    );
    if (Number(counted?.n || 0) >= max) return { status: "limit", pinnedAt: null };
    const pinnedAt = nextPinTimestamp();
    run(
      dbKnex("chat_pinned_messages").insert({
        chat_id: chatId,
        message_id: messageId,
        pinned_by: userId || null,
        pinned_at: pinnedAt,
      }),
    );
    return { status: "pinned", pinnedAt };
  });
}

async function pinMessagePostgres({ chatId, messageId, userId, max }) {
  return dbKnex.transaction(async (trx) => {
    // One pin at a time per chat, so two quick requests cannot both pass the
    // "room left" check and exceed the limit.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`chat-pins:${chatId}`]);
    const existing = await trx("chat_pinned_messages")
      .select("pinned_at")
      .where({ chat_id: chatId, message_id: messageId })
      .first();
    if (existing) return { status: "already", pinnedAt: existing.pinned_at };
    const counted = await trx("chat_pinned_messages").count({ n: "*" }).where({ chat_id: chatId }).first();
    if (Number(counted?.n || 0) >= max) return { status: "limit", pinnedAt: null };
    const pinnedAt = nextPinTimestamp();
    await trx("chat_pinned_messages").insert({
      chat_id: chatId,
      message_id: messageId,
      pinned_by: userId || null,
      pinned_at: pinnedAt,
    });
    return { status: "pinned", pinnedAt };
  });
}

/**
 * Pins a message atomically. Pinning an already pinned message changes nothing
 * ("already"); when the chat has `max` pins the message is not pinned
 * ("limit"). Returns { status: "pinned" | "already" | "limit", pinnedAt }.
 */
export function pinMessage({ chatId, messageId, userId = null, max = 20 }) {
  const args = { chatId, messageId, userId, max: Math.max(1, Math.trunc(Number(max)) || 1) };
  if (isPostgresMode()) return pinMessagePostgres(args);
  return pinMessageSqlite(args);
}

/** Removes one pin. Resolves to the number of pins removed (0 or 1). */
export function unpinMessage(chatId, messageId) {
  if (!chatId || !messageId) return isPostgresMode() ? Promise.resolve(0) : 0;
  return run(
    dbKnex("chat_pinned_messages").where({ chat_id: chatId, message_id: messageId }).del(),
  );
}

/** Removes every pin of a chat. Resolves to the number of pins removed. */
export function unpinAllMessages(chatId) {
  if (!chatId) return isPostgresMode() ? Promise.resolve(0) : 0;
  return run(dbKnex("chat_pinned_messages").where({ chat_id: chatId }).del());
}

/**
 * The pins of a chat as `viewerUserId` may see them, newest pin first, in one
 * query: messages deleted for everyone or by the viewer for themselves are
 * left out. Rows carry what lib/pins.js buildPinEntry() needs, including the
 * attachment facts, so no second query per message is needed.
 */
export function listPinnedMessages(chatId, viewerUserId, { limit = 100 } = {}) {
  if (!chatId) return isPostgresMode() ? Promise.resolve([]) : [];
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 100));
  let query = dbKnex("chat_pinned_messages as p")
    .join("chat_messages as cm", "cm.id", "p.message_id")
    .leftJoin("users as u", "u.id", "cm.user_id")
    .select(
      "p.message_id",
      "p.pinned_by",
      "p.pinned_at",
      "cm.chat_id",
      "cm.user_id as sender_id",
      "cm.body",
      "cm.edited_body",
      "cm.created_at as message_created_at",
      "cm.e2ee_envelope",
      "u.username as sender_username",
      "u.nickname as sender_nickname",
      dbKnex.raw(
        "(SELECT COUNT(*) FROM chat_message_files f WHERE f.message_id = cm.id) AS file_count",
      ),
      dbKnex.raw(
        "(SELECT f.mime_type FROM chat_message_files f WHERE f.message_id = cm.id ORDER BY f.id ASC LIMIT 1) AS first_file_mime",
      ),
      dbKnex.raw(
        "(SELECT f.kind FROM chat_message_files f WHERE f.message_id = cm.id ORDER BY f.id ASC LIMIT 1) AS first_file_kind",
      ),
    )
    .where("p.chat_id", chatId)
    .where("cm.chat_id", chatId)
    .whereNull("cm.hidden_everyone_at");
  if (viewerUserId) {
    query = query.whereNotExists(
      dbKnex("hidden_chat_messages as hcm")
        .select(1)
        .where("hcm.user_id", viewerUserId)
        .whereRaw("hcm.message_id = cm.id"),
    );
  }
  const rawRows = getAll(
    query.orderBy("p.pinned_at", "desc").orderBy("p.message_id", "desc").limit(safeLimit),
  );
  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then((rows) => (rows || []).map(decryptMessageRow));
  }
  return (rawRows || []).map(decryptMessageRow);
}

/** Which of these messages are pinned in the chat? One batched query: [{ message_id }]. */
export function listPinnedMessageIds(chatId, messageIds = []) {
  const ids = Array.from(
    new Set((Array.isArray(messageIds) ? messageIds : []).filter(Boolean)),
  );
  if (!chatId || !ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("chat_pinned_messages")
      .select("message_id")
      .where("chat_id", chatId)
      .whereIn("message_id", ids),
  );
}

// ─── Pinned chats ────────────────────────────────────────────────────────────
//
// `chat_pins` is private to the person who pinned: one row per (person, chat),
// `position` 0 is the top and a new pin goes to the top. A pin only counts
// while the person is still a member of the chat and has not hidden it (see
// effectiveChatPins); the paths that end a membership or hide a chat delete the
// row too, and a pin that slipped through anyway is swept on the next pin.

/**
 * Runs `fn` (synchronous) as one atomic write on SQLite, undoing everything it
 * did if it throws.
 *
 * For operations that READ first and WRITE second (check the limit, then
 * insert). A plain SAVEPOINT outside a transaction starts a deferred one: it
 * only holds a read snapshot after its first SELECT, and turning that into a
 * write fails at once with SQLITE_BUSY_SNAPSHOT if another connection (a
 * second process, a CLI script) committed in between. The busy timeout does
 * not apply to that error. So when no transaction is open, the write lock is
 * taken first with BEGIN IMMEDIATE (which does wait for the busy timeout), and
 * the savepoint nests inside it. Inside a transaction somebody else opened,
 * only the savepoint is added. (sql.js, the fallback, is one in-memory
 * connection: a savepoint is all it needs.)
 */
function sqliteWriteTransaction(label, fn) {
  const savepoint = `sp_${label}_${crypto.randomBytes(4).toString("hex")}`;
  const ownsTransaction = Boolean(betterDb) && !betterDb.inTransaction;
  if (ownsTransaction) runWithoutSave("BEGIN IMMEDIATE");
  const undo = () => {
    try {
      runWithoutSave(`ROLLBACK TO ${savepoint}`);
      runWithoutSave(`RELEASE ${savepoint}`);
    } catch {
      // the savepoint is already gone (a failed COMMIT, say)
    }
    if (ownsTransaction && betterDb.inTransaction) {
      try {
        runWithoutSave("ROLLBACK");
      } catch {
        // ignore rollback failures
      }
    }
  };
  try {
    runWithoutSave(`SAVEPOINT ${savepoint}`);
    const result = fn();
    runWithoutSave(`RELEASE ${savepoint}`);
    if (ownsTransaction) runWithoutSave("COMMIT");
    return result;
  } catch (error) {
    undo();
    throw error;
  }
}

/** The person's pins that still count: still a member, chat not hidden. */
function effectiveChatPins(root, userId) {
  return root("chat_pins as cp")
    .join("chat_members as m", function () {
      this.on("m.chat_id", "=", "cp.chat_id").andOn("m.user_id", "=", "cp.user_id");
    })
    .where("cp.user_id", userId)
    .whereNotExists(
      dbKnex("hidden_chats as h")
        .select(1)
        .whereRaw("h.chat_id = cp.chat_id")
        .whereRaw("h.user_id = cp.user_id"),
    );
}

/** The person's pin rows that no longer count (left the chat, hid it). */
function stalePinChatIds(root, userId) {
  return root("chat_pins as cp")
    .select("cp.chat_id")
    .where("cp.user_id", userId)
    .where(function () {
      this.whereNotExists(
        dbKnex("chat_members as m")
          .select(1)
          .whereRaw("m.chat_id = cp.chat_id")
          .whereRaw("m.user_id = cp.user_id"),
      ).orWhereExists(
        dbKnex("hidden_chats as h")
          .select(1)
          .whereRaw("h.chat_id = cp.chat_id")
          .whereRaw("h.user_id = cp.user_id"),
      );
    });
}

const orderedPinRows = (builder) =>
  builder
    .select("cp.chat_id", "cp.position")
    .orderBy("cp.position", "asc")
    .orderBy("cp.chat_id", "asc");

const chatPinsLockKey = (userId) => `chat-pins:user:${userId}`;

/** Only real, distinct chat ids (strings); anything else cannot be a chat. */
const pinChatIdList = (chatIds) =>
  Array.from(
    new Set((Array.isArray(chatIds) ? chatIds : []).filter((id) => typeof id === "string" && id)),
  );

/** Keeps a "WHERE chat_id IN (...)" well under the database's variable limit. */
const chunkPinChatIds = (ids, size = 500) => {
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
};

/**
 * Deletes the person's pin rows of these chats, nothing else. The cleanup done
 * when a membership ends or a chat is hidden; the pins that remain keep their
 * order (their numbers may have a gap, which only the next unpin closes).
 * removeChatPins() is the same with renumbering, for the pin API.
 */
function deleteChatPinRows(userId, chatIds) {
  const ids = pinChatIdList(chatIds);
  if (!userId || !ids.length) return isPostgresMode() ? Promise.resolve(0) : 0;
  const chunks = chunkPinChatIds(ids);
  const deleteChunk = (chunk) =>
    run(dbKnex("chat_pins").where("user_id", userId).whereIn("chat_id", chunk).del());
  if (isPostgresMode()) {
    return Promise.all(chunks.map(deleteChunk)).then((counts) =>
      counts.reduce((sum, n) => sum + (Number(n) || 0), 0),
    );
  }
  return chunks.reduce((sum, chunk) => sum + (Number(deleteChunk(chunk)) || 0), 0);
}

function pinChatSqlite({ userId, chatId, max }) {
  let wrote = false;
  const result = sqliteWriteTransaction("chat_pin", () => {
    if (!getRow(dbKnex("chat_members").select("chat_id").where({ chat_id: chatId, user_id: userId }).first())) {
      return { status: "not_member", position: null };
    }
    if (getRow(dbKnex("hidden_chats").select("chat_id").where({ chat_id: chatId, user_id: userId }).first())) {
      return { status: "hidden", position: null };
    }

    // Sweep pins that stopped counting, then tidy the numbering they left.
    const stale = getAll(stalePinChatIds(dbKnex, userId)).map((row) => row.chat_id);
    if (stale.length) {
      wrote = true;
      runWithoutSave(dbKnex("chat_pins").where("user_id", userId).whereIn("chat_id", stale).del());
    }

    let rows = getAll(orderedPinRows(effectiveChatPins(dbKnex, userId)));
    if (stale.length) {
      for (const update of planPinCompaction(rows)) {
        runWithoutSave(
          dbKnex("chat_pins")
            .where({ user_id: userId, chat_id: update.chatId })
            .update({ position: update.position }),
        );
      }
      rows = getAll(orderedPinRows(effectiveChatPins(dbKnex, userId)));
    }
    const decision = decideChatPin({ rows, chatId, max });
    if (decision.action === "already") return { status: "already", position: decision.position };
    if (decision.action === "limit") return { status: "limit", position: null };

    // The new pin goes to the top; everything else moves one place down.
    wrote = true;
    runWithoutSave(
      dbKnex("chat_pins").where("user_id", userId).update({ position: dbKnex.raw("?? + 1", ["position"]) }),
    );
    runWithoutSave(
      dbKnex("chat_pins").insert({
        user_id: userId,
        chat_id: chatId,
        position: 0,
        pinned_at: new Date().toISOString(),
      }),
    );
    return { status: "pinned", position: 0 };
  });
  if (wrote) scheduleDatabaseSave();
  return result;
}

async function pinChatPostgres({ userId, chatId, max }) {
  return dbKnex.transaction(async (trx) => {
    // One change at a time per person, so two quick requests cannot both pass
    // the "room left" check and exceed the limit.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [chatPinsLockKey(userId)]);

    const member = await trx("chat_members").select("chat_id").where({ chat_id: chatId, user_id: userId }).first();
    if (!member) return { status: "not_member", position: null };
    const hidden = await trx("hidden_chats").select("chat_id").where({ chat_id: chatId, user_id: userId }).first();
    if (hidden) return { status: "hidden", position: null };

    const stale = (await stalePinChatIds(trx, userId)).map((row) => row.chat_id);
    if (stale.length) {
      await trx("chat_pins").where("user_id", userId).whereIn("chat_id", stale).del();
    }

    let rows = await orderedPinRows(effectiveChatPins(trx, userId));
    if (stale.length) {
      for (const update of planPinCompaction(rows)) {
        await trx("chat_pins")
          .where({ user_id: userId, chat_id: update.chatId })
          .update({ position: update.position });
      }
      rows = await orderedPinRows(effectiveChatPins(trx, userId));
    }
    const decision = decideChatPin({ rows, chatId, max });
    if (decision.action === "already") return { status: "already", position: decision.position };
    if (decision.action === "limit") return { status: "limit", position: null };

    await trx("chat_pins").where("user_id", userId).update({ position: trx.raw("?? + 1", ["position"]) });
    await trx("chat_pins").insert({
      user_id: userId,
      chat_id: chatId,
      position: 0,
      pinned_at: new Date().toISOString(),
    });
    return { status: "pinned", position: 0 };
  });
}

/**
 * Pins a chat for a person, at the top of their pins, atomically. Returns
 * { status, position }:
 *   "pinned"     the chat is pinned now (position 0)
 *   "already"    it was pinned; nothing moved (position is where it is)
 *   "limit"      the person already has `max` pins; nothing changed
 *   "not_member" the person is not in the chat (or it does not exist)
 *   "hidden"     the person has hidden the chat
 */
export function pinChat({ userId, chatId, max = 5 }) {
  if (!userId || !chatId) {
    const refused = { status: "not_member", position: null };
    return isPostgresMode() ? Promise.resolve(refused) : refused;
  }
  const args = { userId, chatId, max: Math.max(1, Math.trunc(Number(max)) || 1) };
  if (isPostgresMode()) return pinChatPostgres(args);
  return pinChatSqlite(args);
}

/**
 * The person's pins as the chat list uses them, top first:
 * [{ chat_id, position, pinned_at }].
 */
export function listChatPins(userId) {
  if (!userId) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    effectiveChatPins(dbKnex, userId)
      .select("cp.chat_id", "cp.position", "cp.pinned_at")
      .orderBy("cp.position", "asc")
      .orderBy("cp.chat_id", "asc"),
  );
}

/** The pins of several people in one query: [{ user_id, chat_id, position }]. */
export function listChatPinsForUsers(userIds = []) {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean)));
  if (!ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  const query = (chunk) =>
    getAll(
      dbKnex("chat_pins as cp")
        .join("chat_members as m", function () {
          this.on("m.chat_id", "=", "cp.chat_id").andOn("m.user_id", "=", "cp.user_id");
        })
        .select("cp.user_id", "cp.chat_id", "cp.position")
        .whereIn("cp.user_id", chunk)
        .whereNotExists(
          dbKnex("hidden_chats as h")
            .select(1)
            .whereRaw("h.chat_id = cp.chat_id")
            .whereRaw("h.user_id = cp.user_id"),
        )
        .orderBy("cp.user_id", "asc")
        .orderBy("cp.position", "asc")
        .orderBy("cp.chat_id", "asc"),
    );
  if (isPostgresMode()) {
    return Promise.all(chunks.map(query)).then((parts) => parts.flat());
  }
  return chunks.flatMap(query);
}

/** The people who have this chat pinned: [{ user_id, username }]. */
export function listChatPinHolders(chatId) {
  if (!chatId) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("chat_pins as cp")
      .join("users as u", "u.id", "cp.user_id")
      .select("cp.user_id", "u.username")
      .where("cp.chat_id", chatId)
      .orderBy("cp.user_id", "asc"),
  );
}

function removeChatPinsSqlite({ userId, chatIds }) {
  const removed = sqliteWriteTransaction("chat_unpin", () => {
    let present = 0;
    for (const chunk of chunkPinChatIds(chatIds)) {
      present += getAll(
        dbKnex("chat_pins").select("chat_id").where("user_id", userId).whereIn("chat_id", chunk),
      ).length;
      runWithoutSave(dbKnex("chat_pins").where("user_id", userId).whereIn("chat_id", chunk).del());
    }
    if (!present) return 0;
    const rows = getAll(orderedPinRows(effectiveChatPins(dbKnex, userId)));
    for (const update of planPinCompaction(rows)) {
      runWithoutSave(
        dbKnex("chat_pins")
          .where({ user_id: userId, chat_id: update.chatId })
          .update({ position: update.position }),
      );
    }
    return present;
  });
  if (removed) scheduleDatabaseSave();
  return removed;
}

async function removeChatPinsPostgres({ userId, chatIds }) {
  return dbKnex.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [chatPinsLockKey(userId)]);
    let removed = 0;
    for (const chunk of chunkPinChatIds(chatIds)) {
      removed += Number(await trx("chat_pins").where("user_id", userId).whereIn("chat_id", chunk).del()) || 0;
    }
    if (!removed) return 0;
    const rows = await orderedPinRows(effectiveChatPins(trx, userId));
    for (const update of planPinCompaction(rows)) {
      await trx("chat_pins")
        .where({ user_id: userId, chat_id: update.chatId })
        .update({ position: update.position });
    }
    return Number(removed);
  });
}

/**
 * Removes the person's pins of these chats (unpinning, leaving, being removed,
 * hiding) and closes the gaps. Resolves to the number of pins removed.
 */
export function removeChatPins(userId, chatIds = []) {
  const ids = pinChatIdList(chatIds);
  if (!userId || !ids.length) return isPostgresMode() ? Promise.resolve(0) : 0;
  if (isPostgresMode()) return removeChatPinsPostgres({ userId, chatIds: ids });
  return removeChatPinsSqlite({ userId, chatIds: ids });
}

function reorderChatPinsSqlite({ userId, chatIds }) {
  const result = sqliteWriteTransaction("chat_pin_order", () => {
    const rows = getAll(orderedPinRows(effectiveChatPins(dbKnex, userId)));
    const plan = planPinReorder(rows, chatIds);
    if (!plan.ok) return { status: "mismatch", changed: false };
    for (const update of plan.updates) {
      runWithoutSave(
        dbKnex("chat_pins")
          .where({ user_id: userId, chat_id: update.chatId })
          .update({ position: update.position }),
      );
    }
    return { status: "ok", changed: plan.updates.length > 0 };
  });
  if (result.changed) scheduleDatabaseSave();
  return result;
}

async function reorderChatPinsPostgres({ userId, chatIds }) {
  return dbKnex.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [chatPinsLockKey(userId)]);
    const rows = await orderedPinRows(effectiveChatPins(trx, userId));
    const plan = planPinReorder(rows, chatIds);
    if (!plan.ok) return { status: "mismatch", changed: false };
    for (const update of plan.updates) {
      await trx("chat_pins")
        .where({ user_id: userId, chat_id: update.chatId })
        .update({ position: update.position });
    }
    return { status: "ok", changed: plan.updates.length > 0 };
  });
}

/**
 * Puts the person's pins in the given order (first = top), atomically. The
 * list must be exactly their pinned chats, each once; otherwise nothing changes
 * and the result is { status: "mismatch" }. Returns { status: "ok" | "mismatch",
 * changed }.
 */
export function reorderChatPins(userId, chatIds = []) {
  const ids = Array.isArray(chatIds) ? chatIds : [];
  if (!userId) {
    const refused = { status: "mismatch", changed: false };
    return isPostgresMode() ? Promise.resolve(refused) : refused;
  }
  if (isPostgresMode()) return reorderChatPinsPostgres({ userId, chatIds: ids });
  return reorderChatPinsSqlite({ userId, chatIds: ids });
}

export function hideChatsForUser(userId, chatIds = []) {
  if (!userId || !Array.isArray(chatIds) || !chatIds.length) {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
  const validChatIds = chatIds.filter(Boolean);
  if (!validChatIds.length) {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
  if (isPostgresMode()) {
    // A chat that is hidden is not in the list, so it cannot stay pinned.
    return Promise.resolve(deleteChatPinRows(userId, validChatIds)).then(() =>
      Promise.all(
        validChatIds.map((chatId) =>
          run(
            dbKnex("hidden_chats")
              .insert({ user_id: userId, chat_id: chatId })
              .onConflict(["user_id", "chat_id"])
              .ignore(),
          ),
        ),
      ),
    );
  }
  deleteChatPinRows(userId, validChatIds);
  validChatIds.forEach((chatId) => {
    run(
      dbKnex("hidden_chats")
        .insert({ user_id: userId, chat_id: chatId })
        .onConflict(["user_id", "chat_id"])
        .ignore(),
    );
  });
}

export function unhideChat(userId, chatId) {
  if (!userId || !chatId) {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
  return run(
    dbKnex("hidden_chats")
      .where({ user_id: userId, chat_id: chatId })
      .del(),
  );
}

export function setChatMuted(userId, chatId, muted) {
  if (!userId || !chatId) {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
  if (muted) {
    return run(
      dbKnex("chat_mutes")
        .insert({
          user_id: userId,
          chat_id: chatId,
          muted: 1,
          updated_at: dbKnex.raw("datetime('now')"),
        })
        .onConflict(["user_id", "chat_id"])
        .merge({
          muted: 1,
          updated_at: dbKnex.raw("datetime('now')"),
        }),
    );
  }

  return run(
    dbKnex("chat_mutes")
      .where({ user_id: userId, chat_id: chatId })
      .del(),
  );
}

export function upsertPushSubscription(userId, endpoint, p256dh, auth, messagePreview = 1) {
  const safeEndpoint = String(endpoint || "").trim();
  if (!userId || !safeEndpoint) {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
  const preview = messagePreview === false || messagePreview === 0 ? 0 : 1;
  return run(
    dbKnex("push_subscriptions")
      .insert({
        user_id: userId,
        endpoint: safeEndpoint,
        p256dh: String(p256dh || ""),
        auth: String(auth || ""),
        message_preview: preview,
        updated_at: dbKnex.raw("datetime('now')"),
      })
      .onConflict("endpoint")
      .merge({
        user_id: userId,
        p256dh: String(p256dh || ""),
        auth: String(auth || ""),
        message_preview: preview,
        updated_at: dbKnex.raw("datetime('now')"),
      }),
  );
}

export function deletePushSubscription(endpoint) {
  const safeEndpoint = String(endpoint || "").trim();
  if (!safeEndpoint) {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
  return run(
    dbKnex("push_subscriptions")
      .where("endpoint", safeEndpoint)
      .del(),
  );
}

export function getTotalUnreadCount(userId) {
  if (!userId) return 0;
  const mcQb = dbKnex("chats as c")
    .select("c.id as chat_id")
    .join("chat_members as m", function () {
      this.on("m.chat_id", "=", "c.id").andOn("m.user_id", "=", dbKnex.raw("?", [userId]));
    })
    .leftJoin("chat_mutes as mu", function () {
      this.on("mu.chat_id", "=", "c.id").andOn("mu.user_id", "=", dbKnex.raw("?", [userId])).andOn("mu.muted", "=", dbKnex.raw("1"));
    })
    .leftJoin("hidden_chats as h", function () {
      this.on("h.chat_id", "=", "c.id").andOn("h.user_id", "=", dbKnex.raw("?", [userId]));
    })
    .whereNull("h.chat_id")
    .whereNull("mu.chat_id");

  const qb = dbKnex
    .from(mcQb.as("mc"))
    .join("chat_messages as cm", "cm.chat_id", "mc.chat_id")
    .leftJoin("hidden_chat_messages as hcm", function () {
      this.on("hcm.message_id", "=", "cm.id").andOn("hcm.user_id", "=", dbKnex.raw("?", [userId]));
    })
    .leftJoin("chat_message_reads as cmr", function () {
      this.on("cmr.message_id", "=", "cm.id").andOn("cmr.user_id", "=", dbKnex.raw("?", [userId]));
    })
    .whereNot("cm.body", "like", "[[system:%]]")
    .whereNull("cm.hidden_everyone_at")
    .whereNull("hcm.message_id")
    .andWhere((builder) => {
      builder
        .where("cm.user_id", "!=", userId)
        .orWhereRaw("LOWER(COALESCE(cm.client_request_id, '')) LIKE 'remote:%'");
    })
    .whereNull("cmr.message_id")
    .count("* as total")
    .first();

  const row = getRow(qb);
  if (row && typeof row.then === "function") {
    return row.then((r) => Number(r?.total || 0));
  }
  return Number(row?.total || 0);
}

export function listPushSubscriptionsByUserIds(userIds = []) {
  const ids = Array.from(
    new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean)),
  );
  if (!ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("push_subscriptions")
      .select("user_id", "endpoint", "p256dh", "auth", "message_preview")
      .whereIn("user_id", ids),
  );
}

// ── End-to-end encryption: device public-key directory ──────────────────────
// Only PUBLIC keys are stored. The server cannot decrypt anything wrapped for
// these keys.

const E2EE_DEVICE_COLUMNS = [
  "id",
  "user_id",
  "label",
  "ecdh_public",
  "ecdsa_public",
  "created_at",
  "last_seen_at",
  "revoked_at",
];

function nowDbTimestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function findE2eeDevice(userId, deviceId) {
  if (!userId || !deviceId) return isPostgresMode() ? Promise.resolve(null) : null;
  const row = getRow(
    dbKnex("e2ee_devices")
      .select(E2EE_DEVICE_COLUMNS)
      .where({ user_id: userId, id: deviceId })
      .first(),
  );
  if (row && typeof row.then === "function") return row.then((r) => r || null);
  return row || null;
}

export function countActiveE2eeDevices(userId) {
  if (!userId) return isPostgresMode() ? Promise.resolve(0) : 0;
  const row = getRow(
    dbKnex("e2ee_devices")
      .where("user_id", userId)
      .whereNull("revoked_at")
      .count({ total: "*" })
      .first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => Number(r?.total || 0));
  }
  return Number(row?.total || 0);
}

export function createE2eeDevice({ userId, label, ecdhPublic, ecdsaPublic }) {
  const id = generateUuid();
  const ts = nowDbTimestamp();
  const record = {
    id,
    user_id: userId,
    label: label || null,
    ecdh_public: ecdhPublic,
    ecdsa_public: ecdsaPublic,
    created_at: ts,
    last_seen_at: ts,
    revoked_at: null,
  };
  const res = run(dbKnex("e2ee_devices").insert(record));
  if (res && typeof res.then === "function") return res.then(() => record);
  return record;
}

export function touchE2eeDevice(userId, deviceId) {
  if (!userId || !deviceId) return isPostgresMode() ? Promise.resolve(0) : 0;
  return run(
    dbKnex("e2ee_devices")
      .where({ user_id: userId, id: deviceId })
      .whereNull("revoked_at")
      .update({ last_seen_at: nowDbTimestamp() }),
  );
}

export function revokeE2eeDevice(userId, deviceId) {
  if (!userId || !deviceId) return isPostgresMode() ? Promise.resolve(0) : 0;
  return run(
    dbKnex("e2ee_devices")
      .where({ user_id: userId, id: deviceId })
      .whereNull("revoked_at")
      .update({ revoked_at: nowDbTimestamp() }),
  );
}

/**
 * Revokes the device of `userId` that has been idle the longest. Used to make
 * room when someone registers more browsers than the per-user cap allows
 * (private windows, cleared site data), instead of locking them out.
 * Resolves to the revoked device id, or null.
 */
export function revokeStalestE2eeDevice(userId) {
  if (!userId) return isPostgresMode() ? Promise.resolve(null) : null;
  const rawRow = getRow(
    dbKnex("e2ee_devices")
      .select("id")
      .where("user_id", userId)
      .whereNull("revoked_at")
      .orderBy("last_seen_at", "asc")
      .orderBy("created_at", "asc")
      .first(),
  );
  const finish = (row) => {
    if (!row?.id) return null;
    const res = revokeE2eeDevice(userId, row.id);
    if (res && typeof res.then === "function") return res.then(() => row.id);
    return row.id;
  };
  if (rawRow && typeof rawRow.then === "function") return rawRow.then(finish);
  return finish(rawRow);
}

/** True when `userId` has authored at least one message in `chatId`. */
export function userHasMessageInChat(chatId, userId) {
  if (!chatId || !userId) return isPostgresMode() ? Promise.resolve(false) : false;
  const row = getRow(
    dbKnex("chat_messages")
      .select("id")
      .where({ chat_id: chatId, user_id: userId })
      .first(),
  );
  if (row && typeof row.then === "function") return row.then((r) => Boolean(r));
  return Boolean(row);
}

export function listE2eeDevicesByUserIds(userIds = []) {
  const ids = Array.from(
    new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean)),
  );
  if (!ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("e2ee_devices")
      .select(E2EE_DEVICE_COLUMNS)
      .whereIn("user_id", ids)
      .whereNull("revoked_at")
      .orderBy("created_at", "asc"),
  );
}

export function setMessageE2eeEnvelope(messageId, envelopeJson) {
  if (!messageId) return isPostgresMode() ? Promise.resolve(0) : 0;
  return run(
    dbKnex("chat_messages")
      .where("id", messageId)
      .update({ e2ee_envelope: envelopeJson || null }),
  );
}

export function listMutedUserIdsForChat(chatId) {
  if (!chatId) return isPostgresMode() ? Promise.resolve([]) : [];
  const rawRows = getAll(
    dbKnex("chat_mutes")
      .select("user_id")
      .where({ chat_id: chatId, muted: 1 }),
  );
  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then((rows) =>
      (rows || [])
        .map((row) => row?.user_id)
        .filter(Boolean),
    );
  }
  return (rawRows || [])
    .map((row) => row?.user_id)
    .filter(Boolean);
}

export function createSession(userId, token) {
  if (!userId || !token) {
    const err = new Error(`Invalid session parameters: userId=${userId}, token=${token}`);
    return isPostgresMode() ? Promise.reject(err) : (() => { throw err; })();
  }
  return run(
    dbKnex("sessions").insert({ user_id: userId, token }),
  );
}

export function getSession(token) {
  if (!token) return isPostgresMode() ? Promise.resolve(null) : null;
  return getRow(
    dbKnex("sessions")
      .select(
        "sessions.id as session_id", "sessions.token", "users.id", "users.username", "users.nickname",
        "users.avatar_url", "users.color", "users.status", "users.banned", "users.role", "users.verified",
      )
      .join("users", "users.id", "sessions.user_id")
      .where("sessions.token", token)
      .andWhere(dbKnex.raw("COALESCE(users.banned, 0) = 0"))
      .first(),
  );
}

export function touchSession(token) {
  if (!token) return isPostgresMode() ? Promise.resolve() : undefined;
  return run(
    dbKnex("sessions")
      .where("token", token)
      .update({ last_seen: dbKnex.raw("datetime('now')") }),
  );
}

export function deleteSession(token) {
  if (!token) return isPostgresMode() ? Promise.resolve() : undefined;
  return run(
    dbKnex("sessions")
      .where("token", token)
      .del(),
  );
}

// Internal admin helpers for server-side DB tooling endpoints.
export function adminGetRow(sql, params = []) {
  return getRow(sql, params);
}

export function adminGetAll(sql, params = []) {
  return getAll(sql, params);
}

export function adminRun(sql, params = []) {
  return runWithoutSave(sql, params);
}

export function adminSave() {
  saveDatabase();
}

export async function adminTransaction(callback) {
  if (isPostgresMode()) {
    return dbKnex.transaction(async (trx) => {
      const queryRun = (sql, params = []) => {
        const { sql: normalizedSql, params: normalizedParams } =
          normalizeSqlForPostgres(sql, params);
        return trx.raw(normalizedSql, normalizedParams);
      };
      return callback(queryRun);
    });
  }

  run("BEGIN");
  try {
    const result = await callback((sql, params = []) => runWithoutSave(sql, params));
    run("COMMIT");
    return result;
  } catch (error) {
    run("ROLLBACK");
    throw error;
  }
}

// ─── Admin Panel ─────────────────────────────────────────────────────────────

export function setUserRole(userId, role) {
  return run(dbKnex("users").where({ id: userId }).update({ role }));
}

export async function getUserRole(userId) {
  const row = await getRow(dbKnex("users").where({ id: userId }).select("role").first());
  return row?.role || "user";
}

export async function isUserAdmin(userId) {
  const role = await getUserRole(userId);
  return role === "admin" || role === "owner";
}

export async function isUserOwner(userId) {
  const role = await getUserRole(userId);
  return role === "owner";
}

export async function getOwnerUser() {
  const row = await getRow(dbKnex("users").where({ role: "owner" }).select("id", "username").first());
  return row || null;
}

export async function bootstrapAdminUsers(adminUsernames) {
  if (!adminUsernames || !adminUsernames.length) return;
  for (const username of adminUsernames) {
    const rawUser = getRow(dbKnex("users").where({ username: username.toLowerCase() }).select("id", "role").first());
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;
    if (user && user.id && user.role !== "admin" && user.role !== "owner") {
      await run(dbKnex("users").where({ id: user.id }).update({ role: "admin" }));
    }
  }
}

export async function getAdminStats() {
  // Batch user counts: one pass over the users table instead of four separate queries.
  const userStats = (await getRow(
    dbKnex("users").select(
      dbKnex.raw('COUNT(*) AS "totalUsers"'),
      dbKnex.raw('COUNT(*) FILTER (WHERE banned = 1) AS "bannedUsers"'),
      dbKnex.raw('COUNT(*) FILTER (WHERE created_at >= datetime(\'now\', \'-7 days\')) AS "newUsers7d"'),
      dbKnex.raw('COUNT(*) FILTER (WHERE status = \'online\') AS "onlineUsers"')
    )
  )) || {};

  // Batch chat counts: one pass over the chats table instead of five queries.
  const chatStats = (await getRow(
    dbKnex("chats").select(
      dbKnex.raw('COUNT(*) FILTER (WHERE type IN (\'group\', \'channel\')) AS "totalChats"'),
      dbKnex.raw('COUNT(*) FILTER (WHERE type = \'dm\') AS "dmChats"'),
      dbKnex.raw('COUNT(*) FILTER (WHERE type = \'group\') AS "groupChats"'),
      dbKnex.raw('COUNT(*) FILTER (WHERE type = \'channel\') AS "channelChats"')
    )
  )) || {};

  // Batch message counts: one pass over chat_messages instead of two queries.
  const messageStats = (await getRow(
    dbKnex("chat_messages").select(
      dbKnex.raw('COUNT(*) AS "totalMessages"'),
      dbKnex.raw('COUNT(*) FILTER (WHERE created_at >= datetime(\'now\', \'-1 day\')) AS "messagesLast24h"')
    )
  )) || {};

  const totalSessions = (await getRow(dbKnex("sessions").count({ count: "*" }).first()))?.count || 0;

  // Optional tables that may not exist on older schemas — keep as individual
  // try/catch singletons so a missing table never aborts the whole stats call.
  let totalFiles = 0;
  try { totalFiles = (await getRow(dbKnex("chat_message_files").count({ count: "*" }).first()))?.count || 0; } catch { totalFiles = 0; }
  let pushSubscriptions = 0;
  try { pushSubscriptions = (await getRow(dbKnex("push_subscriptions").count({ count: "*" }).first()))?.count || 0; } catch { pushSubscriptions = 0; }

  return {
    totalUsers:     Number(userStats.totalUsers    || 0),
    bannedUsers:    Number(userStats.bannedUsers   || 0),
    newUsers7d:     Number(userStats.newUsers7d    || 0),
    onlineUsers:    Number(userStats.onlineUsers   || 0),
    totalChats:     Number(chatStats.totalChats    || 0),
    dmChats:        Number(chatStats.dmChats       || 0),
    groupChats:     Number(chatStats.groupChats    || 0),
    channelChats:   Number(chatStats.channelChats  || 0),
    totalMessages:  Number(messageStats.totalMessages  || 0),
    messagesLast24h:Number(messageStats.messagesLast24h || 0),
    totalSessions:  Number(totalSessions || 0),
    totalFiles:     Number(totalFiles || 0),
    pushSubscriptions: Number(pushSubscriptions || 0),
  };
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Produces an ORDER BY clause fragment for a "natural sort" on a text column:
// sorts by the text prefix first (everything before any trailing number),
// then the trailing integer numerically (so "User 2" < "User 10"),
// then falls back to `tiebreaker` for rows with identical values.
// `dir` ("ASC"/"DESC") is applied to every term so reversing actually reverses.
function naturalSortExpr(col, tiebreaker = null, dir = "ASC") {
  const d = dir === "DESC" ? "DESC" : "ASC";
  // RTRIM strips all trailing digit characters to give the text prefix.
  const textPart = `RTRIM(${col},'0123456789') COLLATE NOCASE ${d}`;
  // SUBSTR from the end of the text prefix onward, cast to integer.
  const numPart  = `CAST(SUBSTR(${col}, length(RTRIM(${col},'0123456789'))+1) AS INTEGER) ${d}`;
  const parts = [textPart, numPart];
  if (tiebreaker) parts.push(`${tiebreaker} COLLATE NOCASE ${d}`);
  return parts.join(", ");
}


export function adminListUsers({ limit = 200, offset = 0, search = "", sortBy = "id", sortDir = "DESC", roleFilter = null, statusFilter = null, verifiedFilter = null, connectedUsernames = null }) {
  const safeLimit  = Math.max(1, Math.min(500, Number(limit) || 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeSortBy  = ["id", "username", "nickname", "role", "created_at", "last_seen"].includes(sortBy) ? sortBy : "id";
  const safeSortDir = sortDir === "ASC" ? "ASC" : "DESC";

  let qb = dbKnex("users").select(
    "id", "username", "nickname", "avatar_url", "color", "status", "role", "banned", "verified", "created_at", "last_seen",
    dbKnex.raw("CASE WHEN status = 'online' THEN 1 ELSE 0 END AS online"),
    dbKnex.raw("COUNT(*) OVER() AS _total")
  );

  if (search) {
    const like = `%${escapeLikePattern(search)}%`;
    qb = qb.where((builder) => {
      builder.whereRaw("username LIKE ? ESCAPE '\\'", [like])
        .orWhereRaw("nickname LIKE ? ESCAPE '\\'", [like]);
    });
  }
  if (roleFilter === "banned") {
    qb = qb.where("banned", 1);
  } else if (roleFilter) {
    qb = qb.where("banned", 0).where("role", roleFilter);
  }

  if (statusFilter === "online") {
    qb = qb.where(function () {
      this.where("status", "online").orWhereNull("status").orWhere("status", "!=", "invisible");
    });
    if (Array.isArray(connectedUsernames)) {
      const lowerConnected = connectedUsernames.map((u) => String(u).toLowerCase()).filter(Boolean);
      if (lowerConnected.length === 0) {
        qb = qb.whereRaw("1 = 0");
      } else {
        qb = qb.whereIn(dbKnex.raw("LOWER(username)"), lowerConnected);
      }
    }
  } else if (statusFilter === "offline") {
    if (Array.isArray(connectedUsernames)) {
      const lowerConnected = connectedUsernames.map((u) => String(u).toLowerCase()).filter(Boolean);
      if (lowerConnected.length > 0) {
        qb = qb.where(function () {
          this.whereNotIn(dbKnex.raw("LOWER(username)"), lowerConnected).orWhere("status", "invisible");
        });
      }
    } else {
      qb = qb.where("status", "invisible");
    }
  }

  if (verifiedFilter === "1" || verifiedFilter === "true") {
    qb = qb.where("verified", 1);
  } else if (verifiedFilter === "0" || verifiedFilter === "false") {
    qb = qb.where(function () {
      this.where("verified", 0).orWhereNull("verified");
    });
  }

  if (safeSortBy === "nickname") {
    qb = qb.orderByRaw(naturalSortExpr("nickname", "username", safeSortDir));
  } else if (safeSortBy === "username") {
    qb = qb.orderByRaw(naturalSortExpr("username", "nickname", safeSortDir));
  } else {
    qb = qb.orderBy(safeSortBy, safeSortDir);
  }

  qb = qb.limit(safeLimit).offset(safeOffset);

  const rawRows = getAll(qb);

  const processUserRows = (rows) => {
    const list = rows || [];
    const total = list.length > 0 ? Number(list[0]._total || 0) : 0;
    const users = list.map(({ _total, ...u }) => u);
    return { users, total };
  };

  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then(processUserRows);
  }
  return processUserRows(rawRows);
}

// adminCountUsers is kept for any future callers that only need the count,
// but the list endpoint now uses adminListUsers which returns both together.
export function adminCountUsers({ search = "", roleFilter = null, statusFilter = null, verifiedFilter = null, connectedUsernames = null } = {}) {
  let qb = dbKnex("users").count({ count: "*" });

  if (search) {
    const like = `%${escapeLikePattern(search)}%`;
    qb = qb.where((builder) => {
      builder.whereRaw("username LIKE ? ESCAPE '\\'", [like])
        .orWhereRaw("nickname LIKE ? ESCAPE '\\'", [like]);
    });
  }
  if (roleFilter === "banned") {
    qb = qb.where("banned", 1);
  } else if (roleFilter) {
    qb = qb.where("banned", 0).where("role", roleFilter);
  }

  if (statusFilter === "online") {
    qb = qb.where(function () {
      this.where("status", "online").orWhereNull("status").orWhere("status", "!=", "invisible");
    });
    if (Array.isArray(connectedUsernames)) {
      const lowerConnected = connectedUsernames.map((u) => String(u).toLowerCase()).filter(Boolean);
      if (lowerConnected.length === 0) {
        qb = qb.whereRaw("1 = 0");
      } else {
        qb = qb.whereIn(dbKnex.raw("LOWER(username)"), lowerConnected);
      }
    }
  } else if (statusFilter === "offline") {
    if (Array.isArray(connectedUsernames)) {
      const lowerConnected = connectedUsernames.map((u) => String(u).toLowerCase()).filter(Boolean);
      if (lowerConnected.length > 0) {
        qb = qb.where(function () {
          this.whereNotIn(dbKnex.raw("LOWER(username)"), lowerConnected).orWhere("status", "invisible");
        });
      }
    } else {
      qb = qb.where("status", "invisible");
    }
  }

  if (verifiedFilter === "1" || verifiedFilter === "true") {
    qb = qb.where("verified", 1);
  } else if (verifiedFilter === "0" || verifiedFilter === "false") {
    qb = qb.where(function () {
      this.where("verified", 0).orWhereNull("verified");
    });
  }

  const rawRow = getRow(qb.first());
  if (rawRow && typeof rawRow.then === "function") {
    return rawRow.then((row) => Number(row?.count || 0));
  }
  return Number(rawRow?.count || 0);
}

export function adminListChats({
  limit = 200,
  offset = 0,
  search = "",
  sortBy = "id",
  sortDir = "DESC",
  typeFilter = null,
  visibilityFilter = null,
  verifiedFilter = null,
  autoAddFilter = null,
  remoteFilter = null,
}) {
  const safeLimit  = Math.max(1, Math.min(500, Number(limit) || 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeSortBy  = ["id", "name", "type", "group_visibility", "created_at", "member_count", "message_count"].includes(sortBy) ? sortBy : "id";
  const safeSortDir = sortDir === "ASC" ? "ASC" : "DESC";

  let qb = dbKnex("chats as c")
    .leftJoin("users as owner", "owner.id", dbKnex.raw("(SELECT user_id FROM chat_members WHERE chat_id = c.id AND role = 'owner' LIMIT 1)"))
    .leftJoin("remote_channel_sources as rcs", "rcs.chat_id", "c.id")
    .select(
      "c.id", "c.name", "c.type", "c.group_username", "c.group_visibility", "c.group_color", "c.group_avatar_url", "c.created_at", "c.verified", "c.auto_add_new_users",
      dbKnex.raw("(SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) AS member_count"),
      dbKnex.raw("(SELECT COUNT(*) FROM chat_messages WHERE chat_id = c.id) AS message_count"),
      "owner.id as owner_id", "owner.username as owner_username", "owner.nickname as owner_nickname",
      "owner.avatar_url as owner_avatar_url", "owner.color as owner_color",
      "owner.verified as owner_verified", "owner.role as owner_role",
      "rcs.enabled as remote_enabled", "rcs.paused as remote_paused",
      dbKnex.raw("COUNT(*) OVER() AS _total")
    )
    .whereIn("c.type", ["group", "channel"]);

  if (search) {
    const like = `%${escapeLikePattern(search)}%`;
    qb = qb.where((builder) => {
      builder.whereRaw("c.name LIKE ? ESCAPE '\\'", [like])
        .orWhereRaw("c.group_username LIKE ? ESCAPE '\\'", [like]);
    });
  }
  if (typeFilter === "group" || typeFilter === "channel") {
    qb = qb.where("c.type", typeFilter);
  }
  if (visibilityFilter === "public" || visibilityFilter === "private") {
    qb = qb.where("c.group_visibility", visibilityFilter);
  }
  if (verifiedFilter === "1" || verifiedFilter === "true") {
    qb = qb.where("c.verified", 1);
  } else if (verifiedFilter === "0" || verifiedFilter === "false") {
    qb = qb.where(function () { this.where("c.verified", 0).orWhereNull("c.verified"); });
  }
  if (autoAddFilter === "1" || autoAddFilter === "true") {
    qb = qb.where("c.auto_add_new_users", 1);
  } else if (autoAddFilter === "0" || autoAddFilter === "false") {
    qb = qb.where(function () { this.where("c.auto_add_new_users", 0).orWhereNull("c.auto_add_new_users"); });
  }
  if (remoteFilter === "active") {
    qb = qb.where("rcs.enabled", 1).where(function () { this.where("rcs.paused", 0).orWhereNull("rcs.paused"); });
  } else if (remoteFilter === "paused") {
    qb = qb.where("rcs.enabled", 1).where("rcs.paused", 1);
  } else if (remoteFilter === "disabled") {
    qb = qb.where("rcs.enabled", 0);
  } else if (remoteFilter === "none") {
    qb = qb.whereNull("rcs.id");
  }

  const countCols = ["member_count", "message_count"];
  if (countCols.includes(safeSortBy)) {
    qb = qb.orderBy(safeSortBy, safeSortDir);
  } else if (safeSortBy === "name") {
    qb = qb.orderByRaw(naturalSortExpr("c.name", "c.group_username", safeSortDir));
  } else if (safeSortBy === "type" || safeSortBy === "group_visibility") {
    qb = qb.orderByRaw(`c.${safeSortBy} COLLATE NOCASE ${safeSortDir}`);
  } else {
    qb = qb.orderBy(`c.${safeSortBy}`, safeSortDir);
  }

  qb = qb.limit(safeLimit).offset(safeOffset);

  const rawRows = getAll(qb);
  const processChatRows = (rows) => {
    const list = rows || [];
    const total = list.length > 0 ? Number(list[0]._total || 0) : 0;
    const chats = list.map(({ _total, ...chat }) => chat);
    return { chats, total };
  };
  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then(processChatRows);
  }
  return processChatRows(rawRows);
}

// adminCountChats is kept for any future callers that only need the count,
// but the list endpoint now uses adminListChats which returns both together.
export function adminCountChats({
  search = "",
  typeFilter = null,
  visibilityFilter = null,
  verifiedFilter = null,
  autoAddFilter = null,
  remoteFilter = null,
} = {}) {
  let qb = dbKnex("chats as c")
    .leftJoin("remote_channel_sources as rcs", "rcs.chat_id", "c.id")
    .count({ count: "*" })
    .whereIn("c.type", ["group", "channel"]);

  if (search) {
    const like = `%${escapeLikePattern(search)}%`;
    qb = qb.where((builder) => {
      builder.whereRaw("c.name LIKE ? ESCAPE '\\'", [like])
        .orWhereRaw("c.group_username LIKE ? ESCAPE '\\'", [like]);
    });
  }
  if (typeFilter === "group" || typeFilter === "channel") {
    qb = qb.where("c.type", typeFilter);
  }
  if (visibilityFilter === "public" || visibilityFilter === "private") {
    qb = qb.where("c.group_visibility", visibilityFilter);
  }
  if (verifiedFilter === "1" || verifiedFilter === "true") {
    qb = qb.where("c.verified", 1);
  } else if (verifiedFilter === "0" || verifiedFilter === "false") {
    qb = qb.where(function () { this.where("c.verified", 0).orWhereNull("c.verified"); });
  }
  if (autoAddFilter === "1" || autoAddFilter === "true") {
    qb = qb.where("c.auto_add_new_users", 1);
  } else if (autoAddFilter === "0" || autoAddFilter === "false") {
    qb = qb.where(function () { this.where("c.auto_add_new_users", 0).orWhereNull("c.auto_add_new_users"); });
  }
  if (remoteFilter === "active") {
    qb = qb.where("rcs.enabled", 1).where(function () { this.where("rcs.paused", 0).orWhereNull("rcs.paused"); });
  } else if (remoteFilter === "paused") {
    qb = qb.where("rcs.enabled", 1).where("rcs.paused", 1);
  } else if (remoteFilter === "disabled") {
    qb = qb.where("rcs.enabled", 0);
  } else if (remoteFilter === "none") {
    qb = qb.whereNull("rcs.id");
  }

  const rawRow = getRow(qb.first());
  if (rawRow && typeof rawRow.then === "function") {
    return rawRow.then((row) => Number(row?.count || 0));
  }
  return Number(rawRow?.count || 0);
}

export function adminBanUser(userId, banned) {
  return run(dbKnex("users").where({ id: userId }).update({ banned: banned ? 1 : 0 }));
}

// Delegate to the canonical deletion helpers so the admin panel performs the
// same full cleanup (message files, reads, hidden chats, mutes, ownership
// transfers, etc.) inside a transaction. Returns the storedNames of orphaned
// upload files so the caller can remove them from disk.
export function adminDeleteUser(userId) {
  return deleteUserById(userId);
}

export function adminDeleteChat(chatId) {
  return deleteChatById(chatId);
}

// ─── Admin Audit Logs (DB-backed, survives ephemeral disks) ───────────────────

function serializeAuditDetails(details) {
  if (details === undefined || details === null) return null;
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function mapAuditRow(row) {
  if (!row) return row;
  const { _total, ...rest } = row;
  return {
    ts: rest.ts ?? null,
    actorUserId: rest.actor_user_id ?? null,
    actorUsername: rest.actor_username ?? null,
    action: rest.action ?? "",
    targetType: rest.target_type ?? null,
    targetLabel: rest.target_label ?? null,
    details: rest.details ?? null,
    status: rest.status ?? "success",
  };
}

// Append a single admin action. Logging must never break the request flow,
// so write failures resolve silently instead of rejecting/throwing.
export function writeAdminAuditLog({
  ts = null,
  actorUserId = null,
  actorUsername = null,
  action,
  targetType = null,
  targetLabel = null,
  details = null,
  status = "success",
} = {}) {
  const entry = {
    ts: ts || new Date().toISOString(),
    actor_user_id: actorUserId ?? null,
    actor_username: actorUsername ?? null,
    action: String(action || ""),
    target_type: targetType ?? null,
    target_label: targetLabel ?? null,
    details: serializeAuditDetails(details),
    status: status ?? "success",
  };
  try {
    const result = run(dbKnex("admin_audit_logs").insert(entry));
    if (result && typeof result.catch === "function") {
      return result.catch(() => {});
    }
    return result;
  } catch {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
}

function applyAuditLogSearch(qb, search) {
  const needle = String(search || "").trim();
  if (!needle) return qb;
  const like = `%${escapeLikePattern(needle)}%`;
  return qb.where((builder) => {
    builder
      .whereRaw("actor_username LIKE ? ESCAPE '\\'", [like])
      .orWhereRaw("action LIKE ? ESCAPE '\\'", [like])
      .orWhereRaw("target_label LIKE ? ESCAPE '\\'", [like])
      .orWhereRaw("details LIKE ? ESCAPE '\\'", [like]);
  });
}

export function readAdminAuditLogs({ limit = 200, offset = 0, search = "" } = {}) {
  const safeLimit = Math.max(1, Number(limit) || 200);
  const safeOffset = Math.max(0, Number(offset) || 0);
  let qb = dbKnex("admin_audit_logs").select(
    "ts",
    "actor_user_id",
    "actor_username",
    "action",
    "target_type",
    "target_label",
    "details",
    "status",
    dbKnex.raw("COUNT(*) OVER() AS _total"),
  );
  qb = applyAuditLogSearch(qb, search);
  qb = qb.orderBy("id", "desc").limit(safeLimit).offset(safeOffset);
  const rawRows = getAll(qb);
  const processRows = (rows) => {
    const list = rows || [];
    const total = list.length > 0 ? Number(list[0]._total || 0) : 0;
    return { entries: list.map(mapAuditRow), total };
  };
  if (rawRows && typeof rawRows.then === "function") {
    return rawRows.then(processRows).catch(() => ({ entries: [], total: 0 }));
  }
  try {
    return processRows(rawRows);
  } catch {
    return { entries: [], total: 0 };
  }
}

export function clearAdminAuditLogs() {
  try {
    return run(dbKnex("admin_audit_logs").del());
  } catch {
    return isPostgresMode() ? Promise.resolve() : undefined;
  }
}

// ─── Saved GIFs ──────────────────────────────────────────────────────────────
//
// `user_gifs` is one person's private collection. Every query below names the
// owner; a GIF of somebody else is simply not found. The oldest GIFs (by
// created_at) make room when a person is over their limit.

// Saved GIFs are evicted oldest first, so their timestamps must be strictly
// increasing even when two land in the same millisecond.
let lastSavedGifTimestampMs = 0;
function nextSavedGifTimestamp() {
  const now = Date.now();
  lastSavedGifTimestampMs = now > lastSavedGifTimestampMs ? now : lastSavedGifTimestampMs + 1;
  return new Date(lastSavedGifTimestampMs).toISOString();
}

const SAVED_GIF_COLUMNS = [
  "id",
  "user_id",
  "storage_key",
  "storage_driver",
  "mime",
  "width",
  "height",
  "frames",
  "size_bytes",
  "sha256",
  "created_at",
  "source_message_id",
  "source_file_id",
];

const savedGifLockKey = (userId) => `saved-gifs:${userId}`;

const isUniqueViolation = (error) =>
  error?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
  error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
  error?.code === "23505" ||
  /UNIQUE constraint failed/i.test(String(error?.message || ""));

/** The person's GIFs, newest first. */
export function listSavedGifs(userId) {
  if (!userId) return isPostgresMode() ? Promise.resolve([]) : [];
  return getAll(
    dbKnex("user_gifs")
      .select(SAVED_GIF_COLUMNS)
      .where("user_id", userId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc"),
  );
}

/** How many GIFs the person has. */
export function countSavedGifs(userId) {
  if (!userId) return isPostgresMode() ? Promise.resolve(0) : 0;
  const row = getRow(dbKnex("user_gifs").where("user_id", userId).count({ n: "*" }).first());
  if (row && typeof row.then === "function") return row.then((r) => Number(r?.n) || 0);
  return Number(row?.n) || 0;
}

/** One of the person's own GIFs, or null (also for a GIF that belongs to somebody else). */
export function findSavedGif(userId, gifId) {
  if (!userId || !gifId) return isPostgresMode() ? Promise.resolve(null) : null;
  return getRow(
    dbKnex("user_gifs").select(SAVED_GIF_COLUMNS).where({ user_id: userId, id: gifId }).first(),
  );
}

/** The person's GIF that was saved from this message file, or null. */
export function findSavedGifBySource(userId, messageId, fileId) {
  if (!userId || !messageId || fileId === null || fileId === undefined) {
    return isPostgresMode() ? Promise.resolve(null) : null;
  }
  return getRow(
    dbKnex("user_gifs")
      .select(SAVED_GIF_COLUMNS)
      .where({ user_id: userId, source_message_id: messageId, source_file_id: String(fileId) })
      .first(),
  );
}

/** The person's GIF with exactly these bytes (SHA-256, hex), or null. */
export function findSavedGifByHash(userId, sha256) {
  if (!userId || !sha256) return isPostgresMode() ? Promise.resolve(null) : null;
  return getRow(
    dbKnex("user_gifs").select(SAVED_GIF_COLUMNS).where({ user_id: userId, sha256 }).first(),
  );
}

function buildSavedGifRow(args) {
  return {
    id: args.id,
    user_id: args.userId,
    storage_key: args.storageKey,
    storage_driver: args.storageDriver || "local",
    mime: args.mime,
    width: Number.isFinite(Number(args.width)) ? Math.trunc(Number(args.width)) : null,
    height: Number.isFinite(Number(args.height)) ? Math.trunc(Number(args.height)) : null,
    frames: Number.isFinite(Number(args.frames)) ? Math.trunc(Number(args.frames)) : null,
    size_bytes: Math.max(0, Math.trunc(Number(args.sizeBytes)) || 0),
    sha256: args.sha256,
    created_at: nextSavedGifTimestamp(),
    source_message_id: args.sourceMessageId || null,
    source_file_id:
      args.sourceFileId === null || args.sourceFileId === undefined ? null : String(args.sourceFileId),
  };
}

function insertSavedGifSqlite(args, limit) {
  return sqliteWriteTransaction("saved_gif", () => {
    const duplicate = getRow(
      dbKnex("user_gifs")
        .select(SAVED_GIF_COLUMNS)
        .where({ user_id: args.userId, sha256: args.sha256 })
        .first(),
    );
    const rows = getAll(
      dbKnex("user_gifs")
        .select("id", "user_id", "storage_key", "storage_driver", "created_at")
        .where("user_id", args.userId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc"),
    );
    if (duplicate) return { status: "existing", gif: duplicate, evicted: [], count: rows.length };

    const evicted = rows.slice(0, Math.max(0, rows.length + 1 - limit));
    if (evicted.length) {
      run(
        dbKnex("user_gifs")
          .where("user_id", args.userId)
          .whereIn("id", evicted.map((row) => row.id))
          .del(),
      );
    }
    const row = buildSavedGifRow(args);
    run(dbKnex("user_gifs").insert(row));
    return { status: "created", gif: row, evicted, count: rows.length - evicted.length + 1 };
  });
}

async function insertSavedGifPostgres(args, limit) {
  return dbKnex.transaction(async (trx) => {
    // One change at a time per person, so two quick requests cannot both pass
    // the "room left" check and leave the person over their limit.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [savedGifLockKey(args.userId)]);
    const duplicate = await trx("user_gifs")
      .select(SAVED_GIF_COLUMNS)
      .where({ user_id: args.userId, sha256: args.sha256 })
      .first();
    const rows = await trx("user_gifs")
      .select("id", "user_id", "storage_key", "storage_driver", "created_at")
      .where("user_id", args.userId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");
    if (duplicate) return { status: "existing", gif: duplicate, evicted: [], count: rows.length };

    const evicted = rows.slice(0, Math.max(0, rows.length + 1 - limit));
    if (evicted.length) {
      await trx("user_gifs")
        .where("user_id", args.userId)
        .whereIn("id", evicted.map((row) => row.id))
        .del();
    }
    const row = buildSavedGifRow(args);
    await trx("user_gifs").insert(row);
    return { status: "created", gif: row, evicted, count: rows.length - evicted.length + 1 };
  });
}

/**
 * Adds a GIF to the person's collection, atomically. If they already hold
 * `limit` GIFs, the oldest ones are deleted in the same transaction to make
 * room (all of them, if the limit was lowered since).
 *
 * `args`: { id, userId, storageKey, storageDriver, mime, width, height, frames,
 * sizeBytes, sha256, sourceMessageId, sourceFileId, limit }.
 *
 * Resolves to { status, gif, evicted, count }:
 *   "created"   `gif` is the new row; `evicted` the rows that were deleted (the
 *               caller deletes their files); `count` how many the person has now
 *   "existing"  the person already holds these exact bytes: `gif` is that row,
 *               nothing was stored or evicted
 */
export async function insertSavedGif(args) {
  const limit = Math.max(1, Math.trunc(Number(args?.limit)) || 1);
  const run_ = () =>
    isPostgresMode() ? insertSavedGifPostgres(args, limit) : insertSavedGifSqlite(args, limit);
  try {
    return await run_();
  } catch (error) {
    // Two requests with the same bytes raced past the duplicate check: the
    // unique index let one in, the other now finds it.
    if (isUniqueViolation(error)) {
      const existing = await findSavedGifByHash(args.userId, args.sha256);
      if (existing) {
        return { status: "existing", gif: existing, evicted: [], count: await countSavedGifs(args.userId) };
      }
    }
    throw error;
  }
}

/**
 * Deletes one of the person's own GIFs. Resolves to the deleted row, or null if
 * they had no such GIF (or another request deleted it first), so a file is
 * removed, and the person told, exactly once.
 */
export async function deleteSavedGif(userId, gifId) {
  if (!userId || !gifId) return null;
  const row = await findSavedGif(userId, gifId);
  if (!row) return null;
  const deleted = await run(dbKnex("user_gifs").where({ user_id: userId, id: gifId }).del());
  return Number(deleted) > 0 ? row : null;
}

/** Every saved GIF's file, for the full resets that wipe all accounts. */
export function listAllSavedGifs() {
  return getAll(dbKnex("user_gifs").select("id", "user_id", "storage_key", "storage_driver"));
}

/** The GIFs of several people, for the bulk tools that delete accounts and must delete their files. */
export function listSavedGifsForUsers(userIds = []) {
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean)));
  if (!ids.length) return isPostgresMode() ? Promise.resolve([]) : [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  const query = (chunk) =>
    getAll(dbKnex("user_gifs").select(SAVED_GIF_COLUMNS).whereIn("user_id", chunk));
  if (isPostgresMode()) {
    return Promise.all(chunks.map(query)).then((parts) => parts.flat());
  }
  return chunks.flatMap(query);
}

// ─── Admin Maintenance ─────────────────────────────────────────────────────────

export async function vacuumDatabase() {
  await run("VACUUM");
  saveDatabase();
}

export function reloadDatabase() {
  reloadDatabaseFromDisk();
}

// Wipe all messages and their file records (keeps users, chats, memberships).
// Returns the storedNames of files to remove from disk.
export async function adminClearAllMessages() {
  if (isPostgresMode()) {
    return dbKnex.transaction(async (trx) => {
      const fileResult = await trx("chat_message_files").select("stored_name");
      const storedNames = getPostgresRows(fileResult)
        .map((row) => row.stored_name)
        .filter(Boolean);
      await trx("message_reactions").del();
      await trx("chat_pinned_messages").del();
      await trx("chat_message_reads").del();
      await trx("hidden_chat_messages").del();
      await trx("chat_message_files").del();
      await trx("chat_messages").del();
      return { storedNames };
    });
  }

  const fileRows = getAll(dbKnex("chat_message_files").select("stored_name"));
  const storedNames = fileRows.map((row) => row.stored_name).filter(Boolean);
  run("BEGIN");
  try {
    run(dbKnex("message_reactions").del());
    run(dbKnex("chat_pinned_messages").del());
    run(dbKnex("chat_message_reads").del());
    run(dbKnex("hidden_chat_messages").del());
    run(dbKnex("chat_message_files").del());
    run(dbKnex("chat_messages").del());
    run("COMMIT");
  } catch (error) {
    run("ROLLBACK");
    throw error;
  }
  saveDatabase();
  return { storedNames };
}

const RESET_TABLES = [
  "user_gifs",
  "chat_pins",
  "chat_pinned_messages",
  "message_reactions",
  "chat_message_reads",
  "hidden_chat_messages",
  "chat_message_files",
  "chat_messages",
  "hidden_chats",
  "chat_mutes",
  "chat_members",
  "chat_left_members",
  "group_removed_members",
  "remote_channel_queue",
  "remote_channel_sources",
  "remote_channel_provider_state",
  "push_subscriptions",
  "e2ee_devices",
  "sessions",
  "chats",
  "users",
];

// Full reset: wipe all user-generated data (users, chats, messages, sessions).
// Schema and runtime settings are preserved. Returns storedNames for disk cleanup.
export async function adminResetDatabase() {
  if (isPostgresMode()) {
    return dbKnex.transaction(async (trx) => {
      const fileResult = await trx("chat_message_files").select("stored_name");
      const storedNames = getPostgresRows(fileResult)
        .map((row) => row.stored_name)
        .filter(Boolean);
      const savedGifs = getPostgresRows(
        await trx("user_gifs").select("id", "user_id", "storage_key", "storage_driver"),
      );
      await trx.raw(`TRUNCATE TABLE ${RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
      return { storedNames, savedGifs };
    });
  }

  const fileRows = getAll(dbKnex("chat_message_files").select("stored_name"));
  const storedNames = fileRows.map((row) => row.stored_name).filter(Boolean);
  const savedGifs = getAll(
    dbKnex("user_gifs").select("id", "user_id", "storage_key", "storage_driver"),
  );
  run("BEGIN");
  try {
    RESET_TABLES.forEach((table) => run(dbKnex(table).del()));
    run("COMMIT");
  } catch (error) {
    run("ROLLBACK");
    throw error;
  }
  run("VACUUM");
  saveDatabase();
  return { storedNames, savedGifs };
}

// ─── App Settings ─────────────────────────────────────────────────────────────

export function dbGetAllSettings() {
  return getAll(dbKnex("app_settings").select("key", "value"));
}

export function dbGetSetting(key) {
  const row = getRow(
    dbKnex("app_settings").select("value").where({ key: String(key) }).first(),
  );
  if (row && typeof row.then === "function") {
    return row.then((r) => (r?.value !== undefined && r?.value !== null ? String(r.value) : null));
  }
  if (row?.value === undefined || row?.value === null) return null;
  return String(row.value);
}

export function dbSetSetting(key, value) {
  run(
    dbKnex("app_settings")
      .insert({ key: String(key), value: String(value) })
      .onConflict("key")
      .merge()
  );
}

export function dbDeleteSetting(key) {
  run(dbKnex("app_settings").where({ key: String(key) }).del());
}
