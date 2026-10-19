# TinyCode

A TypeScript coding-agent harness — the same Core can drive a terminal CLI, a
desktop app, or any other host, through a single `bootstrap()` seam. Built on
the Pi Agent SDK with a deterministic event-sourced runtime, seven filesystem
tools, and a confirmation gate for destructive commands.

## Architecture

| Layer | Responsibility | Location |
|---|---|---|
| **Core** | Run state, decision/observation/gate contracts, loop driver, usage aggregation | `src/core/` |
| **Runtime** | Event log (JSONL), session store, cancellation, terminal run loop | `src/runtime/` |
| **Adapters** | Model port; `pi/` for the Pi SDK, `fake/` (scripted) for tests | `src/adapters/` |
| **Tools** | read, write, ls, bash, grep, edit, agent | `src/tools/` |
| **Product surface** | CLI; Electron desktop host | `src/cli/`, `app/` |

Key facts:

- **`bootstrap()` is host-agnostic.** It accepts an injected `humanInput`
  channel, an optional driver, and optional stores — so tests, the CLI, and
  the desktop app all assemble the same Core/Runtime without forking it.
- **Event-sourced, single source of truth.** A run is a sequence of
  `AgentEvent`s with a monotonic `sequence`, persisted to JSONL. Replays read
  the same log the live view reads.
- **One terminal event per run.** `run_completed` / `run_failed` /
  `run_cancelled` is exclusive; cancellation is `AbortController`-based
  (exit semantics 0 / 1 / 130).
- **Deterministic fake driver.** A scripted model over the *real* tool
  registry and gate enables network-free UI E2E.

## Requirements

Node ≥ 22.19 (ESM, TypeScript strict, no build step in dev).

## Install & CLI

```bash
npm install
npm run build
npx tinycode "your task"
```

Model configuration via environment (`.env` at the project root, never
committed): `TINYCODE_BASE_URL`, `TINYCODE_MODEL`, `TINYCODE_API_KEY` name a
custom endpoint; hosted providers also accept their own key variables.

## Desktop

`app/` is an Electron + React host for the same harness — main process pumps
run events over a typed IPC bridge, the human-input channel becomes an
approval dialog, and the sidebar replays a workspace's own run history.

```bash
npm run desktop         # dev (electron-vite, HMR)
npm run desktop:test    # build + Playwright E2E (fake driver, no network)
```

Security defaults: context isolation on, `nodeIntegration` off, no remote
content, strict CSP, one typed `contextBridge` surface.

## Verify

```bash
npm run test      # 339 unit tests
npm run typecheck # root + app
```

E2E exercises the real app with the fake driver: approve ends `complete`,
decline ends `partial` (missing material), and a run replays read-only from
history.
