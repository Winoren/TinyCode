/**
 * Workspace boundary.
 *
 * The single most important security property of a coding agent: a tool may not
 * touch anything outside the workspace it was pointed at. `path.resolve` alone is
 * not enough — it normalizes `..` but happily follows a symlink out of the tree.
 *
 * Every path a tool receives goes through `resolveWithinWorkspace`. There is no
 * second path-resolution helper, deliberately: one gate, one place to audit.
 */

import fs from "node:fs";
import path from "node:path";

import { AgentError } from "../core/contracts.ts";

/** Resolve `candidate` against the workspace root, refusing any escape. */
export function resolveWithinWorkspace(workspaceRoot: string, candidate: string): string {
  if (candidate.includes("\0")) {
    throw new AgentError("invalid_tool", "path contains a NUL byte");
  }

  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, candidate);

  assertLexicallyInside(root, target, candidate);
  assertNoSymlinkEscape(root, target, candidate);

  return target;
}

function assertLexicallyInside(root: string, target: string, candidate: string): void {
  const relative = path.relative(root, target);
  const escapes = relative.startsWith("..") || path.isAbsolute(relative);
  if (escapes) {
    throw new AgentError(
      "invalid_tool",
      `path escapes the workspace: ${candidate} (workspace root: ${root})`,
    );
  }
}

/**
 * Catch symlink escapes.
 *
 * A path can be lexically inside the workspace and still point outside it, e.g.
 * `link -> /etc`. We resolve the nearest *existing* ancestor (the target itself may
 * not exist yet for a write) and require that its real location is still inside the
 * real workspace root.
 */
function assertNoSymlinkEscape(root: string, target: string, candidate: string): void {
  const realRoot = realpathOrUndefined(root) ?? root;
  const existingAncestor = nearestExistingAncestor(target);
  if (existingAncestor === undefined) return;

  const realAncestor = realpathOrUndefined(existingAncestor);
  if (realAncestor === undefined) return;

  const relative = path.relative(realRoot, realAncestor);
  const escapes = relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative));
  if (escapes) {
    throw new AgentError(
      "invalid_tool",
      `path resolves through a symlink outside the workspace: ${candidate} -> ${realAncestor}`,
    );
  }
}

function nearestExistingAncestor(target: string): string | undefined {
  let probe = target;
  for (;;) {
    if (fs.existsSync(probe)) return probe;
    const parent = path.dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
}

function realpathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return undefined;
  }
}
