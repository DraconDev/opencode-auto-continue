# Full Project Review — opencode-auto-continue v7.19.31

**Date**: 2026-05-17  
**Reviewer**: pi coding agent  
**Previous review**: REVIEW.md (first pass)

---

## 📊 Executive Summary

The project is a well-engineered OpenCode plugin with 16 features across 6,644 source LOC, zero runtime deps, and 773/773 tests passing. Two major refactors have been completed since the first review: `event-handlers.ts` split and `SessionState` decomposition. The codebase is now better organized but still carries the same type-safety debt (20 `as any` casts) and silent-failure risks (5 empty catches in `tokens.ts`).

**Net change from first review:**
- ✅ `event-handlers.ts`: 1,087 → 82 lines (dispatcher) + 6 focused modules
- ✅ `SessionState`: 11 sub-state files created, re-exported via `session-state.ts`
- ✅ **All 20 `as any` casts eliminated** via `typed-helpers.ts`
- ✅ **SQLite failure alert path added** (5-failure threshold)
- ✅ **shared.ts split** into 4 focused modules + barrel
- ✅ **3 config presets added** (conservative/balanced/aggressive)
- ✅ **Sync script extracted** to `scripts/sync.js`
- ✅ **DEP0147 warning eliminated**
- 🔴 Remaining: 7 open items (guard handleEvent, ESLint, README split, etc.)

---

## ✅ Health Check

| Check | Result |
|-------|--------|
| TypeScript | ✅ Clean (`strict: true`) |
| Tests | ✅ **773/773 passing** (18 files, ~3s) |
| Build | ✅ Clean (`npm run build`) |
| Runtime deps | ✅ Zero (peer: `@opencode-ai/plugin` only) |
| `as any` casts | ✅ **0** in production code |
| SQLite failure alerts | ✅ **Yes** (5-failure threshold) |
| Config presets | ✅ **3** (conservative/balanced/aggressive) |
| DEP0147 warnings | ✅ **0** |
| Sync script | ✅ Extracted to `scripts/sync.js` |

---

## 📈 Metrics

| Metric | Before | After | Δ |
|--------|--------|-------|---|
| Source files | 19 | **44** | +25 (11 sub-states + 6 handlers + 4 shared splits + presets + sync script) |
| Source LOC | 6,330 | **7,050** | +720 |
| Largest source file | shared.ts (516) | **shared.ts (285)** | -231 lines |
| `event-handlers.ts` | 1,087 | **82** | -1,005 lines (→ dispatcher) |
| `session-state.ts` | 298 | **323** | +25 (re-exports, imports) |
| `as any` casts | 25 | **0** | -25 (eliminated) |
| Config presets | 0 | **3** | +conservative/balanced/aggressive |
| Sync script | inline 500+ chars | **scripts/sync.js** | extracted |
| DEP0147 warnings | 1 | **0** | eliminated |
| Test LOC | ~14,500 | ~14,500 | unchanged |
| Tests passing | 773 | 773 | stable |

---

## 🔴 Critical Issues (2)

### 1. ✅ FIXED — `as any` casts eliminated via `typed-helpers.ts`

All 20 `as any` casts eliminated. See `src/typed-helpers.ts` for typed helper functions:

- `safeUnref()` — calls `.unref()` on Node.js timers without `as any`
- `getErrorName()` / `getResponseError()` / `isMessageAbortedError()` — typed error inspection
- `getMessageRole()` / `getMessageParts()` — typed message shape accessors
- `hasDollarMethod()` / `getHttpClient()` — typed plugin input accessors
- `createPromptGuardLogger()` — type-compatible log wrapper for `shouldBlockPrompt`


The remaining 3 matches in grep output are **comments** referencing `as any` in typed-helpers.ts and config.ts (self-referential documentation).

### 2. ✅ FIXED — 5 silent SQLite failures in `tokens.ts`

Added `consecutiveFailures` counter and `recordSqliteFailure()` + `recordSqliteSuccess()` helpers. After 5 consecutive failures, a one-time `console.warn` is emitted with an actionable message. Counter resets on success but NOT on "session not found" (normal misses). Also replaced 3× `catch (e: any)` with `catch (e: unknown)` + typed error access, and fixed idle timer unref to use `safeUnref()`.

### 3. ✅ FIXED — `shared.ts` is still a grab-bag

