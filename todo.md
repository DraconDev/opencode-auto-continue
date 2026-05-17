# TODO — opencode-auto-continue

Based on project review (v7.19.31, 773 tests passing). See `REVIEW.md` for full analysis.

## 🔴 High Priority

- [x] ~~**Split `event-handlers.ts` into focused handler modules**~~ ✅ DONE
  - Split 1,087-line `event-handlers.ts` into: `session-handlers.ts` (474), `message-handlers.ts` (417), `handler-context.ts` (46), `system-transform.ts` (103), `todo-handlers.ts` (21), `question-handlers.ts` (79), `event-handlers.ts` (82-line dispatcher)
  - All 773 tests pass, TypeScript clean, build passes

- [x] ~~**Decompose `SessionState` monolith (166 fields)**~~ ✅ DONE
  - Extracted 11 sub-state files: `TimerState`, `RecoveryState`, `CompactionState`, `PlanningState`, `NudgeState`, `ContinueState`, `ReviewState`, `OutputTrackingState`, `MessageTrackingState`, `TestState`, `DangerCommandState`
  - Each sub-state has its own factory function (`createXxxDefaults()`)
  - `SessionState` still flat interface (zero breaking changes), re-exports all sub-states
  - Added `SESSION_TIMER_FIELDS` const — eliminated 5 `as any` casts in `clearAllSessionTimers()`
  - **Note**: Sub-states not yet imported by any module — currently documentation-only

- [x] ~~**Eliminate `as any` casts (20 remaining)**~~ ✅ DONE
  - Created `src/typed-helpers.ts` with typed helpers:
    - `safeUnref()` — 7 timer unref calls (nudge.ts, review.ts, session-handlers.ts, shared.ts)
    - `getErrorName()` / `getResponseError()` / `isMessageAbortedError()` — nudge.ts error inspection
    - `getMessageRole()` / `getMessageParts()` — recovery.ts, shared.ts message shape accessors
    - `hasDollarMethod()` / `getHttpClient()` — test-runner.ts, question-handlers.ts
    - `createPromptGuardLogger()` — nudge.ts prompt guard log
  - Added `assignConfigKey()` in config.ts for typed config key assignment (1 cast)
  - **Zero remaining `as any` casts** in production source code (3 matches are self-referential comments)

- [x] ~~**Add alert path for persistent SQLite failures in `tokens.ts`**~~ ✅ DONE
  - Added `consecutiveFailures` counter (resets on success; NOT incremented on "session not found")
  - Added `recordSqliteFailure(reason: string)` + `recordSqliteSuccess()` helpers
  - After 5 consecutive failures: one-time `console.warn` with actionable message
  - Replaced 3× `catch (e: any)` → `catch (e: unknown)` + typed `instanceof Error` access
  - Fixed idle timer unref in `resetIdleTimer()`: `safeUnref(cachedDb.idleTimer)` (was `if (timer.unref) timer.unref()`)

## 🟡 Medium Priority

- [x] ~~**Split `shared.ts` (516 lines, 22 exports) into focused modules**~~ ✅ DONE
  - `src/utils.ts` (185 lines) — `formatDuration`, `estimateTokens`, `parseTokensFromError` (3-pattern version), `formatMessage`, `updateProgress`, `getMessageText`
  - `src/plan-detection.ts` (106 lines) — `PLAN_PATTERNS`, `TOOL_TEXT_PATTERNS` (XML-style), `TRUNCATED_XML_PATTERNS`, `isPlanContent`, `containsToolCallAsText`, `isSessionPlanning`, `estimateIsPlan`
  - `src/prompt-guard.ts` (145 lines) — `shouldBlockPrompt`, `clearMessagesCache`, `getMessageTimestamp`, `hasSimilarPrompt`, `fetchRecentMessages`
  - `src/shared.ts` (285 lines) — barrel re-export + model limit cache + `safeHook` + `scheduleRecoveryWithGeneration` + `todoMdInstruction` + `getCompactionThreshold`
  - `src/presets.ts` (67 lines) — `PluginPresets` type, `conservative`/`balanced`/`aggressive` presets, `getPreset()`, `DEFAULT_PRESET`
  - All imports from `./shared.js` still work (backward compat barrel)
  - Tests: 773/773 passing, TypeScript clean

- [x] ~~**Add config presets for common use cases**~~ ✅ DONE
  - `preset: "conservative"` / `"balanced"` / `"aggressive"` in `PluginConfig`
  - Preset applied in `index.ts` before `validateConfig()` — explicit config overrides preset values
  - 3 presets with distinct stall timeouts, recovery limits, compaction aggressiveness

- [ ] **Migrate modules to use sub-state types (currently unused)**
  - 11 sub-state files exist but no module imports them yet
  - Start with `compaction.ts` → accept `CompactionState` instead of full `SessionState`
  - Gradual migration: `nudge.ts` → `NudgeState`, `review.ts` → `ReviewState`, etc.

- [x] ~~**Extract `sync` script from `package.json` into `scripts/sync.js`**~~ ✅ DONE
  - Extracted 500+ char one-liner into `scripts/sync.js` (150 lines, well-documented)
  - Fixed DEP0147: replaced `fs.rmSync(plugDir,{recursive:true})` with `fs.rmSync(plugDir,{recursive:true,force:true})`
  - `package.json` now references `node scripts/sync.js`

- [x] ~~**Fix Node.js deprecation warning (`fs.rmdir` → `fs.rm`)**~~ ✅ DONE
  - `terminal-status-notifications.test.ts`: replaced `rmdirSync(dir,{recursive:true})` with `rmSync(dir,{recursive:true,force:true})`
  - DEP0147 warning eliminated

- [ ] **Encapsulate module state — accessor methods instead of direct field access**
  - 14 modules directly read/write `sessions.get(sid).fieldName`
  - Each module should expose accessors: `compaction.isCompacting(sid)`, `nudge.getLastNudgeAt(sid)`
  - Depends on sub-state migration

## 🟢 Low Priority / Polish

- [ ] **Split `plugin.test.ts` (3,720 lines) into focused test files**
  - ⚠️ Attempted in iteration 3 — too complex due to nested describes and shared setup state
  - Requires careful dependency analysis between test sections
  - Only mega test file; others are well-structured per module
  - Split along module boundaries: `session-handler.test.ts`, `message-handler.test.ts`, etc.

- [x] ~~**Add ESLint + Prettier**~~ ✅ DONE
  - Current `lint` script just runs `tsc --noEmit`
  - ESLint catches `as any` casts, unused vars, etc.
  - Prettier for consistent formatting

- [x] ~~**Split README into `docs/` subfiles**~~ ✅ DONE
  - 1,389 lines / 94 headings — too large for single file
  - Create `docs/architecture.md`, `docs/configuration.md`, `docs/troubleshooting.md`

- [x] ~~**Guard event handlers against post-disposal execution**~~ ✅ DONE

- [x] ~~**Fix Node.js deprecation warning (`fs.rmdir` → `fs.rm`)**~~ ✅ DONE
  - Test run emits `DEP0147` — find and replace

- [ ] **Update README "Roadmap" section**
  - Currently empty — link to `todo.md` or remove

- [ ] **Review `process.stdout` direct writes in `terminal.ts`**
  - Terminal title/progress writes directly to stdout
  - May cause issues in non-TTY plugin contexts
