# Agent Instructions for opencode-auto-continue

## Current State (v7.8.1839)

**Status:** Released & Dogfooding (local dev mode)
**Tests:** 452/452 passing
**npm:** `@dracondev/opencode-auto-continue@7.8.1839`
**Local:** `file:///home/dracon/Dev/opencode-auto-continue/dist/index.js`

### v7.8.1839 Changes
- **Raised compaction thresholds**: opportunistic 40k→60k, proactive 60k→80k, hard 80k→100k. Compaction now fires less frequently (20k higher on all layers).
- **Test-Driven Quality Gate (TDQG)**: New `test-runner.ts` module runs configured test commands (default: `cargo test`) automatically:
  - **Test-on-idle**: Runs tests before every nudge. If tests fail, nudge message becomes "fix these tests" directive.
  - **Test-on-review**: Runs tests before review prompt. Results injected via `{testOutput}` template variable.
  - **TDD enforcement**: Continue/nudge messages now instruct AI to "write test first, then implement."
- **`simulateCompacted()` test helper**: Extracted from 10+ repeated patterns in compaction tests — reduces boilerplate.
- **`autoAnswerQuestions` config validation**: Added guard against non-boolean values.
- **`_client` dependency documented**: Question auto-answer uses OpenCode SDK internal `_client` property — documented in Key Trade-offs.
- **Compaction poll fix** (from v7.8.1836): polls `s.compacting` flag instead of `session.status()` for idle. Session stays busy during compaction — status-polling was causing 100% compaction failure rate. Now waits for `session.compacted` event to clear flag.
- **Token reduction on compaction success**: `attemptCompact()` reduces `estimatedTokens` by `compactReductionFactor` after success.
- **Compaction verify wait 30s**: was 10s — large contexts need >10s to compact.

### v7.8.1836 Changes
- **Compaction Poll Fix**: Rewrote `attemptCompact()` — polls `s.compacting` flag instead of `session.status()` for idle. Session stays busy during compaction, so status-polling was causing 100% compaction failure rate. Now waits for `session.compacted` event to clear flag.
- **Bun SQLite Support**: `src/tokens.ts` tries `bun:sqlite` first, then `node:sqlite`. OpenCode runs on Bun where `node:sqlite` throws "No such built-in module".
- **Token Reduction on Compaction Success**: `attemptCompact()` now reduces `estimatedTokens` by `compactReductionFactor` when compaction succeeds. Previously, `maybeHardCompact` would return false even after successful compaction because tokens were still above threshold.
- **`autoAnswerQuestions` Config Toggle**: New config option (default: `true`) to enable/disable question auto-answer. Previously hardcoded.
- **Compaction Verify Wait**: `compactionVerifyWaitMs` increased to 30000 (large contexts need >10s to compact).
- **Test Fixes**: 11 compaction tests fixed — flag-based polling requires setting `s.compacting=false` between poll intervals then advancing timers again. Added 3 new question.asked tests.
- **Removed `mockStatus` from compaction tests**: Tests no longer mock `session.status()` — they simulate `session.compacted` event by setting `s.compacting=false` + `s.lastCompactionAt`.