Split 516-line `shared.ts` into 4 focused modules + barrel:
- `src/utils.ts` — formatDuration, estimateTokens, parseTokensFromError, formatMessage, updateProgress, getMessageText
- `src/plan-detection.ts` — PLAN_PATTERNS, TOOL_TEXT_PATTERNS, TRUNCATED_XML_PATTERNS, isPlanContent, containsToolCallAsText, isSessionPlanning, estimateIsPlan
- `src/prompt-guard.ts` — shouldBlockPrompt, clearMessagesCache, getMessageTimestamp, hasSimilarPrompt, fetchRecentMessages
- `src/presets.ts` — PluginPresets type, conservative/balanced/aggressive presets, getPreset(), DEFAULT_PRESET
- `src/shared.ts` (285 lines) — barrel re-export + model limit cache + safeHook + scheduleRecoveryWithGeneration

All `import from "./shared.js"` calls work unchanged (backward compat barrel). All 773 tests pass.

### 4. ✅ FIXED — No config presets

`preset?: PresetName` added to `PluginConfig`. Three presets available: `conservative`, `balanced` (default), `aggressive`. Preset applied in `index.ts` before `validateConfig()`; explicit config values override preset values. See `src/presets.ts`.

### 5. DEP0147 deprecation warning (fs.rmdir)

`terminal-status-notifications.test.ts` used deprecated `rmdirSync(dir,{recursive:true})`. Replaced with `rmSync(dir,{recursive:true,force:true})`. DEP0147 warning eliminated.

### 6. Extracted `sync` script

500+ char inline script extracted to `scripts/sync.js` (150 lines, well-documented). `package.json` now references `node scripts/sync.js`. Fixed missing comma in `package.json`.

### 7. Guard handleEvent against post-disposal

**TODO** — `isDisposed` flag exists but `handleEvent` doesn't check it before routing.

### 8. Add ESLint + Prettier

**TODO** — `lint` script just runs `tsc --noEmit`. ESLint would catch unused vars, dead code, etc.

### 9. Split README

**TODO** — 1,389 lines / 94 headings too large. Create `docs/architecture.md`, `docs/configuration.md`, `docs/troubleshooting.md`.

### 10. Split plugin.test.ts

**TODO** — 3,720-line mega test file. Split along handler module boundaries.

### 11. Empty Roadmap section

**TODO** — README "Roadmap" section is empty. Link to `todo.md` or remove.

### 12. Migrate modules to use sub-state types

**TODO** — 11 sub-state files exist but no module imports them yet. Start with `compaction.ts` → `CompactionState`.

### 13. Encapsulate module state — accessor methods

**TODO** — 14 modules directly read/write `sessions.get(sid).fieldName`. Should use accessor methods instead.

### 5. Sub-state files exist but are not used by any module

All 11 sub-state files (`*-state.ts`) were created with interfaces and factory functions, but **no module imports them**. Every module still imports `SessionState` from `session-state.ts`. The sub-states are currently documentation-only.

**Assessment**: This is fine as a first step — the sub-interfaces provide type-level documentation. The real benefit comes when modules switch to `CompactionState` instead of `SessionState` for their dependencies, but that requires changing function signatures across the codebase.

**Next step**: Gradually migrate modules to accept sub-state types. Start with `compaction.ts` (only uses CompactionState fields) → accept `CompactionState` instead of `SessionState`.

### 6. `sync` script is 500+ char one-liner in package.json

The `sync` script manages symlinks and plugin installation — all in a single escaped string. Untestable and unreadable.

**Proposal**: Extract to `scripts/sync.js`.

### 7. 14 modules directly access shared mutable state

Every module takes `sessions: Map<string, SessionState>` and reads/writes fields directly. No module encapsulates its own state.

| Module | `sessions.get()` calls |
|--------|----------------------|
| session-handlers.ts | 9 |
| nudge.ts | 9 |
| compaction.ts | 7 |
| message-handlers.ts | 6 |
| index.ts | 6 |

