/**
 * Install-directory `.env` loading, mirroring bin/tinycode.js exactly.
 *
 * Precedence is deliberate: the real environment wins over the file, so a value
 * exported in the shell always beats the stored configuration. A `.env` in the
 * *target* workspace is never read — credentials live with the tool, not with
 * the repo being edited.
 */

import { readFileSync } from "node:fs";

export function loadDotEnv(installRoot: string): void {
  let raw: string;
  try {
    raw = readFileSync(`${installRoot}/.env`, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
