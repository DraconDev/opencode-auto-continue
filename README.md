# opencode-auto-continue

The ultimate OpenCode plugin for session management. **One plugin replaces three**: auto-recovery, todo-reminders, and review-on-completion — all with zero conflicts.

## What It Does

| Feature | Replaces | What It Does |
|---------|----------|--------------|
| **Stall Recovery** | Manual intervention | Detects stuck sessions, aborts them, sends continue |
| **Todo Context** | `opencode-todo-reminder` | Fetches open todos, includes them in recovery messages |
| **Review on Completion** | `opencode-auto-review-completed-todos` | Sends review prompt when all todos are done |
| **Nudger** | Nothing — unique feature | Gentle reminders for idle sessions with open todos |
| **4-Layer Compaction** | Nothing — unique feature | Opportunistic/Proactive/Hard/Emergency — all with token reduction |
| **Question Auto-Answer** | Nothing — unique feature | Auto-replies to AI multi-choice questions with recommended option |
| **Plan-Aware Continue** | Nothing — unique feature | Detects planning phase and uses `continueWithPlanMessage` when recovering |
| **Tool-Text Recovery** | Nothing — unique feature | Detects XML tool calls in reasoning, sends recovery prompt |
| **Hallucination Loop Detection** | Nothing — unique feature | Breaks infinite loops with abort+resume |
| **Prompt Guard** | Nothing — unique feature | Prevents duplicate injections across plugin instances |
| **Custom Prompts** | Nothing — unique feature | Per-session custom prompts with template variables |
| **Session Monitor** | Nothing — unique feature | Detects orphan parents, discovers missed sessions, cleans idle sessions |
| **Terminal Timer** | Nothing — unique feature | Shows elapsed time in terminal title bar |
| **Session Status File** | Nothing — unique feature | Real-time JSON status for external monitoring |
| **Stall Pattern Detection** | Nothing — unique feature | Tracks which part types cause the most stalls |
| **Terminal Progress Bar** | Nothing — unique feature | OSC 9;4 progress in terminal tabs (iTerm2, WezTerm, etc.) |

