/**
 * @fileoverview Tests for the clinicaltrials_compare_studies tool definition.
 * Validates metadata, input schema, logic (including partial failures and
 * field extraction), summary analysis, and response formatting.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-compare-studies.tool
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchStudy = vi.fn();

vi.mock('@/container/index.js', () => ({
  container: {
    resolve: vi.fn(() => ({
      fetchStudy: mockFetchStudy,
    })),
  },
}));

vi.mock('@/container/core/tokens.js', () => ({
  ClinicalTrialsProvider: Symbol('IClinicalTrialsProvider'),
}));

vi.mock('@/mcp-server/transports/auth/lib/withAuth.js', () => ({
  withToolAuth: (_scopes: string[], fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@/utils/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
  generateRequestContextId: vi.fn(() => 'test-ctx-id'),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { compareStudiesTool } from '@/mcp-server/tools/definitions/clinicaltrials-compare-studies.tool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAppContext() {
  return {
    requestId: 'test-request-id',
    timestamp: new Date().toISOString(),
    operation: 'test-compare-studies',
  };
}

const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
};

function makeStudy(nctId: string, overrides: Record<string, unknown> = {}) {
  return {
    protocolSection: {
      identificationModule: {
        nctId,
        briefTitle: `Study ${nctId}`,
        officialTitle: `Official ${nctId}`,
      },
      statusModule: {
        overallStatus: 'Recruiting',
        startDateStruct: { date: '2023-01-15' },
        completionDateStruct: { date: '2025-12-31' },
        lastUpdatePostDateStruct: { date: '2024-06-01' },
      },
      eligibilityModule: {
        eligibilityCriteria: 'Inclusion criteria: Adults aged 18-65',
        sex: 'All',
        minimumAge: '18 Years',
        healthyVolunteers: false,
        stdAges: ['ADULT', 'OLDER_ADULT'],
      },
      designModule: {
        studyType: 'INTERVENTIONAL',
        phases: ['PHASE3'],
        designInfo: {
          allocation: 'RANDOMIZED',
          interventionModel: 'PARALLEL',
          primaryPurpose: 'TREATMENT',
          maskingInfo: { masking: 'DOUBLE' },
        },
      },
      armsInterventionsModule: {
        interventions: [
          {
            type: 'Drug',
            name: 'Test Drug',
            description: 'A test drug description',
          },
        ],
      },
      outcomesModule: {
        primaryOutcomes: [
          { measure: 'Primary endpoint', timeFrame: '12 weeks' },
        ],
        secondaryOutcomes: [
          { measure: 'Secondary endpoint', timeFrame: '24 weeks' },
        ],
      },
      sponsorCollaboratorsModule: {
        leadSponsor: { name: 'Pharma Corp', class: 'INDUSTRY' },
        collaborators: [{ name: 'University Hospital', class: 'OTHER' }],
      },
      contactsLocationsModule: {
        locations: [
          { city: 'New York', country: 'United States' },
          { city: 'Boston', country: 'United States' },
          { city: 'Toronto', country: 'Canada' },
        ],
      },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clinicaltrials_compare_studies tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // Metadata
  // ========================================================================

  describe('metadata', () => {
    it('should have the correct tool name', () => {
      expect(compareStudiesTool.name).toBe('clinicaltrials_compare_studies');
    });

    it('should have a title', () => {
      expect(compareStudiesTool.title).toBe('Compare Clinical Studies');
    });

    it('should have a description', () => {
      expect(compareStudiesTool.description).toContain(
        'side-by-side comparison',
      );
    });

    it('should have correct annotations', () => {
      expect(compareStudiesTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    });

    it('should have a logic function', () => {
      expect(typeof compareStudiesTool.logic).toBe('function');
    });

    it('should have a responseFormatter function', () => {
      expect(typeof compareStudiesTool.responseFormatter).toBe('function');
    });
  });

  // ========================================================================
  // Input Schema
  // ========================================================================

  describe('inputSchema', () => {
    const schema = compareStudiesTool.inputSchema;

    it('should accept 2 valid NCT IDs', () => {
      const result = schema.safeParse({
        nctIds: ['NCT12345678', 'NCT87654321'],
      });
      expect(result.success).toBe(true);
    });

    it('should accept 5 valid NCT IDs', () => {
      const result = schema.safeParse({
        nctIds: [
          'NCT00000001',
          'NCT00000002',
          'NCT00000003',
          'NCT00000004',
          'NCT00000005',
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should reject 1 NCT ID (min 2)', () => {
      const result = schema.safeParse({ nctIds: ['NCT12345678'] });
      expect(result.success).toBe(false);
    });

    it('should reject 6 NCT IDs (max 5)', () => {
      const result = schema.safeParse({
        nctIds: [
          'NCT00000001',
          'NCT00000002',
          'NCT00000003',
          'NCT00000004',
          'NCT00000005',
          'NCT00000006',
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid NCT format', () => {
      const result = schema.safeParse({
        nctIds: ['NCT12345678', 'INVALID'],
      });
      expect(result.success).toBe(false);
    });

    it('should reject NCT ID with wrong digit count', () => {
      const result = schema.safeParse({
        nctIds: ['NCT12345678', 'NCT1234567'],
      });
      expect(result.success).toBe(false);
    });

    it('should accept lowercase nct prefix', () => {
      const result = schema.safeParse({
        nctIds: ['nct12345678', 'Nct87654321'],
      });
      expect(result.success).toBe(true);
    });

    it('should default compareFields to "all"', () => {
      const result = schema.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
      });
      expect(result.compareFields).toBe('all');
    });

    it('should accept a single compareFields string', () => {
      const result = schema.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
        compareFields: 'design',
      });
      expect(result.compareFields).toBe('design');
    });

    it('should accept an array of compareFields', () => {
      const result = schema.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
        compareFields: ['status', 'design'],
      });
      expect(result.compareFields).toEqual(['status', 'design']);
    });

    it('should reject invalid compareFields value', () => {
      const result = schema.safeParse({
        nctIds: ['NCT12345678', 'NCT87654321'],
        compareFields: 'invalid_field',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty array of compareFields', () => {
      const result = schema.safeParse({
        nctIds: ['NCT12345678', 'NCT87654321'],
        compareFields: [],
      });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // Logic — Successful Comparison
  // ========================================================================

  describe('logic — successful comparison', () => {
    it('should compare two studies with all fields', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'all' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons).toHaveLength(2);
      expect(result.comparisons[0]!.nctId).toBe('NCT00000001');
      expect(result.comparisons[1]!.nctId).toBe('NCT00000002');
      expect(result.summary.totalStudies).toBe(2);
      expect(result.errors).toBeUndefined();
    });

    it('should include all field categories when compareFields is "all"', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'all' },
        makeAppContext(),
        mockSdkContext,
      );

      const comp = result.comparisons[0]!;
      expect(comp.eligibility).toBeDefined();
      expect(comp.design).toBeDefined();
      expect(comp.interventions).toBeDefined();
      expect(comp.outcomes).toBeDefined();
      expect(comp.sponsors).toBeDefined();
      expect(comp.locations).toBeDefined();
      expect(comp.status).toBeDefined();
    });

    it('should only include requested fields when specific fields are given', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000002'],
          compareFields: ['status', 'design'],
        },
        makeAppContext(),
        mockSdkContext,
      );

      const comp = result.comparisons[0]!;
      expect(comp.status).toBeDefined();
      expect(comp.design).toBeDefined();
      expect(comp.eligibility).toBeUndefined();
      expect(comp.interventions).toBeUndefined();
      expect(comp.outcomes).toBeUndefined();
      expect(comp.sponsors).toBeUndefined();
      expect(comp.locations).toBeUndefined();
    });

    it('should normalize a single compareFields string to an array internally', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000002'],
          compareFields: 'eligibility',
        },
        makeAppContext(),
        mockSdkContext,
      );

      const comp = result.comparisons[0]!;
      expect(comp.eligibility).toBeDefined();
      expect(comp.design).toBeUndefined();
      expect(result.summary.comparedFields).toEqual(['eligibility']);
    });

    it('should use officialTitle if available', async () => {
      const study = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy.mockResolvedValueOnce(study).mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'status' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.title).toBe('Official NCT00000001');
    });

    it('should fall back to briefTitle when officialTitle is missing', async () => {
      const study1 = makeStudy('NCT00000001', {
        identificationModule: {
          nctId: 'NCT00000001',
          briefTitle: 'Brief Title',
          // no officialTitle
        },
      });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'status' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.title).toBe('Brief Title');
    });
  });

  // ========================================================================
  // Logic — Partial Failures
  // ========================================================================

  describe('logic — partial failures', () => {
    it('should succeed with errors when 1 of 3 studies fails', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockRejectedValueOnce(
          new McpError(JsonRpcErrorCode.NotFound, 'Study not found'),
        )
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000003', 'NCT00000002'],
          compareFields: 'all',
        },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]!.nctId).toBe('NCT00000003');
      expect(result.errors![0]!.error).toBe('Study not found');
    });

    it('should throw when 2 of 3 studies fail (only 1 success < 2 minimum)', async () => {
      const study1 = makeStudy('NCT00000001');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'));

      await expect(
        compareStudiesTool.logic(
          {
            nctIds: ['NCT00000001', 'NCT00000002', 'NCT00000003'],
            compareFields: 'all',
          },
          makeAppContext(),
          mockSdkContext,
        ),
      ).rejects.toThrow(McpError);
    });

    it('should throw McpError with ValidationError code when insufficient studies', async () => {
      mockFetchStudy
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'));

      try {
        await compareStudiesTool.logic(
          { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'all' },
          makeAppContext(),
          mockSdkContext,
        );
        expect.fail('Expected McpError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        expect((err as McpError).message).toContain('Insufficient studies');
      }
    });

    it('should use "An unexpected error occurred" for non-McpError failures', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockRejectedValueOnce(new TypeError('network error'))
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000003', 'NCT00000002'],
          compareFields: 'all',
        },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.errors![0]!.error).toBe('An unexpected error occurred');
    });
  });

  // ========================================================================
  // Logic — Data Extraction
  // ========================================================================

  describe('logic — data extraction', () => {
    it('should extract eligibility data correctly', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000002'],
          compareFields: 'eligibility',
        },
        makeAppContext(),
        mockSdkContext,
      );

      const elig = result.comparisons[0]!.eligibility;
      expect(elig).toEqual({
        criteria: 'Inclusion criteria: Adults aged 18-65',
        sex: 'All',
        minimumAge: '18 Years',
        healthyVolunteers: false,
        stdAges: ['ADULT', 'OLDER_ADULT'],
      });
    });

    it('should return undefined eligibility when module is missing', async () => {
      const study1 = makeStudy('NCT00000001', { eligibilityModule: undefined });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000002'],
          compareFields: 'eligibility',
        },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.eligibility).toBeUndefined();
    });

    it('should extract design data correctly', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'design' },
        makeAppContext(),
        mockSdkContext,
      );

      const design = result.comparisons[0]!.design;
      expect(design).toEqual({
        studyType: 'INTERVENTIONAL',
        phases: ['PHASE3'],
        allocation: 'RANDOMIZED',
        interventionModel: 'PARALLEL',
        primaryPurpose: 'TREATMENT',
        masking: 'DOUBLE',
      });
    });

    it('should return undefined design when module is missing', async () => {
      const study1 = makeStudy('NCT00000001', { designModule: undefined });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'design' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.design).toBeUndefined();
    });

    it('should extract interventions correctly', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000002'],
          compareFields: 'interventions',
        },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.interventions).toEqual([
        {
          type: 'Drug',
          name: 'Test Drug',
          description: 'A test drug description',
        },
      ]);
    });

    it('should return undefined interventions when module is missing', async () => {
      const study1 = makeStudy('NCT00000001', {
        armsInterventionsModule: undefined,
      });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        {
          nctIds: ['NCT00000001', 'NCT00000002'],
          compareFields: 'interventions',
        },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.interventions).toBeUndefined();
    });

    it('should extract outcomes correctly', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'outcomes' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.outcomes).toEqual({
        primary: [{ measure: 'Primary endpoint', timeFrame: '12 weeks' }],
        secondary: [{ measure: 'Secondary endpoint', timeFrame: '24 weeks' }],
      });
    });

    it('should return undefined outcomes when module is missing', async () => {
      const study1 = makeStudy('NCT00000001', { outcomesModule: undefined });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'outcomes' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.outcomes).toBeUndefined();
    });

    it('should extract sponsors correctly', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'sponsors' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.sponsors).toEqual({
        leadSponsor: { name: 'Pharma Corp', class: 'INDUSTRY' },
        collaborators: [{ name: 'University Hospital', class: 'OTHER' }],
      });
    });

    it('should return undefined sponsors when module is missing', async () => {
      const study1 = makeStudy('NCT00000001', {
        sponsorCollaboratorsModule: undefined,
      });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'sponsors' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.sponsors).toBeUndefined();
    });

    it('should extract locations with unique countries and top cities', async () => {
      const study1 = makeStudy('NCT00000001', {
        contactsLocationsModule: {
          locations: [
            { city: 'New York', country: 'United States' },
            { city: 'New York', country: 'United States' },
            { city: 'Boston', country: 'United States' },
            { city: 'Toronto', country: 'Canada' },
            { city: 'London', country: 'United Kingdom' },
            { city: 'Paris', country: 'France' },
            { city: 'Berlin', country: 'Germany' },
            { city: 'Berlin', country: 'Germany' },
          ],
        },
      });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'locations' },
        makeAppContext(),
        mockSdkContext,
      );

      const loc = result.comparisons[0]!.locations!;
      expect(loc.totalCount).toBe(8);
      expect(loc.countries).toEqual([
        'United States',
        'Canada',
        'United Kingdom',
        'France',
        'Germany',
      ]);
      // Top 5 cities sorted by count descending: New York (2), Berlin (2), then Boston, Toronto, London, Paris (1 each)
      expect(loc.topCities).toHaveLength(5);
      expect(loc.topCities![0]).toBe('New York');
      expect(loc.topCities![1]).toBe('Berlin');
    });

    it('should return undefined locations when no locations exist', async () => {
      const study1 = makeStudy('NCT00000001', {
        contactsLocationsModule: { locations: [] },
      });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'locations' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.locations).toBeUndefined();
    });

    it('should return undefined locations when module is missing', async () => {
      const study1 = makeStudy('NCT00000001', {
        contactsLocationsModule: undefined,
      });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'locations' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.locations).toBeUndefined();
    });

    it('should extract status data correctly', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'status' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.status).toEqual({
        overallStatus: 'Recruiting',
        startDate: '2023-01-15',
        completionDate: '2025-12-31',
        lastUpdateDate: '2024-06-01',
      });
    });

    it('should return undefined status when module is missing', async () => {
      const study1 = makeStudy('NCT00000001', { statusModule: undefined });
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'status' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.comparisons[0]!.status).toBeUndefined();
    });
  });

  // ========================================================================
  // Logic — Summary
  // ========================================================================

  describe('logic — summary', () => {
    it('should return totalStudies and comparedFields in summary', async () => {
      const study1 = makeStudy('NCT00000001');
      const study2 = makeStudy('NCT00000002');
      mockFetchStudy
        .mockResolvedValueOnce(study1)
        .mockResolvedValueOnce(study2);

      const result = await compareStudiesTool.logic(
        { nctIds: ['NCT00000001', 'NCT00000002'], compareFields: 'all' },
        makeAppContext(),
        mockSdkContext,
      );

      expect(result.summary.totalStudies).toBe(2);
      expect(result.summary.comparedFields).toContain('all');
    });
  });

  // ========================================================================
  // Response Formatter
  // ========================================================================

  describe('responseFormatter', () => {
    it('should return a single text content block', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            status: { overallStatus: 'Recruiting' },
          },
          {
            nctId: 'NCT00000002',
            title: 'Study B',
            status: { overallStatus: 'Completed' },
          },
        ],
        summary: {
          totalStudies: 2,
          comparedFields: ['all'],
          commonalities: ['All studies are in phase: PHASE3'],
          differences: ['Different statuses: Recruiting, Completed'],
        },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe('text');
    });

    it('should include comparison header', () => {
      const output = {
        comparisons: [
          { nctId: 'NCT00000001', title: 'Study A' },
          { nctId: 'NCT00000002', title: 'Study B' },
        ],
        summary: {
          totalStudies: 2,
          comparedFields: ['all'],
        },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('# Comparison of 2 Clinical Trials');
    });

    it('should list study titles', () => {
      const output = {
        comparisons: [
          { nctId: 'NCT00000001', title: 'Study A' },
          { nctId: 'NCT00000002', title: 'Study B' },
        ],
        summary: { totalStudies: 2, comparedFields: ['all'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**NCT00000001**: Study A');
      expect(text).toContain('**NCT00000002**: Study B');
    });

    it('should display "No title" when title is missing', () => {
      const output = {
        comparisons: [
          { nctId: 'NCT00000001' },
          { nctId: 'NCT00000002', title: 'Study B' },
        ],
        summary: { totalStudies: 2, comparedFields: ['all'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**NCT00000001**: No title');
    });

    it('should include errors section when present', () => {
      const output = {
        comparisons: [
          { nctId: 'NCT00000001', title: 'A' },
          { nctId: 'NCT00000002', title: 'B' },
        ],
        summary: { totalStudies: 2, comparedFields: ['all'] },
        errors: [{ nctId: 'NCT00000003', error: 'Not found' }],
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('## Errors');
      expect(text).toContain('**NCT00000003**: Not found');
    });

    it('should render detailed status section', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            status: {
              overallStatus: 'Recruiting',
              startDate: '2023-01-15',
              completionDate: '2025-12-31',
            },
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['status'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Status:**');
      expect(text).toContain('Overall Status: Recruiting');
      expect(text).toContain('Start Date: 2023-01-15');
      expect(text).toContain('Completion Date: 2025-12-31');
    });

    it('should render detailed design section', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            design: {
              studyType: 'INTERVENTIONAL',
              phases: ['PHASE3'],
              allocation: 'RANDOMIZED',
              interventionModel: 'PARALLEL',
              primaryPurpose: 'TREATMENT',
              masking: 'DOUBLE',
            },
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['design'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Design:**');
      expect(text).toContain('Study Type: INTERVENTIONAL');
      expect(text).toContain('Phases: PHASE3');
      expect(text).toContain('Masking: DOUBLE');
    });

    it('should truncate eligibility criteria to 200 chars', () => {
      const longCriteria = 'A'.repeat(300);
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            eligibility: {
              criteria: longCriteria,
              sex: 'All',
            },
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['eligibility'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('A'.repeat(200) + '...');
      expect(text).not.toContain('A'.repeat(201));
    });

    it('should not add ellipsis when criteria is within 200 chars', () => {
      const shortCriteria = 'Short criteria text';
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            eligibility: {
              criteria: shortCriteria,
              sex: 'All',
            },
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['eligibility'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Criteria: Short criteria text');
      expect(text).not.toContain('...');
    });

    it('should truncate intervention descriptions to 150 chars', () => {
      const longDesc = 'B'.repeat(200);
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            interventions: [
              { type: 'Drug', name: 'TestDrug', description: longDesc },
            ],
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['interventions'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('B'.repeat(150) + '...');
    });

    it('should limit secondary outcomes to 3 with overflow message', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            outcomes: {
              secondary: [
                { measure: 'Sec1' },
                { measure: 'Sec2' },
                { measure: 'Sec3' },
                { measure: 'Sec4' },
                { measure: 'Sec5' },
              ],
            },
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['outcomes'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Sec1');
      expect(text).toContain('Sec2');
      expect(text).toContain('Sec3');
      expect(text).not.toContain('Sec4');
      expect(text).toContain('...and 2 more');
    });

    it('should render sponsor and collaborator details', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            sponsors: {
              leadSponsor: { name: 'Pharma Corp', class: 'INDUSTRY' },
              collaborators: [
                { name: 'Uni Hospital' },
                { name: 'Research Lab' },
              ],
            },
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['sponsors'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Sponsors:**');
      expect(text).toContain('Lead: Pharma Corp (INDUSTRY)');
      expect(text).toContain('Collaborators: 2');
      expect(text).toContain('Uni Hospital');
      expect(text).toContain('Research Lab');
    });

    it('should render location details', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            locations: {
              totalCount: 5,
              countries: ['United States', 'Canada'],
              topCities: ['New York', 'Boston'],
            },
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['locations'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Locations:**');
      expect(text).toContain('Total: 5');
      expect(text).toContain('Countries: United States, Canada');
      expect(text).toContain('Top Cities: New York, Boston');
    });

    it('should render N/A for missing optional status fields', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            status: {},
          },
        ],
        summary: { totalStudies: 1, comparedFields: ['status'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Overall Status: N/A');
      expect(text).toContain('Start Date: N/A');
      expect(text).toContain('Completion Date: N/A');
    });

    it('should include separator between multiple study details', () => {
      const output = {
        comparisons: [
          {
            nctId: 'NCT00000001',
            title: 'Study A',
            status: { overallStatus: 'Recruiting' },
          },
          {
            nctId: 'NCT00000002',
            title: 'Study B',
            status: { overallStatus: 'Completed' },
          },
        ],
        summary: { totalStudies: 2, comparedFields: ['status'] },
      };

      const blocks = compareStudiesTool.responseFormatter!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // The separator appears between studies (not before the first)
      const detailSection = text.split('## Detailed Comparison')[1];
      expect(detailSection).toContain('---');
    });
  });
});
