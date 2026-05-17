import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseTodoMd, readTodoMdFromFile, createTodoMdReader } from "../todo-md-reader.js";

describe("parseTodoMd", () => {
  it("parses pending tasks with - [ ] syntax", () => {
    const content = "# TODO\n\n- [ ] Fix bug\n- [ ] Add feature\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Fix bug", "Add feature"]);
    expect(result.completed).toEqual([]);
  });

  it("parses pending tasks with * [ ] syntax", () => {
    const content = "* [ ] Write tests\n* [ ] Ship it\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Write tests", "Ship it"]);
  });

  it("parses completed tasks with - [x] syntax", () => {
    const content = "- [x] Done thing\n- [X] Another done\n";
    const result = parseTodoMd(content);
    expect(result.completed).toEqual(["Done thing", "Another done"]);
    expect(result.pending).toEqual([]);
  });

  it("parses mixed pending and completed tasks", () => {
    const content = "- [x] Done\n- [ ] Pending\n- [x] Also done\n- [ ] Also pending\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Pending", "Also pending"]);
    expect(result.completed).toEqual(["Done", "Also done"]);
  });

  it("trims whitespace from task text", () => {
    const content = "- [ ]   Spaced task  \n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Spaced task"]);
  });

  it("ignores non-task list items", () => {
    const content = "- Regular item\n- [ ] Real task\n- Another regular\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Real task"]);
  });

  it("ignores headings and other markdown", () => {
    const content = "# Heading\n\nSome paragraph text\n\n- [ ] Actual task\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Actual task"]);
  });

  it("returns empty arrays for empty content", () => {
    const result = parseTodoMd("");
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);
  });

  it("returns empty arrays for content with no tasks", () => {
    const result = parseTodoMd("# Just a heading\n\nSome text\n");
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);
  });

  it("treats non-standard markers as pending", () => {
    const content = "- [-] In progress\n- [.] Partial\n- [ ] Pending\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["In progress", "Partial", "Pending"]);
  });

  it("handles indented task lists", () => {
    const content = "  - [ ] Indented task\n    - [ ] Deeply indented\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Indented task", "Deeply indented"]);
  });

  it("handles CRLF line endings", () => {
    const content = "- [ ] Task one\r\n- [ ] Task two\r\n";
    const result = parseTodoMd(content);
    expect(result.pending).toEqual(["Task one", "Task two"]);
  });
});

describe("readTodoMdFromFile", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when path is empty", async () => {
    const result = await readTodoMdFromFile("");
    expect(result).toBeNull();
  });

  it("returns null when path is whitespace", async () => {
    const result = await readTodoMdFromFile("  ");
    expect(result).toBeNull();
  });
});

describe("createTodoMdReader", () => {
  it("returns null when todoMdPath is empty", async () => {
    const reader = createTodoMdReader({ todoMdPath: "", todoMdSync: true, log: vi.fn() });
    const result = await reader.readAndParse("/project");
    expect(result).toBeNull();
  });

  it("returns null when todoMdSync is false", async () => {
    const reader = createTodoMdReader({ todoMdPath: "TODO.md", todoMdSync: false, log: vi.fn() });
    const result = await reader.readAndParse("/project");
    expect(result).toBeNull();
  });

  it("returns parsed tasks when file exists", async () => {
    const reader = createTodoMdReader({
      todoMdPath: "TODO.md",
      todoMdSync: true,
      log: vi.fn(),
      readFile: async () => "- [ ] Fix bug\n- [x] Done\n",
    });
    const result = await reader.readAndParse("/project");

    expect(result).not.toBeNull();
    expect(result!.pending).toEqual(["Fix bug"]);
    expect(result!.completed).toEqual(["Done"]);
  });

  it("returns null on read error", async () => {
    const log = vi.fn();
    const reader = createTodoMdReader({
      todoMdPath: "TODO.md",
      todoMdSync: true,
      log,
      readFile: async () => { throw new Error("ENOENT"); },
    });
    const result = await reader.readAndParse("/project");

    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("todo.md read error"), expect.any(String));
  });

  it("deduplicates against existing TodoWrite items by exact match", async () => {
    const reader = createTodoMdReader({
      todoMdPath: "TODO.md",
      todoMdSync: true,
      log: vi.fn(),
      readFile: async () => "- [ ] Fix bug\n- [ ] New feature\n- [x] Done\n",
    });
    const existingTodos = [
      { id: "1", content: "Fix bug", title: "Fix bug", status: "pending" },
      { id: "2", content: "Some other task", title: "Some other task", status: "in_progress" },
    ];
    const result = await reader.readAndParse("/project", existingTodos);

    expect(result).not.toBeNull();
    expect(result!.pending).toEqual(["New feature"]);
  });

  it("deduplicates with fuzzy prefix matching for long tasks", async () => {
    const reader = createTodoMdReader({
      todoMdPath: "TODO.md",
      todoMdSync: true,
      log: vi.fn(),
      readFile: async () => "- [ ] Implement the new authentication module\n- [ ] Write integration tests for auth\n- [ ] Unrelated new task\n",
    });
    const existingTodos = [
      { id: "1", content: "Implement the new authentication module with OAuth2", title: "Implement the new authentication module with OAuth2", status: "in_progress" },
      { id: "2", content: "Write integration tests for authentication", title: "Write integration tests for authentication", status: "pending" },
    ];
    const result = await reader.readAndParse("/project", existingTodos);

    expect(result).not.toBeNull();
    expect(result!.pending).toEqual(["Unrelated new task"]);
  });

  it("returns all pending when no existing todos provided", async () => {
    const reader = createTodoMdReader({
      todoMdPath: "TODO.md",
      todoMdSync: true,
      log: vi.fn(),
      readFile: async () => "- [ ] Task A\n- [ ] Task B\n- [x] Task C\n",
    });
    const result = await reader.readAndParse("/project");

    expect(result).not.toBeNull();
    expect(result!.pending).toEqual(["Task A", "Task B"]);
    expect(result!.completed).toEqual(["Task C"]);
  });
});
