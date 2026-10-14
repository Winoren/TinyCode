# Pi Agent SDK → TinyCode port mapping

> **Status:** required before `src/adapters/pi/` may be accepted.
> **Baseline:** `@earendil-works/pi-coding-agent@0.84.2` (verified installed in this
> repo's `node_modules`), `@earendil-works/pi-ai@0.84.2`.
> **Method:** every claim below was read from the installed package — examples first,
> then `docs/`, then `dist/**/*.d.ts`. Nothing here is written from memory. Where the
> Skill's own reference layer disagrees with the installed code, the disagreement is
> recorded rather than smoothed over.

## 1. Why this document exists

The Skill requires that the SDK be an *adapter*, not the architecture. Concretely:
the Core's meaning — what a decision, an observation, a terminal state is — must not
change when the SDK changes. This note is the contract between the two, written
before the adapter so the mapping can be reviewed on its own terms.

## 2. Verified SDK surface

### 2.1 Session assembly — `createAgentSession`

Source: `dist/core/sdk.d.ts` (`CreateAgentSessionOptions`).

```ts
const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
  cwd, agentDir, modelRuntime, model, thinkingLevel,
  tools: string[],          // allowlist; omitted ⇒ default built-ins (read/bash/edit/write)
  excludeTools: string[],   // denylist, applied after `tools`
  noTools: "all" | "builtin",
  customTools: ToolDefinition[],   // ← the path TinyCode uses
  resourceLoader, sessionManager, settingsManager,
});
```

Two facts worth recording because the SDK's own example is easy to misread:

- `examples/sdk/05-tools.ts` says custom tools are registered "via the extensions
  system using `pi.registerTool()`". That is true but *not exhaustive*:
  `customTools?: ToolDefinition[]` genuinely exists on `CreateAgentSessionOptions`
  (`dist/core/sdk.d.ts:47`) and on `AgentSessionConfig` (`dist/core/agent-session.d.ts:122`).
  Both routes are real. TinyCode uses `customTools` — it keeps the tool definition in
  our code rather than inside an extension factory.
- `tools` is an **allowlist**, and extension/custom tools stay enabled unless
  `noTools` changes that. We therefore pass an explicit allowlist *and* keep the
  unknown-name refusal in the Core loop: the SDK's allowlist governs what the model
  may call, and our refusal is the second, independent gate.

### 2.2 Tool definition — `defineTool` / `ToolDefinition`

Source: `dist/core/extensions/types.d.ts:346` (`ToolDefinition`), `:386` (`defineTool`),
re-exported from `dist/index.d.ts`.

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;                       // TypeBox schema
  prepareArguments?: (args: unknown) => Static<TParams>;
  executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,          // ← our AbortSignal crosses here
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}
```

`AgentToolResult<T>` (from `pi-agent-core/dist/types.d.ts:316`):

```ts
{ content: (TextContent | ImageContent)[]; details: T; usage?: Usage; addedToolNames?: string[] }
```

`execute` takes **five** parameters, not the three the Skill's snippets show. That
matters for wiring, not for semantics: `signal` is the second-to-last, and `onUpdate`
is how tool progress reaches the UI — TinyCode currently ignores `onUpdate` rather
than pretending to stream tool progress it does not render.

### 2.3 Session events — `AgentSessionEvent`

Source: `dist/core/agent-session.d.ts:40`, composed from `AgentEvent` in
`pi-agent-core/dist/types.d.ts:374`.

```ts
AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason; result: CompactionResult | undefined; aborted: boolean;
      willRetry: boolean; errorMessage?: string }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
```

`AgentEvent` (the part we care about):

```ts
| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
| { type: "tool_execution_start";  toolCallId: string; toolName: string; args: any }
| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
| { type: "tool_execution_end";    toolCallId: string; toolName: string; result: any; isError: boolean }
```

`AssistantMessageEvent` (from `pi-ai/dist/types.d.ts`):

```ts
| { type: "text_delta";     contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
| { type: "toolcall_end";   contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
| { type: "done";  reason: Extract<StopReason, "stop"|"length"|"toolUse"|"deferred">; message }
| { type: "error"; reason: Extract<StopReason, "aborted"|"error">; error: AssistantMessage }
```

`StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.

### 2.4 Usage — and a real discrepancy with the Skill

Source: `pi-ai/dist/types.d.ts:255`.

```ts
interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number; reasoning?: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

**The Skill's `references/pi-agent-sdk-usage.md` §2.4 is wrong about the shape.**
It lists `inputTokens / outputTokens / cacheReadInputTokens / cacheCreationInputTokens
/ reasoningTokens / costUSD / durationMs / numTurns`. Those are the *normalized*
field names from `agent-runner`'s `RuntimeEvent`, not the SDK's `Usage`. Mapping from
the Skill's names would silently produce `undefined` for every cost figure.

We therefore map from the real `Usage`: `input → inputTokens`, `output → outputTokens`,
`cost.total → costUSD`. `durationMs` is measured by the Runtime, not read from `Usage`.

**Usage is summed across every assistant message in `agent_end.messages`, not taken
from the last one.** Verified against a real deepseek run (2026-10-14): a five-request
run reported 153 input / 144 output tokens — the last turn alone — because each
assistant message carries only its own request's usage. Summing gives the run's real
cost (a comparable six-request run: 2,918 input / 972 output). Note `input` already
excludes cache hits (SDK: `prompt_tokens − cached_tokens`), so deepseek prompt caching
makes later turns look cheap; the sum is still the truthful total.

The Skill's §6 observation 2 still holds and is reproduced here as a known gap: on the
deepseek path `agent_end`'s assistant message may carry no `usage`, so these fields can
legitimately be `undefined`. The trace must say "unknown", never "zero".

### 2.5 Error shape

Provider failures arrive as thrown errors or as `AssistantMessageEvent.error`. The
Skill's verification log records `402 Insufficient Balance` as a real occurrence on
deepseek. `src/core/errors.ts` owns the mapping to `RunErrorCode`; the adapter does not
classify anything itself, so both the throw path and the `agent_end` path normalize
identically.

### 2.6 Persistence and resources

- `SessionManager.inMemory(cwd)` / `.create(cwd, dir?)` / `.open(path)` — the SDK's own
  session store. TinyCode uses `inMemory` and keeps its **own** append-only RunLog as
  the source of truth, because the Skill's contract is event-log replay, not the SDK's
  transcript format.
- `DefaultResourceLoader` does **not** auto-load: `await resourceLoader.reload()` is
  required or nothing is discovered. Noted as the Skill's "high-frequency trap".

### 2.7 Tool surface selection — a measured correction

Our tool names (`read`, `write`, `edit`, `bash`, `ls`, `grep`) **collide with pi's
built-ins**. If a built-in stayed active, the model could call a `bash` that never
passes through `src/tools/paths.ts`, silently voiding the workspace boundary.

The docs suggest `noTools: "builtin"` is "the default posture for a vertical agent".
Reading `dist/core/sdk.js:134-137`:

```js
const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
const initialActiveToolNames =
  options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames));
