/**
 * Generate the golden transcript corpus.
 *
 * Run deliberately, not in CI:
 *
 *   npx tsx scripts/generate-golden.ts
 *
 * Each fixture is a real run's complete event log plus a summary of the state it
 * replays to. The corpus exists so that a change in the event vocabulary, in replay
 * semantics, or in the SDK adapter cannot land silently — if semantics move, these
 * fixtures stop matching and the change must be acknowledged by regenerating them.
 *
 * Determinism is injected (`now`, `newId`), not hoped for: without a fixed clock and
 * id source, timestamps and tool-call ids would make every regeneration a diff.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { fakeTools, scriptedModel } from "../src/adapters/fake/index.ts";
import {
  initialState,
  type AgentEvent,
  type Decision,
  type Task,
} from "../src/core/contracts.ts";
import { coreLoopDriver, type RunDriver } from "../src/core/loop.ts";
import { replayAgentState } from "../src/core/replay.ts";
import { AgentRuntime } from "../src/runtime/runtime.ts";
import { InMemoryRunLog } from "../src/runtime/run-log.ts";
import { InMemorySessionStore } from "../src/runtime/session-store.ts";

const OUTPUT_DIRECTORY = path.join(import.meta.dirname, "..", "fixtures", "golden");

interface Scenario {
  name: string;
  task: Task;
  driver: () => RunDriver;
  humanInput?: (question: string) => Promise<unknown>;
  /** Per-scenario so one fixture can exercise exhaustion without starving the rest. */
  budget?: { maxIterations: number; maxToolCalls: number };
}

/** Generous by default: these fixtures demonstrate semantics, not budget edges. */
const DEFAULT_SCENARIO_BUDGET = { maxIterations: 8, maxToolCalls: 16 };

const TASK: Task = { id: "golden-task", input: "make the failing test pass", cwd: "/workspace" };

const SCENARIOS: Scenario[] = [
  {
    name: "01-respond-only",
    task: TASK,
    driver: () =>
      coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "Nothing to change." }]),
        tools: fakeTools({}),
      }),
  },
  {
    name: "02-read-edit-verify",
    task: TASK,
    driver: () =>
      coreLoopDriver({
        model: scriptedModel([
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
        tools: fakeTools({
          read: () => "export const add = (a, b) => a - b;",
          edit: () => ({ replaced: 1 }),
          bash: () => ({ exitCode: 0, stdout: "PASS" }),
        }),
      }),
  },
  {
    name: "03-tool-failure-isolated",
    task: TASK,
    driver: () =>
      coreLoopDriver({
        model: scriptedModel([
          { kind: "call_tool", intent: { name: "bash", arguments: { command: "npm test" } } },
          { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
          { kind: "respond", content: "The test failed; I read the source anyway." },
        ]),
        tools: fakeTools({
          bash: () => {
            throw new Error("exit 1");
          },
          read: () => "file body",
        }),
      }),
  },
  {
    name: "04-unknown-tool-partial",
    task: TASK,
    driver: () =>
      coreLoopDriver({
        model: scriptedModel([
          { kind: "call_tool", intent: { name: "deploy", arguments: {} } },
          { kind: "respond", content: "I cannot deploy: no such tool." },
        ]),
        tools: fakeTools({ read: () => "ok" }),
      }),
  },
  {
    name: "05-human-confirmation",
    task: TASK,
    driver: () =>
      coreLoopDriver({
        model: scriptedModel([
          { kind: "ask_human", question: "Rewrite the migration in place?" },
          { kind: "respond", content: "Left the migration untouched." },
        ]),
        tools: fakeTools({}),
      }),
    humanInput: async () => "no, do not touch it",
  },
  {
    name: "06-budget-exhausted",
    budget: { maxIterations: 3, maxToolCalls: 16 },
    task: TASK,
    driver: () =>
      coreLoopDriver({
        // Never stops asking for the same tool: the iteration budget must end it.
        model: (() => {
          const decision: Decision = {
            kind: "call_tool",
            intent: { name: "read", arguments: { path: "a.ts" } },
          };
          return {
            async decide() {
              return decision;
            },
          };
        })(),
        tools: fakeTools({ read: () => "same" }),
      }),
  },
];

/** A clock that advances one millisecond per reading, so every run is byte-stable. */
function deterministicClock(): () => number {
  let tick = 0;
  return () => {
    tick += 1;
    return 1_700_000_000_000 + tick;
  };
}

function deterministicIds(): () => string {
  let counter = 0;
  return () => `id-${(counter += 1)}`;
}

await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });

const index: { name: string; description: string }[] = [];

for (const scenario of SCENARIOS) {
  const runLog = new InMemoryRunLog();
  const runtime = new AgentRuntime(
    { id: "golden-session", createdAt: 1_700_000_000_000, runs: [] },
    {
      cwd: scenario.task.cwd,
      driver: scenario.driver(),
      runLog,
      sessionStore: new InMemorySessionStore(deterministicIds()),
      now: deterministicClock(),
      newId: deterministicIds(),
      model: "fake-model",
      budget: {
        ...(scenario.budget ?? DEFAULT_SCENARIO_BUDGET),
        maxRetries: 0,
        timeoutMs: 60_000,
      },
      ...(scenario.humanInput === undefined ? {} : { humanInput: scenario.humanInput }),
    },
  );

  const events: AgentEvent[] = [];
  for await (const event of runtime.run(scenario.task)) events.push(event);

  const runId = events[0]?.runId as string;
  const { state, terminal } = replayAgentState(events, scenario.task);

  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  await fs.writeFile(path.join(OUTPUT_DIRECTORY, `${scenario.name}.jsonl`), `${lines}\n`, "utf8");

  const summary = {
    scenario: scenario.name,
    terminalType: terminal?.type ?? null,
    terminalStatus:
      terminal === undefined
        ? null
        : terminal.type === "run_completed"
          ? terminal.status
          : terminal.type === "run_failed"
            ? terminal.error.code
            : null,
    missingMaterial: terminal?.type === "run_completed" ? (terminal.missingMaterial ?? []) : [],
    eventCount: events.length,
    observationCount: state.observations.length,
    transcriptLength: state.transcript.length,
    toolCalls: state.toolCalls,
    iteration: state.iteration,
    eventTypes: [...new Set(events.map((event) => event.type))].sort(),
  };
  await fs.writeFile(
    path.join(OUTPUT_DIRECTORY, `${scenario.name}.expected.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  index.push({ name: scenario.name, description: `${summary.terminalType} / ${summary.eventCount} events` });
  console.log(
    `${scenario.name.padEnd(26)} ${String(summary.eventCount).padStart(3)} events  ` +
      `${String(terminal?.type)}${summary.terminalStatus === null ? "" : ` (${String(summary.terminalStatus)})`}`,
  );
}

await fs.writeFile(
  path.join(OUTPUT_DIRECTORY, "index.json"),
  `${JSON.stringify({ generatedBy: "scripts/generate-golden.ts", fixtures: index }, null, 2)}\n`,
  "utf8",
);

// Fail loudly if a fixture somehow lacks a terminal state: a truncated golden run
// would silently weaken every assertion built on it.
for (const scenario of SCENARIOS) {
  const events = (await fs.readFile(path.join(OUTPUT_DIRECTORY, `${scenario.name}.jsonl`), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AgentEvent);
  const { terminal } = replayAgentState(events, scenario.task);
  if (terminal === undefined) throw new Error(`${scenario.name} produced no terminal event`);
}

console.log(`\nwrote ${SCENARIOS.length} fixtures to ${OUTPUT_DIRECTORY}`);
