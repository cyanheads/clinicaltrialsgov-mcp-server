/**
 * @fileoverview Tests for clinicaltrials_find_eligible tool.
 * @module tests/mcp-server/tools/definitions/find-eligible.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
          filterOverallStatus: ['RECRUITING'],
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

    it('echoes search criteria in enrichment', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.searchCriteria).toEqual({
        conditions: ['Type 2 Diabetes'],
        location: 'Seattle, Washington, United States',
        age: 30,
        sex: 'ALL',
      });
    });

    it('provides notice in enrichment when no studies found', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice!.length).toBeGreaterThan(0);
    });

    it('hints about extreme age in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, age: 120 }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('extreme');
    });

    it('hints about sex restriction in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, sex: 'MALE' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('sex="ALL"');
    });

    it('hints about healthy volunteer restriction in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, healthyVolunteer: true }),
        ctx,
      );

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('healthy volunteers');
    });

    it('hints about recruiting-only restriction in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('recruitingOnly=false');
    });

    it('hints about narrowing location in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('just the country');
    });

    it('omits notice enrichment when studies are found', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeUndefined();
    });
  });

  describe('format', () => {
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
      });
      expect((blocks[0] as { text: string }).text).toContain('Contact:');
      expect((blocks[0] as { text: string }).text).toContain('Dr. Smith');
    });

    it('shows no-match message for empty results', () => {
      const blocks = findEligible.format!({ studies: [], totalCount: 0 });
      expect((blocks[0] as { text: string }).text).toContain('No eligible studies found');
    });

    it('shows total when more results exist', () => {
      const blocks = findEligible.format!({
        studies: [
          { protocolSection: { identificationModule: { nctId: 'NCT00000001', briefTitle: 'A' } } },
        ],
        totalCount: 50,
      });
      expect((blocks[0] as { text: string }).text).toContain('50 eligible studies (showing 1)');
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
    it('populates funnel enrichment from condition + location + main-search counts (regression for #37)', async () => {
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
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.funnel).toEqual({
        conditionMatched: 298,
        locationMatched: 47,
        demographicsMatched: 2,
      });
    });

    it('ranks on-condition studies above tangential MeSH-umbrella matches (regression for #72)', async () => {
      // Reproduces the reported case: query.cond="Obesity OR Cardiovascular
      // Disease" pulls a Von Willebrand bleeding-disorder trial to rank #1 via
      // a distant MeSH ancestor. The re-rank must push studies whose own
      // condition names a requested condition above it — without dropping any.
      const upstreamOrder = [
        { nctId: 'NCT05776069', conditions: ['Von Willebrand Diseases'] }, // tangential — was #1
        { nctId: 'NCT05611242', conditions: ['Acute Ischemic Stroke'] },
        { nctId: 'NCT06174389', conditions: ['Obesity'] }, // exact match
        { nctId: 'NCT06875973', conditions: ['Atherosclerotic Cardiovascular Disease'] }, // phrase contains
        { nctId: 'NCT06445608', conditions: ['Coronary Artery Disease'] },
      ];
      const studies = upstreamOrder.map((s) => ({
        protocolSection: {
          identificationModule: { nctId: s.nctId },
          conditionsModule: { conditions: s.conditions },
        },
      }));
      mockService.searchStudies.mockResolvedValue({ studies, totalCount: 5 });

      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input!.parse({
          age: 56,
          sex: 'MALE',
          conditions: ['Obesity', 'Cardiovascular Disease'],
          location: { country: 'United States', state: 'Washington', city: 'Seattle' },
        }),
        ctx,
      );

      const order = (
        result.studies as Array<{ protocolSection: { identificationModule: { nctId: string } } }>
      ).map((s) => s.protocolSection.identificationModule.nctId);
      // Direct condition matches (Obesity exact, Atherosclerotic CVD phrase) lead;
      // the Von Willebrand trial is no longer first.
      expect(order.slice(0, 2)).toEqual(['NCT06174389', 'NCT06875973']);
      expect(order[0]).not.toBe('NCT05776069');
      // Recall preserved — every upstream study is still present.
      expect(order).toHaveLength(5);
      expect(new Set(order)).toEqual(new Set(upstreamOrder.map((s) => s.nctId)));
    });

    it('does not match conditions on the generic "Disease" token alone (regression for #72)', async () => {
      // "Cardiovascular Disease" must not rank a "Von Willebrand Diseases" trial
      // via the shared generic word "disease" — only significant tokens count.
      const studies = [
        {
          protocolSection: {
            identificationModule: { nctId: 'NCT_VWD' },
            conditionsModule: { conditions: ['Von Willebrand Diseases'] },
          },
        },
        {
          protocolSection: {
            identificationModule: { nctId: 'NCT_CVD' },
            conditionsModule: { conditions: ['Cardiovascular Disease, Other'] },
          },
        },
      ];
      mockService.searchStudies.mockResolvedValue({ studies, totalCount: 2 });

      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input!.parse({
          age: 50,
          sex: 'ALL',
          conditions: ['Cardiovascular Disease'],
          location: { country: 'United States' },
        }),
        ctx,
      );

      const order = (
        result.studies as Array<{ protocolSection: { identificationModule: { nctId: string } } }>
      ).map((s) => s.protocolSection.identificationModule.nctId);
      // The genuine CVD study leads; the bleeding-disorder trial stays last
      // (scored 0 — "disease" is generic, "willebrand" ≠ "cardiovascular").
      expect(order).toEqual(['NCT_CVD', 'NCT_VWD']);
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
