# Project State

## Current Focus
Improved nudge scheduling logic to avoid interrupting when the AI is asking questions

## Context
The nudge system was previously interrupting users even when the AI was actively asking for input, which could be disruptive. This change adds question detection to prevent nudges during interactive exchanges.

## Completed
- [x] Added question phrase detection for nudge suppression
- [x] Implemented check for last assistant message being a question
- [x] Added early return if question detected in nudge scheduling

## In Progress
- [ ] No active work in progress

## Blockers
- None identified

## Next Steps
1. Verify the question detection works in various conversation scenarios
2. Consider adding more question patterns if needed
