/**
 * @fileoverview Tests for the clinicaltrials_get_study tool definition.
 * Covers metadata, input schema validation, logic (single/multi study, summaries,
 * partial/total failures), and response formatting.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-get-study.tool.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SdkContext } from '@/mcp-server/tools/utils/toolDefinition.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { requestContextService, type RequestContext } from '@/utils/index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchStudy = vi.fn();
const mockListStudies = vi.fn();

vi.mock('@/container/index.js', () => ({
  container: {
    resolve: vi.fn(() => ({
      fetchStudy: mockFetchStudy,
      listStudies: mockListStudies,
    })),
  },
}));

vi.mock('@/mcp-server/transports/auth/lib/withAuth.js', () => ({
  withToolAuth: (_scopes: string[], fn: Function) => fn,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSdkContext(
  overrides: Record<string, unknown> = {},
): SdkContext {
  return {
    signal: new AbortController().signal,
    requestId: 'test-request-id',
    sendNotification: () => Promise.resolve(),
    sendRequest: () => Promise.resolve({}) as never,
    ...overrides,
  } as SdkContext;
}

function createAppContext(): RequestContext {
  return requestContextService.createRequestContext({
    operation: 'test-get-study',
  });
}

function buildMockStudy(overrides: Record<string, unknown> = {}) {
  return {
    protocolSection: {
      identificationModule: {
        nctId: 'NCT12345678',
        briefTitle: 'Test Study',
        officialTitle: 'Official Test Study Title',
      },
      statusModule: {
        overallStatus: 'Recruiting',
      },
      descriptionModule: {
        briefSummary: 'This is a test study summary.',
      },
      conditionsModule: {
        conditions: ['Diabetes', 'Hypertension'],
      },
      armsInterventionsModule: {
        interventions: [
          { name: 'Drug A', type: 'Drug', description: 'Test drug' },
        ],
      },
      sponsorCollaboratorsModule: {
        leadSponsor: { name: 'Test Sponsor', class: 'Industry' },
      },
      eligibilityModule: {},
      designModule: {},
    },
    ...overrides,
  };
}

function buildMockStudy2() {
  return buildMockStudy({
    protocolSection: {
      identificationModule: {
        nctId: 'NCT87654321',
        briefTitle: 'Second Study',
        officialTitle: 'Official Second Study Title',
      },
      statusModule: { overallStatus: 'Completed' },
      descriptionModule: { briefSummary: 'Second study summary.' },
      conditionsModule: { conditions: ['Cancer'] },
      armsInterventionsModule: {
        interventions: [
          { name: 'Therapy B', type: 'Biological', description: 'Bio' },
        ],
      },
      sponsorCollaboratorsModule: {
        leadSponsor: { name: 'NIH', class: 'NIH' },
      },
      eligibilityModule: {},
      designModule: {},
    },
  });
}

// ---------------------------------------------------------------------------
// Import tool under test (must come AFTER vi.mock calls)
// ---------------------------------------------------------------------------

const { getStudyTool } =
  await import('@/mcp-server/tools/definitions/clinicaltrials-get-study.tool.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clinicaltrials_get_study tool', () => {
  const sdkContext = createMockSdkContext();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Metadata
  // =========================================================================

  describe('Metadata', () => {
    it('has the correct programmatic name', () => {
      expect(getStudyTool.name).toBe('clinicaltrials_get_study');
    });

    it('has a human-readable title', () => {
      expect(getStudyTool.title).toBe('Get Clinical Study');
    });

    it('has a non-empty description', () => {
      expect(getStudyTool.description).toBeTruthy();
      expect(getStudyTool.description.length).toBeGreaterThan(10);
    });

    it('has correct annotations', () => {
      expect(getStudyTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    });

    it('exports inputSchema, outputSchema, logic, and responseFormatter', () => {
      expect(getStudyTool.inputSchema).toBeDefined();
      expect(getStudyTool.outputSchema).toBeDefined();
      expect(typeof getStudyTool.logic).toBe('function');
      expect(typeof getStudyTool.responseFormatter).toBe('function');
    });
  });

  // =========================================================================
  // Input Schema Validation
  // =========================================================================

  describe('Input Schema Validation', () => {
    const { inputSchema } = getStudyTool;

    it('accepts a single valid NCT ID string', () => {
      const result = inputSchema.safeParse({ nctIds: 'NCT12345678' });
      expect(result.success).toBe(true);
    });

    it('accepts a lowercase NCT ID (case-insensitive prefix)', () => {
      const result = inputSchema.safeParse({ nctIds: 'nct12345678' });
      expect(result.success).toBe(true);
    });

    it('accepts a mixed-case NCT ID', () => {
      const result = inputSchema.safeParse({ nctIds: 'NcT12345678' });
      expect(result.success).toBe(true);
    });

    it('accepts an array of valid NCT IDs', () => {
      const result = inputSchema.safeParse({
        nctIds: ['NCT11111111', 'NCT22222222', 'NCT33333333'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts an array of exactly 5 NCT IDs (max boundary)', () => {
      const ids = Array.from(
        { length: 5 },
        (_, i) => `NCT${String(i + 1).padStart(8, '0')}`,
      );
      const result = inputSchema.safeParse({ nctIds: ids });
      expect(result.success).toBe(true);
    });

    it('rejects an NCT ID with wrong digit count (too few)', () => {
      const result = inputSchema.safeParse({ nctIds: 'NCT1234' });
      expect(result.success).toBe(false);
    });

    it('rejects an NCT ID with wrong digit count (too many)', () => {
      const result = inputSchema.safeParse({ nctIds: 'NCT123456789' });
      expect(result.success).toBe(false);
    });

    it('rejects an NCT ID missing the NCT prefix', () => {
      const result = inputSchema.safeParse({ nctIds: '12345678' });
      expect(result.success).toBe(false);
    });

    it('rejects an empty array', () => {
      const result = inputSchema.safeParse({ nctIds: [] });
      expect(result.success).toBe(false);
    });

    it('rejects more than 5 NCT IDs', () => {
      const ids = Array.from(
        { length: 6 },
        (_, i) => `NCT${String(i + 1).padStart(8, '0')}`,
      );
      const result = inputSchema.safeParse({ nctIds: ids });
      expect(result.success).toBe(false);
    });

    it('rejects an array containing an invalid NCT ID', () => {
      const result = inputSchema.safeParse({
        nctIds: ['NCT12345678', 'INVALID'],
      });
      expect(result.success).toBe(false);
    });

    it('defaults summaryOnly to false when not provided', () => {
      const result = inputSchema.safeParse({ nctIds: 'NCT12345678' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.summaryOnly).toBe(false);
      }
    });

    it('accepts summaryOnly=true', () => {
      const result = inputSchema.safeParse({
        nctIds: 'NCT12345678',
        summaryOnly: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.summaryOnly).toBe(true);
      }
    });
  });

  // =========================================================================
  // Logic — Single Study
  // =========================================================================

  describe('Logic — single study', () => {
    it('fetches and returns full study data for a single ID string', async () => {
      const study = buildMockStudy();
      mockFetchStudy.mockResolvedValueOnce(study);

      const result = await getStudyTool.logic(
        { nctIds: 'NCT12345678', summaryOnly: false },
        createAppContext(),
        sdkContext,
      );

      expect(mockFetchStudy).toHaveBeenCalledTimes(1);
      expect(mockFetchStudy).toHaveBeenCalledWith(
        'NCT12345678',
        expect.objectContaining({ operation: 'test-get-study' }),
      );
      expect(result.studies).toHaveLength(1);
      expect(result.studies[0]).toEqual(study);
      expect(result.errors).toBeUndefined();
    });

    it('returns a summary when summaryOnly=true', async () => {
      const study = buildMockStudy();
      mockFetchStudy.mockResolvedValueOnce(study);

      const result = await getStudyTool.logic(
        { nctIds: 'NCT12345678', summaryOnly: true },
        createAppContext(),
        sdkContext,
      );

      expect(result.studies).toHaveLength(1);
      const summary = result.studies[0] as Record<string, unknown>;
      expect(summary.nctId).toBe('NCT12345678');
      expect(summary.title).toBe('Official Test Study Title');
      expect(summary.briefSummary).toBe('This is a test study summary.');
      expect(summary.overallStatus).toBe('Recruiting');
      expect(summary.conditions).toEqual(['Diabetes', 'Hypertension']);
      expect(summary.interventions).toEqual([{ name: 'Drug A', type: 'Drug' }]);
      expect(summary.leadSponsor).toBe('Test Sponsor');
      // Full study keys should NOT be present
      expect(summary).not.toHaveProperty('protocolSection');
    });

    it('handles a single NCT ID passed as a 1-element array', async () => {
      const study = buildMockStudy();
      mockFetchStudy.mockResolvedValueOnce(study);

      const result = await getStudyTool.logic(
        { nctIds: ['NCT12345678'], summaryOnly: false },
        createAppContext(),
        sdkContext,
      );

      expect(result.studies).toHaveLength(1);
      expect(result.studies[0]).toEqual(study);
    });
  });

  // =========================================================================
  // Logic — Multiple Studies
  // =========================================================================

  describe('Logic — multiple studies', () => {
    it('fetches multiple studies successfully via listStudies batch', async () => {
      const study1 = buildMockStudy();
      const study2 = buildMockStudy2();
      mockListStudies.mockResolvedValueOnce({
        studies: [study1, study2],
        totalCount: 2,
      });

      const result = await getStudyTool.logic(
        { nctIds: ['NCT12345678', 'NCT87654321'], summaryOnly: false },
        createAppContext(),
        sdkContext,
      );

      expect(mockFetchStudy).not.toHaveBeenCalled();
      expect(mockListStudies).toHaveBeenCalledTimes(1);
      expect(mockListStudies).toHaveBeenCalledWith(
        {
          filter: 'AREA[NCTId](NCT12345678 OR NCT87654321)',
          pageSize: 2,
        },
        expect.objectContaining({ operation: 'test-get-study' }),
      );
      expect(result.studies).toHaveLength(2);
      expect(result.errors).toBeUndefined();
    });

    it('returns partial results when one study is missing from batch response', async () => {
      const study1 = buildMockStudy();
      // Only study1 returned; NCT00000000 is missing from batch
      mockListStudies.mockResolvedValueOnce({
        studies: [study1],
        totalCount: 1,
      });

      const result = await getStudyTool.logic(
        { nctIds: ['NCT12345678', 'NCT00000000'], summaryOnly: false },
        createAppContext(),
        sdkContext,
      );

      expect(result.studies).toHaveLength(1);
      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]!.nctId).toBe('NCT00000000');
      expect(result.errors![0]!.error).toBe(
        'Study not found in batch response',
      );
    });

    it('throws McpError ServiceUnavailable when ALL studies are missing from batch', async () => {
      // Batch returns no studies at all
      mockListStudies.mockResolvedValueOnce({
        studies: [],
        totalCount: 0,
      });

      await expect(
        getStudyTool.logic(
          { nctIds: ['NCT11111111', 'NCT22222222'], summaryOnly: false },
          createAppContext(),
          sdkContext,
        ),
      ).rejects.toThrow(McpError);

      mockListStudies.mockResolvedValueOnce({
        studies: [],
        totalCount: 0,
      });

      try {
        await getStudyTool.logic(
          { nctIds: ['NCT11111111', 'NCT22222222'], summaryOnly: false },
          createAppContext(),
          sdkContext,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(
          JsonRpcErrorCode.ServiceUnavailable,
        );
        expect((err as McpError).message).toContain(
          'Failed to fetch any studies',
        );
        expect((err as McpError).data).toHaveProperty('errors');
      }
    });

    it('preserves input order in results', async () => {
      const study1 = buildMockStudy();
      const study2 = buildMockStudy2();
      // Return in reverse order from API
      mockListStudies.mockResolvedValueOnce({
        studies: [study2, study1],
        totalCount: 2,
      });

      const result = await getStudyTool.logic(
        { nctIds: ['NCT12345678', 'NCT87654321'], summaryOnly: false },
        createAppContext(),
        sdkContext,
      );

      expect(result.studies).toHaveLength(2);
      // Should be reordered to match input
      expect(
        (
          result.studies[0] as Record<string, unknown> & {
            protocolSection: { identificationModule: { nctId: string } };
          }
        ).protocolSection.identificationModule.nctId,
      ).toBe('NCT12345678');
      expect(
        (
          result.studies[1] as Record<string, unknown> & {
            protocolSection: { identificationModule: { nctId: string } };
          }
        ).protocolSection.identificationModule.nctId,
      ).toBe('NCT87654321');
    });
  });

  // =========================================================================
  // Logic — Summary Extraction
  // =========================================================================

  describe('Logic — summary extraction', () => {
    it('extracts all expected summary fields', async () => {
      mockFetchStudy.mockResolvedValueOnce(buildMockStudy());

      const result = await getStudyTool.logic(
        { nctIds: 'NCT12345678', summaryOnly: true },
        createAppContext(),
        sdkContext,
      );

      const summary = result.studies[0] as Record<string, unknown>;
      expect(summary).toEqual({
        nctId: 'NCT12345678',
        title: 'Official Test Study Title',
        briefSummary: 'This is a test study summary.',
        overallStatus: 'Recruiting',
        conditions: ['Diabetes', 'Hypertension'],
        interventions: [{ name: 'Drug A', type: 'Drug' }],
        leadSponsor: 'Test Sponsor',
      });
    });

    it('handles missing optional fields gracefully (sparse study)', async () => {
      const sparseStudy = {
        protocolSection: {
          identificationModule: {
            nctId: 'NCT99999999',
          },
          // No other modules
        },
      };
      mockFetchStudy.mockResolvedValueOnce(sparseStudy);

      const result = await getStudyTool.logic(
        { nctIds: 'NCT99999999', summaryOnly: true },
        createAppContext(),
        sdkContext,
      );

      const summary = result.studies[0] as Record<string, unknown>;
      expect(summary.nctId).toBe('NCT99999999');
      expect(summary.title).toBeUndefined();
      expect(summary.briefSummary).toBeUndefined();
      expect(summary.overallStatus).toBeUndefined();
      expect(summary.conditions).toBeUndefined();
      expect(summary.interventions).toBeUndefined();
      expect(summary.leadSponsor).toBeUndefined();
    });

    it('handles study with empty interventions array', async () => {
      const studyNoInterventions = buildMockStudy();
      studyNoInterventions.protocolSection.armsInterventionsModule = {
        interventions: [],
      };
      mockFetchStudy.mockResolvedValueOnce(studyNoInterventions);

      const result = await getStudyTool.logic(
        { nctIds: 'NCT12345678', summaryOnly: true },
        createAppContext(),
        sdkContext,
      );

      const summary = result.studies[0] as Record<string, unknown>;
      expect(summary.interventions).toEqual([]);
    });

    it('maps multiple interventions correctly', async () => {
      const study = buildMockStudy();
      study.protocolSection.armsInterventionsModule = {
        interventions: [
          { name: 'Drug A', type: 'Drug', description: 'First' },
          { name: 'Procedure B', type: 'Procedure', description: 'Second' },
          { name: 'Device C', type: 'Device', description: 'Third' },
        ],
      };
      mockFetchStudy.mockResolvedValueOnce(study);

      const result = await getStudyTool.logic(
        { nctIds: 'NCT12345678', summaryOnly: true },
        createAppContext(),
        sdkContext,
      );

      const summary = result.studies[0] as Record<string, unknown>;
      expect(summary.interventions).toEqual([
        { name: 'Drug A', type: 'Drug' },
        { name: 'Procedure B', type: 'Procedure' },
        { name: 'Device C', type: 'Device' },
      ]);
    });
  });

  // =========================================================================
  // Response Formatter
  // =========================================================================

  describe('Response Formatter', () => {
    it('returns a single text content block with study JSON for single study (no errors)', () => {
      const study = { nctId: 'NCT12345678' };
      const data = {
        studies: [study],
      };

      const blocks = getStudyTool.responseFormatter!(data as never);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe('text');
      // Single study format: just the study itself, not the wrapper
      expect((blocks[0] as { text: string }).text).toBe(
        JSON.stringify(study, null, 2),
      );
    });

    it('returns a single markdown summary block for multi-study results', () => {
      const data = {
        studies: [buildMockStudy(), buildMockStudy2()],
      };

      const blocks = getStudyTool.responseFormatter!(data as never);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe('text');

      const markdown = (blocks[0] as { text: string }).text;
      expect(markdown).toContain('# 2 Studies Retrieved');
    });

    it('returns a single markdown block with errors when single study has errors', () => {
      const data = {
        studies: [{ nctId: 'NCT12345678' }],
        errors: [{ nctId: 'NCT00000000', error: 'Not found' }],
      };

      const blocks = getStudyTool.responseFormatter!(data as never);

      expect(blocks).toHaveLength(1);
      const markdown = (blocks[0] as { text: string }).text;
      expect(markdown).toContain('Errors');
      expect(markdown).toContain('NCT00000000');
    });

    it('produces valid JSON in single-study block that can be parsed back', () => {
      const study = buildMockStudy();
      const data = { studies: [study] };

      const blocks = getStudyTool.responseFormatter!(data as never);
      const text = (blocks[0] as { text: string }).text;

      expect(() => JSON.parse(text)).not.toThrow();
      const parsed = JSON.parse(text);
      expect(parsed.protocolSection.identificationModule.nctId).toBe(
        'NCT12345678',
      );
    });
  });
});
