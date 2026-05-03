# opencode-auto-force-resume

OpenCode plugin that automatically detects stalled sessions and recovers via `session.abort()` + `continue`.

## Why

OpenCode sessions can stall due to context bloat, tool call loops, or provider throttling. This plugin detects prolonged silence and performs recovery:

1. Detect that the session has been silent for too long (default: 3 minutes)
2. Call `session.abort()` to interrupt the broken turn
3. Wait configurable time
4. Send `continue` to start fresh

## Installation

### npm (recommended)

```bash
npm install opencode-auto-force-resume
```

### GitHub

```bash
npm install github:DraconDev/opencode-auto-force-resume
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
      "waitAfterAbortMs": 1500
    }]
  ]
}
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `stallTimeoutMs` | `180000` | Time (ms) without activity before triggering recovery. Default 3 minutes accommodates slow reasoning models. |
| `waitAfterAbortMs` | `1500` | Pause (ms) between `session.abort()` and `continue`. |

## Recovery Flow

```
[Stall detected]
     ↓
Call session.abort() → interrupt broken turn
     ↓
Wait waitAfterAbortMs
     ↓
Send "continue" → fresh start
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