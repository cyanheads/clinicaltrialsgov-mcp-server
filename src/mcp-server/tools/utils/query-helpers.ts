/**
 * @fileoverview Shared helpers for normalizing tool inputs into API search parameters.
 * @module mcp-server/tools/definitions/query-helpers
 */

/**
 * Normalize `string | string[]` to `string[]`.
 *
 * LLM callers intermittently serialize array arguments as JSON strings
 * (`'["RECRUITING","COMPLETED"]'` rather than `["RECRUITING","COMPLETED"]`). A
 * `[`-leading string that `JSON.parse`s to an all-string array is unwrapped to
 * that array. Every legitimate scalar this normalizes (status/phase enums, NCT
 * IDs, PascalCase field names) starts with a letter, so a `[`-leading string is
 * always either a stringified array or garbage — and garbage falls through to
 * the scalar-wrap, preserving the prior behavior.
 */
export function toArray(v: string | string[]): string[];
export function toArray(v: string | string[] | undefined): string[] | undefined;
export function toArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return;
  if (Array.isArray(v)) return v;
  const trimmed = v.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) {
        return parsed;
      }
    } catch {
      // Not valid JSON — fall through to the scalar-wrap (unchanged behavior).
    }
  }
  return [v];
}

/** Build AREA[] phase filter and combine with user's advancedFilter. */
export function buildAdvancedFilter(
  phaseFilter?: string[],
  advancedFilter?: string,
): string | undefined {
  const parts: string[] = [];
  if (phaseFilter?.length) {
    const expr =
      phaseFilter.length === 1
        ? `AREA[Phase]${phaseFilter[0]}`
        : `(${phaseFilter.map((p) => `AREA[Phase]${p}`).join(' OR ')})`;
    parts.push(expr);
  }
  if (advancedFilter) parts.push(advancedFilter);
  return parts.length > 0 ? parts.join(' AND ') : undefined;
}