```

and `_refreshToolRegistry` (`dist/core/agent-session.js:1940`), where custom tools are
written into the registry **by name, overwriting built-ins**.

Measured with `scripts/probe-session.mjs` against 0.84.2, using
`getActiveToolNames()` (what the model is actually offered) rather than
`getAllTools()` (the registry):

| Configuration | Offered to the model | Registry residue |
|---|---|---|
| `tools: [ours]` | exactly our 6, all resolving to our definitions | none |
| `noTools: "builtin"` | our 6 | built-in `find` remains registered |
| defaults | our 6 | built-in `find` remains registered |
| `noTools: "all"` | **empty** — custom tools are disabled too | — |
| `excludeTools: [ours]` | empty | `find` |

**Adopted: an explicit `tools` allowlist**, the only configuration where the registry
and the active set are both exactly our tools. `noTools: "all"` is actively harmful
here. As defence in depth the driver also asserts at runtime that every active tool
resolves to one of our definitions and refuses to run otherwise
(`assertToolSurface` in `src/adapters/pi/driver.ts`) — a name collision makes "which
definition is live" a question worth re-asking on every SDK upgrade.

## 3. The mapping

| TinyCode Core contract | Pi Agent SDK grounding | Notes |
|---|---|---|
| `Task.input` | `session.prompt(text)` | one Task drives one prompt turn sequence |
| `AgentState.transcript` | rebuilt into `Context` messages | adapter encodes; Core never sees SDK message objects |
| `ModelPort.decide` | `AgentSession.prompt` + `AgentSessionEvent` normalization | **see §4 — this is not a 1:1 call** |
| `ToolPort.execute(intent, signal)` | `defineTool(...).execute(id, params, signal, onUpdate, ctx)` | adapter forwards the signal; ignores `onUpdate` |
| `Decision.respond` | `agent_settled` with no pending tool calls | terminal classification |
| `Decision.call_tool` | `tool_execution_start` | emits `decision_made(call_tool)` + `tool_started` |
| `Observation` | `tool_execution_end` → `{ result, isError }` | provenance (`durationMs`, `observedAt`) added by us |
| `run_cancelled` | `AgentSession.abort()`; fired `AbortSignal` | cancellation is a lifecycle state, never an error |
| `RunErrorCode.provider_unavailable` | `402`, 5xx, transport failures | see `errors.ts`; verified against the 402 case |
| `RunErrorCode.invalid_tool` | `prepareArguments` conversion failure | adapter must not crash the runtime |
| `usage_reported` | `Usage` summed over every `agent_end` assistant message | field-name mapping corrected in §2.4 |

## 4. The one place the architecture does not line up

The Skill sketches `ModelPort.decide(state, signal) → Decision`. The SDK does **not**
expose a single decision: `AgentSession.prompt()` runs its *own* internal agent loop
and reports a stream of events.

Rather than pretend, TinyCode separates the two concerns:

- **`RunDriver`** is the seam. It is `(state, ctx) => AsyncGenerator<EventDraft>`.
  - `coreLoopDriver` (`src/core/loop.ts`) drives `ModelPort`/`ToolPort` directly. It is
    the deterministic reference and is what the fake path uses.
  - `piDriver` (`src/adapters/pi/`) drives the SDK and **normalizes** its events into the
    same `EventDraft` vocabulary.
- The **Runtime** (`src/runtime/`) is agnostic to which driver produced the drafts. It
  owns the envelope (`runId` / monotonic `sequence` / `timestamp`), persistence,
  cancellation, budgets, and the terminal-state guarantee.

Consequence: "the fake adapter and the real adapter produce the same Core semantics"
is checked by comparing the emitted event transcripts, not by asserting two model
adapters have identical signatures. The Core's meaning — decision, observation,
terminal state — is identical on both paths because both call the helpers in
`src/core/transcript.ts` and `src/core/errors.ts`.

The cost of this choice: `ModelPort` is exercised only by the deterministic path. That
is honest — the SDK owns the real loop — and it is why the golden-transcript
comparison is the load-bearing test rather than a `ModelPort` conformance suite.

## 5. Verification plan for the adapter

1. `npm run typecheck` and `npm test` stay green.
2. A fake-vs-real golden transcript comparison over the same task shape.
3. One real end-to-end run against a live provider, with the event stream inspected.
   **Blocked:** no provider credentials are present in this environment (`~/.pi` does
   not exist; no `*_API_KEY` is set). This step cannot be claimed until a key is
   supplied.
