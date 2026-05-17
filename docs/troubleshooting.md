# Troubleshooting

> Troubleshooting guide and migration notes for opencode-auto-continue.
> See [README.md](../README.md) for installation and quick start.

## Troubleshooting

### Plugin Not Loading / "Cannot find module"

**Cause**: Missing `package.json` in plugin directory or incorrect path
**Fix**:
1. Ensure plugin files are in `~/.config/opencode/plugins/opencode-auto-continue/`
2. Create `package.json` in that directory:
   ```json
   {
     "name": "opencode-auto-continue",
     "version": "7.8.235",
     "main": "./index.js"
   }
   ```
3. Ensure `opencode.json` uses correct name: `["opencode-auto-continue", { ... }]`
4. Restart OpenCode after making changes

### Plugin Not Registered in Config

**Cause**: Plugin not added to `plugin` array in `opencode.json`
**Fix**: Add to `~/.config/opencode/opencode.json`:
```json
{
  "plugin": [
    ["opencode-auto-continue", {
      "stallTimeoutMs": 45000,
      "maxRecoveries": 3
    }]
  ]
}
```

### UI Breaks / Freezes

**Cause**: Another plugin sending prompts with `synthetic: false`
**Fix**: Remove other prompt-sending plugins (todo-reminder, auto-review)

### Infinite Recovery Loops

**Cause**: Events not being filtered
**Fix**: Ensure `synthetic: true` is set on all prompts (our plugin does this automatically)

### Recovery Not Triggering

**Cause**: Session not staying busy long enough
**Fix**: Reduce `stallTimeoutMs` (e.g., 60000 for 1 minute)

### Too Aggressive

**Cause**: Timeout too short
**Fix**: Increase `stallTimeoutMs` (e.g., 300000 for 5 minutes)

### Status File Not Updating

**Cause**: `statusFileEnabled: false` or disk full
**Fix**: Check config or disk space

### Terminal Title Not Showing

**Cause**: Terminal doesn't support OSC sequences
**Fix**: Use iTerm2, WezTerm, Windows Terminal, or Ghostty

### Terminal Progress Not Showing

**Cause**: Terminal doesn't support OSC 9;4
**Fix**: Use iTerm2 (3.6.6+), WezTerm, Windows Terminal, or Ghostty


## Migration Guide

### From `opencode-todo-reminder`

Remove from `opencode.json`:
```json
// REMOVE THIS:
"opencode-todo-reminder"
```

Our plugin provides:
- ✅ Todo-aware messages
- ✅ Loop protection
- ✅ User abort handling
- ❌ Toast notifications (install `@mohak34/opencode-notifier` separately)

### From `opencode-auto-review-completed-todos`

Remove from `opencode.json`:
```json
// REMOVE THIS:
"opencode-auto-review-completed-todos"
```

Our plugin provides:
- ✅ Review on completion
- ✅ Debounced triggering
- ✅ One-shot per session

### From `opencode-timer-plugin`

Our plugin provides terminal title updates automatically:
```json
["opencode-auto-continue", {
  "terminalTitleEnabled": true
}]
```

**Note**: For toast notifications, install a separate notification plugin:
```bash
opencode plugin @mohak34/opencode-notifier@latest --global
```


## Status File

The plugin writes a real-time JSON status file for external monitoring.

### Location

- Default: `~/.opencode/logs/auto-force-resume.status`
- Custom: Set `statusFilePath` in config

### Monitoring

```bash
# Watch status file updates
watch -n 1 'cat ~/.opencode/logs/auto-force-resume.status'

# Or use tail
tail -f ~/.opencode/logs/auto-force-resume.status

# Pretty print with jq
watch -n 1 'cat ~/.opencode/logs/auto-force-resume.status | jq .'
```

### Example Output

```json
{
  "version": "6.61.0",
  "timestamp": "2026-05-05T13:00:00.000Z",
  "sessions": {
    "abc123": {
      "elapsed": "5m 32s",
      "status": "active",
      "recovery": {
        "attempts": 2,
        "successful": 1,
        "failed": 0,
        "lastAttempt": "2026-05-05T12:58:00.000Z",
        "lastSuccess": "2026-05-05T12:55:00.000Z",
        "inBackoff": false,
        "backoffAttempts": 0,
        "nextRetryIn": null,
        "avgRecoveryTime": "3s",
        "recoveryRate": "100%",
        "histogram": {
          "min": "1s",
          "max": "12s",
          "median": "3s",
          "samples": 15
        }
      },
      "stall": {
        "detections": 3,
        "lastDetectionAt": "2026-05-05T12:58:00.000Z",
        "lastPartType": "reasoning",
        "patterns": [
          {"type": "tool", "count": 15},
          {"type": "reasoning", "count": 8},
          {"type": "text", "count": 5}
        ]
      },
      "compaction": {
        "proactiveTriggers": 0,
        "tokenLimitTriggers": 2,
        "successful": 1,
        "lastCompactAt": "2026-05-05T12:50:00.000Z",
        "estimatedTokens": 85000,
        "threshold": 100000
      },
      "nudge": {
        "sent": 1,
        "lastNudgeAt": "2026-05-05T12:45:00.000Z"
      },
      "todos": {
        "hasOpenTodos": true
      },
      "autoSubmits": 1,
      "userCancelled": false,
      "planning": false,
      "compacting": false,
      "sessionCreatedAt": "2026-05-05T12:54:28.000Z",
      "history": [
        {"timestamp": "2026-05-05T12:54:28.000Z", "status": "active", "actionDuration": "idle", "progressAgo": "0s"},
        {"timestamp": "2026-05-05T12:55:00.000Z", "status": "recovering", "actionDuration": "32s", "progressAgo": "32s"}
      ]
    }
  }
}
```

### Status File Fields

| Field | Description |
|-------|-------------|
| `version` | Plugin version |
| `timestamp` | ISO timestamp of last update |
| `sessions.{id}.elapsed` | Total session duration |
| `sessions.{id}.status` | Current status: `active`, `recovering`, `compacting`, `planning` |
| `recovery.attempts` | Total recovery attempts |
| `recovery.successful` | Successful recoveries |
| `recovery.failed` | Failed recoveries |
| `recovery.inBackoff` | Currently in exponential backoff |
| `recovery.nextRetryIn` | Time until next retry attempt |
| `recovery.avgRecoveryTime` | Average recovery duration |
| `recovery.recoveryRate` | Success percentage |
| `recovery.histogram` | Min/max/median recovery times |
| `stall.detections` | Total stall detections |
| `stall.lastPartType` | Part type that preceded last stall |
| `stall.patterns` | Top 5 part types causing stalls |
| `history` | Rolling buffer of recent status snapshots |

### Rotated Status Files

When `statusFileRotate > 0`, old status files are kept:
- `~/.opencode/logs/auto-force-resume.status.1` (most recent archive)
- `~/.opencode/logs/auto-force-resume.status.2`
- etc.
