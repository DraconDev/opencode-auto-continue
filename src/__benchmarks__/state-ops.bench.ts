import { bench, describe, vi } from "vitest";
import { createStatusFileModule } from "../status-file.js";
import { createSession, DEFAULT_CONFIG } from "../shared.js";
import type { SessionState } from "../shared.js";

describe("Status File Operations", () => {
  const mockLog = vi.fn();
  const sessions = new Map<string, SessionState>();
  const config = { ...DEFAULT_CONFIG, statusFileEnabled: true };
  
  // Create status file module with temp path
  const statusFile = createStatusFileModule({
    config,
    sessions,
    log: mockLog,
  });

  // Pre-populate sessions
  for (let i = 0; i < 10; i++) {
    sessions.set(`session-${i}`, createSession());
  }

  bench("write status file (10 sessions)", () => {
    statusFile.writeStatusFile("session-0");
  });

  bench("write status file (cold start)", () => {
    const emptySessions = new Map<string, SessionState>();
    const emptyStatus = createStatusFileModule({
      config,
      sessions: emptySessions,
      log: mockLog,
    });
    emptyStatus.writeStatusFile("session-0");
  });
});

describe("Session State Operations", () => {
  bench("create session state", () => {
    createSession();
  });

  bench("update progress timestamp", () => {
    const s = createSession();
    s.lastProgressAt = Date.now();
    s.messageCount++;
    s.estimatedTokens += 100;
  });

  bench("increment recovery stats", () => {
    const s = createSession();
    s.attempts++;
    s.stallDetections++;
    s.recoveryStartTime = Date.now();
    s.lastRecoveryTime = Date.now();
  });
});
