#!/usr/bin/env node
/**
 * Zero-config launcher for TinyCode.
 *
 * Loads the install-directory `.env` (base URL / model / API key) into the
 * environment, then hands off to the compiled CLI. Precedence is deliberate:
 *
 *   flags  >  real environment  >  install-directory `.env`
 *
 * so a value exported in the shell always wins over the file, and a flag
 * always wins over both. A `.env` in the *target* project is never read —
 * credentials live with the tool, not with the repo being edited.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const raw = readFileSync(resolve(installRoot, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // No .env next to the install: the CLI will fall back to hosted-provider
  // auth (e.g. `pi login`) or fail with its normal credential error. Never
  // invent configuration here.
}

// The CLI module guards its own auto-run with an argv[1] identity check that
// never matches under a symlinked bin (argv[1] is the invoked path, the
// module's realpath is the dist file). The launcher is the real entry, so it
// calls the exported main() itself and mirrors the exit-code wiring.
const { main } = await import("../dist/cli/index.js");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
