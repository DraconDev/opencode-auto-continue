# Project State

## Current Focus
Improved nudge injection with optional pre-fetched todos to reduce redundant data fetching

## Context
The nudge system was previously injecting nudges without access to pre-fetched todo data, leading to potential redundant API calls. This change allows passing known todos directly to the nudge injection to improve performance.

## Completed
- [x] Added optional `knownTodos` parameter to `scheduleNudge` function
- [x] Updated `injectNudge` call to pass the optional todos parameter

## In Progress
- [ ] Testing the performance impact of this change in different scenarios

## Blockers
- Need to verify if the optional parameter breaks any existing nudge triggers

## Next Steps
1. Run performance tests with and without the pre-fetched todos
2. Verify backward compatibility with existing nudge triggers
