/**
 * @fileoverview Tests for clinicaltrials_get_study_count tool.
 * @module tests/mcp-server/tools/definitions/get-study-count.tool
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

import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';

describe('getStudyCount', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('handler', () => {
    it('returns total count from service', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 42 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      const input = getStudyCount.input!.parse({ conditionQuery: 'diabetes' });
      const result = await getStudyCount.handler(input, ctx);

      expect(result.totalCount).toBe(42);
    });

    it('defaults totalCount to 0 when undefined', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [] });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      const result = await getStudyCount.handler(getStudyCount.input!.parse({}), ctx);

      expect(result.totalCount).toBe(0);
    });

    it('calls service with pageSize 0 and countTotal true', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 10 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await getStudyCount.handler(getStudyCount.input!.parse({ query: 'test' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 0, countTotal: true }),
        ctx,
      );
    });

    it('echoes populated criteria in enrichment', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 5 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      const input = getStudyCount.input!.parse({
        conditionQuery: 'cancer',
        statusFilter: 'RECRUITING',
      });
      await getStudyCount.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({
        conditionQuery: 'cancer',
        statusFilter: 'RECRUITING',
        sentinelFilterActive: true,
      });
    });

    it('echoes all provided criteria in enrichment', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 1 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      const input = getStudyCount.input!.parse({
        query: 'test',
        conditionQuery: 'cancer',
        interventionQuery: 'chemo',
        locationQuery: 'Seattle',
        sponsorQuery: 'NIH',
        titleQuery: 'phase 3',
        outcomeQuery: 'survival',
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
        locationQuery: 'Seattle',
        sponsorQuery: 'NIH',
        titleQuery: 'phase 3',
        outcomeQuery: 'survival',
        statusFilter: 'RECRUITING',
        phaseFilter: 'PHASE3',
        advancedFilter: 'AREA[StudyType]INTERVENTIONAL',
        sentinelFilterActive: true,
      });
    });

    it('echoes sentinelFilterActive by default even with no query criteria (#78)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 100 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await getStudyCount.handler(getStudyCount.input!.parse({}), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({ sentinelFilterActive: true });
    });

    it('omits sentinelFilterActive when includeUnknownEnrollment=true (#78)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 100 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await getStudyCount.handler(
        getStudyCount.input!.parse({ includeUnknownEnrollment: true }),
        ctx,
      );

      const enrichment = getEnrichment(ctx);
      // Exclusion off and no other criteria → nothing to echo.
      expect(enrichment.searchCriteria).toBeUndefined();
    });

    it('passes phase filter through buildAdvancedFilter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
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

    it('forwards locationQuery, titleQuery, outcomeQuery to service (#59)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 3 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await getStudyCount.handler(
        getStudyCount.input!.parse({
          locationQuery: 'Boston',
          titleQuery: 'vaccine',
          outcomeQuery: 'mortality',
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryLocn: 'Boston',
          queryTitles: 'vaccine',
          queryOutc: 'mortality',
        }),
        ctx,
      );
    });

    it('provides notice in enrichment when totalCount is 0', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await getStudyCount.handler(getStudyCount.input!.parse({ conditionQuery: 'xyz' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('Try broader search terms or fewer filters.');
    });

    it('omits notice enrichment when totalCount > 0', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 5 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await getStudyCount.handler(getStudyCount.input!.parse({ conditionQuery: 'diabetes' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeUndefined();
    });

    it('converts statusFilter string to array', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await getStudyCount.handler(getStudyCount.input!.parse({ statusFilter: 'RECRUITING' }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterOverallStatus: ['RECRUITING'] }),
        ctx,
      );
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

    it.each(QUERY_PARAMS)('rejects an empty %s instead of counting the whole registry', (param) => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      return expectBlankValue(
        getStudyCount.handler(getStudyCount.input!.parse({ [param]: '' }), ctx),
        param,
      );
    });

    it.each(QUERY_PARAMS)('rejects a whitespace-only %s', (param) => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      return expectBlankValue(
        getStudyCount.handler(getStudyCount.input!.parse({ [param]: '  ' }), ctx),
        param,
      );
    });

    it.each(['', '   '])(
      'rejects a blank advancedFilter (%j) instead of dropping the constraint',
      async (advancedFilter) => {
        const ctx = createMockContext({ errors: getStudyCount.errors });
        await expectBlankValue(
          getStudyCount.handler(getStudyCount.input!.parse({ advancedFilter }), ctx),
          'advancedFilter',
        );
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it('leaves a non-blank advancedFilter untouched', async () => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await expect(
        getStudyCount.handler(
          getStudyCount.input!.parse({ advancedFilter: 'AREA[StudyType]INTERVENTIONAL' }),
          ctx,
        ),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterAdvanced: 'AREA[StudyType]INTERVENTIONAL' }),
        ctx,
      );
    });

    it('never reaches the service when a query value is blank', async () => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await expectBlankValue(
        getStudyCount.handler(getStudyCount.input!.parse({ query: '' }), ctx),
        'query',
      );
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it.each(['statusFilter', 'phaseFilter'] as const)(
      'rejects a stringified empty %s array',
      (param) => {
        const ctx = createMockContext({ errors: getStudyCount.errors });
        return expectBlankValue(
          getStudyCount.handler(getStudyCount.input!.parse({ [param]: '[]' }), ctx),
          param,
        );
      },
    );

    // Through the real `.input.parse()` path: the schema lets `[]` through and
    // the handler raises the declared blank_value contract. A schema `.min(1)`
    // would preempt the handler and surface a bare -32602 carrying no reason
    // and no recovery hint (#109).
    it.each(['statusFilter', 'phaseFilter'] as const)(
      'answers an empty %s with the typed blank_value contract, not a bare schema rejection',
      async (param) => {
        const ctx = createMockContext({ errors: getStudyCount.errors });
        await expectBlankValue(
          getStudyCount.handler(getStudyCount.input!.parse({ [param]: [] }), ctx),
          param,
        );
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it('rejects a statusFilter carrying a blank entry', () => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      return expectBlankValue(
        getStudyCount.handler(
          getStudyCount.input!.parse({ statusFilter: ['RECRUITING', ''] }),
          ctx,
        ),
        'statusFilter',
      );
    });

    it('rejects a phaseFilter carrying a blank entry', () => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      return expectBlankValue(
        getStudyCount.handler(getStudyCount.input!.parse({ phaseFilter: ['PHASE3', ' '] }), ctx),
        'phaseFilter',
      );
    });

    it('leaves omission untouched — every narrowed parameter stays optional', async () => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await expect(
        getStudyCount.handler(getStudyCount.input!.parse({}), ctx),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryTerm: undefined,
          filterOverallStatus: undefined,
          filterAdvanced: undefined,
        }),
        ctx,
      );
    });

    it('leaves non-blank values untouched', async () => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await expect(
        getStudyCount.handler(
          getStudyCount.input!.parse({
            query: 'diabetes',
            statusFilter: 'RECRUITING',
            phaseFilter: ['PHASE1', 'PHASE2'],
          }),
          ctx,
        ),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryTerm: 'diabetes',
          filterOverallStatus: ['RECRUITING'],
          filterAdvanced: '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2)',
        }),
        ctx,
      );
    });

    it('declares the blank_value reason on the tool contract', () => {
      expect(getStudyCount.errors?.map((e) => e.reason)).toContain('blank_value');
    });
  });

  // The seven *Query descriptions are literal duplicates of search_studies'
  // — no shared constant holds them, so they drift silently unless pinned.
  // Both tools front the same ClinicalTrials.gov search areas, so a caller
  // reading either one must learn the same match surface (#108).
  describe('*Query match-surface descriptions (#108)', () => {
    const QUERY_PARAMS = [
      'query',
      'conditionQuery',
      'interventionQuery',
      'locationQuery',
      'sponsorQuery',
      'titleQuery',
      'outcomeQuery',
    ] as const;

    it.each(QUERY_PARAMS)('%s carries the same description as search_studies', (param) => {
      const countShape = getStudyCount.input!.shape as Record<string, { description?: string }>;
      const searchShape = searchStudies.input!.shape as Record<string, { description?: string }>;
      expect(countShape[param]?.description).toBe(searchShape[param]?.description);
    });

    it('names ConditionAncestorTerm and its broadening effect on conditionQuery', () => {
      const shape = getStudyCount.input!.shape as Record<string, { description?: string }>;
      expect(shape.conditionQuery?.description).toContain('ConditionAncestorTerm');
      expect(shape.conditionQuery?.description).toMatch(/broader than/i);
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
