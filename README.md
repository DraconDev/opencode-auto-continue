# opencode-auto-force-resume

Intelligently detects and recovers stalled OpenCode sessions using `session.abort()` + `continue` prompt.

## Why

OpenCode sessions can stall due to context bloat, tool call loops, or provider throttling. This plugin monitors session activity and performs automatic recovery only when the session is truly stuck.

## Key Features

- **Smart stall detection** — Only recovers if `session.status()` shows `busy` AND no real progress for the timeout period
- **Status polling after abort** — Polls `session.status()` until session becomes `idle` before sending continue
- **Progress tracking** — Tracks text, step-finish, step-start, reasoning, tool, subtask, and file parts as real progress
- **Plan awareness** — Detects plan content and pauses stall monitoring during planning
- **Compaction awareness** — Detects context compaction and pauses stall monitoring during compaction
- **Recovery limits** — Max 3 attempts per session with 60-second cooldown between attempts
- **Exponential backoff** — After maxRecoveries, uses exponential backoff up to 30 minutes
- **User cancellation detection** — Stops recovery after user manually aborts (ESC key)
- **Silent operation** — File-based debug logging only, no console spam or UI corruption

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

Copy `opencode-auto-force-resume.js` to your `~/.config/opencode/plugins/` directory. No npm install needed.

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
      "abortPollMaxFailures": 3,
      "maxBackoffMs": 1800000,
      "debug": false
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
| `maxBackoffMs` | `1800000` | Maximum backoff delay (ms) after maxRecoveries. Default 30 minutes. |
| `debug` | `false` | Enable debug logging to `~/.opencode/logs/auto-force-resume.log` |

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
Send "continue from where you left off" via prompt()
      ↓
Increment attempts, restart monitoring (event-driven)
```

## How It Works

### Stall Detection

The plugin only considers a session "stuck" when:
1. `session.status()` returns `busy` (not idle or retry)
2. No real progress events for `stallTimeoutMs`

Real progress events:
- `message.part.updated` with `text` part — AI generating text
- `message.part.updated` with `step-finish` part — turn completed
- `message.part.updated` with `step-start` part — new step started
- `message.part.updated` with `reasoning` part — reasoning content
- `message.part.updated` with `tool` part — tool execution
- `message.part.updated` with `subtask` part — subtask created/completed
- `message.part.updated` with `file` part — file operation
- `session.status` with `busy` — actively working

### Plan Detection

The plugin monitors for plan content in text parts and delta updates. When plan content is detected, stall monitoring is paused — the user must address the plan before monitoring resumes.

Plan detection patterns include: "here is my plan", "## plan", "step 1:", numbered lists, checkbox lists, etc.

### Compaction Detection

When `message.part.updated` with `compaction` part is received, stall monitoring is paused until the session becomes busy again (indicating compaction finished).

### Recovery Safety

- Won't recover idle sessions
- Won't recover sessions with recent progress
- Won't recover during planning or compaction
- Won't recover after user aborts (ESC key)
- Gives up after `maxRecoveries` attempts
- Waits `cooldownMs` between attempts
- Polls until session is ready before sending continue
- Uses exponential backoff after maxRecoveries

## Debug Logging

When `debug: true` is set in config, all plugin activity is logged to `~/.opencode/logs/auto-force-resume.log`. This includes:
- Session status changes
- Progress event types
- Recovery attempts and outcomes
- Config validation failures

Logs use `appendFileSync` for thread safety.

## Events

**Progress events that reset stall timer and update lastProgressAt:**
- `message.part.updated` (text, step-finish, step-start, reasoning, tool, subtask, file)
- `session.status` (when busy)

**Activity events that reset stall timer:**
- `message.created`
- `message.part.added`
- `session.created`

**Pause/resume events:**
- `message.part.updated` with `compaction` part → pauses monitoring
- `message.part.updated` with plan text → pauses monitoring
- `message.created` (user message) → resumes monitoring

**Stale events that clear session state:**
- `session.idle`
- `session.error` (MessageAbortedError sets userCancelled)
- `session.compacted`
- `session.ended`
- `session.deleted`

## Cleanup

The plugin registers a `dispose` handler that:
- Sets `isDisposed` flag to prevent new recovery attempts
- Clears all active timers
- Clears the sessions map

## License

MIT