/**
 * Live tests against the real SDK session — no provider credentials needed.
 *
 * A local HTTP server speaks the OpenAI-compatible protocol, and a real `ModelRuntime`
 * provider is pointed at it. Everything else is the production path: the real Pi session,
 * the real prompt, the real tool-call loop, `defineTool` bridging into our `ToolPort`, our
 * actual tool implementations, event normalization, the Runtime envelope and the run log.
 * Only the model's *output* is scripted.
 *
 * This is the closest thing to the end-to-end verification the Skill asks for that does
 * not require an API key, and it covers several things that were previously only
 * unit-tested: the confirmation gate's ordering on the SDK path, and the tool bridge
 * actually executing.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { piDriver } from "../src/adapters/pi/driver.ts";
import { destructiveCommandPolicy } from "../src/core/gate.ts";
import { DEFAULT_BUDGET, type AgentEvent, type RunBudget } from "../src/core/contracts.ts";
import type { GatePolicy } from "../src/core/gate.ts";
import type { HumanInputChannel } from "../src/core/loop.ts";
import type { Sleeper } from "../src/runtime/runtime.ts";
import { createRuntime } from "../src/runtime/runtime.ts";
import { InMemoryRunLog } from "../src/runtime/run-log.ts";
import { InMemorySessionStore } from "../src/runtime/session-store.ts";
import { createToolRegistry, selectTools } from "../src/tools/index.ts";
import {
  startStubProvider,
  stubModel,
  type StubProvider,
  type StubTurn,
} from "./helpers/stub-provider.ts";

const directories: string[] = [];
const providers: StubProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-live-"));
  directories.push(dir);
  return dir;
}

let counter = 0;
const nextId = (): string => `id-${(counter += 1)}`;

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const TERMINALS = new Set(["run_completed", "run_failed", "run_cancelled"]);
const terminals = (events: readonly AgentEvent[]): AgentEvent[] =>
  events.filter((event) => TERMINALS.has(event.type));

describe("live: the real SDK session against a stub provider", () => {
  it("runs a real tool call, streams text, and completes", async () => {
    const cwd = await tempDir();
    await fs.writeFile(path.join(cwd, "answer.ts"), "export const answer = 42;\n", "utf8");

    const stub = await startStubProvider([
      { toolCall: { name: "read", args: { path: "answer.ts" } } },
      { text: "It exports the answer." },
    ]);
    providers.push(stub);
    const { model, modelRuntime } = await stubModel(stub);

    const tools = selectTools(["read"]);
    const runtime = await createRuntime({
      cwd,
      driver: piDriver({
        cwd,
        model,
        modelRuntime,
        tools,
        toolPort: createToolRegistry(tools, { cwd }),
      }),
      runLog: new InMemoryRunLog(),
      sessionStore: new InMemorySessionStore(nextId),
      newId: nextId,
    });

    const events = await collect(runtime.run({ id: "live", input: "what does it export?", cwd }));
    const types = events.map((event) => event.type);

    // The SDK drove a real turn, we normalized it, and the run terminated.
    expect(types).toContain("model_requested");
    expect(types).toContain("decision_made");
    expect(types).toContain("tool_started");
    expect(types).toContain("tool_completed");
    expect(types).toContain("observation_added");
    expect(types).toContain("text_delta");
    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]).toMatchObject({ type: "run_completed", status: "complete" });

    // The observation came from our tool reading the real file, not from the stub.
    const observation = events.find((event) => event.type === "observation_added");
    expect(JSON.stringify(observation)).toContain("answer = 42");

    // Two provider round trips: the tool call, then the answer.
    expect(stub.requestBodies).toHaveLength(2);
    expect(stub.requestBodies[1]).toContain("answer = 42");
  }, 30_000);

  it("does not report a start for a gated action that was declined", async () => {
    const cwd = await tempDir();

    const stub = await startStubProvider([
      { toolCall: { name: "bash", args: { command: "rm -rf .." } } },
      { text: "Left it alone." },
    ]);
    providers.push(stub);
    const { model, modelRuntime } = await stubModel(stub);

    const tools = selectTools(["bash"]);
    const asked: string[] = [];
    const runtime = await createRuntime({
      cwd,
      driver: piDriver({
        cwd,
        model,
        modelRuntime,
        tools,
        toolPort: createToolRegistry(tools, { cwd }),
        gate: destructiveCommandPolicy(),
      }),
      runLog: new InMemoryRunLog(),
      sessionStore: new InMemorySessionStore(nextId),
      newId: nextId,
      humanInput: async (question) => {
        asked.push(question);
        return "no";
      },
    });

    const events = await collect(runtime.run({ id: "live-gate", input: "clean up", cwd }));
    const types = events.map((event) => event.type);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("rm -rf ..");

    // The Skill's contract: a dangerous tool that was refused never reports a start.
    // The SDK fires tool_execution_start *before* calling execute, so without the
    // ToolStartGate the trace read tool_started -> human_input_requested, and a
    // declined action looked like one that had begun.
    expect(types).toContain("human_input_requested");
    expect(types).toContain("human_input_received");
    expect(types).not.toContain("tool_started");
    expect(types).not.toContain("tool_completed");

    // Refused capability, so missing material rather than a silent success.
    expect(terminals(events)[0]).toMatchObject({ type: "run_completed", status: "partial" });
  }, 30_000);

  it("reports the start only after an approval, in the Core loop's order", async () => {
    const cwd = await tempDir();

    // Gated by policy, and harmless to actually run in a throwaway directory: there is
    // no repository here, so git fails quickly and its non-zero exit is reported as
    // information. (Deliberately not `rm -rf ..`, which would really delete the parent
    // of the temp directory if the approval path ever went wrong.)
    const stub = await startStubProvider([
      { toolCall: { name: "bash", args: { command: "git push --force" } } },
      { text: "Nothing to push." },
    ]);
    providers.push(stub);
    const { model, modelRuntime } = await stubModel(stub);

    const tools = selectTools(["bash"]);
    const runtime = await createRuntime({
      cwd,
      driver: piDriver({
        cwd,
        model,
        modelRuntime,
        tools,
        toolPort: createToolRegistry(tools, { cwd }),
        gate: destructiveCommandPolicy(),
      }),
      runLog: new InMemoryRunLog(),
      sessionStore: new InMemorySessionStore(nextId),
      newId: nextId,
      humanInput: async () => "yes",
    });

    const events = await collect(runtime.run({ id: "live-gate-ok", input: "push", cwd }));
    const types = events.map((event) => event.type);

    // Ask first, then report the start.
    expect(types.indexOf("human_input_requested")).toBeGreaterThan(-1);
    expect(types.indexOf("human_input_received")).toBeLessThan(types.indexOf("tool_started"));
    expect(types).toContain("tool_completed");
    expect(terminals(events)[0]).toMatchObject({ type: "run_completed" });
  }, 30_000);

  it("recovers the run from its own durable log", async () => {
    const cwd = await tempDir();
    await fs.writeFile(path.join(cwd, "answer.ts"), "export const answer = 42;\n", "utf8");

    const stub = await startStubProvider([
      { toolCall: { name: "read", args: { path: "answer.ts" } } },
      { text: "Done." },
    ]);
    providers.push(stub);
    const { model, modelRuntime } = await stubModel(stub);

    const tools = selectTools(["read"]);
    const runLog = new InMemoryRunLog();
    const runtime = await createRuntime({
      cwd,
      driver: piDriver({
        cwd,
        model,
        modelRuntime,
        tools,
        toolPort: createToolRegistry(tools, { cwd }),
      }),
      runLog,
      sessionStore: new InMemorySessionStore(nextId),
      newId: nextId,
    });

    const task = { id: "live-recover", input: "read it", cwd };
    const events = await collect(runtime.run(task));
    const runId = events[0]?.runId as string;

    // The real path's state must be reconstructible from what it persisted.
    const recovered = await runtime.recover(runId, task);
    expect(recovered.terminal?.type).toBe("run_completed");
    expect(recovered.state.observations).toHaveLength(1);
    expect(recovered.state.toolCalls).toBe(1);
  }, 30_000);
});


/**
 * Assemble the production stack around a stub provider.
 *
 * These tests exist to exercise code that was previously only *believed* correct: the
 * driver's budget enforcement was written with no way to reach it, cancellation had only
 * ever been tested against a fake driver, and tool-error classification had never seen a
 * real SDK error envelope.
 */
