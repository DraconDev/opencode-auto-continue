// Ambient module declarations for optional SQLite backends.
// These exist so TypeScript can resolve dynamic import() expressions in tokens.ts.
// At runtime, the actual modules may or may not be available.

declare module "bun:sqlite" {
  const Database: new (path: string, options?: { readonly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
    close(): void;
  };
  export { Database };
}

declare module "node:sqlite" {
  const DatabaseSync: new (path: string, options?: { open?: boolean; readonly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
    close(): void;
  };
  export { DatabaseSync };
}
