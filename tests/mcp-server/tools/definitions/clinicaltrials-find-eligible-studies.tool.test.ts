/**
 * @fileoverview Tests for the clinicaltrials_find_eligible_studies tool definition.
 * Validates metadata, input schema parsing, business logic (search, filtering, ranking),
 * and response formatting.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-find-eligible-studies.tool
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────

const mockListStudies = vi.fn();
const mockCheckAgeEligibility = vi.fn();
const mockCheckSexEligibility = vi.fn();
const mockCheckHealthyVolunteerEligibility = vi.fn();
const mockCalculateMatchScore = vi.fn();
const mockCalculateConditionRelevance = vi.fn();
const mockRankStudies = vi.fn();
const mockExtractRelevantLocations = vi.fn();
const mockExtractContactInfo = vi.fn();
const mockExtractStudyDetails = vi.fn();

vi.mock('@/container/index.js', () => ({
  container: {
    resolve: vi.fn(() => ({
      listStudies: mockListStudies,
    })),
  },
}));

vi.mock('@/container/core/tokens.js', () => ({
  ClinicalTrialsProvider: Symbol('ClinicalTrialsProvider'),
}));

vi.mock('@/mcp-server/transports/auth/lib/withAuth.js', () => ({
  withToolAuth: (_scopes: string[], fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@/mcp-server/tools/utils/ageParser.js', () => ({
  checkAgeEligibility: (...args: unknown[]) => mockCheckAgeEligibility(...args),
}));

vi.mock('@/mcp-server/tools/utils/eligibilityCheckers.js', () => ({
  checkSexEligibility: (...args: unknown[]) => mockCheckSexEligibility(...args),
  checkHealthyVolunteerEligibility: (...args: unknown[]) =>
    mockCheckHealthyVolunteerEligibility(...args),
}));

vi.mock('@/mcp-server/tools/utils/studyRanking.js', () => ({
  calculateMatchScore: (...args: unknown[]) => mockCalculateMatchScore(...args),
  calculateConditionRelevance: (...args: unknown[]) =>
    mockCalculateConditionRelevance(...args),
  rankStudies: (...args: unknown[]) => mockRankStudies(...args),
}));

vi.mock('@/mcp-server/tools/utils/studyExtractors.js', () => ({
  extractRelevantLocations: (...args: unknown[]) =>
    mockExtractRelevantLocations(...args),
  extractContactInfo: (...args: unknown[]) => mockExtractContactInfo(...args),
  extractStudyDetails: (...args: unknown[]) => mockExtractStudyDetails(...args),
}));

vi.mock('@/utils/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    notice: vi.fn(),
  },
}));

// ── Import after mocks ──────────────────────────────────────────────

import { findEligibleStudiesTool } from '@/mcp-server/tools/definitions/clinicaltrials-find-eligible-studies.tool.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeStudy(nctId: string, overrides?: Record<string, unknown>) {
  return {
    protocolSection: {
      identificationModule: { nctId, briefTitle: `Study ${nctId}` },
      statusModule: { overallStatus: 'Recruiting' },
      descriptionModule: { briefSummary: `Summary for ${nctId}` },
      conditionsModule: {
        conditions: ['Type 2 Diabetes Mellitus'],
      },
      eligibilityModule: {
        minimumAge: '18 Years',
        maximumAge: '65 Years',
        sex: 'All',
        healthyVolunteers: false,
        eligibilityCriteria: 'Inclusion: age 18-65. Exclusion: pregnant women.',
      },
      contactsLocationsModule: {
        locations: [
          {
            facility: 'Test Hospital',
            city: 'Seattle',
            state: 'WA',
            country: 'United States',
          },
        ],
        centralContacts: [
          { name: 'Dr. Test', phone: '555-1234', email: 'test@test.com' },
        ],
      },
      designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 200 } },
      sponsorCollaboratorsModule: { leadSponsor: { name: 'Test Sponsor' } },
      ...overrides,
    },
  };
}

const baseInput = {
  age: 45,
  sex: 'Male' as const,
  conditions: ['Type 2 Diabetes'],
  location: { country: 'United States', state: 'Washington', city: 'Seattle' },
  healthyVolunteer: false,
  maxResults: 10,
  recruitingOnly: true,
};

/** Minimal RequestContext-shaped object for tests. */
const appContext = {
  requestId: 'test-request-id',
  operation: 'test-find-eligible',
  timestamp: '2026-02-26T00:00:00.000Z',
};

