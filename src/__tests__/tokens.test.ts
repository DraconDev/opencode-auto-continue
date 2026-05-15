import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getSessionTokens,
  getDbPath,
  setDbPath,
  getDbLastError,
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
  `);

  db.prepare(
    "INSERT INTO session (id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("ses_test123", 50000, 5000, 1000, 200000, 10000, Date.now());

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

    it("should use estimatedTokens when realTokensBaseline > 0 (post-compaction)", () => {
      const s = createSession();
      s.realTokens = 29500000;
      s.realTokensBaseline = 29000000;
      s.estimatedTokens = 70000;
      expect(getTokenCount(s)).toBe(70000);
    });

    it("should use estimatedTokens when baseline equals realTokens (post-compaction)", () => {
      const s = createSession();
      s.realTokens = 29000000;
      s.realTokensBaseline = 29000000;
      s.estimatedTokens = 50000;
      expect(getTokenCount(s)).toBe(50000);
    });

    it("should use estimatedTokens when baseline exceeds realTokens (post-compaction)", () => {
      const s = createSession();
      s.realTokens = 29000000;
      s.realTokensBaseline = 29500000;
      s.estimatedTokens = 50000;
      expect(getTokenCount(s)).toBe(50000);
    });

    it("should ignore baseline when it is 0 (no compaction)", () => {
      const s = createSession();
      s.realTokens = 75000;
      s.realTokensBaseline = 0;
      s.estimatedTokens = 50000;
      expect(getTokenCount(s)).toBe(75000);
    });
  });
});
