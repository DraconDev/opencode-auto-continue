# Project State

## Current Focus
Refactored nudge notification configuration to support idle delay and maximum submit limits.

## Context
The nudge notification system was being refactored to simplify triggering logic. This change adjusts the configuration to better control when nudges appear and how many times they can be triggered.

## Completed
- [x] Renamed `nudgeTimeoutMs` to `nudgeIdleDelayMs` to clarify its purpose as an idle delay
- [x] Added `nudgeMaxSubmits` to limit the number of nudge submissions

## In Progress
- [ ] Verify the new configuration values work correctly in integration tests

## Blockers
- Need to update tests to account for the new configuration options

## Next Steps
1. Update nudge notification tests to verify behavior with new configuration
2. Document the new configuration options in the plugin documentation
