# Architecture

> Detailed architecture documentation for opencode-auto-continue.
> See [README.md](../README.md) for installation and quick start.

## How We Work

### Architecture Overview

The plugin is split into focused modules following the factory pattern:

```
index.ts                Main plugin — event routing, module wiring
├── terminal.ts         Terminal title, progress bar, statusLine hook
├── nudge.ts            Idle nudges with loop protection
├── status-file.ts      Atomic status file writes
├── recovery.ts         Stall recovery (abort + continue)
├── compaction.ts        4-layer compaction (opportunistic/proactive/hard/emergency)
├── review.ts            Review + continue prompt delivery
├── session-monitor.ts   Orphan parent detection
├── stop-conditions.ts   Stop condition evaluation
├── test-runner.ts       Test execution, gate files, lock contention detection
├── todo-poller.ts       Periodic todo API polling
├── tokens.ts            SQLite real token counts from OpenCode DB
├── dangerous-commands.ts  Dangerous command detection and blocking
├── shared.ts            Utilities, prompt guard, token estimation
├── config.ts            Plugin config interface, validation, defaults
└── session-state.ts     SessionState interface, token counting
├── types.ts             TypedPluginInput type alias (OpenCode SDK bridge)
```

Each module is initialized early and receives its dependencies:

```typescript
createTerminalModule({ config, sessions, log, input })
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

**4. Plan Awareness**
When plan content is detected, stall monitoring pauses until execution begins.

**5. Status File Writes**
Every meaningful event writes the status file atomically. This enables external monitoring without debug mode.

### Tool-Text Recovery (Catches XML Tool Calls in Reasoning)

Some models output XML tool calls inside their reasoning/text fields instead of using the proper tool-calling mechanism. The plugin detects this during recovery and sends a specialized prompt to execute the tool call.

```
[Stall detected → recover(sid)]
        │
        ▼
Scan ~20 recent messages for XML tool-like patterns
        │
        ├── Detects 17+ patterns:
        │   <function=...>, <invoke>, <tool_call>, <tool_call>,
        │   <invoke name="...">, <function_calls>,
        │   ```json tool calls, <|tool_call|>,
        │   <use_tools>, <function_chain>, <execute>, <run_tool>,
        │   <system-reminder> (role confusion),
        │   + truncated/unclosed tag patterns
        │
        ├── Also detects truncated/unclosed tags
        │
        └── Found XML tool calls?
              │
              ├──YES ──► Send specialized recovery prompt:
              │   "I noticed you have a tool call generated in your
              │    thinking/reasoning. Please execute it using the
              │    proper tool calling mechanism instead of XML tags."
              │
              └──NO ──► Use standard continue message
```

**Why this matters**: Models that output XML instead of executing tool calls get stuck — they think they ran the tool but actually didn't. This recovery prompt breaks that cycle.

**Trade-off**: Regex patterns may have rare false positives on legitimate XML in code (e.g., JSX, XML examples in documentation).

### Hallucination Loop Detection (Breaks Infinite Repeat Cycles)

When a model gets stuck repeating the same broken output (e.g., generating the same error over and over), the plugin detects the pattern and forces a short delay before continuing, breaking the cycle.

```
[Continue sent]
        │
        ▼
Record timestamp in sliding window
        │
        ▼
Check: 3+ continues within 10 minutes?
        │
              ├──YES ──► Short delay (3s) then continue
            │            The delay breaks the hallucination cycle
            │
            └──NO ──► Normal continue flow
```

**Why this matters**: Without this, a hallucinating model can generate the same broken output → plugin sends continue → model generates same broken output → infinite loop. The delay breaks the hallucination cycle — the model gets a moment to reset instead of looping the same broken output.

**Trade-off**: 3-in-10min threshold may catch legitimate rapid continues (e.g., fast-paced debugging sessions), but false positives are rare and only result in one extra abort+resume.

### Prompt Guard (Prevents Duplicate Injections Across Instances)

When multiple plugin instances or race conditions try to inject the same prompt, the prompt guard blocks duplicates.

```
[About to send nudge/continue/review]
        │
        ▼
Fetch recent messages (last ~15)
        │
        ▼
Check: similar prompt content already sent within 30 seconds?
        │
        ├──YES ──► This is a duplicate — skip
        │
        └──NO ──► Send the prompt (normal flow)
```

**Why this matters**: If two plugin instances or rapid events both trigger a continue, the session gets flooded with duplicate messages. The prompt guard ensures only one goes through.

**Key detail**: Uses text similarity (not exact match) — "Please continue working" and "Continue working on tasks" are treated as similar enough to dedupe.

