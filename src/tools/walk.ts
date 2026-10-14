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

export interface WalkStats {
  /** Files actually yielded. */
  filesYielded: number;
  /**
   * True when the entry cap stopped the walk before the tree was exhausted.
   *
   * Without this a capped walk is indistinguishable from a complete one, and a caller
   * reporting "no matches" would be stating a partial result as a definitive one.
   */
  stoppedEarly: boolean;
}

export interface WalkOptions {
  /** Absolute workspace root. */
  root: string;
  ignored?: ReadonlySet<string>;
  maxEntries?: number;
  signal?: AbortSignal;
  /** Optional observer, so a caller can tell a complete walk from a capped one. */
  stats?: WalkStats;
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

      // Check before yielding, so exactly `maxEntries` files come out and hitting the
      // cap is recorded rather than being reported as the end of the tree.
      if (yielded >= maxEntries) {
        if (options.stats !== undefined) options.stats.stoppedEarly = true;
        return;
      }
      yielded += 1;
      if (options.stats !== undefined) options.stats.filesYielded = yielded;
      yield relative;
    }
  }
}
