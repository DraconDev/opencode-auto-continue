# Agent Instructions for opencode-auto-force-resume

## Overview

`opencode-auto-force-resume` is an OpenCode plugin that:
1. Detects stalled sessions (busy but no real progress)
2. Recovers via `session.abort()` + `continue` prompt
3. Nudges idle sessions with pending todos
4. Reviews completed todos
5. Auto-compacts context before token limits
6. Provides real-time status via file/terminal

## New Features (v6.54+)

### Question Detection
- Before nudging, fetches last assistant message
- Checks if message is a question (ends with `?` or contains phrases like "would you like", "should i", "do you want", etc.)
- **Skips nudge if AI is asking user for input** — prevents annoying the user
- Prevents false nudges when AI genuinely needs clarification

### Tool-Text Recovery
- After stall detection, scans recent messages for XML tool calls in reasoning/text
- Detects 18 patterns: `<function=...>`, `<invoke>`, `<tool_call>`, etc.
- Also detects truncated/unclosed tags
- **Sends specialized recovery prompt**: "I noticed you have a tool call generated in your thinking/reasoning. Please execute it using the proper tool calling mechanism..."
- Prevents stalls caused by models outputting XML instead of executing tools

### Hallucination Loop Detection
- Tracks timestamps of all continue prompts in sliding window (10 minutes)
- If 3+ continues within 10 minutes → **forces abort+resume to break the cycle**
- Prevents infinite loops where model generates same broken output repeatedly

### Prompt Guard (Cross-Instance)
- Before injecting any prompt (nudge/continue/review), checks recent messages
- If a similar prompt was sent within last 30 seconds → **blocks duplicate**
- Prevents duplicate injections from multiple plugin instances or race conditions
- Fail-open: allows prompt if check fails

### Child Session Filtering
- Timer toasts skip child/subagent sessions by default
- Checks `parentID` via `session.get()` — no parent = root session
- Configurable via `notifyChildSessions` (default: false)

### Notification Deduping
- 1500ms deduping window prevents rapid successive notifications
- Tracks recent notifications per session
- Cleans up old entries automatically

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
| `session.status (busy)` | Start stall timer, update progress. **Does NOT clear `s.planning`** — session.status(busy) fires during plan generation too and must not destroy the plan flag |
| `session.status (idle)` | If `needsContinue` → send queued continue. If `hasOpenTodos` → send nudge. |
| `session.status (retry)` | Treat as busy (valid progress) |
| `message.updated` (assistant tokens) | Update `estimatedTokens`, check proactive compaction |
| `message.updated` (user) | Reset counters, cancel nudge |
| `message.part.updated` (real progress) | Reset stall timer, reset attempts |
| `message.part.updated` (step-finish tokens) | Update `estimatedTokens` with actual token counts |
| `message.part.updated` (synthetic) | **Ignore** — prevents infinite loop |
| `message.part.updated` (compaction) | Set `compacting = true`, pause monitoring |
| `message.part.updated` (text with plan) | Set `planning = true`, pause monitoring |
| `message.part.updated` (tool/file/subtask/step-start/step-finish) | **Clear `s.planning = false`** — model has moved past planning into execution |
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
7. **Question detection prevents nudge** — if last assistant message is a question, nudge is skipped
8. **Tool-text recovery** — recovery uses specialized prompt when XML tool calls detected in reasoning
9. **Hallucination loop break** — 3+ continues in 10min forces abort+resume
10. **Prompt guard blocks duplicates** — checks recent messages before injecting

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
// Question detection — skip if last assistant message is a question
// Prompt guard — skip if similar prompt sent recently
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

### Recovery Flow (Updated v6.54+)

```
stall timer fires → recover(sid)
  ├─ Check isDisposed / userCancelled / maxRecoveries
  ├─ Check: session still busy?
  ├─ Check: time since last progress >= stallTimeoutMs?
  ├─ Check tool-text in recent messages (XML in reasoning)
  ├─ session.abort()  // REQUIRED before compaction
  ├─ Poll session.status() until idle
  ├─ session.summarize() if autoCompact enabled (session must be idle!)
  ├─ Wait waitAfterAbortMs (5000ms default)
  ├─ Check hallucination loop (3+ continues in 10min → abort+resume)
  ├─ session.promptAsync() with continue message
  └─ Set needsContinue = false, record recovery stats
```

