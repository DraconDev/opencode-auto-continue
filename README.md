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
| **Terminal Timer** | Nothing — unique feature | Shows elapsed time in terminal title bar |
| **Session Status File** | Nothing — unique feature | Real-time JSON status for external monitoring |
| **Stall Pattern Detection** | Nothing — unique feature | Tracks which part types cause the most stalls |
| **Terminal Progress Bar** | Nothing — unique feature | OSC 9;4 progress in terminal tabs (iTerm2, WezTerm, etc.) |

## How We Work

### Architecture Overview

The plugin is split into 7 focused modules following the factory pattern:

```
index.ts              Main plugin — event routing, module wiring
├── terminal.ts       Terminal title, progress bar, statusLine hook
├── notifications.ts  Timer toast notifications
├── nudge.ts          Idle nudges with loop protection
├── status-file.ts    Atomic status file writes
├── recovery.ts       Stall recovery (abort + continue)
├── compaction.ts     Context compaction
├── review.ts         Review + continue prompt delivery
└── shared.ts         Types, config, utilities
```

Each module is initialized early and receives its dependencies:

```typescript
createTerminalModule({ config, sessions, log, input })
createNotificationModule({ config, sessions, log, isDisposed, input })
createNudgeModule({ config, sessions, log, isDisposed, input })
createStatusFileModule({ config, sessions, log })
createRecoveryModule({ config, sessions, log, input, isDisposed, writeStatusFile, cancelNudge })
createCompactionModule({ config, sessions, log, input })
createReviewModule({ config, sessions, log, input, isDisposed, writeStatusFile, isTokenLimitError, forceCompact })
```

### Core Principles

**1. Synthetic Message Filtering**
All plugin-generated prompts use `synthetic: true`. Our event handler ignores these to prevent infinite loops:

```typescript
// Our prompts are synthetic:
body: { parts: [{ type: "text", text: "...", synthetic: true }] }

// Our handler ignores them:
if (part?.synthetic === true) return;
```

**2. Event-Driven, Not Polling**
- Timers are only set when session is `busy`
- All timers cleared on `idle`, `error`, `deleted`
- No background loops or CPU usage when session is idle

**3. Progress Tracking**
Real progress events reset recovery attempts:
- `text`, `step-finish`, `reasoning`, `tool`, `step-start`, `subtask`, `file`

Synthetic events (our own prompts) are ignored.

**4. Plan/Compaction Awareness**
When plan content or compaction is detected, stall monitoring pauses until user addresses it.

**5. Status File Writes**
Every meaningful event writes the status file atomically. This enables external monitoring without debug mode.

**6. Module Architecture**
The plugin uses a factory pattern with focused modules:

```typescript
createStatusFileModule({ config, sessions, log })   // Atomic status file writes
createRecoveryModule({ config, sessions, log, input, isDisposed, writeStatusFile, cancelNudge })  // Stall recovery
createNudgeModule({ config, sessions, log, isDisposed, input })  // Idle nudges with loop protection
createTerminalModule({ config, sessions, log, input })  // Terminal title/progress/hook
createNotificationModule({ config, sessions, log, isDisposed, input })  // Timer toasts
```

Each module is initialized early and its API is called from event handlers in `index.ts`.

### Recovery State Machine

```
[session.status busy]
        │
        ▼
Start stall timer (stallTimeoutMs)
        │
        ├──[Progress event]──► Reset timer, reset attempts
        │
        ├──[Timer fires]──► Check: still busy?
        │                        │
        │                   YES   │ NO (idle) ──► Clear timer, wait for session.idle
        │                        │
        │                   Check: attempts < maxRecoveries?
        │                        │
        │                   NO──► Exponential backoff
        │                        │
        │                   Check: session too old? (maxSessionAgeMs)
        │                        │
        │                   YES──► Give up
        │                        │
        │                   Check: try autoCompact?
        │                        │
        │                   YES──► session.summarize()
        │                        │        │
        │                        │   Wait 3s
        │                        │        │
        │                        │   Check: still busy?
        │                        │        │
        │                        │   YES──► Proceed with abort
        │                        │   NO ──► Recovery complete
        │                        │
        │                   NO──► Proceed with abort
        │                        │
        │                   session.abort()
        │                        │
        │                   Poll until idle (abortPollIntervalMs)
        │                        │
        │                   Wait waitAfterAbortMs
        │                        │
        │                   Check: autoSubmitCount < maxAutoSubmits?
        │                        │
        │                   NO──► Give up (loop protection)
        │                        │
        │                   Fetch todos for context (if includeTodoContext)
        │                        │
        │                   Build message with template vars
        │                        │
        │                   Set needsContinue + continueMessageText
        │                        │
        │                   Increment attempts, autoSubmitCount
        │                        │
        │                   Cancel any pending nudge
        │
        └──[session.idle]──► Clear timer, send any queued continue
```

