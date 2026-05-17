/**
 * Test-Driven Quality Gate State.
 */

export interface TestState {
  lastTestRunAt: number;
  testRunInProgress: boolean;
}

export function createTestDefaults(now: number): TestState {
  return {
    lastTestRunAt: 0,
    testRunInProgress: false,
  };
}