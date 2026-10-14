/**
 * The real CLI, end to end, against a local endpoint.
 *
 * This is the whole product path with nothing stubbed except the model's output: real
 * argument parsing, real bootstrap, a real provider registration, a real SDK session, a
 * real tool call executing our real `read`, real event rendering, and a real exit code.
 *
 * It exists because "the CLI works" was, until now, an inference from unit-testing its
 * pieces. It also verifies the custom-endpoint support the Skill documents
 * (`scenario-custom-provider`) and which the harness previously lacked entirely.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.ts";
import { startStubProvider, type StubProvider } from "./helpers/stub-provider.ts";

const directories: string[] = [];
const providers: StubProvider[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-cli-live-"));
  directories.push(dir);
  return dir;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

async function runMain(argv: readonly string[]): Promise<RunResult> {
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

  const code = await main(argv);
  return { code, out: out.join(""), err: err.join("") };
}

describe("cli end to end against a custom endpoint", () => {
  it("reads a real file through a real tool call and reports the answer", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();
    await fs.writeFile(path.join(cwd, "answer.ts"), "export const answer = 42;\n", "utf8");

    const stub = await startStubProvider([
      { toolCall: { name: "read", args: { path: "answer.ts" } } },
      { text: "It exports 42." },
    ]);
    providers.push(stub);

    const result = await runMain([
      "--cwd", cwd,
      "--store-dir", storeDir,
      "--base-url", `http://127.0.0.1:${stub.port}/v1`,
      "--model", "stub-model",
      "--tools", "read",
      "what does answer.ts export?",
    ]);

    expect(result.code).toBe(0);
    // The label tells the user which endpoint answered.
    expect(result.err).toContain("custom/stub-model");

    // The tool call is reported on screen. Its *output* deliberately is not: the renderer
    // shows one compact line per tool, and the result belongs to the model, not the
    // terminal.
    expect(result.out).toContain("● read path=answer.ts");
    expect(result.out).toContain("It exports 42.");
    expect(result.out).toContain("— complete");

    // So the evidence that the tool really ran is upstream: the second provider round trip
    // carries the file's contents back to the model.
    expect(stub.requestBodies).toHaveLength(2);
    expect(stub.requestBodies[1]).toContain("export const answer = 42");
  }, 30_000);

  it("says tokens are unknown rather than printing zero", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    // The endpoint reports no usage, which the SDK turns into zeros.
    const stub = await startStubProvider([{ text: "No counts here." }]);
    providers.push(stub);

    const result = await runMain([
      "--cwd", cwd,
      "--store-dir", storeDir,
      "--base-url", `http://127.0.0.1:${stub.port}/v1`,
      "--model", "stub-model",
      "--tools", "read",
      "hi",
    ]);

    expect(result.code).toBe(0);
    // The user-visible symptom of the fabricated-zero bug was exactly this line.
    expect(result.err).toContain("tokens unknown");
    expect(result.err).not.toContain("in 0");
  }, 30_000);

  it("exits non-zero when the endpoint refuses the request", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const stub = await startStubProvider([{ httpStatus: 503 }]);
    providers.push(stub);

    const result = await runMain([
      "--cwd", cwd,
      "--store-dir", storeDir,
      "--base-url", `http://127.0.0.1:${stub.port}/v1`,
      "--model", "stub-model",
      "--tools", "read",
      "--max-iterations", "1",
      "hello",
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/run failed/);

    // Two retry layers are in play and both are bounded: the SDK retries the request
    // first (keeping the conversation), and only if the run still fails does the Runtime
    // retry it (with a fresh session). A persistent 503 therefore takes a couple of
    // seconds to surface — measured, not assumed: one request reaches the endpoint, the
    // SDK's own backoff accounts for the delay, and its re-issued turn is what trips the
    // iteration budget configured here.
    expect(result.err).toMatch(/iteration budget exhausted|provider_unavailable|budget_/);
  }, 30_000);

  it("refuses --base-url without a model to name", async () => {
    const { code, err } = await runMain(["--base-url", "http://127.0.0.1:1/v1", "hello"]);

    expect(code).toBe(2);
    expect(err).toContain("--base-url needs --model");
  });

  it("accepts a provider-qualified model so the trace can name the registration", async () => {
    const cwd = await tempDir();
    const storeDir = await tempDir();

    const stub = await startStubProvider([{ text: "hello" }]);
    providers.push(stub);

    const result = await runMain([
      "--cwd", cwd,
      "--store-dir", storeDir,
      "--base-url", `http://127.0.0.1:${stub.port}/v1`,
      "--model", "local-llama/stub-model",
      "--tools", "read",
      "hi",
    ]);

    expect(result.code).toBe(0);
    expect(result.err).toContain("local-llama/stub-model");
  }, 30_000);
});