**Fail-open**: If the message fetch fails, the prompt is allowed through (better to have a rare duplicate than miss a needed continue).

### Custom Prompts (Per-Session Dynamic Messages)

Send dynamic, context-aware prompts to specific sessions with full template variable support. Perfect for integrations, external triggers, or programmatic session management.

```typescript
import { sendCustomPrompt } from "opencode-auto-continue";

// Send a custom prompt to a session
await sendCustomPrompt(sessionId, {
  message: "Custom analysis request: {contextSummary}",
  includeTodoContext: true,
  includeContextSummary: true,
  customPrompt: "Focus on performance bottlenecks"
});
```

**When to use**: External integrations, webhooks, CLI tooling, or when you need to inject context-aware messages without manual intervention.

**Template variables available**:

| Variable | Description |
|----------|-------------|
| `{pending}` | Number of open tasks |
| `{total}` | Total tasks |
| `{completed}` | Completed tasks |
| `{todoList}` | Comma-separated pending tasks (max 5) |
| `{attempts}` | Current recovery attempt |
| `{maxAttempts}` | Max recovery attempts |
| `{contextSummary}` | Session context summary (when `includeContextSummary: true`) |

**API**:

```typescript
function sendCustomPrompt(
  sessionId: string,
  options: {
    message: string;              // Message template with {variables}
    includeTodoContext?: boolean; // Include todo list in message
    includeContextSummary?: boolean; // Include context summary
    customPrompt?: string;        // Additional custom prompt text
  }
): Promise<{
  success: boolean;
  message: string;                // Final rendered message
  todos?: Todo[];                 // Todo context (if fetched)
  customPrompt?: string;          // Custom prompt text (if provided)
  contextSummary?: string;        // Context summary (if requested)
}>
```

**Example with all options**:

```typescript
const result = await sendCustomPrompt("abc123", {
  message: "🔄 Recovery attempt {attempts}/{maxAttempts}. {contextSummary}",
  includeTodoContext: true,
  includeContextSummary: true,
  customPrompt: "Please prioritize the API integration task"
});

// Result:
// {
//   success: true,
//   message: "🔄 Recovery attempt 1/3. Working on 2 tasks: fix auth, update docs",
//   todos: [{ id: "1", content: "fix auth", status: "in_progress" }, ...],
//   customPrompt: "Please prioritize the API integration task",
//   contextSummary: "Working on 2 tasks: fix auth, update docs"
// }
```

### Plan-Aware Continue

When the AI is in a planning phase (detected by plan-related text in messages), recovery uses a plan-aware continue message instead of the generic one.

**What works now**:
- **Planning detection**: The plugin detects when the AI outputs planning text (e.g., "Here's my plan:") and sets a `planning` flag
- **Plan-aware continue**: When recovering during planning, it uses `continueWithPlanMessage` instead of `shortContinueMessage`

**Note**: The plugin does not parse external plan files (PLAN.md, ROADMAP.md, etc.). Planning is detected dynamically from the AI's output text.

### Review on Completion

When all todos are completed, the review prompt fires once per session:

```
[All todos completed]
        │
        ▼
Review fires (debounced 500ms)
        │
        ▼
AI receives review prompt
```

The default review message asks the AI to run tests and verify everything passes. The AI may create new fix todos if it finds failures.

**Note**: Review can fire multiple times per session. After a review fires and the AI creates new pending todos, the todo poller's `processTodos()` resets `reviewFired = false` when the `reviewCooldownMs` has elapsed, enabling another review cycle. If the AI completes all todos without creating new ones, review fires once and stays done. Additionally, if all todos complete while `reviewFired` is still set (e.g., from a previous cycle), the stale flag is reset after cooldown expires, ensuring reviews fire reliably in multi-cycle scenarios.

**Config**:
```json
{
  "reviewMessage": "All tasks have been completed. Please run the test suite...",
  "reviewOnComplete": true
}
```

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
         │                   session.abort()
        │                        │
        │                   Poll until idle (abortPollIntervalMs)
        │                        │
        │                   Wait waitAfterAbortMs
        │                        │
         │                   Check: attempts < maxRecoveries?
         │                        │
         │                   NO──► Exponential backoff
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
                            (if recovery in progress, schedules delayed fallback)
