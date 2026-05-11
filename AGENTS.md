# Agent Instructions for opencode-auto-continue

## Current State (v7.8.306)

**Status:** Released & Dogfooding  
**Tests:** 389/389 passing  
**GitHub:** https://github.com/DraconDev/opencode-auto-continue/releases/tag/v7.8.306

### v7.8.306 Changes
- **Busy-But-Dead Detection**: Distinguishes status pings from real output using `lastOutputAt`/`lastOutputLength` tracking
- **Toast Notifications**: Session Resumed, Recovery Successful, Nudge Failed, Token Limit, Compaction Failed
- **Runtime Validation**: Added validation for `planningTimeoutMs`, `tokenEstimateMultiplier`, `busyStallTimeoutMs`
- **Memory Leak Fix**: Clear `customPromptRuntimes` Set on plugin dispose
- **Config Safety**: All new config options validated at runtime

### v7.8.212 Changes
- **Directive Messages**: All recovery/nudge/review messages use imperative tone with anti-loop guards ("Do not ask for permission — just proceed")
- **Planned Work Tracking**: Messages now prompt AI to create todos for planned work that isn't tracked yet
- **34 Bug Fixes**: Timer races, state corruption, recovery loops, token counting, nudge reliability

### Dogfood Config
```json
["opencode-auto-continue", {
  "stallTimeoutMs": 45000,
  "maxRecoveries": 3,
  "sessionMonitorEnabled": true,
  "nudgeEnabled": true,
  "autoCompact": true,
  "debug": false
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

### Nudge

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nudgeEnabled` | boolean | `true` | Enable idle nudging |
| `nudgeCooldownMs` | number | `300000` | Min time between nudges (5min) |
| `nudgeIdleDelayMs` | number | `5000` | Delay before nudging after idle |
| `includeTodoContext` | boolean | `true` | Include pending todos in nudge message |
| `continueWithTodosMessage` | string | `"..."` | Nudge message template with todo context |

### Compaction

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoCompact` | boolean | `true` | Enable proactive compaction |
| `proactiveCompactAtTokens` | number | `100000` | Token threshold for auto-compaction |
| `compactCooldownMs` | number | `60000` | Min time between compactions |
| `compactMaxRetries` | number | `3` | Max compaction retry attempts |
| `compactReductionFactor` | number | `0.7` | Expected context reduction ratio |

### AI Advisory

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableAdvisory` | boolean | `false` | Enable AI/heuristic session analysis |
| `advisoryModel` | string | `""` | AI model for advisory calls |
| `advisoryTimeoutMs` | number | `5000` | Max wait for AI advisory response |
| `advisoryMaxTokens` | number | `500` | Max tokens in AI advisory response |
| `advisoryTemperature` | number | `0.1` | Temperature for AI calls |

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

## Dynamic Context Pruning (DCP) Integration

**Recommended**: Install DCP (`@tarquinen/opencode-dcp`) alongside this plugin for best context management.

### Why DCP?

DCP handles context optimization far better than our naive `session.summarize()` approach:

| Feature | Our Plugin | DCP |
|---------|-----------|-----|
| Proactive pruning | **Delegated to DCP** | `compress` tool called by model |
| Emergency compaction | `summarize()` on token limit errors | May not catch all edge cases |
| Message dedup | None | Yes — removes repeated tool calls |
| Error purge | None | Yes — prunes errored tool inputs |
| Soft thresholds | N/A (DCP handles) | 50k-100k range with nudges |
| Context preservation | Manual hook injection | Protected tools, user messages, file patterns |

### Auto-Detection

The plugin auto-detects DCP by checking:
1. Global `opencode.json` for DCP in `plugin` array
2. `~/.config/opencode/plugins/opencode-dynamic-context-pruning/`
3. `~/.cache/opencode/node_modules/@tarquinen/opencode-dcp/`

When detected:
- `config.dcpDetected = true`
- Our emergency compaction still fires on token limit errors (DCP may not catch everything)
- Our `experimental.session.compacting` hook still injects session state (todos, planning status)

