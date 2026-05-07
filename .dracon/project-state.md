# Project State

## Current Focus
Added warning toast for users when Dynamic Context Pruning (DCP) is not installed

## Context
The project now detects when DCP is not installed and provides a user-friendly warning to encourage installation of the `@tarquinen/opencode-dcp` plugin for better context management.

## Completed
- [x] Added DCP detection check
- [x] Implemented warning toast when DCP is not detected
- [x] Added configuration option for DCP warning
- [x] Made toast display asynchronous to avoid blocking plugin initialization

## In Progress
- [x] Implementation of DCP warning system

## Blockers
- None identified

## Next Steps
1. Verify toast message content and timing
2. Test with users to ensure the warning is helpful and not intrusive
