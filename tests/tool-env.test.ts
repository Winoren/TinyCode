/**
 * Tool environment scrubbing tests.
 *
 * The browser of a coding agent is a shell the *model* writes. Inheriting the agent's
 * own environment means `echo $DEEPSEEK_API_KEY` is one tool call away — and redaction
 * does not help, because a tool result reaches the model as clear text before it is
 * ever recorded.
 *
 * The control case matters as much as the fix: without it, a passing test proves only
 * that some string was absent, not that scrubbing is what made it absent.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bashTool } from "../src/tools/bash.ts";
import { presentNames, scrubEnvironment } from "../src/tools/env.ts";
import { credentialEnvNames } from "../src/model/registry.ts";
import { createToolRegistry } from "../src/tools/registry.ts";

const SECRET_NAME = "TINYCODE_TEST_CREDENTIAL";
const SECRET_VALUE = "sk-must-never-be-visible-9f2c";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-env-"));
  directories.push(dir);
  return dir;
}

const signal = new AbortController().signal;

async function runEcho(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const registry = createToolRegistry([bashTool], { cwd, env });
  const result = await registry.execute(
    { name: "bash", arguments: { command: `echo "[$${SECRET_NAME}]"` } },
    signal,
  );
  return JSON.stringify(result);
}

describe("scrubEnvironment", () => {
  it("removes the named variables and leaves the rest alone", () => {
    const scrubbed = scrubEnvironment(
      { PATH: "/usr/bin", [SECRET_NAME]: SECRET_VALUE, KEEP_ME: "yes" },
      [SECRET_NAME],
    );

    expect(scrubbed[SECRET_NAME]).toBeUndefined();
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.KEEP_ME).toBe("yes");
  });

  it("returns the original object when there is nothing to remove", () => {
    const env = { PATH: "/usr/bin" };
    expect(scrubEnvironment(env, [])).toBe(env);
  });

  it("reports which names were actually present", () => {
    // Names are reported, never values: the tool layer should not handle the secret.
    const env = { [SECRET_NAME]: SECRET_VALUE, OTHER: "x" };
    expect(presentNames(env, [SECRET_NAME, "OTHER", "ABSENT"])).toEqual([SECRET_NAME, "OTHER"]);
  });
});

describe("a model-written command cannot read the agent's credentials", () => {
  it("control: without scrubbing, the credential IS visible", async () => {
    const cwd = await makeWorkspace();
    const env = { ...process.env, [SECRET_NAME]: SECRET_VALUE };

    const output = await runEcho(cwd, env);

    // This is the leak the next test prevents. If this ever stops holding, the
    // scrubbing test below has become vacuous.
    expect(output).toContain(SECRET_VALUE);
  });

  it("with scrubbing, the credential is not visible", async () => {
    const cwd = await makeWorkspace();
    const env = scrubEnvironment({ ...process.env, [SECRET_NAME]: SECRET_VALUE }, [SECRET_NAME]);

    const output = await runEcho(cwd, env);

    expect(output).not.toContain(SECRET_VALUE);
    expect(output).toContain("[]");
  });

  it("still lets ordinary environment variables through", async () => {
    const cwd = await makeWorkspace();
    const env = scrubEnvironment(
      { ...process.env, TINYCODE_VISIBLE: "hello", [SECRET_NAME]: SECRET_VALUE },
      [SECRET_NAME],
    );

    const registry = createToolRegistry([bashTool], { cwd, env });
    const result = await registry.execute(
      { name: "bash", arguments: { command: "echo \"[$TINYCODE_VISIBLE]\"" } },
      signal,
    );

    // Scrubbing must not turn into a broken environment.
    expect(JSON.stringify(result)).toContain("hello");
  });
});

describe("credentialEnvNames", () => {
  it("names the credential variables that are actually present", () => {
    const original = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = SECRET_VALUE;
    try {
      const names = credentialEnvNames(["deepseek"]);

      expect(names).toContain("DEEPSEEK_API_KEY");
      // Names only — the tool layer must never handle the value.
      expect(names.join(" ")).not.toContain(SECRET_VALUE);
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = original;
    }
  });

  it("reports nothing for a variable that is absent", () => {
    const original = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      // Nothing to scrub, so nothing is withheld.
      expect(credentialEnvNames(["deepseek"])).toEqual([]);
    } finally {
      if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
    }
  });

  it("returns nothing for a provider it does not know", () => {
    expect(credentialEnvNames(["definitely-not-a-provider"])).toEqual([]);
  });
});
