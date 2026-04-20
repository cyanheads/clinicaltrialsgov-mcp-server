/**
 * @fileoverview Single clinical study resource by NCT ID.
 * @module mcp-server/resources/definitions/study.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import { nctIdSchema } from '../../tools/utils/_schemas.js';

export const studyResource = resource('clinicaltrials://{nctId}', {
  name: 'Clinical Trial Study',
  description: 'Fetch a single clinical study by NCT ID. Returns full study data as JSON.',
  mimeType: 'application/json',
  params: z.object({
    nctId: nctIdSchema.describe('NCT identifier (e.g., NCT03722472).'),
  }),

  async handler(params, ctx) {
    const service = getClinicalTrialsService();
    const study = await service.getStudy(params.nctId, ctx);
    ctx.log.info('Study fetched', { nctId: params.nctId });
    return study;
  },
});
