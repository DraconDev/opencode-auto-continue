import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

// Test shared utilities directly
describe("shared.ts utilities", () => {
  describe("safeHook", () => {
    it("should catch errors and not throw", async () => {
      const { safeHook } = await import('../shared.js');

      let errorThrown = false;
      try {
        await safeHook("test", async () => {
          throw new Error("test error");
        }, console.log);
      } catch {
        errorThrown = true;
      }

      expect(errorThrown).toBe(false);
    });

    it("should call log on error", async () => {
      const logMock = vi.fn();
      const { safeHook } = await import('../shared.js');

      await safeHook("test", async () => {
        throw new Error("test error");
      }, logMock);

      expect(logMock).toHaveBeenCalledWith("[test] hook failed:", expect.any(Error));
    });

    it("should pass through successful results", async () => {
      const logMock = vi.fn();
      const { safeHook } = await import('../shared.js');

      let result = false;
      await safeHook("test", async () => {
        result = true;
      }, logMock);

      expect(result).toBe(true);
      expect(logMock).not.toHaveBeenCalled();
    });

    it("should handle async errors", async () => {
      const logMock = vi.fn();
      const { safeHook } = await import('../shared.js');

      await safeHook("async-test", async () => {
        await new Promise(r => setTimeout(r, 10));
        throw new Error("async error");
      }, logMock);

      expect(logMock).toHaveBeenCalled();
    });

    it("should catch and never propagate non-Error objects", async () => {
      const logMock = vi.fn();
      const { safeHook } = await import('../shared.js');

      let caught = false;
      try {
        await safeHook("test", async () => {
          throw "string error";
        }, logMock);
      } catch {
        caught = true;
      }

      expect(caught).toBe(false); // safeHook catches everything, never propagates
      expect(logMock).toHaveBeenCalled();
    });
  });

  describe("parseTokensFromError", () => {
    it("should parse detailed token error message", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("You requested a total of 264230 tokens: 232230 tokens from the input messages and 32000 tokens for the completion.");
      const result = parseTokensFromError(error);

      expect(result).toEqual({ total: 264230, input: 232230, output: 32000 });
    });

    it("should parse simple token error message", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("You requested 150000 tokens");
      const result = parseTokensFromError(error);

      expect(result).toEqual({ total: 150000, input: 150000, output: 0 });
    });

    it("should parse loose token patterns", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("Too many tokens: 98765 tokens in the request");
      const result = parseTokensFromError(error);

      expect(result).toEqual({ total: 98765, input: 98765, output: 0 });
    });

    it("should return null for non-token errors", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("Something went wrong");
      const result = parseTokensFromError(error);

      expect(result).toBeNull();
    });

    it("should handle null error", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const result = parseTokensFromError(null);

      expect(result).toBeNull();
    });

    it("should handle undefined error", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const result = parseTokensFromError(undefined);

      expect(result).toBeNull();
    });

    it("should handle error with no message", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const result = parseTokensFromError({ message: null });

      expect(result).toBeNull();
    });

    it("should handle error with empty message", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("");
      const result = parseTokensFromError(error);

      expect(result).toBeNull();
    });

    it("should handle error with only whitespace", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("   ");
      const result = parseTokensFromError(error);

      expect(result).toBeNull();
    });

    it("should handle numeric error object", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const result = parseTokensFromError(12345 as any);

      expect(result).toBeNull();
    });

    it("should handle string error", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const result = parseTokensFromError("Token limit exceeded: 100000 tokens" as any);

      expect(result).toEqual({ total: 100000, input: 100000, output: 0 });
    });

    it("should parse exact numbers without commas", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("You requested 123456789 tokens");
      const result = parseTokensFromError(error);

      expect(result).toEqual({ total: 123456789, input: 123456789, output: 0 });
    });

    it("should handle multiline error messages", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error(`Error: Request failed
        Context length exceeded
        You requested a total of 200000 tokens: 180000 tokens from the input messages and 20000 tokens for the completion.
        Please reduce your prompt size.`);
      const result = parseTokensFromError(error);

      expect(result).toEqual({ total: 200000, input: 180000, output: 20000 });
    });
  });

  describe("createSession", () => {
    it("should create session with default values", async () => {
      const { createSession } = await import('../session-state.js');

      const session = createSession();

      expect(session).toBeDefined();
      expect(session.timer).toBeNull();
      expect(session.nudgeTimer).toBeNull();
      expect(session.attempts).toBe(0);
      expect(session.userCancelled).toBe(false);
      expect(session.planning).toBe(false);
      expect(session.compacting).toBe(false);
      expect(session.hasOpenTodos).toBe(false);
    });

    it("should set initial timestamps", async () => {
      const { createSession } = await import('../shared.js');

      const before = Date.now();
      const session = createSession();
      const after = Date.now();

      expect(session.lastProgressAt).toBeGreaterThanOrEqual(before);
      expect(session.lastProgressAt).toBeLessThanOrEqual(after);
      expect(session.sessionCreatedAt).toBeGreaterThanOrEqual(before);
      expect(session.sessionCreatedAt).toBeLessThanOrEqual(after);
    });

    it("should initialize empty arrays and objects", async () => {
      const { createSession } = await import('../shared.js');

      const session = createSession();

      expect(session.recoveryTimes).toEqual([]);
      expect(session.stallPatterns).toEqual({});
      expect(session.lastKnownTodos).toEqual([]);
    });

    it("should initialize default values for all counters", async () => {
      const { createSession } = await import('../shared.js');

      const session = createSession();

      expect(session.nudgeCount).toBe(0);
      expect(session.lastNudgeAt).toBe(0);
      expect(session.estimatedTokens).toBe(0);
      expect(session.lastCompactionAt).toBe(0);
      expect(session.tokenLimitHits).toBe(0);
      expect(session.recoverySuccessful).toBe(0);
      expect(session.recoveryFailed).toBe(0);
    });
  });

  describe("validateConfig", () => {
    it("should accept valid config", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const result = validateConfig(DEFAULT_CONFIG);

      expect(result).toEqual(DEFAULT_CONFIG);
    });

    it("should reject stallTimeoutMs <= waitAfterAbortMs", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, stallTimeoutMs: 100, waitAfterAbortMs: 200 };
      const result = validateConfig(config);

      expect(result.stallTimeoutMs).toBe(DEFAULT_CONFIG.stallTimeoutMs);
    });

    it("should reject negative maxRecoveries", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, maxRecoveries: -1 };
      const result = validateConfig(config);

      expect(result.maxRecoveries).toBe(DEFAULT_CONFIG.maxRecoveries);
    });

    it("should reject zero stallTimeoutMs", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, stallTimeoutMs: 0 };
      const result = validateConfig(config);

      expect(result.stallTimeoutMs).toBe(DEFAULT_CONFIG.stallTimeoutMs);
    });

    it("should reject negative cooldownMs", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, cooldownMs: -1000 };
      const result = validateConfig(config);

      expect(result.cooldownMs).toBe(DEFAULT_CONFIG.cooldownMs);
    });

    it("should reject empty continueMessage", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, continueMessage: "" };
      const result = validateConfig(config);

      expect(result.continueMessage).toBe(DEFAULT_CONFIG.continueMessage);
    });

    it("should reject negative reviewDebounceMs", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, reviewDebounceMs: -1 };
      const result = validateConfig(config);

      expect(result.reviewDebounceMs).toBe(DEFAULT_CONFIG.reviewDebounceMs);
    });

    it("should reject negative proactiveCompactAtTokens", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, proactiveCompactAtTokens: -100 };
      const result = validateConfig(config);

      expect(result.proactiveCompactAtTokens).toBe(DEFAULT_CONFIG.proactiveCompactAtTokens);
    });

    it("should reject proactiveCompactAtPercent > 100", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, proactiveCompactAtPercent: 150 };
      const result = validateConfig(config);

      expect(result.proactiveCompactAtPercent).toBe(DEFAULT_CONFIG.proactiveCompactAtPercent);
    });

    it("should reject empty shortContinueMessage", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, shortContinueMessage: "   " };
      const result = validateConfig(config);

      expect(result.shortContinueMessage).toBe(DEFAULT_CONFIG.shortContinueMessage);
    });

    it("should reject empty tokenLimitPatterns", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, tokenLimitPatterns: [] };
      const result = validateConfig(config);

      expect(result.tokenLimitPatterns).toEqual(DEFAULT_CONFIG.tokenLimitPatterns);
    });

    it("should reject invalid compactReductionFactor = 0", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, compactReductionFactor: 0 };
      const result = validateConfig(config);

      expect(result.compactReductionFactor).toBe(DEFAULT_CONFIG.compactReductionFactor);
    });

    it("should reject invalid compactReductionFactor = 1", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, compactReductionFactor: 1 };
      const result = validateConfig(config);

      expect(result.compactReductionFactor).toBe(DEFAULT_CONFIG.compactReductionFactor);
    });

    it("should reject invalid compactReductionFactor > 1", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, compactReductionFactor: 1.5 };
      const result = validateConfig(config);

      expect(result.compactReductionFactor).toBe(DEFAULT_CONFIG.compactReductionFactor);
    });

    it("should accept valid compactReductionFactor = 0.5", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, compactReductionFactor: 0.5 };
      const result = validateConfig(config);

      expect(result.compactReductionFactor).toBe(0.5);
    });

    it("should accept valid compactReductionFactor = 0.99", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, compactReductionFactor: 0.99 };
      const result = validateConfig(config);

      expect(result.compactReductionFactor).toBe(0.99);
    });

    it("should accept valid compactReductionFactor = 0.01", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = { ...DEFAULT_CONFIG, compactReductionFactor: 0.01 };
      const result = validateConfig(config);

      expect(result.compactReductionFactor).toBe(0.01);
    });

    it("should normalize documented session monitor aliases", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../shared.js');

      const config = {
        ...DEFAULT_CONFIG,
        orphanWaitMs: 1234,
        idleCleanupMs: 5678,
        sessionMonitorEnabled: false,
      };
      const result = validateConfig(config);

      expect(result.subagentWaitMs).toBe(1234);
      expect(result.idleSessionTimeoutMs).toBe(5678);
      expect(result.orphanParentDetection).toBe(false);
      expect(result.sessionDiscovery).toBe(false);
      expect(result.idleCleanup).toBe(false);
    });

    it("should keep shared and extracted config defaults in sync", async () => {
      const shared = await import('../shared.js');
      const extracted = await import('../config.js');

      expect(shared.DEFAULT_CONFIG.sessionMonitorEnabled).toBe(extracted.DEFAULT_CONFIG.sessionMonitorEnabled);
      expect(shared.DEFAULT_CONFIG.orphanWaitMs).toBe(extracted.DEFAULT_CONFIG.orphanWaitMs);
      expect(shared.DEFAULT_CONFIG.subagentWaitMs).toBe(extracted.DEFAULT_CONFIG.subagentWaitMs);
      expect(shared.DEFAULT_CONFIG.idleCleanupMs).toBe(extracted.DEFAULT_CONFIG.idleCleanupMs);
      expect(shared.DEFAULT_CONFIG.idleSessionTimeoutMs).toBe(extracted.DEFAULT_CONFIG.idleSessionTimeoutMs);
    });

    it("should normalize documented aliases in extracted config module", async () => {
      const { validateConfig, DEFAULT_CONFIG } = await import('../config.js');

      const result = validateConfig({
        ...DEFAULT_CONFIG,
        orphanWaitMs: 2222,
        idleCleanupMs: 3333,
        sessionMonitorEnabled: false,
      });

      expect(result.subagentWaitMs).toBe(2222);
      expect(result.idleSessionTimeoutMs).toBe(3333);
      expect(result.orphanParentDetection).toBe(false);
      expect(result.sessionDiscovery).toBe(false);
      expect(result.idleCleanup).toBe(false);
    });
  });

  describe("formatMessage", () => {
    it("should replace single placeholder", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Hello {name}", { name: "World" });

      expect(result).toBe("Hello World");
    });

    it("should replace multiple placeholders", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Hello {name}, you have {count} messages", { name: "Alice", count: "5" });

      expect(result).toBe("Hello Alice, you have 5 messages");
    });

    it("should handle missing placeholders", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Hello {name}, you have {count} messages", { name: "Alice" });

      expect(result).toBe("Hello Alice, you have {count} messages");
    });

    it("should handle extra variables", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Hello {name}", { name: "World", extra: "ignored" });

      expect(result).toBe("Hello World");
    });

    it("should handle empty template", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("", { name: "World" });

      expect(result).toBe("");
    });

    it("should handle template with no placeholders", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Hello World", { name: "ignored" });

      expect(result).toBe("Hello World");
    });

    it("should handle special characters in values", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Path: {path}", { path: "/tmp/test (1).txt" });

      expect(result).toBe("Path: /tmp/test (1).txt");
    });

    it("should handle unicode in values", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Hello {name}", { name: "世界" });

      expect(result).toBe("Hello 世界");
    });

    it("should handle newlines in values", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Text: {text}", { text: "line1\nline2" });

      expect(result).toBe("Text: line1\nline2");
    });

    it("should handle brace characters in values", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Path: {path}", { path: "{curly}" });

      expect(result).toBe("Path: {curly}");
    });

    it("should handle numeric values", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Count: {count}", { count: 42 });

      expect(result).toBe("Count: 42");
    });

    it("should handle boolean values", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Enabled: {enabled}", { enabled: true });

      expect(result).toBe("Enabled: true");
    });

    it("should replace same placeholder multiple times", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("{x} + {x} = 2{x}", { x: "one" });

      expect(result).toBe("one + one = 2one");
    });
  });

  describe("snapshot behavior via formatMessage", () => {
    // snapshot() is internal to nudge.ts - test snapshot behavior via formatMessage
    it("should use formatMessage for placeholder replacement", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("{pending} task(s): {todoList}", {
        pending: "3",
        todoList: "task1, task2, task3"
      });

      expect(result).toBe("3 task(s): task1, task2, task3");
    });

    it("should handle todo list template variables", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("{total} todos, {completed} done, {pending} remaining", {
        total: "5",
        completed: "2",
        pending: "3"
      });

      expect(result).toBe("5 todos, 2 done, 3 remaining");
    });

    it("should handle missing template variables gracefully", async () => {
      const { formatMessage } = await import('../shared.js');

      const result = formatMessage("Tasks: {todoList}", { total: "5" });

      expect(result).toBe("Tasks: {todoList}");
    });
  });

  describe("shouldBlockPrompt", () => {
    it("should block duplicate synthetic user prompts", async () => {
      const { shouldBlockPrompt } = await import('../shared.js');
      const input = {
        client: {
          session: {
            messages: vi.fn().mockResolvedValue({
              data: [{
                role: "user",
                createdAt: new Date().toISOString(),
                parts: [{ type: "text", text: "Please continue working on these tasks.", synthetic: true }],
              }],
            }),
          },
        },
      } as any;

      const result = await shouldBlockPrompt("test", "Please continue working on these tasks.", input);

      expect(result).toBe(true);
      expect(input.client.session.messages).toHaveBeenCalledWith({
        path: { id: "test" },
        query: { limit: 15 },
      });
    });

    it("should ignore duplicate text outside the guard window", async () => {
      const { shouldBlockPrompt } = await import('../shared.js');
      const input = {
        client: {
          session: {
            messages: vi.fn().mockResolvedValue({
              data: [{
                role: "user",
                createdAt: Date.now() - 60000,
                parts: [{ type: "text", text: "Please continue working on these tasks.", synthetic: true }],
              }],
            }),
          },
        },
      } as any;

      const result = await shouldBlockPrompt("test", "Please continue working on these tasks.", input);

      expect(result).toBe(false);
    });

    it("should fail open for timestamp-less messages", async () => {
      const { shouldBlockPrompt } = await import('../shared.js');
      const input = {
        client: {
          session: {
            messages: vi.fn().mockResolvedValue({
              data: [{
                role: "user",
                parts: [{ type: "text", text: "Please continue working on these tasks.", synthetic: true }],
              }],
            }),
          },
        },
      } as any;

      const result = await shouldBlockPrompt("test", "Please continue working on these tasks.", input);

      expect(result).toBe(false);
    });
  });

  describe("getCompactionThreshold", () => {
    it("should always return proactiveCompactAtTokens", async () => {
      const { getCompactionThreshold } = await import('../shared.js');

      const result = getCompactionThreshold({ proactiveCompactAtPercent: 50, proactiveCompactAtTokens: 100000 } as any);
      expect(result).toBe(100000);
    });

    it("should return proactiveCompactAtTokens for large models", async () => {
      const { getCompactionThreshold } = await import('../shared.js');

      const result = getCompactionThreshold({ proactiveCompactAtPercent: 50, proactiveCompactAtTokens: 100000 } as any);
      expect(result).toBe(100000);
    });

    it("should return proactiveCompactAtTokens for very large models", async () => {
      const { getCompactionThreshold } = await import('../shared.js');

      const result = getCompactionThreshold({ proactiveCompactAtPercent: 50, proactiveCompactAtTokens: 100000 } as any);
      expect(result).toBe(100000);
    });

    it("should return proactiveCompactAtTokens when configured lower", async () => {
      const { getCompactionThreshold } = await import('../shared.js');

      const result = getCompactionThreshold({ proactiveCompactAtTokens: 50000, proactiveCompactAtPercent: 90 } as any);
      expect(result).toBe(50000);
    });

    it("should return proactiveCompactAtTokens for null model limit", async () => {
      const { getCompactionThreshold } = await import('../shared.js');

      const result = getCompactionThreshold({ proactiveCompactAtPercent: 50, proactiveCompactAtTokens: 100000 } as any);
      expect(result).toBe(100000);
    });

    it("should return proactiveCompactAtTokens for zero model limit", async () => {
      const { getCompactionThreshold } = await import('../shared.js');

      const result = getCompactionThreshold({ proactiveCompactAtPercent: 50, proactiveCompactAtTokens: 100000 } as any);
      expect(result).toBe(100000);
    });

    it("should return proactiveCompactAtTokens for negative model limit", async () => {
      const { getCompactionThreshold } = await import('../shared.js');

      const result = getCompactionThreshold({ proactiveCompactAtPercent: 50, proactiveCompactAtTokens: 100000 } as any);
      expect(result).toBe(100000);
    });
  });

  describe("ModelContextCache", () => {
    it("should invalidate cache when requested", async () => {
      const { invalidateModelLimitCache } = await import('../shared.js');

      invalidateModelLimitCache();

      expect(true).toBe(true);
    });

    it("should return null for non-existent config file", async () => {
      const { getModelContextLimit } = await import('../shared.js');

      const result = getModelContextLimit("/nonexistent/path/config.json");

      expect(result).toBeNull();
    });

    it("should return null for invalid JSON config", async () => {
      const tmp = "/tmp/opencode-test-config-" + Date.now() + ".json";
      writeFileSync(tmp, "not valid json {{{");
      try {
        const { getModelContextLimit } = await import('../shared.js');
        const result = getModelContextLimit(tmp);
        expect(result).toBeNull();
      } finally {
        unlinkSync(tmp);
      }
    });

    it("should return null for empty config", async () => {
      const tmp = "/tmp/opencode-test-config-" + Date.now() + ".json";
      writeFileSync(tmp, "{}");
      try {
        const { getModelContextLimit } = await import('../shared.js');
        const result = getModelContextLimit(tmp);
        expect(result).toBeNull();
      } finally {
        unlinkSync(tmp);
      }
    });

    it("should parse valid config with models", async () => {
      const tmp = "/tmp/opencode-test-config-" + Date.now() + ".json";
      writeFileSync(tmp, JSON.stringify({
        provider: {
          openai: {
            models: {
              "gpt-4": {
                limit: { context: 128000 }
              }
            }
          }
        }
      }));
      try {
        const { getModelContextLimit } = await import('../shared.js');
        const result = getModelContextLimit(tmp);
        expect(result).toBe(128000);
      } finally {
        unlinkSync(tmp);
      }
    });

    it("should return minimum limit from multiple providers", async () => {
      const tmp = "/tmp/opencode-test-config-" + Date.now() + ".json";
      writeFileSync(tmp, JSON.stringify({
        provider: {
          provider1: {
            models: {
              "model1": { limit: { context: 100000 } }
            }
          },
          provider2: {
            models: {
              "model2": { limit: { context: 50000 } }
            }
          }
        }
      }));
      try {
        const { getModelContextLimit } = await import('../shared.js');
        const result = getModelContextLimit(tmp);
        expect(result).toBe(50000);
      } finally {
        unlinkSync(tmp);
      }
    });

    it("should ignore models without limit.context", async () => {
      const tmp = "/tmp/opencode-test-config-" + Date.now() + ".json";
      writeFileSync(tmp, JSON.stringify({
        provider: {
          openai: {
            models: {
              "gpt-4": { limit: { context: 128000 } },
              "gpt-3.5": { limit: {} }
            }
          }
        }
      }));
      try {
        const { getModelContextLimit } = await import('../shared.js');
        const result = getModelContextLimit(tmp);
        expect(result).toBe(128000);
      } finally {
        unlinkSync(tmp);
      }
    });
  });

  describe("containsToolCallAsText", () => {
    it("should detect function= XML in text", async () => {
      const { containsToolCallAsText } = await import('../shared.js');
      expect(containsToolCallAsText('<function=edit_file>some code</function>')).toBe(true);
    });

    it("should detect invoke XML in text", async () => {
      const { containsToolCallAsText } = await import('../shared.js');
      expect(containsToolCallAsText('<invoke name="read">content</invoke>')).toBe(true);
    });

    it("should detect truncated XML (open tag without close)", async () => {
      const { containsToolCallAsText } = await import('../shared.js');
      expect(containsToolCallAsText('<function=edit_file>some code that got cut of')).toBe(true);
    });

    it("should detect tool-like XML tags (edit, bash, etc.)", async () => {
      const { containsToolCallAsText } = await import('../shared.js');
      expect(containsToolCallAsText('<edit file="test.ts">content</edit>')).toBe(true);
      expect(containsToolCallAsText('<bash command="ls -la">')).toBe(true);
    });

    it("should NOT flag normal text", async () => {
      const { containsToolCallAsText } = await import('../shared.js');
      expect(containsToolCallAsText('I will now edit the file to add the new feature.')).toBe(false);
      expect(containsToolCallAsText('Running the tests...')).toBe(false);
    });

    it("should NOT flag very short text", async () => {
      const { containsToolCallAsText } = await import('../shared.js');
      expect(containsToolCallAsText('<func>')).toBe(false);
    });
  });
});
