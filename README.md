# TinyCode

A minimal but complete coding-agent harness in TypeScript, built on the
[Pi Agent SDK](https://github.com/earendil-works/pi). Derivation follows the
`pi-coding-agent` Skill: start from one real task, derive the smallest loop, then
derive Core and Runtime contracts from that loop.

## The task it exists to serve

> Given a repository working directory and a plain-language request, a person wants
> TinyCode to inspect and change files there and run commands. The agent is useful
> when the change is made, the evidence — which tools ran, in what order, what they
> returned — is durable, and the run ends by explicitly saying `complete`, `partial`
> or `failed` rather than quietly stopping.

Everything below is derived from that sentence. Anything that does not answer
"what must the Agent know / do / observe, and how does the run end?" was postponed.

## The smallest loop

```
Task → Context → model decision → tool action → observation → state update → result
```

## Layers

| Layer | Question it answers | Lives in |
|---|---|---|
| **Core** | What does a valid Agent run *mean*? | [`src/core/`](src/core) — pure TypeScript: no SDK, filesystem, network, timers or globals |
| **Runtime** | How does a run actually happen and survive? | [`src/runtime/`](src/runtime) — session/run identity, event envelope, cancellation, budgets, durability |
| **Adapters** | How do concrete model and tools plug in? | [`src/adapters/`](src/adapters) — the deterministic fake path and the Pi SDK path |
| **Product surface** | How does a person use it? | [`src/cli/`](src/cli) |

The Core is runnable with fake adapters alone — no process, database, network or UI.
That is what makes the loop testable, and it is asserted in
[`tests/core-loop.test.ts`](tests/core-loop.test.ts).

### The one place the architecture bends

The Skill sketches `ModelPort.decide(state, signal) → Decision`. The SDK does not
expose a single decision: `session.prompt()` runs its *own* loop and streams events.
Rather than pretend, TinyCode separates the two:

- **`RunDriver`** = `(state, ctx) => AsyncGenerator<EventDraft>`. Two implementations:
  - `coreLoopDriver` drives `ModelPort`/`ToolPort` directly — the deterministic reference;
  - `piDriver` drives the SDK and *normalizes* its events into the same vocabulary.
- The **Runtime** does not care which driver produced the drafts.

Both paths build transcript entries through the same helpers in
[`src/core/transcript.ts`](src/core/transcript.ts) and classify errors through
[`src/core/errors.ts`](src/core/errors.ts), so "same Core semantics on both paths" is
a structural property rather than a promise. Full reasoning:
[`docs/adapter-mapping.md`](docs/adapter-mapping.md).

The SDK translation itself lives in [`src/adapters/pi/normalize.ts`](src/adapters/pi/normalize.ts)
as a **pure function over synthetic events**, not inside a subscription callback. That
matters: it is the most SDK-coupled code in the project and therefore the most likely to
break on an upgrade, and while it lived in the callback the only way to exercise it was a
live provider turn. As a pure function it has real tests, including one asserting that
the state the Pi path mutates live is byte-identical to what replay reconstructs from
its own events.

## Run it

```bash
npm install
export DEEPSEEK_API_KEY=...        # or ANTHROPIC_API_KEY / OPENAI_API_KEY
npx tsx src/cli/index.ts "the tests fail, find out why and fix it"
```

Useful flags: `--read-only`, `--no-bash`, `--tools read,edit,bash`, `--model
deepseek/deepseek-v4-flash`, `--json`, `--max-iterations`, `--timeout`, `--store-dir`.

**No API key means no run.** The CLI refuses to start rather than pretending:

```
✗ could not start: no authenticated model is available. Set a provider API key
  in the environment (for example DEEPSEEK_API_KEY, ...) and try again. (auth)
```

## Verify

```bash
npm run typecheck   # tsc --noEmit, strict + exactOptionalPropertyTypes
npm test            # vitest
npm run build       # emits loadable ESM
npm run golden      # regenerate the golden transcript corpus (deliberate, not CI)
```

### Golden transcripts

[`fixtures/golden/`](fixtures/golden) holds nine complete event logs from real runs,
each paired with a summary of the state it replays to. They exist so that a change in
the event vocabulary, in replay semantics, or in the SDK adapter cannot land silently:
if semantics move, [`tests/golden.test.ts`](tests/golden.test.ts) stops matching and the
corpus must be regenerated on purpose. The set covers all three terminal shapes —
complete, partial with missing material, and failed — plus a recovering retry, an
approved destructive action, and a declined one that ends partial.

Determinism is injected, not hoped for — the generator supplies a fixed clock and id
source, so regenerating an unchanged build produces no diff.

## Invariants, and the test that holds each one

| Invariant | Where it is proven |
|---|---|
| Two sessions share no state | `runtime — session isolation` |
| A run cannot name a workspace other than the one its tools are bound to | `runtime — the workspace a run is bound to` |
| Two concurrent runs in one session do not corrupt each other or the store | `runtime — concurrency` |
| Every run has exactly one terminal event | `runtime — lifecycle guarantees` |
| A tool failure is visible and does not corrupt other state | `core loop — refusal and isolation` |
| Cancellation stops work, is never retried, and is persisted as `cancelled` | `runtime — termination is never fabricated` |
| Credentials never reach an event or the durable log, even when a provider error echoes them | `credentials never reach the durable trace` |
| A model-written command cannot read the agent's own credentials | `tool-env.test.ts`, with a control proving the leak exists without scrubbing |
| Retry is bounded, visible, and skipped for non-retryable and cancelled runs | `runtime — bounded, visible retry` |
| Waiting for a human is a durable `awaiting_human` state that resumes explicitly | `runtime — waiting for a human is a durable state` |
| A restart recovers state, and replay rebuilds it exactly | `runtime — persistence`, `core loop — replay equivalence` |
| The Pi path's live state equals what replay reconstructs from its events | `pi-normalize — state mutation agrees with replay` |
| The real SDK session runs a tool call, streams, and terminates — against a stub provider, so no key is needed | `pi-live.test.ts` |
| The real and fake paths produce the same semantic event sequence | `pi-normalize — the real and fake paths agree on Core semantics` |
| A gated action is not reported as started before it is approved, on either path | `pi-adapter — a gated action is not reported as started before it is approved` |
| Budgets terminate a run predictably | `core loop — budgets and termination`, and the Pi driver enforces turns and tool calls itself |
| A model-supplied regex cannot hang the run past its budget | `grep — interrupts a catastrophically backtracking pattern` |
| A search path that names a file searches that file, and a missing one is reported as missing | `a search path that is a file, not a directory` |
| Project-specific ignores are honoured, not just a built-in directory list | `.gitignore` — skips `target/`, honours a negation, applies from a deeper search root |
| Search results are workspace-relative, so they can be fed to another tool | `.gitignore` — applies the workspace's patterns even when the search starts deeper |
| A file can be located by name even with write and shell tools withheld | `find` — bare patterns match the name anywhere, slash patterns match the path |
| `run_completed` distinguishes `complete` from `partial` | `cli — end-to-end vertical slice` |
| Usage is reported, or explicitly unknown — never a fabricated zero | `event rendering` |
| Tools cannot escape the workspace, including via symlinks | `workspace boundary` |
| A gated action cannot run unapproved, and a refusal is visible, not silent | `gate.test.ts` — policy boundaries and `core loop — the gate decides` |
| A non-zero exit code is information, not a tool failure | `bash` |
| A CRLF file is editable using the text `read` showed | `edit — can edit a CRLF file using the text read showed` |

The load-bearing end-to-end test runs `bootstrap()` — the same assembly the CLI uses —
against a real temp workspace with the **real tools, real Runtime and real JSONL run
log**, with only the model scripted. It reads a broken file, edits it, verifies with a
real `node check.mjs`, and then recovers the run from the log it wrote.

## Security defaults

Closed unless proven otherwise:

- tools run from an explicit allowlist; an unknown name is refused by **two**
  independent gates (the Core loop and the registry);
- every path is resolved through one gate, [`src/tools/paths.ts`](src/tools/paths.ts),
  which refuses lexical escapes, NUL bytes and symlink escapes;
- the walker never follows symlinks and skips dependency directories;
- the driver refuses to run if the model would be offered a tool it did not define —
  our tool names collide with pi's built-ins, so a surviving built-in `bash` would
  bypass the boundary entirely;
- **a model-supplied regex cannot hang the run.** V8 has no regex timeout and a fired
  `AbortSignal` cannot interrupt synchronous backtracking, so `grep` evaluates patterns
  inside a `vm` context with a deadline. The pattern is passed as sandbox *data*, never
  interpolated into source. A pattern that cannot finish is `invalid_tool` — deliberately
  not `timeout`, which would be retried forever;
- tool output is truncated before entering the transcript, because tool results are
  untrusted input, and `read` bounds how much it holds in memory — a small file is read
  whole so its line count is exact, a large one is streamed and only the requested
  window is retained;
- **credentials are withheld from the commands the model writes.** `bash` does not
  inherit the agent's environment: the credential variables of the providers in use are
  deleted before spawning. Redaction protects the trace; only this protects the model's
  context, where a tool result arrives as clear text before it is ever recorded;
- **credentials are redacted from every event** before it is handed to a consumer or
  written to disk — exact-value matching of the keys this process actually holds, not
  pattern matching, so a tool result quoting a key from your own file is not mangled;
- **destructive shell commands are gated by default.** A recursive delete that leaves
  the workspace, a force-push, a hard reset, `sudo`, piping remote content into a shell,
  publishing a package. Stated plainly: this is a **safety net against accidents, not a
  security boundary** — text-level inspection is bypassable, and the real containment is
  the path gate plus OS process isolation. Its job is the routine disaster: an agent
  that decides `rm -rf ..` is how you clean a build directory;
- `ask_human` without a channel **fails**; when stdin is not a terminal, confirmations
  are unavailable rather than assumed, so a gated command fails the run.

## Known limitations

Honest gaps, not a backlog:

1. **No run against a real model provider has completed successfully.** The environment
   has no credentials (`~/.pi/agent/auth.json` is `{}`; no `*_API_KEY` set).

   This is narrower than it sounds. The real SDK path *is* exercised end to end by
   [`tests/pi-live.test.ts`](tests/pi-live.test.ts): a real `ModelRuntime` provider points
   at a local HTTP server speaking the OpenAI-compatible protocol, so a real session
   runs a real prompt, a real tool-call loop through `defineTool` into our `ToolPort`,
   real streaming, real normalization, and a real HTTP round trip — only the model's
   output is scripted. Against a live provider the CLI also reaches the provider and
   fails at authentication, correctly classified as `auth`.

   What is unverified is the one thing a stub cannot supply: a real model's judgement
   over a real repository, and whatever that surfaces.
2. **Token usage may be unknown.** On the deepseek path `agent_end` carries no `usage`
   field, so `usage_reported` reports `tokens unknown` instead of a number. Cost
   tracking needs a second source.
3. **`ModelPort` is exercised only by the deterministic path.** The SDK owns the real
   loop, so `piDriver` does not call `ModelPort`. The golden-transcript comparison is
   therefore the load-bearing equivalence check, not a port conformance suite.
4. **`onUpdate` is ignored.** The SDK streams tool progress; TinyCode does not render
   it, so it does not claim to.
5. **Only the root `.gitignore` is honoured.** Nested `.gitignore` files,
   `.git/info/exclude`, and cross-file negation precedence are not implemented. Saying
   so is better than behaving unpredictably; the root file is where the rules that
   matter in practice live.
6. **No compaction, sub-agents, MCP or permissions UI.** Each was postponed until a
   real task demonstrates the need.
7. **The Pi path's budget enforcement is unverified against a live model.** It is
   implemented and type-checked, but the code path that trips it only runs during a
   real provider turn, which this environment cannot execute. The deterministic path's
   equivalent is covered by tests.
8. **A Runtime-level retry restarts the SDK conversation.** Retry is proven on the
   deterministic path, and the SDK's own request-level retry is configured from the
   same `maxRetries`, but a run-level retry on the Pi path creates a fresh session —
   accumulated observations survive in `AgentState`, the provider's conversation does
   not. Not verified against a live provider.

## Corrections to the Skill

Verified against the installed `@earendil-works/pi-coding-agent@0.84.2`; both are
recorded in [`docs/adapter-mapping.md`](docs/adapter-mapping.md):

1. **Usage field names.** The Skill's `pi-agent-sdk-usage.md` §2.4 lists
   `inputTokens` / `cacheReadInputTokens`, which is agent-runner's *normalized* shape.
   The SDK's `Usage` is `input` / `output` / `cacheRead` / `cacheWrite` / `cost.total`.
   Mapping from the Skill's names silently yields `undefined` for every cost figure.
2. **Tool surface selection.** The docs imply `noTools: "builtin"` is the posture for a
   vertical agent. Measured with [`scripts/probe-session.mjs`](scripts/probe-session.mjs),
   that leaves a built-in `find` registered, and `noTools: "all"` disables custom tools
   too. An explicit `tools` allowlist is the only configuration where the registry and
   the active set are both exactly ours.
