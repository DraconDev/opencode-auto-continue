interface DatabaseSync {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

declare function require(module: "node:sqlite"): { DatabaseSync: new (path: string, options?: { open?: boolean; readonly?: boolean }) => DatabaseSync };

// Bun's SQLite API (different from node:sqlite)
interface BunSqliteDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

declare function require(module: "bun:sqlite"): { Database: new (path: string, options?: { readonly?: boolean }) => BunSqliteDb };
declare function require(module: "node:fs"): typeof import("node:fs");

export interface SessionTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const NO_TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

let dbPath: string | null = null;
let dbLastError: string = "";

export function getDbPath(): string {
  if (dbPath) return dbPath;

  const platform = process.platform;
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";

  if (platform === "darwin") {
    dbPath = `${home}/Library/Application Support/opencode/opencode.db`;
  } else if (platform === "win32") {
    const appData = process.env.APPDATA || `${home}/AppData/Roaming`;
    dbPath = `${appData}/opencode/opencode.db`;
  } else {
    const xdgData = process.env.XDG_DATA_HOME || `${home}/.local/share`;
    dbPath = `${xdgData}/opencode/opencode.db`;
  }

  return dbPath;
}

export function setDbPath(path: string): void {
  dbPath = path;
}

export function getDbLastError(): string {
  return dbLastError;
}

export function getSessionTokens(sessionId: string): SessionTokens {
  try {
    const path = getDbPath();

    const fs = require("node:fs");
    if (!fs.existsSync(path)) {
      dbLastError = `DB not found: ${path}`;
      return NO_TOKENS;
    }

    // Try Bun's SQLite first (OpenCode runs on Bun, not Node.js)
    // Then fall back to node:sqlite (available in Node 22.5+)
    let db: { prepare(sql: string): { get(...params: unknown[]): unknown }; close(): void } | null = null;
    let usingBun = false;

    try {
      const bunSqlite = require("bun:sqlite");
      db = new bunSqlite.Database(path, { readonly: true });
      usingBun = true;
    } catch {
      try {
        const { DatabaseSync } = require("node:sqlite");
        db = new DatabaseSync(path, { open: true }) as any;
      } catch {
        dbLastError = `No SQLite module available (tried bun:sqlite and node:sqlite)`;
        return NO_TOKENS;
      }
    }

    if (!db) {
      dbLastError = `Failed to open SQLite database`;
      return NO_TOKENS;
    }

    try {
      const row = db
        .prepare(
          "SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = ?"
        )
        .get(sessionId) as
        | {
            tokens_input: number;
            tokens_output: number;
            tokens_reasoning: number;
            tokens_cache_read: number;
            tokens_cache_write: number;
          }
        | undefined;

      if (!row) {
        dbLastError = `session not found: ${sessionId}`;
        return NO_TOKENS;
      }

      const total = row.tokens_input + row.tokens_output + row.tokens_reasoning;

      dbLastError = "";
      return {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        cacheRead: row.tokens_cache_read,
        cacheWrite: row.tokens_cache_write,
        total,
      };
    } finally {
      db.close();
    }
  } catch (e: any) {
    dbLastError = e?.message || String(e);
    return NO_TOKENS;
  }
}

export function getLatestMessageTokens(
  sessionId: string
): { input: number; output: number; total: number } | null {
  try {
    const path = getDbPath();

    const fs = require("node:fs");
    if (!fs.existsSync(path)) return null;

    let db: { prepare(sql: string): { get(...params: unknown[]): unknown }; close(): void } | null = null;

    try {
      const bunSqlite = require("bun:sqlite");
      db = new bunSqlite.Database(path, { readonly: true });
    } catch {
      try {
        const { DatabaseSync } = require("node:sqlite");
        db = new DatabaseSync(path, { open: true }) as any;
      } catch {
        return null;
      }
    }

    if (!db) return null;

    try {
      const row = db
        .prepare(
          "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.tokens.input') IS NOT NULL ORDER BY time_created DESC LIMIT 1"
        )
        .get(sessionId) as { data: string } | undefined;

      if (!row) return null;

      const parsed = JSON.parse(row.data);
      const tokens = parsed?.tokens;
      if (!tokens) return null;

      return {
        input: tokens.input || 0,
        output: tokens.output || 0,
        total: tokens.total || (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0),
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function getContextWindowUsage(
  sessionId: string,
  contextLimit: number
): { usedTokens: number; totalTokens: number; percent: number } | null {
  if (contextLimit <= 0) return null;

  const tokens = getSessionTokens(sessionId);
  if (tokens.total === 0) return null;

  const percent = Math.round((tokens.input / contextLimit) * 100);

  return {
    usedTokens: tokens.input,
    totalTokens: contextLimit,
    percent,
  };
}
