/**
 * @fileoverview Tests for clinicaltrials_get_study_count tool.
 * @module tests/mcp-server/tools/definitions/get-study-count.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';

describe('getStudyCount', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('handler', () => {
    it('returns total count from service', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 42 });
      const ctx = createMockContext();
      const input = getStudyCount.input!.parse({ conditionQuery: 'diabetes' });
      const result = await getStudyCount.handler(input, ctx);

      expect(result.totalCount).toBe(42);
    });

    it('defaults totalCount to 0 when undefined', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [] });
      const ctx = createMockContext();
      const result = await getStudyCount.handler(getStudyCount.input!.parse({}), ctx);

      expect(result.totalCount).toBe(0);
    });

    it('calls service with pageSize 0 and countTotal true', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 10 });
      const ctx = createMockContext();
      await getStudyCount.handler(getStudyCount.input!.parse({ query: 'test' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 0, countTotal: true }),
        ctx,
      );
    });

    it('echoes populated criteria in enrichment', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 5 });
      const ctx = createMockContext();
      const input = getStudyCount.input!.parse({
        conditionQuery: 'cancer',
        statusFilter: 'RECRUITING',
      });
      await getStudyCount.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({
        conditionQuery: 'cancer',
        statusFilter: 'RECRUITING',
      });
    });

    it('echoes all provided criteria in enrichment', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 1 });
      const ctx = createMockContext();
      const input = getStudyCount.input!.parse({
        query: 'test',
        conditionQuery: 'cancer',
        interventionQuery: 'chemo',
        sponsorQuery: 'NIH',
        statusFilter: 'RECRUITING',
        phaseFilter: 'PHASE3',
        advancedFilter: 'AREA[StudyType]INTERVENTIONAL',
      });
      await getStudyCount.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({
        query: 'test',
        conditionQuery: 'cancer',
        interventionQuery: 'chemo',
        sponsorQuery: 'NIH',
        statusFilter: 'RECRUITING',
        phaseFilter: 'PHASE3',
        advancedFilter: 'AREA[StudyType]INTERVENTIONAL',
      });
    });

    it('omits searchCriteria enrichment when no criteria provided', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 100 });
      const ctx = createMockContext();
      await getStudyCount.handler(getStudyCount.input!.parse({}), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toBeUndefined();
    });

    it('passes phase filter through buildAdvancedFilter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await getStudyCount.handler(
        getStudyCount.input!.parse({ phaseFilter: ['PHASE1', 'PHASE2'] }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterAdvanced: '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2)',
        }),
        ctx,
      );
    });

    it('provides notice in enrichment when totalCount is 0', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await getStudyCount.handler(getStudyCount.input!.parse({ conditionQuery: 'xyz' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('Try broader search terms or fewer filters.');
    });

    it('omits notice enrichment when totalCount > 0', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 5 });
      const ctx = createMockContext();
      await getStudyCount.handler(getStudyCount.input!.parse({ conditionQuery: 'diabetes' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeUndefined();
    });

    it('converts statusFilter string to array', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await getStudyCount.handler(getStudyCount.input!.parse({ statusFilter: 'RECRUITING' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterOverallStatus: ['RECRUITING'] }),
        ctx,
      );
    });
  });

  describe('format', () => {
    it('shows count for non-zero results', () => {
      const blocks = getStudyCount.format!({ totalCount: 42 });
      expect((blocks[0] as { text: string }).text).toBe('42 studies match the specified criteria.');
    });

    it('shows count for zero results', () => {
      const blocks = getStudyCount.format!({ totalCount: 0 });
      expect((blocks[0] as { text: string }).text).toContain('0 studies match');
    });
  });
});
