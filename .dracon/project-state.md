# Project State

## Current Focus
Improved documentation for session idle handling in AutoForceResumePlugin

## Context
The recent feature work added automatic nudging for idle sessions with pending todos, but the documentation needed clarification about how `session.idle` events should trigger nudges (excluding terminal sessions) while `session.deleted` should clear all session state.

## Completed
- [x] Updated README.md to clarify that `session.idle` triggers nudges for non-terminal sessions while `session.deleted` clears all session state

## In Progress
- [x] Documentation updates for session idle handling

## Blockers
- None identified

## Next Steps
1. Verify the documentation change aligns with the latest implementation
2. Consider additional documentation improvements for other session state transitions
