import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestRunner } from "../test-runner.js";
import type { PluginConfig } from "../config.js";

const DEFAULT_CONFIG: Pick<PluginConfig, "testOnIdle" | "testCommands" | "testCommandTimeoutMs"> = {
  testOnIdle: true,
  testCommands: ["cargo test"],
  testCommandTimeoutMs: 5000,
};

const MOCK_LOG = vi.fn();

/**
 * Create a mock Bun shell `$` function returning a given result.
 * Signature matches:  input.$`cmd`.cwd(dir).then(...)
 */
function makeSuccessShell(stdout: string, exitCode = 0) {
  const promise = Promise.resolve({ stdout, stderr: "", exitCode });
  return vi.fn(() => ({ cwd: vi.fn(() => promise) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createTestRunner", () => {
  it("should return empty results when testOnIdle is false", async () => {
    const runner = createTestRunner({
      config: { ...DEFAULT_CONFIG, testOnIdle: false },
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const results = await runner.runTests();
    expect(results).toEqual([]);
  });

  it("should return empty results when testCommands is empty", async () => {
    const runner = createTestRunner({
      config: { ...DEFAULT_CONFIG, testCommands: [] },
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const results = await runner.runTests();
    expect(results).toEqual([]);
  });

  it("should return empty results when input.$ is not a function", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: {} as any,
    });

    const results = await runner.runTests();
    expect(results).toEqual([]);
  });

  it("should return success result when command exits with 0", async () => {
    const mockShell = makeSuccessShell("test passed", 0);
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].command).toBe("cargo test");
    expect(results[0].passed).toBe(true);
    expect(results[0].timedOut).toBe(false);
  });

  it("should return failure result when command exits with non-zero", async () => {
    const mockShell = makeSuccessShell("test failed", 1);
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].timedOut).toBe(false);
  });

  it("should truncate output to MAX_OUTPUT_PER_COMMAND", async () => {
    const mockShell = makeSuccessShell("x".repeat(10000), 0);
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results[0].output.length).toBe(5000);
  });

  it("should run multiple commands sequentially", async () => {
    const mockShell = makeSuccessShell("", 0);
    const runner = createTestRunner({
      config: { ...DEFAULT_CONFIG, testCommands: ["cargo test", "cargo build"] },
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(2);
    expect(results[0].command).toBe("cargo test");
    expect(results[1].command).toBe("cargo build");
  });

  it("should handle command that throws an error", async () => {
    const err = new Error("command not found");
    const mockShell = vi.fn(() => { throw err; });
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].timedOut).toBe(false);
    expect(results[0].output).toContain("command not found");
  });

  it("formatResults should format test results", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const formatted = runner.formatResults([
      { command: "cargo test", output: "all green", passed: true, timedOut: false },
      { command: "cargo run", output: "build failed", passed: false, timedOut: false },
    ]);

    expect(formatted).toContain("cargo test — PASS");
    expect(formatted).toContain("cargo run — FAIL");
    expect(formatted).toContain("build failed");
  });

  it("formatResults should return placeholder for empty array", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    expect(runner.formatResults([])).toBe("(no test output)");
  });

  it("formatFailures should only show failed results", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const failures = runner.formatFailures([
      { command: "cargo test", output: "all green", passed: true, timedOut: false },
      { command: "cargo build", output: "build failed", passed: false, timedOut: false },
    ]);

    expect(failures).toContain("cargo build — FAIL");
    expect(failures).not.toContain("cargo test");
  });

  it("formatFailures should return empty string when all pass", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const failures = runner.formatFailures([
      { command: "cargo test", output: "ok", passed: true, timedOut: false },
    ]);

    expect(failures).toBe("");
  });
});
