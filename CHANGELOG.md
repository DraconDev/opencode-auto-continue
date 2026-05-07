# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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