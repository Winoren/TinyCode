/**
 * The typed IPC contract between the main process and the renderer.
 *
 * This is the only vocabulary the two processes share. Everything crossing the
 * boundary is JSON-safe: events arrive already redacted by the Runtime, and
 * errors cross as `ApiResult`, never as thrown exceptions.
 */

import type { AgentEvent, Run } from "tinycode/dist/core/contracts.js";

/** Identity of the assembled harness, sent once per run after bootstrap. */
export interface HostRunInfo {
  modelLabel: string;
  tools: readonly string[];
  storeDir: string;
  sessionId: string;
}

/** Main → renderer. One union, one channel, so ordering is observable. */
export type HostMessage =
  | { kind: "run-info"; info: HostRunInfo }
  | { kind: "event"; event: AgentEvent }
  | { kind: "human-input-request"; requestId: number; question: string }
  | { kind: "host-error"; message: string }
  | { kind: "run-active"; active: boolean };

/** Errors cross the boundary with their message intact, per the Result pattern. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface InitialState {
  /** The workspace the window opens with (env override, else the home directory). */
  workspace: string;
  /** True when the host was started with the deterministic fake driver (E2E). */
  fakeMode: boolean;
}

/** What the preload bridge exposes as `window.tinycode`. */
export interface DesktopApi {
  startRun(task: string, cwd: string): Promise<ApiResult<null>>;
  cancelRun(): Promise<ApiResult<null>>;
  answerHuman(requestId: number, value: unknown): Promise<ApiResult<null>>;
  pickWorkspace(): Promise<ApiResult<string | null>>;
  listRuns(cwd: string): Promise<ApiResult<Run[]>>;
  loadRun(cwd: string, runId: string): Promise<ApiResult<{ run: Run; events: AgentEvent[] }>>;
  getInitialState(): Promise<ApiResult<InitialState>>;
  /** Registers a listener for host messages; returns the unsubscribe function. */
  onHostMessage(listener: (message: HostMessage) => void): () => void;
}
