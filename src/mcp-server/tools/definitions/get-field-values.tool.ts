/**
 * @fileoverview Discover valid field values with study counts from ClinicalTrials.gov.
 * @module mcp-server/tools/definitions/get-field-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

export const getFieldValues = tool('clinicaltrials_get_field_values', {
  description: `Discover valid values for ClinicalTrials.gov fields with study counts per value. Use to explore available filter options before building a search — e.g., valid OverallStatus, Phase, InterventionType, StudyType, or LeadSponsorClass values.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    fields: z
      .union([z.string(), z.array(z.string())])
      .describe(
        `PascalCase piece name(s) to get values for. Common fields: OverallStatus, Phase, StudyType, InterventionType, LeadSponsorClass, Sex, StdAge, DesignAllocation, DesignPrimaryPurpose, DesignMasking.`,
      ),
  }),

  output: z.object({
    fieldStats: z
      .array(
        z.object({
          field: z.string().describe('Full dot-notation field path.'),
          piece: z.string().describe('PascalCase piece name.'),
          type: z.string().describe('Field data type (ENUM, BOOLEAN, STRING, DATE, etc.).'),
          missingStudiesCount: z
            .number()
            .optional()
            .describe('Number of studies where this field is absent.'),
          // ENUM / STRING fields
          uniqueValuesCount: z.number().optional().describe('Number of distinct values.'),
          topValues: z
            .array(
              z.object({
                value: z.string().describe('Field value.'),
                studiesCount: z.number().describe('Number of studies with this value.'),
              }),
            )
            .optional()
            .describe(
              'Values ranked by frequency (capped at 250 by the API). Present for ENUM/STRING fields.',
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
        }),
      )
      .describe('Statistics per requested field.'),
  }),

  async handler(input, ctx) {
    const fields = Array.isArray(input.fields) ? input.fields : [input.fields];
    const service = getClinicalTrialsService();
    const stats = await service.getFieldValues(fields, ctx);
    ctx.log.info('Field values fetched', { fieldCount: stats.length });
    return { fieldStats: stats };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const stat of result.fieldStats) {
      if (stat.type === 'BOOLEAN') {
        lines.push(`**${stat.piece}** (boolean):`);
        if (stat.trueCount != null)
          lines.push(`  true: ${stat.trueCount.toLocaleString()} studies`);
        if (stat.falseCount != null)
          lines.push(`  false: ${stat.falseCount.toLocaleString()} studies`);
      } else {
        lines.push(`**${stat.piece}** (${stat.uniqueValuesCount ?? '?'} unique values):`);
        const topValues = stat.topValues ?? [];
        if (topValues.length === 0) {
          lines.push('  No recorded values for this field.');
        } else {
          const shown = topValues.slice(0, 15);
          for (const tv of shown) {
            lines.push(`  ${tv.value}: ${tv.studiesCount.toLocaleString()} studies`);
          }
          if (topValues.length > shown.length) {
            const remainder = topValues.length - shown.length;
            const unique = stat.uniqueValuesCount?.toLocaleString();
            lines.push(
              `  … and ${remainder} more values in structuredContent${unique ? ` (of ${unique} unique; topValues capped at 250)` : ''}`,
            );
          }
        }
      }
      if (stat.missingStudiesCount != null && stat.missingStudiesCount > 0)
        lines.push(`  (missing in ${stat.missingStudiesCount.toLocaleString()} studies)`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
