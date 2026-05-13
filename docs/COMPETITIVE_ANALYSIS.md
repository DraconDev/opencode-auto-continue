# Competitive Analysis: opencode-auto-continue vs Similar Tools

**Date**: 2026-05-07
**Scope**: OpenCode session recovery, management, and orchestration plugins

---

## Competitors Analyzed

### 1. opencode-auto-resume (Mte90)
- **Stars**: 38
- **Release**: v1.0.9 (Apr 2026)
- **Size**: 1028 lines single file (~40KB)
- **Architecture**: Monolithic, event-driven with 5s timer loop

### 2. opencode-sessions (malhashemi)
- **Stars**: 157 (most popular)
- **Release**: v1.0.0 (Oct 2025)
- **Scope**: Multi-agent collaboration, NOT auto-recovery
- **Architecture**: Tool-based session orchestration

### 3. supermemory.ai plugin
- **Scope**: Persistent memory across sessions
- **Not competitive** - complementary feature

### 4. Reddit "tiny auto-continue" plugin
- **Scope**: TASK_STATUS parsing
- **Not competitive** - too simple

---

## Feature Comparison Matrix

| Feature | auto-continue (us) | auto-resume (Mte90) | sessions (malhashemi) |
|---------|-------------------|---------------------|----------------------|
| **Stall Detection** | Timer-based (configurable) | Timer-based (48s fixed) | N/A |
| **Auto-Continue** | ✅ Yes | ✅ Yes | N/A |
| **Tool-Text Recovery** | ✅ 18 regex patterns | ✅ XML pattern scan | N/A |
| **Hallucination Loop** | ✅ Sliding window (3/10min) | ✅ Counter window | N/A |
| **Orphan Parent** | ✅ Yes | ✅ busyCount drop detection | N/A |
| **Subagent Stuck** | ❌ No | ✅ Subagent timeout | N/A |
| **Abort Required** | ✅ Yes (before compact) | ✅ Yes | N/A |
| **Model Preservation** | ❌ No | ✅ Extract from messages | N/A |
| **Session Discovery** | ✅ Yes | ✅ session.list() polling | N/A |
| **Idle Cleanup** | ✅ Yes | ✅ 10min timeout | N/A |
| **Token Limit Recovery** | ✅ Exact/error/step-finish | ❌ No | N/A |
| **Proactive Compaction** | ✅ Auto-compact at 100k | ❌ No | ✅ Manual |
| **Todo Nudge** | ✅ Idle nudge with cooldown | ❌ No | N/A |
| **Todo Review** | ✅ On completion | ❌ No | N/A |
| **AI Advisory** | ✅ Heuristic + AI hybrid | ❌ No | N/A |
| **Question Detection** | ✅ 12 phrases + ? check | ❌ No | N/A |
| **Prompt Guard** | ✅ Cross-instance dedup | ❌ No | N/A |
| **Status File** | ✅ Atomic writes, rotation | ❌ No | N/A |
| **Terminal Integration** | ✅ OSC 0/2 + 9;4 progress | ❌ No | N/A |
| **Notifications** | ✅ Toast, deduped | ❌ No | N/A |
| **Context Pruning** | ✅ DCP integration | ❌ No | N/A |
| **Multi-Agent** | ❌ No | ❌ No | ✅ Fork/Handoff/Compress |
| **Learning System** | 🚧 v7.0 planned | ❌ No | ❌ No |
| **Intent Extraction** | 🚧 code exists but not wired into main plugin | ❌ No | ❌ No |
| **Strategy Pool** | 🚧 code exists but not wired into main plugin | ❌ No | ❌ No |
| **Config Options** | 45+ | 8 | ~5 |
| **Test Coverage** | 389 tests (growing) | Unknown | Unknown |
| **Modular Code** | ✅ 13 source files | ❌ Single file | ❌ Single file |

---

## Where Mte90's auto-resume Beats Us

### 1. **Orphan Parent Detection** ⭐ CRITICAL
- **What**: Detects when subagent finishes but parent stays busy
- **How**: Monitors busyCount dropping from >1 to 1, waits 15s, aborts parent
- **Our Status**: ✅ Implemented in v7.5 session-monitor.ts
- **Impact**: Users with subagents experience stuck parents

### 2. **Subagent Stuck Detection**
- **What**: Detects subagents stuck for >1min (or >3min during tool call)
- **How**: Per-subagent timeout with tool-call awareness
- **Our Gap**: No subagent-specific monitoring
- **Impact**: Subagent failures cascade to parent

### 3. **Model Preservation**
- **What**: Extracts agent/model/provider from last message
- **Why**: Ensures continue uses same model user selected
- **Our Gap**: Continue may use default model
- **Impact**: Model switching breaks context consistency

