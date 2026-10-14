/**
 * CLI and end-to-end slice tests.
 *
 * The last suite is the load-bearing one: it runs `bootstrap` — the same assembly the
 * CLI uses — against a **real temp workspace** with the **real tools**, **real
 * Runtime** and **real JSONL run log**. Only the model is scripted. That makes it a
 * genuine end-to-end proof of the vertical slice without needing provider
 * credentials.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { scriptedModel } from "../src/adapters/fake/index.ts";
import { coreLoopDriver } from "../src/core/loop.ts";
import type { AgentEvent } from "../src/core/contracts.ts";
import { CliUsageError, parseArgs } from "../src/cli/args.ts";
import { createEventRenderer } from "../src/cli/render.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-cli-"));
  directories.push(dir);
  return dir;
}

describe("argument parsing", () => {
  it("defaults to the current directory, all tools, and the task from positional words", () => {
    const options = parseArgs(["fix", "the", "bug"]);

    expect(options.task).toBe("fix the bug");
    expect(options.cwd).toBe(process.cwd());
    expect(options.tools).toEqual(["read", "write", "edit", "ls", "grep", "find", "bash"]);
    expect(options.json).toBe(false);
  });

  it("restricts the tool set for --read-only", () => {
    expect(parseArgs(["--read-only", "look"]).tools).toEqual(["read", "ls", "grep", "find"]);
  });

  it("removes bash for --no-bash without disturbing the rest", () => {
    expect(parseArgs(["--no-bash", "look"]).tools).toEqual(["read", "write", "edit", "ls", "grep", "find"]);
  });

  it("rejects an unknown option instead of ignoring it", () => {
    // A silently ignored `--readonly` typo would grant write access.
    expect(() => parseArgs(["--readonly", "x"])).toThrow(CliUsageError);
  });

  it("rejects an unknown tool name", () => {
    expect(() => parseArgs(["--tools", "read,telepathy", "x"])).toThrow(/unknown tool: telepathy/);
  });

  it("rejects an empty tool selection", () => {
    expect(() => parseArgs(["--tools", ",", "x"])).toThrow(/no tools selected/);
  });

  it("treats everything after -- as the task, even flag-like words", () => {
    const options = parseArgs(["--read-only", "--", "--not-a-flag", "please"]);
    expect(options.task).toBe("--not-a-flag please");
    expect(options.tools).toEqual(["read", "ls", "grep", "find"]);
  });

  it("parses numeric budgets and rejects non-numbers", () => {
    expect(parseArgs(["--max-iterations", "5", "x"]).maxIterations).toBe(5);
    expect(() => parseArgs(["--max-iterations", "many", "x"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--timeout", "-1", "x"])).toThrow(CliUsageError);
  });

  it("requires a value for flags that take one", () => {
    expect(() => parseArgs(["--model"])).toThrow(/requires a value/);
  });
});

describe("event rendering", () => {
  function render(events: readonly AgentEvent[], options = {}): { out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const renderer = createEventRenderer(
      { out: (text) => out.push(text), err: (text) => err.push(text) },
      options,
    );
    for (const event of events) renderer.handle(event);
    renderer.finish();
    return { out: out.join(""), err: err.join("") };
  }

  const base = { runId: "r1", timestamp: 1 };

  it("streams text and shows tool calls with their outcome", () => {
    const { out } = render([
      { ...base, sequence: 0, type: "text_delta", delta: "Looking" },
      { ...base, sequence: 1, type: "tool_started", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } },
      { ...base, sequence: 2, type: "tool_completed", toolCallId: "c1", toolName: "read", status: "success", durationMs: 7 },
      { ...base, sequence: 3, type: "run_completed", status: "complete", result: "Done." },
    ]);

    expect(out).toContain("Looking");
    expect(out).toContain("● read path=a.ts");
    expect(out).toContain("✓ 7ms");
    expect(out).toContain("Done.");
    expect(out).toContain("— complete");
  });

  it("names the missing material for a partial run", () => {
    const { out } = render([
      {
        ...base,
        sequence: 0,
        type: "run_completed",
        status: "partial",
        result: "Could not finish.",
        missingMaterial: ["deploy"],
      },
    ]);

    expect(out).toContain("partial — missing: deploy");
  });

  it("reports a failed run on stderr with its code", () => {
    const { err } = render([
      {
        ...base,
        sequence: 0,
        type: "run_failed",
        error: { code: "provider_unavailable", message: "402 Insufficient Balance" },
      },
    ]);

    expect(err).toContain("provider_unavailable");
    expect(err).toContain("402 Insufficient Balance");
  });

  it("says tokens are unknown rather than reporting zero", () => {
    const { err } = render([
      { ...base, sequence: 0, type: "usage_reported", usage: { toolCalls: 1, durationMs: 12 } },
    ]);

    expect(err).toContain("tokens unknown");
    expect(err).not.toContain("in 0");
  });

  it("surfaces a scheduled retry so a transient failure is distinguishable", () => {
    const { err } = render([
      {
        ...base,
        sequence: 0,
        type: "retry_scheduled",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 250,
        error: { code: "provider_unavailable", message: "503 Service Unavailable" },
      },
      { ...base, sequence: 1, type: "run_completed", status: "complete", result: "recovered" },
    ]);

    expect(err).toContain("retry 2/3");
    expect(err).toContain("provider_unavailable");
    expect(err).toContain("250ms");
  });

  it("emits raw JSONL when asked", () => {
    const { out } = render(
      [{ ...base, sequence: 0, type: "run_cancelled" }],
      { json: true },
    );

    expect(JSON.parse(out.trim())).toMatchObject({ type: "run_cancelled", sequence: 0 });
  });
});

describe("end-to-end vertical slice (real tools, real runtime, scripted model)", () => {
  it("reads, edits, verifies with bash, and reports the outcome", async () => {
    const workspace = await tempDir();
    const storeDir = await tempDir();

    // A real, broken source file and a real test that fails on it.
    await fs.writeFile(
      path.join(workspace, "math.mjs"),
      "export const add = (a, b) => a - b;\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "check.mjs"),
      [
        "import { add } from './math.mjs';",
        "if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2, 3)); process.exit(1); }",
        "console.log('PASS');",
        "",
      ].join("\n"),
      "utf8",
    );

    const bootstrapped = await bootstrap({
      cwd: workspace,
      storeDir,
      toolNames: ["read", "edit", "bash"],
      driverFactory: ({ toolPort }) =>
        coreLoopDriver({
          tools: toolPort,
          model: scriptedModel([
            { kind: "call_tool", intent: { name: "bash", arguments: { command: "node check.mjs" } } },
            { kind: "call_tool", intent: { name: "read", arguments: { path: "math.mjs" } } },
            {
              kind: "call_tool",
              intent: {
                name: "edit",
                arguments: { path: "math.mjs", oldString: "a - b", newString: "a + b" },
              },
            },
            { kind: "call_tool", intent: { name: "bash", arguments: { command: "node check.mjs" } } },
            { kind: "respond", content: "add() subtracted instead of adding; fixed and verified." },
          ]),
        }),
    });

    const events: AgentEvent[] = [];
    for await (const event of bootstrapped.runtime.run({
      id: "e2e",
      input: "the test fails, fix it",
      cwd: workspace,
    })) {
      events.push(event);
    }

    const terminal = events.at(-1);
    expect(terminal?.type).toBe("run_completed");
    expect(terminal).toMatchObject({ status: "complete" });

    // The fix actually landed on disk.
    expect(await fs.readFile(path.join(workspace, "math.mjs"), "utf8")).toContain("a + b");

    // The first bash genuinely observed a failure; the second genuinely passed.
    const observations = events.filter((event) => event.type === "observation_added");
    expect(observations).toHaveLength(4);
    const firstBash = observations[0];
    expect(firstBash).toMatchObject({ name: "bash" });
    if (firstBash?.type === "observation_added") {
      expect(JSON.stringify(firstBash.observation.result)).toContain("exit code: 1");
    }
    const lastBash = observations[3];
    if (lastBash?.type === "observation_added") {
      expect(JSON.stringify(lastBash.observation.result)).toContain("PASS");
    }

    // The run is durably replayable from the log it wrote.
    const runId = events[0]?.runId as string;
    const recovered = await bootstrapped.runtime.recover(runId, {
      id: "e2e",
      input: "the test fails, fix it",
      cwd: workspace,
    });
    expect(recovered.terminal?.type).toBe("run_completed");
    expect(recovered.state.observations).toHaveLength(4);
  }, 30_000);

  it("reports a partial run when the agent lacks a tool it needed", async () => {
    const workspace = await tempDir();
    const storeDir = await tempDir();

    const bootstrapped = await bootstrap({
      cwd: workspace,
      storeDir,
      toolNames: ["read"],
      driverFactory: ({ toolPort }) =>
        coreLoopDriver({
          tools: toolPort,
          model: scriptedModel([
            { kind: "call_tool", intent: { name: "deploy", arguments: {} } },
            { kind: "respond", content: "I cannot deploy: no such tool." },
          ]),
        }),
    });

    const events: AgentEvent[] = [];
    for await (const event of bootstrapped.runtime.run({
      id: "e2e-2",
      input: "deploy it",
      cwd: workspace,
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "run_completed",
      status: "partial",
      missingMaterial: ["deploy"],
    });
  }, 20_000);
});