const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
};

/** Safely extract the text string from the first content block. */
function extractText(blocks: Array<{ type: string; text?: string }>): string {
  return (blocks[0] as { type: 'text'; text: string }).text;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('findEligibleStudiesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
    mockCheckAgeEligibility.mockReturnValue({
      eligible: true,
      reason: 'Age within range (18-65)',
    });
    mockCheckSexEligibility.mockReturnValue({
      eligible: true,
      reason: 'Study accepts all sexes',
    });
    mockCheckHealthyVolunteerEligibility.mockReturnValue({
      eligible: true,
      reason: 'Eligibility status matches study requirements',
    });
    mockCalculateConditionRelevance.mockReturnValue(0.8);
    mockCalculateMatchScore.mockReturnValue(75);
    mockRankStudies.mockImplementation((studies: unknown[]) => studies);
    mockExtractRelevantLocations.mockReturnValue([
      {
        facility: 'Test Hospital',
        city: 'Seattle',
        state: 'WA',
        country: 'United States',
      },
    ]);
    mockExtractContactInfo.mockReturnValue({
      name: 'Dr. Test',
      phone: '555-1234',
      email: 'test@test.com',
    });
    mockExtractStudyDetails.mockReturnValue({
      phase: ['PHASE3'],
      status: 'Recruiting',
      enrollmentCount: 200,
      sponsor: 'Test Sponsor',
    });

    mockListStudies.mockResolvedValue({
      studies: [makeStudy('NCT00000001')],
      totalCount: 1,
    });
  });

  // ── Metadata ──────────────────────────────────────────────────

  describe('metadata', () => {
    it('should have the correct tool name', () => {
      expect(findEligibleStudiesTool.name).toBe(
        'clinicaltrials_find_eligible_studies',
      );
    });

    it('should have a human-readable title', () => {
      expect(findEligibleStudiesTool.title).toBe(
        'Find Eligible Clinical Trials',
      );
    });

    it('should have a descriptive LLM-facing description', () => {
      expect(findEligibleStudiesTool.description).toContain(
        'patient demographics',
      );
      expect(findEligibleStudiesTool.description).toContain(
        'eligible clinical trials',
      );
    });

    it('should have correct annotations', () => {
      expect(findEligibleStudiesTool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    });

    it('should have inputSchema, outputSchema, logic, and responseFormatter', () => {
      expect(findEligibleStudiesTool.inputSchema).toBeDefined();
      expect(findEligibleStudiesTool.outputSchema).toBeDefined();
      expect(typeof findEligibleStudiesTool.logic).toBe('function');
      expect(typeof findEligibleStudiesTool.responseFormatter).toBe('function');
    });
  });

  // ── Input Schema ──────────────────────────────────────────────

  describe('inputSchema', () => {
    const schema = findEligibleStudiesTool.inputSchema;

    it('should parse valid complete input', () => {
      const result = schema.parse(baseInput);
      expect(result.age).toBe(45);
      expect(result.sex).toBe('Male');
      expect(result.conditions).toEqual(['Type 2 Diabetes']);
      expect(result.location.country).toBe('United States');
      expect(result.healthyVolunteer).toBe(false);
      expect(result.maxResults).toBe(10);
      expect(result.recruitingOnly).toBe(true);
    });

    it('should apply default values', () => {
      const minimal = {
        age: 30,
        sex: 'Female',
        conditions: ['Asthma'],
        location: { country: 'Canada' },
      };
      const result = schema.parse(minimal);
      expect(result.healthyVolunteer).toBe(false);
      expect(result.maxResults).toBe(10);
      expect(result.recruitingOnly).toBe(true);
    });

    it('should accept optional location fields', () => {
      const result = schema.parse({
        age: 25,
        sex: 'All',
        conditions: ['Depression'],
        location: {
          country: 'United Kingdom',
          state: 'England',
          city: 'London',
          postalCode: 'SW1',
        },
      });
      expect(result.location.state).toBe('England');
      expect(result.location.city).toBe('London');
      expect(result.location.postalCode).toBe('SW1');
    });

    it('should reject negative age', () => {
      expect(() => schema.parse({ ...baseInput, age: -1 })).toThrow();
    });

    it('should reject age above 120', () => {
      expect(() => schema.parse({ ...baseInput, age: 121 })).toThrow();
    });

    it('should reject non-integer age', () => {
      expect(() => schema.parse({ ...baseInput, age: 45.5 })).toThrow();
    });

    it('should reject invalid sex value', () => {
      expect(() => schema.parse({ ...baseInput, sex: 'Other' })).toThrow();
    });

    it('should reject empty conditions array', () => {
      expect(() => schema.parse({ ...baseInput, conditions: [] })).toThrow();
    });

    it('should reject missing location.country', () => {
      expect(() =>
        schema.parse({ ...baseInput, location: { state: 'WA' } }),
      ).toThrow();
    });

    it('should reject maxResults below 1', () => {
      expect(() => schema.parse({ ...baseInput, maxResults: 0 })).toThrow();
    });

    it('should reject maxResults above 50', () => {
      expect(() => schema.parse({ ...baseInput, maxResults: 51 })).toThrow();
    });

    it('should accept boundary age values (0 and 120)', () => {
      expect(schema.parse({ ...baseInput, age: 0 }).age).toBe(0);
      expect(schema.parse({ ...baseInput, age: 120 }).age).toBe(120);
    });

    it('should accept all valid sex enum values', () => {
      for (const sex of ['All', 'Female', 'Male'] as const) {
        expect(schema.parse({ ...baseInput, sex }).sex).toBe(sex);
      }
    });
  });

  // ── Logic: Search Behavior ────────────────────────────────────

  describe('logic — search behavior', () => {
    it('should join conditions with OR for the conditionQuery', async () => {
      const input = { ...baseInput, conditions: ['Diabetes', 'Hypertension'] };
      await findEligibleStudiesTool.logic(
        input,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockListStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          conditionQuery: 'Diabetes OR Hypertension',
        }),
        expect.anything(),
      );
    });

    it('should quote a single multi-word condition in the conditionQuery', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockListStudies).toHaveBeenCalledWith(
        expect.objectContaining({ conditionQuery: '"Type 2 Diabetes"' }),
        expect.anything(),
      );
    });

    it('should set recruiting filter when recruitingOnly is true', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockListStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: 'STATUS:Recruiting OR STATUS:"Not yet recruiting"',
        }),
        expect.anything(),
      );
    });

    it('should not include filter when recruitingOnly is false', async () => {
      const input = { ...baseInput, recruitingOnly: false };
      await findEligibleStudiesTool.logic(
        input,
        appContext as never,
        mockSdkContext as never,
      );

      const callArgs = mockListStudies.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(callArgs).not.toHaveProperty('filter');
    });

    it('should request pageSize 100 for initial search', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockListStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 100 }),
        expect.anything(),
      );
    });
  });

  // ── Logic: Eligibility Filtering ──────────────────────────────

  describe('logic — eligibility filtering', () => {
    it('should include study that passes all eligibility checks', async () => {
      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(1);
      expect(result.eligibleStudies[0]?.nctId).toBe('NCT00000001');
    });

    it('should exclude study that fails age check', async () => {
      mockCheckAgeEligibility.mockReturnValue({
        eligible: false,
        reason: 'Below minimum age (18)',
      });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(0);
      expect(result.totalMatches).toBe(0);
    });

    it('should exclude study that fails sex check', async () => {
      mockCheckSexEligibility.mockReturnValue({
        eligible: false,
        reason: 'Study only accepts Female',
      });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(0);
    });

    it('should exclude study that fails healthy volunteer check', async () => {
      mockCheckHealthyVolunteerEligibility.mockReturnValue({
        eligible: false,
        reason: 'Study does not accept healthy volunteers',
      });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(0);
    });

    it('should exclude study with no matching locations', async () => {
      mockExtractRelevantLocations.mockReturnValue([]);

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(0);
    });

    it('should skip study without eligibility module', async () => {
      mockListStudies.mockResolvedValue({
        studies: [
          {
            protocolSection: {
              identificationModule: {
                nctId: 'NCT99999999',
                briefTitle: 'No eligibility',
              },
              statusModule: { overallStatus: 'Recruiting' },
            },
          },
        ],
        totalCount: 1,
      });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(0);
      // Age check should never have been called -- skipped before eligibility checks
      expect(mockCheckAgeEligibility).not.toHaveBeenCalled();
    });

    it('should pass correct arguments to checkAgeEligibility', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockCheckAgeEligibility).toHaveBeenCalledWith(
        '18 Years',
        '65 Years',
        45,
      );
    });

    it('should pass correct arguments to checkSexEligibility', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockCheckSexEligibility).toHaveBeenCalledWith('All', 'Male');
    });

    it('should pass correct arguments to checkHealthyVolunteerEligibility', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockCheckHealthyVolunteerEligibility).toHaveBeenCalledWith(
        false,
        false,
      );
    });

    it('should pass condition relevance and demographic checks to calculateMatchScore', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockCalculateMatchScore).toHaveBeenCalledWith(
        0.8, // conditionRelevance from mock
        [
          { eligible: true, reason: 'Age within range (18-65)' },
          { eligible: true, reason: 'Study accepts all sexes' },
          {
            eligible: true,
            reason: 'Eligibility status matches study requirements',
          },
          { eligible: true, reason: '1 location(s) in United States' },
        ],
      );
    });

    it('should include match reasons from passing checks and condition relevance', async () => {
      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies[0]?.matchReasons).toEqual([
        'Age within range (18-65)',
        'Study accepts all sexes',
        'Eligibility status matches study requirements',
        '1 location(s) in United States',
        'Condition relevance: 80% (Type 2 Diabetes Mellitus)',
      ]);
    });

    it('should populate eligibilityHighlights from eligibility module', async () => {
      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      const highlights = result.eligibleStudies[0]?.eligibilityHighlights;
      expect(highlights?.ageRange).toBe('18 Years - 65 Years');
      expect(highlights?.sex).toBe('All');
      expect(highlights?.healthyVolunteers).toBe(false);
      expect(highlights?.criteriaSnippet).toContain('Inclusion: age 18-65');
    });

    it('should exclude study with zero condition relevance', async () => {
      mockCalculateConditionRelevance.mockReturnValue(0);

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(0);
      expect(result.totalMatches).toBe(0);
    });

    it('should handle multiple studies filtering some out', async () => {
      mockListStudies.mockResolvedValue({
        studies: [
          makeStudy('NCT00000001'),
          makeStudy('NCT00000002'),
          makeStudy('NCT00000003'),
        ],
        totalCount: 3,
      });

      // Second study fails age check
      mockCheckAgeEligibility
        .mockReturnValueOnce({ eligible: true, reason: 'Age OK' })
        .mockReturnValueOnce({ eligible: false, reason: 'Too old' })
        .mockReturnValueOnce({ eligible: true, reason: 'Age OK' });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(2);
      expect(result.totalMatches).toBe(2);
    });
  });

  // ── Logic: Results ────────────────────────────────────────────

  describe('logic — results', () => {
    it('should call rankStudies on filtered results', async () => {
      await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(mockRankStudies).toHaveBeenCalledTimes(1);
      expect(mockRankStudies).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ nctId: 'NCT00000001' }),
        ]),
      );
    });

    it('should limit results to maxResults', async () => {
      const studies = Array.from({ length: 15 }, (_, i) =>
        makeStudy(`NCT${String(i + 1).padStart(8, '0')}`),
      );
      mockListStudies.mockResolvedValue({ studies, totalCount: 15 });

      const result = await findEligibleStudiesTool.logic(
        { ...baseInput, maxResults: 5 },
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toHaveLength(5);
      expect(result.totalMatches).toBe(15);
    });

    it('should return empty eligibleStudies when no studies match', async () => {
      mockListStudies.mockResolvedValue({ studies: [], totalCount: 0 });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toEqual([]);
      expect(result.totalMatches).toBe(0);
    });

    it('should handle undefined studies array from provider', async () => {
      mockListStudies.mockResolvedValue({ totalCount: 0 });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies).toEqual([]);
      expect(result.totalMatches).toBe(0);
    });

    it('should populate searchCriteria correctly', async () => {
      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.searchCriteria).toEqual({
        conditions: ['Type 2 Diabetes'],
        location: 'Seattle',
        ageRange: '45 years old, Male',
      });
    });

    it('should use city for location string when available', async () => {
      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.searchCriteria.location).toBe('Seattle');
    });

    it('should fall back to state when city is not provided', async () => {
      const input = {
        ...baseInput,
        location: { country: 'United States', state: 'Washington' },
      };
      const result = await findEligibleStudiesTool.logic(
        input,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.searchCriteria.location).toBe('Washington');
    });

    it('should fall back to country when city and state are not provided', async () => {
      const input = { ...baseInput, location: { country: 'United States' } };
      const result = await findEligibleStudiesTool.logic(
        input,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.searchCriteria.location).toBe('United States');
    });

    it('should extract nctId and title from study protocol', async () => {
      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies[0]?.nctId).toBe('NCT00000001');
      expect(result.eligibleStudies[0]?.title).toBe('Study NCT00000001');
    });

    it('should use fallback values for missing nctId and title', async () => {
      mockListStudies.mockResolvedValue({
        studies: [
          {
            protocolSection: {
              identificationModule: {},
              eligibilityModule: {
                minimumAge: '18 Years',
                maximumAge: '65 Years',
                sex: 'All',
                healthyVolunteers: false,
              },
            },
          },
        ],
        totalCount: 1,
      });

      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies[0]?.nctId).toBe('Unknown');
      expect(result.eligibleStudies[0]?.title).toBe('No title');
    });

    it('should include briefSummary when available', async () => {
      const result = await findEligibleStudiesTool.logic(
        baseInput,
        appContext as never,
        mockSdkContext as never,
      );

      expect(result.eligibleStudies[0]?.briefSummary).toBe(
        'Summary for NCT00000001',
      );
    });
  });

  // ── Response Formatter ────────────────────────────────────────

  describe('responseFormatter', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const formatter = findEligibleStudiesTool.responseFormatter!;

    const sampleStudy = {
      nctId: 'NCT12345678',
      title: 'Diabetes Prevention Trial',
      briefSummary: 'A study of diabetes prevention strategies.',
      matchScore: 75,
      matchReasons: ['Age within range', 'Study accepts all sexes'],
      eligibilityHighlights: {
        ageRange: '18 Years - 65 Years',
        sex: 'All',
        healthyVolunteers: false,
        criteriaSnippet: 'Inclusion: adults with prediabetes',
      },
      locations: [
        {
          facility: 'Seattle General',
          city: 'Seattle',
          state: 'WA',
          country: 'United States',
        },
      ],
      contact: {
        name: 'Dr. Smith',
        phone: '555-1234',
        email: 'smith@study.com',
      },
      studyDetails: {
        phase: ['PHASE3'],
        status: 'Recruiting',
        enrollmentCount: 500,
        sponsor: 'NIH',
      },
    };

    const sampleResult = {
      eligibleStudies: [sampleStudy],
      totalMatches: 1,
      searchCriteria: {
        conditions: ['Type 2 Diabetes'],
        location: 'Seattle',
        ageRange: '45 years old, Male',
      },
    };

    it('should return a single text content block', () => {
      const blocks = formatter(sampleResult);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('text');
    });

    it('should include summary header', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('# Eligible Clinical Trials');
      expect(text).toContain('Found **1** matching studies');
    });

    it('should include search criteria', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('Type 2 Diabetes');
      expect(text).toContain('Seattle');
      expect(text).toContain('45 years old, Male');
    });

    it('should include study title and NCT ID', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('Diabetes Prevention Trial');
      expect(text).toContain('NCT12345678');
    });

    it('should include match score', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('75/100');
    });

    it('should include match reasons', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('Age within range');
      expect(text).toContain('Study accepts all sexes');
    });

    it('should include eligibility highlights', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('18 Years - 65 Years');
      expect(text).toContain('All');
      expect(text).toContain('Healthy Volunteers: No');
    });

    it('should include study details', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('PHASE3');
      expect(text).toContain('Recruiting');
      expect(text).toContain('NIH');
      expect(text).toContain('500');
    });

    it('should include contact information', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('Dr. Smith');
      expect(text).toContain('555-1234');
      expect(text).toContain('smith@study.com');
    });

    it('should include location information', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('Seattle General');
      expect(text).toContain('Seattle');
    });

    it('should limit displayed locations to 3 and show overflow', () => {
      const manyLocations = Array.from({ length: 5 }, (_, i) => ({
        facility: `Hospital ${i + 1}`,
        city: `City ${i + 1}`,
        state: 'WA',
        country: 'United States',
      }));

      const resultWithManyLocations = {
        ...sampleResult,
        eligibleStudies: [{ ...sampleStudy, locations: manyLocations }],
      };

      const text = extractText(formatter(resultWithManyLocations));
      expect(text).toContain('Hospital 1');
      expect(text).toContain('Hospital 2');
      expect(text).toContain('Hospital 3');
      expect(text).not.toContain('Hospital 4');
      expect(text).toContain('...and 2 more locations');
    });

    it('should handle study without contact info', () => {
      const resultWithoutContact = {
        ...sampleResult,
        eligibleStudies: [{ ...sampleStudy, contact: undefined }],
      };

      const text = extractText(formatter(resultWithoutContact));
      expect(text).toContain('Diabetes Prevention Trial');
      expect(text).not.toContain('**Contact:**');
    });

    it('should handle study without briefSummary', () => {
      const resultWithoutSummary = {
        ...sampleResult,
        eligibleStudies: [{ ...sampleStudy, briefSummary: undefined }],
      };

      const text = extractText(formatter(resultWithoutSummary));
      expect(text).toContain('Diabetes Prevention Trial');
      expect(text).not.toContain('**Study Summary:**');
    });

    it('should use singular "result" for one study', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('Showing top 1 result:');
    });

    it('should use plural "results" for multiple studies', () => {
      const multiResult = {
        ...sampleResult,
        eligibleStudies: [sampleStudy, sampleStudy],
        totalMatches: 2,
      };

      const text = extractText(formatter(multiResult));
      expect(text).toContain('Showing top 2 results:');
    });

    it('should handle empty results', () => {
      const emptyResult = {
        eligibleStudies: [] as typeof sampleResult.eligibleStudies,
        totalMatches: 0,
        searchCriteria: {
          conditions: ['Rare Disease'],
          location: 'Antarctica',
          ageRange: '30 years old, Male',
        },
      };

      const text = extractText(formatter(emptyResult));
      expect(text).toContain('Found **0** matching studies');
      expect(text).toContain('Showing top 0 results:');
    });

    it('should number studies sequentially', () => {
      const twoStudies = {
        ...sampleResult,
        eligibleStudies: [
          { ...sampleStudy, title: 'First Study' },
          { ...sampleStudy, title: 'Second Study' },
        ],
        totalMatches: 2,
      };

      const text = extractText(formatter(twoStudies));
      expect(text).toContain('## 1. First Study');
      expect(text).toContain('## 2. Second Study');
    });

    it('should show enrollment count when available', () => {
      const text = extractText(formatter(sampleResult));
      expect(text).toContain('Target Enrollment: 500');
    });

    it('should omit enrollment count when not available', () => {
      const noEnrollment = {
        ...sampleResult,
        eligibleStudies: [
          {
            ...sampleStudy,
            studyDetails: {
              ...sampleStudy.studyDetails,
              enrollmentCount: undefined,
            },
          },
        ],
      };

      const text = extractText(formatter(noEnrollment));
      expect(text).not.toContain('Target Enrollment');
    });
  });
});
