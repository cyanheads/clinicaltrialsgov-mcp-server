/**
 * @fileoverview Tests for clinicaltrials_search_studies tool.
 * @module tests/mcp-server/tools/definitions/search-studies.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import { haversineMi } from '@/mcp-server/tools/utils/geo-helpers.js';

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
          filterAdvanced: 'AREA[Phase]PHASE3 AND AREA[StudyType]INTERVENTIONAL',
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

    // Three constraint strings whose consumers guard on plain truthiness:
    // '' is falsy and silently dropped — the widening #99 exists to stop —
    // while ' ' is truthy and forwarded upstream, splicing a blank term into a
    // joined boolean expression for advancedFilter and sending a malformed
    // value for geoFilter and sort.
    const CONSTRAINT_PARAMS = ['advancedFilter', 'geoFilter', 'sort'] as const;

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
  });
});
