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

[`fixtures/golden/`](fixtures/golden) holds six complete event logs from real runs,
each paired with a summary of the state it replays to. They exist so that a change in
the event vocabulary, in replay semantics, or in the SDK adapter cannot land silently:
if semantics move, [`tests/golden.test.ts`](tests/golden.test.ts) stops matching and the
corpus must be regenerated on purpose.

Determinism is injected, not hoped for — the generator supplies a fixed clock and id
source, so regenerating an unchanged build produces no diff.

## Invariants, and the test that holds each one

| Invariant | Where it is proven |
|---|---|
| Two sessions share no state | `runtime — session isolation` |
| Every run has exactly one terminal event | `runtime — lifecycle guarantees` |
| A tool failure is visible and does not corrupt other state | `core loop — refusal and isolation` |
| Cancellation stops work and is never retried, and is distinct from a timeout | `runtime — termination is never fabricated` |
| A restart recovers state, and replay rebuilds it exactly | `runtime — persistence`, `core loop — replay equivalence` |
| Budgets terminate a run predictably | `core loop — budgets and termination` |
| `run_completed` distinguishes `complete` from `partial` | `cli — end-to-end vertical slice` |
| Usage is reported, or explicitly unknown — never a fabricated zero | `event rendering` |
| Tools cannot escape the workspace, including via symlinks | `workspace boundary` |
| A non-zero exit code is information, not a tool failure | `bash` |

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
- tool output is truncated before entering the transcript, because tool results are
  untrusted input;
- `ask_human` without a channel **fails**; when stdin is not a terminal, confirmations
  are unavailable rather than assumed.

## Known limitations

Honest gaps, not a backlog:

1. **No real end-to-end run has been executed yet.** The environment this was built in
   has no provider credentials (`~/.pi` absent; no `*_API_KEY` set). Every layer is
   verified up to the provider boundary, and the CLI fails cleanly at it, but the
   Skill's "one real workflow run with real input" exit criterion is **not** met.
2. **Token usage may be unknown.** On the deepseek path `agent_end` carries no `usage`
   field, so `usage_reported` reports `tokens unknown` instead of a number. Cost
   tracking needs a second source.
3. **`ModelPort` is exercised only by the deterministic path.** The SDK owns the real
   loop, so `piDriver` does not call `ModelPort`. The golden-transcript comparison is
   therefore the load-bearing equivalence check, not a port conformance suite.
4. **`onUpdate` is ignored.** The SDK streams tool progress; TinyCode does not render
   it, so it does not claim to.
5. **No compaction, sub-agents, MCP or permissions UI.** Each was postponed until a
   real task demonstrates the need.

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
