import { existsSync } from "fs";
import { join } from "path";
import type { PluginConfig } from "./config.js";
import type { TypedPluginInput } from "./types.js";

export interface TestResult {
  command: string;
  output: string;
  passed: boolean;
  timedOut: boolean;
  skipped: boolean;
}

export interface TestRunnerDeps {
  config: Pick<PluginConfig, "testOnIdle" | "testCommands" | "testCommandTimeoutMs" | "testCommandGates">;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
}

const MAX_OUTPUT_PER_COMMAND = 5000;

const ENV_ERROR_PATTERNS = [
  /could not find/i,
  /command not found/i,
  /no such file or directory/i,
  /enoent/i,
  /error:\s*no such command/i,
  /not recognized as an internal or external command/i,
];

const EXIT_CODE_NOT_FOUND = 127;

function findGateFile(command: string, gates: Record<string, string>): string | null {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return null;
  const prefix = parts[0];

  // Longest prefix match: sort gate keys by length descending
  const sortedKeys = Object.keys(gates).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (prefix === key || prefix.startsWith(key)) {
      return gates[key];
    }
  }
  return null;
}

function isEnvError(output: string, exitCode: number): boolean {
  if (exitCode === EXIT_CODE_NOT_FOUND) return true;
  return ENV_ERROR_PATTERNS.some((pat) => pat.test(output));
}

function hasRealResults(results: TestResult[]): boolean {
  return results.some((r) => !r.skipped);
}

export function createTestRunner(deps: TestRunnerDeps) {
  const { config, log, input } = deps;

  async function runTests(): Promise<TestResult[]> {
    if (!config.testOnIdle || config.testCommands.length === 0) {
      return [];
    }

    if (typeof (input as any).$ !== "function") {
      return [];
    }

    const results: TestResult[] = [];

    for (const cmd of config.testCommands) {
      log("running test command:", cmd);

      // Gate file check — skip if project doesn't have the required marker file
      const gateFile = findGateFile(cmd, config.testCommandGates || {});
      if (gateFile) {
        const dir = input.directory || ".";
        const gatePath = join(dir, gateFile);
        if (!existsSync(gatePath)) {
          log("test command skipped — gate file not found:", gateFile, "for command:", cmd, "in:", dir);
          results.push({ command: cmd, output: `(${gateFile} not found in project)`, passed: false, timedOut: false, skipped: true });
          continue;
        }
      }

      const result = await runSingleCommand(cmd);
      // Retroactive skip: if output suggests environment error, mark as skipped
      if (!result.passed && !result.timedOut && isEnvError(result.output, result.passed ? 0 : -1)) {
        log("test command retroactively skipped — env error detected:", cmd);
        result.skipped = true;
        result.output = result.output || "(environment error — command not applicable)";
      }
      results.push(result);
      log("test command completed:", cmd, "passed:", result.passed, "timedOut:", result.timedOut, "skipped:", result.skipped, "outputLen:", result.output.length);
    }

    return results;
  }

  async function runSingleCommand(cmd: string): Promise<TestResult> {
    const timeout = config.testCommandTimeoutMs;
    const cwd = input.directory || undefined;

    try {
      const outputPromise = input.$`${{ raw: cmd }}`.cwd(cwd ?? ".").then((p: any) => {
        const stdout = typeof p?.stdout === "string" ? p.stdout : "";
        const stderr = typeof p?.stderr === "string" ? p.stderr : "";
        const exitCode = p?.exitCode ?? 0;
        return { output: (stdout + stderr).slice(0, MAX_OUTPUT_PER_COMMAND), exitCode };
      });

      const timeoutPromise = new Promise<{ output: string; exitCode: number }>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timeout after ${timeout}ms`)), timeout);
      });

      const { output, exitCode } = await Promise.race([outputPromise, timeoutPromise]);

      // Exit code 127 = command not found → skip
      if (exitCode === EXIT_CODE_NOT_FOUND) {
        return {
          command: cmd,
          output: output || "(command not found)",
          passed: false,
          timedOut: false,
          skipped: true,
        };
      }

      return {
        command: cmd,
        output,
        passed: exitCode === 0,
        timedOut: false,
        skipped: false,
      };
    } catch (e: any) {
      const isTimeout = e?.message?.includes("timeout");
      if (isTimeout) {
        log("test command timed out:", cmd);
        return {
          command: cmd,
          output: `[TIMED OUT after ${timeout / 1000}s]`,
          passed: false,
          timedOut: true,
          skipped: false,
        };
      }

      const errOutput = e?.stdout || e?.stderr || e?.message || String(e);
      // Check if the error output suggests an env error
      if (isEnvError(errOutput, EXIT_CODE_NOT_FOUND)) {
        return {
          command: cmd,
          output: errOutput.slice(0, MAX_OUTPUT_PER_COMMAND),
          passed: false,
          timedOut: false,
          skipped: true,
        };
      }

      return {
        command: cmd,
        output: errOutput.slice(0, MAX_OUTPUT_PER_COMMAND),
        passed: false,
        timedOut: false,
        skipped: false,
      };
    }
  }

  function formatResults(results: TestResult[]): string {
    const real = results.filter((r) => !r.skipped);
    if (real.length === 0) return "";

    return real
      .map((r) => {
        const status = r.passed ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL";
        return `$ ${r.command} — ${status}\n${r.output}`;
      })
      .join("\n\n");
  }

  function formatFailures(results: TestResult[]): string {
    const failures = results.filter((r) => !r.passed && !r.skipped);
    if (failures.length === 0) return "";

    return failures
      .map((r) => {
        const status = r.timedOut ? "TIMEOUT" : "FAIL";
        return `$ ${r.command} — ${status}\n${r.output}`;
      })
      .join("\n\n");
  }

  return { runTests, formatResults, formatFailures, hasRealResults };
}

export type TestRunner = ReturnType<typeof createTestRunner>;

// Export for testing
export { findGateFile, isEnvError, hasRealResults };
