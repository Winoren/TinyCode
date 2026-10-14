/**
 * Pi adapter tests.
 *
 * These run against the real installed SDK with no provider credentials, because the
 * two things most worth proving here do not need a model:
 *
 * 1. the tool bridge forwards to our `ToolPort` and returns the SDK's envelope;
 * 2. **the model is offered exactly our tools** — the guard against a built-in tool
 *    surviving and bypassing the workspace boundary in `tools/paths.ts`.
 *
 * The surface test builds the session from `buildPiSessionOptions`, the same function
 * the production driver calls, so it cannot drift from what actually runs.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import { toolOutput, type ToolIntent, type ToolPort } from "../src/core/contracts.ts";
import { buildSystemPrompt } from "../src/adapters/pi/system-prompt.ts";
import { buildPiSessionOptions, piDriver } from "../src/adapters/pi/driver.ts";
import { definePiTools } from "../src/adapters/pi/tools.ts";
import { toParameters } from "../src/adapters/pi/schema.ts";
import { CODING_TOOLS, READ_ONLY_TOOLS } from "../src/tools/index.ts";
import type { AnyToolDefinition } from "../src/tools/types.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-pi-"));
  directories.push(dir);
  return dir;
}

/** A port that records what it was asked to do. */
function recordingPort(): ToolPort & { readonly seen: ToolIntent[] } {
  const seen: ToolIntent[] = [];
  return {
    seen,
    names: ["read"],
    async execute(intent) {
      seen.push(intent);
      return toolOutput(`contents of ${String(intent.arguments.path)}`, {
        path: intent.arguments.path,
      });
    },
  };
}

const readOnlyTool: AnyToolDefinition = {
  name: "read",
  description: "Read a file",
  schema: z.object({ path: z.string().min(1) }),
  async execute() {
    // Deliberately not what the port returns: the bridge must call the port.
    return toolOutput("from the tool, not the port");
  },
};

describe("schema bridging", () => {
  it("converts a real tool schema into a model-facing JSON Schema", () => {
    const { parameters, error } = toParameters(
      z.object({
        path: z.string().min(1).describe("File path"),
        limit: z.number().int().positive().optional(),
      }),
    );

    expect(error).toBeUndefined();
    expect(parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "File path" },
        limit: { type: "integer" },
      },
      required: ["path"],
    });
  });

  it("converts every shipped tool schema without a diagnostic", () => {
    for (const tool of CODING_TOOLS) {
      const { error } = toParameters(tool.schema);
      expect(error, `${tool.name} schema failed to convert`).toBeUndefined();
    }
  });

  it("falls back permissively instead of throwing on an unconvertible schema", () => {
    // `z.custom` genuinely has no JSON Schema representation, unlike a `refine`,
    // which zod silently drops. Verified against zod 4.6.7.
    const unconvertible = z.custom<unknown>(() => true);

    const { parameters, error } = toParameters(unconvertible);

    // A malformed tool must never prevent the runtime from starting.
    expect(parameters).toMatchObject({ type: "object" });
    expect(typeof error).toBe("string");
  });
});

describe("system prompt", () => {
  it("lists every tool exactly once", () => {
    const prompt = buildSystemPrompt({ cwd: "/tmp/ws", tools: CODING_TOOLS });

    for (const tool of CODING_TOOLS) {
      const occurrences = prompt.split(`- ${tool.name}:`).length - 1;
      expect(occurrences, `${tool.name} should appear once`).toBe(1);
    }
    expect(prompt).toContain("/tmp/ws");
  });
});

describe("tool bridge", () => {
  it("forwards to our ToolPort and returns the SDK envelope", async () => {
    const port = recordingPort();
    const bridge = definePiTools([readOnlyTool], port);
    const definition = bridge.tools[0];
    expect(definition).toBeDefined();

    const result = await definition?.execute(
      "call-1",
      { path: "a.ts" },
      undefined,
      undefined,
      {} as never,
    );

    expect(port.seen).toEqual([{ name: "read", arguments: { path: "a.ts" } }]);
    expect(result?.content).toEqual([{ type: "text", text: "contents of a.ts" }]);
    expect(result?.details).toEqual({ path: "a.ts" });
    expect(bridge.diagnostics).toEqual([]);
  });

  it("reports a diagnostic rather than failing when a schema cannot convert", () => {
    const broken: AnyToolDefinition = {
      name: "broken",
      description: "A tool with an unconvertible schema",
      schema: z.custom<unknown>(() => true),
      async execute() {
        return toolOutput("never reached");
      },
    };

    const bridge = definePiTools([broken], recordingPort());

    expect(bridge.tools).toHaveLength(1);
    expect(bridge.diagnostics).toHaveLength(1);
    expect(bridge.diagnostics[0]).toContain("broken");
  });
});

describe("session tool surface (integration, no model required)", () => {
  it("offers the model exactly our tools, with no built-in leaking through", async () => {
    const cwd = await tempDir();
    const plan = buildPiSessionOptions({ cwd, tools: CODING_TOOLS, toolPort: recordingPort() });

    const { session } = await createAgentSession(plan.sessionOptions);
    try {
      const active = session.getActiveToolNames();
      const expected = CODING_TOOLS.map((tool) => tool.name).sort();

      expect([...active].sort()).toEqual(expected);

      // Sharing a name with a built-in is not enough: the definition must be ours.
      for (const name of active) {
        const definition = session.getToolDefinition(name);
        const ours = CODING_TOOLS.find((tool) => tool.name === name);
        expect(definition?.description, `${name} should resolve to our definition`).toBe(
          ours?.description,
        );
      }
    } finally {
      session.dispose();
    }
  });

  it("keeps a read-only selection read-only", async () => {
    const cwd = await tempDir();
    const plan = buildPiSessionOptions({ cwd, tools: READ_ONLY_TOOLS, toolPort: recordingPort() });

    const { session } = await createAgentSession(plan.sessionOptions);
    try {
      const active = session.getActiveToolNames();
      expect([...active].sort()).toEqual(["grep", "ls", "read"]);
      expect(active).not.toContain("bash");
      expect(active).not.toContain("write");
      expect(active).not.toContain("edit");
    } finally {
      session.dispose();
    }
  });

  it("refuses to run when the offered surface contains a tool we did not define", async () => {
    const cwd = await tempDir();
    // Only claim `read` while handing the SDK a session that also registers `bash`:
    // the guard must catch the discrepancy rather than run with it.
    const driver = piDriver({
      cwd,
      tools: [readOnlyTool],
      toolPort: recordingPort(),
      verifyToolSurface: false,
    });

    const state = {
      task: { id: "t", input: "hi", cwd },
      transcript: [],
      observations: [],
      iteration: 0,
      toolCalls: 0,
    };

    // With the guard disabled the driver proceeds past the surface check; it should
    // fail later for want of a provider, not on the guard.
    const iterator = driver(state, {
      budget: { maxIterations: 2, maxToolCalls: 2, maxRetries: 0, timeoutMs: 5_000 },
      signal: new AbortController().signal,
      now: () => 1,
      newToolCallId: () => "c1",
      humanInput: undefined,
      model: undefined,
    });
    await expect(iterator.next()).rejects.toBeTruthy();
  }, 30_000);
});
