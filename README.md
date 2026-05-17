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
| **Session Monitor** | Nothing — unique feature | Detects orphan parents after subagent completion |
| **Terminal Timer** | Nothing — unique feature | Shows elapsed time in terminal title bar |
| **Session Status File** | Nothing — unique feature | Real-time JSON status for external monitoring |
| **Stall Pattern Detection** | Nothing — unique feature | Tracks which part types cause the most stalls |
| **Terminal Progress Bar** | Nothing — unique feature | OSC 9;4 progress in terminal tabs (iTerm2, WezTerm, etc.) |

**Delegated to other plugins:**
- 🔄 **Toast notifications** → [`@mohak34/opencode-notifier`](https://github.com/mohak34/opencode-notifier) or similar |

> 📊 **Want to understand the internals?** See the [Flow Chart](docs/FLOW-CHART.md) for a detailed breakdown of every state transition, guard check, and decision point.


## Quick Start

```bash
npm install @dracondev/opencode-auto-continue
```

### Plugin Registration

Add to your OpenCode `config.json`:

```json
{
  "plugins": ["@dracondev/opencode-auto-continue"]
}
```

Or with options:

```json
{
  "plugins": [
    ["@dracondev/opencode-auto-continue", {
      "preset": "balanced"
    }]
  ]
}
```

See [docs/configuration.md](docs/configuration.md) for all 50+ options.

## Features

| Feature | Description |
|---------|-------------|
| **Stall Recovery** | Detects stuck sessions, aborts them, sends continue |
| **4-Layer Compaction** | Opportunistic/Proactive/Hard/Emergency token reduction |
| **Todo Context** | Fetches open todos, includes them in recovery messages |
| **Review on Completion** | Sends review prompt when all todos are done |
| **Nudger** | Gentle reminders for idle sessions with open todos |
| **Question Auto-Answer** | Auto-replies to AI multi-choice questions |
| **Plan-Aware Continue** | Detects planning phase, uses appropriate recovery message |
| **Tool-Text Recovery** | Detects XML tool calls in reasoning |
| **Hallucination Loop Detection** | Breaks infinite loops with abort+resume |
| **Prompt Guard** | Prevents duplicate injections across plugin instances |
| **Custom Prompts** | Per-session custom prompts with template variables |
| **Session Monitor** | Detects orphan parents after subagent completion |
| **Terminal Timer** | Shows elapsed time in terminal title bar |
| **Status File** | Real-time JSON status for external monitoring |

## Documentation

- **[docs/architecture.md](docs/architecture.md)** — How the plugin works internally, compaction algorithm, event handling, terminal integration
- **[docs/configuration.md](docs/configuration.md)** — Complete configuration reference, template variables, customization guide
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — Common issues, migration guide, status file format
- **[docs/FLOW-CHART.md](docs/FLOW-CHART.md)** — Visual flow chart of all state transitions

## Changelog

### v7.19+ — Reliability Fixes

**Bug: reviewFired stuck true after multi-cycle workflows** (Bug A)
When todos went from "pending with cooldown active" directly to "all completed", the `reviewFired` flag remained set permanently, preventing the review prompt from ever firing again. Fix: `processTodos()` now detects this stale state and resets `reviewFired = false` after cooldown expires, ensuring reviews fire reliably in multi-cycle scenarios.

**Bug: continue lost when session.idle fires during active recovery** (Bug B)
When `session.idle` or `session.status(idle)` fired while recovery was in progress (`aborting=true` and `needsContinue=true`), the handler skipped calling `sendContinue()` and relied on recovery to send it. If recovery's call failed (e.g., blocked by prompt guard or concurrency guard), the continue was lost permanently — no future event would trigger it. Fix: both `handleSessionIdle` and `handleSessionStatus` now schedule a 3-second delayed fallback that fires `sendContinue()` with a `continueInProgress` guard, ensuring the continue is sent even if the primary path failed.

**Bug: periodic poll skipped on fresh todo.updated but no nudge/review triggered** (Bug C)
When a `todo.updated` event arrived within 10 seconds of the last, `pollAndProcess()` skipped the API poll and also skipped calling `processTodos()`. This meant the `scheduleNudge` fallback and review debounce timer were never started for sessions with pending todos. Fix: `pollAndProcess()` now reprocesses cached todos (`s.lastKnownTodos`) even when the poll is skipped due to event freshness, ensuring nudge scheduling and review triggers work correctly in this path.

**Delayed continue fallback**: Both `handleSessionIdle` and `handleSessionStatus` now schedule a 3-second delayed fallback when `session.idle/status(idle)` fires while `aborting=true` and `needsContinue=true`. The fallback is guarded by `isDisposed()` and `continueInProgress` to prevent double-sends.

**Nudge fallback from todo poller**: `processTodos()` calls `scheduleNudge(sessionId)` when `hasPending && !nudgePaused`, providing a fallback nudge path independent of `session.idle` events.

**Refactored reviewFired reset logic**: `processTodos()` now resets `reviewFired` earlier in a separate branch when `allCompleted && reviewFired && !inCooldown`, then falls through to the existing `allCompleted && !reviewFired` branch — eliminating ~20 lines of duplicated debounce/compact logic.


## Roadmap

See [`todo.md`](./todo.md) for the full development roadmap, including completed items, in-progress work, and planned features.

---


## Performance

- **Memory**: One SessionState per active session (~150 bytes each)
- **Timers**: Max 1 timer per session (stall recovery)
- **Polling**: Status polling only during recovery (not continuous)
- **File I/O**: Status file uses atomic writes (`.tmp` + rename)
- **CPU**: Event-driven, no background loops
- **Dependencies**: Zero external dependencies at runtime


## License

This project is dual-licensed:

- **AGPL-3.0-only** — See [LICENSE](LICENSE) for the full text. This is the default license for open source use.
- **Commercial License** — For organizations that prefer not to comply with AGPLv3's source disclosure requirements. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for details.

By contributing to this project, you agree to the terms in [CLA.md](CLA.md).