```

**Recovery module** (`createRecoveryModule`):
- Located in `src/recovery.ts`
- Called from event handlers in `index.ts`
- Receives `writeStatusFile` and `cancelNudge` as dependencies
- Uses `input as any` for all client API calls
- Sends continue via `sendContinue()` — guarded by `continueInProgress` flag and prompt guard
- If `session.idle` or `session.status(idle)` fires while `aborting=true`, both handlers schedule a 3-second delayed fallback that calls `sendContinue()` with `continueInProgress` guard, ensuring the continue fires even if the primary path was blocked

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
[session.idle] ──► scheduleNudge() ──► setTimeout(nudgeIdleDelayMs)
                                                   │
                                          [Timer fires] ──► injectNudge()
                                                               │
                                                    [Check cooldown] ──► YES ──► send nudge
                                                               │
                                                               NO ──► skip
```

**Nudge scheduling** (`scheduleNudge`):
- Fires on every `session.idle` with pending todos (NO wasBusy dedup)
- Also fires from the periodic todo poller (`processTodos`) as a fallback when `session.idle` events are unreliable — this ensures nudges still fire even if the idle event stream is disrupted
- Schedules via `setTimeout` with `nudgeIdleDelayMs` (default 0 = immediate)
- Resets nudge timer on `todo.updated` with pending todos
- Cancels pending nudge on `message.updated` (user), `session.error`, `session.deleted`

**Nudge injection** (`injectNudge`):
1. Check hard compaction (tokens > `hardCompactAtTokens` → await compaction first)
2. Check failure backoff (5s cooldown after nudge failure)
3. Check cooldown (`nudgeCooldownMs` default 30s)
4. Check session status (busy/retry → schedule retry, skip)
5. Check user message cooldown (skip if user messaged recently)
6. Check `nudgePaused` flag (set on MessageAbortedError, cleared on user message)
7. Run test commands if `testOnIdle` enabled (failures change nudge message to "fix tests")
8. Check loop protection (`nudgeMaxSubmits` default 10)
9. Fetch todos via API for context
10. Send nudge via `session.prompt()`

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
        │                                              │
        │                             [Compaction may fire here]
        │
        └──NO──► Clear any pending debounce
```

**Compaction during review**: If tokens exceed `opportunisticCompactAtTokens` after review fires, opportunistic compaction triggers during the review cycle. This is safe — the review prompt still reaches the AI because `session.compacted` does not clear `reviewFired`. The `session.compacted` handler checks `!s.compacting` before sending continue, so it waits until compaction is fully done before sending its own continue (chained after compaction completes).

**Multi-cycle review**: After a review fires and the AI creates new pending todos, `processTodos()` resets `reviewFired = false` when `reviewCooldownMs` has elapsed, enabling another review cycle when todos complete again.

### Session Monitor (v7.5)

A passive monitoring layer that watches for session lifecycle issues the event system might miss.

**Orphan Parent Detection**: When a subagent finishes but the parent session stays stuck as "busy" forever:
- Monitors `busyCount` across all sessions via 5s timer
- Detects when count drops from >1 to 1 (subagent completion signal)
- Waits `orphanWaitMs` (15s default) for natural parent resume
- If parent still busy → triggers recovery (abort + continue)

**Why timers instead of events?** Orphan detection requires watching busyCount _over time_ — a single event can't detect "was >1 now =1".

**Config**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionMonitorEnabled` | boolean | `true` | Enable session monitoring layer |
| `subagentWaitMs` | number | `15000` | Wait after subagent finish before treating parent as orphan |

**Integration**:
- `touchSession()` called on: session.created, session.status(busy/retry), message.part.updated(real progress)
- Orphan detection calls recovery.ts when parent stuck
- State shares the same sessions Map with all other modules


## How Compaction Works

The plugin manages context with **four compaction layers**, each with different triggers and urgency:

| Layer | Threshold | Style | When It Fires |
|-------|-----------|-------|---------------|
| **Opportunistic** | 60k tokens | Fire-and-forget | Post-recovery, on-idle, pre-nudge, post-review |
| **Proactive** | 80k tokens | Fire-and-forget | Token updates, session create, pre-continue |
| **Hard** | 100k tokens | **Blocking gate** | Before recovery, nudge, or continue |
| **Emergency** | Token limit error | Retry 3x | On `session.error` with limit message |

### Opportunistic Compaction

At `opportunisticCompactAtTokens` (default: 60k), the plugin cleans up context during idle moments before the next operation pushes tokens higher. This is low-priority "housekeeping" compaction.

**Triggers**: After recovery success, session idle, before nudge, after review.

### Proactive Compaction

When `autoCompact: true` and estimated tokens exceed `proactiveCompactAtTokens` (default: 80k), the plugin triggers `session.summarize()` to reduce context before hitting hard limits.

### Hard Compaction (Blocking Gate)

