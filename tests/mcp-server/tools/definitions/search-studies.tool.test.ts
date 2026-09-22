/**
 * @fileoverview Tests for clinicaltrials_search_studies tool.
 * @module tests/mcp-server/tools/definitions/search-studies.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import { haversineMi } from '@/mcp-server/tools/utils/geo-helpers.js';
import { missingLeaves } from '../../../helpers/format-parity.js';

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
    it('projects studies to compact index entries by default (#86)', async () => {
      const serviceResult = {
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' },
              statusModule: { overallStatus: 'RECRUITING' },
            },
          },
        ],
        totalCount: 1,
      };
      mockService.searchStudies.mockResolvedValue(serviceResult);

      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'diabetes' }),
        ctx,
      );

      // Full record is replaced by the compact index projection.
      expect(result.studies).toEqual([
        { nctId: 'NCT12345678', briefTitle: 'Test', overallStatus: 'RECRUITING' },
      ]);
      expect(result.totalCount).toBe(1);
    });

    it('maps all input fields to service params', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({
          phaseFilter: 'PHASE3',
          advancedFilter: 'AREA[StudyType]INTERVENTIONAL',
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterAdvanced: 'AREA[Phase]PHASE3 AND (AREA[StudyType]INTERVENTIONAL)',
        }),
        ctx,
      );
    });

    it('groups an OR-carrying advancedFilter under the phase constraint (#117)', async () => {
      // Ungrouped, the trailing OR branch escapes the AND boundary and the
      // search returns studies with no phase at all.
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({
          phaseFilter: 'PHASE3',
          advancedFilter: 'AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL',
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterAdvanced:
            'AREA[Phase]PHASE3 AND (AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL)',
        }),
        ctx,
      );
    });

    it('converts nctIds string to filterIds array', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ nctIds: 'NCT12345678' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterIds: ['NCT12345678'] }),
        ctx,
      );
    });

    it('parses a JSON-stringified statusFilter array into filterOverallStatus (regression for #75)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({ statusFilter: '["RECRUITING","COMPLETED"]' }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterOverallStatus: ['RECRUITING', 'COMPLETED'] }),
        ctx,
      );
    });

    it('parses a JSON-stringified phaseFilter array into the advanced filter (regression for #75)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({ phaseFilter: '["PHASE1","PHASE2"]' }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterAdvanced: '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2)' }),
        ctx,
      );
    });

    it('echoes search criteria in enrichment when results are empty', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ conditionQuery: 'xyz' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('broader');
    });

    it('provides notice in enrichment for filter-only empty results', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);

      expect(result.nextPageToken).toBe('abc123');
    });

    it('passes pageToken to service', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 50 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ pageToken: 'tok_page2' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: 'tok_page2' }),
        ctx,
      );
    });

    it('defaults includeUnknownEnrollment to false (regression for #41)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({}), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: false }),
        ctx,
      );
    });

    it('forwards includeUnknownEnrollment=true to service', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({ includeUnknownEnrollment: true }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: true }),
        ctx,
      );
    });

    it('forces includeUnknownEnrollment when nctIds is supplied (#106)', async () => {
      // #41's rule: an ID-targeted lookup must never silently filter the
      // caller's selection. getStudiesBatch and find_eligible already opt out;
      // this path reached the same predicate without it, so an explicit ID
      // filter answered "no such study" for a study the record tool returns.
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ nctIds: 'NCT04586062' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterIds: ['NCT04586062'],
          includeUnknownEnrollment: true,
        }),
        ctx,
      );
    });

    it('forces includeUnknownEnrollment for a multi-ID lookup too (#106)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({ nctIds: ['NCT04586062', 'NCT01171079'] }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: true }),
        ctx,
      );
    });

    it('leaves the exclusion in force when nctIds is absent (#106)', async () => {
      // The override is scoped to ID-targeted lookups — a plain query keeps the
      // #41 default so the sentinel still cannot pollute a RANGE or sort.
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ conditionQuery: 'diabetes' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: false }),
        ctx,
      );
    });

    it('omits sentinelFilterActive from the echo when nctIds overrides the exclusion (#106, #78)', async () => {
      // The disclosure states whether the exclusion is actually in effect. On an
      // ID lookup it is not, so echoing it would report a filter that never ran.
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ nctIds: 'NCT04586062' }), ctx);

      const criteria = getEnrichment(ctx).searchCriteria as Record<string, unknown>;
      expect(criteria.nctIds).toBe('NCT04586062');
      expect(criteria.sentinelFilterActive).toBeUndefined();
    });

    it('echoes requestedFields when caller passed explicit fields (regression for #38)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ nctId: 'NCT12345678' }],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
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
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);
      expect(result.requestedFields).toBeUndefined();
    });
  });

  describe('next-page cursor suppression (#98)', () => {
    const renderText = (result: Parameters<NonNullable<typeof searchStudies.format>>[0]) =>
      (searchStudies.format!(result)[0] as { text: string }).text;

    const study = (nctId: string) => ({
      protocolSection: { identificationModule: { nctId } },
    });

    it('suppresses the cursor on both channels when the page already carries every match', async () => {
      // Upstream emits a token whenever the page fills to pageSize, without
      // looking ahead — following it here returns an empty page.
      mockService.searchStudies.mockResolvedValue({
        studies: [study('NCT03722472')],
        totalCount: 1,
        nextPageToken: 'ZVt07cGHkvI2wRk2CJf6',
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ nctIds: ['NCT03722472'], pageSize: 1 }),
        ctx,
      );

      expect(result.nextPageToken).toBeUndefined();
      const text = renderText(result);
      expect(text).not.toContain('nextPageToken');
      expect(text).not.toContain('More results available');
    });

    it('suppresses the cursor for a plain query search at the same exhaustion point', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [study('NCT03722472')],
        totalCount: 1,
        nextPageToken: 'tok_false_cursor',
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ query: 'rare disease', pageSize: 1 }),
        ctx,
      );
      expect(result.nextPageToken).toBeUndefined();
      expect(renderText(result)).not.toContain('tok_false_cursor');
    });

    it('keeps the cursor when the caller supplied a pageToken', async () => {
      // Page 2+ carries no totalCount to compare against, and the upstream
      // cursor is opaque — suppressing there would strand real results.
      mockService.searchStudies.mockResolvedValue({
        studies: [study('NCT03722472')],
        totalCount: 1,
        nextPageToken: 'tok_page3',
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          nctIds: ['NCT03722472'],
          pageSize: 1,
          pageToken: 'tok_page2',
        }),
        ctx,
      );

      expect(result.nextPageToken).toBe('tok_page3');
      expect(renderText(result)).toContain('nextPageToken: tok_page3');
    });

    it('keeps the cursor when totalCount was not computed (countTotal=false)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [study('NCT03722472')],
        nextPageToken: 'tok_no_total',
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ query: 'cancer', pageSize: 1, countTotal: false }),
        ctx,
      );

      expect(result.nextPageToken).toBe('tok_no_total');
      expect(renderText(result)).toContain('nextPageToken: tok_no_total');
    });

    it('keeps the cursor when the page is a partial slice of the match set', async () => {
      // A 3-ID walk at pageSize 1: pages 2 and 3 hold real data.
      mockService.searchStudies.mockResolvedValue({
        studies: [study('NCT03722472')],
        totalCount: 3,
        nextPageToken: 'tok_page2',
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          nctIds: ['NCT03722472', 'NCT05956821', 'NCT02130466'],
          pageSize: 1,
        }),
        ctx,
      );

      expect(result.nextPageToken).toBe('tok_page2');
      expect(renderText(result)).toContain('nextPageToken: tok_page2');
    });

    it('leaves an already-absent cursor absent (no phantom key)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [study('NCT03722472')],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);
      expect(result.nextPageToken).toBeUndefined();
      expect(Object.hasOwn(result, 'nextPageToken')).toBe(false);
    });
  });

  // An ID-targeted lookup that matches nothing is its own kind of empty: the
  // constraint is a list of identifiers, and broadening guidance aimed at
  // queries and filters says nothing about it.
  describe('ID-aware empty-result notice (#130)', () => {
    const emptyPage = () => mockService.searchStudies.mockResolvedValue({ studies: [] });

    const noticeFor = async (input: Record<string, unknown>) => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse(input), ctx);
      return getEnrichment(ctx).notice as string | undefined;
    };

    it('names the IDs when an ID-only lookup matches nothing', async () => {
      emptyPage();
      const notice = await noticeFor({ nctIds: ['NCT00000001'], fields: ['NCTId'] });

      expect(notice).toBeDefined();
      expect(notice).toContain('NCT ID');
      // A well-formed but unregistered ID is answered 200-with-nothing, so the
      // two tools that can settle the question by ID are the way forward.
      expect(notice).toContain('clinicaltrials_get_study_record');
      expect(notice).toContain('clinicaltrials_get_study_results');
      // Nothing to broaden — no query or filter was in play.
      expect(notice).not.toContain('broaden');
    });

    it('adds an ID clause without displacing the filter guidance', async () => {
      emptyPage();
      const notice = await noticeFor({
        nctIds: ['NCT03722472'],
        statusFilter: 'RECRUITING',
        fields: ['NCTId', 'OverallStatus'],
      });

      expect(notice).toBeDefined();
      // The pre-existing advice is still correct on its own axis.
      expect(notice).toContain('Try removing or broadening filters.');
      expect(notice).toContain(
        'Remove statusFilter to include studies in all statuses (completed, terminated, etc.).',
      );
      // And the IDs are now part of the picture.
      expect(notice).toContain('nctIds');
      expect(notice).toContain('Drop the other filters');
    });

    it('claims nothing about whether a combined-lookup ID exists', async () => {
      emptyPage();
      const notice = await noticeFor({ nctIds: ['NCT03722472'], conditionQuery: 'diabetes' });

      // Settling that needs an extra upstream call this handler does not make.
      expect(notice).toContain('may not exist');
      expect(notice).toContain('may have excluded them');
    });

    it('stays silent when at least one ID resolves (partial match)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ protocolSection: { identificationModule: { nctId: 'NCT03722472' } } }],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          nctIds: ['NCT03722472', 'NCT00000001'],
          fields: ['NCTId'],
        }),
        ctx,
      );

      // A page with results is not an empty result, however many IDs missed.
      expect(result.studies).toHaveLength(1);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('stays silent on an exhausted continuation page carrying nctIds', async () => {
      emptyPage();
      const notice = await noticeFor({
        nctIds: ['NCT03722472', 'NCT06323538'],
        fields: ['NCTId'],
        pageSize: 1,
        pageToken: 'tok_page3',
      });

      // The IDs already matched on an earlier page — finished pagination, not
      // an unmatched lookup.
      expect(notice).toBeUndefined();
    });
  });

  // An empty continuation page is pagination finishing, not a search failing.
  // Upstream gives nothing to tell them apart — an exhausted page carries
  // neither totalCount nor nextPageToken — so the call's own input is the only
  // signal, and both channels have to carry the distinction.
  describe('exhausted continuation pages (#122)', () => {
    const renderText = (result: Parameters<NonNullable<typeof searchStudies.format>>[0]) =>
      (searchStudies.format!(result)[0] as { text: string }).text;

    it('flags an empty continuation page on both channels', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: undefined });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          nctIds: ['NCT03722472', 'NCT06323538'],
          fields: ['NCTId'],
          pageSize: 1,
          pageToken: 'tok_page3',
        }),
        ctx,
      );

      expect(result.pageExhausted).toBe(true);
      const text = renderText(result);
      expect(text).not.toContain('No studies matched the search criteria.');
      expect(text).toMatch(/past the end/i);
    });

    it('offers no broaden-the-search guidance on an exhausted continuation', async () => {
      // The cohort already succeeded on earlier pages — telling the caller to
      // widen the query misreads finished pagination as a failed search.
      mockService.searchStudies.mockResolvedValue({ studies: [] });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({
          conditionQuery: 'diabetes',
          statusFilter: 'RECRUITING',
          pageToken: 'tok_page4',
        }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('leaves the empty first-page cohort exactly as it was', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'rare disease', statusFilter: 'RECRUITING' }),
        ctx,
      );

      expect(result.pageExhausted).toBeUndefined();
      expect(Object.hasOwn(result, 'pageExhausted')).toBe(false);
      expect(renderText(result)).toContain('No studies matched the search criteria.');
      expect(getEnrichment(ctx).notice).toContain('broaden');
    });

    it('leaves a continuation page that still carries studies unflagged', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ protocolSection: { identificationModule: { nctId: 'NCT03722472' } } }],
        nextPageToken: 'tok_page4',
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ query: 'diabetes', pageSize: 1, pageToken: 'tok_page3' }),
        ctx,
      );

      expect(result.pageExhausted).toBeUndefined();
      expect(renderText(result)).toContain('Found 1 studies');
    });

    it('renders the exhaustion line from the output field alone (content[] parity)', () => {
      const text = renderText({ studies: [], pageExhausted: true });
      expect(text).not.toContain('No studies matched');
      expect(text).toMatch(/past the end/i);
      expect(text).toMatch(/no further pages/i);
    });
  });

  describe('blank supplied values (#99)', () => {
    const QUERY_PARAMS = [
      'query',
      'conditionQuery',
      'interventionQuery',
      'locationQuery',
      'sponsorQuery',
      'titleQuery',
      'outcomeQuery',
    ] as const;

    /** Assert a handler call fails with the shared blank_value contract for `param`. */
    const expectBlankValue = (call: unknown, param: string) =>
      expect(call).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_value', param },
      });

    beforeEach(() => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    });

    it.each(QUERY_PARAMS)(
      'rejects an empty %s instead of searching the whole registry',
      (param) => {
        const ctx = createMockContext({ errors: searchStudies.errors });
        return expectBlankValue(
          searchStudies.handler(searchStudies.input!.parse({ [param]: '' }), ctx),
          param,
        );
      },
    );

    it.each(QUERY_PARAMS)('rejects a whitespace-only %s', (param) => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      return expectBlankValue(
        searchStudies.handler(searchStudies.input!.parse({ [param]: '   ' }), ctx),
        param,
      );
    });

    // Four strings whose consumers guard on plain truthiness: '' is falsy and
    // silently dropped — the widening #99 exists to stop — while ' ' is truthy
    // and forwarded upstream, splicing a blank term into a joined boolean
    // expression for advancedFilter and sending a malformed value for
    // geoFilter and sort. pageToken fails both ways too (#122): '' restarts the
    // walk at page one under the guise of continuing it, and ' ' 400s upstream
    // with a shape the service's 400 handler cannot classify.
    const CONSTRAINT_PARAMS = ['advancedFilter', 'geoFilter', 'sort', 'pageToken'] as const;

    it.each(CONSTRAINT_PARAMS)(
      'rejects an empty %s instead of silently dropping the constraint',
      async (param) => {
        const ctx = createMockContext({ errors: searchStudies.errors });
        await expectBlankValue(
          searchStudies.handler(searchStudies.input!.parse({ [param]: '' }), ctx),
          param,
        );
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it.each(CONSTRAINT_PARAMS)(
      'rejects a whitespace-only %s instead of forwarding whitespace upstream',
      async (param) => {
        const ctx = createMockContext({ errors: searchStudies.errors });
        await expectBlankValue(
          searchStudies.handler(searchStudies.input!.parse({ [param]: '   ' }), ctx),
          param,
        );
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it('leaves non-blank constraint values untouched', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(
          searchStudies.input!.parse({
            advancedFilter: 'AREA[StudyType]INTERVENTIONAL',
            geoFilter: 'distance(47.6062,-122.3321,50mi)',
            sort: 'LastUpdatePostDate:desc',
          }),
          ctx,
        ),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterAdvanced: 'AREA[StudyType]INTERVENTIONAL',
          filterGeo: 'distance(47.6062,-122.3321,50mi)',
          sort: 'LastUpdatePostDate:desc',
        }),
        ctx,
      );
    });

    it('never reaches the service when a query value is blank', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expectBlankValue(
        searchStudies.handler(searchStudies.input!.parse({ query: '' }), ctx),
        'query',
      );
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it('rejects a fields array carrying a blank entry', () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      return expectBlankValue(
        searchStudies.handler(searchStudies.input!.parse({ fields: ['OverallStatus', ''] }), ctx),
        'fields',
      );
    });

    it.each(['statusFilter', 'phaseFilter'] as const)(
      'rejects a stringified empty %s array',
      (param) => {
        const ctx = createMockContext({ errors: searchStudies.errors });
        return expectBlankValue(
          searchStudies.handler(searchStudies.input!.parse({ [param]: '[]' }), ctx),
          param,
        );
      },
    );

    // Every list arm on this tool answers `[]` the same way, through the real
    // `.input.parse()` path: the schema lets it through and the handler raises
    // the declared blank_value contract. A schema `.min(1)` would preempt the
    // handler and surface a bare -32602 carrying no reason and no recovery hint
    // (#109). nctIds is the arm that never had either guard — an empty list was
    // dropped and the search widened to the whole registry (#110).
    it.each(['fields', 'statusFilter', 'phaseFilter', 'nctIds'] as const)(
      'answers an empty %s with the typed blank_value contract, not a bare schema rejection',
      async (param) => {
        const ctx = createMockContext({ errors: searchStudies.errors });
        await expectBlankValue(
          searchStudies.handler(searchStudies.input!.parse({ [param]: [] }), ctx),
          param,
        );
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it('never issues an unfiltered search for an empty nctIds list (#110)', async () => {
      // The sharper half: an empty list that errors costs a retry, one that
      // succeeds answers an ID-scoped question with the whole registry.
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expectBlankValue(
        searchStudies.handler(searchStudies.input!.parse({ nctIds: [], pageSize: 1 }), ctx),
        'nctIds',
      );
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it('states the empty-list behavior in the nctIds description (#110)', () => {
      const shape = searchStudies.input!.shape as Record<string, { description?: string }>;
      expect(shape.nctIds?.description).toContain('an empty list is rejected');
    });

    it('rejects a statusFilter carrying a blank entry', () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      return expectBlankValue(
        searchStudies.handler(
          searchStudies.input!.parse({ statusFilter: ['RECRUITING', ' '] }),
          ctx,
        ),
        'statusFilter',
      );
    });

    it('rejects a phaseFilter carrying a blank entry', () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      return expectBlankValue(
        searchStudies.handler(searchStudies.input!.parse({ phaseFilter: ['PHASE3', ''] }), ctx),
        'phaseFilter',
      );
    });

    it('leaves omission untouched — every narrowed parameter stays optional', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(searchStudies.input!.parse({}), ctx),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryTerm: undefined,
          fields: undefined,
          filterOverallStatus: undefined,
          filterAdvanced: undefined,
          filterGeo: undefined,
          sort: undefined,
        }),
        ctx,
      );
    });

    it('leaves non-blank values untouched', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(
          searchStudies.input!.parse({
            query: 'diabetes',
            conditionQuery: 'Type 2 Diabetes',
            fields: ['NCTId'],
            statusFilter: ['RECRUITING'],
            phaseFilter: 'PHASE3',
          }),
          ctx,
        ),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryTerm: 'diabetes',
          queryCond: 'Type 2 Diabetes',
          fields: ['NCTId'],
          filterOverallStatus: ['RECRUITING'],
          filterAdvanced: 'AREA[Phase]PHASE3',
        }),
        ctx,
      );
    });

    it('declares the blank_value reason on the tool contract', () => {
      expect(searchStudies.errors?.map((e) => e.reason)).toContain('blank_value');
    });
  });

  // Each *Query parameter is backed by a ClinicalTrials.gov search area with a
  // published piece list (/studies/search-areas). A description that only says
  // "Condition/disease-specific search" reads as an exact-field match, so a
  // caller treats every hit as on-condition and never learns that the MeSH
  // ancestor umbrella pulls in tangential ones (#108).
  describe('*Query match-surface descriptions (#108)', () => {
    const MATCH_SURFACE: Array<[string, string[]]> = [
      ['query', ['NCTId', 'Acronym', 'Condition', 'InterventionName', 'BriefSummary', 'StudyType']],
      [
        'conditionQuery',
        [
          'Condition',
          'BriefTitle',
          'OfficialTitle',
          'ConditionMeshTerm',
          'ConditionAncestorTerm',
          'Keyword',
          'NCTId',
          'MeSH',
        ],
      ],
      [
        'interventionQuery',
        [
          'InterventionName',
          'InterventionType',
          'ArmGroupType',
          'InterventionOtherName',
          'BriefTitle',
          'OfficialTitle',
          'ArmGroupLabel',
          'InterventionMeshTerm',
          'Keyword',
          'InterventionAncestorTerm',
          'InterventionDescription',
          'ArmGroupDescription',
          'MeSH',
        ],
      ],
      [
        'locationQuery',
        ['LocationCity', 'LocationState', 'LocationCountry', 'LocationFacility', 'LocationZip'],
      ],
      ['sponsorQuery', ['LeadSponsorName', 'CollaboratorName', 'OrgFullName']],
      ['titleQuery', ['Acronym', 'BriefTitle', 'OfficialTitle']],
      [
        'outcomeQuery',
        [
          'PrimaryOutcomeMeasure',
          'SecondaryOutcomeMeasure',
          'OtherOutcomeMeasure',
          'OutcomeMeasureTitle',
          'PrimaryOutcomeDescription',
          'SecondaryOutcomeDescription',
          'OtherOutcomeDescription',
          'OutcomeMeasureDescription',
          'OutcomeMeasurePopulationDescription',
        ],
      ],
    ];

    it.each(MATCH_SURFACE)('%s names the fields it actually matches', (param, pieces) => {
      const shape = searchStudies.input!.shape as Record<string, { description?: string }>;
      const description = shape[param]?.description ?? '';
      for (const piece of pieces) expect(description).toContain(piece);
    });

    // The two MeSH-backed areas are the ones whose hits reach past the study's
    // own list; find_eligible carries conditionMatchScore precisely to re-rank
    // what ConditionAncestorTerm drags in.
    it.each(['conditionQuery', 'interventionQuery'] as const)(
      "warns that %s can match beyond the study's own list",
      (param) => {
        const shape = searchStudies.input!.shape as Record<string, { description?: string }>;
        expect(shape[param]?.description).toMatch(/broader than/i);
      },
    );
  });

  describe('geoFilter location re-ranking (#84)', () => {
    // A study whose upstream locations[0] is a far AZ site; the near WA site sits
    // later; one site has no geoPoint at all.
    const seattle = { lat: 47.6062, lon: -122.3321 };
    const studyWithLocations = () => ({
      protocolSection: {
        identificationModule: { nctId: 'NCT06897475', briefTitle: 'Multi-site trial' },
        contactsLocationsModule: {
          locations: [
            {
              facility: 'Phoenix Site',
              city: 'Phoenix',
              state: 'AZ',
              country: 'United States',
              geoPoint: { lat: 33.4484, lon: -112.074 },
            },
            {
              facility: 'Redmond Site',
              city: 'Redmond',
              state: 'WA',
              country: 'United States',
              geoPoint: { lat: 47.674, lon: -122.1215 },
            },
            { facility: 'No-Geo Site', city: 'Unknown', country: 'United States' },
          ],
        },
      },
    });

    // Default (no fields) projects to the compact index, so the re-rank surfaces
    // through locations.nearest / locations.total (the full array is projected away).
    const indexLocations = (result: { studies: unknown[] }) =>
      (
        result.studies[0] as {
          locations?: { nearest?: { city?: string; distanceMi?: number }; total: number };
        }
      ).locations;

    it('projects the nearest matched site as locations.nearest with distanceMi (#84)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [studyWithLocations()],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ geoFilter: 'distance(47.6062,-122.3321,50mi)' }),
        ctx,
      );

      const loc = indexLocations(result);
      // Nearest (Redmond, WA) leads with an annotated distance; total discloses all 3 sites.
      expect(loc?.total).toBe(3);
      expect(loc?.nearest?.city).toBe('Redmond');
      expect(loc?.nearest?.distanceMi).toBeDefined();
      expect(loc?.nearest?.distanceMi).toBeLessThan(15);
    });

    it('annotates the projected nearest site with the great-circle distance (#84)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [studyWithLocations()],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ geoFilter: 'distance(47.6062,-122.3321,50mi)' }),
        ctx,
      );
      expect(indexLocations(result)?.nearest?.distanceMi).toBeCloseTo(
        haversineMi(seattle, { lat: 47.674, lon: -122.1215 }),
        4,
      );
    });

    it('projects the first registered site (no re-rank, no distance) without a geoFilter (#84)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [studyWithLocations()],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);
      const loc = indexLocations(result);
      // Upstream order preserved — Phoenix leads, no distance annotation.
      expect(loc?.total).toBe(3);
      expect(loc?.nearest?.city).toBe('Phoenix');
      expect(loc?.nearest?.distanceMi).toBeUndefined();
    });

    it('preserves the full re-ranked locations array in explicit-fields mode (#84)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [studyWithLocations()],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          geoFilter: 'distance(47.6062,-122.3321,50mi)',
          fields: ['NCTId', 'LocationCity', 'LocationGeoPoint'],
        }),
        ctx,
      );
      // With explicit fields there is no projection — the full re-ranked array survives.
      const locs = (
        result.studies[0] as {
          protocolSection: {
            contactsLocationsModule: { locations: Array<{ city?: string; distanceMi?: number }> };
          };
        }
      ).protocolSection.contactsLocationsModule.locations;
      expect(locs.map((l) => l.city)).toEqual(['Redmond', 'Phoenix', 'Unknown']);
      expect(locs[0]!.distanceMi!).toBeLessThan(15);
      expect(locs[1]!.distanceMi!).toBeGreaterThan(1000);
      expect(locs).toHaveLength(3);
      expect(locs[2]!.city).toBe('Unknown');
      expect(locs[2]!.distanceMi).toBeUndefined();
    });

    it('does not crash when a matched study carries no locations', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [{ protocolSection: { identificationModule: { nctId: 'NCT00000001' } } }],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(
          searchStudies.input!.parse({ geoFilter: 'distance(47.6062,-122.3321,50mi)' }),
          ctx,
        ),
      ).resolves.toBeDefined();
    });
  });

  // #93 routed the shapes upstream rejects with `incorrect format` to the typed
  // geo_invalid contract. The shapes upstream does NOT reject are the gap this
  // covers: a unit-less radius answers 200 with an empty set (read as metres),
  // a zero radius 500s through the whole retry budget, and an out-of-range
  // coordinate 400s with a bare `Search error` the service cannot classify.
  describe('geoFilter validation (#123)', () => {
    const expectGeoInvalid = (call: unknown) =>
      expect(call).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'geo_invalid' },
      });

    beforeEach(() => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    });

    const REJECTED = [
      'distance(47.6,-122.9,50)',
      'distance(47.6,-122.9,0mi)',
      'distance(47.6,-122.9,-50mi)',
      'distance(147.6,-122.9,50mi)',
      'distance(47.6,-222.9,50mi)',
      'distance(47.6,-122.9,50MI)',
      'distance( 47.6 , -122.9 , 50mi )',
      'Seattle, WA',
    ] as const;

    it.each(REJECTED)('rejects %s as geo_invalid before the upstream call', async (geoFilter) => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expectGeoInvalid(searchStudies.handler(searchStudies.input!.parse({ geoFilter }), ctx));
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it('carries the geo_invalid recovery hint on the rejection', async () => {
      // The declared contract's hint is the actionable half — a reason with no
      // hint leaves the caller knowing only that something was wrong.
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(
          searchStudies.input!.parse({ geoFilter: 'distance(47.6,-122.9,50)' }),
          ctx,
        ),
      ).rejects.toMatchObject({
        data: {
          reason: 'geo_invalid',
          recovery: { hint: expect.stringContaining('`mi` or `km` suffix') },
        },
      });
    });

    const ACCEPTED = [
      'distance(47.6,-122.9,50mi)',
      'distance(47.6,-122.9,50km)',
      'distance(47.6,-122.9,50.5mi)',
    ] as const;

    it.each(ACCEPTED)('forwards %s to the service unchanged', async (geoFilter) => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(searchStudies.input!.parse({ geoFilter }), ctx),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterGeo: geoFilter }),
        ctx,
      );
    });

    it('still answers a blank geoFilter with blank_value, not geo_invalid (#99)', async () => {
      // A blank value is a different mistake with a different fix, and the
      // blank check runs first so it keeps naming the parameter.
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(searchStudies.input!.parse({ geoFilter: '   ' }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'blank_value', param: 'geoFilter' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it('states that a unit-less radius is rejected in the geoFilter description', () => {
      const shape = searchStudies.input!.shape as Record<string, { description?: string }>;
      expect(shape.geoFilter?.description).toMatch(/rejected/i);
      expect(shape.geoFilter?.description).not.toContain('interpreted as meters');
    });
  });

  describe('format', () => {
    it('shows no-match message for empty results', () => {
      const blocks = searchStudies.format!({ studies: [] });
      expect((blocks[0] as { text: string }).text).toContain('No studies matched');
    });

    it('shows study count with totalCount', () => {
      const blocks = searchStudies.format!({
        studies: [{ nctId: 'NCT12345678', briefTitle: 'Test Study', overallStatus: 'RECRUITING' }],
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
            nctId: 'NCT12345678',
            briefTitle: 'Study X',
            overallStatus: 'RECRUITING',
            phases: ['PHASE3'],
            enrollmentCount: 500,
            leadSponsor: 'NIH',
            conditions: ['Diabetes', 'Hypertension'],
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

    it('leads with the matched site and its distance when the projection is annotated (#84)', () => {
      const blocks = searchStudies.format!({
        studies: [
          {
            nctId: 'NCT06897475',
            briefTitle: 'Geo trial',
            overallStatus: 'RECRUITING',
            locations: {
              total: 2,
              nearest: {
                facility: 'Redmond Site',
                city: 'Redmond',
                state: 'WA',
                country: 'United States',
                distanceMi: 10.9,
              },
            },
          },
        ],
        totalCount: 1,
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Nearest site: Redmond Site, Redmond, WA, United States');
      expect(text).toContain('10.9 mi from geoFilter center');
      expect(text).toContain('of 2 sites');
    });

    it('shows the registered site (not a nearest-site line) when no geoFilter is set (#84)', () => {
      const blocks = searchStudies.format!({
        studies: [
          {
            nctId: 'NCT12345678',
            locations: {
              total: 1,
              nearest: { facility: 'Phoenix Site', city: 'Phoenix', state: 'AZ' },
            },
          },
        ],
        totalCount: 1,
      });
      const text = (blocks[0] as { text: string }).text;
      // Location must still surface without a geoFilter — the headline carries no
      // location, so a missing Site line would silently drop where the trial runs.
      expect(text).toContain('Site: Phoenix Site, Phoenix, AZ');
      expect(text).not.toContain('Nearest site:');
    });

    it('discloses the site count on a multi-site study without a geoFilter (#84)', () => {
      const blocks = searchStudies.format!({
        studies: [
          {
            nctId: 'NCT12345678',
            locations: {
              total: 3,
              nearest: {
                facility: 'Boston Site',
                city: 'Boston',
                state: 'MA',
                country: 'United States',
              },
            },
          },
        ],
        totalCount: 1,
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Site: Boston Site, Boston, MA, United States (1 of 3 sites)');
      expect(text).not.toContain('Nearest site:');
    });
  });

  describe('output-channel parity — structuredContent and content[] carry the same data (#86)', () => {
    const seattleGeo = 'distance(47.6062,-122.3321,50mi)';

    // The full record upstream returns when no fields param is passed.
    const fullStudy = () => ({
      protocolSection: {
        identificationModule: { nctId: 'NCT03110133', briefTitle: 'Diabetes Prevention' },
        statusModule: { overallStatus: 'RECRUITING' },
        designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 300 } },
        sponsorCollaboratorsModule: { leadSponsor: { name: 'NIDDK' } },
        conditionsModule: { conditions: ['Type 2 Diabetes'] },
        contactsLocationsModule: {
          locations: [
            {
              facility: 'Boston Clinic',
              city: 'Boston',
              state: 'MA',
              country: 'United States',
              geoPoint: { lat: 42.3601, lon: -71.0589 },
            },
            {
              facility: 'Seattle Center',
              city: 'Seattle',
              state: 'WA',
              country: 'United States',
              geoPoint: { lat: 47.6062, lon: -122.3321 },
            },
            { facility: 'Remote Site', city: 'Nowhere', country: 'United States' },
          ],
        },
        eligibilityModule: {
          eligibilityCriteria: 'Inclusion: adults with T2D',
          minimumAge: '18 Years',
        },
        descriptionModule: { briefSummary: 'A large prevention study.' },
      },
      derivedSection: { miscInfoModule: { versionHolder: '2026-06-30' } },
      hasResults: false,
    });

    const renderText = (result: Parameters<NonNullable<typeof searchStudies.format>>[0]) =>
      (searchStudies.format!(result)[0] as { text: string }).text;

    it('default (no fields): structuredContent is a compact index, not the full record, and content[] mirrors it', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [fullStudy()], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'diabetes' }),
        ctx,
      );

      const entry = result.studies[0] as Record<string, unknown>;
      // Bounded — the heavy record subtrees no longer ride in structuredContent.
      expect(entry.protocolSection).toBeUndefined();
      expect(entry.derivedSection).toBeUndefined();
      expect(entry.nctId).toBe('NCT03110133');
      expect(entry.overallStatus).toBe('RECRUITING');
      expect(entry.conditions).toEqual(['Type 2 Diabetes']);
      // Locations bounded to lead site + total count.
      expect(entry.locations).toEqual({
        total: 3,
        nearest: {
          facility: 'Boston Clinic',
          city: 'Boston',
          state: 'MA',
          country: 'United States',
        },
      });

      // content[] carries the same values reachable in structuredContent.
      const text = renderText(result);
      expect(text).toContain('NCT03110133');
      expect(text).toContain('Diabetes Prevention');
      expect(text).toContain('RECRUITING');
      expect(text).toContain('PHASE3');
      expect(text).toContain('N=300');
      expect(text).toContain('NIDDK');
      expect(text).toContain('Type 2 Diabetes');
      expect(text).toContain('Site: Boston Clinic, Boston, MA, United States (1 of 3 sites)');
      // Reverse parity: fields absent from structuredContent are absent from content[] too.
      expect(text).not.toContain('Inclusion:');
      expect(text).not.toContain('A large prevention study.');
    });

    it('default non-geoFilter: a multi-site study still renders its site in content[] (#84 non-geo common case)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [fullStudy()], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'diabetes' }),
        ctx,
      );
      const entry = result.studies[0] as { locations?: { nearest?: { city?: string } } };
      const text = renderText(result);
      // The lead site reaches BOTH channels — the exact regression #84 guarded, here with no geoFilter.
      expect(entry.locations?.nearest?.city).toBe('Boston');
      expect(text).toContain('Boston Clinic');
      expect(text).not.toContain('Nearest site:');
    });

    it('explicit fields incl. a location leaf: every site (2..N) reaches content[] with value parity', async () => {
      const trimmed = {
        protocolSection: {
          identificationModule: { nctId: 'NCT03110133' },
          contactsLocationsModule: {
            locations: [
              { city: 'Boston', state: 'MA' },
              { city: 'Seattle', state: 'WA' },
              { city: 'Austin', state: 'TX' },
            ],
          },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [trimmed], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          conditionQuery: 'diabetes',
          fields: ['NCTId', 'LocationCity', 'LocationState'],
        }),
        ctx,
      );

      // structuredContent carries the full trimmed record — all 3 sites.
      const locs = (
        result.studies[0] as {
          protocolSection: { contactsLocationsModule: { locations: Array<{ city?: string }> } };
        }
      ).protocolSection.contactsLocationsModule.locations;
      expect(locs.map((l) => l.city)).toEqual(['Boston', 'Seattle', 'Austin']);

      // content[] renders EVERY site — sites 2..N no longer suppressed by SEARCH_RENDERED.
      const text = renderText(result);
      expect(text).toContain('Locations (3):');
      for (const city of ['Boston', 'Seattle', 'Austin']) expect(text).toContain(city);
    });

    it('geoFilter (default): the nearest site + distance reach both channels', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [fullStudy()], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({ conditionQuery: 'diabetes', geoFilter: seattleGeo }),
        ctx,
      );
      const entry = result.studies[0] as {
        locations?: { total: number; nearest?: { city?: string; distanceMi?: number } };
      };
      // Seattle sits on the filter center → nearest, ~0 mi.
      expect(entry.locations?.total).toBe(3);
      expect(entry.locations?.nearest?.city).toBe('Seattle');
      expect(entry.locations?.nearest?.distanceMi).toBeCloseTo(0, 0);

      const text = renderText(result);
      expect(text).toContain('Nearest site: Seattle Center, Seattle, WA, United States');
      expect(text).toContain('mi from geoFilter center of 3 sites');
    });

    it('geoFilter + explicit fields: every re-ranked site (nearest first, with distance) reaches both channels', async () => {
      const trimmed = {
        protocolSection: {
          identificationModule: { nctId: 'NCT03110133' },
          contactsLocationsModule: {
            locations: [
              { city: 'Boston', geoPoint: { lat: 42.3601, lon: -71.0589 } },
              { city: 'Seattle', geoPoint: { lat: 47.6062, lon: -122.3321 } },
            ],
          },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [trimmed], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          conditionQuery: 'diabetes',
          geoFilter: seattleGeo,
          fields: ['NCTId', 'LocationCity', 'LocationGeoPoint'],
        }),
        ctx,
      );

      // structuredContent: full re-ranked array, nearest first, annotated.
      const locs = (
        result.studies[0] as {
          protocolSection: {
            contactsLocationsModule: { locations: Array<{ city?: string; distanceMi?: number }> };
          };
        }
      ).protocolSection.contactsLocationsModule.locations;
      expect(locs.map((l) => l.city)).toEqual(['Seattle', 'Boston']);
      expect(locs[0]!.distanceMi).toBeCloseTo(0, 0);

      // content[]: both sites, nearest first, with distance.
      const text = renderText(result);
      const seattleIdx = text.indexOf('Seattle');
      const bostonIdx = text.indexOf('Boston');
      expect(seattleIdx).toBeGreaterThan(-1);
      expect(bostonIdx).toBeGreaterThan(seattleIdx);
      expect(text).toContain('0.0 mi');
    });

    it('explicit fields: repeated secondaryIdInfos entries stay attributed to their own entry in content[] (#86)', async () => {
      // NCT03722472 registers two secondary IDs with overlapping-but-not-identical
      // leaf sets — entry [0] has a `domain` and no `link`, entry [1] the reverse.
      // content[] rendered one four-line record splicing both entries together.
      const trimmed = {
        protocolSection: {
          identificationModule: {
            nctId: 'NCT03722472',
            secondaryIdInfos: [
              { id: 'DMID 17-0104', type: 'OTHER', domain: 'NIH/NIAID/DMID' },
              {
                id: '272201400041C-0-0-1',
                type: 'NIH',
                link: 'https://reporter.nih.gov/quickSearch/272201400041C-0-0-1',
              },
            ],
          },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [trimmed], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          nctIds: ['NCT03722472'],
          fields: [
            'NCTId',
            'SecondaryId',
            'SecondaryIdType',
            'SecondaryIdDomain',
            'SecondaryIdLink',
          ],
          pageSize: 1,
          includeUnknownEnrollment: true,
        }),
        ctx,
      );

      // structuredContent carries both entries untouched.
      const infos = (
        result.studies[0] as {
          protocolSection: {
            identificationModule: {
              secondaryIdInfos: Array<{ id?: string; domain?: string; link?: string }>;
            };
          };
        }
      ).protocolSection.identificationModule.secondaryIdInfos;
      expect(infos.map((i) => i.id)).toEqual(['DMID 17-0104', '272201400041C-0-0-1']);

      // content[] carries every leaf, each attributed to its originating entry.
      const text = renderText(result);
      expect(text).toContain('Secondary Id Infos[0] > Id: DMID 17-0104');
      expect(text).toContain('Secondary Id Infos[0] > Type: OTHER');
      expect(text).toContain('Secondary Id Infos[0] > Domain: NIH/NIAID/DMID');
      expect(text).toContain('Secondary Id Infos[1] > Id: 272201400041C-0-0-1');
      expect(text).toContain('Secondary Id Infos[1] > Type: NIH');
      expect(text).toContain(
        'Secondary Id Infos[1] > Link: https://reporter.nih.gov/quickSearch/272201400041C-0-0-1',
      );
      // No unattributed line — entry [1]'s link never rides under entry [0].
      expect(text).not.toMatch(/Secondary Id Infos > /);
    });

    it('explicit fields: the two browse modules render under distinct labels in content[] (#104)', async () => {
      // NCT02271776 carries meshes in both browse modules. Both arrays are named
      // `meshes` and both leaves are `term`, so the two-segment label window
      // rendered every line as `Meshes[i] > Term` — values stayed distinct and
      // separated, but a content[]-only reader could not tell which module a
      // given line came from.
      const trimmed = {
        protocolSection: { identificationModule: { nctId: 'NCT02271776' } },
        derivedSection: {
          conditionBrowseModule: {
            meshes: [
              { term: 'Obesity' },
              { term: 'Diabetes Mellitus, Type 2' },
              { term: 'Insulin Resistance' },
            ],
          },
          interventionBrowseModule: {
            meshes: [{ term: "4'-galactooligosaccharide" }, { term: 'maltodextrin' }],
          },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [trimmed], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          nctIds: ['NCT02271776'],
          fields: ['NCTId', 'ConditionMeshTerm', 'InterventionMeshTerm'],
          pageSize: 1,
        }),
        ctx,
      );

      const text = renderText(result);
      expect(text).toContain('Condition Browse > Meshes[0] > Term: Obesity');
      expect(text).toContain('Condition Browse > Meshes[2] > Term: Insulin Resistance');
      expect(text).toContain("Intervention Browse > Meshes[0] > Term: 4'-galactooligosaccharide");
      expect(text).toContain('Intervention Browse > Meshes[1] > Term: maltodextrin');
      // No line renders under the ambiguous label the two modules used to share.
      expect(text).not.toMatch(/^\s*Meshes\[\d+] > Term:/m);
    });

    it('explicit fields: a long string leaf (BriefSummary) renders unclipped in content[], matching structuredContent (#89)', async () => {
      // A 543-char summary — the reported NCT00225888 length. structuredContent
      // carries it whole; content[] must too, not a 200-char slice with an ellipsis.
      const longSummary = `The purpose of this study is ${'y'.repeat(520)}`;
      expect(longSummary.length).toBeGreaterThan(500);
      const trimmed = {
        protocolSection: {
          identificationModule: { nctId: 'NCT00225888', briefTitle: 'Food photography study' },
          descriptionModule: { briefSummary: longSummary },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [trimmed], totalCount: 1 });
      const ctx = createMockContext({ errors: searchStudies.errors });
      const result = await searchStudies.handler(
        searchStudies.input!.parse({
          conditionQuery: 'Type 2 Diabetes',
          fields: ['NCTId', 'BriefTitle', 'BriefSummary'],
        }),
        ctx,
      );

      // structuredContent carries the full summary (upstream-trimmed record passes through).
      const sc = result.studies[0] as {
        protocolSection: { descriptionModule: { briefSummary: string } };
      };
      expect(sc.protocolSection.descriptionModule.briefSummary).toBe(longSummary);

      // content[] renders it whole — no 200-char clip, no truncation ellipsis.
      const text = renderText(result);
      expect(text).toContain(longSummary);
      expect(text).not.toContain('…');
    });

    // The exclusion set suppressed three whole subtrees from the field dump
    // while the dedicated renderers covered only some of their leaves, so every
    // uncovered leaf was dropped from content[] despite being explicitly
    // requested. Values here are chosen not to collide with any other rendered
    // string — the parity walker is a literal-substring check, so a colliding
    // value passes while the leaf is never actually rendered.
    describe('explicitly requested leaves under a partly-rendered prefix (#120)', () => {
      const projection = () => ({
        protocolSection: {
          identificationModule: { nctId: 'NCT07770001', briefTitle: 'Renal cohort study' },
          designModule: { enrollmentInfo: { count: 4821, type: 'ESTIMATED' } },
          sponsorCollaboratorsModule: {
            leadSponsor: { name: 'Zephyr Biosciences', class: 'INDUSTRY' },
          },
          contactsLocationsModule: {
            locations: [
              {
                facility: 'Larkspur Research Center',
                city: 'Emeryville',
                state: 'California',
                country: 'United States',
                zip: '94608',
                contacts: [
                  {
                    name: 'Marisol Okonkwo',
                    phone: '555-0142',
                    email: 'okonkwo@larkspur.example',
                    role: 'STUDY_COORDINATOR',
                  },
                ],
              },
            ],
          },
        },
      });

      const runWithFields = async (fields: string[], study: unknown = projection()) => {
        mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });
        const ctx = createMockContext({ errors: searchStudies.errors });
        return await searchStudies.handler(
          searchStudies.input!.parse({ nctIds: ['NCT07770001'], fields, pageSize: 1 }),
          ctx,
        );
      };

      it('renders every requested leaf under its own label, with no parity gap', async () => {
        const result = await runWithFields([
          'NCTId',
          'BriefTitle',
          'EnrollmentCount',
          'EnrollmentType',
          'LeadSponsorName',
          'LeadSponsorClass',
          'LocationFacility',
          'LocationCity',
          'LocationState',
          'LocationCountry',
          'LocationZip',
          'LocationContactName',
          'LocationContactPhone',
          'LocationContactEMail',
          'LocationContactRole',
        ]);
        const text = renderText(result);

        expect(text).toContain('Enrollment > Type: ESTIMATED');
        expect(text).toContain('Lead Sponsor > Class: INDUSTRY');
        expect(text).toContain('Locations > Zip: 94608');
        expect(text).toContain('Contacts > Name: Marisol Okonkwo');
        expect(text).toContain('Contacts > Phone: 555-0142');
        expect(text).toContain('Contacts > Email: okonkwo@larkspur.example');
        expect(text).toContain('Contacts > Role: STUDY_COORDINATOR');
        // The leaves the dedicated renderers already cover stay where they are.
        expect(text).toContain('N=4821');
        expect(text).toContain('Zephyr Biosciences');
        expect(text).toContain('Larkspur Research Center, Emeryville, California, United States');
        expect(missingLeaves(result, text)).toEqual([]);
      });

      it('surfaces the requested leaf, not just the companion upstream bundles along', async () => {
        // Asking for LeadSponsorClass alone still returns leadSponsor.name from
        // upstream; the renderer used to show that unrequested half and drop the
        // requested one.
        const result = await runWithFields(['NCTId', 'LeadSponsorClass']);
        const text = renderText(result);
        expect(text).toContain('Lead Sponsor > Class: INDUSTRY');
        expect(missingLeaves(result, text)).toEqual([]);
      });

      it('surfaces EnrollmentType requested without EnrollmentCount', async () => {
        const result = await runWithFields(['NCTId', 'EnrollmentType']);
        const text = renderText(result);
        expect(text).toContain('Enrollment > Type: ESTIMATED');
        expect(missingLeaves(result, text)).toEqual([]);
      });

      it('attributes nested contacts to their own site when several sites carry several contacts', async () => {
        const multiSite = {
          protocolSection: {
            identificationModule: { nctId: 'NCT07770002' },
            contactsLocationsModule: {
              locations: [
                {
                  facility: 'Larkspur Research Center',
                  city: 'Emeryville',
                  zip: '94608',
                  contacts: [
                    { name: 'Marisol Okonkwo', phone: '555-0142' },
                    { name: 'Tobias Ferreira', phone: '555-0143' },
                  ],
                },
                {
                  facility: 'Windward Clinical',
                  city: 'Asheville',
                  zip: '28801',
                  contacts: [
                    { name: 'Priya Raghunathan', phone: '555-0144' },
                    { name: 'Desmond Achebe', phone: '555-0145' },
                  ],
                },
              ],
            },
          },
        };
        const result = await runWithFields(
          ['NCTId', 'LocationFacility', 'LocationCity', 'LocationZip', 'LocationContactName'],
          multiSite,
        );
        const text = renderText(result);

        // Each site's ZIP and each contact stay attributed to the site they
        // belong to — a flat label would splice two sites' staff together.
        expect(text).toContain('Locations[0] > Zip: 94608');
        expect(text).toContain('Locations[1] > Zip: 28801');
        expect(text).toContain('Locations[0] > Contacts[0] > Name: Marisol Okonkwo');
        expect(text).toContain('Locations[0] > Contacts[1] > Name: Tobias Ferreira');
        expect(text).toContain('Locations[1] > Contacts[0] > Name: Priya Raghunathan');
        expect(text).toContain('Locations[1] > Contacts[1] > Name: Desmond Achebe');
        expect(missingLeaves(result, text)).toEqual([]);
      });

      it('leaves the default no-fields index rendering untouched', async () => {
        // The exclusion set governs the requested-fields renderer only; the
        // compact index must render exactly as it did before.
        mockService.searchStudies.mockResolvedValue({
          studies: [projection()],
          totalCount: 1,
        });
        const ctx = createMockContext({ errors: searchStudies.errors });
        const result = await searchStudies.handler(
          searchStudies.input!.parse({ conditionQuery: 'renal' }),
          ctx,
        );
        const text = renderText(result);

        expect(text).toBe(
          [
            'Found 1 studies (1 total matching)',
            '- **NCT07770001**: Renal cohort study',
            '  N=4821 | Zephyr Biosciences',
            '  Site: Larkspur Research Center, Emeryville, California, United States',
          ].join('\n'),
        );
      });
    });
  });

  // The results workflow gates on hasResults and timeline questions need the
  // start / primary-completion dates, so the default index carries all three —
  // read from the full record the default search already fetches. Every case
  // runs the real pipeline (input parse → handler → output parse → format).
  describe('compact index — results flag and key dates (#139)', () => {
    const record = (
      nctId: string,
      statusModule: Record<string, unknown>,
      hasResults?: boolean,
    ) => ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: `Study ${nctId}` },
        statusModule: { overallStatus: 'COMPLETED', ...statusModule },
      } as Record<string, unknown>,
      ...(hasResults === undefined ? {} : { hasResults }),
    });

    const run = async (studies: unknown[], input: Record<string, unknown> = {}) => {
      mockService.searchStudies.mockResolvedValue({ studies, totalCount: studies.length });
      const result = await runToolContract(
        searchStudies,
        { conditionQuery: 'diabetes', ...input },
        { context: { errors: searchStudies.errors } },
      );
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { studies: Record<string, unknown>[] };
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
      return { structured, text };
    };

    it('carries hasResults and both dates on the default index, verbatim, in both channels', async () => {
      const { structured, text } = await run([
        record(
          'NCT02000001',
          {
            startDateStruct: { date: '2016-02', type: 'ACTUAL' },
            primaryCompletionDateStruct: { date: '2017-11-01', type: 'ACTUAL' },
          },
          true,
        ),
      ]);
      expect(structured.studies[0]).toEqual({
        nctId: 'NCT02000001',
        briefTitle: 'Study NCT02000001',
        overallStatus: 'COMPLETED',
        hasResults: true,
        startDate: '2016-02',
        primaryCompletionDate: '2017-11-01',
      });
      expect(text).toContain(
        '- **NCT02000001**: Study NCT02000001 [COMPLETED]\n  results posted | start 2016-02 | primary completion 2017-11-01',
      );
      expect(missingLeaves(structured, text)).toEqual([]);
    });

    it('renders hasResults=false as "no results", never as "results posted"', async () => {
      const { structured, text } = await run([record('NCT02000002', {}, false)]);
      expect(structured.studies[0]?.hasResults).toBe(false);
      expect(text).toContain('  no results');
      expect(text).not.toContain('results posted');
    });

    it('omits every new key and meta segment when the record publishes none of them', async () => {
      const { structured, text } = await run([record('NCT02000003', {})]);
      expect(structured.studies[0]).toEqual({
        nctId: 'NCT02000003',
        briefTitle: 'Study NCT02000003',
        overallStatus: 'COMPLETED',
      });
      expect(text).not.toMatch(/results|start |primary completion/);
    });

    it('omits a date whose struct carries no date string (type-only struct)', async () => {
      const { structured, text } = await run([
        record('NCT02000004', {
          startDateStruct: { type: 'ESTIMATED' },
          primaryCompletionDateStruct: { date: '2031-06' },
        }),
      ]);
      expect(structured.studies[0]).not.toHaveProperty('startDate');
      expect(structured.studies[0]?.primaryCompletionDate).toBe('2031-06');
      expect(text).not.toContain('start ');
      expect(text).toContain('primary completion 2031-06');
    });

    it('keeps each study’s flag and dates attributed to its own entry across a mixed page', async () => {
      const { structured, text } = await run([
        record('NCT02000011', { startDateStruct: { date: '2004-10' } }, true),
        record('NCT02000012', {}),
        record('NCT02000013', { primaryCompletionDateStruct: { date: '2010-01-01' } }, false),
      ]);
      expect(
        structured.studies.map((s) => [s.hasResults, s.startDate, s.primaryCompletionDate]),
      ).toEqual([
        [true, '2004-10', undefined],
        [undefined, undefined, undefined],
        [false, undefined, '2010-01-01'],
      ]);
      // The study list ends where the Search Criteria trailer begins.
      const blocks = text.split('\n\n')[0]!.split('\n- **').slice(1);
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toContain('results posted | start 2004-10');
      expect(blocks[0]).not.toContain('primary completion');
      expect(blocks[1]).not.toMatch(/results|start |primary completion/);
      expect(blocks[2]).toContain('no results | primary completion 2010-01-01');
      expect(blocks[2]).not.toContain('start ');
      expect(missingLeaves(structured, text)).toEqual([]);
    });

    it('appends the new segments after the existing meta line fields', async () => {
      const study = record('NCT02000021', { startDateStruct: { date: '2019-03-15' } }, true);
      Object.assign(study.protocolSection, {
        designModule: { phases: ['PHASE2'], enrollmentInfo: { count: 40 } },
        sponsorCollaboratorsModule: { leadSponsor: { name: 'Acme Health' } },
        conditionsModule: { conditions: ['Asthma'] },
      });
      const { text } = await run([study]);
      expect(text).toContain(
        '  PHASE2 | N=40 | Acme Health | Asthma | results posted | start 2019-03-15',
      );
    });

    it('sends no fields param upstream on the default path', async () => {
      await run([record('NCT02000031', {}, true)]);
      expect(mockService.searchStudies).toHaveBeenCalledTimes(1);
      expect(mockService.searchStudies.mock.calls[0]?.[0]?.fields).toBeUndefined();
    });

    it('describes the new index keys and the HasResults advanced filter', () => {
      const out = searchStudies.output!.shape as Record<string, { description?: string }>;
      for (const key of ['hasResults', 'startDate', 'primaryCompletionDate'])
        expect(out.studies?.description).toContain(key);
      const input = searchStudies.input!.shape as Record<string, { description?: string }>;
      expect(input.advancedFilter?.description).toContain('AREA[HasResults]true');
    });

    it('leaves the explicit-fields render unchanged — no index meta segments are added', async () => {
      const { text } = await run(
        [
          record(
            'NCT02000041',
            {
              startDateStruct: { date: '2016-02', type: 'ACTUAL' },
              primaryCompletionDateStruct: { date: '2017-11-01', type: 'ACTUAL' },
            },
            true,
          ),
        ],
        {
          fields: [
            'NCTId',
            'BriefTitle',
            'OverallStatus',
            'StartDate',
            'PrimaryCompletionDate',
            'HasResults',
          ],
        },
      );
      expect(text.split('\n\n')[0]).toBe(
        [
          'Found 1 studies (1 total matching)',
          'Requested fields: NCTId, BriefTitle, OverallStatus, StartDate, PrimaryCompletionDate, HasResults',
          '- **NCT02000041**: Study NCT02000041 [COMPLETED]',
          '  Start Date > Date: 2016-02',
          '  Start Date > Type: ACTUAL',
          '  Primary Completion Date > Date: 2017-11-01',
          '  Primary Completion Date > Type: ACTUAL',
          '  Has Results: true',
        ].join('\n'),
      );
    });
  });

  // statusFilter values upstream matches as case-sensitive literals, so the
  // handler canonicalizes each entry before the request: uppercase, separator
  // runs (whitespace, hyphen, underscore) collapsed to one underscore.
  describe('statusFilter case and spacing variants (#140)', () => {
    const STATUSES = [
      'RECRUITING',
      'COMPLETED',
      'ACTIVE_NOT_RECRUITING',
      'NOT_YET_RECRUITING',
      'ENROLLING_BY_INVITATION',
      'SUSPENDED',
      'TERMINATED',
      'WITHDRAWN',
      'UNKNOWN',
      'WITHHELD',
      'NO_LONGER_AVAILABLE',
      'AVAILABLE',
      'APPROVED_FOR_MARKETING',
      'TEMPORARILY_NOT_AVAILABLE',
    ] as const;
    const titleSpaced = (s: string) =>
      s
        .toLowerCase()
        .split('_')
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(' ');
    const VARIANTS = STATUSES.flatMap((canonical) => [
      [canonical.toLowerCase(), canonical],
      [titleSpaced(canonical), canonical],
      [canonical.toLowerCase().replaceAll('_', '-'), canonical],
      [`  ${canonical.toLowerCase().replaceAll('_', '  ')}\t`, canonical],
      [canonical, canonical],
    ]);

    beforeEach(() => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    });

    it.each(VARIANTS)('sends %j upstream as %s', async (variant, canonical) => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ statusFilter: variant }), ctx);
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterOverallStatus: [canonical] }),
        ctx,
      );
    });

    it('canonicalizes every entry of a mixed array and a stringified array', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({
          statusFilter: ['recruiting', 'Not Yet Recruiting', 'ACTIVE_NOT_RECRUITING'],
        }),
        ctx,
      );
      await searchStudies.handler(
        searchStudies.input!.parse({ statusFilter: '["recruiting","completed"]' }),
        ctx,
      );
      expect(mockService.searchStudies.mock.calls.map((c) => c[0].filterOverallStatus)).toEqual([
        ['RECRUITING', 'NOT_YET_RECRUITING', 'ACTIVE_NOT_RECRUITING'],
        ['RECRUITING', 'COMPLETED'],
      ]);
    });

    it('echoes the canonical value in searchCriteria, keeping the caller’s scalar/list shape', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ statusFilter: 'recruiting' }), ctx);
      expect(getEnrichment(ctx).searchCriteria).toMatchObject({ statusFilter: 'RECRUITING' });

      const listCtx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({ statusFilter: ['recruiting', 'completed'] }),
        listCtx,
      );
      expect(getEnrichment(listCtx).searchCriteria).toMatchObject({
        statusFilter: ['RECRUITING', 'COMPLETED'],
      });
    });

    it('forwards a value with no canonical match for upstream to reject (enum_invalid stays the service’s)', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({ statusFilter: 'pending review' }),
        ctx,
      );
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterOverallStatus: ['PENDING_REVIEW'] }),
        ctx,
      );
    });

    it('still answers a blank entry with blank_value before any request', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(
          searchStudies.input!.parse({ statusFilter: ['recruiting', ' \t'] }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'blank_value', param: 'statusFilter' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });
  });

  describe('nctIds case and whitespace variants (#140)', () => {
    beforeEach(() => {
      mockService.searchStudies.mockResolvedValue({ studies: [{}], totalCount: 1 });
    });

    it('canonicalizes a lowercase single ID before the filter and the echo', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(searchStudies.input!.parse({ nctIds: 'nct03722472' }), ctx);
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterIds: ['NCT03722472'], includeUnknownEnrollment: true }),
        ctx,
      );
      expect(getEnrichment(ctx).searchCriteria).toMatchObject({ nctIds: 'NCT03722472' });
    });

    it('canonicalizes every entry of an ID list', async () => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await searchStudies.handler(
        searchStudies.input!.parse({ nctIds: [' nct03722472 ', 'Nct06323538', 'NCT01171079'] }),
        ctx,
      );
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterIds: ['NCT03722472', 'NCT06323538', 'NCT01171079'] }),
        ctx,
      );
    });

    it.each(['ABC123', 'nct0372247', 'NCT 03722472', 'NCT0372247X', 'xnct03722472'])(
      'still rejects the malformed ID %j at the schema',
      (nctIds) => {
        expect(() => searchStudies.input!.parse({ nctIds })).toThrow(/NCTxxxxxxxx/);
        expect(() => searchStudies.input!.parse({ nctIds: [nctIds] })).toThrow(/NCTxxxxxxxx/);
      },
    );
  });
});
