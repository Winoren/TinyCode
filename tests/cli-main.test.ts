/**
 * CLI entry-point tests.
 *
 * These drive the real `main()`: real argument handling, real bootstrap, real
 * rendering, real exit codes. Before this file the CLI was only tested in pieces
 * (parsing, rendering) and its actual exit codes had never been executed — the one
 * behaviour a caller scripting TinyCode depends on most.
 *
 * `main`'s `bootstrapOptions` seam lets the model be swapped out, so the success path
 * is exercisable without a provider key.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.ts";
import { scriptedModel } from "../src/adapters/fake/index.ts";
import { coreLoopDriver } from "../src/core/loop.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-main-"));
  directories.push(dir);
  return dir;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

async function runMain(
  argv: readonly string[],
  bootstrapOptions: Parameters<typeof main>[1] = {},
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });

  const code = await main(argv, bootstrapOptions);
  return { code, out: out.join(""), err: err.join("") };
}

/** A driver that answers immediately, optionally after one tool call. */
function fakeDriver(decisions: Parameters<typeof scriptedModel>[0]) {
  return ({ toolPort }: { toolPort: Parameters<typeof coreLoopDriver>[0]["tools"] }) =>
    coreLoopDriver({ model: scriptedModel(decisions), tools: toolPort });
}

describe("cli — usage and misuse (no provider needed)", () => {
  it("prints usage and exits 0 for --help", async () => {
    const { code, out } = await runMain(["--help"]);

    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    expect(out).toContain("Confirmations:");
  });

  it("exits 2 with usage when no task is given", async () => {
    const { code, err } = await runMain([]);

    expect(code).toBe(2);
    expect(err).toContain("no task given");
  });

  it("exits 2 when the task is only whitespace", async () => {
    const { code } = await runMain(["   "]);
    expect(code).toBe(2);
  });

  it("exits 2 on an unknown option rather than ignoring it", async () => {
    const { code, err } = await runMain(["--readonly", "do something"]);

    expect(code).toBe(2);
    expect(err).toContain("unknown option: --readonly");
  });

  it("exits 2 on an unknown tool", async () => {
    const { code, err } = await runMain(["--tools", "telepathy", "do something"]);

    expect(code).toBe(2);
    expect(err).toContain("unknown tool: telepathy");
  });
});

describe("cli — exit codes reflect the terminal state", () => {
  it("exits 0 and prints the result when the run completes", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const { code, out, err } = await runMain(
      ["--cwd", cwd, "--store-dir", storeDir, "say hello"],
      { driverFactory: fakeDriver([{ kind: "respond", content: "All done." }]) },
    );

    expect(code).toBe(0);
    expect(out).toContain("All done.");
    expect(out).toContain("— complete");
    expect(err).toContain("tools:");
  });

  it("exits 0 for a partial run, and names what was missing", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const { code, out } = await runMain(
      ["--cwd", cwd, "--store-dir", storeDir, "--tools", "read", "deploy it"],
      {
        driverFactory: fakeDriver([
          { kind: "call_tool", intent: { name: "deploy", arguments: {} } },
          { kind: "respond", content: "I could not deploy." },
        ]),
      },
    );

    // Partial is a result, not a process failure.
    expect(code).toBe(0);
    expect(out).toContain("partial — missing: deploy");
  });

  it("exits 1 when the run fails, and reports the typed error", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const { code, err } = await runMain(
      ["--cwd", cwd, "--store-dir", storeDir, "go"],
      {
        driverFactory: () =>
          async function* () {
            throw new Error("402 Insufficient Balance");
          },
      },
    );

    expect(code).toBe(1);
    expect(err).toContain("provider_unavailable");
  });

  it("exits 1 and explains itself when the run cannot start", async () => {
    // No driverFactory, and no credentials in this environment: bootstrap fails.
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const { code, err } = await runMain(["--cwd", cwd, "--store-dir", storeDir, "go"]);

    expect(code).toBe(1);
    expect(err).toContain("could not start");
  });

  it("writes a replayable run log for a completed run", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const { code } = await runMain(["--cwd", cwd, "--store-dir", storeDir, "say hello"], {
      driverFactory: fakeDriver([{ kind: "respond", content: "All done." }]),
    });

    expect(code).toBe(0);
    const entries = await fs.readdir(storeDir, { recursive: true });
    expect(entries.some((entry) => String(entry).endsWith(".jsonl"))).toBe(true);
  });

  it("emits raw JSONL events when asked", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const { out } = await runMain(
      ["--json", "--cwd", cwd, "--store-dir", storeDir, "say hello"],
      { driverFactory: fakeDriver([{ kind: "respond", content: "All done." }]) },
    );

    const events = out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string });

    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_completed");
  });

  it("does not create a workspace store when the run cannot start", async () => {
    const cwd = await tempDir();

    await runMain(["--cwd", cwd, "go"]);

    const entries = await fs.readdir(cwd);
    expect(entries).not.toContain(".tinycode");
  });
});