### 4. **Session Discovery**
- **What**: Periodic session.list() to find missed sessions
- **Why**: Event hooks can miss sessions in some edge cases
- **Our Status**: ✅ Implemented in v7.5 session-monitor.ts
- **Impact**: Some sessions may never get monitored

### 5. **Idle Session Cleanup**
- **What**: Removes sessions idle >10min or >50 entries
- **Why**: Prevents memory leaks in long-running OpenCode
- **Our Status**: ✅ Implemented in v7.5 session-monitor.ts
- **Impact**: Memory bloat over days of use

### 6. **Simplicity**
- **What**: Single file, 8 config options
- **Why**: Easy to understand, debug, contribute
- **Our Gap**: 2700+ lines, 45+ config options
- **Impact**: Steeper learning curve for contributors

---

## Where We Beat Mte90's auto-resume

### 1. **Token-Aware Recovery** ⭐ MAJOR
- **What**: Exact token tracking from errors + step-finish + estimation
- **Why**: Prevents stalls caused by context bloat
- **Their Gap**: No token monitoring at all
- **Impact**: Their users hit token limits without recovery

### 2. **Proactive Compaction**
- **What**: Auto-compact at 100k tokens before emergency
- **Why**: Prevents stalls instead of just recovering
- **Their Gap**: No compaction support
- **Impact**: Sessions die at context limit

### 3. **Todo Integration**
- **What**: Nudge on idle, review on completion
- **Why**: Keeps agent focused on actual tasks
- **Their Gap**: No todo awareness
- **Impact**: Agent may drift from goals

### 4. **AI Advisory**
- **What**: Hybrid heuristic + AI analysis
- **Why**: Smarter decisions than timeout alone
- **Their Gap**: Pure timer-based
- **Impact**: Less nuanced recovery decisions

### 5. **Question Detection**
- **What**: Skips nudge when AI asks user something
- **Why**: Prevents annoying false nudges
- **Their Gap**: No question detection
- **Impact**: May interrupt legitimate user-AI dialog

### 6. **Cross-Instance Prompt Guard**
- **What**: Checks recent messages before injecting
- **Why**: Prevents duplicate prompts from multiple instances
- **Their Gap**: No deduplication
- **Impact**: Duplicate "continue" messages possible

### 7. **Terminal Visibility**
- **What**: OSC title + progress bar
- **Why**: User sees plugin status without log files
- **Their Gap**: No UI feedback
- **Impact**: Users don't know plugin is working

### 8. **Status File**
- **What**: Atomic writes with rotation
- **Why**: Debug without console.log
- **Their Gap**: No persistent status
- **Impact**: Harder to diagnose issues

### 9. **Config Richness**
- **What**: 45+ tunable options
- **Why**: Adapt to different models/providers
- **Their Gap**: 8 fixed options
- **Impact**: Less flexible for different setups

### 10. **Test Coverage**
- **What**: 319 tests, modular architecture
- **Why**: Reliable, maintainable code
- **Their Gap**: Unknown (single file)
- **Impact**: Risk of regressions

---

## Where malhashemi's sessions Beats Us

### 1. **Multi-Agent Orchestration** ⭐ UNIQUE
- **What**: Fork, message, compact, new session modes
- **Why**: Enables parallel exploration and collaboration
- **Our Gap**: Single-session focus
- **Impact**: Can't explore multiple approaches

### 2. **Agent Relay Pattern**
- **What**: Turn-based agent handoff
- **Why**: Clean phase transitions (research → plan → build)
- **Our Gap**: No agent switching
- **Impact**: Single agent does everything

### 3. **Manual Compression Control**
- **What**: User-triggered compaction with handoff message
- **Why**: Context-preserving compression at right moment
- **Our Gap**: Only automatic compaction
- **Impact**: Less control over context management

### 4. **Community Adoption**
- **What**: 157 stars vs our unknown
- **Why**: More visibility, contributors, feedback
- **Our Gap**: Less discoverable
- **Impact**: Slower community growth

---

## Recommended Improvements (Prioritized)

### 🔴 CRITICAL (Implement Next)

#### 1. Orphan Parent Detection
```typescript
// In recovery.ts or new module
function checkOrphanParent(sessions: Map<string, SessionState>) {
  const busyCount = countBusySessions(sessions);
  if (previousBusyCount > 1 && busyCount === 1) {
    // Subagent finished, check if parent stuck
    const parent = findParentSession(sessions);
    if (parent && parent.status === 'busy' && 
        Date.now() - parent.lastProgressAt > config.subagentWaitMs) {
      recover(parent.id, { isOrphan: true });
    }
  }
  previousBusyCount = busyCount;
}
```