### DCP Defaults (for reference)

```json
{
  "compress": {
    "maxContextLimit": 100000,
    "minContextLimit": 50000,
    "nudgeFrequency": 5,
    "mode": "range",
    "permission": "allow"
  },
  "strategies": {
    "deduplication": { "enabled": true },
    "purgeErrors": { "enabled": true, "turns": 4 }
  }
}
```

## AI Advisory Module (`src/ai-advisor.ts`)

The plugin includes a hybrid advisory system (270 lines) that analyzes session state before making recovery/nudge decisions. **AI advises, hardcoded rules decide** — simple/obvious decisions stay fast (hardcoded), edge cases get AI or heuristic analysis.

### Architecture

```
[Decision needed: abort? nudge? wait?]
        │
        ▼
shouldUseAI() checks config + session age
        │
        ├──YES──► extractContext() → 3 recent messages + stall info + todos + tokens
        │            │
        │            ├── AI configured (advisoryModel set)? → callModel(session, prompt)
        │            │      │
        │            │      └── Parse response for @{action}:{confidence}
        │            │            e.g. "@wait:0.85" or "@abort:0.70"
        │            │
        │            └── AI fails/times out? → fall back to heuristic patterns
        │
        └──NO──► Use fallback: heuristic analysis (always available)
                      │
                      └── 7 heuristic patterns → advice
```

### 7 Heuristic Patterns

| # | Pattern | Condition | Advice | Rationale |
|---|---------|-----------|--------|-----------|
| 1 | New session | `elapsedMs < 30000` | `wait` | Session just started, give it time |
| 2 | Repeated stall | `lastPartType === lastStallPartType` | `abort` | Stuck in same pattern, need fresh context |
| 3 | Mixed patterns | Different part types before stall | `wait` | Making progress across different activities |
| 4 | Long planning | `planningDurationMs > 60000` | `abort` | Stuck planning, need to start executing |
| 5 | High tokens + todos | tokens > 80% limit + open todos | `continue` | Context is full but work remains |
| 6 | High tokens, no todos | tokens > 80% limit + all done | `compact` | Clean up context, wrap up |
| 7 | Stalled with todos | session stalled + open todos | `continue` | Keep pushing toward completion |

### Integration Points

- **Recovery** (`recovery.ts`): Before the final abort attempt in `recover()`, calls `shouldUseAI()` then `getAdvice()`. If advice is `wait` with ≥0.7 confidence, skips abort entirely. Logs all advice regardless.

