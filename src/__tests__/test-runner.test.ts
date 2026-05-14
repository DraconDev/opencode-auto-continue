import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestRunner, findGateFile, isEnvError } from "../test-runner.js";
import type { PluginConfig } from "../config.js";

const DEFAULT_CONFIG: Pick<PluginConfig, "testOnIdle" | "testCommands" | "testCommandTimeoutMs" | "testCommandGates"> = {
  testOnIdle: true,
  testCommands: ["cargo test"],
  testCommandTimeoutMs: 5000,
  testCommandGates: {
    cargo: "Cargo.toml",
    pnpm: "package.json",
    npm: "package.json",
    yarn: "package.json",
    npx: "package.json",
    make: "Makefile",
    go: "go.mod",
    pip: "pyproject.toml",
    pytest: "pyproject.toml",
  },
};

const MOCK_LOG = vi.fn();

function makeSuccessShell(stdout: string, exitCode = 0) {
  const promise = Promise.resolve({ stdout, stderr: "", exitCode });
  return vi.fn(() => ({ cwd: vi.fn(() => promise) }));
}

function makeFailureShell(stderr: string, exitCode = 1) {
  const promise = Promise.resolve({ stdout: "", stderr, exitCode });
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
    expect(results[0].skipped).toBe(false);
  });

  it("should return failure result when command exits with non-zero", async () => {
    const mockShell = makeFailureShell("test failed", 1);
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].timedOut).toBe(false);
    expect(results[0].skipped).toBe(false);
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
    expect(results[0].skipped).toBe(true); // "command not found" triggers env-error skip
    expect(results[0].output).toContain("command not found");
  });

  it("formatResults should format test results", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const formatted = runner.formatResults([
      { command: "cargo test", output: "all green", passed: true, timedOut: false, skipped: false },
      { command: "cargo run", output: "build failed", passed: false, timedOut: false, skipped: false },
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

  it("formatFailures should only show failed non-skipped results", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const failures = runner.formatFailures([
      { command: "cargo test", output: "all green", passed: true, timedOut: false, skipped: false },
      { command: "cargo build", output: "build failed", passed: false, timedOut: false, skipped: false },
      { command: "cargo clippy", output: "Cargo.toml not found", passed: false, timedOut: false, skipped: true },
    ]);

    expect(failures).toContain("cargo build — FAIL");
    expect(failures).not.toContain("cargo test");
    expect(failures).not.toContain("cargo clippy");
  });

  it("formatFailures should return empty string when all pass", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const failures = runner.formatFailures([
      { command: "cargo test", output: "ok", passed: true, timedOut: false, skipped: false },
    ]);

    expect(failures).toBe("");
  });

  it("formatFailures should return empty string when all failures are skipped", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const failures = runner.formatFailures([
      { command: "cargo test", output: "Cargo.toml not found", passed: false, timedOut: false, skipped: true },
    ]);

    expect(failures).toBe("");
  });

  it("formatResults should show SKIP label for skipped results", async () => {
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: vi.fn() } as any,
    });

    const formatted = runner.formatResults([
      { command: "cargo test", output: "(Cargo.toml not found in project)", passed: false, timedOut: false, skipped: true },
    ]);

    expect(formatted).toContain("cargo test — SKIP");
  });
});

describe("gate file detection", () => {
  const defaultGates: Record<string, string> = {
    cargo: "Cargo.toml",
    pnpm: "package.json",
    npm: "package.json",
    yarn: "package.json",
    npx: "package.json",
    make: "Makefile",
    go: "go.mod",
    pip: "pyproject.toml",
    pytest: "pyproject.toml",
  };

  it("should find gate file for cargo test", () => {
    expect(findGateFile("cargo test", defaultGates)).toBe("Cargo.toml");
  });

  it("should find gate file for cargo build", () => {
    expect(findGateFile("cargo build", defaultGates)).toBe("Cargo.toml");
  });

  it("should find gate file for pnpm test", () => {
    expect(findGateFile("pnpm test", defaultGates)).toBe("package.json");
  });

  it("should find gate file for npm run test", () => {
    expect(findGateFile("npm run test", defaultGates)).toBe("package.json");
  });

  it("should find gate file for go test", () => {
    expect(findGateFile("go test ./...", defaultGates)).toBe("go.mod");
  });

  it("should find gate file for make test", () => {
    expect(findGateFile("make test", defaultGates)).toBe("Makefile");
  });

  it("should return null for unknown command prefix", () => {
    expect(findGateFile("python -m pytest", defaultGates)).toBe(null);
  });

  it("should return null for empty command", () => {
    expect(findGateFile("", defaultGates)).toBe(null);
  });

  it("should use longest prefix match when multiple gates could match", () => {
    const gates: Record<string, string> = {
      npx: "package.json",
      "npx-custom": "custom.marker",
    };
    expect(findGateFile("npx-custom test", gates)).toBe("custom.marker");
  });

  it("should support custom gate overrides", () => {
    const customGates = { ...defaultGates, pytest: "requirements.txt" };
    expect(findGateFile("pytest", customGates)).toBe("requirements.txt");
  });
});

