# Project State

## Current Focus
Updated auto-force-resume plugin configuration options in documentation

## Context
The changes simplify the configuration options for the auto-force-resume plugin by removing deprecated or redundant settings while adding new ones for better user control.

## Completed
- [x] Removed deprecated configuration options (`abortPollIntervalMs`, `abortPollMaxTimeMs`, `abortPollMaxFailures`, `maxBackoffMs`, `maxAutoSubmits`, `continueMessage`, `continueWithTodosMessage`, `maxAttemptsMessage`, `includeTodoContext`, `reviewOnComplete`, `reviewMessage`, `reviewDebounceMs`)
- [x] Updated `waitAfterAbortMs` from 1500 to 5000 milliseconds
- [x] Enabled `showToasts` for better user notifications

## In Progress
- [x] Documentation updates for the simplified configuration

## Blockers
- None identified

## Next Steps
1. Verify the updated configuration works as expected in test environments
2. Consider adding more user-friendly documentation examples for the new configuration options
