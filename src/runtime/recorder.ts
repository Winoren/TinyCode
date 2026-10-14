/**
 * Event recording — the durable envelope.
 *
 * Only the Runtime may mint `runId` / `sequence` / `timestamp`. Drivers emit
 * `EventDraft`s precisely so they cannot invent their own ordering, and every event
 * in a run passes through one recorder, which is what makes "monotonic sequence"
 * a property of the system rather than a convention.
 *
 * Persistence is fire-and-forget: auditing is a side channel, and a slow or failing
 * write must never stall or crash the agent loop. `flush()` exists so tests and
 * shutdown paths can still await durability deliberately.
 */

import { identityRedactor, redactValue, type Redactor } from "../core/redact.ts";
import type { AgentEvent, EventDraft } from "../core/contracts.ts";
import type { RunLog } from "./run-log.ts";

export class EventRecorder {
  private sequence = 0;
  private readonly pending = new Set<Promise<void>>();
  private failureCount = 0;

  constructor(
    private readonly runId: string,
    private readonly runLog: RunLog,
    private readonly now: () => number,
    private readonly onPersistenceError: ((error: unknown) => void) | undefined = undefined,
    private readonly redact: Redactor = identityRedactor,
  ) {}

  record(draft: EventDraft): AgentEvent {
    // Redact on the way in, so an event that is handed to a consumer and an event
    // that reaches disk are the same value. Redacting only at the write step would
    // leave the live stream leaky.
    const safe = this.redact.size === 0 ? draft : redactValue(draft, this.redact);
    const event = {
      ...safe,
      runId: this.runId,
      sequence: this.sequence,
      timestamp: this.now(),
    } as AgentEvent;
    this.sequence += 1;

    const write = this.runLog.appendEvent(event).catch((error: unknown) => {
      // Audit is a side channel: count it, report it, do not fail the run.
      this.failureCount += 1;
      this.onPersistenceError?.(error);
    });
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));

    return event;
  }

  /** Await every write issued so far. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  get persistenceFailures(): number {
    return this.failureCount;
  }

  get outstandingWrites(): number {
    return this.pending.size;
  }
}
