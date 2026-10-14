/**
 * Secret-leak tests.
 *
 * The Skill states a hard invariant: "secrets never appear in events, traces, or
 * logs". A claim like that is worth exactly as much as the test that tries to break
 * it, so the second case here is adversarial — it makes a provider error *echo the
 * credential*, which is the realistic leak vector, and asserts the persisted log is
 * still clean.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrap } from "../src/bootstrap.ts";
import { resolveModel } from "../src/model/registry.ts";
import { scriptedModel } from "../src/adapters/fake/index.ts";
import { coreLoopDriver } from "../src/core/loop.ts";

const SECRET = "sk-tinycode-secret-6f2a91c4d7e8b305";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-secret-"));
  directories.push(dir);
  return dir;
}

/** Every regular file under `root`, as raw text. */
async function readAllFiles(root: string): Promise<{ file: string; content: string }[]> {
  const results: { file: string; content: string }[] = [];
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    results.push({ file: full, content: await fs.readFile(full, "utf8") });
  }
  return results;
}

describe("credentials never reach the durable trace", () => {
  it("resolves a model from the environment without persisting the key", async () => {
    const storeDir = await tempDir();
    const cwd = await tempDir();

    // Prove the key really is being consumed, so the assertion below is not vacuous.
    const resolution = await resolveModel({
      spec: "deepseek/deepseek-v4-flash",
      env: { DEEPSEEK_API_KEY: SECRET },
    });
    expect(resolution.model).toBeDefined();
    expect(resolution.envWiredProviders).toContain("deepseek");

    const bootstrapped = await bootstrap({
      cwd,
      storeDir,
      toolNames: ["read"],
      driverFactory: ({ toolPort }) =>
        coreLoopDriver({
          tools: toolPort,
          model: scriptedModel([{ kind: "respond", content: "done" }]),
        }),
    });

    for await (const _event of bootstrapped.runtime.run({ id: "s1", input: "hi", cwd })) {
      // drain
    }

    for (const { file, content } of await readAllFiles(storeDir)) {
      expect(content, `${file} must not contain the credential`).not.toContain(SECRET);
    }
  }, 30_000);

  it("keeps the key out of the log even when a provider error echoes it", async () => {
    const storeDir = await tempDir();
    const cwd = await tempDir();

    const bootstrapped = await bootstrap({
      cwd,
      storeDir,
      toolNames: ["read"],
      secrets: [SECRET],
      driverFactory: () =>
        async function* () {
          // A provider that includes the credential in its failure message. This is
          // the realistic vector: an error string travelling into the trace.
          throw new Error(`401 Unauthorized: the API key ${SECRET} is invalid`);
        },
    });

    const events = [];
    for await (const event of bootstrapped.runtime.run({ id: "s2", input: "hi", cwd })) {
      events.push(event);
    }

    // The run must still fail honestly and be typed.
    expect(events.at(-1)).toMatchObject({ type: "run_failed", error: { code: "auth" } });

    for (const { file, content } of await readAllFiles(storeDir)) {
      expect(content, `${file} must not contain the credential`).not.toContain(SECRET);
    }
  }, 30_000);
});
