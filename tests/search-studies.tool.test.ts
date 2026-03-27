/**
 * @fileoverview Tests for clinicaltrials_search_studies tool.
 * @module tests/search-studies.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));

import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

describe('searchStudies', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('applies default pageSize of 10', () => {
      const input = searchStudies.input.parse({});
      expect(input.pageSize).toBe(10);
    });

    it('applies default countTotal of true', () => {
      const input = searchStudies.input.parse({});
      expect(input.countTotal).toBe(true);
    });

    it('rejects pageSize out of range', () => {
      expect(() => searchStudies.input.parse({ pageSize: 0 })).toThrow();
      expect(() => searchStudies.input.parse({ pageSize: 1001 })).toThrow();
    });

    it('validates NCT ID format', () => {
      expect(() => searchStudies.input.parse({ nctIds: 'INVALID' })).toThrow();
      expect(() => searchStudies.input.parse({ nctIds: 'NCT12345678' })).not.toThrow();
    });
  });

  describe('handler', () => {
    it('returns studies from service', async () => {
      const serviceResult = {
        studies: [{ nctId: 'NCT12345678' }],
        totalCount: 1,
      };
      mockService.searchStudies.mockResolvedValue(serviceResult);

      const ctx = createMockContext();
      const result = await searchStudies.handler(
        searchStudies.input.parse({ conditionQuery: 'diabetes' }),
        ctx,
      );

      expect(result.studies).toEqual([{ nctId: 'NCT12345678' }]);
      expect(result.totalCount).toBe(1);
    });

    it('maps input fields to service params', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input.parse({
          query: 'general',
          conditionQuery: 'cancer',
          interventionQuery: 'chemo',
          locationQuery: 'Seattle',
          sponsorQuery: 'NIH',
          titleQuery: 'phase 3',
          outcomeQuery: 'survival',
          statusFilter: 'RECRUITING',
          geoFilter: 'distance(47.6,-122.3,50mi)',
          sort: 'LastUpdatePostDate:desc',
          pageSize: 20,
          countTotal: false,
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryTerm: 'general',
          queryCond: 'cancer',
          queryIntr: 'chemo',
          queryLocn: 'Seattle',
          querySpons: 'NIH',
          queryTitles: 'phase 3',
          queryOutc: 'survival',
          filterOverallStatus: ['RECRUITING'],
          filterGeo: 'distance(47.6,-122.3,50mi)',
          sort: 'LastUpdatePostDate:desc',
          pageSize: 20,
          countTotal: false,
        }),
        ctx,
      );
    });

    it('echoes search criteria when results are empty', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await searchStudies.handler(
        searchStudies.input.parse({ conditionQuery: 'rare disease', statusFilter: 'RECRUITING' }),
        ctx,
      );

      expect(result.studies).toEqual([]);
      expect(result.searchCriteria).toEqual({
        conditionQuery: 'rare disease',
        statusFilter: 'RECRUITING',
      });
    });

    it('omits searchCriteria when results exist', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ nctId: 'NCT12345678' }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      const result = await searchStudies.handler(
        searchStudies.input.parse({ conditionQuery: 'diabetes' }),
        ctx,
      );

      expect(result.searchCriteria).toBeUndefined();
    });

    it('passes nextPageToken through', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{}],
        totalCount: 100,
        nextPageToken: 'abc123',
      });
      const ctx = createMockContext();
      const result = await searchStudies.handler(searchStudies.input.parse({}), ctx);

      expect(result.nextPageToken).toBe('abc123');
    });
  });

  describe('format', () => {
    it('shows no-match message with criteria for empty results', () => {
      const blocks = searchStudies.format!({
        studies: [],
        searchCriteria: { conditionQuery: 'xyz' },
      });
      expect(blocks[0].text).toContain('No studies matched');
      expect(blocks[0].text).toContain('conditionQuery=xyz');
      expect(blocks[0].text).toContain('Try broader');
    });

    it('shows study count and details for results', () => {
      const blocks = searchStudies.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test Study' },
              statusModule: { overallStatus: 'RECRUITING' },
            },
          },
        ],
        totalCount: 50,
      });
      expect(blocks[0].text).toContain('Found 1 studies (50 total matching)');
      expect(blocks[0].text).toContain('NCT12345678: Test Study [RECRUITING]');
    });

    it('shows pagination hint when nextPageToken present', () => {
      const blocks = searchStudies.format!({
        studies: [{}],
        nextPageToken: 'tok',
      });
      expect(blocks[0].text).toContain('nextPageToken');
    });

    it('truncates study list at 5 and shows remainder', () => {
      const studies = Array.from({ length: 8 }, (_, i) => ({
        protocolSection: {
          identificationModule: { nctId: `NCT0000000${i}`, briefTitle: `Study ${i}` },
        },
      }));
      const blocks = searchStudies.format!({ studies, totalCount: 8 });
      expect(blocks[0].text).toContain('... and 3 more');
    });
  });
});
