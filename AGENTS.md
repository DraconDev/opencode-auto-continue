# Agent Instructions for opencode-auto-force-resume

## Overview

`opencode-auto-force-resume` is an OpenCode plugin that:
1. Detects stalled sessions (busy but no real progress)
2. Recovers via `session.abort()` + `continue` prompt
3. Nudges idle sessions with pending todos
4. Reviews completed todos
5. Auto-compacts context before token limits
6. Provides real-time status via file/terminal

## Session State Machine

```
session.created → [busy] ←→ [idle]
                         ↓
                    send nudge
                         ↓
session.deleted / session.ended → cleanup
```

### Session States

| State | Description |
|-------|-------------|
| `busy` | Agent is actively generating (tool calls, text, reasoning, etc.) |
| `idle` | Agent stopped generating. Nudge fires if `hasOpenTodos && nudgeEnabled` |
| `planning` | Plan content detected — all monitoring pauses |
| `compacting` | Context compaction in progress — monitoring pauses |
| `userCancelled` | User pressed ESC / aborted — recovery disabled |

### Event → State Transitions

| Event | Effect |
|-------|--------|
| `session.status (busy)` | Start stall timer, update progress |
| `session.status (idle)` | If `needsContinue` → send queued continue. If `wasBusy && hasOpenTodos` → send nudge. |
| `session.status (retry)` | Treat as busy (valid progress) |
| `message.updated` (assistant tokens) | Update `estimatedTokens`, check proactive compaction |
| `message.updated` (user) | Reset counters, cancel nudge |
| `message.part.updated` (real progress) | Reset stall timer, reset attempts |
| `message.part.updated` (step-finish tokens) | Update `estimatedTokens` with actual token counts |
| `message.part.updated` (synthetic) | **Ignore** — prevents infinite loop |
| `message.part.updated` (compaction) | Set `compacting = true`, pause monitoring |
| `message.part.updated` (text with plan) | Set `planning = true`, pause monitoring |
| `todo.updated` (all done) | Trigger review after debounce |
| `todo.updated` (has pending) | Set `hasOpenTodos = true`, start nudge timer |
| `session.error` (MessageAbortedError) | Set `userCancelled = true`, clear timer |
| `session.error` (token limit) | Parse tokens, increment `tokenLimitHits`, trigger emergency compaction |
| `session.error` (other) | Clear timer, monitoring pauses |
| `session.compacted` | **Do NOT reset** — clear compacting flag, reset estimates, preserve state |
| `session.idle` | **Do NOT reset** — preserve nudge state, trigger nudge |
| `session.deleted` / `session.ended` | Call `resetSession()` — full cleanup |

### Key Invariants

1. **`session.idle` is NOT terminal** — unlike `session.deleted`/`session.ended`, it preserves session state
2. **`session.compacted` is NOT terminal** — it preserves session state, clears compacting flag, resets token estimates
3. **Synthetic messages are filtered** — `part.synthetic === true` is ignored in `message.part.updated`
4. **Token estimation from three sources** — error messages, step-finish tokens, AssistantMessage tokens (see above)
5. **Recovery queue** — `needsContinue` flag set by `recover()`, consumed by `session.status` handler when idle
6. **Plan/compaction pause** — stall timer and nudge timer both pause during these states

## Nudge Architecture

### Dual Trigger Paths

1. **`session.idle` handler** (primary) — fires immediately when model goes idle with pending todos
2. **`session.status (idle)` in busy→idle transition** (secondary backup) — fires once per transition

Both paths check `nudgeCooldownMs` before sending.

### sendNudge() Guard Checks (in order)

```typescript
if (isDisposed) return;           // Plugin disposed
if (!s.lastUserMessageId) return;  // User recently engaged
if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) return; // Cooldown active
if (!s.hasOpenTodos) return;       // No pending todos
// session.status() check — skip if busy/retry
// fetch todos for context (if includeTodoContext)
// send prompt with {pending}, {todoList}, {total}, {completed} template vars
```

### Nudge Message

Default: `"The session has {pending} open task(s) that still need to be completed: {todoList}. Please continue working on these tasks."`

Template variables:
- `{pending}` — count of in_progress + pending todos
- `{todoList}` — comma-separated list of todo contents (up to 5)
- `{total}` — total todo count
- `{completed}` — count of completed + cancelled todos

## Stall Detection & Recovery

### Progress Part Types (reset stall timer)

- `text`, `reasoning`, `tool`, `file`, `subtask`, `step-start`, `step-finish`

### Non-Progress Events (ignored for stall)

- Synthetic parts (`part.synthetic === true`)
- `compaction` parts
- Plan text content

### Recovery Flow