**Recovery module** (`createRecoveryModule`):
- Located in `src/recovery.ts` (214 lines)
- Called from event handlers in `index.ts`
- Receives `writeStatusFile` and `cancelNudge` as dependencies
- Uses `input as any` for all client API calls

**Exponential backoff**:
- After `maxRecoveries` attempts, delay doubles each time
- Max delay capped at `maxBackoffMs` (30 min default)
- Backoff resets when recovery succeeds

### Todo Context Injection

Before sending continue, todos are fetched:

```
[About to send continue]
        │
        ▼
Fetch session.todos()
        │
        ▼
Filter: pending/in_progress tasks
        │
        ├──[Has pending]──► Format: "You have 3 tasks: fix bug, update docs, refactor"
        │
        └──[No pending]──► Use default message
```

### Nudge Flow (opencode-todo-reminder pattern)

The nudge system prevents sessions from going idle with pending todos. It follows the same pattern as opencode-todo-reminder:

```
[session.idle] ──► scheduleNudge() ──► setTimeout(nudgeIdleDelayMs=500ms)
                                                   │
                                          [Timer fires] ──► injectNudge()
                                                               │
                                                    [Check cooldown] ──► YES ──► send nudge
                                                               │
                                                               NO ──► skip
```

**Nudge scheduling** (`scheduleNudge`):
- Fires on every `session.idle` with pending todos (NO wasBusy dedup)
- Schedules via `setTimeout` with `nudgeIdleDelayMs` (500ms default)
- Resets nudge timer on `todo.updated` with pending todos
- Cancels pending nudge on `message.updated` (user), `session.error`, `session.deleted`

**Nudge injection** (`injectNudge`):
1. Check cooldown (nudgeCooldownMs=60000ms)
2. Check session status (skip if busy/retry)
3. Check user message cooldown (skip if user messaged recently)
4. Check `nudgePaused` flag (set on MessageAbortedError, cleared on user message)
5. Check loop protection (nudgeMaxSubmits=3)
   - Compare todo snapshot to detect real progress
   - If snapshot unchanged after max submits → pause
6. Fetch todos via API for context
7. Send nudge via `session.promptAsync()`

**Loop protection**:
- `nudgeCount` increments each successful nudge
- `lastTodoSnapshot` = serialized `id:status` of all todos
- If snapshot unchanged after `nudgeMaxSubmits` nudges → pause next cycle
- If snapshot changes (user added/completed todos) → reset counter

**Abort detection**:
- `MessageAbortedError` sets `nudgePaused = true`
- Next nudge cycle is skipped
- Cleared when user sends a message

### Review Flow

```
[todo.updated] → allCompleted?
        │
        ├──YES──► Debounce 500ms
        │          │
        │          └──Check: reviewFired == false?
        │                      │
        │                      └──YES──► Send review prompt
        │                                      │
        │                                      └──reviewFired = true
        │
        └──NO──► Clear any pending debounce
```

## Installation

### npm

```bash
npm install opencode-auto-force-resume
```

### GitHub

```bash
npm install github:DraconDev/opencode-auto-force-resume
```

### Local Development

```bash
git clone https://github.com/DraconDev/opencode-auto-force-resume
cd opencode-auto-force-resume
npm install
npm run build
cp dist/index.js ~/.config/opencode/plugins/
cp dist/index.d.ts ~/.config/opencode/plugins/
```

## Configuration

