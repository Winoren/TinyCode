/**
 * `find` — locate files by name or path pattern.
 *
 * Its absence was a real capability gap, not just a gap in the Skill's built-in tool
 * list: under `--read-only` the agent gets `read`, `ls` and `grep`, so without `find`
 * there is **no way at all** to locate a file by name. `grep` searches contents, and
 * `ls` shows one directory.
 *
 * ## Pattern semantics, stated because they are a choice
 *
 * - a pattern containing `/` is matched against the whole workspace-relative path,
 *   so `src/**\/*.ts` means what it looks like;
 * - a pattern without `/` is matched against the **basename**, so `*.test.ts` finds
 *   test files anywhere in the tree.
 *
 * The second rule is the one that matters in practice: a bare `*.test.ts` that only
 * matched files in the workspace root would be useless, and would push the model back
 * to shelling out. The rule is spelled out in the tool description so the model is not
 * guessing either.
 *
 * Glob matching itself is Node's own `path.matchesGlob` (22.5+), so no dependency is
 * added and the semantics are the platform's rather than something hand-rolled.
 */

import path from "node:path";
import { z } from "zod";

import { AgentError, toolOutput } from "../core/contracts.ts";
import type { ToolDefinition } from "./types.ts";
import { loadGitignore, resolveSearchTarget, walkFiles, type WalkStats } from "./walk.ts";

const FindInput = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Glob pattern. With a '/' it matches the whole relative path (e.g. 'src/**/*.ts'); " +
        "without one it matches the file name anywhere in the tree (e.g. '*.test.ts').",
    ),
  path: z.string().optional().describe("Directory to search, relative to the workspace root"),
  maxResults: z.number().int().positive().max(1_000).optional(),
});

export type FindInput = z.infer<typeof FindInput>;

const DEFAULT_MAX_RESULTS = 200;

export const findTool: ToolDefinition<FindInput> = {
  name: "find",
  description:
    "Find files by name or path pattern. Returns workspace-relative paths, so they can " +
    "be passed straight to read or edit. A pattern without '/' matches the file name " +
    "anywhere in the tree; one with '/' matches the whole relative path. Skips " +
    "dependency and build directories, and anything the project's .gitignore excludes.",

  schema: FindInput,

  async execute(input, ctx) {
    if (typeof path.matchesGlob !== "function") {
      throw new AgentError(
        "runtime_error",
        "this Node.js version has no path.matchesGlob (needs 22.5+); `find` is unavailable",
      );
    }

    const target = await resolveSearchTarget(ctx.cwd, input.path ?? ".");
    const limit = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const matchWholePath = input.pattern.includes("/");

    if (target.kind === "file") {
      const subject = matchWholePath ? target.relative : path.basename(target.relative);
      const matched = path.matchesGlob(subject, input.pattern);
      const body = matched ? target.relative : emptyFindMessage(input.pattern, matchWholePath, {
        filesYielded: 1,
        stoppedEarly: false,
      });
      return toolOutput(body, {
        pattern: input.pattern,
        matchCount: matched ? 1 : 0,
        filesWalked: 1,
        truncated: false,
        walkStoppedEarly: false,
      });
    }

    const root = target.absolute;
    // Patterns are relative to the workspace, even when the search starts deeper.
    const gitignore = await loadGitignore(ctx.cwd);

    const matches: string[] = [];
    let truncated = false;
    const stats: WalkStats = { filesYielded: 0, stoppedEarly: false };

    for await (const relative of walkFiles({
      root,
      signal: ctx.signal,
      stats,
      ...(gitignore === undefined ? {} : { gitignore }),
    })) {
      const subject = matchWholePath ? relative : path.basename(relative);
      if (!path.matchesGlob(subject, input.pattern)) continue;

      matches.push(toWorkspaceRelative(ctx.cwd, root, relative));
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }

    const body =
      matches.length === 0
        ? emptyFindMessage(input.pattern, matchWholePath, stats)
        : matches.join("\n") + (truncated ? `\n… [stopped at ${limit} matches]` : "");

    return toolOutput(body, {
      pattern: input.pattern,
      matchCount: matches.length,
      filesWalked: stats.filesYielded,
      truncated,
      walkStoppedEarly: stats.stoppedEarly,
    });
  },
};

/**
 * A negative result is only useful if it is honest about its scope — the same rule the
 * `grep` empty result follows.
 */
export function emptyFindMessage(
  pattern: string,
  matchWholePath: boolean,
  stats: WalkStats,
): string {
  const scope = matchWholePath
    ? `no file path matched /${pattern}/`
    : `no file name matched /${pattern}/`;

  if (stats.stoppedEarly) {
    return (
      `${scope} in the first ${stats.filesYielded} files walked. The walk was capped ` +
      "before the tree was exhausted, so this is NOT a complete answer — narrow the path."
    );
  }
  return `${scope}.`;
}

/**
 * Rewrite a path produced by a walk into one relative to the workspace root.
 *
 * A search may start in a subdirectory, but a path is only useful to the caller if it
 * can be handed straight back to another tool: reporting `a.ts` for a search inside
 * `src` means `read a.ts` opens a different file, or none at all. Every tool speaks
 * workspace-relative paths, so search results must too.
 */
function toWorkspaceRelative(
  workspaceRoot: string,
  searchRoot: string,
  relativeToSearchRoot: string,
): string {
  const prefix = path
    .relative(path.resolve(workspaceRoot), path.resolve(searchRoot))
    .split(path.sep)
    .filter((segment) => segment !== "")
    .join("/");

  return prefix === "" ? relativeToSearchRoot : `${prefix}/${relativeToSearchRoot}`;
}