When tokens exceed `hardCompactAtTokens` (default: 100k), the hard compactor **blocks** until compaction succeeds or times out. Recovery, nudge, and continue all `await` it before proceeding.

- Always fires (ignores `autoCompact` flag)
- **Fires even when session is planning** — at 100k+ tokens, the context danger outweighs any planning concern
- Bypasses cooldown by default (`hardCompactBypassCooldown: true`)
- Respects `hardCompactMaxWaitMs` (default 30s, scaled up for massive sessions) — returns false if exceeded but doesn't strand the session

### Emergency Compaction (Token Limit Errors)

When a token limit error is detected:
1. Parse exact token counts from error message
2. Call `session.summarize()` with progressive verification
3. Wait 2s → check if session idled
4. Wait 3s → check again
5. Wait 5s → check again
6. If compaction fails → schedule recovery with backoff instead of abandoning session

**Post-compaction token reset**:
After compaction completes, estimated tokens are recalculated using `compactReductionFactor`:
```
estimatedTokens = estimatedTokens * compactReductionFactor
```
With default factor 0.7: `estimatedTokens = estimatedTokens * 0.7` (70% remain, 30% removed)

The factor represents the fraction of tokens **remaining** after compaction. Compaction removes ~30% of context at default settings.

### Why Four Layers?

- **Opportunistic** (60k): Gentle cleanup during idle moments
- **Proactive** (80k): Pre-emptive before limits hit
- **Hard** (100k): Mandatory gate — blocks operations until compacted
- **Emergency**: Safety net for edge cases that slip through

### Double Compact Prevention (v7.8.1904+) & Token Drift Fix (v7.14.35+)

