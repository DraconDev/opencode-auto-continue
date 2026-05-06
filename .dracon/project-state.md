# Project State

## Current Focus
Removed deprecated `nudgeTimeoutMs` configuration option from documentation.

## Context
The `nudgeTimeoutMs` option was deprecated in favor of `nudgeIdleDelayMs` to standardize nudge timing configuration.

## Completed
- [x] Removed deprecated `nudgeTimeoutMs` from README.md configuration table

## In Progress
- [x] No active work in progress

## Blockers
- None

## Next Steps
1. Verify all references to `nudgeTimeoutMs` are updated in code
2. Consider removing the deprecated option from code if no backward compatibility is needed