#### 2. Session Discovery
```typescript
// Periodic session.list() polling
async function discoverSessions() {
  const result = await input.client.session.list();
  for (const session of result.data) {
    if (!sessions.has(session.id)) {
      initializeSession(session.id);
    }
  }
}
```

#### 3. Idle Session Cleanup
```typescript
// In timer or periodic check
function cleanupIdleSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.status === 'idle' && now - s.lastActivityAt > config.idleCleanupMs) {
      sessions.delete(id);
      log('cleaned up idle session:', id);
    }
  }
  // Also enforce max session count
  if (sessions.size > config.maxSessions) {
    const oldest = findOldestIdleSession(sessions);
    if (oldest) sessions.delete(oldest);
  }
}
```

### 🟠 HIGH (This Week)

#### 4. Model Preservation
```typescript
// Extract model config from last message
async function getModelFromSession(sessionId: string): Promise<ModelConfig | null> {
  const messages = await input.client.session.messages({ path: { id: sessionId }, query: { limit: 1 } });
  const msg = messages.data?.[0];
  if (msg?.agent || msg?.model || msg?.provider) {
    return { agent: msg.agent, model: msg.model, provider: msg.provider };
  }
  return null;
}
```

#### 5. Subagent Stuck Detection
```typescript
// Monitor child sessions
function checkSubagentHealth(parentId: string) {
  const parent = sessions.get(parentId);
  if (!parent?.childSessions) return;
  
  for (const childId of parent.childSessions) {
    const child = sessions.get(childId);
    if (child?.status === 'busy' && 
        Date.now() - child.lastProgressAt > config.subagentTimeoutMs) {
      // Child stuck - notify parent or abort child
      handleStuckSubagent(parentId, childId);
    }
  }
}
```

#### 6. Simplify Default Config
```typescript
// Provide "presets" for common setups
const PRESETS = {
  default: { stallTimeoutMs: 45000, maxRecoveries: 3 },
  aggressive: { stallTimeoutMs: 30000, maxRecoveries: 5 },
  gentle: { stallTimeoutMs: 60000, maxRecoveries: 2 },
  subagent: { stallTimeoutMs: 45000, maxRecoveries: 3, subagentEnabled: true },
};
```

### 🟡 MEDIUM (This Month)

#### 7. Feature Flags for v7.0
```typescript
// Make autonomy features opt-in
const config = {
  autonomy: {
    level: 'basic', // 'basic' | 'adaptive' | 'proactive' | 'full'
    enableOrphanDetection: false,
    enableSubagentMonitor: false,
    enableLearning: false,
  }
};
```

#### 8. Health Check Endpoint
```typescript
// Status endpoint for external monitoring
function getHealthStatus(): HealthReport {
  return {
    version: packageJson.version,
    sessionsMonitored: sessions.size,
    sessionsBusy: countBusySessions(),
    totalRecoveries: stats.totalRecoveries,
    totalNudges: stats.totalNudges,
    lastRecoveryAt: stats.lastRecoveryAt,
    uptime: Date.now() - startTime,
  };
}
```

#### 9. Better Documentation
- Quick-start guide with presets
- Troubleshooting flowchart
- Configuration cookbook
- Architecture diagrams

### 🟢 LOW (Future)

#### 10. Benchmarks
- Performance: event handling < 1ms
- Recovery latency: detect → abort → continue < 10s
- Memory: < 50MB for 100 sessions

#### 11. Telemetry (Opt-in)
- Recovery success rate per strategy
- Average time-to-recovery
- Most common stall patterns
- Model-specific failure rates

---

## Differentiation Strategy

### What Makes Us Unique

1. **Recovery + Nudge + Review** — Complete lifecycle, not just recovery
2. **Token-Aware** — Only plugin with proactive context management
3. **AI Advisory** — Hybrid intelligence for edge cases
4. **Terminal Integration** — User visibility without TUI breakage
5. **v7.0 Autonomy Vision** — Self-improving, predictive, strategic

### Marketing Angles

- **"The complete session lifecycle manager"** (vs just recovery)
- **"Token-aware recovery"** (vs naive timeout)
- **"Autonomous session intelligence"** (v7.0 positioning)
- **"Never lose context again"** (proactive compaction)

---

## Next Steps

1. ~~**Implement orphan parent detection**~~ ✅ Done in v7.5
2. ~~**Add session discovery polling**~~ ✅ Done in v7.5
3. ~~**Add idle session cleanup**~~ ✅ Done in v7.5
4. **Update README** with competitive comparison
5. **Create "Why auto-continue over auto-resume?"** documentation page

---

*Analysis by: opencode-auto-continue team*
*Date: 2026-05-07*
