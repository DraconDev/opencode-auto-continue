# opencode-auto-continue

The ultimate OpenCode plugin for session management. **One plugin replaces three**: auto-recovery, todo-reminders, and review-on-completion — all with zero conflicts.

## What It Does

| Feature | Replaces | What It Does |
|---------|----------|--------------|
| **Stall Recovery** | Manual intervention | Detects stuck sessions, aborts them, sends continue |
| **Todo Context** | `opencode-todo-reminder` | Fetches open todos, includes them in recovery messages |
| **Review on Completion** | `opencode-auto-review-completed-todos` | Sends review prompt when all todos are done |
| **Nudger** | Nothing — unique feature | Gentle reminders for idle sessions with open todos |
| **Emergency Compaction** | Nothing — unique feature | Compacts on token limit errors (belt-and-suspenders) |
| **Plan-Aware Continue** | Nothing — unique feature | Uses `continueWithPlanMessage` when planning phase detected |
| **Question Detection** | Nothing — unique feature | Prevents nudging when AI is asking user a question |
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
- 🔄 **Proactive context pruning** → [`@tarquinen/opencode-dcp`](https://github.com/tarquinen/opencode-dcp)
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
├── compaction.ts     Emergency compaction (token limit errors only)
├── review.ts         Review + continue prompt delivery
├── ai-advisor.ts     AI-driven session analysis + heuristic patterns
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
createAIAdvisor({ config, sessions, log })
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
createTerminalModule({ config, sessions, log, input })  // Terminal title/progress/hook
```

Each module is initialized early and its API is called from event handlers in `index.ts`.

### Question Detection (Stops Nudges When AI Asks You Something)

The plugin detects when the AI is asking _you_ a question and **skips nudging** during that time. This prevents the plugin from interrupting when the AI genuinely needs user input.

```
[Session idle with pending todos]
        │
        ▼
Fetch last 5 assistant messages
        │
        ▼
Check: does last message end with "?"
        │   OR contain phrases like:
        │   "would you like", "should i", "do you want",
        │   "can you", "could you", "what do you think",
        │   "how would you", "is there anything", "shall i"
        │
        ├──YES (it's a question) ──► Skip nudge — AI is waiting for you
        │
        └──NO ──► Proceed with normal nudge flow
```

**Why this matters**: Without question detection, the plugin would send "Please continue working on your tasks..." right after the AI asked you "Should I refactor this or leave it as-is?" — which is annoying and counterproductive.

**Trade-off**: Adds ~50-200ms latency per nudge check (fetches last 5 messages).

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
- **Auto-mark complete**: When `planDrivenContinue: true`, completing todos automatically marks matching plan items as complete (via fuzzy string matching)

**What the code has but doesn't wire up yet**:
- Plan file parsing (`PLAN.md`, `ROADMAP.md`, `.opencode/plan.md`)
- `buildPlanContinueMessage()` — builds contextual "next item is X" messages
- These are tested but not yet integrated into the recovery flow

See [Roadmap](#roadmap) for planned improvements.

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

### AI Advisory System

The plugin includes an optional advisory layer that analyzes session state before making decisions. **AI advises, hardcoded rules decide** — simple/obvious decisions stay fast, edge cases get analysis.

```
[Session event triggers recovery/nudge]
        │
        ▼
Check: enableAdvisory && shouldUseAI()?
        │
        ├──YES──► AI advisor analyzes session context
        │            │
        │            ├── AI available? ──► Call real AI (OpenAI-compatible)
        │            │                        │
        │            │                        └── Analyze prompt response
        │            │
        │            └── AI unavailable? ──► Run heuristic pattern analysis
        │                                      │
        │                                      ├── New session (<30s) ──► wait
        │                                      ├── Repeated same-type stall ──► abort
        │                                      ├── Mixed patterns ──► wait
        │                                      ├── Long planning (>60s) ──► abort
        │                                      ├── High tokens + todos ──► continue
        │                                      ├── High tokens, no todos ──► compact
        │                                      └── Stalled with pending todos ──► continue
        │
        └──NO──► Use hardcoded rules (fast path)
```

**7 Heuristic Patterns** (no AI call needed):

| Pattern | Condition | Advice |
|---------|-----------|--------|
| New session | Elapsed time < 30s | `wait` — give it time |
| Repeated stall | Same part type as last stall | `abort` — stuck in loop |
| Mixed patterns | Different part types before stall | `wait` — making progress |
| Long planning | Planning > 60s | `abort` — stuck planning |
| High tokens + todos | Tokens > 80% of limit + pending todos | `continue` — push forward |
| High tokens, no todos | Tokens > 80% of limit, all done | `compact` — wrap up cleanup |
| Stalled with todos | Session stalled + open todos | `continue` — keep working |

**AI Call** (when configured):
1. Extract context: last 3 messages, stall time, todos, token estimate, recovery attempts
2. Send to configured AI model via OpenAI-compatible API
3. Parse response for `@{action}:confidence` format
4. Fall back to heuristics if AI fails or times out

**Integration points:**
- **Recovery**: Before final abort attempt, advisor analyzes stall pattern. May suggest wait instead of abort.
- **Nudge**: After question detection check, advisor analyzes if nudging is appropriate. Skips nudge if advice is `wait` (≥0.7 confidence) or `abort` (≥0.6 confidence).

For **significantly better context management**, install DCP alongside this plugin:

```bash
opencode plugin @tarquinen/opencode-dcp@latest --global
```

**Why?** DCP handles context optimization far better than our emergency-only approach:

| Feature | Our Plugin Only | With DCP |
|---------|----------------|----------|
| Proactive pruning | ❌ None (emergency only) | ✅ `compress` tool called by model |
| Message dedup | ❌ None | ✅ Removes repeated tool calls |
| Error purge | ❌ None | ✅ Prunes errored tool inputs |
| Soft thresholds | ❌ None | ✅ 50k-100k range with nudges |
| Context preservation | ❌ None | ✅ Protected tools, user messages, file patterns |
| Emergency compaction | ✅ Token limit errors | ✅ Plus DCP's proactive pruning |

**When DCP is detected**, our plugin automatically:
- Disables proactive compaction (DCP handles it)
- Keeps emergency compaction on token limit errors (belt-and-suspenders)
- Injects session state (todos, planning status) into compaction hooks

**Architecture**: We focus on session continuity (stall recovery, nudging, review). DCP focuses on context optimization. Together they cover both concerns without overlap.

## Installation

### npm

```bash
npm install opencode-auto-continue
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
  "version": "7.8.235",
  "main": "./index.js",
  "types": "./index.d.ts"
}
EOF
```

**Then register it in your OpenCode config** (see [Plugin Registration](#plugin-registration) below).

## Plan-Aware Features

The plugin has partial plan support. What's implemented vs planned:

### ✅ Implemented: Auto-Mark Complete

When `planDrivenContinue: true` and `planAutoMarkComplete: true`, completing a todo automatically marks the matching plan item as complete in your plan file.

**How it works**:
- Watches `todo.updated` events
- When a todo is marked completed, searches the plan file for a matching description (fuzzy string match)
- Updates `- [ ]` to `- [x]` in the plan file

**Supported plan files** (checked in order):
1. `PLAN.md`
2. `ROADMAP.md`
3. `.opencode/plan.md`

**Plan format**:
```markdown
# Project Plan

## Phase 1: Foundation
- [ ] Setup project structure
- [x] Add configuration
- [ ] Write tests
```

### Configuration

```json
{
  "plugin": [
    ["opencode-auto-continue", {
      "planDrivenContinue": true,
      "planFilePath": null,
      "planAutoMarkComplete": true
    }]
  ]
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `planDrivenContinue` | boolean | `false` | Enable plan features (currently auto-mark only) |
| `planFilePath` | string | `null` | Custom plan file path. If null, searches standard locations. |
| `planAutoMarkComplete` | boolean | `true` | Auto-mark plan items when corresponding todos finish |

### 🚧 Planned: Plan-Driven Continue Messages

The codebase includes plan parsing and message building utilities, but they're not yet wired into the recovery flow. See [Roadmap](#roadmap).

## Plugin Registration

Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "@mohak34/opencode-notifier@latest",
    "@tarquinen/opencode-dcp@latest",
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
    ["opencode-auto-continue", {
      "stallTimeoutMs": 180000,
      "waitAfterAbortMs": 5000,
      "maxRecoveries": 3,
      "cooldownMs": 60000,
      "nudgeEnabled": true,
      "nudgeIdleDelayMs": 500,
      "nudgeMaxSubmits": 3,
      "nudgeMessage": "The session has {pending} open task(s) that still need to be completed: {todoList}. Please continue working on these tasks.",
      "nudgeCooldownMs": 60000,
      "autoCompact": true,
      "maxSessionAgeMs": 7200000,
      "compactMaxRetries": 3,
      "compactReductionFactor": 0.7,
      "shortContinueMessage": "Continue.",
      "tokenLimitPatterns": ["context length", "maximum context length", "token count exceeds"],
      "terminalTitleEnabled": true,
      "statusFileEnabled": true,
      "statusFilePath": "",
      "maxStatusHistory": 10,
      "statusFileRotate": 5,
      "recoveryHistogramEnabled": true,
      "stallPatternDetection": true,
      "terminalProgressEnabled": true,
      "planDrivenContinue": false,
      "planFilePath": null,
      "planAutoMarkComplete": true,
      "enableAdvisory": false,
      "advisoryModel": "",
      "advisoryTimeoutMs": 5000,
      "advisoryMaxTokens": 500,
      "advisoryTemperature": 0.1,
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
| `nudgeIdleDelayMs` | `500` | Delay after session.idle before sending nudge |
| `nudgeMessage` | `"The session has {pending}..."` | Nudge message telling agent to continue |
| `nudgeCooldownMs` | `60000` | Min time between nudges (1 min) |
| `nudgeMaxSubmits` | `3` | Max nudges before loop protection pauses |

### Compaction Options

| Option | Default | Description |
|--------|---------|-------------|
| `autoCompact` | `true` | Enable emergency compaction on token limit errors |
| `compactRetryDelayMs` | `3000` | Delay between compaction retries |
| `compactMaxRetries` | `3` | Max compaction retry attempts |
| `compactionVerifyWaitMs` | `10000` | Max wait for compaction verification |
| `compactReductionFactor` | `0.7` | Fraction of tokens removed (70%) |

### Context Window

For proactive context pruning, install DCP (see below). Our plugin only handles **emergency compaction** when token limits are hit.

If you frequently hit token limits with large pastes (HTML, JSON, etc.), consider lowering your model's context window or using DCP for smart pruning.

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

### AI Advisory Options

| Option | Default | Description |
|--------|---------|-------------|
| `enableAdvisory` | `false` | Enable AI/heuristic session analysis |
| `advisoryModel` | `""` | AI model for advisory calls (e.g. `"gemma-4-31b-it"`) |
| `advisoryTimeoutMs` | `5000` | Max wait for AI advisory response |
| `advisoryMaxTokens` | `500` | Max tokens in AI advisory response |
| `advisoryTemperature` | `0.1` | Temperature for AI advisory calls (low = deterministic) |

**AI provider**: Reads `baseURL` and `apiKey` from your model config in `opencode.json`. Uses OpenAI-compatible chat completions endpoint.

**When AI is not configured** (`enableAdvisory: false` or `advisoryModel: ""`), the advisor still runs heuristic pattern analysis. Setting `enableAdvisory: true` with a valid `advisoryModel` enables real AI calls as the primary advisor, with heuristics as fallback.

### Plan Options

| Option | Default | Description |
|--------|---------|-------------|
| `planDrivenContinue` | `false` | Enable plan-driven auto-continue |
| `planFilePath` | `null` | Custom plan file path (relative or absolute). If null, searches standard locations |
| `planAutoMarkComplete` | `true` | Auto-mark plan items as complete when corresponding todos finish |

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

The plugin only handles **emergency compaction** when token limits are hit. For proactive context pruning, install DCP (see below).

### Emergency Compaction (Token Limit Errors)

When a token limit error is detected:
1. Parse exact token counts from error message
2. Call `session.summarize()` with progressive verification
3. Wait 2s → check if session idled
4. Wait 3s → check again
5. Wait 5s → check again
6. If still busy → proceed with abort+continue

**Post-compaction token reset**:
After compaction completes, estimated tokens are recalculated using `compactReductionFactor`:
```
estimatedTokens = estimatedTokens * (1 - compactReductionFactor)
```
With default factor 0.7: `estimatedTokens = estimatedTokens * 0.3` (30% remain)

This matches the actual reduction — compaction removes ~70% of context, so the remaining tokens should be ~30% of pre-compaction count.

### Why Only Emergency?

Proactive compaction is delegated to DCP, which does it better:
- Soft thresholds (50k-100k range) instead of hard limits
- Message deduplication
- Error pruning
- Smart context preservation

Our emergency compaction is a safety net for when DCP misses something or isn't installed.

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

**For proactive context pruning with large models, install DCP:**
```bash
opencode plugin @tarquinen/opencode-dcp@latest --global
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
| **Question Detection** | ✅ Complete | v6.54 |

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
| **Test-Fix Loop** | High | Reset `reviewFired` when new fix todos are created after review, enabling automatic test-run → fix → re-test cycles. Currently review is one-shot per session. |
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