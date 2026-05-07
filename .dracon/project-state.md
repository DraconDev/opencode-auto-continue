# Project State

## Current Focus
Improved recovery prompt selection by prioritizing tool-text detection over plan-aware messages

## Context
The tool-text detection feature was recently added to identify embedded XML/Markdown patterns in sessions. This change ensures these sessions use specialized recovery prompts instead of generic plan-aware messages, improving recovery accuracy for tool-text content.

## Completed
- [x] Added tool-text detection check before plan-aware message logic
- [x] Added specific recovery prompt for tool-text sessions
- [x] Added debug logging for tool-text recovery prompt usage

## In Progress
- [ ] None (this is a complete feature implementation)

## Blockers
- None (this is a complete implementation of the tool-text recovery feature)

## Next Steps
1. Verify recovery prompt quality with test cases containing tool-text
2. Monitor recovery success rates for tool-text sessions in production