**Proposal**: Each module should expose accessor methods. Depends on sub-state migration (#5).

---

## 🟢 Low Issues / Polish (7)

| # | Issue | Effort |
|---|-------|--------|
| 8 | `plugin.test.ts` is 3,720 lines — only mega test file | Medium |
| 9 | No ESLint/Prettier — `lint` just runs `tsc --noEmit` | Small |
| 10 | README 1,389 lines / 94 headings — needs docs/ split | Small |
| 11 | `DEP0147` Node.js warning: `fs.rmdir` → `fs.rm` | Trivial |
| 12 | `handleEvent` doesn't check `isDisposed()` before routing | Trivial |
| 13 | Empty README "Roadmap" section | Trivial |
| 14 | `process.stdout` direct writes in `terminal.ts` | Small |

---

## 📁 File Organization (current)

### Handler modules (new)
```
event-handlers.ts      82  ← dispatcher only
session-handlers.ts   474  ← session.* handlers
message-handlers.ts   417  ← message.* handlers
system-transform.ts   103  ← experimental.* hooks
question-handlers.ts   79  ← question.asked
handler-context.ts     46  ← HandlerContext interface
todo-handlers.ts       21  ← todo.updated
```

### Sub-state modules (new)
```
recovery-state.ts      63  ← 21 fields
compaction-state.ts    42  ← 16 fields  
nudge-state.ts         42  ← 11 fields + Todo type
continue-state.ts      22  ← 6 fields
output-tracking-state  20  ← 5 fields
message-tracking-state 20  ← 5 fields
review-state.ts        20  ← 5 fields
planning-state.ts      17  ← 3 fields
timer-state.ts         16  ← 3 fields
test-state.ts          15  ← 2 fields
danger-command-state   15  ← 2 fields
```

### Core modules (unchanged)
```
shared.ts             516  ← still the largest file (grab-bag)
nudge.ts             465  ← most `as any` casts (8)
recovery.ts          438
index.ts             437  ← module wiring
config.ts            409
compaction.ts        355
review.ts            324  ← 2 `as any` casts
session-state.ts     323  ← re-exports sub-states
tokens.ts            286  ← 5 silent catches
test-runner.ts       269
types.ts             257  ← 26 exports
session-monitor.ts   247
status-file.ts       237
todo-poller.ts       224
terminal.ts          104
dangerous-commands.ts 78
stop-conditions.ts    75
todo-md-reader.ts     70
```

---

## 🎯 Priority Roadmap (Updated)

| # | Priority | Item | Status | Effort |
|---|----------|------|--------|--------|
| 1 | 🔴 | Split `event-handlers.ts` | ✅ DONE | — |
| 2 | 🔴 | Decompose `SessionState` | ✅ DONE | — |
| 3 | 🔴 | Eliminate `as any` casts (20) | ✅ DONE | Medium |
| 4 | 🔴 | Add alert path for SQLite failures | 🟡 Remaining | Small |
| 5 | 🟡 | Split `shared.ts` into focused modules | 🟡 Remaining | Medium |
| 6 | 🟡 | Add config presets | 🟡 Remaining | Small |
| 7 | 🟡 | Migrate modules to sub-state types | 🟡 Remaining | Large |
| 8 | 🟡 | Extract `sync` script | 🟡 Remaining | Small |
| 9 | 🟡 | Module state encapsulation | 🟡 Remaining | Large |
| 10 | 🟢 | Split `plugin.test.ts` | 🟡 Remaining | Medium |
| 11 | 🟢 | Add ESLint + Prettier | 🟡 Remaining | Small |
| 12 | 🟢 | Split README into docs/ | 🟡 Remaining | Small |
| 13 | 🟢 | Fix DEP0147 warning | 🟡 Remaining | Trivial |
| 14 | 🟢 | Guard `handleEvent` against post-disposal | 🟡 Remaining | Trivial |
| 15 | 🟢 | Empty Roadmap section | 🟡 Remaining | Trivial |

### Recommended next actions (ordered by impact × ease):

1. **SQLite failure alert** — 5 empty catches, add failure counter + toast (small effort, high impact)
2. **Split `shared.ts`** — grab-bag is the biggest remaining organizational issue (medium effort, medium impact)
3. **Config presets** — biggest user-facing improvement (small effort, medium impact)
4. **Migrate modules to sub-state types** — first candidate: `compaction.ts` → `CompactionState`
5. **Module state encapsulation** — accessor methods instead of direct field access

---

*End of review. Three major refactors completed. Remaining debt is silent failures (tokens.ts), organizational (shared.ts grab-bag, sub-states unused).*
