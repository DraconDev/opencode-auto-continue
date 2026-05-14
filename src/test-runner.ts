import type { PluginConfig } from "./config.js";
import type { TypedPluginInput } from "./types.js";

export interface TestResult {
  command: string;
  output: string;
  passed: boolean;
  timedOut: boolean;
}

export interface TestRunnerDeps {
  config: Pick<PluginConfig, "testOnIdle" | "testCommands" | "testCommandTimeoutMs">;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
}

const MAX_OUTPUT_PER_COMMAND = 5000;

export function createTestRunner(deps: TestRunnerDeps) {
  const { config, log, input } = deps;

  async function runTests(): Promise<TestResult[]> {
    if (!config.testOnIdle || config.testCommands.length === 0) {
      return [];
    }

    const results: TestResult[] = [];

    for (const cmd of config.testCommands) {
      log("running test command:", cmd);
      const result = await runSingleCommand(cmd);
      results.push(result);
      log("test command completed:", cmd, "passed:", result.passed, "timedOut:", result.timedOut, "outputLen:", result.output.length);
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
        return { output: (stdout + stderr).slice(0, MAX_OUTPUT_PER_COMMAND), exitCode: p?.exitCode ?? 0 };
      });

      const timeoutPromise = new Promise<{ output: string; exitCode: number }>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timeout after ${timeout}ms`)), timeout);
      });

      const { output, exitCode } = await Promise.race([outputPromise, timeoutPromise]);

      return {
        command: cmd,
        output,
        passed: exitCode === 0,
        timedOut: false,
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
        };
      }

      const errOutput = e?.stdout || e?.stderr || e?.message || String(e);
      return {
        command: cmd,
        output: errOutput.slice(0, MAX_OUTPUT_PER_COMMAND),
        passed: false,
        timedOut: false,
      };
    }
  }

  function formatResults(results: TestResult[]): string {
    if (results.length === 0) return "(no test output)";

    return results
      .map((r) => {
        const status = r.passed ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL";
        return `$ ${r.command} — ${status}\n${r.output}`;
      })
      .join("\n\n");
  }

  function formatFailures(results: TestResult[]): string {
    const failures = results.filter((r) => !r.passed);
    if (failures.length === 0) return "";

    return failures
      .map((r) => {
        const status = r.timedOut ? "TIMEOUT" : "FAIL";
        return `$ ${r.command} — ${status}\n${r.output}`;
      })
      .join("\n\n");
  }

  return { runTests, formatResults, formatFailures };
}

export type TestRunner = ReturnType<typeof createTestRunner>;