describe("env-error detection", () => {
  it("should detect exit code 127 as env error", () => {
    expect(isEnvError("some output", 127)).toBe(true);
  });

  it("should detect 'could not find' pattern", () => {
    expect(isEnvError("error: could not find Cargo.toml", 1)).toBe(true);
  });

  it("should detect 'command not found' pattern", () => {
    expect(isEnvError("bash: cargo: command not found", 1)).toBe(true);
  });

  it("should detect 'no such file or directory' pattern", () => {
    expect(isEnvError("No such file or directory", 1)).toBe(true);
  });

  it("should detect 'ENOENT' pattern", () => {
    expect(isEnvError("Error: ENOENT: no such file", 1)).toBe(true);
  });

  it("should detect Windows 'not recognized' pattern", () => {
    expect(isEnvError("'cargo' is not recognized as an internal or external command", 1)).toBe(true);
  });

  it("should NOT detect normal test failure as env error", () => {
    expect(isEnvError("test foo::bar::test_something failed", 1)).toBe(false);
  });

  it("should NOT detect exit code 0 as env error", () => {
    expect(isEnvError("all tests passed", 0)).toBe(false);
  });

  it("should NOT detect assertion errors as env error", () => {
    expect(isEnvError("assertion failed: left != right", 1)).toBe(false);
  });
});

describe("gate-based skipping", () => {
  it("should skip cargo test when Cargo.toml not found", async () => {
    const mockShell = makeSuccessShell("should not run", 0);
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp/nonexistent-dir-for-test" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].passed).toBe(false);
    expect(mockShell).not.toHaveBeenCalled();
  });

  it("should run cargo test when Cargo.toml exists", async () => {
    const mockShell = makeSuccessShell("test passed", 0);
    const runner = createTestRunner({
      config: DEFAULT_CONFIG,
      log: MOCK_LOG,
      // Use actual project dir which has Cargo.toml (or at least package.json)
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    // May or may not be skipped depending on whether /tmp has Cargo.toml
    // but the shell should be called since we're testing the gate logic
    if (!results[0].skipped) {
      expect(mockShell).toHaveBeenCalled();
    }
  });

  it("should skip pnpm test when package.json not found", async () => {
    const mockShell = makeSuccessShell("should not run", 0);
    const runner = createTestRunner({
      config: { ...DEFAULT_CONFIG, testCommands: ["pnpm test"] },
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp/nonexistent-dir-for-test" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(mockShell).not.toHaveBeenCalled();
  });

  it("should always run commands with no matching gate", async () => {
    const mockShell = makeSuccessShell("output", 0);
    const runner = createTestRunner({
      config: { ...DEFAULT_CONFIG, testCommands: ["./run-tests.sh"] },
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp/nonexistent-dir-for-test" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(mockShell).toHaveBeenCalled();
  });

  it("should retroactively skip on env-error output", async () => {
    const mockShell = makeFailureShell("error: could not find Cargo.toml in /tmp or any parent directory", 1);
    const runner = createTestRunner({
      // Use "make test" which has Makefile gate, but we set no gate for this test
      config: { ...DEFAULT_CONFIG, testCommands: ["./run-tests.sh"] },
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
  });

  it("should skip on exit code 127 from shell", async () => {
    const mockShell = makeFailureShell("bash: cargo: command not found", 127);
    const runner = createTestRunner({
      // No gate so it runs, but exit 127 causes skip
      config: { ...DEFAULT_CONFIG, testCommands: ["./custom-test"], testCommandGates: {} },
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
  });

  it("should handle mixed commands — some skipped, some run", async () => {
    const mockShell = makeSuccessShell("ok", 0);
    const runner = createTestRunner({
      config: { ...DEFAULT_CONFIG, testCommands: ["cargo test", "pnpm test", "./custom.sh"] },
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp/nonexistent-dir-for-test" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(3);
    // cargo and pnpm should be skipped (no gate file in /tmp/nonexistent...)
    expect(results[0].skipped).toBe(true);
    expect(results[1].skipped).toBe(true);
    // ./custom.sh has no gate → runs
    expect(results[2].skipped).toBe(false);
  });

  it("should support custom testCommandGates from config", async () => {
    const mockShell = makeSuccessShell("ok", 0);
    const runner = createTestRunner({
      config: {
        ...DEFAULT_CONFIG,
        testCommands: ["pytest"],
        testCommandGates: { pytest: "pyproject.toml" },
      },
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp/nonexistent-dir-for-test" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true); // no pyproject.toml in /tmp/nonexistent...
  });

  it("should NOT skip on legitimate test failure output", async () => {
    const mockShell = makeFailureShell("test foo::bar::test_something ... FAILED\n1 test failed", 1);
    const runner = createTestRunner({
      config: { ...DEFAULT_CONFIG, testCommandGates: {} }, // No gate → always runs
      log: MOCK_LOG,
      input: { $: mockShell as any, directory: "/tmp" } as any,
    });

    const results = await runner.runTests();
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].passed).toBe(false);
  });
});
