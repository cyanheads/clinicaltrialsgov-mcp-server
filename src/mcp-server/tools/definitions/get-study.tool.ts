/**
 * @fileoverview Single study lookup by NCT ID. Mirrors the clinicaltrials://{nctId}
 * resource as a tool for clients that don't support MCP resources.
 * @module mcp-server/tools/definitions/get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

export const getStudy = tool('clinicaltrials_get_study', {
  description:
    'Fetch a single clinical study by NCT ID. Returns the full study record. Equivalent to the clinicaltrials://{nctId} resource for clients that do not support MCP resources.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    nctId: z
      .string()
      .regex(/^NCT\d{8}$/)
      .describe('NCT identifier (e.g., NCT03722472).'),
  }),

  output: z.object({
    study: z.record(z.string(), z.unknown()).describe('Full study record.'),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const study = await service.getStudy(input.nctId, ctx);
    ctx.log.info('Study fetched', { nctId: input.nctId });
    return { study };
  },

  format: (result) => {
    const proto = result.study.protocolSection as Record<string, unknown> | undefined;
    const id = proto?.identificationModule as Record<string, unknown> | undefined;
    const title = (id?.briefTitle as string) ?? (id?.officialTitle as string) ?? 'Unknown';
    return [{ type: 'text', text: `**${(id?.nctId as string) ?? 'Study'}**: ${title}` }];
  },
});