### Full Configuration Reference

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
      "maxAttemptsMessage": "I've tried to continue several times but haven't seen progress.",
      "includeTodoContext": true,
      "reviewOnComplete": true,
      "reviewMessage": "All tasks in this session have been completed. Please perform a final review...",
      "reviewDebounceMs": 500,
      "showToasts": false,
      "nudgeEnabled": true,
      "nudgeIdleDelayMs": 500,
      "nudgeMaxSubmits": 3,
      "nudgeMessage": "The session has {pending} open task(s) that still need to be completed: {todoList}. Please continue working on these tasks.",
      "nudgeCooldownMs": 60000,
      "autoCompact": true,
      "maxSessionAgeMs": 7200000,
      "proactiveCompactAtTokens": 100000,
      "proactiveCompactAtPercent": 50,
      "compactRetryDelayMs": 3000,
      "compactMaxRetries": 3,
      "shortContinueMessage": "Continue.",
      "tokenLimitPatterns": ["context length", "maximum context length", "token count exceeds"],
      "timerToastEnabled": true,
      "timerToastIntervalMs": 60000,
      "terminalTitleEnabled": true,
      "statusFileEnabled": true,
      "statusFilePath": "",
      "maxStatusHistory": 10,
      "statusFileRotate": 5,
      "recoveryHistogramEnabled": true,
      "stallPatternDetection": true,
      "terminalProgressEnabled": true,
      "debug": false
    }]
  ]
}
```

### Recovery Options

| Option | Default | Description |
|--------|---------|-------------|
| `stallTimeoutMs` | `180000` | Time without activity before recovery (3 min) |
| `waitAfterAbortMs` | `1500` | Pause between abort and continue (1.5s) |
| `maxRecoveries` | `3` | Max recovery attempts before exponential backoff |
| `cooldownMs` | `60000` | Time between recovery attempts (1 min) |
| `abortPollIntervalMs` | `200` | Poll interval after abort |
| `abortPollMaxTimeMs` | `5000` | Max poll time after abort |
| `abortPollMaxFailures` | `3` | Max poll failures before giving up |
| `maxBackoffMs` | `1800000` | Max backoff delay (30 min) |

### Todo Options

| Option | Default | Description |
|--------|---------|-------------|
| `includeTodoContext` | `true` | Fetch and include todos in messages |
| `continueMessage` | `"Please continue..."` | Message without todo context |
| `continueWithTodosMessage` | `"You have {pending}..."` | Message with todo context |

### Review Options

| Option | Default | Description |
|--------|---------|-------------|
| `reviewOnComplete` | `true` | Send review when all todos done |
| `reviewMessage` | `"All tasks completed..."` | Review prompt text |
| `reviewDebounceMs` | `500` | Debounce before triggering review |

### Nudge Options

| Option | Default | Description |
|--------|---------|-------------|
| `nudgeEnabled` | `true` | Send continue prompts for incomplete todos |
| `nudgeIdleDelayMs` | `500` | Delay after session.idle before sending nudge |
| `nudgeMessage` | `"The session has {pending}..."` | Nudge message telling agent to continue |
| `nudgeCooldownMs` | `60000` | Min time between nudges (1 min) |
| `nudgeMaxSubmits` | `3` | Max nudges before loop protection pauses |

### Compaction Options

| Option | Default | Description |
|--------|---------|-------------|
| `autoCompact` | `true` | Try compaction before abort |
| `proactiveCompactAtTokens` | `100000` | Token threshold for proactive compaction |
| `proactiveCompactAtPercent` | `50` | Percentage of model context limit |
| `compactRetryDelayMs` | `3000` | Delay between compaction retries |
| `compactMaxRetries` | `3` | Max compaction retry attempts |
| `compactionVerifyWaitMs` | `10000` | Max wait time for compaction to complete (progressive checks at 2s/3s/5s) |
| `compactCooldownMs` | `120000` | Min time between compaction attempts (2 min) |

### Timer & Display Options

| Option | Default | Description |
|--------|---------|-------------|
| `timerToastEnabled` | `true` | Show periodic timer toasts |
| `timerToastIntervalMs` | `60000` | Interval between timer toasts (1 min) |
| `terminalTitleEnabled` | `true` | Update terminal title with elapsed time |
| `terminalProgressEnabled` | `true` | OSC 9;4 terminal tab progress bar |

### Status File Options

| Option | Default | Description |
|--------|---------|-------------|
| `statusFileEnabled` | `true` | Enable real-time status file writes |
| `statusFilePath` | `""` | Custom path (default: `~/.opencode/logs/auto-force-resume.status`) |
| `maxStatusHistory` | `10` | Number of history entries to keep per session |
| `statusFileRotate` | `5` | Number of rotated archives to keep |
| `recoveryHistogramEnabled` | `true` | Track recovery time histogram (min/max/median) |
| `stallPatternDetection` | `true` | Track which part types cause stalls |

### Other Options

| Option | Default | Description |
|--------|---------|-------------|
| `showToasts` | `false` | Show toast notifications |
| `debug` | `false` | Enable debug logging to file |

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
  "version": "3.117.4",
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
      "timer": {
        "actionDuration": "5m 32s",
        "lastProgressAgo": "12s"
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
| `timer.actionDuration` | Time since action started |
| `timer.lastProgressAgo` | Time since last progress event |
| `history` | Rolling buffer of recent status snapshots |

### Rotated Status Files

When `statusFileRotate > 0`, old status files are kept:
- `~/.opencode/logs/auto-force-resume.status.1` (most recent archive)
- `~/.opencode/logs/auto-force-resume.status.2`
- etc.

## How Compaction Works

The plugin uses two compaction strategies to prevent context bloat:

### 1. Proactive Compaction (Preventive)

Triggers BEFORE context becomes critical. Runs on:
- **Every progress event** (message part updated) - catches bloat during active sessions
- **When session resumes busy** - catches pre-existing bloat from prior interactions
- **When session becomes idle** - catches bloat between user messages

**Threshold calculation**:
```
threshold = min(proactiveCompactAtTokens, modelContextLimit * proactiveCompactAtPercent / 100)
```

For example, with a 262k context model and 50%:
```
threshold = min(100000, 262144 * 0.50) = min(100000, 131072) = 100000 tokens
```

### 2. Recovery Compaction (Reactive)

Triggers when a stall is detected during recovery. Before aborting the session, the plugin tries `session.summarize()` with progressive verification:
1. Wait 2 seconds → check if session idled
2. Wait 3 seconds → check again
3. Wait 5 seconds → check again
4. If still busy → proceed with abort+continue

### Token Estimation

The plugin estimates token usage from ALL message part types, not just text:

| Part Type | Estimation Source |
|-----------|------------------|
| `text` | Full text content |
| `reasoning` | Reasoning chain text |
| `tool` | Tool call JSON (serialized) |
| `file` | URL + MIME type |
| `subtask` | Prompt + description |
| `step-start` | Step name |

**Ratios used**:
- English text: ~0.75 tokens/char (industry standard for Claude, GPT-4)
- Code: ~1.0 tokens/char (dense tokenization)
- Digits/numbers: ~0.5 tokens/char

If OpenCode's API returns real token counts (via `session.status()`), those are used instead of estimates.

### Why Compaction Might Not Fire

If compaction isn't triggering despite high token usage, check these:

1. **Check the status file** - Look at `compaction.estimatedTokens` vs `compaction.threshold`:
   ```bash
   cat ~/.opencode/logs/auto-force-resume.status
   ```
   Look for:
   ```json
   "compaction": {
     "proactiveTriggers": 0,
     "estimatedTokens": 85000,
     "threshold": 100000
   }
   ```
   If `estimatedTokens < threshold`, the estimated count is too low.

2. **Known limitations**:
   - Token estimation only counts content seen during this session. Pre-existing context from resumed sessions might not be counted.
   - The plugin can't read tool definitions, system prompts, or file contents added to context before the plugin started.
   - Only text content is estimated - binary data, images, and other non-text parts aren't counted.

3. **Set a lower threshold**:
   ```json
   ["opencode-auto-force-resume", {
     "proactiveCompactAtTokens": 50000,
     "proactiveCompactAtPercent": 30
   }]
   ```

4. **Enable debug mode** to see what's happening:
   ```json
   ["opencode-auto-force-resume", {
     "debug": true
   }]
   ```
   Check `~/.opencode/logs/auto-force-resume.log` for lines containing "compaction".

### How to Verify Compaction Is Working

1. Check the status file:
   ```bash
   watch -n 2 'cat ~/.opencode/logs/auto-force-resume.status'
   ```
   Look for `"compaction"` section - if `"proactiveTriggers"` > 0 or `"lastCompactAt"` is set, it's running.

2. Watch debug logs:
   ```bash
   tail -f ~/.opencode/logs/auto-force-resume.log | grep -i compact
   ```
   You should see entries like:
   ```
   "attempting compaction for session: abc123"
   "compaction successful for session: abc123 after 2000ms wait"
   "compaction reduced tokens from ~ 85000 to ~ 25500"
   ```

## Terminal Title

When `terminalTitleEnabled: true`, the plugin updates your terminal title to show session timer:

```
⏱️ 3m 12s | Last: 45s ago
```

This uses OSC (Operating System Command) escape sequences:
- `OSC 0`: Sets both icon name and window title
- `OSC 2`: Sets window title (fallback)

**Works in**: iTerm2, WezTerm, Windows Terminal, GNOME Terminal, Ghostty, macOS Terminal

When session goes idle, title resets to `opencode`.

## Terminal Progress Bar (OSC 9;4)

When `terminalProgressEnabled: true`, the plugin sends OSC 9;4 sequences to show progress in terminal tabs:

```bash
# Set progress to 50%:
printf '\e]9;4;1;50\e\\'

