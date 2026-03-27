/**
 * @fileoverview Tests for clinicaltrials://{nctId} resource.
 * @module tests/study.resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));

import { studyResource } from '@/mcp-server/resources/definitions/study.resource.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

describe('studyResource', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
  });

  describe('params validation', () => {
    it('accepts valid NCT ID', () => {
      expect(() => studyResource.params.parse({ nctId: 'NCT03722472' })).not.toThrow();
    });

    it('rejects invalid NCT ID', () => {
      expect(() => studyResource.params.parse({ nctId: 'bad' })).toThrow();
      expect(() => studyResource.params.parse({ nctId: 'NCT1234' })).toThrow();
    });
  });

  describe('handler', () => {
    it('returns study data for valid params', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT03722472' } } };
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const params = studyResource.params.parse({ nctId: 'NCT03722472' });
      const result = await studyResource.handler(params, ctx);

      expect(result).toBe(study);
      expect(mockService.getStudy).toHaveBeenCalledWith('NCT03722472', ctx);
    });

    it('propagates service errors', async () => {
      mockService.getStudy.mockRejectedValue(new Error('Not found'));
      const ctx = createMockContext();
      const params = studyResource.params.parse({ nctId: 'NCT03722472' });

      await expect(studyResource.handler(params, ctx)).rejects.toThrow('Not found');
    });
  });
});
