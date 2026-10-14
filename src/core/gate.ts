/**
 * The confirmation gate: which actions need a person's approval first.
 *
 * ## What this is, and what it is not
 *
 * This is a **safety net against accidents, not a security boundary**. The policy
 * inspects a shell command as text, and text-level inspection is bypassable — quoting,
 * command substitution, encodings, and indirection all defeat it. The real containment
 * is `tools/paths.ts` (every path resolved through one gate) plus operating-system
 * process isolation.
 *
 * Its job is to stop the routine disaster: an agent that decides `rm -rf ..` is the
 * way to clean a build directory, or force-pushes a shared branch because a test run
 * left the tree dirty. Those are mistakes, and a moment's confirmation prevents them.
 *
 * ## Why the policy takes the workspace root
 *
 * `rm -rf node_modules` is destructive but routine and recoverable. `rm -rf ..` is
 * catastrophic. Both are "recursive delete", so flag-matching alone cannot tell them
 * apart — the difference is *where*. The policy resolves the targets and only asks
 * when they leave the workspace.
 */

import path from "node:path";

import {
  AgentError,
  type HumanInputChannel,
  type ToolIntent,
  type ToolPort,
} from "./contracts.ts";

export interface GateVerdict {
  /** `true` proceeds without asking. */
  allow: boolean;
  /** Why approval is required. Shown to the person, so it must read as a reason. */
  reason: string;
}

export interface GateContext {
  /** Absolute workspace root. */
  cwd: string;
}

export type GatePolicy = (intent: ToolIntent, context: GateContext) => GateVerdict;

export const ALLOWED: GateVerdict = { allow: true, reason: "" };

/** A policy that gates nothing. */
export function allowAllPolicy(): GatePolicy {
  return () => ALLOWED;
}

interface DangerPattern {
  pattern: RegExp;
  reason: string;
}

/**
 * Commands that always require confirmation, regardless of target.
 *
 * Kept deliberately short and each entry justified: a long list of scary-looking
 * regexes trains the operator to approve without reading, which is worse than no gate.
 */
const ALWAYS_CONFIRM: readonly DangerPattern[] = [
  {
    pattern: /\bgit\s+push\b[^\n|;&]*(--force\b|--force-with-lease\b|\s-f(?:\s|$))/i,
    reason: "a force-push rewrites history other people may already have",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "a hard reset discards uncommitted work irrecoverably",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/i,
    reason: "git clean deletes untracked files irrecoverably",
  },
  {
    pattern: /\bsudo\b/i,
    reason: "runs with elevated privileges outside the workspace sandbox",
  },
  {
    pattern: /\bmkfs\b|\bdd\b[^\n|;&]*\bof=\/dev\//i,
    reason: "writes directly to a block device",
  },
  {
    pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/i,
    reason: "grants world-writable permissions",
  },
  {
    pattern: /\b(curl|wget)\b[^\n|;&]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
    reason: "pipes remote content straight into a shell",
  },
  {
    pattern: /\b(npm|yarn|pnpm|cargo)\s+publish\b/i,
    reason: "publishes a package publicly and is hard to undo",
  },
  {
    pattern: /\b(shutdown|reboot|halt|killall)\b/i,
    reason: "disrupts the host machine",
  },
];

/**
 * The default policy: gate shell commands that are destructive outside the workspace,
 * or irreversible anywhere.
 */
export function destructiveCommandPolicy(): GatePolicy {
  return (intent, context) => {
    if (intent.name !== "bash") return ALLOWED;

    const command = intent.arguments.command;
    if (typeof command !== "string" || command.trim() === "") return ALLOWED;

    for (const { pattern, reason } of ALWAYS_CONFIRM) {
      if (pattern.test(command)) return { allow: false, reason };
    }

    const escaping = recursiveDeletesOutside(command, context.cwd);
    if (escaping.length > 0) {
      return {
        allow: false,
        reason: `recursively deletes outside the workspace: ${escaping.join(", ")}`,
      };
    }

    return ALLOWED;
  };
}

/**
 * Recursive `rm` targets that resolve outside the workspace root.
 *
 * A pragmatic token scan, not a shell parser: it splits on whitespace and separators
 * and takes the operands that follow `rm`. It is wrong for anything clever, which is
 * exactly why this module's header calls the gate a safety net rather than a boundary.
 */
