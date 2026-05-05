# opencode-auto-force-resume

The ultimate OpenCode plugin for session management. **One plugin replaces three**: auto-recovery, todo-reminders, and review-on-completion — all with zero conflicts.

## What It Does

| Feature | Replaces | What It Does |
|---------|----------|--------------|
| **Stall Recovery** | Manual intervention | Detects stuck sessions, aborts them, sends continue |
| **Todo Context** | `opencode-todo-reminder` | Fetches open todos, includes them in recovery messages |
| **Review on Completion** | `opencode-auto-review-completed-todos` | Sends review prompt when all todos are done |
| **Nudger** | Nothing — unique feature | Gentle reminders for idle sessions with open todos |
| **Auto-Compaction** | Nothing — unique feature | Tries context compaction before aborting |

## Why One Plugin?

Running multiple plugins that send prompts creates **event chaos** — each plugin's prompts trigger events that confuse the others, causing infinite loops and UI breakage. This plugin handles everything with a single unified state machine.

## Key Features

### 1. Stall Recovery
- **Smart detection** — Only recovers if `session.status()` shows `busy` AND no real progress for timeout
- **Status polling** — Polls `session.status()` until `idle` before sending continue
- **Progress tracking** — Tracks text, step-finish, reasoning, tool, subtask, file parts
- **Synthetic filtering** — Ignores synthetic messages to prevent infinite loops
- **Plan awareness** — Pauses monitoring when plan content detected
- **Compaction awareness** — Pauses monitoring during context compaction

### 2. Todo Context (Replaces `opencode-todo-reminder`)
- **Fetches todos** before sending continue message
- **Context-aware messages** — *"You have 3 open tasks: fix bug, update docs, refactor"*
- **Loop protection** — Max 3 auto-submits without user engagement
- **Resets on user message** — Counters reset when user actively participates

### 3. Review on Completion (Replaces `opencode-auto-review-completed-todos`)
- **Auto-triggers** when all todos completed
- **Debounced** — 500ms to avoid premature triggering
- **One-shot** — Only fires once per session

### 4. Nudger (Unique)
- **Gentle reminders** for idle sessions with open todos
- **Configurable timeout** — Default 5 minutes
- **Cooldown** — Won't nudge more than once per minute
- **Resets on activity** — User sends message → nudge timer resets

### 5. Auto-Compaction (Unique)
- **Tries compaction first** before aborting stuck session
- **Context bloat fix** — Summarizes session to free up tokens
- **Falls back** — If compaction doesn't help, proceeds with abort+continue

## Installation

### npm

```bash
npm install opencode-auto-force-resume
```

### GitHub

```bash
npm install github:DraconDev/opencode-auto-force-resume
```

### Local

Copy `opencode-auto-force-resume.js` to `~/.config/opencode/plugins/`

## Configuration

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
      "nudgeEnabled": true,
      "nudgeTimeoutMs": 300000,
      "nudgeMessage": "You have {pending} open task(s). Send a message when you're ready to continue.",
      "nudgeCooldownMs": 60000,
      "autoCompact": true,
      "showToasts": false,
      "debug": false
    }]
  ]
}
```

## Options

### Recovery Options

| Option | Default | Description |
|--------|---------|-------------|
| `stallTimeoutMs` | `180000` | Time without activity before recovery (3 min) |
| `waitAfterAbortMs` | `1500` | Pause between abort and continue (1.5s) |
| `maxRecoveries` | `3` | Max recovery attempts before backoff |
| `cooldownMs` | `60000` | Time between recovery attempts (1 min) |
| `abortPollIntervalMs` | `200` | Poll interval after abort |
| `abortPollMaxTimeMs` | `5000` | Max poll time after abort |
| `abortPollMaxFailures` | `3` | Max poll failures before giving up |
| `maxBackoffMs` | `1800000` | Max backoff delay (30 min) |
| `maxAutoSubmits` | `3` | Max auto-submits without user engagement |

### Todo Options

| Option | Default | Description |
|--------|---------|-------------|
| `includeTodoContext` | `true` | Fetch and include todos in messages |
| `continueMessage` | `"Please continue..."` | Message without todo context |
| `continueWithTodosMessage` | `"Please continue... You have {pending}..."` | Message with todo context |

### Review Options

| Option | Default | Description |
|--------|---------|-------------|
| `reviewOnComplete` | `true` | Send review when all todos done |
| `reviewMessage` | `"All tasks completed..."` | Review prompt text |
| `reviewDebounceMs` | `500` | Debounce before triggering review |

### Nudge Options

| Option | Default | Description |
|--------|---------|-------------|
| `nudgeEnabled` | `true` | Enable gentle nudges |
| `nudgeTimeoutMs` | `300000` | Idle time before nudge (5 min) |
| `nudgeMessage` | `"You have {pending}..."` | Nudge message text |
| `nudgeCooldownMs` | `60000` | Min time between nudges (1 min) |

### Compaction Options

| Option | Default | Description |
|--------|---------|-------------|
| `autoCompact` | `true` | Try compaction before abort |

### Other Options

| Option | Default | Description |
|--------|---------|-------------|
| `showToasts` | `false` | Show toast notifications |
| `debug` | `false` | Enable debug logging |

## Template Variables

Use in any message template:

| Variable | Description |
|----------|-------------|
| `{pending}` | Number of open tasks |
| `{total}` | Total tasks |
| `{completed}` | Completed tasks |
| `{todoList}` | Comma-separated pending tasks (max 5) |
| `{attempts}` | Current recovery attempt |
| `{maxAttempts}` | Max recovery attempts |

## Flow Diagrams

### Stall Recovery Flow

```
[Session busy]
      ↓
