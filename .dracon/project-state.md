# Project State

## Current Focus
Prevent compaction during active planning to avoid disrupting ongoing session operations.

## Context
The system was compacting sessions even when planning was in progress, which could interrupt active operations. This change ensures compaction only occurs when the session is idle.

## Completed
- [x] Added check to skip compaction when `s.planning` is true

## In Progress
- [x] None (this is a focused bug fix)

## Blockers
- None (this is a straightforward addition)

## Next Steps
1. Verify no regression in compaction timing
2. Update documentation if needed
