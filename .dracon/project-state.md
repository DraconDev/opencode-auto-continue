# Project State

## Current Focus
Improved auto-continue logic for sessions transitioning from busy→idle with pending todos

## Context
The previous auto-continue logic would trigger whenever a session was idle with pending todos, potentially causing unnecessary nudges. This change ensures nudges only occur once per busy→idle transition to prevent duplicate notifications.

## Completed
- [x] Added `wasBusy` flag to track busy→idle transitions
- [x] Modified auto-continue logic to only trigger after a busy→idle transition
- [x] Reset `wasBusy` flag after triggering to prevent repeated nudges

## In Progress
- [x] Implementation of the new transition-based auto-continue logic

## Blockers
- None identified

## Next Steps
1. Verify the new logic prevents duplicate nudges in test scenarios
2. Monitor user feedback for any unintended side effects
