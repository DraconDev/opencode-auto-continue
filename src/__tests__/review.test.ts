import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReviewModule } from "../review.js";
import type { ReviewDeps } from "../review.js";
import { createSession } from "../session-state.js";

async function flushPromises() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("review module", () => {
  describe("triggerReview compaction deferral", () => {
    it("should defer review when hardCompactionInProgress is true", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.hardCompactionInProgress = true;
      s.compacting = false;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
      expect(s.reviewRetryTimer).not.toBeNull();
    });

    it("should defer review when compacting is true", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
      expect(s.reviewRetryTimer).not.toBeNull();
    });

    it("should NOT defer review when neither flag is set", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).toHaveBeenCalled();
      expect(s.reviewRetryTimer).toBeNull();
    });

    it("should clear existing reviewRetryTimer before setting new one", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);

      await triggerReview("test");
      const firstTimer = s.reviewRetryTimer;
      expect(firstTimer).not.toBeNull();

      await triggerReview("test");
      expect(s.reviewRetryTimer).not.toBe(firstTimer);
    });

    it("should fire review after 5s retry timer when compaction clears", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");
      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();

      s.compacting = false;
      s.hardCompactionInProgress = false;

      await vi.advanceTimersByTimeAsync(5500);

      expect(deps.input.client.session.prompt).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT fire review after 5s timer when reviewFired is true", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      s.compacting = false;
      s.reviewFired = true;

      const promptCallsBefore = (deps.input.client.session.prompt as any).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5500);

      expect((deps.input.client.session.prompt as any).mock.calls.length).toBe(promptCallsBefore);
      vi.useRealTimers();
    });

    it("should NOT fire review after 5s timer when session is disposed", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      s.compacting = false;
      (deps.isDisposed as any).mockReturnValue(true);

      const promptCallsBefore = (deps.input.client.session.prompt as any).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5500);

      expect((deps.input.client.session.prompt as any).mock.calls.length).toBe(promptCallsBefore);
      vi.useRealTimers();
    });

    it("should NOT fire review after 5s timer when session is removed", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      deps.sessions.delete("test");

      const promptCallsBefore = (deps.input.client.session.prompt as any).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5500);

      expect((deps.input.client.session.prompt as any).mock.calls.length).toBe(promptCallsBefore);
      vi.useRealTimers();
    });
  });

  describe("sendContinue", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips if continueInProgress is true", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      s.continueInProgress = true;
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
      expect(s.continueInProgress).toBe(true);
    });

    it("skips if needsContinue is false", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.needsContinue = false;
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("skips if session is disposed", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);
      (deps.isDisposed as any).mockReturnValue(true);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("sends prompt and clears needsContinue on success", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(deps.input.client.session.prompt).toHaveBeenCalled();
      expect(s.needsContinue).toBe(false);
      expect(s.continueMessageText).toBe("");
      expect(s.continueRetryCount).toBe(0);
      expect(s.lastContinueRetryAt).toBe(0);
      expect(s.continueInProgress).toBe(false);
    });

    it("resolves {todoMdInstruction} in continueMessageText", async () => {
      const deps = makeDeps();
      deps.config.todoMdPath = "TODO.md";
      deps.config.shortContinueMessage = "Continue. {todoMdInstruction}";
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue. {todoMdInstruction}";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      const callArgs = (deps.input.client.session.prompt as any).mock.calls[0][0];
      const sentText = callArgs.body.parts[0].text;
      expect(sentText).toContain("TODO.md");
      expect(sentText).not.toContain("{todoMdInstruction}");
    });

    it("increments retryCount on prompt failure", async () => {
      const deps = makeDeps();
      (deps.input.client.session.prompt as any).mockRejectedValue(new Error("fail"));
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(s.continueRetryCount).toBe(1);
      expect(s.lastContinueRetryAt).toBe(Date.now());
      expect(s.continueInProgress).toBe(false);
    });

    it("gives up after MAX_CONTINUE_RETRIES (3) failures", async () => {
      const deps = makeDeps();
      (deps.input.client.session.prompt as any).mockRejectedValue(new Error("fail"));
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);

      for (let i = 0; i < 3; i++) {
        await sendContinue("test");
        // Advance past backoff so next retry isn't blocked
        await vi.advanceTimersByTimeAsync(6000);
        await flushPromises();
      }
      // After 3 failures, retryCount=3, needsContinue still true
      expect(s.continueRetryCount).toBe(3);
      expect(s.needsContinue).toBe(true);

      // 4th call: hits retry limit, gives up
      await sendContinue("test");
      expect(s.needsContinue).toBe(false);
      expect(s.continueRetryCount).toBe(0);
    });

    it("skips when retry backoff is active (5s)", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      s.continueRetryCount = 1;
      s.lastContinueRetryAt = Date.now() - 2000;
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("resets stale retry count when >60s since last retry", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      s.continueRetryCount = 2;
      s.lastContinueRetryAt = Date.now() - 70000;
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(deps.input.client.session.prompt).toHaveBeenCalled();
      expect(s.continueRetryCount).toBe(0);
    });

    it("clears continueInProgress in finally block on success", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(s.continueInProgress).toBe(false);
    });

    it("clears continueInProgress in finally block on failure", async () => {
      const deps = makeDeps();
      (deps.input.client.session.prompt as any).mockRejectedValue(new Error("fail"));
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(s.continueInProgress).toBe(false);
    });

    it("60s safety timeout force-clears continueInProgress", async () => {
      const deps = makeDeps();
      (deps.input.client.session.prompt as any).mockImplementation(() => new Promise(() => {}));
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      const promise = sendContinue("test");

      await vi.advanceTimersByTimeAsync(61000);
      await flushPromises();

      expect(s.continueInProgress).toBe(false);
    });

    it("calls forceCompact on token limit error", async () => {
      const deps = makeDeps();
      const tokenError = new Error("context length exceeded");
      (deps.input.client.session.prompt as any).mockRejectedValue(tokenError);
      (deps.isTokenLimitError as any).mockReturnValue(true);
      (deps.forceCompact as any).mockResolvedValue(true);
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      const promise = sendContinue("test");
      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();
      await promise;

      expect(deps.forceCompact).toHaveBeenCalledWith("test");
    });

    it("blocks duplicate via prompt guard", async () => {
      const deps = makeDeps();
      const recentMessages = [
        { role: "user", info: { role: "user", createdAt: new Date().toISOString() }, parts: [{ type: "text", text: "Continue." }] },
      ];
      (deps.input.client.session.messages as any).mockResolvedValue({ data: recentMessages, error: undefined });
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("calls maybeHardCompact before sending continue", async () => {
      const deps = makeDeps();
      const mockHardCompact = vi.fn().mockResolvedValue(false);
      deps.maybeHardCompact = mockHardCompact;
      const s = createSession();
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      deps.sessions.set("test", s);

      const { sendContinue } = createReviewModule(deps);
      await sendContinue("test");

      expect(mockHardCompact).toHaveBeenCalledWith("test");
    });
  });

  describe("triggerReview", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips if reviewFired is true", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.reviewFired = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("skips if review cooldown is active", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.lastReviewAt = Date.now() - 30000;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("sends review prompt and sets reviewFired=true on success", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).toHaveBeenCalled();
      expect(s.reviewFired).toBe(true);
      expect(s.lastReviewAt).toBeGreaterThan(0);
    });

    it("resets reviewFired on failure so retry is allowed", async () => {
      const deps = makeDeps();
      (deps.input.client.session.prompt as any).mockRejectedValue(new Error("fail"));
      const s = createSession();
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(s.reviewFired).toBe(false);
    });

    it("blocks duplicate review via prompt guard", async () => {
      const deps = makeDeps();
      const recentMessages = [
        { role: "user", info: { role: "user", createdAt: new Date().toISOString() }, parts: [{ type: "text", text: "All tracked tasks are marked complete." }] },
      ];
      (deps.input.client.session.messages as any).mockResolvedValue({ data: recentMessages, error: undefined });
      const s = createSession();
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("shows toast when showToasts is true", async () => {
      const deps = makeDeps();
      deps.config.showToasts = true;
      const s = createSession();
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.tui.showToast).toHaveBeenCalled();
    });

    it("calls forceCompact on token limit error", async () => {
      const deps = makeDeps();
      const tokenError = new Error("context length exceeded");
      (deps.input.client.session.prompt as any).mockRejectedValue(tokenError);
      (deps.isTokenLimitError as any).mockReturnValue(true);
      const s = createSession();
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.forceCompact).toHaveBeenCalledWith("test");
    });
  });
});

function makeDeps(overrides?: Partial<ReviewDeps>): ReviewDeps {
  return {
    config: {
      reviewMessage: "All tracked tasks are marked complete. {testOutput}",
      reviewWithoutTestsMessage: "All tracked tasks are marked complete.",
      showToasts: false,
      shortContinueMessage: "Continue.",
      reviewCooldownMs: 60000,
      todoMdPath: "",
    },
    sessions: new Map(),
    log: vi.fn(),
    input: {
      client: {
        session: {
          prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
          messages: vi.fn().mockResolvedValue({ data: [], error: undefined }),
          status: vi.fn().mockResolvedValue({ data: { test: { type: "idle" } }, error: undefined }),
        },
        tui: {
          showToast: vi.fn().mockResolvedValue(undefined),
        },
      },
      directory: "/test",
    } as any,
    isDisposed: vi.fn().mockReturnValue(false),
    writeStatusFile: vi.fn(),
    isTokenLimitError: vi.fn().mockReturnValue(false),
    forceCompact: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}
