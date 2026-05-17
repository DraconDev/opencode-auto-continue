# Configuration

> Complete configuration guide for opencode-auto-continue.
> See [README.md](../README.md) for installation and quick start.

## Configuration

### Quick Start

Minimal configuration with sensible defaults:

```json
["opencode-auto-continue", {
  "stallTimeoutMs": 180000,
  "maxRecoveries": 3,
  "sessionMonitorEnabled": true,
  "nudgeEnabled": true,
  "autoCompact": true,
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
| `busyStallTimeoutMs` | `180000` | Time without real output when session reports busy (3 min) |
| `textOnlyStallTimeoutMs` | `180000` | Time with only text/reasoning output before stall (3 min) |
| `toolLoopMaxRepeats` | `5` | Max consecutive same-tool calls before tool loop detection |
| `toolLoopWindowMs` | `120000` | Window for tool loop detection (2 min) |
| `planningTimeoutMs` | `300000` | Max time in planning state before forced recovery (5 min) |
| `tokenEstimateMultiplier` | `1.0` | Multiplier for text-based token estimation |
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

### Review Options

| Option | Default | Description |
|--------|---------|-------------|
| `reviewOnComplete` | `true` | Send review when all todos done |
| `reviewMessage` | `"..."` | Review prompt text (TDD-focused, includes {testOutput} template) |
| `reviewWithoutTestsMessage` | `"..."` | Review prompt without test output |
| `reviewDebounceMs` | `500` | Debounce before triggering review |
| `reviewCooldownMs` | `60000` | Min time between reviews |

### Message Templates

| Option | Default | Description |
|--------|---------|-------------|
| `shortContinueMessage` | `"Continue..."` | Short continue prompt |
| `continueWithPlanMessage` | `"Finish your plan..."` | Continue when plan detected |
| `continueMessage` | `"Continue from where you left off..."` | Default continue (TDD + TodoWrite) |
| `continueWithTodosMessage` | `"You have {pending}..."` | Continue with todo context (TDD + TodoWrite) |
| `maxAttemptsMessage` | `"..."` | Shown after max recovery attempts |

### Nudge Options

| Option | Default | Description |
|--------|---------|-------------|
| `nudgeEnabled` | `true` | Send continue prompts for incomplete todos |
| `nudgeIdleDelayMs` | `0` | Delay after session.idle before sending nudge |
| `nudgeMessage` | `"You have {pending}..."` | Nudge message (TDD + TodoWrite) |
| `nudgeCooldownMs` | `30000` | Min time between nudges (30s) |
| `nudgeMaxSubmits` | `10` | Max nudges before loop protection pauses |
| `includeTodoContext` | `true` | Include pending todos in nudge message |
| `todoPollIntervalMs` | `30000` | Periodic todo API poll interval (0=disable) |

### Compaction Options

| Option | Default | Description |
|--------|---------|-------------|
| `autoCompact` | `true` | Enable proactive and opportunistic compaction |
| `compactCooldownMs` | `60000` | Min time between soft compactions |
| `proactiveCompactAtTokens` | `80000` | Token threshold for proactive compaction |
| `opportunisticCompactAtTokens` | `60000` | Token threshold for opportunistic compaction |
| `hardCompactAtTokens` | `100000` | Token threshold for mandatory blocking compaction |
| `hardCompactMaxWaitMs` | `30000` | Max wait for hard compaction before proceeding anyway |
| `hardCompactBypassCooldown` | `true` | Hard compaction ignores cooldown |
| `compactRetryDelayMs` | `3000` | Delay between compaction retries |
| `compactMaxRetries` | `3` | Max compaction retry attempts |
| `compactionVerifyWaitMs` | `30000` | Max wait for compaction verification |
| `compactReductionFactor` | `0.7` | Fraction of tokens remaining after compaction (0.7 = 70% remain, 30% removed) |
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
| `showToasts` | `true` | Show toast notifications |

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
| `testCommandGates` | `{}` | Gate files for test commands (e.g., `{"cargo": "Cargo.toml"}`) — prevents running tests in non-project directories |

When enabled, the plugin runs tests automatically before each nudge. If tests fail, the nudge message becomes `"Tests are failing. Fix these before continuing..."`. At review time, test output is injected via `{testOutput}` template variable. Continue/nudge messages include TDD instructions.

### Stop Conditions

| Option | Default | Description |
|--------|---------|-------------|
| `stopFilePath` | `""` | Path to a stop file — plugin pauses when file exists |
| `maxRuntimeMs` | `0` | Max session runtime in ms (0=disabled) |
| `untilMarker` | `""` | Stop when this marker text appears in output |

### Other Options

| Option | Default | Description |
|--------|---------|-------------|
| `debug` | `false` | Enable debug logging to file |

### Dangerous Command Blocking

| Option | Default | Description |
|--------|---------|-------------|
| `dangerousCommandBlocking` | `true` | Abort session if AI tries blocked commands (sudo, rm -rf /~, chmod 777, etc.) |
| `dangerousCommandInjection` | `true` | Inject dangerous commands policy into system prompt (visible every turn, no wasted AI turn) |


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
