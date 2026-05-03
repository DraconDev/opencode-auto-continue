# opencode-auto-force-resume

OpenCode plugin that automatically detects stalled sessions and recovers via `cancel` + `continue`, with optional context compression fallback.

## Why

OpenCode sessions can stall due to context bloat, tool call loops, or provider throttling. This plugin detects prolonged silence and performs recovery:

1. Detect that the session has been silent for too long (default: 3 minutes)
2. Send `cancel` to interrupt the broken turn
3. Wait 1.5 seconds
4. Send `continue` to start fresh
5. If that fails, try context compression (`/compact` + `continue`)

## Installation

### npm (recommended)

```bash
npm install opencode-auto-force-resume
```

### GitHub

```bash
npm install github:draconf/opencode-auto-force-resume
```

### Local plugin

Copy `opencode-auto-force-resume.ts` to your `~/.config/opencode/plugins/` directory. No npm install needed.

## Configuration

Add to your `opencode.json` plugins array:

```json
{
  "plugin": [
    ["opencode-auto-force-resume", {
      "stallTimeoutMs": 180000,
      "cancelWaitMs": 1500,
      "maxRecoveries": 10,
      "cooldownMs": 300000,
      "enableCompressionFallback": true
    }]
  ]
}
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `stallTimeoutMs` | `180000` | Time (ms) without activity before triggering recovery. Default 3 minutes accommodates slow reasoning models. |
| `cancelWaitMs` | `1500` | Pause (ms) between sending `cancel` and `continue`. |
| `maxRecoveries` | `10` | Maximum recovery attempts per session before giving up. |
| `cooldownMs` | `300000` | Cooldown (ms) between recovery cycles. Prevents rapid repeated attempts. |
| `enableCompressionFallback` | `true` | If standard recovery fails, try `/compact` then `continue`. |

## Recovery Flow

```
[Stall detected]
     ↓
Send "cancel" → interrupt broken turn
     ↓
Wait 1.5s (let cancel land)
     ↓
Send "continue" → fresh start
     ↓
If failed and enableCompressionFallback:
     ↓
Send "/compact" → compress context
     ↓
Wait 2s
     ↓
Send "continue" → resume from compressed state
```

## Events

**Activity events that reset the stall timer:**
- `message.part.updated`
- `message.part.added`
- `message.updated`
- `message.created`
- `step.finish`
- `session.status`

**Stale events that clear session state:**
- `session.idle`
- `session.error`
- `session.compacted`
- `session.ended`

## License

MIT