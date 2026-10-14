/**
 * A local OpenAI-compatible endpoint for tests.
 *
 * Lets the real SDK session — and the real CLI — be driven end to end without provider
 * credentials: `ModelRuntime.registerProvider` points a provider at this server, so the
 * session, the HTTP round trip, the tool-call loop and event normalization are all
 * genuine. Only the model's output is scripted.
 *
 * Shared rather than duplicated per test file.
 */

import http from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface StubTurn {
  /** Emit a tool call for this tool instead of text. */
  toolCall?: { name: string; args: Record<string, unknown> };
  /** Emit several tool calls in one turn, which is what real models usually do. */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  text?: string;
  /** Fail the request with this HTTP status instead of completing it. */
  httpStatus?: number;
  /** Wait this long before responding. */
  delayMs?: number;
  /** Report token usage in the final chunk. */
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface StubProvider {
  readonly port: number;
  readonly requestBodies: string[];
  close(): Promise<void>;
}

/** Minimal OpenAI-compatible streaming endpoint. */
export async function startStubProvider(turns: readonly StubTurn[]): Promise<StubProvider> {
  const requestBodies: string[] = [];
  let requestCount = 0;

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      void (async () => {
        requestBodies.push(body);
        // The last turn repeats, so "always asks for a tool" is expressible.
        const turn = turns[Math.min(requestCount, turns.length - 1)] ?? { text: "" };
        requestCount += 1;

        if (turn.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
        }

        if (turn.httpStatus !== undefined) {
          response.writeHead(turn.httpStatus, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { message: "stub failure", type: "server_error" } }),
          );
          return;
        }

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });

        const chunk = (
          delta: unknown,
          finishReason: string | null = null,
          usage?: unknown,
        ): string =>
          `data: ${JSON.stringify({
            id: "chatcmpl-stub",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "stub-model",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(usage === undefined ? {} : { usage }),
          })}\n\n`;

        const calls = turn.toolCalls ?? (turn.toolCall === undefined ? [] : [turn.toolCall]);

        if (calls.length > 0) {
          response.write(chunk({ role: "assistant", content: "Working on it. " }));
          response.write(
            chunk({
              tool_calls: calls.map((call, index) => ({
                index,
                id: `call_${requestCount}_${index}`,
                type: "function",
                function: { name: call.name, arguments: "" },
              })),
            }),
          );
          response.write(
            chunk({
              tool_calls: calls.map((call, index) => ({
                index,
                function: { arguments: JSON.stringify(call.args) },
              })),
            }),
          );
          response.write(chunk({}, "tool_calls", turn.usage));
        } else {
          response.write(chunk({ role: "assistant", content: turn.text ?? "" }));
          response.write(chunk({}, "stop", turn.usage));
        }

        response.write("data: [DONE]\n\n");
        response.end();
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    requestBodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Derived rather than imported: the SDK does not export this type from its root. */
type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

export async function stubModel(stub: StubProvider) {
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  const provider: ProviderConfig = {
    name: "TinyCode live-test stub",
    baseUrl: `http://127.0.0.1:${stub.port}/v1`,
    api: "openai-completions",
    apiKey: "stub-key",
    models: [
      {
        id: "stub-model",
        name: "stub-model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4_096,
      },
    ],
  };
  modelRuntime.registerProvider("stub", provider);

  const model = modelRuntime.getModel("stub", "stub-model");
  if (model === undefined) throw new Error("the stub model did not register");
  return { model, modelRuntime };
}
