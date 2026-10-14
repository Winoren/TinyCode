/**
 * Assembly: everything a runnable TinyCode needs, wired in one place.
 *
 * Kept out of the CLI so the same composition can be driven by a test, an SSE
 * server, or another host without duplicating the wiring — and so the fake-driver
 * path and the real-driver path are constructed by the same code.
 *
 * Model resolution happens *before* any store is opened: a missing credential should
 * fail without leaving a `.tinycode/` directory behind.
 */

import path from "node:path";

import { getEnvApiKey } from "@earendil-works/pi-ai/compat";

import { piDriver } from "./adapters/pi/driver.ts";
import { DEFAULT_BUDGET, type RunBudget, type ToolPort } from "./core/contracts.ts";
import type { HumanInputChannel, RunDriver } from "./core/loop.ts";
import { destructiveCommandPolicy, type GatePolicy } from "./core/gate.ts";
import { createRedactor } from "./core/redact.ts";
import { credentialEnvNames, resolveModel } from "./model/registry.ts";
import {
  AgentRuntime,
  createRuntime,
  defaultIdGenerator,
  JsonlRunLog,
  JsonSessionStore,
  type RunLog,
  type SessionStore,
} from "./runtime/index.ts";
import { scrubEnvironment } from "./tools/env.ts";
import { createToolRegistry, selectTools } from "./tools/index.ts";
import type { AnyToolDefinition } from "./tools/types.ts";
import { DEFAULT_TOOL_NAMES } from "./cli/args.ts";

export interface BootstrapOptions {
  cwd: string;
  modelSpec?: string;
  toolNames?: readonly string[];
  budget?: Partial<RunBudget>;
  humanInput?: HumanInputChannel;
  storeDir?: string;
  onPersistenceError?: (error: unknown) => void;
  /** Inject a driver instead of the Pi adapter (used by tests and the fake path). */
  driver?: RunDriver;
  /**
   * Build a driver from the assembled tool port. Lets a caller exercise the *real*
   * tool registry, Runtime and RunLog with only the model swapped out.
   */
  driverFactory?: (context: {
    toolPort: ToolPort;
    tools: readonly AnyToolDefinition[];
    cwd: string;
  }) => RunDriver;
  runLog?: RunLog;
  sessionStore?: SessionStore;
  /**
   * Confirmation policy. Defaults to gating destructive shell commands; pass
   * `allowAllPolicy()` to disable gating, or a custom policy to change what counts.
   */
  gate?: GatePolicy;
  /**
   * Extra credential values to redact from every event. Provider keys found in the
   * environment are added automatically; this is for callers that hold a secret the
   * resolver cannot see.
   */
  secrets?: readonly string[];
  /** Surface tool-schema conversion problems. */
  onDiagnostics?: (diagnostics: readonly string[]) => void;
}

export interface Bootstrapped {
  runtime: AgentRuntime;
  modelLabel: string;
  toolNames: string[];
  diagnostics: string[];
  storeDir: string;
  envWiredProviders: string[];
}

export async function bootstrap(options: BootstrapOptions): Promise<Bootstrapped> {
  const storeDir = options.storeDir ?? path.join(options.cwd, ".tinycode");
  const tools = selectTools(options.toolNames ?? DEFAULT_TOOL_NAMES);
  const budget: RunBudget = { ...DEFAULT_BUDGET, ...options.budget };
  const newId = defaultIdGenerator();

  const gate: GatePolicy = options.gate ?? destructiveCommandPolicy();

  const diagnostics: string[] = [];
  const collect = (messages: readonly string[]): void => {
    diagnostics.push(...messages);
    options.onDiagnostics?.(messages);
  };

  // --- 1. Resolve the model first, so an auth failure leaves no artifacts. ---
  let modelLabel = "(injected driver)";
  let envWiredProviders: string[] = [];
  let buildPi: (() => RunDriver) | undefined;

  if (options.driver === undefined && options.driverFactory === undefined) {
    const resolution = await resolveModel(
      options.modelSpec === undefined ? {} : { spec: options.modelSpec },
    );
    modelLabel = resolution.label;
    envWiredProviders = resolution.envWiredProviders;
    buildPi = () =>
      piDriver({
        cwd: options.cwd,
        ...(resolution.model === undefined ? {} : { model: resolution.model }),
        modelRuntime: resolution.modelRuntime,
        toolPort,
        tools,
        gate: gate,
        maxRetries: budget.maxRetries,
        onDiagnostics: collect,
      });
  }

  // --- 2. Collect the credentials this process actually holds, so they can be kept
  //        out of every event and out of the durable trace. ---
  const secretCandidates = [...(options.secrets ?? [])];
  for (const providerId of envWiredProviders) {
    const key = getEnvApiKey(providerId);
    if (key !== undefined) secretCandidates.push(key);
  }
  const redact = createRedactor(secretCandidates);

  // --- 3. The tool port, with the agent's own credentials withheld from any command
  //        the model writes. Redaction protects the trace; only this protects the
  //        model's context. ---
  const toolEnv = scrubEnvironment(process.env, credentialEnvNames(envWiredProviders));
  const toolPort = createToolRegistry(tools, { cwd: options.cwd, env: toolEnv });

  // --- 4. Only now touch the filesystem. ---
  const runLog = options.runLog ?? (await JsonlRunLog.open(storeDir));
  const sessionStore =
    options.sessionStore ?? (await JsonSessionStore.open(storeDir, newId));

  const driver =
    options.driver ?? options.driverFactory?.({ toolPort, tools, cwd: options.cwd }) ?? buildPi?.();
  if (driver === undefined) {
    throw new Error("bootstrap produced no driver; this is a programming error");
  }

  const runtime = await createRuntime({
    cwd: options.cwd,
    driver,
    runLog,
    sessionStore,
    budget,
    newId,
    model: modelLabel,
    redact,
    ...(options.humanInput === undefined ? {} : { humanInput: options.humanInput }),
    ...(options.onPersistenceError === undefined
      ? {}
      : { onPersistenceError: options.onPersistenceError }),
  });

  return {
    runtime,
    modelLabel,
    toolNames: tools.map((tool) => tool.name),
    diagnostics,
    storeDir,
    envWiredProviders,
  };
}
