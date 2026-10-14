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
import { REGEX_TOTAL_BUDGET_MS, emptySearchMessage, grepTool } from "../src/tools/grep.ts";
import { walkFiles } from "../src/tools/walk.ts";
import { emptyFindMessage, findTool } from "../src/tools/find.ts";
import { lsTool } from "../src/tools/ls.ts";
import { resolveWithinWorkspace } from "../src/tools/paths.ts";
import { MAX_IN_MEMORY_BYTES, readTool } from "../src/tools/read.ts";
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

  it("refuses a binary file instead of pouring mojibake into the transcript", async () => {
    const cwd = await makeWorkspace();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...Array.from({ length: 256 }, (_unused, index) => index),
    ]);
    await fs.writeFile(path.join(cwd, "image.png"), png);

    // A NUL byte is the standard binary sniff. Decoding this as UTF-8 would produce
    // replacement characters that cost context and tell the model nothing.
    await expect(run(readTool, { path: "image.png" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });

  it("still reads a text file that merely contains non-ASCII characters", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "notes.md"), "# 中文标题\nemoji ✅\n", "utf8");

    const result = await run(readTool, { path: "notes.md" }, cwd);
    expect(result.content).toContain("中文标题");
    expect(result.content).toContain("✅");
  });

  it("streams a large file instead of loading it, and says the total is unknown", async () => {
    const cwd = await makeWorkspace();
    // Just over the in-memory threshold, so the streaming branch is the one taken.
    const line = `${"x".repeat(99)}\n`;
    const count = Math.ceil((MAX_IN_MEMORY_BYTES + 1024) / line.length);
    await fs.writeFile(path.join(cwd, "big.log"), line.repeat(count), "utf8");

    const result = await run(readTool, { path: "big.log", limit: 3 }, cwd);

    const details = result.details as { totalLines: unknown; truncated: boolean; note?: string };
    // Loading a multi-gigabyte file to count its lines is the failure this avoids.
    expect(details.totalLines).toBeNull();
    expect(details.truncated).toBe(true);
    expect(details.note).toContain("streamed");
    expect(result.content.split("\n").filter((l) => l.includes("xxx"))).toHaveLength(3);
  });

  it("honours offset when streaming a large file", async () => {
    const cwd = await makeWorkspace();
    const lines = Array.from({ length: 90_000 }, (_unused, index) => `line-${index}`).join("\n");
    await fs.writeFile(path.join(cwd, "big.txt"), `${lines}\n`, "utf8");

    const result = await run(readTool, { path: "big.txt", offset: 5, limit: 2 }, cwd);

    expect(result.content).toContain("5  line-4");
    expect(result.content).toContain("6  line-5");
    expect(result.content).not.toContain("line-6");
  });

  it("detects a binary file on the streaming path too", async () => {
    const cwd = await makeWorkspace();
    // Large enough to bypass the in-memory sniff, and containing a NUL byte.
    const chunk = Buffer.concat([Buffer.from("text"), Buffer.from([0])]);
    const repeats = Math.ceil((MAX_IN_MEMORY_BYTES + 1024) / chunk.length);
    await fs.writeFile(path.join(cwd, "big.bin"), Buffer.concat(Array(repeats).fill(chunk)));

    await expect(run(readTool, { path: "big.bin", limit: 5 }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });

  it("still reports an exact total for a file small enough to read whole", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "small.txt"), "a\nb\nc", "utf8");

    const result = await run(readTool, { path: "small.txt" }, cwd);
    expect(result.details).toMatchObject({ totalLines: 3, truncated: false });
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

describe("path-shape errors are actionable", () => {
  it("tells the model a directory is not a file when writing", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "src"));

    // read already says this clearly; write and edit used to leak a raw EISDIR.
    let failure: { code?: string; message?: string } | undefined;
    try {
      await run(writeTool, { path: "src", content: "x" }, cwd);
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }

    expect(failure?.code).toBe("invalid_tool");
    expect(failure?.message).toMatch(/directory/i);
  });

  it("tells the model a directory is not a file when editing", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "src"));

    await expect(
      run(editTool, { path: "src", oldString: "a", newString: "b" }, cwd),
    ).rejects.toMatchObject({ code: "invalid_tool" });
  });

  it("reports a file used as a directory rather than leaking ENOTDIR", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "blocker"), "not a directory", "utf8");

    await expect(
      run(writeTool, { path: "blocker/child.txt", content: "x" }, cwd),
    ).rejects.toMatchObject({ code: "invalid_tool" });
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

  it("can edit a CRLF file using the text read showed", async () => {
    const cwd = await makeWorkspace();
    // A file that came from a Windows checkout.
    await fs.writeFile(path.join(cwd, "win.ts"), "const a = 1;\r\nconst b = 2;\r\n", "utf8");

    const shown = await run(readTool, { path: "win.ts" }, cwd);
    expect(shown.content).toContain("const a = 1;");
    // read normalises for display, so the model only ever saw LF text.
    expect(shown.content).not.toContain("\r");

    // The model can only pass back what it was shown.
    const edited = await run(
      editTool,
      {
        path: "win.ts",
        oldString: "const a = 1;\nconst b = 2;",
        newString: "const a = 1;\nconst b = 3;",
      },
      cwd,
    );

    expect(edited.content).toContain("Replaced 1 occurrence");
    expect(edited.details).toMatchObject({ lineEndings: "adapted to CRLF" });

    // The point: the edit lands, and the file keeps its CRLF endings rather than being
    // silently converted to LF (or left unmatchable).
    expect(await fs.readFile(path.join(cwd, "win.ts"), "utf8")).toBe(
      "const a = 1;\r\nconst b = 3;\r\n",
    );
  });

  it("prefers an exact match and leaves LF files alone", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "unix.ts"), "alpha\nbravo\n", "utf8");

    const edited = await run(
      editTool,
      { path: "unix.ts", oldString: "bravo", newString: "charlie" },
      cwd,
    );

    expect(edited.details).toMatchObject({ lineEndings: "exact" });
    expect(await fs.readFile(path.join(cwd, "unix.ts"), "utf8")).toBe("alpha\ncharlie\n");
  });

  it("adapts an LF quote when the file uses CRLF, and the reverse", async () => {
    const cwd = await makeWorkspace();
    // A file stored with LF, quoted by a model that included carriage returns.
    await fs.writeFile(path.join(cwd, "unix.ts"), "alpha\nbravo\n", "utf8");

    const edited = await run(
      editTool,
      { path: "unix.ts", oldString: "alpha\r\nbravo", newString: "alpha\r\ncharlie" },
      cwd,
    );

    expect(edited.details).toMatchObject({ lineEndings: "adapted to LF" });
    expect(await fs.readFile(path.join(cwd, "unix.ts"), "utf8")).toBe("alpha\ncharlie\n");
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

  it("interrupts a catastrophically backtracking pattern and stays usable", async () => {
    const cwd = await makeWorkspace();
    // Textbook ReDoS: (a+)+$ against many a's then b backtracks exponentially. V8 has
    // no regex timeout, and a fired AbortSignal cannot interrupt synchronous
    // backtracking, so without the sandbox this call would never return.
    await fs.writeFile(path.join(cwd, "evil.txt"), `${"a".repeat(200)}b\n`, "utf8");
    await fs.writeFile(path.join(cwd, "ok.txt"), "needle\n", "utf8");

    const started = Date.now();
    let failure: { code?: string } | undefined;
    try {
      await run(grepTool, { pattern: "(a+)+$" }, cwd);
    } catch (error) {
      failure = error as { code?: string };
    }
    const elapsed = Date.now() - started;

    // Bounded, not "however long V8 felt like taking".
    expect(elapsed).toBeLessThan(REGEX_TOTAL_BUDGET_MS + 2_000);
    expect(elapsed).toBeGreaterThanOrEqual(REGEX_TOTAL_BUDGET_MS - 300);

    // Classified, not a raw escape. `timeout` is retryable, so reporting it that way
    // would make the Runtime retry a pattern that will never get faster; a vm timeout
    // error also fails `instanceof Error` (different realm), so an `instanceof` guard
    // would let it through unclassified.
    expect(failure, "the runaway pattern should have failed rather than returned").toBeDefined();
    expect(failure?.code).toBe("invalid_tool");

    // Interruption uses the V8 terminator; a poisoned isolate would kill the agent for
    // the rest of the run.
    const after = await run(grepTool, { pattern: "needle" }, cwd);
    expect(after.content).toContain("ok.txt:1:");
  }, 20_000);

  it("rejects an invalid regular expression as invalid_tool", async () => {
    const cwd = await makeWorkspace();
    await expect(run(grepTool, { pattern: "([unclosed" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });
});

describe("walk cap", () => {
  it("reports that it stopped early instead of ending silently", async () => {
    const cwd = await makeWorkspace();
    for (let index = 0; index < 12; index += 1) {
      await fs.writeFile(path.join(cwd, `f${index}.txt`), "x", "utf8");
    }

    const stats = { filesYielded: 0, stoppedEarly: false };
    const seen: string[] = [];
    for await (const relative of walkFiles({ root: cwd, maxEntries: 5, stats })) {
      seen.push(relative);
    }

    // Silently returning at the cap makes a partial search look like a complete one,
    // and a "no matches" answer would then be a lie.
    expect(stats.stoppedEarly, "hitting the cap must be observable").toBe(true);
    expect(stats.filesYielded).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it("leaves the flag clear when the tree was exhausted", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "a.txt"), "x", "utf8");

    const stats = { filesYielded: 0, stoppedEarly: false };
    for await (const _relative of walkFiles({ root: cwd, stats })) {
      // drain
    }

    expect(stats.stoppedEarly).toBe(false);
    expect(stats.filesYielded).toBe(1);
  });
});

describe("respecting .gitignore", () => {
  async function repo(gitignore: string): Promise<string> {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, ".gitignore"), gitignore, "utf8");
    await fs.mkdir(path.join(cwd, "target", "debug"), { recursive: true });
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "target", "debug", "gen.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, "src", "a.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, "app.log"), "", "utf8");
    await fs.writeFile(path.join(cwd, "keep.log"), "", "utf8");
    return cwd;
  }

  it("skips directories the project ignores, which the built-in list cannot know about", async () => {
    const cwd = await repo("target/\n");

    const result = await run(findTool, { pattern: "*.ts" }, cwd);

    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("target/");
  });

  it("honours a negation", async () => {
    const cwd = await repo("*.log\n!keep.log\n");

    const result = await run(findTool, { pattern: "*.log" }, cwd);

    expect(result.content).toContain("keep.log");
    expect(result.content).not.toContain("app.log");
  });

  it("applies the workspace's patterns even when the search starts deeper", async () => {
    const cwd = await repo("generated/\n");
    await fs.mkdir(path.join(cwd, "src", "generated"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "generated", "b.ts"), "", "utf8");

    // Testing `generated/b.ts` against the matcher would miss it; the pattern is
    // written relative to the workspace root, so the walk must test `src/generated/...`.
    const result = await run(findTool, { pattern: "*.ts", path: "src" }, cwd);

    // Results stay workspace-relative even though the search started deeper, so they
    // can be handed straight to another tool.
    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("generated");
  });

  it("returns a path that read can open directly", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "deep", "target.ts"), "const marker = 1;\n", "utf8");

    // The search starts at `src`, so the result must still name a path `read` accepts —
    // `deep/target.ts` would resolve to a file that does not exist.
    const found = await run(findTool, { pattern: "*.ts", path: "src" }, cwd);
    const reportedPath = found.content.split("\n")[0] ?? "";

    const opened = await run(readTool, { path: reportedPath }, cwd);
    expect(opened.content).toContain("marker");
  });

  it("keeps grep consistent with find", async () => {
    const cwd = await repo("target/\n");
    await fs.writeFile(path.join(cwd, "target", "debug", "gen.ts"), "needle\n", "utf8");
    await fs.writeFile(path.join(cwd, "src", "a.ts"), "needle\n", "utf8");

    const result = await run(grepTool, { pattern: "needle" }, cwd);

    expect(result.content).toContain("src/a.ts:1:");
    expect(result.content).not.toContain("target/");
  });

  it("still works when there is no .gitignore, and when it is empty", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "dep", "a.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, "src.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, ".gitignore"), "   \n", "utf8");

    const result = await run(findTool, { pattern: "*.ts" }, cwd);

    // The built-in list is the floor and applies regardless.
    expect(result.content).toContain("src.ts");
    expect(result.content).not.toContain("node_modules");
  });
});

