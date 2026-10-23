/**
 * @fileoverview Discover valid field values with study counts from ClinicalTrials.gov.
 * @module mcp-server/tools/definitions/get-field-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { FieldValueStats } from '@/services/clinical-trials/types.js';
import {
  blankValueMessage,
  firstBlankListParam,
  splitListEntries,
  toArray,
} from '../utils/query-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

/**
 * Characters of `longest.value` returned before it becomes a preview. Upstream
 * longest values sit at or under ~1,600 characters except the document-scale
 * fields (DetailedDescription, ReferenceCitation, EligibilityCriteria,
 * BriefSummary), which run to 32k; this bound previews only those.
 */
const LONGEST_PREVIEW_CHARS = 2000;

type LongestValue = NonNullable<FieldValueStats['longest']> & { truncated?: true | undefined };

/** A provider stat as both surfaces carry it — see `presentFieldStat`. */
type PresentedFieldStats = Omit<FieldValueStats, 'longest'> & {
  longest?: LongestValue;
  uniqueValuesCounted?: false;
};

/**
 * Cut a longest value past the bound to a prefix, flagged `truncated`. `length`
 * stays the provider's full length. The cut steps back one code unit rather
 * than end on a high surrogate, which would leave half a character.
 */
function boundLongest(longest: LongestValue): LongestValue {
  if (longest.value.length <= LONGEST_PREVIEW_CHARS) return longest;
  const lastCode = longest.value.charCodeAt(LONGEST_PREVIEW_CHARS - 1);
  const end =
    lastCode >= 0xd800 && lastCode <= 0xdbff ? LONGEST_PREVIEW_CHARS - 1 : LONGEST_PREVIEW_CHARS;
  return { ...longest, value: longest.value.slice(0, end), truncated: true };
}

/**
 * Shape one provider stat for both surfaces: bound its longest value (#161),
 * and flag `uniqueValuesCounted: false` when the provider's `uniqueValuesCount`
 * is 0 yet a recorded longest value shows the field has values. The provider
 * reports 0 for free-text fields it does not count distinct values on
 * (DetailedDescription, filled in ~400k studies); the 0 itself passes through
 * unchanged. A field it reports no values for carries no longest, so its 0 is
 * a real count and gets no flag (#165).
 */
function presentFieldStat(stat: FieldValueStats): PresentedFieldStats {
  if (!stat.longest) return stat;
  return {
    ...stat,
    ...(stat.uniqueValuesCount === 0 ? { uniqueValuesCounted: false as const } : {}),
    longest: boundLongest(stat.longest),
  };
}

/**
 * Provider text as a fenced block, verbatim. Interpolated inline, a line break
 * would start a new line of the listing — a heading, a list item, a forged
 * field header — and a line's leading whitespace would be dropped. A fence
 * longer than any backtick run in the value cannot be closed from inside.
 */
