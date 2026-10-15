/**
 * The deterministic driver used by the E2E suite and local no-network demos.
 *
 * Setting `TINYCODE_DESKTOP_FAKE=1` makes the host assemble `bootstrap()` with a
 * scripted model instead of the Pi adapter: no network, no credentials, but the
 * same Runtime, gate, real tool registry and persistence. The script
 * intentionally includes a gated shell command so the approval dialog is
 * exercised end to end — approve runs the command, decline records missing
 * material and the run still completes as `partial`.
 */

import { scriptedModel } from "tinycode/dist/adapters/fake/index.js";
import type { Decision } from "tinycode/dist/core/contracts.js";
import { destructiveCommandPolicy } from "tinycode/dist/core/gate.js";
import { coreLoopDriver } from "tinycode/dist/core/loop.js";
import type { BootstrapOptions } from "tinycode/dist/bootstrap.js";

export function isFakeMode(): boolean {
  return process.env.TINYCODE_DESKTOP_FAKE === "1";
}

const DECISIONS: readonly Decision[] = [
  // Always confirmed by the gate, in any workspace, so the dialog always appears.
  { kind: "call_tool", intent: { name: "bash", arguments: { command: "git reset --hard" } } },
  { kind: "respond", content: "Fake run finished." },
];

const FAKE_TOOL_NAMES: readonly string[] = ["bash", "read", "ls"];

export function fakeDriverFactory(): NonNullable<BootstrapOptions["driverFactory"]> {
  return ({ toolPort }) =>
    coreLoopDriver({
      model: scriptedModel(DECISIONS),
      tools: toolPort,
      gate: destructiveCommandPolicy(),
    });
}

export function fakeBootstrapOverrides(): Partial<BootstrapOptions> {
  return { driverFactory: fakeDriverFactory(), toolNames: FAKE_TOOL_NAMES };
}
