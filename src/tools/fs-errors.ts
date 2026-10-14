/**
 * Turning filesystem errno values into something a model can act on.
 *
 * `EISDIR: illegal operation on a directory, write` tells a model nothing it can use.
 * "not a file: src (it is a directory; use ls)" tells it exactly what to do next — and
 * the difference matters, because a tool error is the model's only feedback.
 *
 * One implementation, shared by every tool that touches the filesystem. Three tools
 * each mapping errno themselves is how `read` ended up with a clear directory message
 * while `write` and `edit` leaked the raw error.
 */

import { AgentError } from "../core/contracts.ts";

/**
 * Map a filesystem failure, or return undefined when it is not one we recognise —
 * in which case the caller should rethrow the original rather than guess.
 */
export function fsErrorToAgentError(error: unknown, displayPath: string): AgentError | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  switch (code) {
    case "ENOENT":
      return new AgentError("invalid_tool", `file not found: ${displayPath}`);

    case "EISDIR":
      return new AgentError(
        "invalid_tool",
        `not a file: ${displayPath} (it is a directory; use ls to list it)`,
      );

    case "EEXIST":
      // Only reachable from `mkdir(..., { recursive: true })`, where the call cannot
      // fail because the directory exists — so the path is occupied by something that
      // is not a directory. (Verified: mkdir reports EEXIST here, not ENOTDIR.)
      return new AgentError(
        "invalid_tool",
        `not a directory: a parent of ${displayPath} already exists as a file`,
      );

    case "ENOTDIR":
      return new AgentError(
        "invalid_tool",
        `not a directory: a parent of ${displayPath} is a file`,
      );

    case "EACCES":
    case "EPERM":
      return new AgentError(
        "invalid_tool",
        `permission denied: ${displayPath} (it exists but is not writable by this process)`,
      );

    case "ENOSPC":
      return new AgentError("runtime_error", `no space left on the device while using ${displayPath}`);

    case "ELOOP":
      return new AgentError("invalid_tool", `too many symbolic links while resolving ${displayPath}`);

    case "ENAMETOOLONG":
      return new AgentError("invalid_tool", `path is too long: ${displayPath}`);

    default:
      return undefined;
  }
}

/** Rethrow a recognised filesystem failure as an actionable one; otherwise rethrow as-is. */
export function throwFsError(error: unknown, displayPath: string): never {
  const mapped = fsErrorToAgentError(error, displayPath);
  if (mapped !== undefined) throw mapped;
  throw error;
}