```
stall timer fires → recover(sid)
  ├─ Check isDisposed / userCancelled / maxRecoveries
  ├─ session.summarize() if autoCompact enabled (retry up to 3x)
  ├─ session.abort()
  ├─ Poll session.status() until idle
  ├─ session.promptAsync() with continue message
  └─ Set needsContinue = false, record recovery stats
```

### Backoff After Max Recoveries

- 1st failure: immediate retry
- 2nd: 30s cooldown
- 3rd: 60s cooldown
- Beyond maxRecoveries: exponential backoff up to `maxBackoffMs: 1800000` (30min)

## Token Estimation

Three actual data sources (in order of accuracy):

1. **Error messages** (`session.error`) — exact counts from "You requested a total of 264230 tokens: 232230 input, 32000 output"
2. **step-finish parts** (`message.part.updated`) — `{ input, output, reasoning, cache }` per completion
3. **AssistantMessage** (`message.updated`) — `{ input, output, reasoning, cache }` per message

Token accumulation:
- `message.updated` (assistant): `s.estimatedTokens += input + output + reasoning`
- `message.part.updated` (step-finish): `s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens)`
- `session.error`: `s.estimatedTokens = Math.max(s.estimatedTokens, parsedTotal)`

**Why session.status() doesn't help**: OpenCode SDK's `SessionStatus` type is only `{ type: "idle" | "busy" | "retry" }` — no token fields. The plugin relies on the three sources above instead.

**Text-based fallback estimation** (for text/reasoning/tool parts without tokens):
- English text: `chars × 0.75 / 4` tokens
- Code: `chars × 1.0 / 4` tokens
- Digits: `chars × 0.5 / 4` tokens

**Important**: `estimatedTokens` is a running sum of all message tokens. This WILL exceed actual context window because old messages get dropped. Intentional — better to over-estimate and compact early.

## Proactive Compaction

Triggers on: every progress event + session resume busy + idle + message.updated with tokens.

Config options:
- `proactiveCompactAtTokens: 100000` — token threshold
- `proactiveCompactAtPercent: 50` — % of model limit
- `compactCooldownMs: 120000` — 2min between compaction attempts
- `compactMaxRetries: 3` — retry attempts

Threshold calculation:
- Large models (≥200k): `min(100000, modelLimit * 0.5)`
- Small models (<200k): `min(75000, modelLimit * 0.5)`

## Status File

Written atomically (`.tmp` + rename) to `~/.opencode/logs/auto-force-resume.status` on every event.

Includes: elapsed time, recovery stats, stall detections, compaction info, timer state, todos, auto-submits, history, recovery histogram, stall patterns.

Config: `statusFileEnabled`, `statusFilePath`, `maxStatusHistory`, `statusFileRotate`

## Terminal Visibility

- **OSC 0/2 (title)**: `⏱️ 3m 12s | Last: 45s ago` — clears on idle
- **OSC 9;4 (progress)**: percentage bar in iTerm2/WezTerm/Windows Terminal/Ghostty
- **Toast**: periodic `showToast` every `timerToastIntervalMs: 60000`

## Key Trade-offs

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| `synthetic` filter in message events | Prevents plugin's own prompts from resetting timers | Need to explicitly mark plugin prompts as synthetic |
| `needsContinue` queue mechanism | Prevents abort+prompt race condition with TUI | Extra flag to track |
| Token estimation from ALL part types | More accurate than text-only | Estimates still miss pre-existing context |
| `compactCooldownMs` 2min | Prevents excessive compaction API calls | May miss some bloat scenarios |
| `wasBusy` dedup flag | Prevents nudge loops on repeated idle events | One extra boolean per session |
| Status file atomic writes | Never partial read during `tail -f` | Extra `.tmp` file per write |

## Debugging

Enable debug mode in `opencode.json`:
```json
["opencode-auto-force-resume", { "debug": true }]
```

Logs go to `~/.opencode/logs/auto-force-resume.log`.

## Common Issues

### Nudge not firing
1. Check `nudgeEnabled: true` in config
2. Verify `hasOpenTodos: true` in status file
3. Check `lastNudgeAt` — may be in cooldown
4. Check `lastUserMessageId` — user engaged recently
5. Check session status — plugin skips if session is busy/retry

### Recovery not triggering
1. Check `maxRecoveries > 0`
2. Check `userCancelled` flag — ESC aborts recovery permanently
3. Check `planning` or `compacting` flags — pauses monitoring
4. Check exponential backoff — after maxRecoveries, waits up to 30min

### UI breakage
- Debug mode OFF by default — file logging can cause TUI crashes
- No `console.log`/`console.error` in production paths
