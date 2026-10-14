/**
 * Tool tests.
 *
 * Half of these are adversarial: a coding agent's file tools are the difference
 * between "edits my project" and "edits my machine", so the boundary cases matter
 * more than the happy path. Each workspace is a fresh temp directory.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { resolveWithinWorkspace } from "../src/tools/paths.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { writeTool } from "../src/tools/write.ts";

const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-ws-"));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const signal = new AbortController().signal;

function run<I>(tool: ToolDefinition<I>, input: I, cwd: string) {
  return tool.execute(input, { cwd, signal });
}

describe("workspace boundary", () => {
  it("rejects lexical escapes", async () => {
    const cwd = await makeWorkspace();
    await expect(run(readTool, { path: "../outside.txt" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
    await expect(run(writeTool, { path: "../evil.txt", content: "x" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });

  it("rejects absolute paths outside the workspace", async () => {
    const cwd = await makeWorkspace();
    await expect(run(readTool, { path: "/etc/hosts" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });

  it("rejects a path that escapes through a symlink", async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret", "utf8");
    await fs.symlink(outside, path.join(cwd, "escape"), "dir");

    // Lexically inside the workspace, but really outside it.
    await expect(run(readTool, { path: "escape/secret.txt" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });

  it("allows the workspace root itself and nested paths", async () => {
    const cwd = await makeWorkspace();
    expect(resolveWithinWorkspace(cwd, ".")).toBe(path.resolve(cwd));
    expect(resolveWithinWorkspace(cwd, "a/b/c.txt")).toBe(path.resolve(cwd, "a/b/c.txt"));
  });

  it("does not confuse a sibling sharing a path prefix with the workspace", async () => {
    const cwd = await makeWorkspace();
    // `/ws/x` vs `/ws/x-other`: a naive startsWith() check treats the sibling as
    // inside. path.relative does not.
    expect(() => resolveWithinWorkspace(cwd, `../${path.basename(cwd)}-other/x`)).toThrow(
      /escapes the workspace/,
    );
  });

  it("rejects NUL bytes in a path", async () => {
    const cwd = await makeWorkspace();
    expect(() => resolveWithinWorkspace(cwd, "a\0b")).toThrow(/NUL/);
  });
});

describe("read", () => {
  it("returns numbered lines and reports totals", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha\nbravo\ncharlie", "utf8");

    const result = await run(readTool, { path: "a.txt" }, cwd);

    expect(result.content).toBe("1  alpha\n2  bravo\n3  charlie");
    expect(result.details).toMatchObject({ totalLines: 3, returnedLines: 3, truncated: false });
  });

  it("honours offset and limit, and says how much is left", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.txt"), "1\n2\n3\n4\n5", "utf8");

    const result = await run(readTool, { path: "a.txt", offset: 2, limit: 2 }, cwd);

    expect(result.content).toContain("2  2");
    expect(result.content).toContain("3  3");
    expect(result.content).toContain("2 more lines");
  });

  it("reports a missing file as invalid_tool rather than crashing", async () => {
    const cwd = await makeWorkspace();
    await expect(run(readTool, { path: "nope.txt" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });
});

describe("write", () => {
  it("creates parent directories and distinguishes create from overwrite", async () => {
    const cwd = await makeWorkspace();

    const created = await run(writeTool, { path: "deep/nested/a.txt", content: "hello" }, cwd);
    expect(created.content).toContain("Created");
    expect(created.details).toMatchObject({ created: true, bytes: 5 });

    const overwritten = await run(writeTool, { path: "deep/nested/a.txt", content: "hi" }, cwd);
    expect(overwritten.content).toContain("Overwrote");
    expect(overwritten.details).toMatchObject({ created: false });
  });
});

describe("edit", () => {
  it("replaces a unique occurrence", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.ts"), "return a - b;\n", "utf8");

    const result = await run(
      editTool,
      { path: "a.ts", oldString: "a - b", newString: "a + b" },
      cwd,
    );

    expect(result.content).toContain("Replaced 1 occurrence");
    expect(await fs.readFile(path.join(cwd, "a.ts"), "utf8")).toBe("return a + b;\n");
  });

  it("refuses an ambiguous match instead of guessing", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.ts"), "foo\nfoo\n", "utf8");

    await expect(
      run(editTool, { path: "a.ts", oldString: "foo", newString: "bar" }, cwd),
    ).rejects.toMatchObject({ code: "invalid_tool" });

    // The file must be untouched after a refusal.
    expect(await fs.readFile(path.join(cwd, "a.ts"), "utf8")).toBe("foo\nfoo\n");
  });

  it("replaces every occurrence when replaceAll is set", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.ts"), "foo\nfoo\n", "utf8");

    const result = await run(
      editTool,
      { path: "a.ts", oldString: "foo", newString: "bar", replaceAll: true },
      cwd,
    );

    expect(result.content).toContain("Replaced 2 occurrence");
    expect(await fs.readFile(path.join(cwd, "a.ts"), "utf8")).toBe("bar\nbar\n");
  });

  it("reports a missing target string as invalid_tool", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.ts"), "alpha\n", "utf8");

    await expect(
      run(editTool, { path: "a.ts", oldString: "omega", newString: "x" }, cwd),
    ).rejects.toMatchObject({ code: "invalid_tool" });
  });
});

describe("ls", () => {
  it("marks directories with a trailing slash and sorts by name", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "b.txt"), "", "utf8");
    await fs.writeFile(path.join(cwd, "a.txt"), "", "utf8");

    const result = await run(lsTool, {}, cwd);

    expect(result.content).toBe("a.txt\nb.txt\nsrc/");
    expect(result.details).toMatchObject({ count: 3, directories: 1 });
  });
});

describe("grep", () => {
  it("finds matches with file and line numbers", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.ts"), "const x = 1;\nconst y = 2;\n", "utf8");
    await fs.writeFile(path.join(cwd, "b.ts"), "let z = 2;\n", "utf8");

    const result = await run(grepTool, { pattern: "= 2" }, cwd);

    expect(result.content).toContain("a.ts:2:");
    expect(result.content).toContain("b.ts:1:");
  });

  it("skips dependency directories and binary files", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "dep.ts"), "needle\n", "utf8");
    await fs.writeFile(path.join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 110, 101, 101, 100]));
    await fs.writeFile(path.join(cwd, "real.ts"), "needle\n", "utf8");

    const result = await run(grepTool, { pattern: "needle" }, cwd);

    expect(result.content).toContain("real.ts:1:");
    expect(result.content).not.toContain("node_modules");
    expect(result.content).not.toContain("blob.bin");
  });

  it("rejects an invalid regular expression as invalid_tool", async () => {
    const cwd = await makeWorkspace();
    await expect(run(grepTool, { pattern: "([unclosed" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });
});

describe("bash", () => {
  it("captures stdout and a zero exit code", async () => {
    const cwd = await makeWorkspace();
    const result = await run(bashTool, { command: "echo hello" }, cwd);

    expect(result.content).toContain("exit code: 0");
    expect(result.content).toContain("hello");
  });

  it("reports a non-zero exit code as information, not as a tool failure", async () => {
    const cwd = await makeWorkspace();
    const result = await run(bashTool, { command: "exit 3" }, cwd);

    expect(result.content).toContain("exit code: 3");
    expect(result.details).toMatchObject({ exitCode: 3, timedOut: false });
  });

  it("runs in the workspace directory", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "marker.txt"), "", "utf8");
    const result = await run(bashTool, { command: "ls" }, cwd);

    expect(result.content).toContain("marker.txt");
  });

  it("reports a timeout instead of hanging", async () => {
    const cwd = await makeWorkspace();
    const result = await run(bashTool, { command: "sleep 5", timeoutMs: 300 }, cwd);

    expect(result.content).toContain("TIMED OUT");
    expect(result.details).toMatchObject({ timedOut: true });
  });

  it("rejects with AbortError when the run is cancelled", async () => {
    const cwd = await makeWorkspace();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    await expect(
      bashTool.execute(
        { command: "sleep 5" },
        { cwd, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("registry", () => {
  it("refuses an unknown tool name", async () => {
    const cwd = await makeWorkspace();
    const registry = createToolRegistry([readTool], { cwd });

    await expect(
      registry.execute({ name: "ghost", arguments: {} }, signal),
    ).rejects.toMatchObject({ code: "invalid_tool" });
  });

  it("refuses malformed arguments with a readable message", async () => {
    const cwd = await makeWorkspace();
    const registry = createToolRegistry([readTool], { cwd });

    await expect(
      registry.execute({ name: "read", arguments: { path: 42 } }, signal),
    ).rejects.toThrow(/invalid arguments for read/);
  });

  it("exposes exactly the tools it was given", async () => {
    const cwd = await makeWorkspace();
    const registry = createToolRegistry([readTool, lsTool], { cwd });
    expect(registry.names).toEqual(["read", "ls"]);
  });
});