### v7.8.1828 Changes
- **Question Auto-Answer**: Handles `question.asked` events — auto-replies with the first (recommended) option via `POST /question/{requestID}/reply`. Prevents sessions from stalling when AI asks multiple-choice questions.
- **Reduced Compaction Thresholds**: `proactiveCompactAtTokens: 100k→60k`, `hardCompactAtTokens: 100k→80k`, `opportunisticCompactAtTokens: 50k→40k`. Old thresholds fired too late — sessions hit 200k+ before compaction triggered.
- **Token Estimation Debug Logging**: `refreshRealTokens()` no longer silently swallows SQLite errors. Logs DB errors via `getDbLastError()`, real vs estimated counts, and threshold comparisons at every compaction check.
- **Compaction Decision Logging**: All three compaction layers (opportunistic, proactive, hard) now log skip reasons with actual token values — threshold not met, cooldown, planning, compacting, etc.
- **Nudge Skip-Reason Logging**: Nudge logs why it's skipping (disabled, paused, continue pending, planning/compacting flags, no todo data vs no open todos, cooldown).
- **npm Package Resolution Fix**: Config changed from `"opencode-auto-continue"` (resolved to someone else's npm `0.1.1`) to `"@dracondev/opencode-auto-continue"` (our scoped package). Old cached packages deleted from `~/.cache/opencode/packages/`. Local symlink removed to prevent dual-load.

### v7.8.1602 Changes
- **SQLite Token Reader**: Compaction decisions now use real token counts from `~/.local/share/opencode/opencode.db` via `src/tokens.ts`. Fallback to event-based estimation when DB unavailable.
- **Nudge Fix**: Three root-cause bugs fixed — cancel-schedule-cancel race, 500ms delay causing stale todos, `session.todo()` API returning empty. Now uses cached `todo.updated` events.
- **Recovery Intent Preservation**: Tracks `lastFileEdited`/`lastToolCall`/`lastToolSummary` and injects `## Recovery Context` into continue messages.
- **Removed AI Advisor Module**: 270 lines of disabled-by-default dead code deleted.
- **Removed maxAutoSubmits**: Redundant with `maxRecoveries` — loop protection now uses `s.attempts >= config.maxRecoveries`.

### Dogfood Config
```json
["file:///home/dracon/Dev/opencode-auto-continue/dist/index.js", {
  "stallTimeoutMs": 45000,
  "maxRecoveries": 3,
  "sessionMonitorEnabled": true,
  "nudgeEnabled": true,
  "autoCompact": true,
  "debug": true
}]
```

## Overview

`opencode-auto-continue` is an OpenCode plugin that:
1. Detects stalled sessions (busy but no real progress)
2. Recovers via `session.abort()` + `continue` prompt
3. Nudges idle sessions with pending todos
4. Reviews completed todos
5. Emergency compaction on token limit errors
6. Provides real-time status via file/terminal
7. **NEW (v7.5)**: Monitors for orphan parent sessions and discovers missed sessions

## Configuration Reference

All config options are set in `opencode.json` under the plugin entry:

```json
["opencode-auto-continue", {
  "stallTimeoutMs": 45000,
  "maxRecoveries": 3,
  "debug": false
}]
```

### Core Recovery

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `stallTimeoutMs` | number | `45000` | Time without real output before considering session stalled |
| `busyStallTimeoutMs` | number | `180000` | Time without real output when session reports busy (3min) |
| `maxRecoveries` | number | `3` | Max recovery attempts per session |
| `cooldownMs` | number | `60000` | Min time between recovery attempts |
| `waitAfterAbortMs` | number | `5000` | Wait after abort before sending continue |
| `maxBackoffMs` | number | `1800000` | Max exponential backoff delay (30min) |
| `maxSessionAgeMs` | number | `7200000` | Max session age before giving up (2hr) |
| `planningTimeoutMs` | number | `300000` | Max time in planning state before forced recovery (5min) |
| `tokenEstimateMultiplier` | number | `1.0` | Multiplier for text-based token estimation (was hardcoded 2.0) |

### Session Monitor (v7.5)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionMonitorEnabled` | boolean | `true` | Enable session monitoring layer |
| `orphanWaitMs` | number | `15000` | Wait after subagent finish before treating parent as orphan |
| `sessionDiscoveryIntervalMs` | number | `60000` | How often to poll `session.list()` for missed sessions |
| `idleCleanupMs` | number | `600000` | Remove idle sessions after this time (10min) |
| `maxSessions` | number | `50` | Max sessions to keep in memory |

### Question Auto-Answer

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoAnswerQuestions` | boolean | `false` | Auto-answer AI multiple-choice questions with first (recommended) option |

### Test-Driven Quality Gate

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `testOnIdle` | boolean | `true` | Auto-run `testCommands` when session goes idle; inject failures into nudge |
| `testCommands` | string[] | `["cargo test"]` | Shell commands to run for test verification (sequentially) |
| `testCommandTimeoutMs` | number | `300000` | Per-command timeout in ms (5 minutes) |

### Nudge

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nudgeEnabled` | boolean | `true` | Enable idle nudging |
| `nudgeCooldownMs` | number | `30000` | Min time between nudges (30s) |
| `nudgeIdleDelayMs` | number | `0` | Delay before nudging after idle |
| `nudgeMaxSubmits` | number | `10` | Max nudges before loop protection |
| `includeTodoContext` | boolean | `true` | Include pending todos in nudge message |
| `continueWithTodosMessage` | string | `"..."` | Nudge message template with todo context |

### Compaction

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoCompact` | boolean | `true` | Enable proactive and opportunistic compaction |
| `proactiveCompactAtTokens` | number | `80000` | Token threshold for proactive auto-compaction |
| `opportunisticCompactAtTokens` | number | `60000` | Token threshold for opportunistic compaction |
| `hardCompactAtTokens` | number | `100000` | Token threshold for mandatory blocking compaction |
| `hardCompactMaxWaitMs` | number | `30000` | Max wait for hard compaction before proceeding anyway |
| `hardCompactBypassCooldown` | boolean | `true` | Hard compaction ignores `compactCooldownMs` |
| `compactCooldownMs` | number | `60000` | Min time between compactions (soft layers) |
| `compactMaxRetries` | number | `3` | Max compaction retry attempts |
| `compactRetryDelayMs` | number | `3000` | Delay between compaction retries |
| `compactionVerifyWaitMs` | number | `10000` | Max wait for compaction verification |
| `compactReductionFactor` | number | `0.7` | Expected context reduction ratio |
| `compactionSafetyTimeoutMs` | number | `15000` | Safety timeout to clear stuck `compacting` flag |

### Terminal & Status

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `terminalTitleEnabled` | boolean | `true` | Enable terminal title updates |
| `statusFileEnabled` | boolean | `true` | Enable status file writes |
| `statusFilePath` | string | `"~/.opencode/logs/auto-force-resume.status"` | Status file location |
| `debug` | boolean | `false` | Enable debug logging |

## New Features (v6.62+)

### Custom Prompts (Per-Session API)

Programmatically send dynamic, context-aware prompts to specific sessions.

```typescript
import { sendCustomPrompt } from "opencode-auto-continue";

await sendCustomPrompt(sessionId, {
  message: "Custom message: {contextSummary}",
  includeTodoContext: true,
  includeContextSummary: true,
  customPrompt: "Focus on performance bottlenecks"
});
```

**Features**:
- Full template variable support (`{pending}`, `{todoList}`, `{contextSummary}`, etc.)
- Optional todo context injection
- Optional session context summary
- Returns rendered message, todo list, and custom prompt for verification
- Used by both recovery and nudge modules

**Template variables**:
- `{pending}` — count of in_progress + pending todos
- `{total}` — total todo count
- `{completed}` — count of completed + cancelled todos
- `{todoList}` — comma-separated list of todo contents (up to 5)
- `{attempts}` — current recovery attempt number
- `{maxAttempts}` — max recovery attempts configured
- `{contextSummary}` — session context summary (when `includeContextSummary: true`)

**Recovery integration**: `buildRecoveryMessage()` accepts optional `customPrompt` and `includeContextSummary` parameters.

**Nudge integration**: `buildNudgeMessage()` accepts optional `customPrompt` and `includeContextSummary` parameters.

## New Features (v6.54+)

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

## Session Monitor (`src/session-monitor.ts`)

A passive monitoring layer that watches for session lifecycle issues the event system might miss. Added in v7.2.0 to close gaps identified by competitive analysis.

### Features

#### 1. Orphan Parent Detection
When a subagent finishes but the parent session stays stuck as "busy" forever:
- Monitors `busyCount` across all sessions via 5s timer
- Detects when count drops from >1 to 1 (subagent completion signal)
- Waits `orphanWaitMs` (15s default) for natural parent resume
- If parent still busy → triggers recovery (abort + continue)
- Prevents the "stuck parent after subagent" failure mode

#### 2. Session Discovery
Event hooks can miss sessions in edge cases (plugin loaded mid-session, SDK events dropped):
- Periodic `session.list()` polling every `sessionDiscoveryIntervalMs` (60s)
- Creates minimal `SessionState` for any untracked busy sessions
- Integrates seamlessly with existing recovery/nudge timers
- Does not interfere with sessions already being tracked

#### 3. Idle Session Cleanup
Prevents memory leaks in long-running OpenCode instances:
- Removes sessions idle > `idleCleanupMs` (10min default)
- Enforces `maxSessions` limit (50 default) — removes oldest idle first
- Timer-based, not event-driven (runs every 30s)
- Safe: only cleans sessions with no pending timers or operations

### Architecture

```
Plugin init → sessionMonitor.start()
                    │
                    ├── 5s timer ──► checkOrphanParents()
                    │                    │
                    │                    └── busyCount drop?
                    │                        ├── YES ──► wait 15s ──► recover parent
                    │                        └── NO  ──► do nothing
                    │
                    ├── 60s timer ──► discoverSessions()
                    │                    │
                    │                    └── session.list()
                    │                        ├── New session ──► create minimal state
                    │                        └── Known session ──► skip
                    │
                    └── 30s timer ──► cleanupIdleSessions()
                                         │
                                         └── idle > 10min OR count > 50?
                                             ├── YES ──► remove session
                                             └── NO  ──► keep

Events ──► sessionMonitor.touchSession(id)
              │
              └── updates lastActivityAt
```

### Integration Points

- **index.ts**: `sessionMonitor.start()` on plugin init, `sessionMonitor.stop()` on dispose
- **Events**: `touchSession()` called on `session.created`, `session.status(busy/retry)`, `message.part.updated(real progress)`
- **Recovery**: Orphan detection calls `recover()` from recovery module when parent stuck
- **State**: Shares the same `sessions` Map with all other modules

### Config

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `orphanWaitMs` | number | `15000` | Wait after subagent finish before treating parent as orphan |
| `sessionDiscoveryIntervalMs` | number | `60000` | How often to poll `session.list()` for missed sessions |
| `idleCleanupMs` | number | `600000` | Remove idle sessions after this time (10min) |
| `maxSessions` | number | `50` | Max sessions to keep in memory |

### When It Fires

| Scenario | Detection | Action |
|----------|-----------|--------|
| Subagent completes, parent stuck | busyCount >1 → 1 | Wait 15s, then recover parent |
| Plugin loaded mid-session | session.list() shows unknown busy session | Create minimal SessionState |
| Session idle for hours | cleanup timer | Remove from `sessions` Map |
| Too many sessions tracked | >50 sessions | Remove oldest idle sessions |

### Trade-offs

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| Timer-based monitoring | Orphan detection requires watching busyCount over time | Adds ~3 timers (5s, 30s, 60s) |
| Minimal session creation | Discovered sessions don't need full init | May miss config-dependent behaviors |
| Passive layer | Detects but delegates recovery | Keeps separation of concerns |
| Shared sessions Map | All modules see same state | Must be careful with cleanup timing |

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
| `hardCompacting` | Hard compaction blocking gate in progress — recovery/nudge/continue await |
| `userCancelled` | User pressed ESC / aborted — recovery disabled |

### Output Tracking Fields (v7.8.254+)

| Field | Type | Description |
|-------|------|-------------|
| `lastOutputAt` | `number` | Timestamp of last real output (text, tool, file, subtask, step parts) |
| `lastOutputLength` | `number` | Length of last text output content (detects even tiny progress) |
| `lastProgressAt` | `number` | Timestamp of last status ping OR real output (legacy, prefer `lastOutputAt`) |

These fields distinguish real progress from `session.status(busy)` pings. Recovery uses `lastOutputAt` for stall detection; `lastProgressAt` is maintained for backward compatibility.

### Recovery Intent Fields (v7.8.1602+)

| Field | Type | Description |
|-------|------|-------------|
| `lastFileEdited` | `string` | URL of last file the AI edited before stall |
| `lastToolCall` | `string` | Name of last tool the AI ran before stall |
| `lastToolSummary` | `string` | Human-readable summary: "edited tokens.ts", "ran npm test" |

These fields are tracked during `message.part.updated` events and injected as `## Recovery Context` into recovery continue messages.

### Event → State Transitions

| Event | Effect |
|-------|--------|
| `session.status (busy)` | Start stall timer. **Does NOT call `updateProgress()`** — status pings are not real output. Checks `busyStallTimeoutMs` for stuck sessions. **Does NOT clear `s.planning`** — session.status(busy) fires during plan generation too and must not destroy the plan flag |
| `session.status (idle)` | If `needsContinue` → send queued continue. Opportunistic compaction check only — nudge is handled by `session.idle`.
| `session.status (retry)` | Treat as busy (valid progress) |
| `message.updated` (assistant tokens) | Update `estimatedTokens` for status tracking |
| `message.updated` (user) | Reset counters, cancel nudge, reset `lastNudgeAt` |
| `message.part.updated` (real progress) | Reset stall timer, reset attempts, update `lastOutputAt` |
| `message.part.updated` (step-finish tokens) | Update `estimatedTokens` with actual token counts |
| `message.part.updated` (synthetic) | **Ignore** — prevents infinite loop |
| `message.part.updated` (compaction) | Set `compacting = true`, pause monitoring |
| `message.part.updated` (text with plan) | Set `planning = true`, pause monitoring |
| `message.part.updated` (tool/file/subtask/step-start/step-finish) | **Clear `s.planning = false`** — model has moved past planning into execution |
| `todo.updated` (all done) | Trigger review after debounce |
| `todo.updated` (has pending) | Set `hasOpenTodos = true`, start nudge timer |
| `question.asked` | Auto-reply with first option via `POST /question/{requestID}/reply` (gated by `autoAnswerQuestions`). Reset `lastOutputAt`/`lastProgressAt`, cancel nudge. Prevents session from stalling on AI questions. |
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
5. **SQLite real tokens preferred** — compaction decisions use real token counts from `session` table, fallback to event-based estimation
6. **Recovery queue** — `needsContinue` flag set by `recover()`, consumed by `session.status` handler when idle
6. **Plan/compaction pause** — stall timer and nudge timer both pause during these states
7. **Busy-but-dead detection** — `session.status(busy)` does not count as progress; only actual output updates `lastOutputAt`
8. **Tool-text recovery** — recovery uses specialized prompt when XML tool calls detected in reasoning
9. **Hallucination loop break** — 3+ continues in 10min forces abort+resume
10. **Prompt guard blocks duplicates** — checks recent messages before injecting
11. **Timer generation counter** — `timerGeneration` prevents stale timers from firing after being overwritten
12. **Planning timeout** — planning state blocked forever, recovery forced after `planningTimeoutMs`
13. **Continue retry limit** — max 3 retries with 5s backoff prevents infinite idle-event loops
14. **Nudge failure backoff** — exponential backoff prevents tight nudge loops on API errors
15. **Review reset** — `reviewFired` resets when new pending todos appear, enabling test-fix loops
16. **Hard compaction gate** — recovery/nudge/continue all `await maybeHardCompact()` when tokens exceed `hardCompactAtTokens`
17. **Compaction safety timeout** — `compactionSafetyTimeoutMs` force-clears stuck `compacting` flag if `session.summarize()` hangs
18. **Emergency failure recovery** — emergency compaction failure schedules recovery with backoff instead of abandoning session

## Nudge Architecture

### Single Trigger Path

Nudge is scheduled **only** from `session.idle` event to avoid cancel-schedule-cancel race with `session.status(idle)`. The `session.status(idle)` handler schedules opportunistic compaction only — nudge is left to `session.idle`.

### Cached Todos (Primary Source)

The nudge uses `s.lastKnownTodos` from `todo.updated` events as its primary data source. The `session.todo()` API is unreliable — it returns empty arrays even when todos exist. Only falls back to API when cache is empty.

### sendNudge() Guard Checks (in order)

```typescript
if (isDisposed) return;           // Plugin disposed
if (!s.lastUserMessageId) return;  // User recently engaged
if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) return; // Cooldown active
if (!s.hasOpenTodos) return;       // No pending todos
// Prompt guard — skip if similar prompt sent recently
// session.status() check — skip if busy/retry
// fetch todos for context (if includeTodoContext)
// send prompt with {pending}, {todoList}, {total}, {completed} template vars
```

### Nudge Message

Default: `"Continue working on the pending tasks and mark them as completed when done. **You must create todos for any new work you discover before starting it** — including planned work from earlier that isn't tracked yet. Do not ask for permission — act autonomously and keep making progress. Pending tasks: {todoList}."`

**All directive messages** (continue, continueWithTodos, review, nudge, continueWithPlan, shortContinue) now use imperative tone with explicit todo-creation mandates:
- `continueMessage`: "If you discover new work, create a todo for it before starting."
- `continueWithTodosMessage`: "**You must create todos for any new work you discover before starting it** — do not do untracked work."
- `reviewMessage`: "**Create fix todos for any bugs or failures you find before attempting fixes.** If you have planned work that isn't tracked yet, **create todos for it now** and then work through them."
- `nudgeMessage`: "**You must create todos for any new work you discover before starting it**"
- `continueWithPlanMessage`: "**create todos for each planned item**, then start executing"
- `shortContinueMessage`: "Create todos for any untracked work before starting it."

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
  ├─ session.abort()
  ├─ Poll session.status() until idle
  ├─ Wait waitAfterAbortMs (5000ms default)
  ├─ Check hallucination loop (3+ continues in 10min → abort+resume)
  ├─ Inject recovery context (last file/tool/plan before abort)
  ├─ session.promptAsync() with continue message
  └─ Set needsContinue = false, record recovery stats
```

### Busy-But-Dead Detection (v7.8.254+)

**Problem**: `session.status(busy)` fires repeatedly even when the AI is stuck ("busy but dead"). The old code treated status pings as progress, preventing recovery from ever firing.

**Solution**: Distinguish status pings from real output:

| Field | Purpose |
|-------|---------|
| `lastOutputAt` | Timestamp of last real output (text, tool, file, subtask, step parts) |
| `lastOutputLength` | Length of last text output (to detect even tiny progress) |
| `lastProgressAt` | Timestamp of last status ping OR real output |

**Behavior**:
- `session.status(busy)` no longer counts as progress — only actual message parts do
- If session reports busy but no real output for `busyStallTimeoutMs` (3min default) → immediate recovery with toast
- Recovery checks `lastOutputAt` first; if status pings are recent but output is stale, proceeds with recovery anyway

### Backoff After Max Recoveries

- 1st failure: immediate retry
- 2nd: 30s cooldown
- 3rd: 60s cooldown
- Beyond maxRecoveries: exponential backoff up to `maxBackoffMs: 1800000` (30min)

## Token Estimation (v7.8.1602+)

### Primary: SQLite Real Token Counts

The plugin reads actual token counts from OpenCode's SQLite database via `src/tokens.ts`:

- `getSessionTokens(sessionId)` queries `session` table: `tokens_input`, `tokens_output`, `tokens_reasoning`
- `getTokenCount(s)` helper: prefers `realTokens` > `estimatedTokens` (graceful fallback)
- `refreshRealTokens(sid)` called before every compaction decision
- Platform-aware path: `~/.local/share/opencode/opencode.db` (Linux), `~/Library/Application Support/opencode/opencode.db` (Mac)
- Uses `node:sqlite` (built-in, zero dependencies)

### Fallback: Event-Based Estimation (When DB Unavailable)

Three data sources (in order of accuracy):

1. **Error messages** (`session.error`) — exact counts from "You requested a total of 264230 tokens: 232230 input, 32000 output"
2. **step-finish parts** (`message.part.updated`) — `{ input, output, reasoning, cache }` per completion
3. **AssistantMessage** (`message.updated`) — `{ input, output, reasoning, cache }` per message

Token accumulation:
- `message.updated` (assistant): `s.estimatedTokens += input + output + reasoning`
- `message.part.updated` (step-finish): `s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens)`
- `session.error`: `s.estimatedTokens = Math.max(s.estimatedTokens, parsedTotal)`

**Text-based fallback estimation** (for tool/file/subtask parts without tokens):
- Tool calls: `chars × 1.0 / 4` tokens → multiplied by `tokenEstimateMultiplier` (default 1.0)
- File references: `chars × 0.75 / 4` tokens → multiplied by `tokenEstimateMultiplier`
- Subtask prompts: `chars × 0.75 / 4` tokens → multiplied by `tokenEstimateMultiplier`

**Note**: Text and reasoning parts are NOT estimated — they use actual token counts from `message.updated` (assistant tokens metadata). This prevents double-counting.

**Configurable multiplier**: Set `tokenEstimateMultiplier` in config (default 1.0). Previously hardcoded at 2.0, which caused massive overestimation.

## Context Compaction

The plugin manages context with **four compaction layers**, each with different triggers, thresholds, and urgency:

| Layer | Threshold | Style | Behavior |
|-------|-----------|-------|----------|
| **Opportunistic** | 40k tokens | Fire-and-forget | Low-priority cleanup on idle/recovery/review/nudge |
| **Proactive** | 60k tokens | Fire-and-forget | Pre-emptive before limits hit |
| **Hard** | 80k tokens | **Blocking gate** | Must succeed before recovery/nudge/continue proceed |
| **Emergency** | Token limit error | Retry 3x | Last resort on hard limit hit |

### Opportunistic Compaction

Fires at `opportunisticCompactAtTokens` (default: 60,000) at lifecycle points where the session is about to send a prompt but isn't actively generating. This cleans up context before the next operation pushes tokens higher.

**Trigger points** (all gated by their own config toggle):
- **Post-recovery** (`opportunisticCompactAfterRecovery`): After recovery success toast
- **On idle** (`opportunisticCompactOnIdle`): When session goes idle
- **Pre-nudge** (`opportunisticCompactBeforeNudge`): Before nudge fires (uses `nudgeCompactThreshold` = 80k)
- **Post-review** (`opportunisticCompactAfterReview`): After review completes

**Guards**: Not compacting, not planning, not stoppedByCondition, cooldown elapsed.

### Proactive Compaction

When `autoCompact: true` and estimated tokens exceed `proactiveCompactAtTokens` (default: 80k), the plugin triggers `session.summarize()` to reduce context before hitting hard limits.

**Called from**: Token-update events (`message.part.updated`, `session.created`, `session.idle`)

### Hard Compaction (NEW)

When tokens exceed `hardCompactAtTokens` (default: 100k), the hard compactor **blocks** until compaction succeeds or times out. This is a mandatory gate — recovery, nudge, and continue all `await` it before proceeding.

**Key differences from proactive**:
- Ignores `autoCompact` flag — always fires when threshold is exceeded
- Bypasses `compactCooldownMs` by default (`hardCompactBypassCooldown: true`)
- Sets `hardCompactionInProgress` flag to prevent concurrent hard compactions
- Respects `hardCompactMaxWaitMs` (default 30s) — returns false if exceeded but doesn't strand the session
- Called as gate in: `recover()`, `sendNudge()`, `sendContinue()`

### Emergency Compaction

- `session.error` with token limit message → `forceCompact(sid)`
- Retries up to `compactMaxRetries` (default: 3)
- **On failure**: Schedules recovery with exponential backoff instead of abandoning session

### Compaction Safety Timeout (NEW)

If `session.summarize()` hangs or fails without emitting `session.compacted`, the `compacting` flag could stay `true` forever, blocking all monitoring. The safety timeout (`compactionSafetyTimeoutMs`, default 15s) force-clears the flag.

### Compaction Flow

```
Opportunistic (50k)?
  ├── YES ──► maybeOpportunisticCompact() (fire-and-forget)
  └── NO  ──► continue

