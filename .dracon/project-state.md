# Project State

## Current Focus
Enhanced session recovery messaging with configurable message formats

## Context
This change improves the session recovery system by making the messaging more configurable and specific to different scenarios (continuation with todos, max attempts reached).

## Completed
- [x] Renamed `messageFormat` to `continueMessage` for clarity
- [x] Added `continueWithTodosMessage` for cases with pending tasks
- [x] Added `maxAttemptsMessage` for when maximum retry attempts are reached

## In Progress
- [ ] No active work in progress

## Blockers
- None identified

## Next Steps
1. Verify the new message formats work as expected in different scenarios
2. Update documentation to reflect the new configuration options
