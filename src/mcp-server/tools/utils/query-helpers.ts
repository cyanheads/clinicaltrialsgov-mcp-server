/**
 * @fileoverview Shared helpers for normalizing tool inputs into API search parameters.
 * @module mcp-server/tools/definitions/query-helpers
 */

/** Normalize string | string[] to string[]. */
export function toArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return;
  return Array.isArray(v) ? v : [v];
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
