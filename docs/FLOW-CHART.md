# Plugin Flow Chart — What Actually Happens

> This document maps the actual behavior of `opencode-auto-continue` v7.8.235. Every flow described here has been verified against the source code.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Main Event Loop](#main-event-loop)
3. [Session State Machine](#session-state-machine)
4. [Stall Recovery Flow](#stall-recovery-flow)
5. [Nudge Flow](#nudge-flow)
6. [Review Flow](#review-flow)
7. [Session Monitor Flow](#session-monitor-flow)
8. [Token Estimation & Compaction](#token-estimation--compaction)
9. [Complete Decision Matrix](#complete-decision-matrix)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode Plugin Host                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Events     │  │   Client     │  │   TUI/Terminal   │   │
│  │  (stream)    │  │   (API)      │  │   (UI hooks)     │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                   │             │
│         └─────────────────┴───────────────────┘             │
│                           │                                  │
│                    ┌──────┴──────┐                           │
│                    │  index.ts   │                           │
│                    │  (router)   │                           │
│                    └──────┬──────┘                           │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐               │
│         │                 │                 │               │
│    ┌────┴────┐      ┌────┴────┐      ┌────┴────┐          │
│    │recovery │      │ nudge   │      │ review  │          │
│    │  .ts    │      │  .ts    │      │  .ts    │          │
│    └────┬────┘      └────┬────┘      └────┬────┘          │
│         │                 │                 │               │
│    ┌────┴────┐      ┌────┴────┐      ┌────┴────┐          │
│    │session  │      │terminal │      │status   │          │
│    │monitor  │      │  .ts    │      │file.ts  │          │
│    │  .ts    │      └─────────┘      └─────────┘          │
│    └─────────┘                                              │
└─────────────────────────────────────────────────────────────┘
```

**Module Responsibilities:**

| Module | Lines | Purpose |
|--------|-------|---------|
| `index.ts` | 923 | Main event router, state management, module wiring |
| `recovery.ts` | 398 | Stall detection, abort+continue, hallucination loop detection |
| `nudge.ts` | 408 | Idle reminders with question detection and loop protection |
| `review.ts` | 157 | Review prompt on completion, continue delivery |
| `session-monitor.ts` | 338 | Orphan detection, session discovery, idle cleanup |
| `terminal.ts` | 110 | OSC title/progress updates |
| `status-file.ts` | ~180 | Atomic JSON status writes |
| `compaction.ts` | ~200 | Emergency compaction on token limits |
| `ai-advisor.ts` | ~460 | Heuristic + AI advisory (optional) |
| `shared.ts` | ~600 | Types, config, utilities |

---

## Main Event Loop

Every OpenCode event flows through this path:

```
[OpenCode Event]
       │
       ▼
┌──────────────┐
│  index.ts    │
│  event()     │
└──────┬───────┘
       │
       ▼
┌─────────────────────────┐
│ Extract session ID      │
│ (from properties)       │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ Route by event type     │
│ (big if/else chain)     │
└──────┬──────────────────┘
       │
       ├──► session.created ─────► createSession()
       ├──► session.status(busy) ─► updateProgress() + scheduleRecovery()
       ├──► session.status(idle) ─► clearTimer() + sendContinue() + scheduleNudge()
       ├──► message.part.updated ─► updateProgress() + clearTimer() + scheduleRecovery()
       ├──► message.updated ──────► track tokens + user message detection
       ├──► message.created ──────► updateProgress() + clearTimer()
       ├──► todo.updated ─────────► check completion + triggerReview()
       ├──► session.error ────────► handle abort / token limit / other
       ├──► session.idle ─────────► scheduleNudge()
       ├──► session.compacted ────► clear compacting flag
       └──► session.deleted ──────► resetSession()
```

**Key insight**: There is no event queue — each event is handled synchronously (with async operations). Race conditions are possible but mitigated by state flags (`aborting`, `needsContinue`, `compacting`, etc.).

---

## Session State Machine

```
                    ┌─────────────┐
                    │   CREATED   │
                    │ (init state)│
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │   BUSY   │ │   IDLE   │ │  ERROR   │
      │ (active) │ │ (paused) │ │ (paused) │
      └────┬─────┘ └────┬─────┘ └────┬─────┘
           │            │            │
           │    ┌───────┘            │
           │    │                    │
           ▼    ▼                    ▼
      ┌──────────────────────────────────┐
      │         RECOVERY TIMER           │
      │   (stallTimeoutMs countdown)     │
      └──────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │Recover() │ │ Progress │ │  User    │
      │ (abort+  │ │ (reset)  │ │ Abort    │
      │ continue)│ │          │ │ (stop)   │
      └──────────┘ └──────────┘ └──────────┘
```

### State Transitions (Verified)

| From | To | Trigger | Action |
|------|----|---------|--------|
| CREATED | BUSY | `session.status(busy)` | Start stall timer |
| CREATED | IDLE | `session.status(idle)` | Clear timer, schedule nudge |
| BUSY | IDLE | `session.status(idle)` | Clear timer, send queued continue |
| BUSY | BUSY | `message.part.updated` | Reset timer, reset attempts |
| BUSY | RECOVERY | Timer fires | abort() + wait + continue |
| IDLE | BUSY | `session.status(busy)` | Start stall timer |
| ANY | PAUSED | `planning=true` | Pause stall timer |
| ANY | PAUSED | `compacting=true` | Pause stall timer |
| ANY | ENDED | `session.deleted` | Full cleanup |

### State Flags (What They Actually Do)

```
SessionState {
  timer: Timeout | null           // Stall recovery timer
  nudgeTimer: Timeout | null      // Nudge delay timer
  reviewDebounceTimer: Timeout | null  // Review delay timer
  
  aborting: boolean               // Currently in abort+continue flow
  needsContinue: boolean          // Continue message queued
  userCancelled: boolean          // User pressed ESC (permanent until reset)
  planning: boolean               // AI is planning (pause monitoring)
  compacting: boolean             // Compaction in progress (pause monitoring)
  
  attempts: number                // Recovery attempts this session
  autoSubmitCount: number         // Total continues sent (loop protection)
  nudgeCount: number              // Nudges sent (loop protection)
  
  lastProgressAt: number          // Timestamp of last real progress
  actionStartedAt: number         // When session went busy
  sessionCreatedAt: number        // Session creation timestamp
  
  estimatedTokens: number         // Running token estimate
  tokenLimitHits: number          // How many token limit errors
  
  hasOpenTodos: boolean           // Cached todo state
  lastKnownTodos: Todo[]          // Last seen todo list
  reviewFired: boolean            // Review already sent (one-shot)
  
  stallPatterns: Record<string,number>  // Part type → stall count
  continueTimestamps: number[]    // For hallucination loop detection
}
```

---

## Stall Recovery Flow

This is the core feature. Here's what **actually** happens step by step:

```
[Session goes BUSY]
       │
       ▼
┌─────────────────────────────┐
│ scheduleRecovery(delayMs)   │
│ Set timeout for stallTimeoutMs
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ [Timer fires — recover()]   │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ GUARD CHECKS (early exits)  │
│ • isDisposed()              │
│ • !session exists           │
│ • aborting (already)        │
│ • userCancelled             │
│ • planning                  │
│ • compacting                │
│ • attempts >= maxRecoveries │ ──► exponential backoff
│ • cooldown active           │ ──► reschedule
│ • session too old           │ ──► give up
└──────┬──────────────────────┘
       │ (all checks passed)
       ▼
┌─────────────────────────────┐
│ Mark session aborting=true  │
│ Increment stallDetections   │
│ Record recoveryStartTime    │
│ Track stall pattern         │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Check session.status()      │
│ Is it still busy?           │
└──────┬──────────────────────┘
       │ NO
       ▼
   Return (session recovered naturally)
       │
       │ YES
       ▼
┌─────────────────────────────┐
│ Check: time since last      │
│ progress >= stallTimeoutMs? │
└──────┬──────────────────────┘
       │ NO (false alarm)
       ▼
   Reschedule with remaining time
       │
       │ YES (real stall)
       ▼
┌─────────────────────────────┐
│ Check tool-text in last 3   │
│ assistant messages          │
│ (XML tool calls in text)    │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ session.abort()             │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Poll session.status()       │
│ until idle (up to 5s)       │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ If autoCompact:             │
│ session.summarize()         │
│ (emergency compaction)      │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Wait waitAfterAbortMs (5s)  │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Check: autoSubmitCount >=   │
│ maxAutoSubmits?             │
└──────┬──────────────────────┘
       │ YES
       ▼
   Give up (loop protection)
       │
       │ NO
       ▼
┌─────────────────────────────┐
│ Check hallucination loop:   │
│ 3+ continues in 10 min?     │
└──────┬──────────────────────┘
       │ YES
       ▼
   abort() again + wait 3s
       │
       │ NO
       ▼
┌─────────────────────────────┐
│ BUILD CONTINUE MESSAGE      │
│ Priority:                   │
│ 1. Tool-text detected?      │ ──► TOOL_TEXT_RECOVERY_PROMPT
│ 2. AI custom prompt?        │ ──► Use AI-generated prompt
│ 3. planning=true?           │ ──► continueWithPlanMessage
│ 4. Has pending todos?       │ ──► continueWithTodosMessage
│ 5. Default                  │ ──► continueMessage
│ 6. Token limit hits?        │ ──► shortContinueMessage
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Prompt guard: check for     │
│ duplicate in recent msgs    │
└──────┬──────────────────────┘
       │ DUPLICATE FOUND
       ▼
   Skip (prevent spam)
       │
       │ NO DUPLICATE
       ▼
┌─────────────────────────────┐
│ Set needsContinue=true      │
│ Set continueMessageText     │
│ Increment attempts          │
│ Increment autoSubmitCount   │
│ Cancel any pending nudge    │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Is session idle NOW?        │
└──────┬──────────────────────┘
       │ YES
       ▼
   Send continue immediately
       │
       │ NO
       ▼
   Wait for session.status(idle)
   event to send continue
```

**Continue message priority** (exact order from `recovery.ts:306-354`):

1. **Tool-text recovery prompt** (if XML detected in last 3 messages)
2. **AI advisor custom prompt** (if `lastAdvisoryAdvice.customPrompt` exists)
3. **Plan-aware message** (if `planning=true`)
4. **Todo context message** (if pending todos exist and `includeTodoContext`)
5. **Default continue message** (fallback)
6. **Short message** (if `tokenLimitHits > 0` — overrides all above)

**Critical timing**:
- Recovery timer: `stallTimeoutMs` (default 45s)
- Abort poll: every `abortPollIntervalMs` (default 200ms), max `abortPollMaxTimeMs` (default 5s)
- Wait after abort: `waitAfterAbortMs` (default 5s)
- Cooldown between recoveries: `cooldownMs` (default 60s)

---

## Nudge Flow

Nudges remind the AI to continue when idle with pending todos.

```
[session.status(idle)] or [session.idle]
       │
       ▼
┌─────────────────────────────┐
│ scheduleNudge()             │
│ Set timeout for             │
│ nudgeIdleDelayMs (500ms)    │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ [Timer fires — injectNudge()]
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ GUARD CHECKS (early exits)  │
│ • isDisposed()              │
│ • !nudgeEnabled             │
│ • nudgePaused (after abort) │
│ • needsContinue (recovery)  │
│ • aborting                  │
│ • planning                  │
│ • compacting                │
│ • cooldown active           │
│ • session busy/retry        │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Fetch todos from API        │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ No pending todos?           │
└──────┬──────────────────────┘
       │ YES
       ▼
   Reset nudge counter, return
       │
       │ NO
       ▼
┌─────────────────────────────┐
│ Check todo snapshot changed?│
│ (detects real progress)     │
└──────┬──────────────────────┘
       │ YES
       ▼
   Reset nudge counter
       │
       ▼
┌─────────────────────────────┐
│ nudgeCount >= nudgeMaxSubmits?
│ (loop protection)           │
└──────┬──────────────────────┘
       │ YES
       ▼
   Show warning toast, return
       │
       │ NO
       ▼
┌─────────────────────────────┐
│ Check last assistant msg    │
│ Is it a question?           │
│ (? or phrases like "should  │
│  I", "would you like")      │
└──────┬──────────────────────┘
       │ YES
       ▼
   Skip nudge (AI needs user)
       │
       │ NO
       ▼
┌─────────────────────────────┐
│ AI Advisory check (optional)│
│ If enableAdvisory:          │
│   getAdvice()               │
│   Skip if wait>=0.7 or      │
│   abort>=0.6 confidence     │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Build nudge message         │
│ Uses nudgeMessage template  │
│ with {pending}, {todoList}  │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Prompt guard check          │
│ (prevent duplicates)        │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Send via session.prompt()   │
│ Marked synthetic=true       │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ If aborted: pauseNudge()    │
│ Else: increment nudgeCount  │
│ Update lastNudgeAt          │
│ Show toast (if enabled)     │
└─────────────────────────────┘
```

**Nudge message priority** (from `nudge.ts:273-297`):
1. AI advisor custom prompt (if available)
2. `nudgeMessage` template with todo context

**When nudges DON'T fire**:
- Session is busy/retry
- No pending todos
- User recently messaged (`lastUserMessageId` set)
- After ESC abort (`nudgePaused=true`)
- Loop protection triggered (3 nudges without progress)
- Cooldown active (`nudgeCooldownMs`)
- AI is asking a question
- AI advisor says wait/abort

---

## Review Flow

Review fires once when all todos complete.

```
[todo.updated event]
       │
       ▼
┌─────────────────────────────┐
│ Check: all todos completed? │
│ (every todo is completed    │
│  or cancelled)              │
└──────┬──────────────────────┘
       │ NO
       ▼
   Clear review debounce timer
   Return
       │
       │ YES
       ▼
┌─────────────────────────────┐
│ Already fired? (reviewFired)│
└──────┬──────────────────────┘
       │ YES
       ▼
   Skip (one-shot per session)
       │
       │ NO
       ▼
┌─────────────────────────────┐
│ reviewOnComplete enabled?   │
└──────┬──────────────────────┘
       │ NO
       ▼
   Skip
       │
       │ YES
       ▼
┌─────────────────────────────┐
│ Set debounce timer          │
│ (reviewDebounceMs = 500ms)  │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ [Debounce fires]            │
│ triggerReview()             │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ GUARD CHECKS                │
│ • isDisposed()              │
│ • !session exists           │
│ • reviewFired (already)     │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Show toast (if enabled)     │
│ "Session Complete"          │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Prompt guard check          │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Send review prompt          │
│ via session.prompt()        │
│ synthetic=true              │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Set reviewFired=true        │
│ (PERMANENT for this session)│
└─────────────────────────────┘
```

**Important**: `reviewFired` is **never reset** during a session. It only clears on `session.deleted` or `session.ended` via `resetSession()`. This means:
- Review fires **exactly once** per session
- If AI creates fix todos after review, review **won't fire again**
- The "test-fix loop" documented in old READMEs doesn't actually work

---

## Session Monitor Flow

Three independent timers run in the background:

```
Plugin Init
    │
    ├──► start() 
    │      │
    │      ├──► 5s interval ──► checkOrphanParents()
    │      │                      │
    │      │                      ▼
    │      │              ┌─────────────────┐
    │      │              │ Count busy      │
    │      │              │ sessions        │
    │      │              └────────┬────────┘
    │      │                       │
    │      │              ┌────────┴────────┐
    │      │              │ Count dropped   │
    │      │              │ from >1 to 1?   │
    │      │              │ (subagent done) │
    │      │              └────────┬────────┘
    │      │                       │ YES
    │      │                       ▼
    │      │              ┌─────────────────┐
    │      │              │ Wait orphanWaitMs
    │      │              │ (default 15s)   │
    │      │              └────────┬────────┘
    │      │                       │
    │      │              ┌────────┴────────┐
    │      │              │ Still busy?     │
    │      │              └────────┬────────┘
    │      │                       │ YES
    │      │                       ▼
    │      │              ┌─────────────────┐
    │      │              │ recover(parentId)│
    │      │              │ (force abort+    │
    │      │              │  continue)       │
    │      │              └─────────────────┘
    │      │
    │      ├──► 60s interval ──► discoverSessions()
    │      │                      │
    │      │                      ▼
    │      │              ┌─────────────────┐
    │      │              │ session.list()  │
    │      │              └────────┬────────┘
    │      │                       │
    │      │              ┌────────┴────────┐
    │      │              │ Unknown + busy? │
    │      │              └────────┬────────┘
    │      │                       │ YES
    │      │                       ▼
    │      │              ┌─────────────────┐
    │      │              │ Create minimal  │
    │      │              │ SessionState    │
    │      │              │ Start recovery  │
    │      │              │ timer           │
    │      │              └─────────────────┘
    │      │
    │      └──► 30s interval ──► cleanupIdleSessions()
    │                             │
    │                             ▼
    │                     ┌─────────────────┐
    │                     │ Find idle >     │
    │                     │ idleCleanupMs   │
    │                     │ (default 10min) │
    │                     └────────┬────────┘
    │                              │
    │                     ┌────────┴────────┐
    │                     │ No pending work │
    │                     │ (timers, ops)   │
    │                     └────────┬────────┘
    │                              │ YES
    │                              ▼
    │                     ┌─────────────────┐
    │                     │ Remove from     │
    │                     │ sessions Map    │
    │                     └─────────────────┘
```

---

## Token Estimation & Compaction

### Token Estimation (Three Sources)

```
[Token Tracking]
       │
       ├──► message.updated (assistant)
       │      └──► info.tokens {input, output, reasoning}
       │           Add to estimatedTokens
       │
       ├──► message.part.updated (step-finish)
       │      └──► part.tokens {input, output, reasoning}
       │           max(estimatedTokens, stepTokens)
       │
       ├──► session.error (token limit)
       │      └──► Parse from error message
       │           "You requested 264230 tokens..."
       │           max(estimatedTokens, parsedTotal)
       │
       └──► Fallback estimation
              └──► estimateTokens(text)
                   English: chars × 0.75 / 4
                   Code: chars × 1.0 / 4
                   Digits: chars × 0.5 / 4
```

### Emergency Compaction Flow

```
[session.error]
       │
       ▼
┌─────────────────────────────┐
│ Is token limit error?       │
│ (matches tokenLimitPatterns)│
└──────┬──────────────────────┘
       │ NO
       ▼
   Normal error handling
       │
       │ YES
       ▼
┌─────────────────────────────┐
│ Increment tokenLimitHits    │
│ Parse exact token counts    │
│ Update estimatedTokens      │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ forceCompact(sessionId)     │
│ (async, may take seconds)   │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Try session.summarize()     │
│ Retry up to compactMaxRetries
│ (default 3)                 │
└──────┬──────────────────────┘
       │
       ├──► Success ──► Return true
       │
       └──► Failure ──► Return false
```

**Post-compaction**: `estimatedTokens *= (1 - compactReductionFactor)`
- Default factor: 0.7 → tokens reduced to 30%

---

## Complete Decision Matrix

### When Does Recovery Fire?

| Condition | Recovery? | Notes |
|-----------|-----------|-------|
| Session busy, no progress for `stallTimeoutMs` | ✅ Yes | Default 45s |
| Session busy, progress within timeout | ❌ No | Timer resets |
| Session idle | ❌ No | Timer cleared |
| `planning=true` | ❌ No | Monitoring paused |
| `compacting=true` | ❌ No | Monitoring paused |
| `userCancelled=true` | ❌ No | ESC pressed |
| `aborting=true` | ❌ No | Already recovering |
| `attempts >= maxRecoveries` | ⚠️ Backoff | Exponential delay |

### When Does Nudge Fire?

| Condition | Nudge? | Notes |
|-----------|--------|-------|
| Session idle + pending todos | ✅ Yes | After `nudgeIdleDelayMs` |
| Session busy | ❌ No | Skipped |
| No pending todos | ❌ No | Nothing to nudge |
| User recently messaged | ❌ No | `lastUserMessageId` set |
| After ESC abort | ❌ No | `nudgePaused=true` |
| Loop protection (3 nudges) | ❌ No | Need progress first |
| AI asking question | ❌ No | Question detection |
| Cooldown active | ❌ No | `nudgeCooldownMs` |

### When Does Review Fire?

| Condition | Review? | Notes |
|-----------|---------|-------|
| All todos complete + not yet fired | ✅ Yes | Debounced 500ms |
| Already fired this session | ❌ No | `reviewFired` permanent |
| `reviewOnComplete=false` | ❌ No | Disabled |
| New todos created after review | ❌ No | One-shot only |

### When Does Compaction Fire?

| Condition | Compact? | Notes |
|-----------|----------|-------|
| Token limit error | ✅ Yes | Emergency only |
| Proactive (token threshold) | ❌ No | Delegated to DCP |
| Manual trigger | ❌ No | Not exposed |

---

## Edge Cases & Race Conditions

### 1. Recovery During Nudge
```
If recovery fires while nudge is scheduled:
- recovery.ts calls cancelNudge()
- Recovery takes priority
- Nudge won't fire until next idle
```

### 2. User Message During Recovery
```
If user sends message while needsContinue=true:
- message.created handler clears needsContinue
- Queued continue is cancelled
- User message takes priority
```

### 3. Session Goes Idle During Abort
```
If session.status(idle) arrives while aborting:
- Checks s.aborting flag
- "session idle while recovery is finalizing"
- Doesn't send continue (recovery will handle it)
```

### 4. Synthetic Message Filter
```
All plugin prompts use synthetic=true
Event handler ignores parts with synthetic=true
Prevents infinite loops
```

### 5. Plan Detection Race
```
session.status(busy) does NOT clear planning flag
(because planning IS busy work)
planning cleared by non-plan progress:
- tool, file, subtask, step-start, step-finish
```

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────┐
│                    EXTERNAL STATE                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │OpenCode  │  │Plan File │  │Status    │  │Terminal│  │
│  │Session   │  │(PLAN.md) │  │File      │  │(OSC)   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │             │             │            │        │
│       │◄────────────┼─────────────┼────────────┘        │
│       │  abort()    │  writeFile  │  writeFile          │
│       │  prompt()   │             │                     │
│       │  todo()     │             │                     │
│       │  messages() │             │                     │
│       │  status()   │             │                     │
│       │  summarize()│             │                     │
│       │             │             │                     │
│       └─────────────┴─────────────┴─────────────────────┘
│                          │
│                          ▼
│               ┌─────────────────────┐
│               │   sessions Map      │
│               │   (in-memory state) │
│               └─────────────────────┘
│                          │
│       ┌──────────────────┼──────────────────┐
│       │                  │                  │
│       ▼                  ▼                  ▼
│  ┌─────────┐      ┌─────────┐      ┌─────────┐
│  │Recovery │      │ Nudge   │      │ Review  │
│  │ Module  │      │ Module  │      │ Module  │
│  └─────────┘      └─────────┘      └─────────┘
└─────────────────────────────────────────────────────────┘
```

---

## Configuration Impact Map

| Config | Affects | What Changes |
|--------|---------|--------------|
| `stallTimeoutMs` | Recovery timer | How long before stall detected |
| `maxRecoveries` | Recovery | How many attempts before backoff |
| `cooldownMs` | Recovery | Min time between attempts |
| `waitAfterAbortMs` | Recovery | Pause between abort and continue |
| `nudgeEnabled` | Nudge | Master switch |
| `nudgeIdleDelayMs` | Nudge | Delay after idle before nudge |
| `nudgeCooldownMs` | Nudge | Min time between nudges |
| `nudgeMaxSubmits` | Nudge | Loop protection threshold |
| `autoCompact` | Compaction | Enable emergency compaction |
| `reviewOnComplete` | Review | Enable review prompts |
| `enableAdvisory` | Advisor | Enable AI/heuristic analysis |
| `sessionMonitorEnabled` | Monitor | Enable orphan discovery cleanup |

---

*Generated from source code analysis of opencode-auto-continue v7.8.235*