describe("a search path that is a file, not a directory", () => {
  it("searches the file rather than silently reporting no matches", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "only.ts"), "const needle = 1;\n", "utf8");

    // Pointing a content search at a file is an obvious thing to do. Silently saying
    // "no matches" is a wrong answer; the file plainly contains one.
    const result = await run(grepTool, { pattern: "needle", path: "only.ts" }, cwd);

    expect(result.content).toContain("only.ts:1:");
  });

  it("finds a file when the path is a file", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "only.test.ts"), "", "utf8");

    const result = await run(findTool, { pattern: "*.test.ts", path: "only.test.ts" }, cwd);

    expect(result.content).toContain("only.test.ts");
  });

  it("still reports a genuinely missing path honestly", async () => {
    const cwd = await makeWorkspace();
    await expect(run(grepTool, { pattern: "x", path: "nope" }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });
});

describe("an honest negative result", () => {
  it("does not state a capped search as a definitive answer", () => {
    const capped = emptySearchMessage("needle", { filesYielded: 20_000, stoppedEarly: true });

    expect(capped).toContain("NOT a complete answer");
    expect(capped).toContain("20000");
  });

  it("states a complete search plainly", () => {
    const complete = emptySearchMessage("needle", { filesYielded: 12, stoppedEarly: false });

    expect(complete).toBe("No matches for /needle/");
    expect(complete).not.toContain("NOT a complete");
  });
});