async function liveRuntime(options: {
  cwd: string;
  stub: StubProvider;
  toolNames: readonly string[];
  budget?: Partial<RunBudget>;
  humanInput?: HumanInputChannel;
  gate?: GatePolicy;
  sleep?: Sleeper;
}): Promise<{ runtime: Awaited<ReturnType<typeof createRuntime>> }> {
  const { model, modelRuntime } = await stubModel(options.stub);
  const tools = selectTools(options.toolNames);

  return {
    runtime: await createRuntime({
      cwd: options.cwd,
      driver: piDriver({
        cwd: options.cwd,
        model,
        modelRuntime,
        tools,
        toolPort: createToolRegistry(tools, { cwd: options.cwd }),
        ...(options.gate === undefined ? {} : { gate: options.gate }),
        maxRetries: 0,
      }),
      runLog: new InMemoryRunLog(),
      sessionStore: new InMemorySessionStore(nextId),
      newId: nextId,
      ...(options.budget === undefined ? {} : { budget: { ...DEFAULT_BUDGET, ...options.budget } }),
      ...(options.humanInput === undefined ? {} : { humanInput: options.humanInput }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    }),
  };
}

describe("live: budgets, cancellation and failure on the real path", () => {
  it("enforces the tool budget", async () => {
    const cwd = await tempDir();
    // The stub repeats its last turn, so it asks for a tool forever.
    const stub = await startStubProvider([
      { toolCall: { name: "ls", args: {} } },
    ]);
    providers.push(stub);

    const { runtime } = await liveRuntime({
      cwd,
      stub,
      toolNames: ["ls"],
      budget: { maxToolCalls: 1, maxIterations: 20 },
    });

    const events = await collect(runtime.run({ id: "budget-tools", input: "list", cwd }));

    // Written in an earlier round with no way to reach it; this is the first time the
    // driver's own budget check has actually run.
    expect(terminals(events)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "budget_tools" },
    });
  }, 30_000);

  it("enforces the iteration budget", async () => {
    const cwd = await tempDir();
    const stub = await startStubProvider([{ toolCall: { name: "ls", args: {} } }]);
    providers.push(stub);

    const { runtime } = await liveRuntime({
      cwd,
      stub,
      toolNames: ["ls"],
      budget: { maxIterations: 1, maxToolCalls: 50 },
    });

    const events = await collect(runtime.run({ id: "budget-iters", input: "list", cwd }));

    expect(terminals(events)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "budget_iterations" },
    });
  }, 30_000);

  it("cancels a run that is waiting on the provider", async () => {
    const cwd = await tempDir();
    const stub = await startStubProvider([{ text: "too late", delayMs: 5_000 }]);
    providers.push(stub);

    const { runtime } = await liveRuntime({ cwd, stub, toolNames: ["ls"] });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);

    const events = await collect(
      runtime.run({ id: "cancel", input: "slow", cwd }, controller.signal),
    );

    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]?.type).toBe("run_cancelled");
  }, 30_000);

  it("distinguishes a time budget expiry from a cancellation", async () => {
    const cwd = await tempDir();
    const stub = await startStubProvider([{ text: "too late", delayMs: 5_000 }]);
    providers.push(stub);

    const { runtime } = await liveRuntime({
      cwd,
      stub,
      toolNames: ["ls"],
      budget: { timeoutMs: 500 },
    });

    const events = await collect(runtime.run({ id: "timeout", input: "slow", cwd }));

    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "budget_timeout" },
    });
  }, 30_000);

  it("classifies a real tool failure with its message intact", async () => {
    const cwd = await tempDir();
    // `read` on a file that does not exist: our tool throws, the SDK wraps it in the
    // AgentToolResult envelope, and the classification has to survive that.
    const stub = await startStubProvider([
      { toolCall: { name: "read", args: { path: "missing.ts" } } },
      { text: "I could not read it." },
    ]);
    providers.push(stub);

    const { runtime } = await liveRuntime({ cwd, stub, toolNames: ["read"] });

    const events = await collect(runtime.run({ id: "tool-error", input: "read it", cwd }));
    const observation = events.find((event) => event.type === "observation_added");

    const serialized = JSON.stringify(observation);
    expect(serialized).toContain("missing.ts");
    // Before the envelope fix this was a JSON blob classified `runtime_error`.
    expect(serialized).toContain("invalid_tool");
    expect(serialized).not.toContain('{\"content\"');

    // A failed tool is evidence, not an absent capability: the run still completes.
    expect(terminals(events)[0]).toMatchObject({ type: "run_completed", status: "complete" });
  }, 30_000);

  it("handles several tool calls in one turn", async () => {
    const cwd = await tempDir();
    await fs.writeFile(path.join(cwd, "a.ts"), "export const a = 1;\n", "utf8");
    await fs.writeFile(path.join(cwd, "b.ts"), "export const b = 2;\n", "utf8");

    // Real models batch tool calls constantly — reading two files in one turn is the
    // ordinary case, and every stub before this one could only ask for a single tool.
    const stub = await startStubProvider([
      {
        toolCalls: [
          { name: "read", args: { path: "a.ts" } },
          { name: "read", args: { path: "b.ts" } },
        ],
      },
      { text: "Both read." },
    ]);
    providers.push(stub);

    const { runtime } = await liveRuntime({ cwd, stub, toolNames: ["read"] });

    const events = await collect(runtime.run({ id: "multi", input: "read both", cwd }));
    const types = events.map((event) => event.type);

    expect(types.filter((type) => type === "tool_started")).toHaveLength(2);
    expect(types.filter((type) => type === "tool_completed")).toHaveLength(2);
    expect(types.filter((type) => type === "observation_added")).toHaveLength(2);

    // Both results reached the model: the second request carries both files.
    expect(stub.requestBodies).toHaveLength(2);
    expect(stub.requestBodies[1]).toContain("export const a = 1");
    expect(stub.requestBodies[1]).toContain("export const b = 2");

    expect(terminals(events)[0]).toMatchObject({ type: "run_completed", status: "complete" });

    // Every call is accounted for in the state replay rebuilds.
    const runId = events[0]?.runId as string;
    const recovered = await runtime.recover(runId, { id: "multi", input: "read both", cwd });
    expect(recovered.state.toolCalls).toBe(2);
    expect(recovered.state.observations).toHaveLength(2);
  }, 30_000);

  it("keeps two runs in one session independent", async () => {
    const cwd = await tempDir();
    await fs.writeFile(path.join(cwd, "secret-plan.txt"), "PROJECT ORCHID\n", "utf8");

    const stub = await startStubProvider([
      { toolCall: { name: "read", args: { path: "secret-plan.txt" } } },
      { text: "First run done." },
      { text: "Second run done." },
    ]);
    providers.push(stub);

    const { runtime } = await liveRuntime({ cwd, stub, toolNames: ["read"] });

    const first = await collect(runtime.run({ id: "run-1", input: "read the plan", cwd }));
    const second = await collect(runtime.run({ id: "run-2", input: "unrelated task", cwd }));

    expect(terminals(first)[0]).toMatchObject({ type: "run_completed" });
    expect(terminals(second)[0]).toMatchObject({ type: "run_completed" });
    expect(first[0]?.runId).not.toBe(second[0]?.runId);

    // The second run must not inherit the first run's conversation. Each driver invocation
    // opens a fresh SDK session, so the provider request for run two carries nothing from
    // run one — which is the whole point of a session being a container for runs rather
    // than a single growing conversation.
    expect(stub.requestBodies).toHaveLength(3);
    expect(stub.requestBodies[2]).not.toContain("PROJECT ORCHID");
    expect(stub.requestBodies[2]).toContain("unrelated task");

    // And the run log keeps them apart.
    const runIds = new Set([first[0]?.runId, second[0]?.runId]);
    expect(runIds.size).toBe(2);
  }, 30_000);

  it("counts turns correctly across a multi-turn run", async () => {
    const cwd = await tempDir();

    // A realistic shape rather than one repeating turn: three actions, then an answer —
    // four model calls. The iteration-budget fix was verified with a stub that repeated a
    // single turn, which exercises the counter differently.
    const script: StubTurn[] = [
      { toolCall: { name: "ls", args: {} } },
      { toolCall: { name: "ls", args: {} } },
      { toolCall: { name: "ls", args: {} } },
      { text: "Finished after three looks." },
    ];

    const withinBudget = await startStubProvider(script);
    providers.push(withinBudget);
    const { runtime } = await liveRuntime({
      cwd,
      stub: withinBudget,
      toolNames: ["ls"],
      budget: { maxIterations: 4, maxToolCalls: 10 },
    });

    const finished = await collect(runtime.run({ id: "turns-ok", input: "look around", cwd }));

    expect(terminals(finished)[0]).toMatchObject({ type: "run_completed", status: "complete" });
    expect(finished.filter((event) => event.type === "tool_started")).toHaveLength(3);
    // Four model calls reached the provider, and the run needed all four.
    expect(withinBudget.requestBodies).toHaveLength(4);

    // One turn short: the answering turn is refused.
    const short = await startStubProvider(script);
    providers.push(short);
    const { runtime: tight } = await liveRuntime({
      cwd,
      stub: short,
      toolNames: ["ls"],
      budget: { maxIterations: 3, maxToolCalls: 10 },
    });

    const refused = await collect(tight.run({ id: "turns-tight", input: "look around", cwd }));

    expect(terminals(refused)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "budget_iterations" },
    });
  }, 30_000);

  it("reports tokens when the endpoint reports them", async () => {
    const cwd = await tempDir();
    const stub = await startStubProvider([
      { text: "Counted.", usage: { prompt_tokens: 1_234, completion_tokens: 56 } },
    ]);
    providers.push(stub);

    const { runtime } = await liveRuntime({ cwd, stub, toolNames: ["ls"] });

    const events = await collect(runtime.run({ id: "usage", input: "hello", cwd }));
    const reported = events.find((event) => event.type === "usage_reported");

    // The exit criterion is that usage answers the cost question; this is the first test
    // to check it against a provider that actually reports usage.
    expect(reported).toMatchObject({
      type: "usage_reported",
      usage: { inputTokens: 1_234, outputTokens: 56 },
    });
  }, 30_000);

  it("reports unknown rather than zero when the endpoint reports nothing", async () => {
    const cwd = await tempDir();
    const stub = await startStubProvider([{ text: "Uncounted." }]);
    providers.push(stub);

    const { runtime } = await liveRuntime({ cwd, stub, toolNames: ["ls"] });

    const events = await collect(runtime.run({ id: "usage-none", input: "hello", cwd }));
    const reported = events.find((event) => event.type === "usage_reported");

    const usage = (reported as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.outputTokens).toBeUndefined();
  }, 30_000);

  it("retries a retryable provider failure and then succeeds", async () => {
    const cwd = await tempDir();
    const stub = await startStubProvider([
      { httpStatus: 503 },
      { httpStatus: 503 },
      { text: "Recovered." },
    ]);
    providers.push(stub);

    const tools = selectTools(["ls"]);
    const { model, modelRuntime } = await stubModel(stub);
    const runtime = await createRuntime({
      cwd,
      driver: piDriver({
        cwd,
        model,
        modelRuntime,
        tools,
        toolPort: createToolRegistry(tools, { cwd }),
        // The SDK's own request retry would hide the Runtime's, so disable it here.
        maxRetries: 0,
      }),
      runLog: new InMemoryRunLog(),
      sessionStore: new InMemorySessionStore(nextId),
      newId: nextId,
      budget: { ...DEFAULT_BUDGET, maxRetries: 2 },
      sleep: async () => true,
    });

    const events = await collect(runtime.run({ id: "retry", input: "hello", cwd }));

    expect(events.filter((event) => event.type === "retry_scheduled").length).toBeGreaterThan(0);
    expect(terminals(events)[0]).toMatchObject({ type: "run_completed" });
  }, 30_000);
});
