# Type Safety Patterns & Error Handling Conventions

## Overview

This document describes the type safety patterns and error handling conventions used in the opencode-auto-continue codebase. Following these patterns ensures maintainability, prevents runtime errors, and makes the code easier to understand.

## Type Safety Patterns

### 1. No `any` Types

**Rule:** Never use `any`. Use `unknown` for values of uncertain type.

**Rationale:** `any` disables TypeScript's type checking entirely. `unknown` forces you to validate the type before using it.

**Example:**
```typescript
// ❌ Bad - disables type checking
function handleError(error: any) {
  console.log(error.message); // Could crash at runtime
}

// ✅ Good - forces type validation
function handleError(error: unknown) {
  if (error instanceof Error) {
    console.log(error.message);
  } else {
    console.log(String(error));
  }
}
```

### 2. Type Guards for Runtime Validation

**Pattern:** Use type guards when dealing with external data (API responses, user input, parsed JSON).

**Example:**
```typescript
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
```

### 3. Explicit Return Types on Exported Functions

**Rule:** Always declare explicit return types on exported functions.

**Rationale:** Makes the public API clear and catches accidental return type changes.

**Example:**
```typescript
// ✅ Good
export function calculateBackoff(attempts: number): number {
  return Math.min(1000 * Math.pow(2, attempts), 30000);
}

// ❌ Bad - return type inferred
export function calculateBackoff(attempts: number) {
  return Math.min(1000 * Math.pow(2, attempts), 30000);
}
```

### 4. Interface Segregation

**Pattern:** Keep interfaces focused and small. Extract shared types into dedicated modules.

**Modules:**
- `config.ts` - `PluginConfig` and related config types
- `session-state.ts` - `SessionState`, `Todo`, and session-related types
- `autonomy-types.ts` - Autonomous core types (for v7.0 features)
- `types.ts` - `TypedPluginInput` and plugin SDK types

### 5. Import Organization

**Pattern:** Organize imports in this order:
1. External modules (e.g., `fs`, `path`)
2. Type-only imports (`import type { ... }`)
3. Value imports from local modules
4. Side-effect imports (rare)

**Example:**
```typescript
import { existsSync, readFileSync } from "fs";
import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { formatDuration, safeHook } from "./shared.js";
```

## Error Handling Conventions

### 1. safeHook Pattern

**Pattern:** Wrap all event handlers with `safeHook()` to prevent plugin crashes from affecting the host.

**Usage:**
```typescript
await safeHook("event", async () => {
  // Event handling logic
  await handleEvent(event);
}, log);
```

**Behavior:**
- Catches all errors in the handler
- Logs errors via the provided log function
- Never propagates errors to the caller
- Always returns gracefully

### 2. Fail-Open Design

**Pattern:** When in doubt, allow the operation to proceed rather than blocking it.

**Examples:**
- Prompt guard: If check fails, allow the prompt (don't block)
- Compaction: If summarize fails, log and continue
- Status file: If write fails, silently ignore

### 3. Async Error Handling

**Pattern:** Always handle promise rejections, especially for fire-and-forget operations.

**Example:**
```typescript
// ✅ Good - handles rejection
compaction.forceCompact(sid).then((compacted) => {
  if (compacted) {
    log('compaction succeeded');
  }
}).catch((e) => {
  log('compaction error:', e);
});

// ❌ Bad - unhandled rejection
compaction.forceCompact(sid).then((compacted) => {
  if (compacted) {
    log('compaction succeeded');
  }
});
```

### 4. Error Logging

**Rule:** Log all errors with context. Never silently swallow errors.

**Pattern:**
```typescript
try {
  await riskyOperation();
} catch (e) {
  log('riskyOperation failed:', e);
  // Handle or propagate as needed
}
```

### 5. No console.* in Production

**Rule:** Never use `console.log`, `console.error`, etc. Use the configurable `log` function.

**Rationale:** Console output breaks TUI applications. The `log` function respects the `debug` config flag.

### 6. Type-Safe Error Parsing

**Pattern:** Parse error details safely without assuming structure.

**Example:**
```typescript
function isTokenLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    return config.tokenLimitPatterns.some(pattern =>
      pattern.test(error.message)
    );
  }
  return false;
}
```

## Module Structure

### File Organization

Each module follows this structure:
1. **Imports** - External, then types, then utilities
2. **Types/Interfaces** - Module-specific types (if not in dedicated type modules)
3. **Factory Function** - `createXxxModule(deps)` pattern
4. **Internal Functions** - Helper functions
5. **Exports** - Main function and any standalone exports

### Example Module Structure

```typescript
// 1. Imports
import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { safeHook } from "./shared.js";

// 2. Types
export interface XxxDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
}

// 3. Factory Function
export function createXxxModule(deps: XxxDeps) {
  const { config, sessions, log } = deps;
  
  // 4. Internal Functions
  function helper() {
    // ...
  }
  
  // 5. Public Methods
  function doSomething() {
    // ...
  }
  
  return { doSomething };
}
```

## Testing Patterns

### Type-Safe Mocks

**Pattern:** Use Vitest's `vi.fn()` with proper return types.

**Example:**
```typescript
const mockAbort = vi.fn<[], Promise<{ data: boolean }>>()
  .mockResolvedValue({ data: true });
```

### Testing Error Paths

**Pattern:** Always test error handling paths.

**Example:**
```typescript
it("should handle abort failure gracefully", async () => {
  mockAbort.mockRejectedValue(new Error("abort failed"));
  // Should not throw
  await expect(plugin.event({...})).resolves.not.toThrow();
});
```

## Migration Notes

### From `any` to `unknown`

1. Change parameter type from `any` to `unknown`
2. Add type guards before accessing properties
3. Use `instanceof` checks for Error types
4. Use type assertion functions (`isXxx`) for complex types

### From Inline Types to Dedicated Modules

1. Extract interfaces to appropriate type module (`config.ts`, `session-state.ts`)
2. Update imports in all consuming files
3. Add re-exports in `shared.ts` for backward compatibility
4. Verify build passes

## Checklist

Before committing code, verify:
- [ ] No `any` types (use `unknown`)
- [ ] No `console.*` calls (use `log`)
- [ ] All exported functions have explicit return types
- [ ] Error handlers don't swallow errors silently
- [ ] Async operations handle rejections
- [ ] safeHook wraps all event handlers
- [ ] Build passes with `strict: true`
- [ ] All tests pass
