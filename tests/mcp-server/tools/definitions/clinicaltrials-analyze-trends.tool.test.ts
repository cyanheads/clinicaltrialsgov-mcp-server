/**
 * @fileoverview Tests for the clinicaltrials_analyze_trends tool definition.
 * Validates metadata, input schema, logic (fetchAllStudies + aggregation), and response formatting.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-analyze-trends.tool
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  JsonRpcErrorCode,
  McpError,
} from '../../../../src/types-global/errors.js';
import type { RequestContext } from '../../../../src/utils/internal/requestContext.js';

// ----------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------

const mockListStudies = vi.fn();

vi.mock('../../../../src/container/index.js', () => {
  // Tokens use Symbol, so container.resolve receives a Token<T> with an `id: symbol`.
  // The source imports `AppConfig` and `ClinicalTrialsProvider` tokens and calls
  // `container.resolve(token)`. We match on the token's `description` property.
  return {
    container: {
      resolve: vi.fn((token: { description?: string }) => {
        if (token?.description === 'AppConfig') {
          return { maxStudiesForAnalysis: 5000 };
        }
        // Default: ClinicalTrialsProvider
        return { listStudies: mockListStudies };
      }),
    },
    AppConfig: { id: Symbol('AppConfig'), description: 'AppConfig' },
    ClinicalTrialsProvider: {
      id: Symbol('IClinicalTrialsProvider'),
      description: 'IClinicalTrialsProvider',
    },
  };
});

vi.mock('../../../../src/container/core/tokens.js', () => ({
  AppConfig: { id: Symbol('AppConfig'), description: 'AppConfig' },
  ClinicalTrialsProvider: {
    id: Symbol('IClinicalTrialsProvider'),
    description: 'IClinicalTrialsProvider',
  },
}));

vi.mock('../../../../src/mcp-server/transports/auth/lib/withAuth.js', () => ({
  withToolAuth: <T extends (...args: never[]) => unknown>(
    _scopes: string[],
    fn: T,
  ) => fn,
}));

vi.mock('../../../../src/utils/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    notice: vi.fn(),
  },
  requestContextService: {
    createRequestContext: vi.fn(() => ({
      requestId: 'test-request-id',
      operation: 'test',
    })),
  },
}));

// ----------------------------------------------------------------
// Import under test (must come after vi.mock)
// ----------------------------------------------------------------
import { analyzeTrendsTool } from '../../../../src/mcp-server/tools/definitions/clinicaltrials-analyze-trends.tool.js';

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
} as unknown as Parameters<typeof analyzeTrendsTool.logic>[2];

function makeAppContext(): RequestContext {
  return {
    requestId: 'test-request-id',
    timestamp: new Date().toISOString(),
    operation: 'test',
  };
}

interface StudyOverrides {
  statusModule?: Record<string, unknown>;
  contactsLocationsModule?: Record<string, unknown>;
  sponsorCollaboratorsModule?: Record<string, unknown>;
  designModule?: Record<string, unknown>;
  identificationModule?: Record<string, unknown>;
}

function makeStudy(overrides: StudyOverrides = {}) {
  return {
    protocolSection: {
      identificationModule: { nctId: 'NCT00000001' },
      statusModule: {
        overallStatus: 'Recruiting',
        startDateStruct: { date: '2023-06-15' },
      },
      contactsLocationsModule: {
        locations: [{ country: 'United States' }, { country: 'Canada' }],
      },
      sponsorCollaboratorsModule: {
        leadSponsor: { class: 'Industry' },
      },
      designModule: {
        phases: ['PHASE3'],
      },
      ...overrides,
    },
  };
}

/** Helper to safely access an array element and assert it exists. */
function at<T>(arr: T[], index: number): T {
  const val = arr[index];
  if (val === undefined) {
    throw new Error(
      `Expected element at index ${index} but array has length ${arr.length}`,
    );
  }
  return val;
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('analyzeTrendsTool', () => {
  // The tool's internal `delay()` uses setTimeout. Since fake timers are globally enabled,
  // we switch to real timers for this file so the 250ms delays resolve naturally.
  beforeAll(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.useFakeTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // 1. Metadata
  // ============================================================
  describe('metadata', () => {
    it('should have the correct name', () => {
      expect(analyzeTrendsTool.name).toBe('clinicaltrials_analyze_trends');
    });

    it('should have a title', () => {
      expect(analyzeTrendsTool.title).toBe('Analyze Clinical Trial Trends');
    });

    it('should have a description', () => {
      expect(analyzeTrendsTool.description).toContain('statistical analysis');
    });

    it('should have correct annotations', () => {
      expect(analyzeTrendsTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    });

    it('should have inputSchema, outputSchema, logic, and responseFormatter', () => {
      expect(analyzeTrendsTool.inputSchema).toBeDefined();
      expect(analyzeTrendsTool.outputSchema).toBeDefined();
      expect(typeof analyzeTrendsTool.logic).toBe('function');
      expect(typeof analyzeTrendsTool.responseFormatter).toBe('function');
    });
  });

  // ============================================================
  // 2. Input Schema Validation
  // ============================================================
  describe('inputSchema', () => {
    const schema = analyzeTrendsTool.inputSchema;

    it('should accept a single analysis type', () => {
      const result = schema.safeParse({ analysisType: 'countByStatus' });
      expect(result.success).toBe(true);
    });

    it('should accept an array of analysis types', () => {
      const result = schema.safeParse({
        analysisType: ['countByStatus', 'countByCountry'],
      });
      expect(result.success).toBe(true);
    });

    it('should accept optional query and filter', () => {
      const result = schema.safeParse({
        analysisType: 'countByPhase',
        query: 'cancer',
        filter: 'AREA[Phase]PHASE3',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('cancer');
        expect(result.data.filter).toBe('AREA[Phase]PHASE3');
      }
    });

    it('should reject an invalid analysis type string', () => {
      const result = schema.safeParse({ analysisType: 'invalidType' });
      expect(result.success).toBe(false);
    });

    it('should reject an empty array of analysis types', () => {
      const result = schema.safeParse({ analysisType: [] });
      expect(result.success).toBe(false);
    });

    it('should reject missing analysisType', () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject an array containing invalid analysis types', () => {
      const result = schema.safeParse({
        analysisType: ['countByStatus', 'notAType'],
      });
      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // 3. Logic — fetchAllStudies behavior
  // ============================================================
  describe('logic - fetchAllStudies', () => {
    it('should return empty analysis when totalCount is 0', async () => {
      mockListStudies.mockResolvedValueOnce({
        studies: [],
        totalCount: 0,
      });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByStatus' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.analysis).toHaveLength(1);
      expect(at(result.analysis, 0).totalStudies).toBe(0);
      expect(at(result.analysis, 0).results).toEqual({});
    });

    it('should throw McpError ValidationError when totalCount exceeds maxStudies', async () => {
      mockListStudies.mockResolvedValueOnce({
        studies: [],
        totalCount: 10000,
      });

      await expect(
        analyzeTrendsTool.logic(
          { analysisType: 'countByStatus' },
          makeAppContext(),
          mockSdkContext,
        ),
      ).rejects.toThrow(McpError);

      try {
        mockListStudies.mockResolvedValueOnce({
          studies: [],
          totalCount: 10000,
        });
        await analyzeTrendsTool.logic(
          { analysisType: 'countByStatus' },
          makeAppContext(),
          mockSdkContext,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        expect((err as McpError).message).toContain('exceeds the limit');
      }
    });

    it('should fetch a single page when all studies fit', async () => {
      const studies = [makeStudy(), makeStudy()];

      // First page returns all studies — no nextPageToken
      mockListStudies.mockResolvedValueOnce({
        studies,
        totalCount: 2,
        nextPageToken: undefined,
      });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByStatus' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).totalStudies).toBe(2);
      // Single page — only one call needed
      expect(mockListStudies).toHaveBeenCalledTimes(1);
    });

    it('should paginate through multiple pages', async () => {
      const page1Studies = [makeStudy(), makeStudy()];
      const page2Studies = [makeStudy()];

      // Page 1 (includes totalCount + nextPageToken)
      mockListStudies.mockResolvedValueOnce({
        studies: page1Studies,
        totalCount: 3,
        nextPageToken: 'token-page-2',
      });
      // Page 2 (no more pages)
      mockListStudies.mockResolvedValueOnce({
        studies: page2Studies,
        totalCount: 3,
        nextPageToken: undefined,
      });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByStatus' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).totalStudies).toBe(3);
      expect(mockListStudies).toHaveBeenCalledTimes(2);

      // Verify the second page call included the pageToken
      const secondPageCall = at(mockListStudies.mock.calls, 1);
      expect(secondPageCall[0]).toHaveProperty('pageToken', 'token-page-2');
    });

    it('should pass query and filter to listStudies', async () => {
      mockListStudies.mockResolvedValueOnce({
        studies: [],
        totalCount: 0,
      });

      await analyzeTrendsTool.logic(
        {
          analysisType: 'countByStatus',
          query: 'diabetes',
          filter: 'AREA[Status]Recruiting',
        },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(mockListStudies.mock.calls, 0)[0]).toMatchObject({
        query: 'diabetes',
        filter: 'AREA[Status]Recruiting',
        pageSize: 1000,
      });
    });
  });

  // ============================================================
  // 4. Logic — each analysis type
  // ============================================================
  describe('logic - countByStatus', () => {
    it('should aggregate studies by overallStatus', async () => {
      const studies = [
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023-01-01' },
          },
        }),
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023-01-01' },
          },
        }),
        makeStudy({
          statusModule: {
            overallStatus: 'Completed',
            startDateStruct: { date: '2023-01-01' },
          },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 3 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByStatus' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({
        Recruiting: 2,
        Completed: 1,
      });
    });

    it('should count "Unknown" when overallStatus is missing', async () => {
      const studies = [makeStudy({ statusModule: {} })];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByStatus' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({ Unknown: 1 });
    });
  });

  describe('logic - countByCountry', () => {
    it('should aggregate studies by country, counting multi-location studies per location', async () => {
      const studies = [
        makeStudy({
          contactsLocationsModule: {
            locations: [{ country: 'United States' }, { country: 'Canada' }],
          },
        }),
        makeStudy({
          contactsLocationsModule: {
            locations: [{ country: 'United States' }],
          },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 2 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByCountry' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({
        'United States': 2,
        Canada: 1,
      });
    });

    it('should handle studies with no locations', async () => {
      const studies = [makeStudy({ contactsLocationsModule: {} })];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByCountry' },
        makeAppContext(),
        mockSdkContext,
      );

      // No locations to iterate — results should be empty
      expect(at(result.analysis, 0).results).toEqual({});
    });

    it('should count "Unknown" for locations missing a country', async () => {
      const studies = [
        makeStudy({
          contactsLocationsModule: {
            locations: [{ country: undefined }],
          },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByCountry' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({ Unknown: 1 });
    });
  });

  describe('logic - countBySponsorType', () => {
    it('should aggregate studies by sponsor class', async () => {
      const studies = [
        makeStudy({
          sponsorCollaboratorsModule: { leadSponsor: { class: 'Industry' } },
        }),
        makeStudy({
          sponsorCollaboratorsModule: { leadSponsor: { class: 'Industry' } },
        }),
        makeStudy({
          sponsorCollaboratorsModule: { leadSponsor: { class: 'NIH' } },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 3 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countBySponsorType' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({
        Industry: 2,
        NIH: 1,
      });
    });

    it('should count "Unknown" when sponsor class is missing', async () => {
      const studies = [makeStudy({ sponsorCollaboratorsModule: {} })];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countBySponsorType' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({ Unknown: 1 });
    });
  });

  describe('logic - countByPhase', () => {
    it('should aggregate studies by phase, supporting multi-phase studies', async () => {
      const studies = [
        makeStudy({ designModule: { phases: ['PHASE2', 'PHASE3'] } }),
        makeStudy({ designModule: { phases: ['PHASE3'] } }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 2 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByPhase' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({
        PHASE2: 1,
        PHASE3: 2,
      });
    });

    it('should count "Unknown" when phases array is missing', async () => {
      const studies = [makeStudy({ designModule: {} })];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByPhase' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({ Unknown: 1 });
    });
  });

  describe('logic - countByYear', () => {
    it('should extract YYYY from startDateStruct.date', async () => {
      const studies = [
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023-06-15' },
          },
        }),
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023-01-01' },
          },
        }),
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2022-12-01' },
          },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 3 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByYear' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({
        '2023': 2,
        '2022': 1,
      });
    });

    it('should count "Unknown" when startDateStruct is missing', async () => {
      const studies = [
        makeStudy({ statusModule: { overallStatus: 'Recruiting' } }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByYear' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({ Unknown: 1 });
    });
  });

  describe('logic - countByMonth', () => {
    it('should extract YYYY-MM from startDateStruct.date', async () => {
      const studies = [
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023-06-15' },
          },
        }),
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023-06-01' },
          },
        }),
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023-07-01' },
          },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 3 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByMonth' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({
        '2023-06': 2,
        '2023-07': 1,
      });
    });

    it('should count "Unknown" when date is too short for YYYY-MM extraction', async () => {
      const studies = [
        makeStudy({
          statusModule: {
            overallStatus: 'Recruiting',
            startDateStruct: { date: '2023' },
          },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByMonth' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({ Unknown: 1 });
    });

    it('should count "Unknown" when startDateStruct is missing', async () => {
      const studies = [
        makeStudy({ statusModule: { overallStatus: 'Recruiting' } }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 1 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: 'countByMonth' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(at(result.analysis, 0).results).toEqual({ Unknown: 1 });
    });
  });

  // ============================================================
  // 5. Logic — multiple analysis types in one call
  // ============================================================
  describe('logic - multiple analysis types', () => {
    it('should return one result per requested analysis type', async () => {
      const studies = [
        makeStudy(),
        makeStudy({
          statusModule: {
            overallStatus: 'Completed',
            startDateStruct: { date: '2022-03-01' },
          },
        }),
      ];

      mockListStudies.mockResolvedValueOnce({ studies, totalCount: 2 });

      const result = await analyzeTrendsTool.logic(
        { analysisType: ['countByStatus', 'countByPhase', 'countByYear'] },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.analysis).toHaveLength(3);
      expect(at(result.analysis, 0).analysisType).toBe('countByStatus');
      expect(at(result.analysis, 1).analysisType).toBe('countByPhase');
      expect(at(result.analysis, 2).analysisType).toBe('countByYear');

      // Verify each has the same totalStudies
      for (const a of result.analysis) {
        expect(a.totalStudies).toBe(2);
      }

      // countByStatus
      expect(at(result.analysis, 0).results).toEqual({
        Recruiting: 1,
        Completed: 1,
      });

      // countByPhase — both studies have PHASE3
      expect(at(result.analysis, 1).results).toEqual({ PHASE3: 2 });

      // countByYear
      expect(at(result.analysis, 2).results).toEqual({
        '2023': 1,
        '2022': 1,
      });
    });
  });

  // ============================================================
  // 6. Response Formatter
  // ============================================================
  describe('responseFormatter', () => {
    // responseFormatter is guaranteed to exist on this tool definition
    const formatter = analyzeTrendsTool.responseFormatter as NonNullable<
      typeof analyzeTrendsTool.responseFormatter
    >;

    it('should produce a single text content block', () => {
      const output = {
        analysis: [
          {
            analysisType: 'countByStatus' as const,
            totalStudies: 100,
            results: { Recruiting: 60, Completed: 40 },
          },
        ],
      };

      const blocks = formatter(output);
      expect(blocks).toHaveLength(1);
      expect(at(blocks, 0).type).toBe('text');
    });

    it('should say "1 analysis" for singular', () => {
      const output = {
        analysis: [
          {
            analysisType: 'countByStatus' as const,
            totalStudies: 10,
            results: { Recruiting: 10 },
          },
        ],
      };

      const blocks = formatter(output);
      const text = (at(blocks, 0) as { type: 'text'; text: string }).text;
      expect(text).toContain('Completed 1 analysis');
    });

    it('should say "2 analyses" for plural', () => {
      const output = {
        analysis: [
          {
            analysisType: 'countByStatus' as const,
            totalStudies: 10,
            results: { Recruiting: 10 },
          },
          {
            analysisType: 'countByPhase' as const,
            totalStudies: 10,
            results: { PHASE3: 10 },
          },
        ],
      };

      const blocks = formatter(output);
      const text = (at(blocks, 0) as { type: 'text'; text: string }).text;
      expect(text).toContain('Completed 2 analyses');
    });

    it('should separate multiple analyses with ---', () => {
      const output = {
        analysis: [
          {
            analysisType: 'countByStatus' as const,
            totalStudies: 10,
            results: { Recruiting: 10 },
          },
          {
            analysisType: 'countByPhase' as const,
            totalStudies: 10,
            results: { PHASE3: 10 },
          },
        ],
      };

      const blocks = formatter(output);
      const text = (at(blocks, 0) as { type: 'text'; text: string }).text;
      expect(text).toContain('---');
    });

    it('should include percentage calculations', () => {
      const output = {
        analysis: [
          {
            analysisType: 'countByStatus' as const,
            totalStudies: 200,
            results: { Recruiting: 100, Completed: 100 },
          },
        ],
      };

      const blocks = formatter(output);
      const text = (at(blocks, 0) as { type: 'text'; text: string }).text;
      expect(text).toContain('50.0%');
    });

    it('should show top 10 and "...and N more" when >10 categories', () => {
      const results: Record<string, number> = {};
      for (let i = 0; i < 15; i++) {
        results[`Country${String(i).padStart(2, '0')}`] = 15 - i;
      }

      const output = {
        analysis: [
          {
            analysisType: 'countByCountry' as const,
            totalStudies: 120,
            results,
          },
        ],
      };

      const blocks = formatter(output);
      const text = (at(blocks, 0) as { type: 'text'; text: string }).text;

      // Should have 10 bullet entries
      const bulletCount = (text.match(/\u2022/g) ?? []).length;
      expect(bulletCount).toBe(10);

      // Should mention the remaining 5
      expect(text).toContain('...and 5 more');
    });

    it('should not show "...and N more" when <=10 categories', () => {
      const output = {
        analysis: [
          {
            analysisType: 'countByStatus' as const,
            totalStudies: 100,
            results: { Recruiting: 60, Completed: 40 },
          },
        ],
      };

      const blocks = formatter(output);
      const text = (at(blocks, 0) as { type: 'text'; text: string }).text;
      expect(text).not.toContain('...and');
    });

    it('should sort entries by count descending', () => {
      const output = {
        analysis: [
          {
            analysisType: 'countByStatus' as const,
            totalStudies: 100,
            results: {
              Finished: 10,
              Recruiting: 50,
              'Not yet recruiting': 40,
            },
          },
        ],
      };

      const blocks = formatter(output);
      const text = (at(blocks, 0) as { type: 'text'; text: string }).text;

      // Extract only the bullet lines to verify sort order
      const bulletLines = text
        .split('\n')
        .filter((line) => line.includes('\u2022'));
      expect(bulletLines).toHaveLength(3);
      expect(at(bulletLines, 0)).toContain('Recruiting');
      expect(at(bulletLines, 0)).toContain('50');
      expect(at(bulletLines, 1)).toContain('Not yet recruiting');
      expect(at(bulletLines, 1)).toContain('40');
      expect(at(bulletLines, 2)).toContain('Finished');
      expect(at(bulletLines, 2)).toContain('10');
    });
  });
});
