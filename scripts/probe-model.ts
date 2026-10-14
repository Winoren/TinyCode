/**
 * Diagnostic probe: what does model resolution actually see?
 *
 * Not part of the product. Answers "why is no model available?" without guessing,
 * by printing the resolved label, which providers received an environment key, and
 * what the catalog offers.
 *
 * Usage:
 *   npx tsx scripts/probe-model.ts
 *   npx tsx scripts/probe-model.ts deepseek/deepseek-v4-flash
 */

import { resolveModel } from "../src/model/registry.ts";

const spec = process.argv[2];

let resolution;
try {
  resolution = await resolveModel(spec === undefined ? {} : { spec });
} catch (error) {
  // A diagnostic should report, not stack-trace.
  console.log(`model resolution failed: ${(error as Error).message}`);
  process.exitCode = 1;
  throw new Error("__handled__");
}

console.log(`requested:        ${spec ?? "(first available)"}`);
console.log(`resolved label:   ${resolution.label}`);
console.log(`model defined:    ${resolution.model !== undefined}`);
console.log(
  `env-wired:        ${resolution.envWiredProviders.length === 0 ? "(none)" : resolution.envWiredProviders.join(", ")}`,
);
console.log(
  `catalog:          ${
    resolution.availableModels.length === 0
      ? "(empty — no authenticated provider)"
      : resolution.availableModels
          .map((model) => `${model.providerId}/${model.modelId}`)
          .join(", ")
  }`,
);

if (resolution.availableModels.length === 0) {
  console.log(
    "\nNo provider is authenticated. Set one of DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, " +
      "OPENAI_API_KEY (or another supported provider variable) and run again.",
  );
}
