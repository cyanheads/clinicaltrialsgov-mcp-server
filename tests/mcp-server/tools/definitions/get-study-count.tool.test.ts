/**
 * @fileoverview Tests for clinicaltrials_get_study_count tool.
 * @module tests/get-study-count.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));

import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

describe('getStudyCount', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
  });

  describe('handler', () => {
    it('returns total count from service', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 42 });
      const ctx = createMockContext();
      const input = getStudyCount.input.parse({ conditionQuery: 'diabetes' });
      const result = await getStudyCount.handler(input, ctx);

      expect(result.totalCount).toBe(42);
    });

    it('defaults totalCount to 0 when undefined', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [] });
      const ctx = createMockContext();
      const result = await getStudyCount.handler(getStudyCount.input.parse({}), ctx);

      expect(result.totalCount).toBe(0);
    });

    it('calls service with pageSize 0 and countTotal true', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 10 });
      const ctx = createMockContext();
      await getStudyCount.handler(getStudyCount.input.parse({ query: 'test' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 0, countTotal: true }),
        ctx,
      );
    });

    it('echoes populated criteria in searchCriteria', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 5 });
      const ctx = createMockContext();
      const input = getStudyCount.input.parse({
        conditionQuery: 'cancer',
        statusFilter: 'RECRUITING',
      });
      const result = await getStudyCount.handler(input, ctx);

      expect(result.searchCriteria).toEqual({
        conditionQuery: 'cancer',
        statusFilter: 'RECRUITING',
      });
    });

    it('omits searchCriteria when no criteria provided', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 100 });
      const ctx = createMockContext();
      const result = await getStudyCount.handler(getStudyCount.input.parse({}), ctx);

      expect(result.searchCriteria).toBeUndefined();
    });

    it('passes phase filter through buildAdvancedFilter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await getStudyCount.handler(
        getStudyCount.input.parse({ phaseFilter: ['PHASE1', 'PHASE2'] }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterAdvanced: '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2)',
        }),
        ctx,
      );
    });
  });

  describe('format', () => {
    it('shows count for non-zero results', () => {
      const blocks = getStudyCount.format!({ totalCount: 42 });
      expect(blocks[0].text).toBe('42 studies match the specified criteria.');
    });

    it('shows suggestion for zero results', () => {
      const blocks = getStudyCount.format!({ totalCount: 0 });
      expect(blocks[0].text).toContain('0 studies match');
      expect(blocks[0].text).toContain('Try broader');
    });

    it('includes criteria in zero-result message', () => {
      const blocks = getStudyCount.format!({
        totalCount: 0,
        searchCriteria: { conditionQuery: 'rare disease' },
      });
      expect(blocks[0].text).toContain('conditionQuery=rare disease');
    });
  });
});
