# opencode-auto-force-resume

OpenCode plugin that automatically detects stalled sessions and recovers via `cancel` + `continue`, with optional context compression fallback.

## Why

OpenCode sessions can stall due to context bloat, tool call loops, or provider throttling. The standard `opencode-auto-resume` plugin only sends `continue` into a broken state, which doesn't help if the model is stuck in a reasoning loop or context overflow.

This plugin implements the same workflow you would do manually:
1. Detect that the session has been silent for too long (configurable, default 3 minutes)
2. Send `cancel` to interrupt the broken turn
3. Wait 1.5 seconds
4. Send `continue` to start fresh
5. If that fails, try context compression (`/compact` + `continue`)

## Installation

### Option 1: Install from npm (recommended)

```bash
npm install opencode-auto-force-resume
```

### Option 2: Install from GitHub

```bash
npm install github:draconf/opencode-auto-force-resume
```

### Option 3: Local plugin (no install)

If you want to use it without publishing, copy `opencode-auto-force-resume.ts` to your `~/.config/opencode/plugins/` directory.

## Configuration

Add to your `opencode.json` plugins array:

```json
{
  "plugin": [
    "@mohak34/opencode-notifier@latest",
    "opencode-todo-reminder",
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

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `stallTimeoutMs` | `180000` | Time (ms) without activity before triggering recovery. Default 3 minutes gives even slow reasoning models time to respond. |
| `cancelWaitMs` | `1500` | Pause (ms) between sending `cancel` and `continue`. |
| `maxRecoveries` | `10` | Maximum recovery attempts per session before giving up. |
| `cooldownMs` | `300000` | Cooldown (ms) between recovery cycles. Prevents rapid repeated attempts. |
| `enableCompressionFallback` | `true` | If standard recovery fails, try `/compact` then `continue`. |

## How It Works

1. **Activity Monitoring** — Watches for SSE events (`message.part.updated`, `message.created`, `step.finish`, etc.). Any activity resets the stall timer.

2. **Stall Detection** — If no activity for `stallTimeoutMs`, recovery begins.

3. **Recovery Flow**:
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

4. **Cooldown** — After a recovery attempt, the plugin waits `cooldownMs` before attempting again. This prevents hammering a stuck session.

## Comparison with opencode-auto-resume

| Feature | opencode-auto-resume | opencode-auto-force-resume |
|---------|---------------------|---------------------------|
| First action on stall | `continue` | `cancel` then `continue` |
| Interrupt broken turn | No | Yes |
| Compression fallback | No | Yes (optional) |
| Max retries | 3 (default) | 10 (configurable) |
| Timeout | 18s (too aggressive) | 180s (safe for reasoning models) |
| Recovery per session | Multiple, with backoff | Up to 10, with 5min cooldown |

## Events That Reset the Stall Timer

- `message.part.updated`
- `message.part.added`
- `message.updated`
- `message.created`
- `step.finish`
- `session.status`

## Events That Clear Session State

- `session.idle`
- `session.error`
- `session.compacted`
- `session.ended`

## License

MIT