**CRITICAL**: Compaction (`summarize()`) now happens **AFTER** abort, when session is idle. Previously it was called on busy sessions which always failed.

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

**Text-based fallback estimation** (for text/reasoning/tool parts without tokens):
- English text: `chars × 0.75 / 4` tokens → **×2 multiplier** for hidden context
- Code: `chars × 1.0 / 4` tokens → **×2 multiplier** for hidden context
- Digits: `chars × 0.5 / 4` tokens → **×2 multiplier** for hidden context

**Important**: `estimatedTokens` is a running sum of all message tokens. This WILL exceed actual context window because old messages get dropped. Intentional — better to over-estimate and compact early.

**Why session.status() doesn't help**: OpenCode SDK's `SessionStatus` type is only `{ type: "idle" | "busy" | "retry" }` — no token fields. The plugin relies on the three sources above instead.

## Proactive Compaction

Triggers on: every progress event + session resume busy + idle + message.updated with tokens.

**Skips during planning**: `maybeProactiveCompact` checks `s.planning` and returns early — compaction is deferred while the model is generating plan content. This prevents summarising away in-progress plans. Emergency compaction (token limit errors) still fires regardless.

Config options:
- `proactiveCompactAtTokens: 100000` — token threshold
- `compactCooldownMs: 60000` — 1min between compaction attempts
- `compactMaxRetries: 3` — retry attempts
- `compactAtMessageCount: 50` — fallback: trigger after 50 messages even if tokens underestimated

Threshold calculation:
- Always returns `proactiveCompactAtTokens` (100k default), regardless of model size
- Message count fallback catches cases where token estimation is too conservative

## Compaction Flow (v6.54+)

```
maybeProactiveCompact(sid)
  ├─ Check: session exists
  ├─ Check: autoCompact enabled
  ├─ Check: NOT planning
  ├─ Check: NOT compacting
  ├─ Check: cooldown elapsed (compactCooldownMs)
  ├─ Check: session is idle (NOT busy) — SKIP if busy!
  ├─ Check: estimatedTokens >= threshold OR messageCount >= compactAtMessageCount
  └─ Call attemptCompact(sid)
         ├─ session.summarize()
         ├─ Wait 2s → check status
         ├─ Wait 3s → check status
         ├─ Wait 5s → check status
         └─ If idle → success, reset tokens
```

**Recovery compaction** (in recovery.ts):
```
recover(sid)
  ├─ ... stall checks ...
  ├─ session.abort()  // Must abort first!
  ├─ Poll until idle
  ├─ session.summarize()  // Now safe to compact
  ├─ Wait 3s
  ├─ session.promptAsync() with continue message
```

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
| Token estimation from three sources | Error messages give exact counts; step-finish gives per-completion; AssistantMessage gives per-message | Running sum overestimates context (old msgs dropped) — but better early than late |
| `synthetic` filter in message events | Prevents plugin's own prompts from resetting timers | Need to explicitly mark plugin prompts as synthetic |
| `needsContinue` queue mechanism | Prevents abort+prompt race condition with TUI | Extra flag to track |
| Last-known todos cache | Eliminates double-fetch in nudge.ts | Only updated on todo.updated events |
| `compactCooldownMs` 1min | Prevents excessive compaction API calls | May miss some bloat scenarios between checks |
| Status file atomic writes | Never partial read during `tail -f` | Extra `.tmp` file per write |
| safeHook fail-open wrapper | Prevents plugin errors from crashing the host | Errors are logged but never propagated |
| Question detection | Prevents annoying nudges when AI asks user | Extra API call per nudge (~50-200ms) |
| Tool-text recovery | Catches XML-in-reasoning stalls | 18 regex patterns may have false positives |
| Hallucination loop break | Prevents infinite loops | 3-in-10min threshold may catch legitimate rapid continues |
| Prompt guard | Prevents duplicate injections | Extra API call per prompt (~50-200ms) |

## OpenCode Hooks

### experimental.compaction.autocontinue

The plugin registers this hook to disable OpenCode's generic synthetic "continue" message that fires after compaction. Instead, the plugin sends its own todo-aware continue message via `review.sendContinue()`.

**Hook behavior**: Sets `output.enabled = false` to disable the generic continue.

### safeHook Utility

Fail-open hook wrapper in `shared.ts` that catches errors and logs them without propagating:

```typescript
await safeHook("event", async () => { /* ... */ }, log);
```

