# Project State

## Current Focus
Add optional Dynamic Context Pruning (DCP) integration with warning configuration

## Context
This change enables optional integration with DCP while providing a warning configuration to handle cases where DCP might be unavailable or misconfigured.

## Completed
- [x] Added `@tarquinen/opencode-dcp` as an optional peer dependency
- [x] Added `dcpWarning` configuration flag with default value `true`

## In Progress
- [x] Implementation of DCP integration logic (not yet shown in this diff)

## Blockers
- DCP integration implementation requires additional code changes to utilize the optional dependency

## Next Steps
1. Implement DCP integration logic in relevant modules
2. Add documentation for DCP configuration options