After `session.compacted` fires, the SQLite DB still holds pre-compaction token counts (they accumulate over the session's lifetime — `tokens_input` is a lifetime total, not current context). Without intervention, `getTokenCount()` would return values like 29M tokens from the DB instead of the actual ~70k context size.

**Initial fix (v7.8.1904)**:

1. **Grace period guard** (`compactionGracePeriodMs`, default 10s): All 3 compaction layers skip if `lastCompactionAt` is within this window, even if `hardCompactBypassCooldown: true`. Prevents triggering while DB values are stale.

2. **`realTokensBaseline` tracking on `session.compacted`**: Sets `realTokensBaseline = realTokens` (the lifetime token total at compaction time). After this, `getTokenCount()` switches from cumulative DB values to `estimatedTokens` (already reduced by `compactReductionFactor`). This prevents the massive token count discrepancy (29M DB vs 70k actual) from triggering false compaction.

**Drift problem (v7.14.35 fix)**: After repeated compactions, `estimatedTokens` could drift downward because the reduction factor is applied each time while accumulation may undershoot (e.g., assistant message text is estimated from `info.tokens` which isn't always available). This caused compaction to stop firing even as the context grew. The fix: `getTokenCount()` now uses `Math.max(estimatedTokens, realTokens - realTokensBaseline)` — a floor set by the actual DB growth since last compaction prevents the count from dropping below real context growth:

```typescript
// session-state.ts — getTokenCount()
if (s.realTokensBaseline > 0 && s.realTokens > 0) {
  const growth = Math.max(0, s.realTokens - s.realTokensBaseline);
  return Math.max(s.estimatedTokens, growth);  // floor by DB growth
}
```

The `refreshRealTokens()` throttle:
- `realTokens > 0 && now - lastRealTokenRefreshAt < 10s` → return cached
- After baseline is set: returns `Math.max(estimatedTokens, growth)` where growth is new tokens since last compaction
- Immediately after compaction: `growth = 0` → returns `estimatedTokens` (no loop)
- After 50k new tokens: `growth = 50k` → returns `max(estimatedTokens, 50k)` (prevents drift)

`forceCompact()` (emergency) is NOT blocked by grace period — token limit errors require immediate action.

### Scaled Verify Wait for Massive Sessions

The verify wait (`compactionVerifyWaitMs`) is scaled by token count to accommodate very large sessions:

| Token Count | Multiplier | Example (30s default) |
|------------|------------|----------------------|
| < 200k | 1× | 30s wait |
| 200k–500k | 2× | 60s wait |
| > 500k | 3× | 90s wait |

Sessions with millions of tokens (e.g., 29M from cumulative DB counts) need significantly more time for `session.summarize()` to complete.

### Token Estimation

The plugin estimates token usage from three actual data sources:

#### Token Sources (in order of accuracy)

| Source | Event | What's Available |
|--------|-------|------------------|
| **1. Error messages** | `session.error` | Exact counts: "You requested a total of 264230 tokens: 232230 input, 32000 output" |
| **2. step-finish parts** | `message.part.updated` | `{ input, output, reasoning, cache }` per completion |
| **3. AssistantMessage** | `message.updated` | `{ input, output, reasoning, cache }` per message |

#### How Tokens Are Tracked

```typescript
// message.updated (AssistantMessage.tokens)
if (info?.role === "assistant" && info?.tokens) {
    s.estimatedTokens += tokens.input + tokens.output + tokens.reasoning;
}

// message.part.updated (step-finish.tokens)
if (partType === "step-finish" && part?.tokens) {
    s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens);
}

// session.error (parseTokensFromError)
const { total, input, output } = parseTokensFromError(err);
s.estimatedTokens = Math.max(s.estimatedTokens, total);
```

**Ratios used for text-based estimation** (fallback only):
- English text: ~0.35 tokens/char
- Code: ~0.50 tokens/char
- Digits/numbers: ~0.25 tokens/char

#### Why session.status() Doesn't Help

The OpenCode SDK's `SessionStatus` type is only:
```typescript
type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry", attempt, message, next }
```

There are NO token count fields in `session.status()`. The plugin relies on the three sources above instead.

#### Estimated vs Actual Context

**Important**: Our `estimatedTokens` is a running sum of all message tokens we've seen. This WILL exceed the actual context window because:
- Old messages get dropped from context as new ones are added
- Pre-existing context (before plugin started) isn't counted

This is intentional — we'd rather over-estimate and compact early than hit the limit.

#### Post-Compaction Growth Tracking

After compaction, `estimatedTokens` is reduced by `compactReductionFactor`. If it drifts too low (e.g., because `info.tokens` is missing for assistant messages), `getTokenCount()` uses the actual DB growth as a floor:

```
growth = max(0, realTokens - realTokensBaseline)
effective = max(estimatedTokens, growth)
```

This ensures that even if `estimatedTokens` undershoots, we never ignore more than 80k tokens of new content between compactions.

### How to Verify Compaction Is Working

1. Check the status file:
   ```bash
   watch -n 2 'cat ~/.opencode/logs/auto-force-resume.status'
   ```
   Look for `"compaction"` section - if `"lastCompactAt"` is set, emergency compaction fired.

2. Watch debug logs:
   ```bash
   tail -f ~/.opencode/logs/auto-force-resume.log | grep -i compact
   ```
   You should see entries like:
   ```
   "token limit error detected (hit #1) for session: abc123"
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
| `session.created` | Initialize session state, inject dangerous command warning |
| `session.status` (busy) | Start/reset stall timer (status pings do NOT count as progress) |
| `session.status` (idle) | Send queued continue if `needsContinue`; if recovery in progress (`aborting=true`), schedule 3s delayed fallback; trigger opportunistic compaction |
| `session.status` (retry) | Treat as busy (progress indicator) |
| `session.compacted` | Clear compacting flag, reset estimates, queue continue, re-schedule nudge |
| `session.idle` | Poll todos, schedule nudge if open todos exist; if recovery in progress (`aborting=true`), schedule 3s delayed fallback instead of sending directly |
| `session.updated` | Write status file |
| `session.deleted` / `session.ended` | Full session cleanup |
| `message.updated` (assistant) | Accumulate token counts |
| `message.updated` (user) | Reset all counters, cancel nudge |
| `message.part.updated` (real progress) | Update timestamps, reset attempts, trigger compaction check |
| `message.part.updated` (text/reasoning with tool-call-as-text) | Do NOT reset progress — model stuck generating XML |
| `message.part.updated` (compaction) | Set `compacting = true`, start safety timeout |
| `message.part.updated` (plan text) | Set `planning = true`, schedule planning timeout |
| `message.part.updated` (tool/file/subtask/step) | Clear `planning` flag, update tool loop counter |
| `todo.updated` (all done) | Trigger review after debounce |
| `todo.updated` (has pending) | Set `hasOpenTodos = true` |
| `question.asked` | Auto-reply with first option if `autoAnswerQuestions` enabled |
| `message.created` / `message.part.added` | Reset timer, reset attempts |
| `message.updated` (user) | Reset counters, cancel nudge |
| `session.error` (MessageAbortedError) | Set userCancelled, clear timer |
| `session.error` (token limit) | Trigger emergency compaction |
| `session.error` (other) | Clear timer, monitoring pauses |
| `todo.updated` | Check completion, trigger review/nudge |
| `session.idle` | Trigger nudge for pending todos |
| `session.deleted` | Clear all session state |
