# Project State

## Current Focus
Enhanced session recovery prompt with synthetic flag and empty directory fallback

## Context
This change improves the auto-force-resume plugin's session recovery behavior by:
1. Adding a synthetic flag to recovery prompts for better tracking
2. Adding a fallback for empty directory values to prevent undefined errors

## Completed
- [x] Added `synthetic: true` flag to recovery prompt parts
- [x] Added fallback for empty directory values in prompt query

## In Progress
- [x] No active work in progress

## Blockers
- None identified

## Next Steps
1. Verify the synthetic flag is properly handled by downstream systems
2. Test the empty directory fallback with various session recovery scenarios
