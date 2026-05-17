import { readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { Todo } from "./session-state.js";

interface TodoMdResult {
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

interface TodoMdReaderDeps {
  todoMdPath: string;
  log: (...args: unknown[]) => void;
  readFile?: (path: string) => Promise<string>;
}

export interface TodoMdReader {
  readAndParse: (directory: string) => Promise<TodoMdResult | null>;
}

export function createTodoMdReader(deps: TodoMdReaderDeps): TodoMdReader {
  const { todoMdPath, log } = deps;
  const doRead = deps.readFile ?? ((p: string) => nodeReadFile(p, "utf-8"));

  async function readAndParse(directory: string): Promise<TodoMdResult | null> {
    if (!todoMdPath) return null;

    const fullPath = join(directory, todoMdPath);

    try {
      const content = await doRead(fullPath);
      const result = parseTodoMd(content);

      log("todo.md read result", {
        path: fullPath,
        pending: result.pending.length,
        completed: result.completed.length,
      });

      return result;
    } catch (e) {
      log("todo.md read error:", String(e));
      return null;
    }
  }

  return { readAndParse };
}
