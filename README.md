# opencode-auto-force-resume

The ultimate OpenCode plugin for session recovery. Intelligently detects stalled sessions, recovers them, reminds about open tasks, and reviews completed work — all in one plugin.

## Why

OpenCode sessions can stall due to context bloat, tool call loops, or provider throttling. This plugin monitors session activity and performs automatic recovery only when the session is truly stuck. It also replaces `opencode-todo-reminder` and `opencode-auto-review-completed-todos` with a unified, conflict-free implementation.

## Key Features

### Stall Recovery
- **Smart stall detection** — Only recovers if `session.status()` shows `busy` AND no real progress for the timeout period
- **Status polling after abort** — Polls `session.status()` until session becomes `idle` before sending continue
- **Progress tracking** — Tracks text, step-finish, step-start, reasoning, tool, subtask, and file parts as real progress
- **Synthetic filtering** — Ignores synthetic messages to prevent infinite loops
- **Plan awareness** — Detects plan content and pauses stall monitoring during planning
- **Compaction awareness** — Detects context compaction and pauses stall monitoring during compaction

### Todo Context (Replaces `opencode-todo-reminder`)
- **Todo fetching** — Fetches open todos before sending continue message
- **Context-aware messages** — Includes pending task count and names in recovery message
- **Loop protection** — Max 3 auto-submits without user engagement, resets when user sends a message
- **Configurable messages** — Customize continue message format with template variables

### Review on Completion (Replaces `opencode-auto-review-completed-todos`)
- **Auto-review** — Sends review prompt when all todos are completed
- **Debounced** — 500ms debounce to avoid premature triggering
- **One-shot** — Only fires once per session

### Recovery Safety
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
      "maxAutoSubmits": 3,
      "continueMessage": "Please continue from where you left off.",
      "continueWithTodosMessage": "Please continue from where you left off. You have {pending} open task(s): {todoList}.",
      "maxAttemptsMessage": "I've tried to continue several times but haven't seen progress. Please send a new message when you're ready to continue.",
      "includeTodoContext": true,
      "reviewOnComplete": true,
      "reviewMessage": "All tasks in this session have been completed. Please perform a final review: summarize what was accomplished, note any technical decisions or trade-offs made, flag anything that should be documented, and list any follow-up tasks or improvements for next time.",
      "reviewDebounceMs": 500,
      "showToasts": false,
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
| `maxAutoSubmits` | `3` | Max auto-submits without user engagement before pausing. |
| `continueMessage` | `"Please continue..."` | Default continue message (used when no todos or todos disabled). |
| `continueWithTodosMessage` | `"Please continue... You have {pending}..."` | Continue message when todos are present. |
| `maxAttemptsMessage` | `"I've tried to continue..."` | Message shown when max attempts reached. |
| `includeTodoContext` | `true` | Whether to fetch and include todo context in messages. |
| `reviewOnComplete` | `true` | Whether to send review prompt when all todos complete. |
| `reviewMessage` | `"All tasks completed..."` | Review prompt message. |
| `reviewDebounceMs` | `500` | Debounce time (ms) before triggering review after todos complete. |
| `showToasts` | `false` | Show toast notifications (if TUI supports it). |
| `debug` | `false` | Enable debug logging to `~/.opencode/logs/auto-force-resume.log` |

## Template Variables

Use these in message templates:

| Variable | Description |
|----------|-------------|
| `{pending}` | Number of open tasks |
| `{total}` | Total tasks |
| `{completed}` | Completed tasks |
| `{todoList}` | Comma-separated list of pending tasks (max 5) |
| `{attempts}` | Current recovery attempt |
| `{maxAttempts}` | Max recovery attempts |

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
YES → Fetch todos (if enabled)
      ↓
Build context-aware message
      ↓
Call session.abort()
      ↓
Poll session.status() until "idle" (or timeout)
      ↓
Wait minimum time (waitAfterAbortMs)
      ↓
Send continue prompt with todo context
      ↓
Increment attempts, restart monitoring (event-driven)
```

## Review Flow

```
[Todo updated]
      ↓
All todos completed?
      ↓
YES → Start debounce timer (reviewDebounceMs)
      ↓
Timer fires → Send review prompt
      ↓
Flag review as fired (one-shot per session)
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

### Synthetic Filtering

The plugin ignores messages with `synthetic: true` to prevent infinite loops. When the plugin sends its own continue prompt with `synthetic: true`, the resulting events are filtered out and do not reset the stall timer.

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
- Filters synthetic messages to prevent loops

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

**Todo events:**
- `todo.updated` → checks completion status, triggers review if all done

## Debug Logging

When `debug: true` is set in config, all plugin activity is logged to `~/.opencode/logs/auto-force-resume.log`. This includes:
- Session status changes
- Progress event types
- Recovery attempts and outcomes
- Todo fetch results
- Config validation failures

Logs use `appendFileSync` for thread safety.

## Cleanup

The plugin registers a `dispose` handler that:
- Sets `isDisposed` flag to prevent new recovery attempts
- Clears all active timers (stall timers and review debounce timers)
- Clears the sessions map

## License

MIT