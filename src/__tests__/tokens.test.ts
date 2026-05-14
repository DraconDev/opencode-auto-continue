import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getSessionTokens,
  getDbPath,
  setDbPath,
  getDbLastError,
  getLatestMessageTokens,
  getContextWindowUsage,
} from "../tokens.js";
import { createSession, getTokenCount } from "../session-state.js";

const TMP_DIR = "/tmp/opencode-tokens-test";
const DB_PATH = join(TMP_DIR, "opencode.db");

function createTestDb() {
  mkdirSync(TMP_DIR, { recursive: true });

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0,
      time_updated INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER DEFAULT 0
    );
  `);

  db.prepare(
    "INSERT INTO session (id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("ses_test123", 50000, 5000, 1000, 200000, 10000, Date.now());

  db.prepare(
    "INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)"
  ).run(
    "msg_1",
    "ses_test123",
    JSON.stringify({ tokens: { input: 10000, output: 1000, reasoning: 500, total: 11500 } }),
    Date.now()
  );

  db.close();
}

function cleanupTestDb() {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}

describe("tokens module", () => {
  beforeEach(() => {
    cleanupTestDb();
    setDbPath("");
    getDbLastError();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  describe("getDbPath", () => {
    it("should return a path based on platform", () => {
      const path = getDbPath();
      expect(path).toContain("opencode.db");
      expect(path.length).toBeGreaterThan(0);
    });

    it("should cache the path", () => {
      const path1 = getDbPath();
      const path2 = getDbPath();
      expect(path1).toBe(path2);
    });
  });

  describe("setDbPath", () => {
    it("should override the auto-detected path", () => {
      setDbPath("/custom/path/opencode.db");
      expect(getDbPath()).toBe("/custom/path/opencode.db");
    });
  });

  describe("getSessionTokens", () => {
    it("should return NO_TOKENS when DB does not exist", () => {
      setDbPath("/nonexistent/path/opencode.db");
      const tokens = getSessionTokens("ses_test123");
      expect(tokens.total).toBe(0);
      expect(tokens.input).toBe(0);
      expect(getDbLastError()).toContain("DB not found");
    });

    it("should return NO_TOKENS when session not found in DB", () => {
      createTestDb();
      setDbPath(DB_PATH);
      const tokens = getSessionTokens("ses_nonexistent");
      expect(tokens.total).toBe(0);
      expect(getDbLastError()).toContain("session not found");
    });

    it("should return real token counts from SQLite", () => {
      createTestDb();
      setDbPath(DB_PATH);
      const tokens = getSessionTokens("ses_test123");
      expect(tokens.input).toBe(50000);
      expect(tokens.output).toBe(5000);
      expect(tokens.reasoning).toBe(1000);
      expect(tokens.cacheRead).toBe(200000);
      expect(tokens.cacheWrite).toBe(10000);
      expect(tokens.total).toBe(56000);
    });

    it("should clear last error on success", () => {
      createTestDb();
      setDbPath(DB_PATH);
      getSessionTokens("ses_test123");
      expect(getDbLastError()).toBe("");
    });
  });

  describe("getLatestMessageTokens", () => {
    it("should return null when DB does not exist", () => {
      setDbPath("/nonexistent/path/opencode.db");
      const result = getLatestMessageTokens("ses_test123");
      expect(result).toBeNull();
    });

    it("should return token data from latest message", () => {
      createTestDb();
      setDbPath(DB_PATH);
      const result = getLatestMessageTokens("ses_test123");
      expect(result).not.toBeNull();
      expect(result!.input).toBe(10000);
      expect(result!.output).toBe(1000);
      expect(result!.total).toBe(11500);
    });

    it("should return null when no messages with tokens", () => {
      createTestDb();
      setDbPath(DB_PATH);
      const result = getLatestMessageTokens("ses_nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getContextWindowUsage", () => {
    it("should return null when contextLimit <= 0", () => {
      createTestDb();
      setDbPath(DB_PATH);
      const result = getContextWindowUsage("ses_test123", 0);
      expect(result).toBeNull();
    });

    it("should return null when no tokens available", () => {
      setDbPath("/nonexistent/path/opencode.db");
      const result = getContextWindowUsage("ses_test123", 100000);
      expect(result).toBeNull();
    });

    it("should return usage info based on input tokens vs context limit", () => {
      createTestDb();
      setDbPath(DB_PATH);
      const result = getContextWindowUsage("ses_test123", 200000);
      expect(result).not.toBeNull();
      expect(result!.usedTokens).toBe(50000);
      expect(result!.totalTokens).toBe(200000);
      expect(result!.percent).toBe(25);
    });
  });

  describe("getTokenCount", () => {
    it("should return realTokens when > 0", () => {
      const s = createSession();
      s.realTokens = 75000;
      s.estimatedTokens = 50000;
      expect(getTokenCount(s)).toBe(75000);
    });

    it("should fall back to estimatedTokens when realTokens is 0", () => {
      const s = createSession();
      s.realTokens = 0;
      s.estimatedTokens = 50000;
      expect(getTokenCount(s)).toBe(50000);
    });

    it("should return 0 when both are 0", () => {
      const s = createSession();
      expect(getTokenCount(s)).toBe(0);
    });
  });
});
