/**
 * @fileoverview Tests for clinicaltrials_find_eligible tool.
 * @module tests/find-eligible.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({ maxEligibleCandidates: 50 })),
}));

import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

function makeEligibleStudy(overrides: {
  nctId?: string;
  minAge?: string;
  maxAge?: string;
  sex?: string;
  country?: string;
  state?: string;
  city?: string;
  conditions?: string[];
  status?: string;
}): RawStudyShape {
  const {
    nctId = 'NCT12345678',
    minAge = '18 Years',
    maxAge = '65 Years',
    sex = 'ALL',
    country = 'United States',
    state = 'Washington',
    city = 'Seattle',
    conditions = ['Type 2 Diabetes'],
    status = 'RECRUITING',
  } = overrides;

  return {
    protocolSection: {
      identificationModule: { nctId, briefTitle: `Study ${nctId}` },
      statusModule: { overallStatus: status },
      designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 100 } },
      sponsorCollaboratorsModule: { leadSponsor: { name: 'Sponsor' } },
      eligibilityModule: { minimumAge: minAge, maximumAge: maxAge, sex, healthyVolunteers: false },
      conditionsModule: { conditions },
      contactsLocationsModule: {
        locations: [{ country, state, city, facility: 'Test Hospital', status: 'Recruiting' }],
      },
      descriptionModule: { briefSummary: 'A test study' },
    },
  };
}

const baseInput = {
  age: 30,
  sex: 'All' as const,
  conditions: ['Type 2 Diabetes'],
  location: { country: 'United States', state: 'Washington', city: 'Seattle' },
};

describe('findEligible', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('requires at least one condition', () => {
      expect(() => findEligible.input.parse({ ...baseInput, conditions: [] })).toThrow();
    });

    it('rejects age outside 0-120', () => {
      expect(() => findEligible.input.parse({ ...baseInput, age: -1 })).toThrow();
      expect(() => findEligible.input.parse({ ...baseInput, age: 121 })).toThrow();
    });

    it('rejects invalid sex', () => {
      expect(() => findEligible.input.parse({ ...baseInput, sex: 'Other' })).toThrow();
    });

    it('applies defaults for recruitingOnly and maxResults', () => {
      const input = findEligible.input.parse(baseInput);
      expect(input.recruitingOnly).toBe(true);
      expect(input.maxResults).toBe(10);
    });
  });

  describe('handler', () => {
    it('returns eligible studies matching patient profile', async () => {
      const study = makeEligibleStudy({});
      mockService.searchStudies.mockResolvedValue({
        studies: [study],
        totalCount: 1,
      });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.eligibleStudies).toHaveLength(1);
      expect(result.eligibleStudies[0].nctId).toBe('NCT12345678');
      expect(result.totalMatches).toBe(1);
    });

    it('builds condition query with quoting and OR', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input.parse({
          ...baseInput,
          conditions: ['Type 2 Diabetes', 'Hypertension'],
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryCond: '"Type 2 Diabetes" OR Hypertension',
        }),
        ctx,
      );
    });

    it('builds status filter when recruitingOnly is true', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterOverallStatus: ['RECRUITING', 'NOT_YET_RECRUITING'],
        }),
        ctx,
      );
    });

    it('omits status filter when recruitingOnly is false', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input.parse({ ...baseInput, recruitingOnly: false }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterOverallStatus: undefined,
        }),
        ctx,
      );
    });

    it('includes sex filter in advancedFilter when sex is not All', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input.parse({ ...baseInput, sex: 'Female' }), ctx);

      const call = mockService.searchStudies.mock.calls[0][0];
      expect(call.filterAdvanced).toContain('AREA[Sex]ALL OR AREA[Sex]FEMALE');
    });

    it('excludes studies where patient age is below minimumAge', async () => {
      const study = makeEligibleStudy({ minAge: '18 Years' });
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input.parse({ ...baseInput, age: 16 }),
        ctx,
      );

      expect(result.eligibleStudies).toHaveLength(0);
    });

    it('excludes studies where patient age is above maximumAge', async () => {
      const study = makeEligibleStudy({ maxAge: '65 Years' });
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input.parse({ ...baseInput, age: 70 }),
        ctx,
      );

      expect(result.eligibleStudies).toHaveLength(0);
    });

    it('excludes studies restricted to opposite sex', async () => {
      const study = makeEligibleStudy({ sex: 'FEMALE' });
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input.parse({ ...baseInput, sex: 'Male' }),
        ctx,
      );

      expect(result.eligibleStudies).toHaveLength(0);
    });

    it('excludes studies with no matching country', async () => {
      const study = makeEligibleStudy({ country: 'Canada' });
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.eligibleStudies).toHaveLength(0);
    });

    it('sorts by location proximity (city > state > country)', async () => {
      const cityMatch = makeEligibleStudy({
        nctId: 'NCT00000001',
        city: 'Seattle',
        state: 'Washington',
        country: 'United States',
      });
      const stateMatch = makeEligibleStudy({
        nctId: 'NCT00000002',
        city: 'Portland',
        state: 'Washington',
        country: 'United States',
      });
      const countryMatch = makeEligibleStudy({
        nctId: 'NCT00000003',
        city: 'Houston',
        state: 'Texas',
        country: 'United States',
      });
      mockService.searchStudies.mockResolvedValue({
        studies: [countryMatch, cityMatch, stateMatch],
        totalCount: 3,
      });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.eligibleStudies.map((s: { nctId: string }) => s.nctId)).toEqual([
        'NCT00000001', // city match (score 3)
        'NCT00000002', // state match (score 2)
        'NCT00000003', // country match (score 1)
      ]);
    });

    it('respects maxResults', async () => {
      const studies = Array.from({ length: 5 }, (_, i) =>
        makeEligibleStudy({ nctId: `NCT0000000${i}` }),
      );
      mockService.searchStudies.mockResolvedValue({ studies, totalCount: 5 });

      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input.parse({ ...baseInput, maxResults: 2 }),
        ctx,
      );

      expect(result.eligibleStudies).toHaveLength(2);
      expect(result.totalMatches).toBe(5);
    });

    it('provides noMatchHints when no studies match', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.noMatchHints).toBeDefined();
      expect(result.noMatchHints!.length).toBeGreaterThan(0);
    });

    it('hints about extreme age when no candidates pass filters', async () => {
      const study = makeEligibleStudy({ minAge: '18 Years', maxAge: '65 Years' });
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input.parse({ ...baseInput, age: 120 }),
        ctx,
      );

      const hints = result.noMatchHints ?? [];
      expect(hints.some((h: string) => h.includes('extreme'))).toBe(true);
    });

    it('populates match reasons with conditions and eligibility', async () => {
      const study = makeEligibleStudy({});
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      const reasons = result.eligibleStudies[0].matchReasons;
      expect(reasons.some((r: string) => r.includes('Conditions'))).toBe(true);
      expect(reasons.some((r: string) => r.includes('Age 30'))).toBe(true);
      expect(reasons.some((r: string) => r.includes('Location'))).toBe(true);
    });

    it('formats eligible study with location details', async () => {
      const study = makeEligibleStudy({});
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);
      const eligible = result.eligibleStudies[0];

      expect(eligible.eligibility.ageRange).toBe('18 Years to 65 Years');
      expect(eligible.locations).toHaveLength(1);
      expect(eligible.locations[0].city).toBe('Seattle');
      expect(eligible.studyDetails.phase).toBe('PHASE3');
    });
  });

  describe('format', () => {
    it('renders eligible studies list', () => {
      const blocks = findEligible.format!({
        eligibleStudies: [
          {
            nctId: 'NCT12345678',
            title: 'Test Study',
            matchReasons: ['Conditions: Diabetes'],
            eligibility: { ageRange: '18 Years to 65 Years', sex: 'ALL' },
            locations: [{ city: 'Seattle', state: 'WA', country: 'US' }],
            studyDetails: { status: 'RECRUITING', phase: 'PHASE3', sponsor: 'NIH' },
          },
        ],
        totalMatches: 1,
        searchCriteria: {
          conditions: ['Diabetes'],
          location: 'Seattle, WA, US',
          age: 30,
          sex: 'All',
        },
      });
      expect(blocks[0].text).toContain('Found 1 eligible studies');
      expect(blocks[0].text).toContain('NCT12345678');
      expect(blocks[0].text).toContain('RECRUITING');
    });

    it('renders no-match hints', () => {
      const blocks = findEligible.format!({
        eligibleStudies: [],
        totalMatches: 0,
        searchCriteria: { conditions: ['Rare'], location: 'US', age: 30, sex: 'All' },
        noMatchHints: ['No studies found', 'Try broader terms'],
      });
      expect(blocks[0].text).toContain('Found 0 eligible studies');
      expect(blocks[0].text).toContain('No studies found');
      expect(blocks[0].text).toContain('Try broader terms');
    });
  });
});
