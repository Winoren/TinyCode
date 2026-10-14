/**
 * Deterministic workspace walking.
 *
 * Shared by the search tools so that "what is a file we are willing to look at" is
 * defined once. Two deliberate security defaults:
 *
 * - symlinks are never followed while walking, so a link planted inside the
 *   workspace cannot pull the walk outside it;
 * - noise directories (`node_modules`, `.git`, …) are skipped, so search results are
 *   about the user's code rather than their dependency tree.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
]);

export interface WalkOptions {
  /** Absolute workspace root. */
  root: string;
  ignored?: ReadonlySet<string>;
  maxEntries?: number;
  signal?: AbortSignal;
}

/** Yield file paths relative to `root`, in a stable sorted order. */
export async function* walkFiles(options: WalkOptions): AsyncGenerator<string> {
  const ignored = options.ignored ?? DEFAULT_IGNORED_DIRECTORIES;
  const maxEntries = options.maxEntries ?? 20_000;
  const stack: string[] = [""];
  let yielded = 0;

  while (stack.length > 0) {
    options.signal?.throwIfAborted();
    const relativeDirectory = stack.pop();
    if (relativeDirectory === undefined) break;

    const absoluteDirectory =
      relativeDirectory === "" ? options.root : path.join(options.root, relativeDirectory);

    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it rather than failing the whole search.
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;

      const relative =
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;

      if (entry.isDirectory()) {
        stack.push(relative);
        continue;
      }
      // Only regular files: symlinks and devices are skipped by design.
      if (!entry.isFile()) continue;

      yielded += 1;
      if (yielded > maxEntries) return;
      yield relative;
    }
  }
}
