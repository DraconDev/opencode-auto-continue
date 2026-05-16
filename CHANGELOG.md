# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [7.14.41] - 2026-05-16

### Changed

- **Dangerous commands policy injection moved to system prompt**: Previously injected via `session.prompt` on `session.created`, which caused the AI to waste its first turn acknowledging the policy instead of responding to the user's actual request. Now uses `experimental.chat.system.transform` hook to inject the policy into the system prompt — visible to the AI every turn but no wasted turn on session start.

### Fixed

- **Proactive compaction gap during idle**: The normal `session.idle` path (no recovery queued) only ran opportunistic compaction, not proactive compaction. Added `refreshRealTokens` + `maybeProactiveCompact` to the normal idle path so the 80k threshold is re-checked after long silent periods.

## [7.14.37] - 2026-05-16

### Fixed

- **Post-compaction token drift** (`getTokenCount()`): After repeated compactions, `estimatedTokens` could drift below compaction thresholds because the reduction factor was applied each cycle while accumulation undershot (assistant message text estimation skipped when `info.tokens` unavailable). Compaction would stop firing despite the context growing. Fixed by using `Math.max(estimatedTokens, realTokens - realTokensBaseline)` — DB growth since last compaction acts as a floor.

## [7.8.1852] - 2026-05-14

### Added

- **Test-Driven Quality Gate (TDQG)**: New `test-runner.ts` module automatically runs configured test commands (`cargo test` by default) before nudges and review.
  - **Test-on-idle**: Runs tests before every nudge. If tests fail, the nudge message becomes "fix these failures" — blocking other work until tests pass.
  - **Test-on-review**: Runs tests before the review prompt. Output injected via `{testOutput}` template variable so the plan agent can analyze failures.
  - **TDD enforcement**: Continue/nudge/review messages now instruct the AI to "write a test first, then implement."

### Changed

- **Review routed to plan agent**: Review prompts now use `agent: "plan"` instead of default — engineer vs construction worker analogy.
- **Default messages updated**: `continueMessage`, `continueWithTodosMessage`, and `reviewMessage` include TDD instructions and `{testOutput}` template.

## [7.8.1842] - 2026-05-14

### Changed

- **Review routed to plan agent**: Review prompts now use `agent: "plan"` instead of default. The smarter "plan" agent reviews completed work instead of the execution-focused "build" agent — engineer vs construction worker analogy.

## [7.8.1841] - 2026-05-14

### Changed

- **Raised compaction thresholds**: opportunistic 40k→60k, proactive 60k→80k, hard 80k→100k. Compaction fires less frequently (20k higher on all layers).
- **`autoAnswerQuestions` default**: Changed from `true` to `false`. Users must explicitly opt in to auto-answer AI questions.

### Added

- **OpenCode question blocking**: Added `"permission": { "question": "deny" }` to opencode.json to disable OpenCode's question-asking feature entirely. Questions were blocking autonomous flow — this stops them at the source.

## [7.8.331] - 2026-05-12

### Fixed

- **Critical: cleanupIdleSessions dangling timers** — Now clears `timer`, `nudgeTimer`, and `reviewDebounceTimer` before deleting idle sessions. Prevents zombie sessions from resurrecting when stale timers fire.
- **Critical: session.compacted continue not sent** — After emergency compaction, now directly queues and sends continue via `review.sendContinue()` instead of relying on subsequent idle event that may never fire.
- **High: Double token counting for assistant messages** — Skip token estimation when `msgRole === 'assistant'` since actual tokens arrive via `message.updated`. Prevents inflated estimates triggering premature compaction.
- **High: Discovered sessions timeout too long** — Use `Math.min(stallTimeoutMs, 30000)` for faster detection of already-stuck sessions discovered via `session.list()` polling.
- **Medium: actionStartedAt never resets** — Reset `actionStartedAt = 0` when session goes idle. Fixes incorrect elapsed time for sessions oscillating between busy/idle.
- **Medium: lastNudgeAt not updated in custom prompts** — Set `lastNudgeAt = Date.now()` when sending custom prompts to prevent immediate nudge after custom prompt.
- **Medium: lastKnownStatus stale on error** — Set `lastKnownStatus = 'error'` on `MessageAbortedError` to prevent stale status misleading orphan detection.

### Removed

- **Dead code: event-router.ts** — Removed 424-line unused parallel implementation that was never imported. Eliminates maintenance hazard and code drift.
- **Dead config: Plan-driven continue options** — Removed `planDrivenContinue`, `planFilePath`, `planAutoMarkComplete`, `planMaxItemsPerContinue` from config interface and defaults. These options were never wired into the recovery flow.

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
  - `reviewFired` is permanent per session (one-shot) — verified against source code

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