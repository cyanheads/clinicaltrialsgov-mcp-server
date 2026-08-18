/**
 * @fileoverview Discover valid field values with study counts from ClinicalTrials.gov.
 * @module mcp-server/tools/definitions/get-field-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import { blankValueMessage, firstBlankListParam, toArray } from '../utils/query-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

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
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
    },
  ],

  input: z.object({
    fields: z
      .union([
        z.string().describe('A single PascalCase field name.'),
        z.array(z.string()).describe('Multiple PascalCase field names (at least one required).'),
      ])
      .describe(
        `PascalCase field name(s) to get value statistics for — an empty list is rejected, not treated as "every field". Examples: OverallStatus, Phase, StudyType, Sex, LeadSponsorClass. Use clinicaltrials_get_field_definitions with a query to find more field names.`,
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
                'True when the field is array-typed (a study can carry several values, e.g. Phase, Condition), so the per-value studiesCount buckets sum above the study total. Use to avoid computing a percentage against the corpus.',
              ),
            // ENUM / STRING fields
            uniqueValuesCount: z.number().optional().describe('Number of distinct values.'),
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
            // BOOLEAN fields
            trueCount: z
              .number()
              .optional()
              .describe('Studies where field is true. Present for BOOLEAN fields.'),
            falseCount: z
              .number()
              .optional()
              .describe('Studies where field is false. Present for BOOLEAN fields.'),
          })
          .describe('Statistics for a single requested field.'),
      )
      .describe(
        'One entry per requested field: canonical path, PascalCase piece name, data type, missing/unique counts, and top values with study counts (or trueCount/falseCount for BOOLEAN fields).',
      ),
  }),

  async handler(input, ctx) {
    // An empty list drops the upstream `fields` param and answers with the
    // whole ~418-field catalog. Both empty forms land here — the real array and
    // the stringified '[]', which validates as a string and only resolves to []
    // after toArray. Judged in the handler, not at the schema: the schema runs
    // first and surfaces a bare -32602 with no reason and no recovery hint. The
    // reason is blank_value rather than field_invalid, whose hint sends the
    // caller off to browse the field tree — not the question a caller who
    // supplied a blank is asking.
    const fields = toArray(input.fields);
    const blankParam = firstBlankListParam({ fields });
    if (blankParam) {
      throw ctx.fail('blank_value', blankValueMessage(blankParam), {
        param: blankParam,
        ...ctx.recoveryFor('blank_value'),
      });
    }
    const service = getClinicalTrialsService();
    const stats = await service.getFieldValues(fields, ctx);
    ctx.log.info('Field values fetched', { fieldCount: stats.length });
    return { fieldStats: stats };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const stat of result.fieldStats) {
      const header =
        stat.type === 'BOOLEAN'
          ? `**${stat.piece}** — ${stat.field} (boolean):`
          : `**${stat.piece}** — ${stat.field} (${stat.type}, ${stat.uniqueValuesCount ?? '?'} unique values):`;
      lines.push(header);
      if (stat.trueCount != null) lines.push(`  true: ${stat.trueCount} studies`);
      if (stat.falseCount != null) lines.push(`  false: ${stat.falseCount} studies`);
      const topValues = stat.topValues ?? [];
      if (stat.type !== 'BOOLEAN') {
        if (topValues.length === 0) {
          lines.push('  No recorded values for this field.');
        } else {
          // Render every fetched value with its study count — content[] must
          // carry the same topValues the handler returns in structuredContent,
          // or content-only clients go blind past the 16th value (#90).
          for (const tv of topValues) {
            lines.push(`  ${tv.value}: ${tv.studiesCount} studies`);
          }
          // topValues is upstream-capped at 250. When the field has more distinct
          // values than were fetched, the tail is unreachable (beyond the API cap),
          // not omitted by us — disclose that honestly rather than implying we trimmed.
          const unique = stat.uniqueValuesCount;
          if (unique != null && unique > topValues.length) {
            lines.push(
              `  Showing all ${topValues.length} fetched values (of ${unique} unique; topValues capped at 250 by the API).`,
            );
          }
        }
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