Used in `index.ts` to wrap the main event handler. Prevents plugin bugs from crashing the OpenCode host.

### Model Config Caching

`getModelContextLimit()` caches the parsed `opencode.json` with mtime checking:
- First call reads and parses the file
- Subsequent calls return cached value if mtime hasn't changed
- Cache is invalidated when file modification time changes

This avoids repeated `fs.readFileSync` + `JSON.parse` on every proactive compaction check.

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
6. **Check if last assistant message was a question** — question detection may have skipped it

### Recovery not triggering
1. Check `maxRecoveries > 0`
2. Check `userCancelled` flag — ESC aborts recovery permanently
3. Check `planning` or `compacting` flags — pauses monitoring
4. Check exponential backoff — after maxRecoveries, waits up to 30min

### Compaction not triggering
1. Check `autoCompact: true` in config
2. Check `estimatedTokens` vs `threshold` in status file
3. Check `compacting` flag — may already be compacting
4. Check `planning` flag — proactive compaction skips during planning
5. **Check session status** — must be idle to compact (busy sessions can't be summarized)
6. Enable debug mode and check logs for "proactive compact" messages

### UI breakage
- Debug mode OFF by default — file logging can cause TUI crashes
- No `console.log`/`console.error` in production paths

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
| `session.status (busy)` | Start stall timer, update progress. **Does NOT clear `s.planning`** — session.status(busy) fires during plan generation too and must not destroy the plan flag |
| `session.status (idle)` | If `needsContinue` → send queued continue. If `wasBusy && hasOpenTodos` → send nudge. |
| `session.status (retry)` | Treat as busy (valid progress) |
| `message.updated` (assistant tokens) | Update `estimatedTokens`, check proactive compaction |
| `message.updated` (user) | Reset counters, cancel nudge |
| `message.part.updated` (real progress) | Reset stall timer, reset attempts |
| `message.part.updated` (step-finish tokens) | Update `estimatedTokens` with actual token counts |
| `message.part.updated` (synthetic) | **Ignore** — prevents infinite loop |
| `message.part.updated` (compaction) | Set `compacting = true`, pause monitoring |
| `message.part.updated` (text with plan) | Set `planning = true`, pause monitoring |
| `message.part.updated` (tool/file/subtask/step-start/step-finish) | **Clear `s.planning = false`** — model has moved past planning into execution |
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

**Skips during planning**: `maybeProactiveCompact` checks `s.planning` and returns early — compaction is deferred while the model is generating plan content. This prevents summarising away in-progress plans. Emergency compaction (token limit errors) still fires regardless.

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
| Token estimation from three sources | Error messages give exact counts; step-finish gives per-completion; AssistantMessage gives per-message | Running sum overestimates context (old msgs dropped) — but better early than late |
| `synthetic` filter in message events | Prevents plugin's own prompts from resetting timers | Need to explicitly mark plugin prompts as synthetic |
| `needsContinue` queue mechanism | Prevents abort+prompt race condition with TUI | Extra flag to track |
| Last-known todos cache | Eliminates double-fetch in nudge.ts | Only updated on todo.updated events |
| `compactCooldownMs` 2min | Prevents excessive compaction API calls | May miss some bloat scenarios between checks |
| Status file atomic writes | Never partial read during `tail -f` | Extra `.tmp` file per write |
| safeHook fail-open wrapper | Prevents plugin errors from crashing the host | Errors are logged but never propagated |

## OpenCode Hooks

### experimental.compaction.autocontinue

The plugin registers this hook to disable OpenCode's generic synthetic "continue" message that fires after compaction. Instead, the plugin sends its own todo-aware continue message via `review.sendContinue()`.

**Hook behavior**: Sets `output.enabled = false` to disable the generic continue.

### safeHook Utility

Fail-open hook wrapper in `shared.ts` that catches errors and logs them without propagating:

```typescript
await safeHook("event", async () => { /* ... */ }, log);
```

Used in `index.ts` to wrap the main event handler. Prevents plugin bugs from crashing the OpenCode host.

### Model Config Caching

`getModelContextLimit()` caches the parsed `opencode.json` with mtime checking:
- First call reads and parses the file
- Subsequent calls return cached value if mtime hasn't changed
- Cache is invalidated when file modification time changes

This avoids repeated `fs.readFileSync` + `JSON.parse` on every proactive compaction check.

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
