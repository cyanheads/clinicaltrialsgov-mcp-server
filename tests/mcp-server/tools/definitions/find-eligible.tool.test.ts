/**
 * @fileoverview Tests for clinicaltrials_find_eligible tool.
 * @module tests/mcp-server/tools/definitions/find-eligible.tool
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

import {
  conditionMatchScore,
  findEligible,
} from '@/mcp-server/tools/definitions/find-eligible.tool.js';

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
    it('requires the conditions parameter', () => {
      const { conditions: _omitted, ...withoutConditions } = baseInput;
      expect(() => findEligible.input!.parse(withoutConditions)).toThrow();
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

    it('defaults locationLimit and rejects values outside 1-500 (#100)', () => {
      expect(findEligible.input!.parse(baseInput).locationLimit).toBe(10);
      expect(() => findEligible.input!.parse({ ...baseInput, locationLimit: 0 })).toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, locationLimit: 501 })).toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, locationLimit: 1 })).not.toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, locationLimit: 500 })).not.toThrow();
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

      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(result.studies).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });

    it('builds condition query with quoting and OR', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
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
      const ctx = createMockContext({ errors: findEligible.errors });
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
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryLocn: 'Seattle, Washington, United States' }),
        ctx,
      );
    });

    it('builds location from country only', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
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
      const ctx = createMockContext({ errors: findEligible.errors });
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
      const ctx = createMockContext({ errors: findEligible.errors });
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
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, sex: 'FEMALE' }), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain('AREA[Sex]ALL OR AREA[Sex]FEMALE');
    });

    it('omits sex filter when sex is All', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).not.toContain('AREA[Sex]');
    });

    it('includes healthy volunteer filter when set', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, healthyVolunteer: true }),
        ctx,
      );

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain('AREA[HealthyVolunteers]true');
    });

    it('includes age range filters in advancedFilter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain('AREA[MinimumAge]RANGE[MIN, 30 years]');
      expect(call.filterAdvanced).toContain('AREA[MaximumAge]RANGE[30 years, MAX]');
    });

    it('ORs each age bound with its MISSING counterpart so an open-ended bound qualifies (#105)', async () => {
      // An AREA[Field]RANGE[…] predicate matches only studies that publish the
      // field, so a closed range on MaximumAge drops every "18 Years and older"
      // study — the majority shape among recruiting trials. An absent bound is
      // unbounded, not disqualifying.
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain(
        '(AREA[MinimumAge]RANGE[MIN, 30 years] OR AREA[MinimumAge]MISSING)',
      );
      expect(call.filterAdvanced).toContain(
        '(AREA[MaximumAge]RANGE[30 years, MAX] OR AREA[MaximumAge]MISSING)',
      );
    });

    it('keeps the Sex and HealthyVolunteers arms strict — no MISSING widening (#105)', async () => {
      // An unstated healthy-volunteer policy is not an affirmative yes, and an
      // unrestricted study registers a literal Sex: ALL rather than omitting the
      // field. Neither arm takes the MISSING widening the age bounds need —
      // guards against it being applied by pattern across every AREA[] predicate.
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, healthyVolunteer: true, sex: 'FEMALE' }),
        ctx,
      );

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.filterAdvanced).toContain('AREA[HealthyVolunteers]true');
      expect(call.filterAdvanced).not.toContain('AREA[HealthyVolunteers]MISSING');
      expect(call.filterAdvanced).toContain('(AREA[Sex]ALL OR AREA[Sex]FEMALE)');
      expect(call.filterAdvanced).not.toContain('AREA[Sex]MISSING');
    });

    it('carries an open-ended-age study through both channels without inventing a bound (#105)', async () => {
      // The shape the widened predicate now admits: minimumAge published,
      // maximumAge absent. structuredContent must carry the record verbatim and
      // format() must render the one-sided bound as "≥", never fabricate an
      // upper bound or drop the field.
      const openEnded = {
        protocolSection: {
          identificationModule: { nctId: 'NCT06907862', briefTitle: '18 and older trial' },
          statusModule: { overallStatus: 'RECRUITING' },
          eligibilityModule: { minimumAge: '18 Years', sex: 'ALL' },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [openEnded], totalCount: 1 });
      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, age: 58 }),
        ctx,
      );

      const elig = (result.studies[0] as typeof openEnded).protocolSection.eligibilityModule;
      expect(elig.minimumAge).toBe('18 Years');
      expect(elig).not.toHaveProperty('maximumAge');

      const text = (findEligible.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Eligibility: Age: ≥18 Years');
      expect(text).not.toMatch(/Age: 18 Years–/);
    });

    it('uses maxResults as pageSize', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
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
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ includeUnknownEnrollment: true }),
        ctx,
      );
    });

    it('requests the eligibility field set', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0]![0];
      expect(call.fields).toContain('NCTId');
      expect(call.fields).toContain('MinimumAge');
      expect(call.fields).toContain('LocationCity');
      expect(call.fields).toContain('HealthyVolunteers');
      expect(call.fields).toContain('CentralContactEMail');
    });

    it('echoes search criteria including the reproducible query strings in enrichment (#91)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      // The exact upstream query strings ride alongside the normalized echo so a
      // caller can reproduce the full match set via clinicaltrials_search_studies.
      expect(enrichment.searchCriteria).toEqual({
        conditions: ['Type 2 Diabetes'],
        location: 'Seattle, Washington, United States',
        age: 30,
        sex: 'ALL',
        conditionQuery: '"Type 2 Diabetes"',
        statusFilter: ['RECRUITING'],
        advancedFilter:
          '(AREA[MinimumAge]RANGE[MIN, 30 years] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[30 years, MAX] OR AREA[MaximumAge]MISSING)',
      });
    });

    it('omits statusFilter and folds sex + healthy-volunteer into the echoed advancedFilter (#91)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(
        findEligible.input!.parse({
          ...baseInput,
          sex: 'FEMALE',
          healthyVolunteer: true,
          recruitingOnly: false,
        }),
        ctx,
      );

      const sc = getEnrichment(ctx).searchCriteria as Record<string, unknown>;
      // recruitingOnly=false → no status filter applied, so none is echoed.
      expect(sc.statusFilter).toBeUndefined();
      expect(sc.conditionQuery).toBe('"Type 2 Diabetes"');
      expect(sc.advancedFilter).toContain('(AREA[Sex]ALL OR AREA[Sex]FEMALE)');
      expect(sc.advancedFilter).toContain('AREA[HealthyVolunteers]true');
    });

    it('provides notice in enrichment when no studies found', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toEqual(expect.any(String));
      expect(enrichment.notice).not.toBe('');
    });

    it('hints about extreme age in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, age: 120 }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('extreme');
    });

    it('hints about sex restriction in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, sex: 'MALE' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('sex="ALL"');
    });

    it('hints about healthy volunteer restriction in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, healthyVolunteer: true }),
        ctx,
      );

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('healthy volunteers');
    });

    it('hints about recruiting-only restriction in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('recruitingOnly=false');
    });

    it('hints about narrowing location in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('just the country');
    });

    it('omits notice enrichment when studies are found', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeUndefined();
    });
  });

  describe('blank supplied values (#99)', () => {
    /** Assert a handler call fails with the shared blank_value contract for `param`. */
    const expectBlankValue = (call: unknown, param: string) =>
      expect(call).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_value', param },
      });

    beforeEach(() => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    });

    // Through the real `.input.parse()` path. A schema `.min(1)` would preempt
    // the handler on the fully-empty form alone, splitting one class of input
    // across two error shapes — a typed blank_value for ['']  and a bare -32602
    // for [] (#109).
    it('answers an empty conditions list with the typed blank_value contract', async () => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expectBlankValue(
        findEligible.handler(findEligible.input!.parse({ ...baseInput, conditions: [] }), ctx),
        'conditions',
      );
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it('rejects a conditions array whose only entry is blank', () => {
      const ctx = createMockContext({ errors: findEligible.errors });
      return expectBlankValue(
        findEligible.handler(findEligible.input!.parse({ ...baseInput, conditions: [''] }), ctx),
        'conditions',
      );
    });

    it('rejects a conditions array carrying a blank entry alongside a valid one', () => {
      const ctx = createMockContext({ errors: findEligible.errors });
      return expectBlankValue(
        findEligible.handler(
          findEligible.input!.parse({ ...baseInput, conditions: ['Diabetes', '  '] }),
          ctx,
        ),
        'conditions',
      );
    });

    it.each(['', '   '])('rejects a blank location.country (%j)', (country) => {
      const ctx = createMockContext({ errors: findEligible.errors });
      return expectBlankValue(
        findEligible.handler(
          findEligible.input!.parse({ ...baseInput, location: { country } }),
          ctx,
        ),
        'location.country',
      );
    });

    it('never reaches the service when a supplied value is blank', async () => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expectBlankValue(
        findEligible.handler(findEligible.input!.parse({ ...baseInput, conditions: [''] }), ctx),
        'conditions',
      );
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it('leaves non-blank values untouched', async () => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expect(
        findEligible.handler(findEligible.input!.parse(baseInput), ctx),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryCond: '"Type 2 Diabetes"' }),
        ctx,
      );
    });

    it('leaves the optional location parts untouched when omitted', async () => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expect(
        findEligible.handler(
          findEligible.input!.parse({ ...baseInput, location: { country: 'United States' } }),
          ctx,
        ),
      ).resolves.toBeDefined();
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryLocn: 'United States' }),
        ctx,
      );
    });

    it('declares the blank_value reason on the tool contract', () => {
      expect(findEligible.errors?.map((e) => e.reason)).toContain('blank_value');
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

    it('renders all interventions, locations, contacts, and the full summary without caps (#91)', () => {
      // Reproduces the reported NCT07271186 shape: many sites/interventions and a
      // long summary that structuredContent carries in full. content[] must match —
      // no first-3/first-2 previews, no 200-char summary clip.
      const longSummary = `Study rationale: ${'x'.repeat(400)}`; // > 200 chars
      const blocks = findEligible.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT07271186', briefTitle: 'Big multi-site trial' },
              statusModule: { overallStatus: 'RECRUITING' },
              descriptionModule: { briefSummary: longSummary },
              armsInterventionsModule: {
                interventions: [
                  { name: 'Drug A' },
                  { name: 'Drug B' },
                  { name: 'Drug C' },
                  { name: 'Drug D' }, // 4th — beyond the old slice(0, 3)
                ],
              },
              contactsLocationsModule: {
                locations: [
                  { facility: 'Site 1', city: 'Huntsville', state: 'Alabama', country: 'US' },
                  { facility: 'Site 2', city: 'Little Rock', state: 'Arkansas', country: 'US' },
                  {
                    facility: 'Site 3',
                    city: 'Huntington Beach',
                    state: 'California',
                    country: 'US',
                  },
                  { facility: 'Site 4', city: 'Denver', state: 'Colorado', country: 'US' }, // 4th, 5th —
                  { facility: 'Site 5', city: 'Miami', state: 'Florida', country: 'US' }, // beyond slice(0, 3)
                ],
                centralContacts: [
                  { name: 'Coord One', phone: '555-0001', email: 'one@test.org' },
                  { name: 'Coord Two', phone: '555-0002', email: 'two@test.org' },
                  { name: 'Coord Three', phone: '555-0003', email: 'three@test.org' }, // 3rd — beyond slice(0, 2)
                ],
              },
            },
          },
        ],
        totalCount: 1,
      });
      const text = (blocks[0] as { text: string }).text;
      // Full summary reaches content[] — not clipped at 200 chars, no ellipsis.
      expect(text).toContain(longSummary);
      expect(text).not.toContain('...');
      // Every intervention, including the 4th.
      for (const drug of ['Drug A', 'Drug B', 'Drug C', 'Drug D']) expect(text).toContain(drug);
      // Every site, including 4 and 5, with no "(+N more)" tail.
      for (const site of ['Site 1', 'Site 2', 'Site 3', 'Site 4', 'Site 5'])
        expect(text).toContain(site);
      expect(text).not.toContain('more)');
      // Every central contact, including the 3rd.
      for (const coord of ['Coord One', 'Coord Two', 'Coord Three']) expect(text).toContain(coord);
    });

    it('renders each site status alongside the site so a non-recruiting site is visible (#91)', () => {
      // The tool requests LocationStatus and returns it in structuredContent. A
      // site-level status can differ from the study's overall status, so a
      // content[]-only caller must see it — otherwise a NOT_YET_RECRUITING site
      // reads as currently open under recruitingOnly=true.
      const blocks = findEligible.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'Mixed-status trial' },
              statusModule: { overallStatus: 'RECRUITING' },
              contactsLocationsModule: {
                locations: [
                  {
                    facility: 'Yale',
                    city: 'New Haven',
                    state: 'Connecticut',
                    country: 'United States',
                    status: 'RECRUITING',
                  },
                  {
                    facility: 'University of South Florida',
                    city: 'Tampa',
                    state: 'Florida',
                    country: 'United States',
                    status: 'NOT_YET_RECRUITING',
                  },
                  {
                    facility: 'Unstated Site',
                    city: 'Boston',
                    state: 'Massachusetts',
                    country: 'United States',
                  },
                ],
              },
            },
          },
        ],
        totalCount: 1,
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain(
        'Yale, New Haven, Connecticut, United States [RECRUITING] | University of South Florida, Tampa, Florida, United States [NOT_YET_RECRUITING]',
      );
      // A site with no published status renders bare — no fabricated status.
      expect(text).toContain('Unstated Site, Boston, Massachusetts, United States');
      expect(text).not.toMatch(/Unstated Site[^|\n]*\[/);
    });

    it('renders the reproducible query strings in the searchCriteria content[] trailer (#91)', () => {
      // The trailer is content[]'s twin of the searchCriteria enrichment — every
      // sub-field VALUE must render here, or it reaches structuredContent only.
      const text = findEligible.enrichmentTrailer!.searchCriteria!.render!({
        conditions: ['Type 2 Diabetes'],
        location: 'Seattle, Washington, United States',
        age: 30,
        sex: 'ALL',
        conditionQuery: '"Type 2 Diabetes"',
        statusFilter: ['RECRUITING'],
        advancedFilter:
          '(AREA[MinimumAge]RANGE[MIN, 30 years] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[30 years, MAX] OR AREA[MaximumAge]MISSING)',
      });
      expect(text).toContain('conditions=[Type 2 Diabetes]');
      expect(text).toContain('conditionQuery="Type 2 Diabetes"');
      // location is an applied upstream filter (queryLocn) — it must ride in the
      // reproduce set, else a caller replays a broader, all-locations query (#91-C).
      expect(text).toContain('locationQuery=Seattle, Washington, United States');
      expect(text).toContain('statusFilter=[RECRUITING]');
      expect(text).toContain(
        'advancedFilter=(AREA[MinimumAge]RANGE[MIN, 30 years] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[30 years, MAX] OR AREA[MaximumAge]MISSING)',
      );
      // find_eligible always queries includeUnknownEnrollment=true; search_studies
      // defaults it false, so the reproduce set must carry it for a faithful replay (#91-C).
      expect(text).toContain('includeUnknownEnrollment=true');
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

      const ctx = createMockContext({ errors: findEligible.errors });
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

      const ctx = createMockContext({ errors: findEligible.errors });
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

      const ctx = createMockContext({ errors: findEligible.errors });
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

    it('does not let a single-word false friend outrank a genuine subtype match (regression for #79)', async () => {
      // query.cond="Type 2 Diabetes" OR Hypertension pulls in a Pulmonary
      // Arterial Hypertension trial because "hypertension" is a substring of its
      // condition. The single-word "Hypertension" request must not credit PAH (a
      // distinct disease) as an on-condition match above a genuine Type 2
      // Diabetes trial. Upstream had PAH first — the reported bug.
      const upstreamOrder = [
        { nctId: 'NCT06053580', conditions: ['Pulmonary Arterial Hypertension'] }, // false friend — was #1
        { nctId: 'NCT_T2D', conditions: ['Type 2 Diabetes Mellitus'] }, // genuine subtype
      ];
      const studies = upstreamOrder.map((s) => ({
        protocolSection: {
          identificationModule: { nctId: s.nctId },
          conditionsModule: { conditions: s.conditions },
        },
      }));
      mockService.searchStudies.mockResolvedValue({ studies, totalCount: 2 });

      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(
        findEligible.input!.parse({
          age: 58,
          sex: 'MALE',
          conditions: ['Type 2 Diabetes', 'Hypertension'],
          location: { country: 'United States', state: 'Washington', city: 'Seattle' },
        }),
        ctx,
      );

      const order = (
        result.studies as Array<{ protocolSection: { identificationModule: { nctId: string } } }>
      ).map((s) => s.protocolSection.identificationModule.nctId);
      // The genuine Type 2 Diabetes trial (tier 2) leads; PAH (tier 1 — the
      // shared single word "hypertension") no longer holds the top slot.
      expect(order).toEqual(['NCT_T2D', 'NCT06053580']);
      // Recall preserved — nothing dropped.
      expect(new Set(order)).toEqual(new Set(upstreamOrder.map((s) => s.nctId)));
    });

    it('does not split word-order variants of the same concept across tiers (regression for #79)', async () => {
      // "Type 2 Diabetes Mellitus" and "Diabetes Mellitus, Type 2" are the same
      // concept; both must score tier 2 for a "Type 2 Diabetes" request. The
      // reversed-word study is placed first upstream — before the fix it was
      // demoted to tier 1 (only shared tokens) and sank below the direct-order
      // study; now both are tier 2 and the stable sort preserves upstream order.
      const upstreamOrder = [
        { nctId: 'NCT05780905', conditions: ['Diabetes Mellitus, Type 2'] }, // reversed word order
        { nctId: 'NCT07228117', conditions: ['Type 2 Diabetes Mellitus'] },
      ];
      const studies = upstreamOrder.map((s) => ({
        protocolSection: {
          identificationModule: { nctId: s.nctId },
          conditionsModule: { conditions: s.conditions },
        },
      }));
      mockService.searchStudies.mockResolvedValue({ studies, totalCount: 2 });

      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(
        findEligible.input!.parse({
          age: 58,
          sex: 'MALE',
          conditions: ['Type 2 Diabetes'],
          location: { country: 'United States', state: 'Washington', city: 'Seattle' },
        }),
        ctx,
      );

      const order = (
        result.studies as Array<{ protocolSection: { identificationModule: { nctId: string } } }>
      ).map((s) => s.protocolSection.identificationModule.nctId);
      // Both tier 2 → stable sort keeps the reversed-word study in its upstream
      // position rather than demoting it below the direct-order study.
      expect(order).toEqual(['NCT05780905', 'NCT07228117']);
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

      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const sortedStudy = result.studies[0] as typeof study;
      const locs = sortedStudy.protocolSection.contactsLocationsModule.locations;
      // Seattle (city match) wins over WA-state-only and US-country-only sites.
      expect(locs[0]!.facility).toBe('Seattle Site');
    });
  });

  describe('handler — bounded candidate locations (#100)', () => {
    type CandidateStudy = {
      locationSummary?: {
        locationsTruncated: boolean;
        matchedLocations: number;
        nearestRecruitingSiteAdded?: true;
        retrieveFullStudyWith: string;
        totalLocations: number;
      };
      protocolSection: {
        contactsLocationsModule?: { locations?: Array<Record<string, unknown>> };
        identificationModule: { briefTitle?: string; nctId: string };
      };
    };

    /** A study carrying `sites` locations under one identification module. */
    const studyWith = (nctId: string, sites: Array<Record<string, unknown>>) => ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: `${nctId} trial` },
        contactsLocationsModule: { locations: sites },
      },
    });

    const site = (
      facility: string,
      city: string,
      state: string,
      country = 'United States',
      status = 'RECRUITING',
    ) => ({
      facility,
      city,
      state,
      country,
      status,
    });

    /** Run the handler and return the single bounded candidate it produced. */
    const runOne = async (
      study: unknown,
      overrides: Record<string, unknown> = {},
    ): Promise<CandidateStudy> => {
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });
      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, ...overrides }),
        ctx,
      );
      return result.studies[0] as CandidateStudy;
    };

    const facilities = (candidate: CandidateStudy) =>
      (candidate.protocolSection.contactsLocationsModule?.locations ?? []).map((l) => l.facility);

    it('keeps only the sites matching the requested city, dropping the rest', async () => {
      // The reported shape: a study qualifies on a Seattle site but carries every
      // site it ever registered, so distant sites dominate a local eligibility
      // answer and the payload.
      const candidate = await runOne(
        studyWith('NCT05929768', [
          site('Seattle A', 'Seattle', 'Washington'),
          site('Spokane', 'Spokane', 'Washington'),
          site('Seattle B', 'Seattle', 'Washington'),
          site('Boston', 'Boston', 'Massachusetts'),
          site('Miami', 'Miami', 'Florida'),
        ]),
      );
      expect(facilities(candidate)).toEqual(['Seattle A', 'Seattle B']);
      expect(candidate.locationSummary).toEqual({
        totalLocations: 5,
        matchedLocations: 2,
        locationsTruncated: false,
        retrieveFullStudyWith: 'clinicaltrials_get_study_record',
      });
    });

    it('falls back to the state tier when no site is in the requested city', async () => {
      const candidate = await runOne(
        studyWith('NCT1', [
          site('Spokane', 'Spokane', 'Washington'),
          site('Boston', 'Boston', 'Massachusetts'),
          site('Tacoma', 'Tacoma', 'Washington'),
        ]),
      );
      expect(facilities(candidate)).toEqual(['Spokane', 'Tacoma']);
      expect(candidate.locationSummary?.matchedLocations).toBe(2);
    });

    it('falls back to the country tier when no site is in the requested state', async () => {
      const candidate = await runOne(
        studyWith('NCT1', [
          site('Boston', 'Boston', 'Massachusetts'),
          site('Toronto', 'Toronto', 'Ontario', 'Canada'),
        ]),
      );
      expect(facilities(candidate)).toEqual(['Boston']);
      expect(candidate.locationSummary?.totalLocations).toBe(2);
    });

    it('keeps every site bounded when none matches the requested location at all', async () => {
      // A study can qualify upstream through a facility or ZIP match with no
      // city/state/country hit. The payload must still be bounded, never dumped.
      const candidate = await runOne(
        studyWith(
          'NCT1',
          Array.from({ length: 30 }, (_, i) =>
            site(`Toronto ${i}`, 'Toronto', 'Ontario', 'Canada'),
          ),
        ),
        { locationLimit: 3 },
      );
      expect(facilities(candidate)).toHaveLength(3);
      expect(candidate.locationSummary).toEqual({
        totalLocations: 30,
        matchedLocations: 30,
        locationsTruncated: true,
        retrieveFullStudyWith: 'clinicaltrials_get_study_record',
      });
    });

    it('caps the matched sites at locationLimit and flags the truncation', async () => {
      const candidate = await runOne(
        studyWith(
          'NCT1',
          Array.from({ length: 40 }, (_, i) => site(`Seattle ${i}`, 'Seattle', 'Washington')),
        ),
        { locationLimit: 4 },
      );
      expect(facilities(candidate)).toHaveLength(4);
      expect(candidate.locationSummary).toEqual({
        totalLocations: 40,
        matchedLocations: 40,
        locationsTruncated: true,
        retrieveFullStudyWith: 'clinicaltrials_get_study_record',
      });
    });

    it('defaults to a bounded candidate without the caller passing locationLimit', async () => {
      const candidate = await runOne(
        studyWith(
          'NCT1',
          Array.from({ length: 200 }, (_, i) => site(`Seattle ${i}`, 'Seattle', 'Washington')),
        ),
      );
      expect(facilities(candidate).length).toBeLessThan(200);
      expect(candidate.locationSummary?.locationsTruncated).toBe(true);
    });

    it('omits the summary entirely when nothing was dropped (#80 echo semantics)', async () => {
      const candidate = await runOne(
        studyWith('NCT1', [
          site('Seattle A', 'Seattle', 'Washington'),
          site('Seattle B', 'Seattle', 'Washington'),
        ]),
      );
      expect(facilities(candidate)).toEqual(['Seattle A', 'Seattle B']);
      expect(candidate.locationSummary).toBeUndefined();
    });

    it('leaves a study with no locations untouched', async () => {
      const candidate = await runOne({
        protocolSection: {
          identificationModule: { nctId: 'NCT1', briefTitle: 'No sites' },
          contactsLocationsModule: { locations: [] },
        },
      });
      expect(facilities(candidate)).toEqual([]);
      expect(candidate.locationSummary).toBeUndefined();
    });

    it('leaves a study with no contactsLocationsModule untouched', async () => {
      const candidate = await runOne({
        protocolSection: { identificationModule: { nctId: 'NCT1', briefTitle: 'No module' } },
      });
      expect(candidate.protocolSection.contactsLocationsModule).toBeUndefined();
      expect(candidate.locationSummary).toBeUndefined();
    });

    it('preserves every non-location field of the candidate', async () => {
      const candidate = (await runOne({
        protocolSection: {
          identificationModule: { nctId: 'NCT1', briefTitle: 'Keeps its data' },
          descriptionModule: { briefSummary: 'A summary' },
          armsInterventionsModule: { interventions: [{ name: 'Drug A' }] },
          eligibilityModule: { minimumAge: '18 Years', sex: 'ALL' },
          contactsLocationsModule: {
            centralContacts: [{ name: 'Dr. Smith' }],
            locations: [
              site('Seattle', 'Seattle', 'Washington'),
              site('Boston', 'Boston', 'Massachusetts'),
            ],
          },
        },
      })) as CandidateStudy & {
        protocolSection: {
          armsInterventionsModule: { interventions: Array<{ name: string }> };
          contactsLocationsModule: { centralContacts: Array<{ name: string }> };
          descriptionModule: { briefSummary: string };
          eligibilityModule: { minimumAge: string };
        };
      };
      expect(candidate.protocolSection.descriptionModule.briefSummary).toBe('A summary');
      expect(candidate.protocolSection.armsInterventionsModule.interventions[0]!.name).toBe(
        'Drug A',
      );
      expect(candidate.protocolSection.eligibilityModule.minimumAge).toBe('18 Years');
      expect(candidate.protocolSection.contactsLocationsModule.centralContacts[0]!.name).toBe(
        'Dr. Smith',
      );
    });

    it('renders exactly the bounded sites in content[], and no dropped one (channel parity, #46/#91)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [
          studyWith('NCT1', [
            site('Seattle A', 'Seattle', 'Washington'),
            site('Boston', 'Boston', 'Massachusetts'),
            site('Miami', 'Miami', 'Florida'),
          ]),
        ],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
      const text = (findEligible.format!(result)[0] as { text: string }).text;

      expect(text).toContain('Seattle A');
      // A site absent from structuredContent must be absent from content[] too —
      // trimming one channel while the other keeps the full record is the defect
      // #46 fixed, and the cap here applies once at the handler boundary.
      expect(text).not.toContain('Boston');
      expect(text).not.toContain('Miami');
    });

    it('renders every locationSummary value in content[] (channel parity)', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [
          studyWith('NCT05929768', [
            ...Array.from({ length: 6 }, (_, i) => site(`Seattle ${i}`, 'Seattle', 'Washington')),
            ...Array.from({ length: 957 }, (_, i) =>
              site(`Elsewhere ${i}`, 'Boston', 'Massachusetts'),
            ),
          ]),
        ],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, locationLimit: 4 }),
        ctx,
      );
      const text = (findEligible.format!(result)[0] as { text: string }).text;

      // showing / totalLocations / matchedLocations / truncation / retrieval pointer.
      expect(text).toContain('4 of 963');
      expect(text).toContain('6 match the requested location');
      expect(text).toContain('truncated');
      expect(text).toContain('clinicaltrials_get_study_record');
      expect(text).toContain('NCT05929768');
    });

    it('does not render a sites line when nothing was dropped', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [studyWith('NCT1', [site('Seattle A', 'Seattle', 'Washington')])],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
      const text = (findEligible.format!(result)[0] as { text: string }).text;
      expect(text).not.toContain('registered');
      expect(text).toContain('Seattle A');
    });

    it('does not leak locationSummary into the field-dump fallback', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [
          studyWith('NCT1', [
            site('Seattle A', 'Seattle', 'Washington'),
            site('Boston', 'Boston', 'Massachusetts'),
          ]),
        ],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
      const text = (findEligible.format!(result)[0] as { text: string }).text;
      expect(text).not.toMatch(/Location Summary > /);
    });

    describe('nearest recruiting site (#114)', () => {
      /**
       * The reported shape — a RECRUITING study whose nearest site is closed and
       * whose only open site sits one tier out. Selecting on geography alone
       * returns the closed Seattle site and hides the open Renton one.
       */
      const closedCityOpenState = () =>
        studyWith('NCT07174336', [
          site(
            'Swedish Medical Center',
            'Seattle',
            'Washington',
            'United States',
            'NOT_YET_RECRUITING',
          ),
          site(
            'UW Medicine Valley Medical Center',
            'Renton',
            'Washington',
            'United States',
            'RECRUITING',
          ),
          site(
            'Deaconess Hospital',
            'Spokane',
            'Washington',
            'United States',
            'NOT_YET_RECRUITING',
          ),
          site('North Star Lodge', 'Yakima', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
          site('MD Anderson', 'Houston', 'Texas', 'United States', 'NOT_YET_RECRUITING'),
        ]);

      it('admits the nearest recruiting site when every matched site is closed', async () => {
        const candidate = await runOne(closedCityOpenState());
        expect(facilities(candidate)).toEqual([
          'Swedish Medical Center',
          'UW Medicine Valley Medical Center',
        ]);
        expect(candidate.locationSummary).toEqual({
          totalLocations: 5,
          matchedLocations: 1,
          locationsTruncated: false,
          nearestRecruitingSiteAdded: true,
          retrieveFullStudyWith: 'clinicaltrials_get_study_record',
        });
      });

      it('admits the nearest recruiting site, not the first one it finds', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Seattle closed', 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            site('Boston open', 'Boston', 'Massachusetts', 'United States', 'RECRUITING'),
            site('Tacoma closed', 'Tacoma', 'Washington', 'United States', 'SUSPENDED'),
            site('Renton open', 'Renton', 'Washington', 'United States', 'RECRUITING'),
          ]),
        );
        // Renton matches at the state tier, Boston only at the country tier.
        expect(facilities(candidate)).toEqual(['Seattle closed', 'Renton open']);
        expect(candidate.locationSummary?.nearestRecruitingSiteAdded).toBe(true);
      });

      it('leaves the tier answer alone when a matched site is already recruiting', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Seattle open', 'Seattle', 'Washington'),
            site('Seattle closed', 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            site('Renton open', 'Renton', 'Washington'),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Seattle open', 'Seattle closed']);
        expect(candidate.locationSummary?.nearestRecruitingSiteAdded).toBeUndefined();
      });

      it('admits nothing when the study registers no recruiting site anywhere', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Seattle closed', 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            site('Renton closed', 'Renton', 'Washington', 'United States', 'TERMINATED'),
            site('Boston closed', 'Boston', 'Massachusetts', 'United States', 'COMPLETED'),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Seattle closed']);
        expect(candidate.locationSummary).toEqual({
          totalLocations: 3,
          matchedLocations: 1,
          locationsTruncated: false,
          retrieveFullStudyWith: 'clinicaltrials_get_study_record',
        });
      });

      it('treats enrolling-by-invitation as closed — a self-referring patient cannot enroll there', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Seattle closed', 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            site(
              'Renton invite-only',
              'Renton',
              'Washington',
              'United States',
              'ENROLLING_BY_INVITATION',
            ),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Seattle closed']);
        expect(candidate.locationSummary?.nearestRecruitingSiteAdded).toBeUndefined();
      });

      it('adds one site alongside the cap, which still bounds the matched sites', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            ...Array.from({ length: 12 }, (_, i) =>
              site(`Seattle ${i}`, 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            ),
            site('Renton open', 'Renton', 'Washington'),
          ]),
          { locationLimit: 3 },
        );
        expect(facilities(candidate)).toEqual([
          'Seattle 0',
          'Seattle 1',
          'Seattle 2',
          'Renton open',
        ]);
        expect(candidate.locationSummary).toEqual({
          totalLocations: 13,
          matchedLocations: 12,
          locationsTruncated: true,
          nearestRecruitingSiteAdded: true,
          retrieveFullStudyWith: 'clinicaltrials_get_study_record',
        });
      });

      it('keeps the summary absent when the admitted site completes the site list (#80)', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Seattle closed', 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            site('Renton open', 'Renton', 'Washington'),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Seattle closed', 'Renton open']);
        expect(candidate.locationSummary).toBeUndefined();
      });

      it('leaves a lone closed site alone when the study registers no other', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Seattle closed', 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Seattle closed']);
        expect(candidate.locationSummary).toBeUndefined();
      });

      it('admits nothing on the no-geographic-match path — every site already sits at the tier', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            ...Array.from({ length: 5 }, (_, i) =>
              site(`Toronto ${i}`, 'Toronto', 'Ontario', 'Canada', 'NOT_YET_RECRUITING'),
            ),
            site('Montreal open', 'Montreal', 'Quebec', 'Canada'),
          ]),
          { locationLimit: 2 },
        );
        // Recruiting sites sort ahead of closed ones inside a tier, so the cap
        // cannot bury the open site behind closed peers at the same tier.
        expect(facilities(candidate)).toEqual(['Montreal open', 'Toronto 0']);
        expect(candidate.locationSummary?.nearestRecruitingSiteAdded).toBeUndefined();
      });

      it('renders the admitted site and the reason it was added in content[] (#46/#91)', async () => {
        mockService.searchStudies.mockResolvedValue({
          studies: [closedCityOpenState()],
          totalCount: 1,
        });
        const ctx = createMockContext({ errors: findEligible.errors });
        const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
        const text = (findEligible.format!(result)[0] as { text: string }).text;

        expect(text).toContain(
          'Swedish Medical Center, Seattle, Washington, United States [NOT_YET_RECRUITING]',
        );
        expect(text).toContain(
          'UW Medicine Valley Medical Center, Renton, Washington, United States [RECRUITING]',
        );
        expect(text).toContain('showing 2 of 5');
        expect(text).toContain('1 match the requested location');
        expect(text).toContain('nearest recruiting site');
        expect(text).not.toContain('Deaconess');
      });
    });
  });
});

