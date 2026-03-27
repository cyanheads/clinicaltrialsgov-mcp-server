/**
 * @fileoverview Get canonical enum type definitions from the ClinicalTrials.gov data model.
 * @module mcp-server/tools/definitions/get-enums.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

export const getEnums = tool('clinicaltrials_get_enums', {
  description: `Get all valid enum types and their values from the ClinicalTrials.gov data model. Returns the canonical, exhaustive set of allowed values for enum fields — useful for understanding all valid filter options and their legacy display names. For value frequency distributions (how many studies use each value), use clinicaltrials_get_field_values instead.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    enumTypes: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        `Filter to specific enum type names. Common types: Status, Phase, StudyType, InterventionType, Sex, StandardAge, AgencyClass, DesignAllocation, PrimaryPurpose, DesignMasking, ArmGroupType, ObservationalModel. Case-sensitive. Omit for all types (~40).`,
      ),
  }),

  output: z.object({
    enums: z
      .array(
        z.object({
          type: z.string().describe('Enum type name.'),
          pieces: z.array(z.string()).describe('Piece names that use this enum.'),
          values: z
            .array(
              z.object({
                value: z.string().describe('Canonical enum value.'),
                legacyValue: z.string().optional().describe('Legacy display name.'),
              }),
            )
            .describe('All valid values for this enum type.'),
        }),
      )
      .describe('Enum type definitions.'),
    totalTypes: z.number().describe('Number of enum types returned.'),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    let enums = await service.getEnums(ctx);

    if (input.enumTypes) {
      const filter = new Set(Array.isArray(input.enumTypes) ? input.enumTypes : [input.enumTypes]);
      enums = enums.filter((e) => filter.has(e.type));
      if (enums.length === 0) {
        throw new Error(
          `No enum type matching '${[...filter].join(', ')}'. ` +
            `Call without enumTypes to see all available types, or check exact names: ` +
            `Status, Phase, StudyType, InterventionType, Sex, StandardAge, AgencyClass, etc.`,
        );
      }
    }

    ctx.log.info('Enums fetched', { typeCount: enums.length });
    return { enums, totalTypes: enums.length };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const enumDef of result.enums) {
      const pieces = enumDef.pieces.length > 0 ? ` (used by: ${enumDef.pieces.join(', ')})` : '';
      lines.push(`**${enumDef.type}**${pieces} — ${enumDef.values.length} values:`);
      for (const v of enumDef.values) {
        const legacy = v.legacyValue && v.legacyValue !== v.value ? ` → ${v.legacyValue}` : '';
        lines.push(`  ${v.value}${legacy}`);
      }
    }
    if (lines.length === 0) lines.push('No enum types found.');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
