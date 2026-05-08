# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [7.8.0] - 2026-05-08

### Added

- **Plan-Driven Auto-Continue**: When the AI runs out of todos, it reads a plan document and continues working on the next item
  - **Automatic plan discovery**: Searches for `PLAN.md`, `ROADMAP.md`, `.opencode/plan.md`, `README.md`, `TODO.md` in that order
  - **Progress tracking**: Reports plan completion percentage and current phase
  - **Auto-mark complete**: Optionally marks plan items as complete when corresponding todos finish (`planAutoMarkComplete`)
  - **Duplicate prevention**: Tracks `lastPlanItemDescription` to avoid sending the same continue message twice
- **Plan Module** (`src/plan.ts`): Parse and manage plan documents
  - `parsePlan()`: Extracts phases and items from markdown with checkbox format (`- [ ] item`)
  - `buildPlanContinueMessage()`: Generates continue prompt with progress and upcoming items
  - `markPlanItemComplete()`: Fuzzy-matches todo content to plan items and marks them complete
- **Plan Configuration Options**:
  - `planDrivenContinue`: Enable/disable plan-driven auto-continue (default: false)
  - `planFilePath`: Custom plan file path, relative or absolute (default: null, auto-discover)
  - `planAutoMarkComplete`: Auto-mark plan items when todos complete (default: true)
  - `planMaxItemsPerContinue`: Max items to show in continue message (default: 3)
- **Review Loop**: Review message now prompts AI to run tests and create fix todos
  - If tests fail, AI creates fix todos
  - When fix todos complete, review fires again
  - `reviewFired` resets when new todos created after review, enabling test-fix loop

### Changed

- **Nudge module**: When no pending todos and `planDrivenContinue` enabled, checks plan file and sends continue message
- **Default review message**: Now focuses on running tests and creating fix todos instead of general review
- **Session state**: Added `lastPlanItemDescription` field for deduplication

## [7.5.0] - 2026-05-07

### Added

- **Session Monitor Module** (`src/session-monitor.ts`): Passive monitoring layer for session lifecycle gaps
  - **Orphan Parent Detection**: Detects when subagent finishes but parent stays stuck as "busy"
    - Monitors busyCount via 5s timer, detects drop from >1 to 1
    - Waits `orphanWaitMs` (15s default) for natural parent resume
    - Triggers recovery (abort + continue) if parent still stuck
  - **Session Discovery**: Periodic `session.list()` polling every 60s for missed sessions
    - Creates minimal SessionState for untracked busy sessions
    - Integrates seamlessly with existing recovery/nudge timers
  - **Idle Session Cleanup**: Prevents memory leaks in long-running OpenCode instances
    - Removes sessions idle > `idleCleanupMs` (10min default)
    - Enforces `maxSessions` limit (50 default) - removes oldest idle first
- **Session Monitor Config Options**:
  - `sessionMonitorEnabled`: Enable/disable session monitor (default: true)
  - `orphanWaitMs`: Wait after subagent finish before treating parent as orphan (default: 15000)
  - `sessionDiscoveryIntervalMs`: Polling interval for session discovery (default: 60000)
  - `idleCleanupMs`: Remove idle sessions after this time (default: 600000)
  - `maxSessions`: Max sessions to keep in memory (default: 50)
- **Session Monitor Integration**: Full integration with existing event system
  - `touchSession()` called on session.created, session.status, message.part.updated
  - Shares sessions Map with all other modules
  - Timer-based (5s, 30s, 60s), not event-driven

### Changed

- **Event handler wiring**: Added sessionMonitor.start() on plugin init, sessionMonitor.stop() on dispose
- **State management**: SessionState now includes `parentSessionId` for tracking subagent relationships

### Fixed

- **Memory leak**: Sessions no longer accumulate forever - idle sessions cleaned up automatically
- **Orphan parents**: Parent sessions stuck after subagent completion now recovered automatically

## [6.62.0] - 2026-05-07

### Added

- **Custom Prompts (Per-Session API)**: Programmatically send dynamic, context-aware prompts to specific sessions
  - New `sendCustomPrompt(sessionId, options)` function exported from main module
  - Full template variable support: `{pending}`, `{todoList}`, `{contextSummary}`, `{attempts}`, `{maxAttempts}`, `{total}`, `{completed}`
  - Optional todo context injection via `includeTodoContext`
  - Optional session context summary via `includeContextSummary`
  - Custom prompt text via `customPrompt` parameter
  - Returns rendered message, todo list, and custom prompt for verification
- **Template variable expansion**: `buildRecoveryMessage()` and `buildNudgeMessage()` now support custom prompts and context summaries
- **Integration points**: Recovery and nudge modules both support custom prompt parameters

### Changed

- **Message building**: Recovery and nudge message builders now accept optional `customPrompt` and `includeContextSummary` parameters
- **Context summary**: Session state summaries now available in custom prompts via `{contextSummary}` template variable

## [2.0.0] - 2025-05-03

### Changed

- **Simplified recovery flow**: Removed compression fallback for simplicity
- **Config options**: `stallTimeoutMs` and `waitAfterAbortMs` only
- **Recovery flow**: `session.abort()` → wait → `continue`
- Uses OpenCode SDK's `session.abort()` API for clean interruption
- No text messages sent to chat (avoids UI corruption)

### Removed

- `maxRecoveries`, `cooldownMs`, `enableCompressionFallback` (overcomplicated)
- Compression fallback (can be added back if needed)

## [1.1.0] - 2025-05-03

### Changed

- **Recovery flow**: Now uses `session.abort()` API instead of sending "cancel" text message
  - No longer pollutes chat history with artificial "cancel" messages
  - Cleaner interrupt that doesn't corrupt the OpenCode TUI
  - Renamed `cancelWaitMs` to `continueWaitMs` for clarity

### Fixed

- Bug where sending "cancel" as text corrupted the OpenCode TUI and confused the model

## [1.0.0] - 2025-05-03

### Added

- Initial release
- Stall detection with configurable timeout (default 180s / 3 minutes)
- Recovery flow: `cancel` → wait → `continue`
- Compression fallback: `/compact` → `continue` when standard recovery fails
- Session state tracking with cooldown between recovery attempts
- Configurable options:
  - `stallTimeoutMs`: Time without activity before recovery (default: 180000)
  - `cancelWaitMs`: Pause between cancel and continue (default: 1500)
  - `maxRecoveries`: Maximum attempts per session (default: 10)
  - `cooldownMs`: Cooldown between recovery cycles (default: 300000)
  - `enableCompressionFallback`: Enable /compact fallback (default: true)
- Activity event monitoring for session state management
- Stale event handling for automatic session cleanup
- Unit tests with Vitest (24 tests covering core functionality)
- CI/CD with GitHub Actions for automated testing
- Automated npm publishing and GitHub release creation on tag push