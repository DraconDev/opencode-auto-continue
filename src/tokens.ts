import { existsSync } from "node:fs";

import { safeUnref } from "./typed-helpers.js";

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
 * Attempt to load a SQLite module synchronously via require() (CJS environments).
 * Returns the module wrapper or null if neither is available.
 */
function tryRequireSqlite(): { open(path: string, options: { readonly: boolean }): SqliteDatabase } | null {
  // Try bun:sqlite via require
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunSqlite = require("bun:sqlite");
    return {
      open(path: string, options: { readonly: boolean }) {
        return new bunSqlite.Database(path, options) as SqliteDatabase;
      },
    };
  } catch {}

  // Try node:sqlite via require
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeSqlite = require("node:sqlite");
    return {
      open(path: string, _options: { readonly: boolean }) {
        return new nodeSqlite.DatabaseSync(path, { open: true }) as SqliteDatabase;
      },
    };
  } catch {}

  return null;
}

/**
 * Attempt to load a SQLite module. Tries require() first (CJS), then import() (ESM).
 * Returns null and sets sqliteModuleError if neither is available.
 * Caches the result so subsequent calls are synchronous (return from cache).
 */
async function loadSqliteModule(): Promise<{ open(path: string, options: { readonly: boolean }): SqliteDatabase } | null> {
  if (sqliteModule) return sqliteModule;
  if (sqliteModuleError) return null;

  // Try CJS require() first — works in Node.js / vitest CJS contexts
  const syncResult = tryRequireSqlite();
  if (syncResult) {
    sqliteModule = syncResult;
    return sqliteModule;
  }

  // Fall back to ESM dynamic import — needed for pure ESM environments
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
  safeUnref(cachedDb.idleTimer);
}

/** Close the cached SQLite database connection, releasing resources. */
export function closeDb(): void {
  closeCachedDb();
}

/** Reset the SQLite module cache (for testing only). */
export function _resetSqliteCache(): void {
  closeCachedDb();
  sqliteModule = null;
  sqliteModuleError = null;
  sqliteModuleLoading = null;
  consecutiveFailures = 0;
}

/**
 * Consecutive failure counter — tracks how many times getSessionTokens
 * returned NO_TOKENS due to a real database error (module unavailable,
 * DB open failure, or query error). Resets to 0 on any successful token read.
 * Does NOT increment on "session not found" — that's a normal lookup miss.
 *
 * Used to detect persistent SQLite failures and emit a one-time warning.
 */
let consecutiveFailures = 0;


/**
 * Threshold after which we emit a console.warn about persistent SQLite failures.
 * A warning is logged once when the threshold is first reached. The counter
 * continues to increment so the failure duration is visible in debug logs.
 */
const FAILURE_WARNING_THRESHOLD = 5;

/**
 * Record a database access failure. Increments the consecutive failure counter.
 * When the threshold is first reached, emits a one-time console.warn.
 *
 * @param reason - Brief description of the failure type (for the warning message)
 */
function recordSqliteFailure(reason: string): void {
  consecutiveFailures++;
  if (consecutiveFailures === FAILURE_WARNING_THRESHOLD) {
    console.warn(
      "[opencode-auto-continue] SQLite failure threshold reached (" +
        FAILURE_WARNING_THRESHOLD +
        " consecutive failures). " +
        "Database token tracking is unavailable — " +
        reason +
        ". " +
        "Compaction triggers may not fire. Check that OpenCode is running and the database is accessible."
    );
  }
}


/**
 * Record a successful token read. Resets the consecutive failure counter.
 * Call this before any successful return from getSessionTokens.
 */
function recordSqliteSuccess(): void {
  consecutiveFailures = 0;
}


/**
 * Get the path to the OpenCode SQLite database.
 * Resolves platform-specific default paths (macOS, Windows, Linux/XDG).
 * Can be overridden with setDbPath().
 *
 * @returns The database file path
 */
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

/**
 * Override the database path (for testing or custom installations).
 * Closes any existing DB connection if the path changes.
 *
 * @param path - The new database file path
 */
export function setDbPath(path: string): void {
  if (dbPath !== path) closeCachedDb();
  dbPath = path;
}

/**
 * Get the last error that occurred during database access.
 * Useful for diagnosing token counting failures.
 *
 * @returns The last error message string, or empty string if none
 */
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
        recordSqliteFailure(sqliteModuleError || "no SQLite module available");
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
      recordSqliteSuccess();
      return {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        cacheRead: row.tokens_cache_read,
        cacheWrite: row.tokens_cache_write,
        total,
      };
    } catch (queryError: unknown) {
      dbLastError = queryError instanceof Error ? queryError.message : String(queryError);
      closeCachedDb();
      recordSqliteFailure("query execution failed");
      return NO_TOKENS;
    }
  } catch (e: unknown) {
    dbLastError = e instanceof Error ? e.message : String(e);
    recordSqliteFailure("path check or unknown error");
    return NO_TOKENS;
  }
}
