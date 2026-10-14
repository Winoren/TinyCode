/**
 * Model resolution.
 *
 * Two behaviours here were measured against the installed packages rather than
 * assumed:
 *
 * 1. `ModelRuntime.create()` does **not** consult the environment. With
 *    `DEEPSEEK_API_KEY` set, `hasConfiguredAuth("deepseek")` still returns `false`,
 *    while the compat streaming path reads the env key at call time
 *    (`pi-ai/dist/compat.js:148`). Left alone, auth checks and the actual request
 *    would disagree — so environment keys are wired in explicitly.
 * 2. The built-in catalog is small. For deepseek it offers `deepseek-v4-flash` and
 *    `deepseek-v4-pro`; `deepseek-chat` does not exist. Guessing a model id produces
 *    a confusing failure, so an unknown id lists what is actually available.
 */

import { findEnvKeys, getEnvApiKey, type Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AgentError } from "../core/contracts.ts";

/** The model type the SDK's session options accept. */
export type ResolvedModel = Model<string>;

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ModelResolution {
  model: ResolvedModel | undefined;
  modelRuntime: ModelRuntime;
  /** Human-readable `provider/model`, for the trace and the status line. */
  label: string;
  /** Providers that received a runtime key from the environment. */
  envWiredProviders: string[];
  availableModels: ModelRef[];
}

/**
 * A user-supplied OpenAI- or Anthropic-compatible endpoint.
 *
 * The Skill's `scenario-custom-provider` covers exactly this: pointing the agent at a
 * self-hosted or internal LLM. Without it the harness can only talk to hosted providers
 * with an API key, which rules out a local model entirely.
 */
export interface CustomEndpoint {
  providerId: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  api?: "openai-completions" | "anthropic-messages";
}

export interface ResolveModelOptions {
  /** Register and use a custom endpoint instead of resolving a hosted provider. */
  custom?: CustomEndpoint;
  /** `provider/model`, or just `provider` to take its first available model. */
  spec?: string;
  authPath?: string;
  modelsPath?: string;
  /** Overrides the ambient environment. Values must be strings; omit to use process.env. */
  env?: Record<string, string>;
}

export function parseModelSpec(spec: string): { providerId: string; modelId?: string } {
  const trimmed = spec.trim();
  if (trimmed === "") throw new Error("model spec is empty");

  const slash = trimmed.indexOf("/");
  if (slash === -1) return { providerId: trimmed };
  const providerId = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  if (providerId === "" || modelId === "") {
    throw new Error(`malformed model spec "${spec}"; expected "provider/model"`);
  }
  return { providerId, modelId };
}

export async function resolveModel(options: ResolveModelOptions = {}): Promise<ModelResolution> {
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    ...(options.authPath === undefined ? {} : { authPath: options.authPath }),
    ...(options.modelsPath === undefined ? {} : { modelsPath: options.modelsPath }),
  });

  if (options.custom !== undefined) {
    return resolveCustomEndpoint(modelRuntime, options.custom);
  }

  const envWiredProviders = await wireEnvironmentKeys(modelRuntime, options.env);
  const available = await modelRuntime.getAvailable();
  const availableModels: ModelRef[] = available.map((model) => ({
    providerId: model.provider,
    modelId: model.id,
  }));

  const describeAvailable = (): string =>
    availableModels.length === 0
      ? "(none authenticated)"
      : availableModels.map((ref) => `${ref.providerId}/${ref.modelId}`).join(", ");

  if (options.spec === undefined) {
    const first = available[0];
    if (first === undefined) {
      throw new AgentError(
        "auth",
        "no authenticated model is available. Set a provider API key in the environment " +
          "(for example DEEPSEEK_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY) and try again.",
      );
    }
    return {
      model: first,
      modelRuntime,
      label: `${first.provider}/${first.id}`,
      envWiredProviders,
      availableModels,
    };
  }

  const requested = parseModelSpec(options.spec);

  if (requested.modelId === undefined) {
    const firstForProvider = available.find((model) => model.provider === requested.providerId);
    if (firstForProvider === undefined) {
      throw new AgentError(
        "auth",
        `no authenticated model for provider "${requested.providerId}". Available: ${describeAvailable()}`,
      );
    }
    return {
      model: firstForProvider,
      modelRuntime,
      label: `${firstForProvider.provider}/${firstForProvider.id}`,
      envWiredProviders,
      availableModels,
    };
  }

  const model = modelRuntime.getModel(requested.providerId, requested.modelId);
  if (model === undefined) {
    throw new Error(
      `unknown model "${requested.providerId}/${requested.modelId}". Available: ${describeAvailable()}`,
    );
  }

  return {
    model,
    modelRuntime,
    label: `${requested.providerId}/${requested.modelId}`,
    envWiredProviders,
    availableModels,
  };
}

