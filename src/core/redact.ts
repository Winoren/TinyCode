/**
 * Credential redaction.
 *
 * The Skill's security defaults state that secrets never enter state, events or
 * traces, and that they are redacted before logging. This module is that gate.
 *
 * Two design choices worth stating:
 *
 * - **Exact values, not patterns.** We redact the credentials we actually hold, not
 *   anything shaped like an API key. Pattern matching would corrupt legitimate
 *   content — a tool result quoting a key from the user's own file, documentation, or
 *   a test fixture — and false positives in a coding agent's transcript are worse than
 *   the leak they prevent.
 * - **Very short values are ignored.** Redacting a 3-character "secret" would blank
 *   out ordinary prose everywhere. Real provider keys are long; anything shorter than
 *   `MINIMUM_SECRET_LENGTH` is not treated as a credential and is reported by
 *   `createRedactor().ignored` so the omission is visible rather than silent.
 */

const MINIMUM_SECRET_LENGTH = 8;
const PLACEHOLDER = "[redacted]";

export interface Redactor {
  (text: string): string;
  /** Number of distinct secrets actually being redacted. Zero means a no-op. */
  readonly size: number;
  /** Candidates rejected as too short to redact safely. */
  readonly ignored: readonly string[];
}

/** A redactor that changes nothing, for the common case of no configured secrets. */
export const identityRedactor: Redactor = Object.assign((text: string) => text, {
  size: 0,
  ignored: [] as readonly string[],
});

export function createRedactor(candidates: readonly string[]): Redactor {
  const secrets: string[] = [];
  const ignored: string[] = [];

  for (const candidate of candidates) {
    if (candidate === "") continue;
    if (candidate.length < MINIMUM_SECRET_LENGTH) {
      ignored.push(candidate);
      continue;
    }
    if (!secrets.includes(candidate)) secrets.push(candidate);
  }

  if (secrets.length === 0) {
    return Object.assign((text: string) => text, { size: 0, ignored });
  }

  // Longest first, so a secret that contains another is replaced whole.
  secrets.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(secrets.map(escapeRegExp).join("|"), "g");

  return Object.assign((text: string) => text.replace(pattern, PLACEHOLDER), {
    size: secrets.length,
    ignored,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact every string in a value, cloning only along paths that actually changed.
 *
 * Copy-on-write keeps the common case (nothing to redact) from doubling the memory of
 * large tool results, which can be hundreds of kilobytes.
 */
export function redactValue<T>(value: T, redact: Redactor): T {
  if (redact.size === 0) return value;

  if (typeof value === "string") {
    const redacted = redact(value);
    return (redacted === value ? value : redacted) as T;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const redacted = redactValue(item, redact);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? output : value) as T;
  }

  if (value !== null && typeof value === "object") {
    // Only plain objects: class instances may not survive a structural copy.
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return value;

    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactValue(entry, redact);
      if (redacted !== entry) changed = true;
      output[key] = redacted;
    }
    return (changed ? output : value) as T;
  }

  return value;
}
