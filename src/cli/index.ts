/**
 * The CLI entry point.
 *
 * Consumes the product-level event stream and nothing else, so the same run can be
 * driven from a terminal, a test, or an SSE endpoint.
 *
 * Two behaviours are deliberate rather than incidental:
 *
 * - **stdin that is not a terminal gets no confirmation channel.** The Skill's rule is
 *   that `ask_human` without a channel must fail, never silently proceed. Piping a
 *   task into TinyCode therefore cannot auto-approve a dangerous action.
 * - **the exit code reflects the terminal state**: 0 complete, 1 failed, 130
 *   cancelled. A partial run still exits 0 only if the agent said so explicitly —
 *   `partial` is a result, not a failure, and the message says what was missing.
 */

import readline from "node:readline/promises";

import { bootstrap, type BootstrapOptions, } from "../bootstrap.ts";
import type { CustomEndpoint } from "../model/registry.ts";
import type { AgentEvent } from "../core/contracts.ts";
import type { HumanInputChannel } from "../core/loop.ts";
import { CliUsageError, parseArgs, usageText } from "./args.ts";
import { createEventRenderer } from "./render.ts";

/**
 * `bootstrapOptions` is a seam, not production configuration: it lets a test drive the
 * real CLI — real argument handling, real rendering, real exit codes — with only the
 * model swapped out. Without it the whole product surface is untestable until someone
 * has a provider key, which is exactly how the exit codes went unverified.
 */
export async function main(
  argv: readonly string[],
  bootstrapOptions: Partial<BootstrapOptions> = {},
): Promise<number> {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${usageText()}\n`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }

  if (options.task === undefined || options.task.trim() === "") {
    process.stderr.write(`no task given.\n\n${usageText()}\n`);
    return 2;
  }

  const interactive = process.stdin.isTTY === true;
  const confirmation = createConfirmationChannel({ autoApprove: options.yes, interactive });

  let runtime;
  let modelLabel: string;
  let toolNames: string[];
  try {
    const customEndpoint =
      options.baseUrl === undefined
        ? undefined
        : buildCustomEndpoint(options.baseUrl, options.model as string, options.apiKey);

    const bootstrapped = await bootstrap({
      ...bootstrapOptions,
      cwd: options.cwd,
      ...(customEndpoint === undefined ? {} : { customEndpoint }),
      ...(options.model === undefined ? {} : { modelSpec: options.model }),
      toolNames: options.tools,
      budget: {
        maxIterations: options.maxIterations,
        maxToolCalls: options.maxToolCalls,
        timeoutMs: options.timeoutMs,
      },
      ...(options.storeDir === undefined ? {} : { storeDir: options.storeDir }),
      ...(confirmation.channel === undefined ? {} : { humanInput: confirmation.channel }),
      onDiagnostics: (messages) => {
        for (const message of messages) process.stderr.write(`[schema] ${message}\n`);
      },
      onPersistenceError: (error) => {
        process.stderr.write(`[trace] failed to persist an event: ${String(error)}\n`);
      },
    });
    runtime = bootstrapped.runtime;
    modelLabel = bootstrapped.modelLabel;
    toolNames = bootstrapped.toolNames;
  } catch (error) {
    process.stderr.write(`\n✗ could not start: ${describe(error)}\n`);
    return 1;
  }

  process.stderr.write(
    `tinycode · ${modelLabel} · ${options.cwd}\n` +
      `tools: ${toolNames.join(", ")}\n` +
      (interactive || options.yes
        ? ""
        : "note: stdin is not a terminal, so tool confirmations will fail rather than be assumed.\n") +
      "\n",
  );

  const renderer = createEventRenderer(
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
    { json: options.json, showThinking: options.showThinking },
  );

  const controller = new AbortController();
  const onInterrupt = (): void => {
    process.stderr.write("\n[interrupt] cancelling run...\n");
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);

  let terminal: AgentEvent | undefined;
  try {
    for await (const event of runtime.run(
      { id: `cli-${Date.now().toString(36)}`, input: options.task, cwd: options.cwd },
      controller.signal,
    )) {
      renderer.handle(event);
      if (
        event.type === "run_completed" ||
        event.type === "run_failed" ||
        event.type === "run_cancelled"
      ) {
        terminal = event;
      }
    }
  } catch (error) {
    process.stderr.write(`\n✗ runtime error: ${describe(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    confirmation.close();
    renderer.finish();
  }

  switch (terminal?.type) {
    case "run_completed":
      return 0;
    case "run_cancelled":
      return 130;
    default:
      return 1;
  }
}

interface ConfirmationChannel {
  channel: HumanInputChannel | undefined;
  close: () => void;
}

function createConfirmationChannel(options: {
  autoApprove: boolean;
  interactive: boolean;
}): ConfirmationChannel {
  if (options.autoApprove) {
    return {
      channel: async () => "yes",
      close: () => {},
    };
  }

  if (!options.interactive) {
    // Fail closed: no channel means `ask_human` fails instead of being assumed.
    return { channel: undefined, close: () => {} };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return {
    channel: async (question) => {
      const answer = await rl.question(`\n? ${question}\n  [y/N] `);
      return answer;
    },
    close: () => rl.close(),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code === undefined ? error.message : `${error.message} (${code})`;
  }
  return String(error);
}

import { pathToFileURL } from "node:url";

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`fatal: ${describe(error)}\n`);
      process.exitCode = 1;
    });
}

/**
 * Turn the endpoint flags into a provider registration.
 *
 * `--model` doubles as the model id here because with `--base-url` there is no hosted
 * catalog to choose from: whatever the endpoint serves is the only option, and the user
 * is the only one who knows its name. A `<provider>/<model>` form is still accepted so the
 * registration can be named something meaningful in the trace.
 */
function buildCustomEndpoint(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
): CustomEndpoint {
  const slash = model.indexOf("/");
  const providerId = slash === -1 ? "custom" : model.slice(0, slash);
  const modelId = slash === -1 ? model : model.slice(slash + 1);

  if (providerId === "" || modelId === "") {
    throw new CliUsageError(`malformed --model "${model}"; expected "<model>" or "<provider>/<model>"`);
  }

  return {
    providerId,
    baseUrl,
    modelId,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}
