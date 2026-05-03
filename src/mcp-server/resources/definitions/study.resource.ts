/**
 * @fileoverview Single clinical study resource by NCT ID.
 * @module mcp-server/resources/definitions/study.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import { nctIdSchema } from '../../tools/utils/_schemas.js';
import { RECOVERY_HINTS } from '../../tools/utils/recovery-hints.js';

export const studyResource = resource('clinicaltrials://{nctId}', {
  name: 'Clinical Trial Study',
  description: 'Fetch a single clinical study by NCT ID. Returns full study data as JSON.',
  mimeType: 'application/json',
  errors: [
    {
      reason: 'study_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The provided NCT ID does not match any study at ClinicalTrials.gov.',
      recovery: RECOVERY_HINTS.study_not_found,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
    },
  ],
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
