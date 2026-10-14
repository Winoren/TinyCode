/**
 * Binary detection — one implementation, shared by `read` and `grep`.
 *
 * Two tools need the same answer to "is this a text file?", and having written it twice
 * once already, it lives here. The `read` tool previously decoded anything at all as
 * UTF-8, so a PNG or a compiled artefact became replacement characters in the
 * transcript: the model paid context for content that carried no information.
 *
 * The heuristic is the standard one — a NUL byte in the first block. It can miss a
 * binary whose first 8 KB happens to contain no NUL, which is why the tools report what
 * they did rather than claiming certainty.
 */

/** How much of a file to inspect before deciding. */
export const SNIFF_BYTES = 8_000;

/** NUL in the leading block is the conventional signal for "not text". */
export function looksBinary(content: Uint8Array): boolean {
  const probe = content.subarray(0, SNIFF_BYTES);
  return probe.includes(0);
}