### Config

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableAdvisory` | boolean | `false` | Enable AI/heuristic session analysis |
| `advisoryModel` | string | `""` | AI model for advisory calls (e.g. `"gemma-4-31b-it"`) |
| `advisoryTimeoutMs` | number | `5000` | Max wait for AI advisory response (ms) |
| `advisoryMaxTokens` | number | `500` | Max tokens in AI advisory response |
| `advisoryTemperature` | number | `0.1` | Temperature for AI calls (low = deterministic) |

### AI Provider Call

When `enableAdvisory: true` and `advisoryModel` is set, the advisor:
1. Extracts session context: last 3 messages, stall time, stall count, open todos, token estimate, recovery attempts, part type
2. Calls OpenAI-compatible chat completions endpoint using `baseURL` and `apiKey` from the model config found in `opencode.json`
3. Expects response format: `@{action}:{confidence}` where action is `wait`, `abort`, `continue`, or `compact`
4. Falls back to heuristics on failure/timeout

### Trade-offs

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| AI advises, rules decide | Hardcoded rules are instant; AI adds latency | Edge cases get smarter handling |
| No AI for simple stalls | New sessions (<30s) clearly don't need abort | Heuristic covers 7 common patterns |
| Fallback chain | AI → heuristic → hardcoded | Graceful degradation |
| Read-only advice | Advisor never aborts/continues directly | Session module retains control |

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
| `userCancelled` | User pressed ESC / aborted — recovery disabled |

### Event → State Transitions

| Event | Effect |
|-------|--------|
| `session.status (busy)` | Start stall timer, update progress. **Does NOT clear `s.planning`** — session.status(busy) fires during plan generation too and must not destroy the plan flag |
| `session.status (idle)` | If `needsContinue` → send queued continue. If `hasOpenTodos` → send nudge. |
| `session.status (retry)` | Treat as busy (valid progress) |
| `message.updated` (assistant tokens) | Update `estimatedTokens` for status tracking |
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
7. **Tool-text recovery** — recovery uses specialized prompt when XML tool calls detected in reasoning
9. **Hallucination loop break** — 3+ continues in 10min forces abort+resume
10. **Prompt guard blocks duplicates** — checks recent messages before injecting
11. **Timer generation counter** — `timerGeneration` prevents stale timers from firing after being overwritten
12. **Planning timeout** — planning state blocked forever, recovery forced after `planningTimeoutMs`
13. **Continue retry limit** — max 3 retries with 5s backoff prevents infinite idle-event loops
14. **Nudge failure backoff** — exponential backoff prevents tight nudge loops on API errors
15. **Review reset** — `reviewFired` resets when new pending todos appear, enabling test-fix loops

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
  ├─ session.abort()
  ├─ Poll session.status() until idle
  ├─ Wait waitAfterAbortMs (5000ms default)
  ├─ Check hallucination loop (3+ continues in 10min → abort+resume)
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

**Text-based fallback estimation** (for tool/file/subtask parts without tokens):
- Tool calls: `chars × 1.0 / 4` tokens → multiplied by `tokenEstimateMultiplier` (default 1.0)
- File references: `chars × 0.75 / 4` tokens → multiplied by `tokenEstimateMultiplier`
- Subtask prompts: `chars × 0.75 / 4` tokens → multiplied by `tokenEstimateMultiplier`

**Note**: Text and reasoning parts are NOT estimated — they use actual token counts from `message.updated` (assistant tokens metadata). This prevents double-counting.

**Configurable multiplier**: Set `tokenEstimateMultiplier` in config (default 1.0). Previously hardcoded at 2.0, which caused massive overestimation.

## Context Compaction (Emergency Only)

**Proactive compaction is delegated to DCP** (`@tarquinen/opencode-dcp`). This plugin only handles **emergency compaction** on token limit errors.

### When Emergency Compaction Fires

- `session.error` with token limit message → `forceCompact(sid)`
- Retries up to `compactMaxRetries` (default: 3)
- Only when session is idle (busy sessions cannot be summarized)

### Why No Proactive Compaction?

DCP's `compress` tool is superior:
- Soft thresholds (50k-100k range) vs hard 100k limit
- Message deduplication
- Error pruning
- Protected context (tools, user messages, file patterns)

Our emergency compaction is a safety net for edge cases DCP doesn't catch.

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

| Tool-text recovery | Catches XML-in-reasoning stalls | 18 regex patterns may have false positives |
| Hallucination loop break | Prevents infinite loops | 3-in-10min threshold may catch legitimate rapid continues |
| Prompt guard | Prevents duplicate injections | Extra API call per prompt (~50-200ms) |
| AI advisory hybrid | AI advises, rules decide — edge cases get smart analysis | Heuristic covers 7 patterns; full AI adds latency/cost |
| Advisory fallback chain | AI → heuristic → hardcoded | Graceful degradation at cost of complexity |
| Read-only advisor | Never aborts or continues directly | Session module retains full control |

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
6. **Check advisory** — if `enableAdvisory: true`, advisor may have recommended skipping the nudge. Check logs for advisory advice.

### Recovery not triggering
1. Check `maxRecoveries > 0`
2. Check `userCancelled` flag — ESC aborts recovery permanently
3. Check `planning` or `compacting` flags — pauses monitoring
4. Check exponential backoff — after maxRecoveries, waits up to 30min

### UI breakage
- Debug mode OFF by default — file logging can cause TUI crashes
- No `console.log`/`console.error` in production paths


