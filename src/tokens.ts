import { existsSync } from "node:fs";

// Ambient module declarations for optional SQLite backends.
// These exist so TypeScript can resolve dynamic import() expressions.
// At runtime, the actual modules may or may not be available.
declare module "bun:sqlite" {
  const Database: new (path: string, options?: { readonly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
    close(): void;
  };
  export { Database };
}
declare module "node:sqlite" {
  const DatabaseSync: new (path: string, options?: { open?: boolean; readonly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
    close(): void;
  };
  export { DatabaseSync };
}

/** Minimal interface for both node:sqlite and bun:sqlite databases */
export interface SqliteDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

/** Lazy-loaded SQLite module — initialized once on first use */
let sqliteModule: {
  open(path: string, options: { readonly: boolean }): SqliteDatabase;
} | null = null;
let sqliteModuleError: string | null = null;
let sqliteModuleLoading: Promise<{ open(path: string, options: { readonly: boolean }): SqliteDatabase } | null> | null = null;

/**
 * Attempt to load a SQLite module. Tries bun:sqlite first, then node:sqlite.
 * Returns null and sets sqliteModuleError if neither is available.
 * Uses dynamic import() instead of require() for proper ESM/CJS interop.
 * Caches the result so subsequent calls are synchronous (return from cache).
 */
async function loadSqliteModule(): Promise<{ open(path: string, options: { readonly: boolean }): SqliteDatabase } | null> {
  if (sqliteModule) return sqliteModule;
  if (sqliteModuleError) return null;
  if (sqliteModuleLoading) return sqliteModuleLoading;

  sqliteModuleLoading = (async () => {
    try {
      const bunSqlite = await import("bun:sqlite");
      sqliteModule = {
        open(path: string, options: { readonly: boolean }) {
          return new bunSqlite.Database(path, options) as SqliteDatabase;
        },
      };
      return sqliteModule;
    } catch {}

    try {
      const nodeSqlite = await import("node:sqlite");
      sqliteModule = {
        open(path: string, _options: { readonly: boolean }) {
          return new nodeSqlite.DatabaseSync(path, { open: true }) as SqliteDatabase;
        },
      };
      return sqliteModule;
    } catch {}

    sqliteModuleError = "No SQLite module available (tried bun:sqlite and node:sqlite)";
    return null;
  })();

  return sqliteModuleLoading;
}

/**
 * Warm up the SQLite module cache. Call this early (e.g., on plugin init)
 * so that subsequent getSessionTokens calls can open the DB synchronously
 * if the module is already cached. Not required — getSessionTokens will
 * call this internally if needed.
 */
export async function warmupSqlite(): Promise<void> {
  await loadSqliteModule();
}

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

interface CachedDb {
  db: SqliteDatabase;
  path: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let cachedDb: CachedDb | null = null;
const DB_IDLE_TIMEOUT_MS = 30000;

function closeCachedDb(): void {
  if (cachedDb) {
    if (cachedDb.idleTimer) clearTimeout(cachedDb.idleTimer);
    try { cachedDb.db.close(); } catch {}
    cachedDb = null;
  }
}

function resetIdleTimer(): void {
  if (!cachedDb) return;
  if (cachedDb.idleTimer) clearTimeout(cachedDb.idleTimer);
  cachedDb.idleTimer = setTimeout(() => {
    closeCachedDb();
  }, DB_IDLE_TIMEOUT_MS);
  if (cachedDb.idleTimer.unref) cachedDb.idleTimer.unref();
}

export function closeDb(): void {
  closeCachedDb();
}

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
  if (dbPath !== path) closeCachedDb();
  dbPath = path;
}

export function getDbLastError(): string {
  return dbLastError;
}

/**
 * Get session token counts from the OpenCode SQLite database.
 * Returns NO_TOKENS if the DB is unavailable or the session is not found.
 *
 * On the first call, this is async because it needs to load the SQLite module
 * via dynamic import(). Subsequent calls are synchronous (module is cached).
 * Call warmupSqlite() during plugin init to ensure the module is pre-loaded.
 */
export async function getSessionTokens(sessionId: string): Promise<SessionTokens> {
  try {
    const path = getDbPath();

    if (!existsSync(path)) {
      dbLastError = `DB not found: ${path}`;
      closeCachedDb();
      return NO_TOKENS;
    }

    if (cachedDb && cachedDb.path !== path) {
      closeCachedDb();
    }

    if (!cachedDb) {
      const mod = await loadSqliteModule();
      if (!mod) {
        dbLastError = sqliteModuleError || "No SQLite module available";
        return NO_TOKENS;
      }

      const db = mod.open(path, { readonly: true });
      cachedDb = { db, path, idleTimer: null };
    }

    resetIdleTimer();

    try {
      const row = cachedDb.db
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
    } catch (queryError: any) {
      dbLastError = queryError?.message || String(queryError);
      closeCachedDb();
      return NO_TOKENS;
    }
  } catch (e: any) {
    dbLastError = e?.message || String(e);
    closeCachedDb();
    return NO_TOKENS;
  }
}
