import { readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { Todo } from "./session-state.js";

export interface TodoMdResult {
  pending: string[];
  completed: string[];
}

const TASK_RE = /^\s*[-*]\s*\[([ xX.-])\]\s*(.+?)\s*$/;

export function parseTodoMd(content: string): TodoMdResult {
  const pending: string[] = [];
  const completed: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const m = line.match(TASK_RE);
    if (!m) continue;

    const marker = m[1].toLowerCase();
    const text = m[2].trim();

    if (marker === "x") {
      completed.push(text);
    } else {
      pending.push(text);
    }
  }

  return { pending, completed };
}

export interface TodoMdReaderDeps {
  todoMdPath: string;
  todoMdSync: boolean;
  log: (...args: unknown[]) => void;
  readFile?: (path: string) => Promise<string>;
}

export interface TodoMdReader {
  readAndParse: (directory: string, existingTodos?: Todo[]) => Promise<TodoMdResult | null>;
}

export function createTodoMdReader(deps: TodoMdReaderDeps): TodoMdReader {
  const { todoMdPath, log } = deps;
  const doRead = deps.readFile ?? ((p: string) => nodeReadFile(p, "utf-8"));

  async function readAndParse(directory: string, existingTodos?: Todo[]): Promise<TodoMdResult | null> {
    if (!todoMdPath || !deps.todoMdSync) return null;

    const fullPath = join(directory, todoMdPath);

    try {
      const content = await doRead(fullPath);
      const result = parseTodoMd(content);

      if (existingTodos && existingTodos.length > 0) {
        const existingTexts = new Set(
          existingTodos.map((t) => (t.content || t.title || "").toLowerCase().trim())
        );
        result.pending = result.pending.filter((task) => {
          const normalized = task.toLowerCase().trim();
          for (const existing of existingTexts) {
            if (existing === normalized) return false;
            if (existing.length > 10 && normalized.includes(existing.slice(0, -2))) return false;
            if (normalized.length > 10 && existing.includes(normalized.slice(0, -2))) return false;
          }
          return true;
        });
      }

      log("todo.md read result", {
        path: fullPath,
        pending: result.pending.length,
        completed: result.completed.length,
        deduped: existingTodos ? "yes" : "no",
      });

      return result;
    } catch (e) {
      log("todo.md read error:", String(e));
      return null;
    }
  }

  return { readAndParse };
}