function fenced(value: string): string[] {
  let longestRun = 0;
  for (const [run] of value.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [fence, value, fence];
}

/** The `content[]` lines for a longest value. */
function renderLongest({ value, length, nctId, truncated }: LongestValue): string[] {
  const extent = truncated
    ? `first ${value.length} of ${length} characters`
    : `${length} characters`;
  if (!/[\r\n]/.test(value)) {
    // Mid-line inside quotes: no block marker applies, only the inline escapes.
    const quoted = `"${inertText(value, '"', '"')}"`;
    return truncated
      ? [`  longest value (${extent}, in ${nctId}): ${quoted}`]
      : [`  longest value: ${quoted} (${extent}, in ${nctId})`];
  }
  return [`  longest value (${extent}, in ${nctId}):`, ...fenced(value)];
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const SURROGATE = /[\uD800-\uDFFF]/;
const ENTITY = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/;

/**
 * Index of the character that opens a block when `value` starts a line — an
 * ATX heading, a list item, a blockquote, a tilde fence — or -1. Setext
 * underlines and thematic breaks need the whole line, and the `: N studies`
 * suffix keeps a line from ever being one.
 */
function blockMarkerAt(value: string): number {
  if (/^(?:#{1,6}[ \t]|[-+*][ \t]|>|~{3})/.test(value)) return 0;
  const ordered = /^\d{1,9}(?=[.)][ \t])/.exec(value);
  return ordered ? ordered[0].length : -1;
}

/**
 * Whether a `*` or `_` run between `prev` and `next` can open or close
 * emphasis, by CommonMark's flanking rules. It can pair with a run on another
 * line of the same paragraph, so no run that could delimit is left bare. A
 * neighbor outside the BMP is classified differently across renderers, so a
 * run beside one is treated as delimiting.
 */
function canDelimit(char: string, prev: string, next: string): boolean {
  if (SURROGATE.test(prev) || SURROGATE.test(next)) return true;
  const prevSpace = WHITESPACE.test(prev);
  const nextSpace = WHITESPACE.test(next);
  const prevPunct = PUNCTUATION.test(prev);
  const nextPunct = PUNCTUATION.test(next);
  const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  if (char === '*') return left || right;
  return (left && (!right || prevPunct)) || (right && (!left || nextPunct));
}

/**
 * Single-line provider text as written into a `content[]` line between the
 * characters `before` and `after`. Backslash-escapes exactly the characters
 * that would make CommonMark render something other than the value there: the
 * block marker at `markerAt`, an emphasis run that can delimit, every backtick
 * (a code span pairs across lines), a backslash before punctuation, `<`
 * opening a tag or autolink, `&` opening an entity, and `](` closing a link.
 * Everything else is written as is, so `cdrh_docs` and `<=18 years` stay
 * byte-identical.
 */
function inertText(value: string, before: string, after: string, markerAt = -1): string {
  const charAt = (index: number) => (index < 0 ? before : (value[index] ?? after));
  let out = '';
  for (let i = 0; i < value.length; ) {
    const char = value[i] as string;
    if (char === '*' || char === '_') {
      let end = i + 1;
      while (value[end] === char) end++;
      const run = value.slice(i, end);
      const escapeRun =
        (markerAt >= i && markerAt < end) || canDelimit(char, charAt(i - 1), charAt(end));
      out += escapeRun ? run.replaceAll(char, `\\${char}`) : run;
      i = end;
      continue;
    }
    const next = charAt(i + 1);
    const escapeChar =
      i === markerAt ||
      char === '`' ||
      (char === '\\' && ASCII_PUNCTUATION.test(next)) ||
      (char === '<' && /[A-Za-z/!?]/.test(next)) ||
      (char === ']' && next === '(') ||
      (char === '&' && ENTITY.test(value.slice(i, i + 34)));
    out += escapeChar ? `\\${char}` : char;
    i++;
  }
  return out;
}

/**
 * A single-line topValues value as it starts a `content[]` line: after the
 * indent, before its `: N studies` suffix, with a leading block marker escaped.
 */
function inertLine(value: string): string {
  return inertText(value, ' ', ':', blockMarkerAt(value));
}

/**
 * The `content[]` lines for one topValues entry. A value with a line break or
 * leading whitespace cannot be carried exactly on one line, so it gets a
 * fenced block; any other value is escaped in place.
 */
function renderTopValue({ value, studiesCount }: { value: string; studiesCount: number }) {
  return /[\r\n]|^[ \t]/.test(value)
    ? [`  value (${studiesCount} studies):`, ...fenced(value)]
    : [`  ${inertLine(value)}: ${studiesCount} studies`];
}

export const getFieldValues = tool('clinicaltrials_get_field_values', {
  description: `Discover valid values for ClinicalTrials.gov fields with study counts per value. Use to explore available filter options before building a search — e.g., valid OverallStatus, Phase, InterventionType, StudyType, or LeadSponsorClass values.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'blank_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parameter was supplied with a blank, whitespace-only, or empty-list value.',
      recovery: RECOVERY_HINTS.blank_value,
    },
    {
      reason: 'field_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A requested field name is not a valid PascalCase piece name.',
      recovery: RECOVERY_HINTS.field_invalid,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    fields: z
      .union([
        z.string().describe('A single PascalCase field name.'),
        z.array(z.string()).describe('Multiple PascalCase field names (at least one required).'),
      ])
      .describe(
        `PascalCase field name(s) to get value statistics for — an empty list is rejected, not treated as "every field". A comma- or pipe-joined string ("Phase,StudyType") is split into separate names. Examples: OverallStatus, Phase, StudyType, Sex, LeadSponsorClass. Use clinicaltrials_get_field_definitions with a query to find more field names.`,
      ),
  }),

  output: z.object({
    fieldStats: z
      .array(
        z
          .object({
            field: z.string().describe('Full dot-notation field path.'),
            piece: z.string().describe('PascalCase piece name.'),
            type: z.string().describe('Field data type (ENUM, BOOLEAN, STRING, DATE, etc.).'),
            missingStudiesCount: z
              .number()
              .optional()
              .describe('Number of studies where this field is absent.'),
            multiValued: z
              .boolean()
              .optional()
              .describe(
                'True when the field is repeated — array-typed itself (Phase, Condition) or nested under a repeated object (LocationCountry, one per site) — so a study can carry several values and the per-value studiesCount buckets sum above the study total. Use to avoid computing a percentage against the corpus.',
              ),
            // ENUM / STRING fields
            uniqueValuesCount: z
              .number()
              .optional()
              .describe(
                'Number of distinct values, as ClinicalTrials.gov reports it. Free-text STRING fields it does not count (DetailedDescription, EligibilityCriteria) report 0 here alongside uniqueValuesCounted: false — that 0 is not a count. A 0 without the flag means no recorded values.',
              ),
            uniqueValuesCounted: z
              .literal(false)
              .optional()
              .describe(
                'False when ClinicalTrials.gov did not count distinct values for this field, so the uniqueValuesCount of 0 is not a real count — the field has recorded values (see longest) but no topValues. Absent otherwise.',
              ),
            topValues: z
              .array(
                z
                  .object({
                    value: z.string().describe('Field value.'),
                    studiesCount: z.number().describe('Number of studies with this value.'),
                  })
                  .describe('A value and its study count.'),
              )
              .optional()
              .describe(
                'Values ranked by frequency (capped at 250 by the API). Present for ENUM/STRING fields. When multiValued is true, studiesCount sums can exceed the study total.',
              ),
            longest: z
              .object({
                value: z
                  .string()
                  .describe(
                    'The longest recorded value — when truncated is true, only a prefix of at most 2,000 characters (1,999 when the cut would split a surrogate pair).',
                  ),
                length: z
                  .number()
                  .describe(
                    'Full length of the recorded value in characters, even when truncated.',
                  ),
                nctId: z.string().describe('NCT ID of a study carrying it.'),
                truncated: z
                  .literal(true)
                  .optional()
                  .describe(
                    'True when value is a preview of at most 2,000 characters; absent when value is whole. The notice names the clinicaltrials_search_studies call that returns the full text.',
                  ),
              })
              .optional()
              .describe(
                'Longest recorded value with its length and a study carrying it. Present for STRING fields only.',
              ),
            // BOOLEAN fields
            trueCount: z
              .number()
              .optional()
              .describe('Studies where field is true. Present for BOOLEAN fields.'),
            falseCount: z
              .number()
              .optional()
              .describe('Studies where field is false. Present for BOOLEAN fields.'),
            // INTEGER / NUMBER / DATE fields
            min: z
              .union([
                z.number().describe('Smallest value of an INTEGER/NUMBER field.'),
                z
                  .string()
                  .describe(
                    'Earliest value of a DATE field, at the precision recorded — a partial date such as "1900-01" stays partial.',
                  ),
              ])
              .optional()
              .describe(
                'Smallest recorded value — a number for INTEGER/NUMBER, a date string for DATE.',
              ),
            max: z
              .union([
                z.number().describe('Largest value of an INTEGER/NUMBER field.'),
                z.string().describe('Latest value of a DATE field, at the precision recorded.'),
              ])
              .optional()
              .describe(
                'Largest recorded value — a number for INTEGER/NUMBER, a date string for DATE.',
              ),
            avg: z
              .number()
              .optional()
              .describe('Mean of the recorded values. Present for INTEGER/NUMBER fields.'),
            formats: z
              .array(z.string().describe('A date pattern, e.g. "yyyy-MM-dd".'))
              .optional()
              .describe(
                'Date patterns this field is recorded in. Present for DATE fields; more than one means the field mixes precisions across studies.',
              ),
          })
          .describe('Statistics for a single requested field.'),
      )
      .describe(
        'One entry per requested field: canonical path, PascalCase piece name, data type, and the statistics variant that type carries — top values with study counts plus unique/longest for ENUM/STRING, trueCount/falseCount for BOOLEAN, min/max/avg for INTEGER/NUMBER, min/max/formats for DATE.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a longest value was cut to a preview — names, for each such field, the clinicaltrials_search_studies arguments that return its full text.',
      ),
  },

  async handler(input, ctx) {
    // An empty list drops the upstream `fields` param and answers with the
    // whole ~418-field catalog. Both empty forms land here — the real array and
    // the stringified '[]', which validates as a string and only resolves to []
    // after toArray. Judged in the handler, not at the schema: the schema runs
    // first and surfaces a bare -32602 with no reason and no recovery hint. The
    // reason is blank_value rather than field_invalid, whose hint sends the
    // caller off to browse the field tree — not the question a caller who
    // supplied a blank is asking. Entries are split on `,`/`|` before the
    // check, so `[","]` is judged blank rather than as a field named ",".
    const fields = splitListEntries(toArray(input.fields));
    const blankParam = firstBlankListParam({ fields });
    if (blankParam) {
      throw ctx.fail('blank_value', blankValueMessage(blankParam), { param: blankParam });
    }
    const service = getClinicalTrialsService();
    const stats = await service.getFieldValues(fields, ctx);
    ctx.log.info('Field values fetched', { fieldCount: stats.length });
    const fieldStats = stats.map(presentFieldStat);
    /**
     * search_studies with explicit fields returns the untruncated text on both
     * surfaces, protocol and results sections alike; get_study_record omits
     * resultsSection, so it cannot be the retrieval path.
     */
    const retrieval = fieldStats.flatMap(({ piece, longest }) =>
      longest?.truncated
        ? [
            `${piece}: clinicaltrials_search_studies with ${JSON.stringify({ nctIds: [longest.nctId], fields: [piece] })}`,
          ]
        : [],
    );
    if (retrieval.length > 0) {
      ctx.enrich.notice(
        `longest.value is a preview of at most the first ${LONGEST_PREVIEW_CHARS} characters where longest.truncated is true; longest.length is the full length. Full text — ${retrieval.join('; ')}.`,
      );
    }
    return { fieldStats };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const stat of result.fieldStats) {
      // `type` selects the header and, when nothing at all was reported, which
      // absence line is honest for that variant. Everything else renders on
      // presence rather than on type: upstream omits the keys a variant does not
      // carry, so presence already is the variant, and rendering only what one
      // type branch expects is what dropped the INTEGER/NUMBER/DATE statistics
      // and reported a populated range as an empty dataset (#119).
      const ranged = stat.type === 'INTEGER' || stat.type === 'NUMBER';
      const dated = stat.type === 'DATE';
      const boolish = stat.type === 'BOOLEAN';
      // A flagged 0 is a count the provider did not take, never zero (#165).
      const uniqueLabel =
        stat.uniqueValuesCounted === false
          ? 'distinct values not counted'
          : `${stat.uniqueValuesCount ?? '?'} unique values`;
      const typeLabel = boolish
        ? 'boolean'
        : ranged || dated
          ? stat.type
          : `${stat.type}, ${uniqueLabel}`;
      lines.push(`**${stat.piece}** — ${stat.field} (${typeLabel}):`);

      const body: string[] = [];
      if (stat.trueCount != null) body.push(`  true: ${stat.trueCount} studies`);
      if (stat.falseCount != null) body.push(`  false: ${stat.falseCount} studies`);
      // String() and nothing else: a date bound keeps the precision it was
      // written with ("1900-01" stays a month), and an average keeps every
      // digit, so content[] carries exactly what structuredContent does.
      if (stat.min != null) body.push(`  min: ${String(stat.min)}`);
      if (stat.max != null) body.push(`  max: ${String(stat.max)}`);
      if (stat.avg != null) body.push(`  avg: ${String(stat.avg)}`);
      if (stat.formats?.length) body.push(`  date formats: ${stat.formats.join(', ')}`);
      // Render every fetched value with its study count — content[] must carry
      // the same topValues the handler returns in structuredContent, or
      // content-only clients go blind past the 16th value (#90).
      const topValues = stat.topValues ?? [];
      for (const tv of topValues) body.push(...renderTopValue(tv));
      // topValues is upstream-capped at 250. When the field has more distinct
      // values than were fetched, the tail is unreachable (beyond the API cap),
      // not omitted by us — disclose that honestly rather than implying we trimmed.
      const unique = stat.uniqueValuesCount;
      if (topValues.length > 0 && unique != null && unique > topValues.length) {
        body.push(
          `  Showing all ${topValues.length} fetched values (of ${unique} unique; topValues capped at 250 by the API).`,
        );
      }
      if (stat.longest) body.push(...renderLongest(stat.longest));

      if (body.length > 0) {
        lines.push(...body);
      } else if (ranged) {
        // Distinct from the ENUM/STRING empty-value line (#25), which would name
        // the wrong variant: upstream reports no value buckets for these types at
        // all, so a missing bucket list says nothing about whether values exist.
        lines.push('  No range or average reported for this field.');
      } else if (dated) {
        lines.push('  No date range or formats reported for this field.');
      } else if (!boolish) {
        lines.push('  No recorded values for this field.');
      }

      if (stat.missingStudiesCount != null && stat.missingStudiesCount > 0)
        lines.push(`  (missing in ${stat.missingStudiesCount} studies)`);
      if (stat.multiValued)
        lines.push(
          '  (multi-valued field — counts may exceed the study total; a study can carry several values)',
        );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