describe('conditionMatchScore (#79 lexical condition re-rank)', () => {
  it('scores an exact match tier 3, including single-word requests', () => {
    expect(conditionMatchScore(['Type 2 Diabetes'], ['Type 2 Diabetes'])).toBe(3);
    expect(conditionMatchScore(['Hypertension'], ['Hypertension'])).toBe(3);
  });

  it('scores a multi-word subtype tier 2 regardless of word order', () => {
    expect(conditionMatchScore(['Type 2 Diabetes Mellitus'], ['Type 2 Diabetes'])).toBe(2);
    expect(conditionMatchScore(['Diabetes Mellitus, Type 2'], ['Type 2 Diabetes'])).toBe(2);
    // Both word-order variants land in the SAME tier — the word-order fix.
    expect(conditionMatchScore(['Type 2 Diabetes Mellitus'], ['Type 2 Diabetes'])).toBe(
      conditionMatchScore(['Diabetes Mellitus, Type 2'], ['Type 2 Diabetes']),
    );
    // Multi-word even though "disease" is a generic token → subtype still credited.
    expect(
      conditionMatchScore(['Atherosclerotic Cardiovascular Disease'], ['Cardiovascular Disease']),
    ).toBe(2);
  });

  it('drops a single-word false friend to tier 1, below a genuine exact match', () => {
    // "Hypertension" must not credit the distinct disease "Pulmonary Arterial
    // Hypertension" as a subtype — the multi-word gate sends it to tier 1.
    expect(conditionMatchScore(['Pulmonary Arterial Hypertension'], ['Hypertension'])).toBe(1);
    expect(conditionMatchScore(['Pulmonary Arterial Hypertension'], ['Hypertension'])).toBeLessThan(
      conditionMatchScore(['Hypertension'], ['Hypertension']),
    );
  });

  it('scores a sibling subtype as shared-token only (tier 1)', () => {
    // "Type 1 Diabetes Mellitus" is not a superset of "Type 2 Diabetes" (no "2"),
    // so it stays tier 1 — a different disease, not a subtype.
    expect(conditionMatchScore(['Type 1 Diabetes Mellitus'], ['Type 2 Diabetes'])).toBe(1);
  });

  it('scores no direct overlap tier 0', () => {
    expect(conditionMatchScore(['Asthma'], ['Type 2 Diabetes'])).toBe(0);
    expect(conditionMatchScore([], ['Type 2 Diabetes'])).toBe(0);
  });
});