No progress for stallTimeoutMs?
      ↓
YES → Check session.status()
      ↓
Status === "busy"?
      ↓
YES → autoCompact?
      ↓
YES → Try session.summarize()
      ↓
Wait 3s → Check status again
      ↓
Still busy?
      ↓
YES → Fetch todos (if enabled)
      ↓
Build message with todo context
      ↓
session.abort()
      ↓
Poll until idle (or timeout)
      ↓
Wait waitAfterAbortMs
      ↓
session.prompt("Please continue...")
      ↓
Increment attempts
      ↓
Wait for events (no timer set)
```

### Nudge Flow

```
[todo.updated]
      ↓
Pending todos exist?
      ↓
YES → Start nudge timer (5 min)
      ↓
User sends message?
      ↓
YES → Cancel nudge timer
      ↓
NO → Timer fires after 5 min
      ↓
session.prompt("You have 3 open tasks...")
      ↓
Wait nudgeCooldownMs (1 min)
      ↓
Reset nudge timer
```

### Review Flow

```
[todo.updated]
      ↓
All todos completed?
      ↓
YES → Start debounce timer (500ms)
      ↓
Timer fires
      ↓
reviewFired = false?
      ↓
YES → session.prompt("Please review...")
      ↓
reviewFired = true
      ↓
One-shot — won't fire again
```

## Synthetic Filtering

### The Problem

Without filtering:
```
Plugin sends prompt → Event fires → Plugin sees event → Resets timer → Loops forever
```

### The Solution

All our prompts use `synthetic: true`:
```typescript
await session.prompt({
  body: {
    parts: [{ type: "text", text: "Please continue...", synthetic: true }]
  }
});
```

Our event handler ignores synthetic messages:
```typescript
if (part?.synthetic === true) return;
```

**Result**: Our prompts don't trigger ourselves. No infinite loops.

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
- ❌ Toast notifications (use `showToasts: true`)

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

## Examples

### Minimal Config

```json
["opencode-auto-force-resume", {
  "stallTimeoutMs": 60000,
  "debug": false
}]
```

### Aggressive Recovery (Fast Testing)

```json
["opencode-auto-force-resume", {
  "stallTimeoutMs": 10000,
  "cooldownMs": 5000,
  "maxRecoveries": 5,
  "nudgeTimeoutMs": 60000
}]
```

### Custom Messages

```json
["opencode-auto-force-resume", {
  "continueMessage": "Hey! You stopped. Keep going!",
  "continueWithTodosMessage": "Hey! You have {pending} tasks left: {todoList}. Keep going!",
  "nudgeMessage": "Don't forget about your {pending} open tasks!",
  "reviewMessage": "Great job! Please summarize what we accomplished."
}]
```

### Disable Nudge and Review

```json
["opencode-auto-force-resume", {
  "nudgeEnabled": false,
  "reviewOnComplete": false
}]
```

## Troubleshooting

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

### Debug Logging

Enable temporarily:
```json
"debug": true
```

Check logs:
```bash
tail -f ~/.opencode/logs/auto-force-resume.log
```

**Note**: Debug logging is file-only, does not affect TUI.

## Event Handling

| Event | Action |
|-------|--------|
| `session.status` (busy) | Reset timer, update progress |
| `session.status` (idle/retry) | Clear timer |
| `message.part.updated` (real progress) | Update progress, reset attempts |
| `message.part.updated` (synthetic) | **Ignore** |
| `message.part.updated` (compaction) | Pause monitoring |
| `message.part.updated` (plan text) | Pause monitoring |
| `message.created` / `message.part.added` | Reset timer, reset attempts |
| `message.updated` (user) | Reset counters, cancel nudge |
| `session.error` (MessageAbortedError) | Set userCancelled, clear timer |
| `todo.updated` | Check completion, trigger review/nudge |
| `session.idle` / `session.deleted` | Clear session state |

## Performance

- **Memory**: One SessionState per active session (~200 bytes each)
- **Timers**: Max 2 timers per session (stall + nudge/review)
- **Polling**: Status polling only during recovery (not continuous)
- **File I/O**: Debug logs use `appendFileSync` (blocking but thread-safe)
- **CPU**: Event-driven, no background loops

## License

MIT