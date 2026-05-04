/**
 * @fileoverview Tests for clinicaltrials_find_eligible tool.
 * @module tests/mcp-server/tools/definitions/find-eligible.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';

const baseInput = {
  age: 30,
  sex: 'ALL' as const,
  conditions: ['Type 2 Diabetes'],
  location: { country: 'United States', state: 'Washington', city: 'Seattle' },
};

describe('findEligible', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('requires at least one condition', () => {
      expect(() => findEligible.input!.parse({ ...baseInput, conditions: [] })).toThrow();
    });

    it('rejects age outside 0-120', () => {
      expect(() => findEligible.input!.parse({ ...baseInput, age: -1 })).toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, age: 121 })).toThrow();
    });

    it('accepts boundary ages', () => {
      expect(() => findEligible.input!.parse({ ...baseInput, age: 0 })).not.toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, age: 120 })).not.toThrow();
    });

    it('rejects invalid sex', () => {
      expect(() => findEligible.input!.parse({ ...baseInput, sex: 'Other' })).toThrow();
    });

    it('accepts all valid sex values', () => {
      for (const sex of ['FEMALE', 'MALE', 'ALL'] as const) {
        expect(() => findEligible.input!.parse({ ...baseInput, sex })).not.toThrow();
      }
    });

    it('applies defaults for recruitingOnly, healthyVolunteer, and maxResults', () => {
      const input = findEligible.input!.parse(baseInput);
      expect(input.recruitingOnly).toBe(true);
      expect(input.healthyVolunteer).toBe(false);
      expect(input.maxResults).toBe(10);
    });

    it('rejects maxResults outside 1-50', () => {
      expect(() => findEligible.input!.parse({ ...baseInput, maxResults: 0 })).toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, maxResults: 51 })).toThrow();
    });

    it('requires location.country', () => {
      expect(() =>
        findEligible.input!.parse({ ...baseInput, location: { state: 'WA' } }),
      ).toThrow();
    });
  });

  describe('handler', () => {
    it('returns studies from the API', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.studies).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });

    it('builds condition query with quoting and OR', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input!.parse({
          ...baseInput,
          conditions: ['Type 2 Diabetes', 'Hypertension'],
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryCond: '"Type 2 Diabetes" OR Hypertension' }),
        ctx,
      );
    });

    it('does not quote single-word conditions', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, conditions: ['Asthma'] }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryCond: 'Asthma' }),
        ctx,
      );
    });

    it('builds location query from city, state, country', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryLocn: 'Seattle, Washington, United States' }),
        ctx,
      );
    });

    it('builds location from country only', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input!.parse({
          ...baseInput,
          location: { country: 'United States' },
        }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryLocn: 'United States' }),
        ctx,
      );
    });

    it('builds status filter when recruitingOnly is true', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

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
        findEligible.input!.parse({ ...baseInput, recruitingOnly: false }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterOverallStatus: undefined }),
        ctx,
      );
    });

    it('includes sex filter in advancedFilter when sex is not All', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, sex: 'FEMALE' }), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain('AREA[Sex]ALL OR AREA[Sex]FEMALE');
    });

    it('omits sex filter when sex is All', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).not.toContain('AREA[Sex]');
    });

    it('includes healthy volunteer filter when set', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, healthyVolunteer: true }),
        ctx,
      );

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain('AREA[HealthyVolunteers]true');
    });

    it('includes age range filters in advancedFilter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain('AREA[MinimumAge]RANGE[MIN, 30 years]');
      expect(call.filterAdvanced).toContain('AREA[MaximumAge]RANGE[30 years, MAX]');
    });

    it('uses maxResults as pageSize', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, maxResults: 25 }), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 25 }),
        ctx,
      );
    });

    it('opts out of the EnrollmentCount sentinel filter (regression for #41)', async () => {
      // Eligibility matches care about who can enroll, not whether the
      // sponsor published an enrollment count. The sentinel filter would
      // drop otherwise-valid matches.
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: true }),
        ctx,
      );
    });

    it('requests the eligibility field set', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.fields).toContain('NCTId');
      expect(call.fields).toContain('MinimumAge');
      expect(call.fields).toContain('LocationCity');
      expect(call.fields).toContain('HealthyVolunteers');
      expect(call.fields).toContain('CentralContactEMail');
    });

    it('echoes search criteria in output', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.searchCriteria).toEqual({
        conditions: ['Type 2 Diabetes'],
        location: 'Seattle, Washington, United States',
        age: 30,
        sex: 'ALL',
      });
    });

    it('provides noMatchHints when no studies found', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.noMatchHints).toBeDefined();
      expect(result.noMatchHints!.length).toBeGreaterThan(0);
    });

    it('hints about extreme age', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, age: 120 }),
        ctx,
      );

      expect(result.noMatchHints!.some((h: string) => h.includes('extreme'))).toBe(true);
    });

    it('hints about sex restriction', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, sex: 'MALE' }),
        ctx,
      );

      expect(result.noMatchHints!.some((h: string) => h.includes('sex="ALL"'))).toBe(true);
    });

    it('hints about healthy volunteer restriction', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, healthyVolunteer: true }),
        ctx,
      );

      expect(result.noMatchHints!.some((h: string) => h.includes('healthy volunteers'))).toBe(true);
    });

    it('hints about recruiting-only restriction', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.noMatchHints!.some((h: string) => h.includes('recruitingOnly=false'))).toBe(
        true,
      );
    });

    it('hints about narrowing location', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.noMatchHints!.some((h: string) => h.includes('just the country'))).toBe(true);
    });

    it('omits noMatchHints when studies are found', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.noMatchHints).toBeUndefined();
    });
  });

  describe('format', () => {
    const baseFunnel = { conditionMatched: 0, locationMatched: 0, demographicsMatched: 0 };

    it('renders study list with eligibility', () => {
      const blocks = findEligible.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test Study' },
              statusModule: { overallStatus: 'RECRUITING' },
              eligibilityModule: {
                minimumAge: '18 Years',
                maximumAge: '65 Years',
                sex: 'ALL',
                healthyVolunteers: false,
              },
            },
          },
        ],
        totalCount: 1,
        searchCriteria: { conditions: ['Diabetes'], location: 'US', age: 30, sex: 'ALL' },
        funnel: { ...baseFunnel, demographicsMatched: 1 },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Found 1 eligible studies');
      expect(text).toContain('NCT12345678');
      expect(text).toContain('RECRUITING');
      expect(text).toContain('18 Years');
      expect(text).toContain('65 Years');
      expect(text).toContain('Healthy Volunteers: No');
    });

    it('renders locations for studies', () => {
      const blocks = findEligible.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
              statusModule: { overallStatus: 'RECRUITING' },
              contactsLocationsModule: {
                locations: [
                  { facility: 'Hospital A', city: 'Seattle', country: 'US', status: 'RECRUITING' },
                  { facility: 'Hospital B', city: 'Portland', country: 'US', status: 'RECRUITING' },
                ],
              },
            },
          },
        ],
        totalCount: 1,
        searchCriteria: { conditions: ['X'], location: 'US', age: 30, sex: 'ALL' },
        funnel: baseFunnel,
      });
      expect((blocks[0] as { text: string }).text).toContain('Hospital A');
      expect((blocks[0] as { text: string }).text).toContain('Locations:');
    });

    it('renders central contacts', () => {
      const blocks = findEligible.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
              statusModule: { overallStatus: 'RECRUITING' },
              contactsLocationsModule: {
                centralContacts: [
                  { name: 'Dr. Smith', phone: '555-1234', email: 'smith@test.com' },
                ],
              },
            },
          },
        ],
        totalCount: 1,
        searchCriteria: { conditions: ['X'], location: 'US', age: 30, sex: 'ALL' },
        funnel: baseFunnel,
      });
      expect((blocks[0] as { text: string }).text).toContain('Contact:');
      expect((blocks[0] as { text: string }).text).toContain('Dr. Smith');
    });

    it('renders no-match hints', () => {
      const blocks = findEligible.format!({
        studies: [],
        totalCount: 0,
        searchCriteria: { conditions: ['Rare'], location: 'US', age: 30, sex: 'ALL' },
        funnel: baseFunnel,
        noMatchHints: ['No studies found', 'Try broader terms'],
      });
      expect((blocks[0] as { text: string }).text).toContain('No eligible studies found');
      expect((blocks[0] as { text: string }).text).toContain('No studies found');
      expect((blocks[0] as { text: string }).text).toContain('Try broader terms');
    });

    it('shows total when more results exist', () => {
      const blocks = findEligible.format!({
        studies: [
          { protocolSection: { identificationModule: { nctId: 'NCT00000001', briefTitle: 'A' } } },
        ],
        totalCount: 50,
        searchCriteria: { conditions: ['X'], location: 'US', age: 30, sex: 'ALL' },
        funnel: { conditionMatched: 200, locationMatched: 80, demographicsMatched: 50 },
      });
      expect((blocks[0] as { text: string }).text).toContain('50 eligible studies (showing 1)');
    });

    it('renders the funnel line (regression for #37)', () => {
      const blocks = findEligible.format!({
        studies: [],
        totalCount: 2,
        searchCriteria: { conditions: ['RA'], location: 'Seattle', age: 58, sex: 'FEMALE' },
        funnel: { conditionMatched: 298, locationMatched: 47, demographicsMatched: 2 },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Funnel: 298 condition → 47 + location → 2 + demographics');
    });

    it('renders sites in pre-sorted order without recruiting-priority override (regression for #37)', () => {
      // Handler sorts locations by match score; format() must not re-filter
      // by status, or a city-matched non-recruiting site gets buried behind
      // recruiting non-matches.
      const blocks = findEligible.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT1', briefTitle: 'X' },
              contactsLocationsModule: {
                locations: [
                  // Pre-sorted: Seattle match first even when not RECRUITING
                  { facility: 'Seattle Site', city: 'Seattle', status: 'COMPLETED' },
                  { facility: 'NY Site 1', city: 'New York', status: 'RECRUITING' },
                  { facility: 'NY Site 2', city: 'New York', status: 'RECRUITING' },
                  { facility: 'NY Site 3', city: 'New York', status: 'RECRUITING' },
                ],
              },
            },
          },
        ],
        totalCount: 1,
        searchCriteria: { conditions: ['X'], location: 'Seattle', age: 30, sex: 'ALL' },
        funnel: { conditionMatched: 1, locationMatched: 1, demographicsMatched: 1 },
      });
      const text = (blocks[0] as { text: string }).text;
      const seattleIdx = text.indexOf('Seattle Site');
      const nySite3Idx = text.indexOf('NY Site 3');
      expect(seattleIdx).toBeGreaterThan(-1);
      // Seattle Site comes before NY Site 3 (or NY Site 3 is in the +N more bucket)
      if (nySite3Idx > -1) expect(seattleIdx).toBeLessThan(nySite3Idx);
    });
  });

  describe('handler — funnel + location sort', () => {
    it('populates funnel from condition + location + main-search counts (regression for #37)', async () => {
      mockService.searchStudies.mockImplementation(async (params: { queryLocn?: string }) => {
        // Distinguish the three calls by which params are present:
        //   - main: queryLocn + filterAdvanced + fields
        //   - condition stage: only queryCond + count
        //   - location stage: queryCond + queryLocn (no filterAdvanced/fields)
        const p = params as Record<string, unknown>;
        if (p.fields) return { studies: [], totalCount: 2 }; // main
        if (p.queryLocn) return { studies: [], totalCount: 47 }; // condition + location
        return { studies: [], totalCount: 298 }; // condition only
      });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.funnel).toEqual({
        conditionMatched: 298,
        locationMatched: 47,
        demographicsMatched: 2,
      });
    });

    it("sorts locations by match to the user's city (regression for #37)", async () => {
      const study = {
        protocolSection: {
          identificationModule: { nctId: 'NCT1' },
          contactsLocationsModule: {
            locations: [
              {
                facility: 'NY Site',
                city: 'New York',
                state: 'New York',
                country: 'United States',
              },
              {
                facility: 'Seattle Site',
                city: 'Seattle',
                state: 'Washington',
                country: 'United States',
              },
              {
                facility: 'Portland Site',
                city: 'Portland',
                state: 'Oregon',
                country: 'United States',
              },
            ],
          },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const sortedStudy = result.studies[0] as typeof study;
      const locs = sortedStudy.protocolSection.contactsLocationsModule.locations;
      // Seattle (city match) wins over WA-state-only and US-country-only sites.
      expect(locs[0]!.facility).toBe('Seattle Site');
    });
  });
});