**Delegated to other plugins:**
- 🔄 **Toast notifications** → [`@mohak34/opencode-notifier`](https://github.com/mohak34/opencode-notifier) or similar |

> 📊 **Want to understand the internals?** See the [Flow Chart](docs/FLOW-CHART.md) for a detailed breakdown of every state transition, guard check, and decision point.

## How We Work

### Architecture Overview

The plugin is split into 7 focused modules following the factory pattern:

```
index.ts              Main plugin — event routing, module wiring
├── terminal.ts       Terminal title, progress bar, statusLine hook
├── nudge.ts          Idle nudges with loop protection
├── status-file.ts    Atomic status file writes
├── recovery.ts       Stall recovery (abort + continue)
├── compaction.ts     4-layer compaction (opportunistic/proactive/hard/emergency)
├── review.ts         Review + continue prompt delivery
└── shared.ts         Types, config, utilities
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

**6. Module Architecture**
The plugin uses a factory pattern with focused modules:

```typescript
createStatusFileModule({ config, sessions, log })   // Atomic status file writes
createRecoveryModule({ config, sessions, log, input, isDisposed, writeStatusFile, cancelNudge })  // Stall recovery
createNudgeModule({ config, sessions, log, isDisposed, input })  // Idle nudges with loop protection
createCompactionModule({ config, sessions, log, input })  // 4-layer compaction
createTerminalModule({ config, sessions, log, input })  // Terminal title/progress/hook
```

Each module is initialized early and its API is called from event handlers in `index.ts`.

### Tool-Text Recovery (Catches XML Tool Calls in Reasoning)

Some models output XML tool calls inside their reasoning/text fields instead of using the proper tool-calling mechanism. The plugin detects this during recovery and sends a specialized prompt to execute the tool call.

```
[Stall detected → recover(sid)]
        │
        ▼
Scan ~20 recent messages for XML tool-like patterns
        │
        ├── Detects 18 patterns:
        │   <function=...>, <invoke>, <tool_call>, <tool_call>,
        │   <invoke name="...">, <function_calls>, <function name="...">,
        │   [FunctionCalling], [TOOL_CALLS], [tool_calls],
        │   ```json { "function":, ```json { "tool_calls":,
        │   <|tool_call|>, <TOOL>, [FUNCTION], <use_tools>,
        │   <function_chain>, <execute>, <run_tool>
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

**Trade-off**: 18 regex patterns may have rare false positives on legitimate XML in code (e.g., JSX, XML examples in documentation).

### Hallucination Loop Detection (Breaks Infinite Repeat Cycles)

When a model gets stuck repeating the same broken output (e.g., generating the same error over and over), the plugin detects the pattern and forces a fresh start.

```
[Continue sent]
        │
        ▼
Record timestamp in sliding window
        │
        ▼
Check: 3+ continues within 10 minutes?
        │
        ├──YES ──► Force abort+resume
        │            Instead of another continue, do a full session reset
        │            to break the hallucination cycle
        │
        └──NO ──► Normal continue flow
```

**Why this matters**: Without this, a hallucinating model can generate the same broken output → plugin sends continue → model generates same broken output → infinite loop. The abort+resume forces the model to start fresh with a clean context.

**Trade-off**: 3-in-10min threshold may catch legitimate rapid continues (e.g., fast-paced debugging sessions), but false positives are rare and only result in one extra abort+resume.

### Prompt Guard (Prevents Duplicate Injections Across Instances)

When multiple plugin instances or race conditions try to inject the same prompt, the prompt guard blocks duplicates.

```
[About to send nudge/continue/review]
        │
        ▼
Fetch recent messages (last ~50)
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

**Note**: Review is **one-shot per session** (`reviewFired` resets only on `session.deleted` / `session.ended`). If the AI creates fix todos after review, you'll need to manually trigger review again or wait for the session to end.

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

### Session Monitor (v7.5)

A passive monitoring layer that watches for session lifecycle issues the event system might miss.

#### Features

**1. Orphan Parent Detection**
When a subagent finishes but the parent session stays stuck as "busy" forever:
- Monitors `busyCount` across all sessions via 5s timer
- Detects when count drops from >1 to 1 (subagent completion signal)
- Waits `orphanWaitMs` (15s default) for natural parent resume
- If parent still busy → triggers recovery (abort + continue)

**2. Session Discovery**
Event hooks can miss sessions in edge cases (plugin loaded mid-session, SDK events dropped):
- Periodic `session.list()` polling every `sessionDiscoveryIntervalMs` (60s)
- Creates minimal `SessionState` for any untracked busy sessions
- Integrates seamlessly with existing recovery/nudge timers

**3. Idle Session Cleanup**
Prevents memory leaks in long-running OpenCode instances:
- Removes sessions idle > `idleCleanupMs` (10min default)
- Enforces `maxSessions` limit (50 default) — removes oldest idle first
- Timer-based, not event-driven (runs every 30s)

#### Architecture

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
```

#### Config

```json
["opencode-auto-continue", {
  "sessionMonitorEnabled": true,
  "orphanWaitMs": 15000,
  "sessionDiscoveryIntervalMs": 60000,
  "idleCleanupMs": 600000,
  "maxSessions": 50
}]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionMonitorEnabled` | boolean | `true` | Enable session monitoring layer |
| `orphanWaitMs` | number | `15000` | Wait after subagent finish before treating parent as orphan |
| `sessionDiscoveryIntervalMs` | number | `60000` | How often to poll `session.list()` for missed sessions |
| `idleCleanupMs` | number | `600000` | Remove idle sessions after this time (10min) |
| `maxSessions` | number | `50` | Max sessions to keep in memory |

### Session Monitor

A passive monitoring layer that watches for session lifecycle issues the event system might miss.

```
[All sessions tracked in sessions Map]
         │
         ├── 5s timer ──► checkOrphanParents()
         │                    │
         │                    └── busyCount >1 → 1? ──► Wait 15s ──► recover parent
         │
         ├── 60s timer ──► discoverSessions()
         │                    │
         │                    └── session.list() shows unknown busy session? ──► create minimal state
         │
         └── 30s timer ──► cleanupIdleSessions()
                              │
                              └── idle > 10min OR count > 50? ──► remove oldest idle

[Integration]
• touchSession() called on: session.created, session.status(busy/retry), message.part.updated(real progress)
• Orphan detection calls recovery.ts when parent stuck
• State shares the same sessions Map with all other modules
```

**Why timers instead of events?** Orphan detection requires watching busyCount _over time_ — a single event can't detect "was >1 now =1". Session discovery catches sessions the event system missed (plugin loaded mid-session, events dropped). Idle cleanup prevents memory leaks in long-running instances.

The plugin handles **4-layer compaction**: opportunistic at 40k, proactive at 60k, hard at 80k, and emergency on token limit errors, providing comprehensive context management without requiring external plugins.

## Installation

### npm

```bash
npm install @dracondev/opencode-auto-continue
```

### GitHub

```bash
npm install github:DraconDev/opencode-auto-continue
```

### Local Development

For developing or testing the plugin locally:

```bash
git clone https://github.com/DraconDev/opencode-auto-continue
cd opencode-auto-continue
npm install
npm run build

# Create plugin directory if it doesn't exist
mkdir -p ~/.config/opencode/plugins/opencode-auto-continue

# Copy all compiled files (not just index.js!)
cp -r dist/* ~/.config/opencode/plugins/opencode-auto-continue/

# Create package.json so OpenCode can resolve the plugin
cat > ~/.config/opencode/plugins/opencode-auto-continue/package.json << 'EOF'
{
  "name": "opencode-auto-continue",
  "version": "7.8.344",
  "main": "./index.js",
  "types": "./index.d.ts"
}
EOF
```

**Then register it in your OpenCode config** (see [Plugin Registration](#plugin-registration) below).

## Plugin Registration

Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "@mohak34/opencode-notifier@latest",
    ["opencode-auto-continue", {
      "stallTimeoutMs": 45000,
      "maxRecoveries": 3,
      "sessionMonitorEnabled": true,
      "nudgeEnabled": true,
      "autoCompact": true,
      "debug": false
    }]
  ]
}
```

**Important**: The plugin name `opencode-auto-continue` must match the directory name in `~/.config/opencode/plugins/`.

### Local vs npm Installation

**Local (development)**:
- Plugin files in `~/.config/opencode/plugins/opencode-auto-continue/`
- Reference in config: `["opencode-auto-continue", { ... }]` (no version, no scope)
- Requires `package.json` in plugin directory

**npm (production)**:
```bash
npm install -g opencode-auto-continue
# or
opencode plugin opencode-auto-continue@latest --global
```
- Reference in config: `["opencode-auto-continue", { ... }]` or `"opencode-auto-continue"`

## Configuration

### Quick Start

Minimal configuration with sensible defaults:

```json
["opencode-auto-continue", {
  "stallTimeoutMs": 45000,
  "maxRecoveries": 3,
  "debug": false
}]
```

### Full Configuration Reference

```json
{
  "plugin": [
    ["file:///home/dracon/Dev/opencode-auto-continue/dist/index.js", {
      "stallTimeoutMs": 45000,
      "maxRecoveries": 3,
      "waitAfterAbortMs": 5000,
      "cooldownMs": 60000,
      "nudgeEnabled": true,
      "nudgeIdleDelayMs": 0,
      "nudgeMaxSubmits": 10,
      "nudgeCooldownMs": 30000,
      "autoCompact": true,
      "autoAnswerQuestions": false,
      "maxSessionAgeMs": 7200000,
      "proactiveCompactAtTokens": 80000,
      "opportunisticCompactAtTokens": 60000,
      "hardCompactAtTokens": 100000,
      "compactMaxRetries": 3,
      "compactReductionFactor": 0.7,
      "compactionVerifyWaitMs": 30000,
      "compactRetryDelayMs": 3000,
      "shortContinueMessage": "Continue. Create todos for any untracked work before starting it.",
      "tokenLimitPatterns": ["context length", "maximum context length", "token count exceeds", "too many tokens", "payload too large", "token limit exceeded"],
      "terminalTitleEnabled": true,
      "statusFileEnabled": true,
      "statusFilePath": "",
      "maxStatusHistory": 10,
      "statusFileRotate": 5,
      "recoveryHistogramEnabled": true,
      "stallPatternDetection": true,
      "terminalProgressEnabled": true,
      "sessionMonitorEnabled": true,
      "debug": false
    }]
  ]
}
```

### Recovery Options

| Option | Default | Description |
|--------|---------|-------------|
| `stallTimeoutMs` | `180000` | Time without activity before recovery (3 min) |
| `waitAfterAbortMs` | `5000` | Pause between abort and continue (5s) |
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
| `nudgeIdleDelayMs` | `0` | Delay after session.idle before sending nudge |
| `nudgeMessage` | `"..."` | Nudge message telling agent to continue |
| `nudgeCooldownMs` | `30000` | Min time between nudges (30s) |
| `nudgeMaxSubmits` | `10` | Max nudges before loop protection pauses |

### Compaction Options

| Option | Default | Description |
|--------|---------|-------------|
| `autoCompact` | `true` | Enable proactive and opportunistic compaction |
| `proactiveCompactAtTokens` | `80000` | Token threshold for proactive compaction |
| `opportunisticCompactAtTokens` | `60000` | Token threshold for opportunistic compaction |
| `hardCompactAtTokens` | `100000` | Token threshold for mandatory blocking compaction |
| `hardCompactMaxWaitMs` | `30000` | Max wait for hard compaction before proceeding anyway |
| `hardCompactBypassCooldown` | `true` | Hard compaction ignores cooldown |
| `compactRetryDelayMs` | `3000` | Delay between compaction retries |
| `compactMaxRetries` | `3` | Max compaction retry attempts |
| `compactionVerifyWaitMs` | `30000` | Max wait for compaction verification |
| `compactReductionFactor` | `0.7` | Fraction of tokens removed (70%) |
| `compactionSafetyTimeoutMs` | `15000` | Safety timeout to clear stuck compacting flag |
| `compactionGracePeriodMs` | `10000` | Grace period after compaction — all layers skip while DB updates |
| `compactionFailBackoffMs` | `60000` | After compaction fails, all layers skip for this period to prevent spam |

### Context Window

The plugin handles **4-layer compaction**: opportunistic at 60k, proactive at 80k, hard at 100k, and emergency on token limit errors.

If you frequently hit token limits with large pastes (HTML, JSON, etc.), consider lowering your model's context window.

### Terminal Options

| Option | Default | Description |
|--------|---------|-------------|
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

### Question Auto-Answer Options

| Option | Default | Description |
|--------|---------|-------------|
| `autoAnswerQuestions` | `false` | Auto-answer AI multiple-choice questions with first (recommended) option |

When enabled, the plugin intercepts `question.asked` events and replies with the first option automatically. This prevents sessions from stalling when the AI asks follow-up questions. Uses OpenCode SDK internal `_client` property — no public API available in v1.

### Test-Driven Quality Gate

| Option | Default | Description |
|--------|---------|-------------|
| `testOnIdle` | `true` | Auto-run `testCommands` when session goes idle; inject failures into nudge |
| `testCommands` | `["cargo test"]` | Shell commands to run for test verification (sequentially) |
| `testCommandTimeoutMs` | `300000` | Per-command timeout in ms (5 minutes) |

When enabled, the plugin runs tests automatically before each nudge. If tests fail, the nudge message becomes `"Tests are failing. Fix these before continuing..."`. At review time, test output is injected via `{testOutput}` template variable. Continue/nudge messages include TDD instructions.

### Other Options

| Option | Default | Description |
|--------|---------|-------------|
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
  "version": "6.61.0",
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
| `history` | Rolling buffer of recent status snapshots |

### Rotated Status Files

When `statusFileRotate > 0`, old status files are kept:
- `~/.opencode/logs/auto-force-resume.status.1` (most recent archive)
- `~/.opencode/logs/auto-force-resume.status.2`
- etc.

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
estimatedTokens = estimatedTokens * (1 - compactReductionFactor)
```
With default factor 0.7: `estimatedTokens = estimatedTokens * 0.3` (30% remain)

This matches the actual reduction — compaction removes ~70% of context, so the remaining tokens should be ~30% of pre-compaction count.

### Why Four Layers?

- **Opportunistic** (60k): Gentle cleanup during idle moments
- **Proactive** (80k): Pre-emptive before limits hit
- **Hard** (100k): Mandatory gate — blocks operations until compacted
- **Emergency**: Safety net for edge cases that slip through

### Double Compact Prevention (v7.8.1904+)

After `session.compacted` fires, the SQLite DB still holds pre-compaction token counts (they accumulate over the session's lifetime — `tokens_input` is a lifetime total, not current context). Without intervention, `getTokenCount()` would return values like 29M tokens from the DB instead of the actual ~70k context size.

**Two-part fix**:

1. **Grace period guard** (`compactionGracePeriodMs`, default 10s): All 3 compaction layers skip if `lastCompactionAt` is within this window, even if `hardCompactBypassCooldown: true`. Prevents triggering while DB values are stale.

2. **`realTokensBaseline` tracking on `session.compacted`**: Sets `realTokensBaseline = realTokens` (the lifetime token total at compaction time). After this, `getTokenCount()` ignores the cumulative DB `realTokens` and returns `estimatedTokens` instead — which has already been reduced by `compactReductionFactor`. This prevents the massive token count discrepancy (29M DB vs 70k actual) from triggering false compaction.

The `refreshRealTokens()` throttle:
- `realTokens > 0 && now - lastRealTokenRefreshAt < 10s` → return cached
- `realTokensBaseline > 0` → return `estimatedTokens` (not the cumulative DB value)
- After baseline is set: DB values are ignored until a new compaction resets the baseline

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
- English text: ~0.75 tokens/char
- Code: ~1.0 tokens/char
- Digits/numbers: ~0.5 tokens/char

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
| `session.error` (token limit) | Trigger emergency compaction |
| `session.error` (other) | Clear timer, monitoring pauses |
| `todo.updated` | Check completion, trigger review/nudge |
| `session.idle` | Trigger nudge for pending todos |
| `session.deleted` | Clear all session state |

## How to Customize

### Disable All Auto-Recovery

```json
["opencode-auto-continue", {
  "maxRecoveries": 0,
  "stallTimeoutMs": 999999999
}]
```

### Aggressive Recovery (For Testing)

```json
["opencode-auto-continue", {
  "stallTimeoutMs": 10000,
  "cooldownMs": 5000,
  "maxRecoveries": 10,
  "waitAfterAbortMs": 500
}]
```

### Long-Running Sessions (Large Context Models)

```json
["opencode-auto-continue", {
  "stallTimeoutMs": 600000,
  "maxSessionAgeMs": 14400000
}]
```

### Custom Messages

```json
["opencode-auto-continue", {
  "continueMessage": "Hey! You stopped. Keep going!",
  "continueWithTodosMessage": "Hey! You have {pending} tasks left: {todoList}. Keep going!",
  "nudgeMessage": "Don't forget about your {pending} open tasks!",
  "reviewMessage": "Great job! Please summarize what we accomplished."
}]
```

### Custom Prompts (Programmatic)

For programmatic control, use the `sendCustomPrompt` API:

```typescript
import { sendCustomPrompt } from "opencode-auto-continue";

// Inject a custom prompt with full context
await sendCustomPrompt(sessionId, {
  message: "⚡ Priority task: {contextSummary}",
  includeTodoContext: true,
  includeContextSummary: true,
  customPrompt: "Focus on the authentication bug first"
});
```

Available in both recovery and nudge flows. See [Custom Prompts](#custom-prompts-per-session-dynamic-messages) section above for full API reference.

### Disable Specific Features

```json
["opencode-auto-continue", {
  "nudgeEnabled": false,
  "reviewOnComplete": false,
  "autoCompact": false,
  "terminalTitleEnabled": false,
  "statusFileEnabled": false,
  "terminalProgressEnabled": false
}]
```

**Note**: Toast notifications are handled by separate plugins like `@mohak34/opencode-notifier`. This plugin focuses purely on session continuity.

### Enable Debug Mode

```json
["opencode-auto-continue", {
  "debug": true
}]
```

Check logs:
```bash
tail -f ~/.opencode/logs/auto-force-resume.log
```

### Custom Status File Location

```json
["opencode-auto-continue", {
  "statusFilePath": "/tmp/my-opencode-status.json",
  "statusFileRotate": 3
}]
```

### Token Limit Handling

```json
["opencode-auto-continue", {
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
["opencode-auto-continue", {
  "recoveryHistogramEnabled": true
}]
```

Tracks recovery times to show you average/min/max/median recovery duration.

### Stall Pattern Detection

```json
["opencode-auto-continue", {
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
- ❌ Toast notifications (install `@mohak34/opencode-notifier` separately)

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
["opencode-auto-continue", {
  "terminalTitleEnabled": true
}]
```

**Note**: For toast notifications, install a separate notification plugin:
```bash
opencode plugin @mohak34/opencode-notifier@latest --global
```

## Troubleshooting

### Plugin Not Loading / "Cannot find module"

**Cause**: Missing `package.json` in plugin directory or incorrect path
**Fix**:
1. Ensure plugin files are in `~/.config/opencode/plugins/opencode-auto-continue/`
2. Create `package.json` in that directory:
   ```json
   {
     "name": "opencode-auto-continue",
     "version": "7.8.235",
     "main": "./index.js"
   }
   ```
3. Ensure `opencode.json` uses correct name: `["opencode-auto-continue", { ... }]`
4. Restart OpenCode after making changes

### Plugin Not Registered in Config

**Cause**: Plugin not added to `plugin` array in `opencode.json`
**Fix**: Add to `~/.config/opencode/opencode.json`:
```json
{
  "plugin": [
    ["opencode-auto-continue", {
      "stallTimeoutMs": 45000,
      "maxRecoveries": 3
    }]
  ]
}
```

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

## Roadmap

### Recently Completed ✅

| Feature | Status | Version |
|---------|--------|---------|
| **Session Monitor** | ✅ Complete | v7.2.0 |
| - Orphan parent detection | Detects stuck parents after subagent completion |
| - Session discovery | Periodic polling catches missed sessions |
| - Idle cleanup | Automatic memory management |
| **Custom Prompts API** | ✅ Complete | v6.62 |
| **AI Advisory** | ✅ Complete | v6.5 |
| **Tool-Text Recovery** | ✅ Complete | v6.54 |
| **Hallucination Loop Detection** | ✅ Complete | v6.54 |
| **Cross-Instance Prompt Guard** | ✅ Complete | v6.54 |
| **Busy-But-Dead Detection** | ✅ Complete | v7.8.254 |

### In Progress 🚧

| Feature | Priority | Target |
|---------|----------|--------|
| **Config Presets** | Medium | v7.3 |
| Pre-defined profiles: `default`, `aggressive`, `gentle`, `subagent` |
| **Subagent Stuck Detection** | Medium | v7.4 |
| Per-subagent timeout monitoring with tool-call awareness |

### Planned 📋

| Feature | Priority | Description |
|---------|----------|-------------|
| **Plan-Driven Continue Messages** | High | Read PLAN.md and send contextual "next item is X" continue messages when todos run out. Code exists (`buildPlanContinueMessage`) but not wired into recovery flow. |
| **Test-Fix Loop** | High | ✅ **Implemented in v7.8.306** — reviewFired resets when new pending todos appear after review, enabling automatic test-run → fix → re-test cycles. |
| **v7.0 Autonomy Module** | High | Self-improving recovery with intent extraction and strategy selection |
| **Learning Database** | High | SQLite-based effectiveness tracking for recovery strategies |
| **Predictive Engine** | Medium | Predict stalls before they happen using token trends |
| **Health Endpoint** | Medium | JSON endpoint for external monitoring integrations |
| **Telemetry (opt-in)** | Low | Anonymous recovery success rates and stall pattern stats |
| **Multi-Session Orchestration** | Low | Coordinate recovery across concurrent sessions |

### v7.0 Vision 🎯

The v7.0 release transforms the plugin from reactive recovery to **proactive session intelligence**:

1. **Intent Extraction** — Understand what the user is trying to accomplish
2. **Task Graphs** — Build structured understanding from todos
3. **Strategy Pool** — Select optimal recovery strategy based on context
4. **Self-Improving** — Learn which strategies work best per pattern
5. **Meta-Cognition** — Track own effectiveness and adapt behavior

See `docs/VISION-v7.0.md` for full architecture details.

---

## Performance

- **Memory**: One SessionState per active session (~150 bytes each)
- **Timers**: Max 1 timer per session (stall recovery)
- **Polling**: Status polling only during recovery (not continuous)
- **File I/O**: Status file uses atomic writes (`.tmp` + rename)
- **CPU**: Event-driven, no background loops
- **Dependencies**: Zero external dependencies at runtime

## License

MIT