function recursiveDeletesOutside(command: string, cwd: string): string[] {
  const segments = command.split(/[;|&\n]+/);

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter((token) => token !== "");
    const rmIndex = tokens.findIndex((token) => token === "rm" || token.endsWith("/rm"));
    if (rmIndex === -1) continue;

    const operands = tokens.slice(rmIndex + 1);
    const recursive = operands.some((token) => /^-[a-zA-Z]*[rR]/.test(token) || token === "--recursive");
    if (!recursive) continue;

    const targets = operands.filter((token) => !token.startsWith("-"));
    const outside = targets.filter((target) => escapesWorkspace(target, cwd));
    if (outside.length > 0) return outside;
  }

  return [];
}

function escapesWorkspace(target: string, cwd: string): boolean {
  // Shell variables and globs cannot be resolved statically; assume the worst.
  if (/[$`*?[\]{}~]/.test(target)) return true;

  const root = path.resolve(cwd);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative === "") return false; // the workspace root itself
  return relative.startsWith("..") || path.isAbsolute(relative);
}

const AFFIRMATIVE = new Set([
  "y",
  "yes",
  "yeah",
  "yep",
  "true",
  "ok",
  "okay",
  "approve",
  "approved",
  "sure",
  "go",
  "proceed",
  "confirm",
]);

/**
 * Whether a person's answer means "yes".
 *
 * Anything not recognisably affirmative is a refusal: an ambiguous answer to "may I
 * delete this" must not be read as consent.
 */
export function isApproval(input: unknown): boolean {
  if (input === true) return true;
  if (typeof input !== "string") return false;
  return AFFIRMATIVE.has(input.trim().toLowerCase());
}

/** The question shown to the person. One wording, used by both execution paths. */
export function confirmQuestion(intent: ToolIntent, verdict: GateVerdict): string {
  const detail =
    intent.name === "bash" && typeof intent.arguments.command === "string"
      ? intent.arguments.command.trim()
      : intent.name;
  return `Run \`${truncate(detail, 200)}\`? It ${verdict.reason}.`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Apply the policy to one intent and obtain consent if required.
 *
 * This is the shared enforcement used by the SDK path. The Core loop implements the
 * same semantics inline because it must *yield* the round-trip events, and a function
 * that cannot yield cannot emit them; the policy, the question wording and the
 * approval test are shared, so the two paths cannot disagree about what was asked.
 *
 * Throws rather than returning a verdict: an unapproved action must not be reachable,
 * and a thrown error becomes a visible failed observation in both paths.
 */
export interface GateEnforcement {
  policy: GatePolicy;
  context: GateContext;
  /** Absent means nothing can be approved, so a gated action fails closed. */
  humanInput: HumanInputChannel | undefined;
  /** Reported so the caller can surface the round trip in the event stream. */
  onRequested?: (question: string) => void;
  onAnswered?: (input: unknown) => void;
}

export async function enforceGate(
  intent: ToolIntent,
  enforcement: GateEnforcement,
  signal: AbortSignal,
): Promise<void> {
  const verdict = enforcement.policy(intent, enforcement.context);
  if (verdict.allow) return;

  const question = confirmQuestion(intent, verdict);

  if (enforcement.humanInput === undefined) {
    throw new AgentError(
      "runtime_error",
      `no human input channel is available, so this cannot be confirmed: ${question}`,
    );
  }

  enforcement.onRequested?.(question);
  const input = await enforcement.humanInput(question, signal);
  enforcement.onAnswered?.(input);

  if (!isApproval(input)) {
    throw new AgentError("invalid_tool", `declined by the operator: ${verdict.reason}`);
  }
}

/**
 * Wrap a `ToolPort` so that every action passes the gate first.
 *
 * Both execution paths funnel through `ToolPort.execute`, which makes this decorator
 * the one place a gate is enforced regardless of who is driving the loop.
 */
export function createGatedToolPort(inner: ToolPort, enforcement: GateEnforcement): ToolPort {
  return {
    names: inner.names,
    async execute(intent: ToolIntent, signal: AbortSignal): Promise<unknown> {
      await enforceGate(intent, enforcement, signal);
      return inner.execute(intent, signal);
    },
  };
}
