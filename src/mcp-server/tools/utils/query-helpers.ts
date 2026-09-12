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

/**
 * Name the first supplied-but-blank string parameter, or `undefined` when every
 * supplied value carries non-whitespace. Omitted parameters are skipped —
 * omission keeps its documented meaning; only a value the caller actually
 * supplied is judged. Trimming, not a length check: `' '` is as empty as `''`,
 * and the upstream query builder drops both, silently widening the request to
 * the whole registry instead of constraining it.
 */
export function firstBlankParam(params: Record<string, string | undefined>): string | undefined {
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value.trim().length === 0) return name;
  }
  return undefined;
}

/**
 * Name the first supplied list parameter that is empty or carries a blank
 * entry. Pass lists already normalized through `toArray`, so the stringified
 * `'[]'` form LLM callers sometimes send is judged on what it resolves to.
 */
export function firstBlankListParam(
  params: Record<string, string[] | undefined>,
): string | undefined {
  for (const [name, values] of Object.entries(params)) {
    if (!values) continue;
    if (values.length === 0 || values.some((v) => v.trim().length === 0)) return name;
  }
  return undefined;
}

/**
 * Actionable message for a parameter supplied with a blank value. Leads with
 * the fix that works on a required parameter too — omitting one of those fails
 * the schema and returns a bare -32602 with no reason and no recovery hint.
 */
export function blankValueMessage(param: string): string {
  return `Parameter '${param}' was supplied with a blank value — an empty or whitespace-only string, an empty list, or a list carrying a blank entry. Supply a value containing non-whitespace, or for a list at least one non-blank entry; omit the parameter entirely only if it is optional and you meant to leave it unset.`;
}

/**
 * Build the AREA[] phase filter and combine it with the caller's advancedFilter.
 *
 * The caller's expression is parenthesized as a unit before the AND join. Essie
 * has no precedence rule that scopes a trailing `OR` back under a preceding
 * `AND`, so an ungrouped operand let the OR branch escape the phase constraint
 * entirely — a PHASE3 search answered with phase-less observational studies.
 * The wrap is unconditional: Essie tolerates redundant nested parentheses, and
 * deciding whether a caller's own leading `(` closes at the end of the
 * expression or midway through it would mean reimplementing the parser.
 *
 * An advancedFilter with no phase expression alongside it is returned untouched
 * — there is no AND boundary for its meaning to leak past.
 */
export function buildAdvancedFilter(
  phaseFilter?: string[],
  advancedFilter?: string,
): string | undefined {
  const phaseExpr = phaseFilter?.length
    ? phaseFilter.length === 1
      ? `AREA[Phase]${phaseFilter[0]}`
      : `(${phaseFilter.map((p) => `AREA[Phase]${p}`).join(' OR ')})`
    : undefined;
  if (!advancedFilter) return phaseExpr;
  return phaseExpr ? `${phaseExpr} AND (${advancedFilter})` : advancedFilter;
}

/**
 * Render one structured term as an upstream query operand: quoted when it
 * carries whitespace so it matches as a literal phrase, bare otherwise.
 *
 * An embedded `"` is stripped rather than escaped. Upstream Essie has no
 * working escape for a literal quote inside a quoted phrase and does not fail
 * on one — an unescaped `"` silently reparses into a different query that
 * returns a plausible-looking wrong result set, and a backslash-escaped one
 * matches nothing. Removing the character is the only handling that keeps the
 * phrase intact.
 */
export function quoteQueryTerm(term: string): string {
  const sanitized = term.replaceAll('"', '');
  return /\s/.test(sanitized) ? `"${sanitized}"` : sanitized;
}
