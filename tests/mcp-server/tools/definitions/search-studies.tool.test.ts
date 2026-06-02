/**
 * @fileoverview Tests for clinicaltrials_search_studies tool.
 * @module tests/mcp-server/tools/definitions/search-studies.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';

describe('searchStudies', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('applies default pageSize of 10', () => {
      const input = searchStudies.input!.parse({});
      expect(input.pageSize).toBe(10);
    });

    it('applies default countTotal of true', () => {
      const input = searchStudies.input!.parse({});
      expect(input.countTotal).toBe(true);
    });

    it('rejects pageSize below 1', () => {
      expect(() => searchStudies.input!.parse({ pageSize: 0 })).toThrow();
    });

    it('rejects pageSize above maxPageSize', () => {
      expect(() => searchStudies.input!.parse({ pageSize: 999 })).toThrow();
    });

    it('accepts valid pageSize', () => {
      expect(() => searchStudies.input!.parse({ pageSize: 50 })).not.toThrow();
    });

    it('validates NCT ID format', () => {
      expect(() => searchStudies.input!.parse({ nctIds: 'INVALID' })).toThrow();
      expect(() => searchStudies.input!.parse({ nctIds: 'NCT1234' })).toThrow();
      expect(() => searchStudies.input!.parse({ nctIds: 'NCT12345678' })).not.toThrow();
    });

    it('accepts array of NCT IDs', () => {
      const input = searchStudies.input!.parse({ nctIds: ['NCT12345678', 'NCT87654321'] });
      expect(input.nctIds).toEqual(['NCT12345678', 'NCT87654321']);
    });

    it('accepts all optional query fields', () => {
      expect(() =>
        searchStudies.input!.parse({
          query: 'test',
          conditionQuery: 'diabetes',
          interventionQuery: 'insulin',
          locationQuery: 'Seattle',
          sponsorQuery: 'NIH',
          titleQuery: 'phase 3',
          outcomeQuery: 'survival',
        }),
      ).not.toThrow();
    });

    it('accepts statusFilter as string or array', () => {
      expect(searchStudies.input!.parse({ statusFilter: 'RECRUITING' }).statusFilter).toBe(
        'RECRUITING',
      );
      expect(
        searchStudies.input!.parse({ statusFilter: ['RECRUITING', 'COMPLETED'] }).statusFilter,
      ).toEqual(['RECRUITING', 'COMPLETED']);
    });

    it('accepts phaseFilter as string or array', () => {
      expect(searchStudies.input!.parse({ phaseFilter: 'PHASE3' }).phaseFilter).toBe('PHASE3');
      expect(searchStudies.input!.parse({ phaseFilter: ['PHASE1', 'PHASE2'] }).phaseFilter).toEqual(
        ['PHASE1', 'PHASE2'],
      );
    });
  });

  describe('handler', () => {
    it('returns studies from service', async () => {
      const serviceResult = { studies: [{ nctId: 'NCT12345678' }], totalCount: 1 };
      mockService.searchStudies.mockResolvedValue(serviceResult);

      const ctx = createMockContext();
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'diabetes' }),
        ctx,
      );

      expect(result.studies).toEqual([{ nctId: 'NCT12345678' }]);
      expect(result.totalCount).toBe(1);
    });

    it('maps all input fields to service params', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input!.parse({
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

    it('converts phaseFilter to advanced filter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input!.parse({ phaseFilter: ['PHASE1', 'PHASE2'] }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterAdvanced: '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2)',
        }),
        ctx,
      );
    });

    it('combines phaseFilter with advancedFilter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input!.parse({
          phaseFilter: 'PHASE3',
          advancedFilter: 'AREA[StudyType]INTERVENTIONAL',
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterAdvanced: 'AREA[Phase]PHASE3 AND AREA[StudyType]INTERVENTIONAL',
        }),
        ctx,
      );
    });

    it('converts nctIds string to filterIds array', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext();
      await searchStudies.handler(searchStudies.input!.parse({ nctIds: 'NCT12345678' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterIds: ['NCT12345678'] }),
        ctx,
      );
    });

    it('echoes search criteria in enrichment when results are empty', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'rare disease', statusFilter: 'RECRUITING' }),
        ctx,
      );

      expect(result.studies).toEqual([]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({
        conditionQuery: 'rare disease',
        statusFilter: 'RECRUITING',
        sentinelFilterActive: true,
      });
    });

    it('provides notice in enrichment for query + filter combo', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input!.parse({
          conditionQuery: 'rare disease',
          statusFilter: 'RECRUITING',
          phaseFilter: 'PHASE3',
        }),
        ctx,
      );

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('removing filters');
      expect(enrichment.notice).toContain('statusFilter');
      expect(enrichment.notice).toContain('phaseFilter');
    });

    it('provides notice in enrichment for query-only empty results', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await searchStudies.handler(searchStudies.input!.parse({ conditionQuery: 'xyz' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('broader');
    });

    it('provides notice in enrichment for filter-only empty results', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input!.parse({ statusFilter: 'SUSPENDED', geoFilter: 'distance(0,0,1mi)' }),
        ctx,
      );

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('broadening filters');
    });

    it('echoes searchCriteria enrichment when results exist (regression for #58)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ nctId: 'NCT12345678' }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      await searchStudies.handler(searchStudies.input!.parse({ conditionQuery: 'diabetes' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({
        conditionQuery: 'diabetes',
        sentinelFilterActive: true,
      });
      expect(enrichment.notice).toBeUndefined();
    });

    it('omits sentinelFilterActive when includeUnknownEnrollment=true (#58)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ nctId: 'NCT12345678' }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'diabetes', includeUnknownEnrollment: true }),
        ctx,
      );

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({ conditionQuery: 'diabetes' });
    });

    it('passes nextPageToken through', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{}],
        totalCount: 100,
        nextPageToken: 'abc123',
      });
      const ctx = createMockContext();
      const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);

      expect(result.nextPageToken).toBe('abc123');
    });

    it('passes pageToken to service', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 50 });
      const ctx = createMockContext();
      await searchStudies.handler(searchStudies.input!.parse({ pageToken: 'tok_page2' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: 'tok_page2' }),
        ctx,
      );
    });

    it('defaults includeUnknownEnrollment to false (regression for #41)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext();
      await searchStudies.handler(searchStudies.input!.parse({}), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: false }),
        ctx,
      );
    });

    it('forwards includeUnknownEnrollment=true to service', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext();
      await searchStudies.handler(
        searchStudies.input!.parse({ includeUnknownEnrollment: true }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: true }),
        ctx,
      );
    });

    it('echoes requestedFields when caller passed explicit fields (regression for #38)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ nctId: 'NCT12345678' }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ fields: ['NCTId', 'BriefTitle'] }),
        ctx,
      );
      expect(result.requestedFields).toEqual(['NCTId', 'BriefTitle']);
    });

    it('omits requestedFields when caller did not pass fields', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ nctId: 'NCT12345678' }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);
      expect(result.requestedFields).toBeUndefined();
    });
  });

  describe('format', () => {
    it('shows no-match message for empty results', () => {
      const blocks = searchStudies.format!({ studies: [] });
      expect((blocks[0] as { text: string }).text).toContain('No studies matched');
    });

    it('shows study count with totalCount', () => {
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
      expect((blocks[0] as { text: string }).text).toContain('Found 1 studies (50 total matching)');
      expect((blocks[0] as { text: string }).text).toContain('NCT12345678');
      expect((blocks[0] as { text: string }).text).toContain('Test Study');
      expect((blocks[0] as { text: string }).text).toContain('RECRUITING');
    });

    it('shows study count without totalCount', () => {
      const blocks = searchStudies.format!({
        studies: [{}],
      });
      expect((blocks[0] as { text: string }).text).toContain('Found 1 studies');
      expect((blocks[0] as { text: string }).text).not.toContain('total matching');
    });

    it('renders study metadata (phases, enrollment, sponsor, conditions)', () => {
      const blocks = searchStudies.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'Study X' },
              statusModule: { overallStatus: 'RECRUITING' },
              designModule: {
                phases: ['PHASE3'],
                enrollmentInfo: { count: 500 },
              },
              sponsorCollaboratorsModule: { leadSponsor: { name: 'NIH' } },
              conditionsModule: { conditions: ['Diabetes', 'Hypertension'] },
            },
          },
        ],
        totalCount: 1,
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('PHASE3');
      expect(text).toContain('N=500');
      expect(text).toContain('NIH');
      expect(text).toContain('Diabetes');
    });

    it('emits nextPageToken value and pagination hint when token present', () => {
      const blocks = searchStudies.format!({
        studies: [{}],
        nextPageToken: 'tok_abc123',
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('pass pageToken');
      expect(text).toContain('nextPageToken: tok_abc123');
    });

    it('omits pagination hint when nextPageToken absent', () => {
      const blocks = searchStudies.format!({ studies: [{}] });
      expect((blocks[0] as { text: string }).text).not.toContain('pageToken');
    });

    it('handles study with missing fields gracefully', () => {
      const blocks = searchStudies.format!({ studies: [{}], totalCount: 1 });
      expect((blocks[0] as { text: string }).text).toContain('Found 1 studies');
      expect((blocks[0] as { text: string }).text).toContain('Unknown');
    });
  });
});
