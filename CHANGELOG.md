# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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