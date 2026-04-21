/**
 * @fileoverview Tests for clinicaltrials://{nctId} resource.
 * @module tests/mcp-server/resources/definitions/study.resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { studyResource } from '@/mcp-server/resources/definitions/study.resource.js';

describe('studyResource', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  const params = studyResource.params!;

  describe('params validation', () => {
    it('accepts valid NCT ID', () => {
      expect(() => params.parse({ nctId: 'NCT03722472' })).not.toThrow();
    });

    it('rejects invalid NCT ID', () => {
      expect(() => params.parse({ nctId: 'bad' })).toThrow();
      expect(() => params.parse({ nctId: 'NCT1234' })).toThrow();
    });

    it('rejects lowercase nct prefix', () => {
      expect(() => params.parse({ nctId: 'nct03722472' })).toThrow();
    });

    it('rejects NCT ID with wrong digit count', () => {
      expect(() => params.parse({ nctId: 'NCT123456789' })).toThrow();
    });
  });

  describe('handler', () => {
    it('returns study data for valid params', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT03722472' } } };
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const parsed = params.parse({ nctId: 'NCT03722472' });
      const result = await studyResource.handler(parsed, ctx);

      expect(result).toBe(study);
      expect(mockService.getStudy).toHaveBeenCalledWith('NCT03722472', ctx);
    });

    it('propagates service errors', async () => {
      mockService.getStudy.mockRejectedValue(new Error('Not found'));
      const ctx = createMockContext();
      const parsed = params.parse({ nctId: 'NCT03722472' });

      await expect(studyResource.handler(parsed, ctx)).rejects.toThrow('Not found');
    });
  });

  describe('metadata', () => {
    it('has correct MIME type', () => {
      expect(studyResource.mimeType).toBe('application/json');
    });

    it('has description', () => {
      expect(studyResource.description).toBeTruthy();
    });
  });
});
