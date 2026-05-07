# Project State

## Current Focus
Added tool-text detection for recovery prompts in sessions containing embedded XML

## Context
This change improves recovery handling for sessions where tool outputs are embedded as raw text (XML in reasoning). The previous auto-compaction behavior was triggering unnecessarily in these cases.

## Completed
- [x] Added tool-text detection pattern matching
- [x] Modified auto-compaction to skip when tool-text is detected
- [x] Added logging for tool-text detection cases

## In Progress
- [x] Implementation of tool-text recovery logic

## Blockers
- None identified for this specific change

## Next Steps
1. Implement recovery prompt variants for tool-text cases
2. Add integration tests for tool-text recovery scenarios
