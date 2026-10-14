/**
 * Diagnostic probe: what tool surface does a session actually get?
 *
 * Not part of the product. Answers one security-relevant question with real code
 * instead of assumption: our custom tools are named read/write/edit/bash/ls/grep,
 * colliding with pi's built-ins. If a built-in survives, the model could call a bash
 * that never passes through our workspace boundary.
 *
 * The decisive API is `getActiveToolNames()` (what the model is offered), not
 * `getAllTools()` (the registry).
 */

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const customTool = (name) => ({
  name,
  label: name,
  description: `TinyCode ${name}`,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
});

const ours = ["read", "write", "edit", "bash", "ls", "grep"];

const configurations = [
  { label: "defaults (no options)", options: {} },
  { label: 'noTools: "builtin"', options: { noTools: "builtin" } },
  { label: 'noTools: "all"', options: { noTools: "all" } },
  { label: "tools: ours", options: { tools: ours } },
  { label: 'noTools: "builtin" + tools: ours', options: { noTools: "builtin", tools: ours } },
  { label: "excludeTools: ours", options: { excludeTools: ours } },
];

for (const { label, options } of configurations) {
  console.log(`\n=== ${label} ===`);
  try {
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      customTools: ours.map(customTool),
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      ...options,
    });

    const active = session.getActiveToolNames();
    const registry = session.getAllTools().map((tool) => tool.name);

    console.log(`  ACTIVE (offered to model): [${active.join(", ")}]`);
    console.log(`  registry:                  [${registry.join(", ")}]`);

    // Does each active name resolve to OUR definition, or to a built-in?
    const provenance = active.map((name) => {
      const definition = session.getToolDefinition(name);
      return `${name}=${definition?.description?.startsWith("TinyCode") ? "ours" : "NOT-OURS"}`;
    });
    console.log(`  provenance:                ${provenance.join(" ")}`);

    const leaks = active.filter((name) => {
      const definition = session.getToolDefinition(name);
      return definition?.description?.startsWith("TinyCode") !== true;
    });
    if (leaks.length > 0) console.log(`  !! LEAK: active tools not backed by our code: ${leaks.join(", ")}`);

    session.dispose();
  } catch (error) {
    console.log(`  FAILED: ${error?.message ?? error}`);
  }
}
