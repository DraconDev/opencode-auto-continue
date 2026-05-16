import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendCustomPrompt, type CustomPromptOptions, type CustomPromptResult } from "../index.js";
import { createMockInput, createMockSessionClient } from "./helpers.js";
import type { PluginConfig } from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { SessionState } from "../session-state.js";
import { createSession } from "../session-state.js";

// We need access to the internal runtime registration to set up test state.
// The sendCustomPrompt function reads from module-level customPromptRuntimes.
// We'll register a runtime manually for testing.

describe("sendCustomPrompt", () => {
  let mockInput: ReturnType<typeof createMockInput>;
  let mockSessions: Map<string, SessionState>;
  let mockConfig: PluginConfig;
  let logFn: (...args: unknown[]) => void;

  // We need to access the module's internal registerCustomPromptRuntime.
  // Since it's not exported, we'll test via the plugin function's side effects.
  // For unit testing, we'll re-import the module with a fresh state.
  // Instead, we test the end-to-end behavior by setting up the runtime.

  beforeEach(() => {
    vi.useFakeTimers();
    mockInput = createMockInput();
    mockSessions = new Map();
    mockConfig = { ...DEFAULT_CONFIG };
    logFn = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("without registered runtime", () => {
    it("should return error when no runtime is registered", async () => {
      // Reset module state by importing fresh
      // Since the runtimes are module-level singletons, we need to ensure
      // they're cleared. In a real test, we'd need the plugin to initialize.
      // For this test, we just verify the error format.
      const result = await sendCustomPrompt("ses_nonexistent", {
        message: "test",
      });
      // If no runtime matches, it should fail
      expect(result.success).toBe(false);
      expect(result.error).toContain("No active opencode-auto-continue plugin runtime");
    });
  });

  describe("with registered runtime via plugin initialization", () => {
    // These tests require initializing the plugin, which creates a runtime.
    // We test via the exported API after calling AutoForceResumePlugin.
    let pluginReturn: any;
    let sessionId: string;

    beforeEach(async () => {
      sessionId = "ses_test123";
      mockSessions.set(sessionId, createSession());

      // Initialize the plugin to register the custom prompt runtime
      const { AutoForceResumePlugin } = await import("../index.js");
      pluginReturn = await AutoForceResumePlugin(mockInput, { ...DEFAULT_CONFIG, debug: false, stallTimeoutMs: 60000, nudgeEnabled: false, sessionMonitorEnabled: false, reviewOnIdle: false });
    });

    afterEach(async () => {
      if (pluginReturn?.dispose) {
        pluginReturn.dispose();
      }
    });

    it("should send a simple custom prompt", async () => {
      const result = await sendCustomPrompt(sessionId, {
        message: "Continue working on the task",
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Continue working on the task");
      expect(mockInput.client.session.prompt).toHaveBeenCalled();
    });

    it("should render template variables", async () => {
      const result = await sendCustomPrompt(sessionId, {
        message: "Recovery attempt {attempts} of {maxAttempts}",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Recovery attempt 1 of");
    });

    it("should include todo context when requested", async () => {
      const todoData = [
        { id: "t1", content: "Fix bug", status: "in_progress" },
        { id: "t2", content: "Add tests", status: "pending" },
      ];
      mockInput.client.session.todo = vi.fn().mockResolvedValue({
        data: todoData,
        error: undefined,
      });

      const result = await sendCustomPrompt(sessionId, {
        message: "Work on: {todoList}",
        includeTodoContext: true,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Fix bug");
      expect(result.todos).toBeDefined();
      expect(result.todos?.length).toBe(2);
    });

    it("should include context summary when requested", async () => {
      mockInput.client.session.messages = vi.fn().mockResolvedValue({
        data: [{ role: "assistant", parts: [{ type: "text", text: "I'm working on the codebase" }] }],
        error: undefined,
      });
      mockInput.client.session.todo = vi.fn().mockResolvedValue({
        data: [],
        error: undefined,
      });

      const result = await sendCustomPrompt(sessionId, {
        message: "Continue: {contextSummary}",
        includeContextSummary: true,
        includeTodoContext: true,
      });

      expect(result.success).toBe(true);
      expect(result.contextSummary).toBeDefined();
    });

    it("should return error for empty message", async () => {
      const result = await sendCustomPrompt(sessionId, {
        message: "",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("empty");
    });

    it("should append customPrompt when template doesn't include {customPrompt}", async () => {
      const result = await sendCustomPrompt(sessionId, {
        message: "Keep going",
        customPrompt: "Focus on the login page",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Keep going");
      expect(result.message).toContain("Focus on the login page");
      expect(result.message).toContain("Additional instruction:");
    });

    it("should handle todo fetch failure gracefully", async () => {
      mockInput.client.session.todo = vi.fn().mockRejectedValue(new Error("network error"));

      const result = await sendCustomPrompt(sessionId, {
        message: "Work on: {todoList}",
        includeTodoContext: true,
      });

      expect(result.success).toBe(true);
      // todoList should remain empty
      expect(result.message).toContain("Work on:");
    });

    it("should handle message fetch failure gracefully", async () => {
      mockInput.client.session.messages = vi.fn().mockRejectedValue(new Error("server error"));

      const result = await sendCustomPrompt(sessionId, {
        message: "Context: {contextSummary}",
        includeContextSummary: true,
      });

      expect(result.success).toBe(true);
    });

    it("should handle prompt send failure", async () => {
      mockInput.client.session.prompt = vi.fn().mockRejectedValue(new Error("send failed"));

      const result = await sendCustomPrompt(sessionId, {
        message: "Continue",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("send failed");
    });

    it("should send prompt with synthetic: true", async () => {
      await sendCustomPrompt(sessionId, {
        message: "Test message",
      });

      const call = mockInput.client.session.prompt.mock.calls[0];
      expect(call[0].body.parts[0].synthetic).toBe(true);
    });
  });
});
