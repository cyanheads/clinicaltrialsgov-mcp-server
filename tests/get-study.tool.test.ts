/**
 * @fileoverview Tests for clinicaltrials_get_study tool.
 * @module tests/get-study.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));

import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

describe('getStudy', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('accepts valid NCT ID', () => {
      expect(() => getStudy.input.parse({ nctId: 'NCT12345678' })).not.toThrow();
    });

    it('rejects invalid NCT ID format', () => {
      expect(() => getStudy.input.parse({ nctId: 'INVALID' })).toThrow();
      expect(() => getStudy.input.parse({ nctId: 'NCT1234' })).toThrow();
      expect(() => getStudy.input.parse({ nctId: 'nct12345678' })).toThrow();
    });
  });

  describe('handler', () => {
    it('returns study for valid nctId', async () => {
      const study = {
        protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
      };
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const result = await getStudy.handler(getStudy.input.parse({ nctId: 'NCT12345678' }), ctx);

      expect(result.study).toBe(study);
      expect(mockService.getStudy).toHaveBeenCalledWith('NCT12345678', ctx);
    });

    it('propagates service errors', async () => {
      mockService.getStudy.mockRejectedValue(new Error('Not found'));
      const ctx = createMockContext();
      await expect(
        getStudy.handler(getStudy.input.parse({ nctId: 'NCT12345678' }), ctx),
      ).rejects.toThrow('Not found');
    });
  });

  describe('format', () => {
    it('renders study with title', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'My Study' },
          },
        },
      });
      expect(blocks).toEqual([{ type: 'text', text: '**NCT12345678**: My Study' }]);
    });

    it('falls back to officialTitle when briefTitle missing', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', officialTitle: 'Official Title' },
          },
        },
      });
      expect(blocks[0].text).toBe('**NCT12345678**: Official Title');
    });

    it('falls back to Unknown when no title', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: { identificationModule: { nctId: 'NCT12345678' } },
        },
      });
      expect(blocks[0].text).toBe('**NCT12345678**: Unknown');
    });

    it('falls back to Study when no nctId', () => {
      const blocks = getStudy.format!({ study: {} });
      expect(blocks[0].text).toBe('**Study**: Unknown');
    });
  });
});
