# Project State

## Current Focus
Improved documentation for nudge cooldown behavior in idle session handling

## Context
This change clarifies how the `nudgeCooldownMs` setting applies to both session idle events and busy→idle transitions, ensuring consistent behavior across different session state changes.

## Completed
- [x] Updated documentation to explicitly state that `nudgeCooldownMs` applies to both session idle events and busy→idle transitions

## In Progress
- [x] Documentation update for nudge cooldown behavior

## Blockers
- None identified

## Next Steps
1. Verify that the updated documentation matches the actual implementation behavior
2. Consider if additional documentation is needed for other related configuration options