/**
 * Give every registered provider the environment key the compat layer would have
 * used anyway, so `hasConfiguredAuth` and the real request agree.
 */
async function wireEnvironmentKeys(
  modelRuntime: ModelRuntime,
  env: Record<string, string> | undefined,
): Promise<string[]> {
  const wired: string[] = [];

  for (const provider of modelRuntime.getProviders()) {
    const providerId = provider.id;
    try {
      if (modelRuntime.hasConfiguredAuth(providerId)) continue;
      const key = getEnvApiKey(providerId, env);
      if (key === undefined || key.trim() === "") continue;
      await modelRuntime.setRuntimeApiKey(providerId, key);
      wired.push(providerId);
    } catch {
      // A provider that will not accept a runtime key is not fatal: it may be
      // OAuth-only, and the surface that matters is `getAvailable()`.
      continue;
    }
  }

  return wired;
}

/**
 * The environment variable names that hold credentials for these providers **and are
 * actually present in this process**.
 *
 * Presence-filtered on purpose: an absent variable needs no scrubbing, and using the
 * provider's own detection means we withhold exactly the credentials this process
 * holds rather than a speculative list.
 *
 * Names, not values: the tool layer only deletes them from a child process's
 * environment and never handles the secret itself.
 */
export function credentialEnvNames(providerIds: readonly string[]): string[] {
  const names = new Set<string>();
  for (const providerId of providerIds) {
    for (const name of findEnvKeys(providerId) ?? []) names.add(name);
  }
  return [...names];
}

/**
 * Register a caller-supplied endpoint and return its model.
 *
 * Registered under its own provider id so the built-in catalog is never disturbed, and
 * with `reasoning: false` / text-only input: inventing capabilities for an endpoint we
 * know nothing about would produce a model that claims to support things it does not.
 */
function resolveCustomEndpoint(
  modelRuntime: ModelRuntime,
  endpoint: CustomEndpoint,
): ModelResolution {
  const api = endpoint.api ?? "openai-completions";

  // The SDK's provider layer insists on a credential and refuses to start without one.
  // Most self-hosted OpenAI-compatible servers (Ollama, llama.cpp, vLLM) ignore the
  // Authorization header entirely, so a placeholder is what makes a local model usable at
  // all. It is a literal string, not a secret. An endpoint that does need a real key
  // answers 401, which the taxonomy already reports as `auth` — a clear failure rather
  // than a refusal to start.
  const apiKey = endpoint.apiKey ?? "tinycode-local-endpoint";

  modelRuntime.registerProvider(endpoint.providerId, {
    name: `${endpoint.providerId} (custom endpoint)`,
    baseUrl: endpoint.baseUrl,
    api,
    apiKey,
    models: [
      {
        id: endpoint.modelId,
        name: endpoint.modelId,
        api,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });

  const model = modelRuntime.getModel(endpoint.providerId, endpoint.modelId);
  if (model === undefined) {
    throw new AgentError(
      "auth",
      `the custom endpoint did not register a usable model: ` +
        `${endpoint.providerId}/${endpoint.modelId} at ${endpoint.baseUrl}`,
    );
  }

  const ref = { providerId: endpoint.providerId, modelId: endpoint.modelId };
  return {
    model,
    modelRuntime,
    label: `${endpoint.providerId}/${endpoint.modelId}`,
    envWiredProviders: [],
    availableModels: [ref],
  };
}
