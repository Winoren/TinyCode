/**
 * CLI argument parsing.
 *
 * Pure and dependency-free so it can be tested without spawning a process. Unknown
 * flags are an error rather than being silently ignored: a typo like `--readonly`
 * that quietly grants write access would be a security bug, not a convenience.
 */

export const ALL_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
  "bash",
] as const;
export const READ_ONLY_TOOL_NAMES = ["read", "ls", "grep", "find"] as const;
export const DEFAULT_TOOL_NAMES: readonly string[] = ALL_TOOL_NAMES;

export interface CliOptions {
  task: string | undefined;
  cwd: string;
  model: string | undefined;
  tools: string[];
  json: boolean;
  showThinking: boolean;
  yes: boolean;
  help: boolean;
  maxIterations: number;
  maxToolCalls: number;
  timeoutMs: number;
  storeDir: string | undefined;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const DEFAULTS = {
  maxIterations: 24,
  maxToolCalls: 64,
  timeoutMs: 300_000,
};

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    task: undefined,
    cwd: process.cwd(),
    model: undefined,
    tools: [...DEFAULT_TOOL_NAMES],
    json: false,
    showThinking: false,
    yes: false,
    help: false,
    maxIterations: DEFAULTS.maxIterations,
    maxToolCalls: DEFAULTS.maxToolCalls,
    timeoutMs: DEFAULTS.timeoutMs,
    storeDir: undefined,
  };

  const words: string[] = [];
  let index = 0;

  const value = (flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined) throw new CliUsageError(`${flag} requires a value`);
    index += 1;
    return next;
  };

  const positiveInteger = (flag: string, raw: string): number => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new CliUsageError(`${flag} expects a positive integer, received "${raw}"`);
    }
    return parsed;
  };

  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    if (argument === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }

    switch (argument) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--cwd":
        options.cwd = value("--cwd");
        break;
      case "--model":
      case "-m":
        options.model = value("--model");
        break;
      case "--store-dir":
        options.storeDir = value("--store-dir");
        break;
      case "--read-only":
        options.tools = [...READ_ONLY_TOOL_NAMES];
        break;
      case "--no-bash":
        options.tools = options.tools.filter((name) => name !== "bash");
        break;
      case "--tools":
        options.tools = value("--tools")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "");
        break;
      case "--json":
        options.json = true;
        break;
      case "--thinking":
        options.showThinking = true;
        break;
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--max-iterations":
        options.maxIterations = positiveInteger("--max-iterations", value("--max-iterations"));
        break;
      case "--max-tool-calls":
        options.maxToolCalls = positiveInteger("--max-tool-calls", value("--max-tool-calls"));
        break;
      case "--timeout":
        options.timeoutMs = positiveInteger("--timeout", value("--timeout"));
        break;
      default:
        if (argument.startsWith("-") && argument !== "-") {
          throw new CliUsageError(`unknown option: ${argument}`);
        }
        words.push(argument);
        break;
    }
  }

  if (words.length > 0) options.task = words.join(" ");

  const known = new Set(ALL_TOOL_NAMES);
  for (const name of options.tools) {
    if (!known.has(name as (typeof ALL_TOOL_NAMES)[number])) {
      throw new CliUsageError(`unknown tool: ${name} (available: ${[...known].join(", ")})`);
    }
  }
  if (options.tools.length === 0) {
    throw new CliUsageError("no tools selected; the agent would be unable to do anything");
  }

  return options;
}

export function usageText(): string {
  return [
    "TinyCode — a minimal coding agent harness",
    "",
    "Usage:",
    '  tinycode [options] "<task>"',
    "",
    "Options:",
    "  -m, --model <provider/model>  Model to use (default: first authenticated)",
    "      --cwd <dir>               Workspace root (default: current directory)",
    "      --read-only               Expose only read, ls and grep",
    "      --no-bash                 Remove bash from the tool set",
    "      --tools <a,b,c>           Explicit tool selection",
    "      --max-iterations <n>      Iteration budget (default: 24)",
    "      --max-tool-calls <n>      Tool-call budget (default: 64)",
    "      --timeout <ms>            Wall-clock budget (default: 300000)",
    "      --json                    Emit raw JSONL events",
    "      --thinking                Show model thinking deltas",
    "  -y, --yes                     Answer yes to every confirmation (non-interactive)",
    "      --store-dir <dir>         Where run logs are written (default: <cwd>/.tinycode)",
    "  -h, --help                    Show this help",
    "",
    "Confirmations:",
    "  Destructive shell commands are gated: a recursive delete that leaves the",
    "  workspace, force-push, hard reset, sudo, piping remote content into a shell,",
    "  publishing a package, and similar. This is a safety net against accidents,",
    "  not a security boundary. With no terminal and no --yes, a gated command fails",
    "  the run rather than being assumed.",
    "",
    "Environment:",
    "  DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, ... provide provider auth.",
  ].join("\n");
}