Proactive (100k)?
  ├── YES ──► maybeProactiveCompact() (fire-and-forget)
  └── NO  ──► continue

Hard (100k)?
  ├── YES ──► maybeHardCompact() (blocking gate)
  │              ├── success ──► proceed with recovery/nudge/continue
  │              └── timeout ──► proceed anyway (soft fail-open)
  └── NO  ──► proceed

Emergency (token limit error)?
  └── YES ──► forceCompact(sid)
                 ├── success ──► queue continue, resume
                 └── failure ──► schedule recovery with backoff
```

## Toast Notifications (v7.8.235+)

The plugin shows toast notifications via `input.client.tui.showToast()` to provide user visibility into its actions:

| Toast | Trigger | Meaning |
|-------|---------|---------|
| **Session Resumed** | Session goes busy within 30s after a nudge | AI resumed working after being nudged |
| **Recovery Successful** | Session goes busy within 30s after a continue | AI resumed working after recovery |
| **Nudge Failed** | Nudge prompt fails to send | Will retry with backoff |
| **Token Limit Reached** | Emergency compaction starts | Context was too large, compacting now |
| **Compaction Failed** | Emergency compaction fails | Manual intervention may be needed |

**State tracking**:
- `lastNudgeAt` — timestamp of last nudge send (reset on user messages to prevent false Session Resumed)
- `lastContinueAt` — timestamp of last continue send (reset on user messages to prevent false Recovery Successful)

## Status File

Written atomically (`.tmp` + rename) to `~/.opencode/logs/auto-force-resume.status` on every event.

Includes: elapsed time, recovery stats, stall detections, compaction info, todos, auto-submits, history, recovery histogram, stall patterns.

Config: `statusFileEnabled`, `statusFilePath`, `maxStatusHistory`, `statusFileRotate`

## Terminal Visibility

- **OSC 0/2 (title)**: `⏱️ 3m 12s | Last: 45s ago` — clears on idle
- **OSC 9;4 (progress)**: percentage bar in iTerm2/WezTerm/Windows Terminal/Ghostty

## Key Trade-offs

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| Token estimation from three sources | Error messages give exact counts; step-finish gives per-completion; AssistantMessage gives per-message | Running sum overestimates context (old msgs dropped) — but better early than late |
| All plugin prompts use `synthetic: true` | Semantic clarity: these are plugin-generated, not user messages. AI processes them identically regardless of flag. | Adds a toggle if user wants real-user-style prompts. No behavioral difference confirmed. |
| `needsContinue` queue mechanism | Prevents abort+prompt race condition with TUI | Extra flag to track |
| Last-known todos cache | Eliminates double-fetch in nudge.ts | Only updated on todo.updated events |
| Status file atomic writes | Never partial read during `tail -f` | Extra `.tmp` file per write |
| safeHook fail-open wrapper | Prevents plugin errors from crashing the host | Errors are logged but never propagated |
| Question auto-answer via `_client` SDK internals | No public API for question reply in v1 SDK | Breaks silently if OpenCode renames internal `_client` property |

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

This avoids repeated `fs.readFileSync` + `JSON.parse` on every status update.

## Debugging

Enable debug mode in `opencode.json`:
```json
["opencode-auto-continue", { "debug": true }]
```

Logs go to `~/.opencode/logs/auto-force-resume.log`.

## Bug Fixes History

### v7.8 (Current) - 34 Total Fixes

#### Initial Audit (9 Fixes)
1. **Stranded Continue Retry** - Added retry limit/backoff for idle-event retries
2. **Orphan Detection Dead Code** - Added heuristic for stuck busy sessions
3. **Planning Shield Forever Stall** - Added planning timeout (5min default)
4. **Dual Timer Race** - Added `timerGeneration` counter to prevent stale timers
5. **Triple Token Counting** - Deduplicated token estimation, added configurable `tokenEstimateMultiplier` (default 1.0)
6. **Nudge API Error** - Fallback to cached todos on fetch failure
7. **Review One-Shot** - Reset `reviewFired` when new todos appear
8. **0ms Recovery After Compaction** - Use `stallTimeoutMs` instead of 0
9. **Advisory Wrong Provider** - Match by model name instead of first available

#### Comprehensive Review (19 Fixes)
- **CRITICAL (4)**: Unified scheduleRecovery, sendContinue concurrency guard, recover() catch infinite loop, emergency compaction callback race
- **HIGH (5)**: Orphan threshold (30s→180s), complete clearTimer, prompt guard in sendContinue, nudge retry backoff, review retry
- **MODERATE (5)**: Discovered sessions busy check, configurable planningTimeoutMs, reduced shouldBlockPrompt limit (50→15), debounced status writes (500ms), max auto-submits UX
- **MINOR (5)**: Consistent state reset, removed redundant shouldUseAI, AbortController timeout leak, progressTypes array

#### Reanalysis (6 Fixes)
1. **Duplicate attempts increment** - Removed double `s.attempts++` in recovery.ts catch block
2. **Variable shadowing** - Fixed nudge.ts AI advisory block shadowing
3. **Duplicate state reset** - Removed duplicate assignments in resetSession()
4. **Indentation issue** - Fixed message.part.updated handler structure
5. **Silent failure** - Added error logging to shouldBlockPrompt
6. **Memory leak** - Clear old timer in scheduleRecoveryWithGeneration

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


