import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReviewModule } from "../review.js";
import type { ReviewDeps } from "../review.js";
import type { SessionState } from "../session-state.js";
import { createSession } from "../session-state.js";

function makeDeps(overrides?: Partial<ReviewDeps>): ReviewDeps {
  return {
    config: {
      reviewMessage: "All tracked tasks are marked complete. {testOutput}",
      reviewWithoutTestsMessage: "All tracked tasks are marked complete.",
      showToasts: false,
      shortContinueMessage: "Continue.",
      reviewCooldownMs: 60000,
    },
    sessions: new Map(),
    log: vi.fn(),
    input: {
      client: {
        session: {
          prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
          messages: vi.fn().mockResolvedValue({ data: [], error: undefined }),
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

describe("review module", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

    it("should retry review after 5s timer fires and compaction is done", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();

      s.compacting = false;
      s.hardCompactionInProgress = false;

      await vi.advanceTimersByTimeAsync(5000);
      await new Promise(r => setTimeout(r, 0));

      expect(deps.input.client.session.prompt).toHaveBeenCalled();
    });

    it("should NOT retry review when reviewFired is true when timer fires", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      s.compacting = false;
      s.hardCompactionInProgress = false;
      s.reviewFired = true;

      await vi.advanceTimersByTimeAsync(5000);
      await new Promise(r => setTimeout(r, 0));

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("should NOT retry review when session is disposed when timer fires", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      s.compacting = false;
      (deps.isDisposed as any).mockReturnValue(true);

      await vi.advanceTimersByTimeAsync(5000);
      await new Promise(r => setTimeout(r, 0));

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });

    it("should NOT retry review when session is removed when timer fires", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const { triggerReview } = createReviewModule(deps);
      await triggerReview("test");

      deps.sessions.delete("test");

      await vi.advanceTimersByTimeAsync(5000);
      await new Promise(r => setTimeout(r, 0));

      expect(deps.input.client.session.prompt).not.toHaveBeenCalled();
    });
  });
});
