/**
 * The desktop host: assembles TinyCode through `bootstrap()` and pumps each
 * run's event stream to the renderer over IPC.
 *
 * The host adds no behavior the CLI does not have — same bootstrap seam, same
 * human-input channel shape, same cancellation semantics (a fired caller signal
 * ends the run as `run_cancelled`). The only new wiring is transport: events
 * cross the process boundary instead of a terminal renderer. One window, one
 * active run; a second start is refused rather than queued.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { dialog, type BrowserWindow, type OpenDialogOptions } from "electron";
import { bootstrap } from "tinycode/dist/bootstrap.js";
import type { BootstrapOptions } from "tinycode/dist/bootstrap.js";
import type { AgentEvent, Run } from "tinycode/dist/core/contracts.js";
import { JsonlRunLog } from "tinycode/dist/runtime/run-log.js";
import type { CustomEndpoint } from "tinycode/dist/model/registry.js";
import type { HostMessage } from "../shared/protocol.ts";
import { fakeBootstrapOverrides, isFakeMode } from "./fake-run.ts";

const HOST_CHANNEL = "desktop:host-message";

interface ActiveRun {
  controller: AbortController;
}

interface PendingHuman {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class AgentHost {
  private active: ActiveRun | undefined;
  private requestCounter = 0;
  private readonly pendingHuman = new Map<number, PendingHuman>();

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly installRoot: string,
  ) {}

  // ---- run lifecycle ------------------------------------------------------------

  /**
   * Start a run and pump its events. Resolves when the run reaches a terminal
   * event; rejects only when the run could not be assembled (e.g. bad
   * credentials), which the caller reports as an `ApiResult` error.
   */
  async startRun(task: string, cwd: string): Promise<void> {
    if (this.active !== undefined) {
      throw new Error("a run is already active; cancel it before starting another");
    }

    const workspace = path.resolve(cwd);
    const stat = await fs.stat(workspace).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory()) {
      throw new Error(`workspace is not a directory: ${workspace}`);
    }

    const bootstrapped = await bootstrap({
      cwd: workspace,
      ...modelOptions(),
      humanInput: (question, signal) => this.requestHumanInput(question, signal),
      onDiagnostics: (messages) => {
        const text = messages.map((message) => `[schema] ${message}`).join("\n");
        if (text !== "") this.send({ kind: "host-error", message: text });
      },
      // A persistence failure is visible but never fatal — same policy as the CLI.
      onPersistenceError: (error) => {
        this.send({ kind: "host-error", message: `[trace] persist failed: ${describe(error)}` });
      },
      ...(isFakeMode() ? fakeBootstrapOverrides() : {}),
    });

    const controller = new AbortController();
    this.active = { controller };
    this.send({ kind: "run-active", active: true });
    this.send({
      kind: "run-info",
      info: {
        modelLabel: bootstrapped.modelLabel,
        tools: bootstrapped.toolNames,
        storeDir: bootstrapped.storeDir,
        sessionId: bootstrapped.runtime.session.id,
      },
    });

    const taskId = `desktop-${Date.now().toString(36)}`;
    try {
      for await (const event of bootstrapped.runtime.run(
        { id: taskId, input: task, cwd: workspace },
        controller.signal,
      )) {
        this.send({ kind: "event", event });
      }
    } catch (error) {
      // The Runtime guarantees exactly one terminal event, so reaching here means
      // something outside the run contract broke; say so honestly.
      this.send({ kind: "host-error", message: `run pump failed: ${describe(error)}` });
    } finally {
      this.active = undefined;
      this.send({ kind: "run-active", active: false });
    }
  }

  cancelRun(): void {
    if (this.active === undefined) throw new Error("no run is active");
    this.active.controller.abort();
  }

  // ---- human input ---------------------------------------------------------------

  /**
   * The `HumanInputChannel` handed to bootstrap. The question crosses IPC with
   * an id; `answerHuman` resolves the waiting promise. An aborted signal
   * rejects with the signal's reason so the Runtime classifies the run as
   * cancelled, not failed.
   */
  private requestHumanInput(question: string, signal: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.requestCounter += 1;
      const requestId = this.requestCounter;
      const pending: PendingHuman = { resolve, reject };

      const cleanup = (): void => {
        this.pendingHuman.delete(requestId);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason);
      };

      this.pendingHuman.set(requestId, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      this.send({ kind: "human-input-request", requestId, question });
    });
  }

  answerHuman(requestId: number, value: unknown): void {
    const pending = this.pendingHuman.get(requestId);
    if (pending === undefined) {
      throw new Error(`no pending human input request #${requestId}`);
    }
    this.pendingHuman.delete(requestId);
    pending.resolve(value);
  }

  // ---- history (read-only, from the workspace's own store) ------------------------

  async listRuns(cwd: string): Promise<Run[]> {
    return this.runLogFor(cwd).listRuns();
  }

  async loadRun(cwd: string, runId: string): Promise<{ run: Run; events: AgentEvent[] }> {
    const log = this.runLogFor(cwd);
    const [run, events] = await Promise.all([log.loadRun(runId), log.listEvents(runId)]);
    if (run === undefined) throw new Error(`no run with id ${runId} in this workspace`);
    return { run, events };
  }

  private runLogFor(cwd: string): JsonlRunLog {
    // Constructor only computes paths; listing and reading tolerate a missing store.
    return new JsonlRunLog(path.join(path.resolve(cwd), ".tinycode"));
  }

  // ---- workspace picker ------------------------------------------------------------

  async pickWorkspace(): Promise<string | null> {
    const window = this.getWindow();
    const options: OpenDialogOptions = {
      title: "Choose a workspace",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: this.installRoot,
    };
    const result =
      window === null || window.isDestroyed()
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    const chosen = result.filePaths[0];
    return result.canceled || chosen === undefined ? null : chosen;
  }

  // ---- transport --------------------------------------------------------------------

  private send(message: HostMessage): void {
    const window = this.getWindow();
    if (window === null || window.isDestroyed()) return;
    window.webContents.send(HOST_CHANNEL, message);
  }
}

/**
 * Model configuration from the environment, mirroring the CLI's env handling:
 * `TINYCODE_BASE_URL` + `TINYCODE_MODEL` (+ optional `TINYCODE_API_KEY`) name a
 * custom endpoint; a bare `TINYCODE_MODEL` names a hosted `provider/model`;
 * hosted providers may also authenticate through their own key variables.
 */
function modelOptions(): Partial<Pick<BootstrapOptions, "customEndpoint" | "modelSpec">> {
  // Same precedence as the CLI launcher: the real environment wins over the file.
  const baseUrl = process.env.TINYCODE_BASE_URL;
  const model = process.env.TINYCODE_MODEL;
  const apiKey = process.env.TINYCODE_API_KEY;

  if (baseUrl === undefined || baseUrl.trim() === "") {
    return model === undefined ? {} : { modelSpec: model };
  }

  if (model === undefined || model.trim() === "") {
    throw new Error(
      "TINYCODE_BASE_URL is set but TINYCODE_MODEL is missing; the endpoint needs a model name",
    );
  }

  const slash = model.indexOf("/");
  const providerId = slash === -1 ? "custom" : model.slice(0, slash);
  const modelId = slash === -1 ? model : model.slice(slash + 1);
  if (providerId === "" || modelId === "") {
    throw new Error(`malformed TINYCODE_MODEL "${model}"; expected "<model>" or "<provider>/<model>"`);
  }
  const customEndpoint: CustomEndpoint = {
    providerId,
    baseUrl,
    modelId,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
  return { customEndpoint };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