# Clear progress:
printf '\e]9;4;0\e\\'
```

This shows a progress indicator in terminal tabs (iTerm2, WezTerm, Windows Terminal).

**Progress calculation**: `(time_since_last_progress / stallTimeoutMs) * 100`

- 0% = Just started, fresh progress
- 100% = About to trigger recovery
- 99% = Max (never reaches 100% until recovery fires)

## Event Handling Reference

| Event | Action |
|-------|--------|
| `session.status` (busy) | Reset timer, update progress, start timers |
| `session.status` (idle) | Clear timer, clear terminal title/progress |
| `session.status` (retry) | Treat as busy (progress indicator) |
| `message.part.updated` (real) | Update progress, reset attempts |
| `message.part.updated` (synthetic) | **Ignore** (prevents loops) |
| `message.part.updated` (compaction) | Pause monitoring; `session.compacted` resumes |
| `session.compacted` | Clear compacting flag, preserve session state, reset estimates |
| `message.part.updated` (plan text) | Pause monitoring |
| `message.created` / `message.part.added` | Reset timer, reset attempts |
| `message.updated` (user) | Reset counters, cancel nudge |
| `session.error` (MessageAbortedError) | Set userCancelled, clear timer |
| `session.error` (other) | Clear timer, monitoring pauses |
| `todo.updated` | Check completion, trigger review/nudge |
| `session.idle` | Trigger nudge for pending todos (not terminal) |
| `session.deleted` | Clear all session state |

## How to Customize

### Disable All Auto-Recovery

```json
["opencode-auto-force-resume", {
  "maxRecoveries": 0,
  "stallTimeoutMs": 999999999
}]
```

### Aggressive Recovery (For Testing)

```json
["opencode-auto-force-resume", {
  "stallTimeoutMs": 10000,
  "cooldownMs": 5000,
  "maxRecoveries": 10,
  "waitAfterAbortMs": 500
}]
```

### Long-Running Sessions

```json
["opencode-auto-force-resume", {
  "stallTimeoutMs": 600000,
  "maxSessionAgeMs": 14400000,
  "proactiveCompactAtTokens": 150000
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

### Disable Specific Features

```json
["opencode-auto-force-resume", {
  "nudgeEnabled": false,
  "reviewOnComplete": false,
  "autoCompact": false,
  "terminalTitleEnabled": false,
  "statusFileEnabled": false,
  "terminalProgressEnabled": false
}]
```

### Enable Debug Mode

```json
["opencode-auto-force-resume", {
  "debug": true
}]
```

Check logs:
```bash
tail -f ~/.opencode/logs/auto-force-resume.log
```

### Custom Status File Location

```json
["opencode-auto-force-resume", {
  "statusFilePath": "/tmp/my-opencode-status.json",
  "statusFileRotate": 3
}]
```

### Token Limit Handling

```json
["opencode-auto-force-resume", {
  "tokenLimitPatterns": [
    "context length",
    "maximum context length",
    "token count exceeds",
    "too many tokens",
    "custom error pattern"
  ],
  "compactMaxRetries": 5,
  "compactRetryDelayMs": 5000
}]
```

### Recovery Histogram Tuning

```json
["opencode-auto-force-resume", {
  "recoveryHistogramEnabled": true
}]
```

Tracks recovery times to show you average/min/max/median recovery duration.

### Stall Pattern Detection

```json
["opencode-auto-force-resume", {
  "stallPatternDetection": true
}]
```

Shows which part types (tool, reasoning, text, etc.) are most associated with stalls.

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

### From `opencode-timer-plugin`

Our plugin provides terminal title updates automatically:
```json
["opencode-auto-force-resume", {
  "terminalTitleEnabled": true
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

### Status File Not Updating

**Cause**: `statusFileEnabled: false` or disk full
**Fix**: Check config or disk space

### Terminal Title Not Showing

**Cause**: Terminal doesn't support OSC sequences
**Fix**: Use iTerm2, WezTerm, Windows Terminal, or Ghostty

### Terminal Progress Not Showing

**Cause**: Terminal doesn't support OSC 9;4
**Fix**: Use iTerm2 (3.6.6+), WezTerm, Windows Terminal, or Ghostty

## Performance

- **Memory**: One SessionState per active session (~200 bytes each)
- **Timers**: Max 2 timers per session (stall + nudge/review)
- **Polling**: Status polling only during recovery (not continuous)
- **File I/O**: Status file uses atomic writes (`.tmp` + rename)
- **CPU**: Event-driven, no background loops

## License

MIT