describe("find", () => {
  async function scaffold(): Promise<string> {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "src", "deep"), { recursive: true });
    await fs.mkdir(path.join(cwd, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(cwd, "top.test.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, "src", "a.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, "src", "a.test.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, "src", "deep", "b.ts"), "", "utf8");
    await fs.writeFile(path.join(cwd, "node_modules", "dep", "c.ts"), "", "utf8");
    return cwd;
  }

  it("matches a bare name pattern against the file name anywhere in the tree", async () => {
    const cwd = await scaffold();

    // A `*.test.ts` that only matched the workspace root would be useless, and would
    // push the model back to shelling out.
    const result = await run(findTool, { pattern: "*.test.ts" }, cwd);

    const lines = result.content.split("\n").filter((line) => line.endsWith(".test.ts"));
    expect(lines.sort()).toEqual(["src/a.test.ts", "top.test.ts"]);
  });

  it("matches a pattern containing a slash against the whole relative path", async () => {
    const cwd = await scaffold();

    expect((await run(findTool, { pattern: "src/*.ts" }, cwd)).content.split("\n").sort()).toEqual([
      "src/a.test.ts",
      "src/a.ts",
    ]);

    const recursive = await run(findTool, { pattern: "src/**/*.ts" }, cwd);
    expect(recursive.content).toContain("src/deep/b.ts");
  });

  it("skips dependency directories", async () => {
    const cwd = await scaffold();

    const result = await run(findTool, { pattern: "*.ts" }, cwd);
    expect(result.content).not.toContain("node_modules");
  });

  it("stops at maxResults and says so", async () => {
    const cwd = await scaffold();

    const result = await run(findTool, { pattern: "*.ts", maxResults: 1 }, cwd);

    expect(result.details).toMatchObject({ matchCount: 1, truncated: true });
    expect(result.content).toContain("stopped at 1 matches");
  });

  it("refuses a path outside the workspace", async () => {
    const cwd = await scaffold();
    await expect(run(findTool, { pattern: "*.ts", path: "../.." }, cwd)).rejects.toMatchObject({
      code: "invalid_tool",
    });
  });

  it("is honest about whether an empty result was complete", () => {
    const complete = emptyFindMessage("*.rs", false, { filesYielded: 4, stoppedEarly: false });
    expect(complete).toBe("no file name matched /*.rs/.");

    const capped = emptyFindMessage("*.rs", false, { filesYielded: 20_000, stoppedEarly: true });
    expect(capped).toContain("NOT a complete answer");
    expect(capped).toContain("20000");
  });

  it("distinguishes a name pattern from a path pattern in its message", () => {
    const stats = { filesYielded: 2, stoppedEarly: false };
    expect(emptyFindMessage("a/b", true, stats)).toContain("no file path matched");
    expect(emptyFindMessage("b", false, stats)).toContain("no file name matched");
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
