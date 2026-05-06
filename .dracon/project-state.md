# Project State

## Current Focus
Refactored nudge toast notification to use input.client instead of client.client

## Context
This change simplifies the nudge module's API access pattern by removing an unnecessary intermediate client reference.

## Completed
- [x] Changed toast notification to use `input.client.tui` instead of `client.client.tui`

## In Progress
- [x] No active work in progress

## Blockers
- None

## Next Steps
1. Verify no runtime errors occur with this change
2. Update related tests to reflect the new API pattern
