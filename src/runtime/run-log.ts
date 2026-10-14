/**
 * The append-only event log.
 *
 * The log is the source of truth for a run; a snapshot is only a cache. Two
 * properties are load-bearing:
 *
 * - **`sequence` is monotonic per run**, so replay is ordering-stable and
 *   idempotent.
 * - **a torn final line is tolerated.** A crash can leave a half-written JSON line;
 *   a recovery path that throws on its own crash artefact is not a recovery path.
 *   `parseEventLog` reports what it skipped instead of hiding it.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { AgentEvent, Run } from "../core/contracts.ts";

export interface RunLog {
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(runId: string): Promise<AgentEvent[]>;
  saveRun(run: Run): Promise<void>;
  loadRun(runId: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
}

export interface ParsedEventLog {
  events: AgentEvent[];
  /** 1-based line numbers that could not be parsed. Empty is the healthy case. */
  skippedLineNumbers: number[];
}

/**
 * Parse a JSONL event log.
 *
 * Lines are not required to be sorted — `replayAgentState` sorts by `sequence` —
 * but they are returned in file order so a caller can reconstruct append order.
 */
export function parseEventLog(raw: string): ParsedEventLog {
  const events: AgentEvent[] = [];
  const skippedLineNumbers: number[] = [];

  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isAgentEvent(parsed)) {
        skippedLineNumbers.push(index + 1);
        continue;
      }
      events.push(parsed);
    } catch {
      skippedLineNumbers.push(index + 1);
    }
  }

  return { events, skippedLineNumbers };
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AgentEvent>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.sequence === "number" &&
    typeof candidate.timestamp === "number"
  );
}

/** In-memory log. Used by tests and by a runtime that explicitly wants no durability. */
export class InMemoryRunLog implements RunLog {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly runs = new Map<string, Run>();

  async appendEvent(event: AgentEvent): Promise<void> {
    const existing = this.events.get(event.runId);
    if (existing === undefined) {
      this.events.set(event.runId, [event]);
      return;
    }
    existing.push(event);
  }

  async listEvents(runId: string): Promise<AgentEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }

  async saveRun(run: Run): Promise<void> {
    this.runs.set(run.runId, { ...run });
  }

  async loadRun(runId: string): Promise<Run | undefined> {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : { ...run };
  }

  async listRuns(): Promise<Run[]> {
    return [...this.runs.values()].map((run) => ({ ...run }));
  }
}

/**
 * JSONL log on disk: one append-only file per run, plus one file of run metadata.
 *
 * Appends to the same file are serialized through a per-key promise chain, because
 * concurrent `appendFile` calls can interleave and produce a torn line even without
 * a crash.
 */
export class JsonlRunLog implements RunLog {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly runsDirectory: string;
  private readonly runsIndexFile: string;

  constructor(private readonly directory: string) {
    this.runsDirectory = path.join(directory, "runs");
    this.runsIndexFile = path.join(directory, "runs.jsonl");
  }

  static async open(directory: string): Promise<JsonlRunLog> {
    await fs.mkdir(path.join(directory, "runs"), { recursive: true });
    return new JsonlRunLog(directory);
  }

  private eventFile(runId: string): string {
    return path.join(this.runsDirectory, `${sanitize(runId)}.jsonl`);
  }

  /** Serialize work per key so two appends never interleave inside one file. */
  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    await this.serialize(event.runId, async () => {
      await fs.appendFile(this.eventFile(event.runId), `${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async listEvents(runId: string): Promise<AgentEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.eventFile(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseEventLog(raw).events;
  }

  async saveRun(run: Run): Promise<void> {
    // Snapshot synchronously, before yielding to the serialized queue. The caller's
    // `run` object is mutable and its status changes during a run, so stringifying
    // inside the queued closure would persist whatever the status had become by the
    // time the queue drained — not the state being recorded.
    const snapshot: Run = { ...run };
    await this.serialize("__runs__", async () => {
      await fs.appendFile(this.runsIndexFile, `${JSON.stringify(snapshot)}\n`, "utf8");
    });
  }

  async loadRun(runId: string): Promise<Run | undefined> {
    return (await this.listRuns()).find((run) => run.runId === runId);
  }

  async listRuns(): Promise<Run[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.runsIndexFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    // The index is append-only, so one run appears once per state change. Folding by
    // `runId` keeps the newest record while preserving first-seen order. Without
    // this, listing runs returns the same run several times with stale statuses —
    // and the in-memory log, which is a Map, would disagree with this one.
    const latest = new Map<string, Run>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const run = JSON.parse(line) as Run;
        if (typeof run?.runId === "string") latest.set(run.runId, run);
      } catch {
        continue;
      }
    }
    return [...latest.values()];
  }
}

/** Keep a caller-supplied id from escaping the log directory. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
