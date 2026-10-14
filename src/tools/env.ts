/**
 * Environment scrubbing for spawned commands.
 *
 * A coding agent runs shell commands the *model* wrote. Inheriting the agent's own
 * environment wholesale hands those commands every credential the agent holds, so
 * `echo $DEEPSEEK_API_KEY` — or anything that exfiltrates it — is one tool call away.
 *
 * Redaction (see `core/redact.ts`) protects the durable trace. It does **not** protect
 * the model's context: a tool result is handed to the model as clear text and only
 * afterwards recorded. So scrubbing has to happen at the source, not at the log.
 *
 * Scope is deliberately narrow: only the credential variables belonging to providers
 * this run actually uses are removed. Blanking every `*_TOKEN` would break ordinary
 * workflows (a build that needs `GITHUB_TOKEN`) for no security gain, because the agent
 * never held those values in the first place.
 */

/** A copy of `env` with the named variables removed. */
export function scrubEnvironment(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  if (names.length === 0) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const name of names) delete scrubbed[name];
  return scrubbed;
}

/** Names present in `env`, for reporting what was actually withheld. */
export function presentNames(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((name) => env[name] !== undefined && env[name] !== "");
}
