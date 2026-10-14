/**
 * Golden transcript regression tests.
 *
 * Each fixture is a real run's complete event log, pinned. The corpus exists so that a
 * change in the event vocabulary, in replay semantics, or in the SDK adapter cannot
 * land silently: if semantics move, these assertions stop matching and the change has
 * to be acknowledged by regenerating the corpus deliberately
 * (`npx tsx scripts/generate-golden.ts`).
 *
 * The structural invariants are asserted independently of the stored summary, so a
 * corrupted fixture is caught even if someone regenerates both sides from broken code.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentEvent, Task } from "../src/core/contracts.ts";
import { replayAgentState } from "../src/core/replay.ts";

const FIXTURE_DIRECTORY = path.join(import.meta.dirname, "..", "fixtures", "golden");

interface GoldenSummary {
  scenario: string;
  terminalType: string | null;
  terminalStatus: string | null;
  missingMaterial: string[];
  eventCount: number;
  observationCount: number;
  transcriptLength: number;
  toolCalls: number;
  iteration: number;
  eventTypes: string[];
}

interface GoldenIndex {
  fixtures: { name: string }[];
}

const TASK: Task = { id: "golden-task", input: "make the failing test pass", cwd: "/workspace" };

async function loadFixture(name: string): Promise<{ events: AgentEvent[]; expected: GoldenSummary }> {
  const raw = await fs.readFile(path.join(FIXTURE_DIRECTORY, `${name}.jsonl`), "utf8");
  const events = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AgentEvent);
  const expected = JSON.parse(
    await fs.readFile(path.join(FIXTURE_DIRECTORY, `${name}.expected.json`), "utf8"),
  ) as GoldenSummary;
  return { events, expected };
}

const index = JSON.parse(
  await fs.readFile(path.join(FIXTURE_DIRECTORY, "index.json"), "utf8"),
) as GoldenIndex;

const names = index.fixtures.map((fixture) => fixture.name);

describe("golden corpus", () => {
  it("covers more than one terminal state", async () => {
    const terminals = new Set<string | null>();
    for (const name of names) {
      terminals.add((await loadFixture(name)).expected.terminalType);
    }
    // A corpus where every run succeeds cannot detect a regression in failure handling.
    expect(terminals.size).toBeGreaterThan(1);
    expect(names.length).toBeGreaterThanOrEqual(5);
  });
});

describe.each(names)("golden fixture %s", (name) => {
  it("has a strictly monotonic, gap-free sequence from zero", async () => {
    const { events } = await loadFixture(name);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, i) => i));
  });

  it("shares one runId and starts with run_started", async () => {
    const { events } = await loadFixture(name);
    const runIds = new Set(events.map((event) => event.runId));
    expect(runIds.size).toBe(1);
    expect(events[0]?.type).toBe("run_started");
  });

  it("contains exactly one terminal event", async () => {
    const { events } = await loadFixture(name);
    const terminals = events.filter((event) =>
      ["run_completed", "run_failed", "run_cancelled"].includes(event.type),
    );
    expect(terminals).toHaveLength(1);
    // And it is last: nothing may follow a run's terminal state.
    expect(terminals[0]).toBe(events.at(-1));
  });

  it("replays to the pinned summary", async () => {
    const { events, expected } = await loadFixture(name);
    const { state, terminal } = replayAgentState(events, TASK);

    expect(state.observations).toHaveLength(expected.observationCount);
    expect(state.transcript).toHaveLength(expected.transcriptLength);
    expect(state.toolCalls).toBe(expected.toolCalls);
    expect(state.iteration).toBe(expected.iteration);
    expect(terminal?.type).toBe(expected.terminalType);
    expect(events).toHaveLength(expected.eventCount);

    if (terminal?.type === "run_completed") {
      expect(terminal.status).toBe(expected.terminalStatus);
      expect(terminal.missingMaterial ?? []).toEqual(expected.missingMaterial);
    } else if (terminal?.type === "run_failed") {
      expect(terminal.error.code).toBe(expected.terminalStatus);
    }
  });

  it("replays deterministically and independently of event order", async () => {
    const { events } = await loadFixture(name);

    const first = replayAgentState(events, TASK);
    const second = replayAgentState(events, TASK);
    const shuffled = replayAgentState([...events].reverse(), TASK);

    expect(second.state).toEqual(first.state);
    expect(shuffled.state).toEqual(first.state);
    expect(shuffled.terminal?.type).toBe(first.terminal?.type);
  });
});
