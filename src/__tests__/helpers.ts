import { vi } from "vitest";

/**
 * Flush all pending microtasks and timer callbacks.
 * More reliable than chaining `await Promise.resolve()` multiple times.
 * Use after `vi.advanceTimersByTimeAsync()` to let async handlers settle.
 */
export async function flushPromises(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Create a mock session client for testing.
 * Each method is a vi.fn() that can be individually overridden.
 */
export function createMockSessionClient(overrides?: Record<string, any>) {
  return {
    abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
    prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
    status: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
    todo: vi.fn().mockResolvedValue({ data: [], error: undefined }),
    summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
    messages: vi.fn().mockResolvedValue({ data: [], error: undefined }),
    list: vi.fn().mockResolvedValue({ data: [], error: undefined }),
    ...overrides,
  };
}

/**
 * Create a mock plugin input with the given session client.
 */
export function createMockInput(sessionClient?: any): any {
  return {
    client: {
      session: sessionClient || createMockSessionClient(),
      tui: {
        showToast: vi.fn().mockResolvedValue({}),
      },
    },
    directory: "/tmp",
  };
}
