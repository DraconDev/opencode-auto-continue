# Changelog

## 1.0.0 (2025-05-03)

### Added

- Initial release
- Stall detection with configurable timeout (default 180s)
- Recovery flow: cancel → wait → continue
- Compression fallback: /compact → continue
- Session state tracking with cooldown
- Coexists with other plugins without conflicts

### Features

- **stallTimeoutMs**: Time without activity before recovery (default 180000ms / 3 minutes)
- **cancelWaitMs**: Pause between cancel and continue (default 1500ms)
- **maxRecoveries**: Maximum attempts per session (default 10)
- **cooldownMs**: Cooldown between recovery cycles (default 300000ms / 5 minutes)
- **enableCompressionFallback**: Try /compact if standard recovery fails (default true)