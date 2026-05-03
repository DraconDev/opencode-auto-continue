# opencode-auto-force-resume

Intelligently detects and recovers stalled OpenCode sessions using `session.abort()` + `continue` prompt.

## Why

OpenCode sessions can stall due to context bloat, tool call loops, or provider throttling. This plugin monitors session activity and performs automatic recovery only when the session is truly stuck.

## Key Features

- **Smart stall detection** — Only recovers if `session.status()` shows `busy` AND no real progress for the timeout period
- **Status polling after abort** — Polls `session.status()` until session becomes `idle` before sending continue
- **Progress tracking** — Tracks `message.part.delta`, `step-finish`, and `reasoning` parts as real progress
- **Recovery limits** — Max 3 attempts per session with 60-second cooldown between attempts
- **User cancellation detection** — Stops recovery after user manually aborts (ESC key)
- **Silent operation** — No console spam or UI corruption

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
      "waitAfterAbortMs": 1500,
      "maxRecoveries": 3,
      "cooldownMs": 60000,
      "abortPollIntervalMs": 200,
      "abortPollMaxTimeMs": 5000,
      "abortPollMaxFailures": 3
    }]
  ]
}
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `stallTimeoutMs` | `180000` | Time (ms) without activity before triggering recovery. Default 3 minutes accommodates slow reasoning models. |
| `waitAfterAbortMs` | `1500` | Minimum pause (ms) between `session.abort()` and `continue`. |
| `maxRecoveries` | `3` | Maximum recovery attempts per session before giving up. |
| `cooldownMs` | `60000` | Time (ms) between recovery attempts. Prevents spam. |
| `abortPollIntervalMs` | `200` | How often to poll `session.status()` after abort (ms). |
| `abortPollMaxTimeMs` | `5000` | Maximum time to poll for idle status after abort (ms). |
| `abortPollMaxFailures` | `3` | Max consecutive `session.status()` failures before giving up on polling. |

## Recovery Flow

```
[Activity detected]
      ↓
Set stall timer (stallTimeoutMs)
      ↓
Timer fires → Check session.status()
      ↓
Status === "busy" AND lastProgressAt is old?
      ↓
YES → Call session.abort()
      ↓
Poll session.status() until "idle" (or timeout)
      ↓
Wait minimum time (waitAfterAbortMs)
      ↓
Send "continue" via promptAsync()
      ↓
Increment attempts, restart monitoring
```

## How It Works

### Stall Detection

The plugin only considers a session "stuck" when:
1. `session.status()` returns `busy` (not idle or retry)
2. No real progress events for `stallTimeoutMs`

Real progress events:
- `message.part.delta` — AI generating text
- `message.part.updated` with `step-finish` part — turn completed
- `message.part.updated` with `reasoning` part — reasoning content
- `session.status` with `busy` — actively working

### Recovery Safety

- Won't recover idle sessions
- Won't recover sessions with recent progress
- Won't recover after user aborts (ESC key)
- Gives up after `maxRecoveries` attempts
- Waits `cooldownMs` between attempts
- Polls until session is ready before sending continue

## Events

**Progress events that reset stall timer and update lastProgressAt:**
- `message.part.delta`
- `message.part.updated` (text, step-finish, reasoning only)
- `session.status` (when busy)

**Activity events that reset stall timer:**
- `message.created`
- `message.part.added`
- `session.created`

**Stale events that clear session state:**
- `session.idle`
- `session.error` (MessageAbortedError sets userCancelled)
- `session.compacted`
- `session.ended`
- `session.deleted`

## Cleanup

The plugin registers a `dispose` handler that clears all active timers when OpenCode unloads the plugin, preventing memory leaks.

## License

MIT