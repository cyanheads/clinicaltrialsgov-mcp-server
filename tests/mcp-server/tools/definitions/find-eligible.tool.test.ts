/**
 * @fileoverview Tests for clinicaltrials_find_eligible tool.
 * @module tests/mcp-server/tools/definitions/find-eligible.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, rateLimited, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  placeWords,
} from '@/mcp-server/tools/definitions/find-eligible.tool.js';
import { readMarkdown } from '../../../helpers/commonmark.js';
import { expectLinearGrowth, LINE_BREAK_SHAPES } from '../../../helpers/cpu-timing.js';
import { loadStudyFixture } from '../../../helpers/format-parity.js';

/** The once-per-response caveat on the results path (#147), pinned verbatim. */
const CANDIDATE_NOTICE =
  'Candidates are matched on age, sex, location, recruitment status, and a fuzzy condition search only. Inclusion/exclusion criteria were not checked, and a candidate can exclude the requested condition. Review each with clinicaltrials_get_study_record (nctId) before treating it as a match.';

const baseInput = {
  age: 30,
  sex: 'ALL' as const,
  conditions: ['Type 2 Diabetes'],
  location: { country: 'United States', state: 'Washington', city: 'Seattle' },
};

/** The queryLocn `baseInput.location` builds (#164). */
const BASE_LOCATION_QUERY =
  'SEARCH[Location](Seattle AND (AREA[LocationState]"Washington" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"United States")';

describe('findEligible', () => {
  const mockService = { countStudies: vi.fn(), searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    // The two funnel stages; tests that read the funnel set their own counts.
    mockService.countStudies.mockResolvedValue(0);
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

    it('keeps the maxResults minimum of 1 and sets no maximum (#153)', () => {
      expect(() => findEligible.input!.parse({ ...baseInput, maxResults: 0 })).toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, maxResults: 1.5 })).toThrow();
      for (const maxResults of [1, 50, 51, 1000, 1001, 5000]) {
        expect(findEligible.input!.parse({ ...baseInput, maxResults }).maxResults).toBe(maxResults);
      }
    });

    it('defaults locationLimit, keeps its minimum of 1, and sets no maximum (#100, #153)', () => {
      expect(findEligible.input!.parse(baseInput).locationLimit).toBe(10);
      expect(() => findEligible.input!.parse({ ...baseInput, locationLimit: 0 })).toThrow();
      expect(() => findEligible.input!.parse({ ...baseInput, locationLimit: 1.5 })).toThrow();
      for (const locationLimit of [1, 500, 501, 1_000_000]) {
        expect(() => findEligible.input!.parse({ ...baseInput, locationLimit })).not.toThrow();
      }
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

    it('sends a single-token condition carrying punctuation or ( ) [ ] exactly as written', async () => {
      // Only location parts take the punctuation-aware quoting; a condition is
      // quoted on whitespace alone, so these keep the match sets they have
      // always had upstream.
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(
        findEligible.input!.parse({
          ...baseInput,
          conditions: ['COVID-19(SARS-CoV-2)', 'AREA[Condition]melanoma', 'Non-Hodgkin Lymphoma'],
        }),
        ctx,
      );

      const expected = 'COVID-19(SARS-CoV-2) OR AREA[Condition]melanoma OR "Non-Hodgkin Lymphoma"';
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryCond: expected }),
        ctx,
      );
      expect(
        mockService.countStudies.mock.calls.map(
          (call) => (call[0] as { queryCond: string }).queryCond,
        ),
      ).toEqual([expected, expected]);
      expect((getEnrichment(ctx).searchCriteria as { conditionQuery: string }).conditionQuery).toBe(
        expected,
      );
    });

    it('builds location query from city, state, country', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryLocn: BASE_LOCATION_QUERY,
        }),
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
        expect.objectContaining({
          queryLocn: 'SEARCH[Location](AREA[LocationCountry]"United States")',
        }),
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
      expect(text).toContain('Demographic criteria: Age: ≥18 Years');
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
        location: BASE_LOCATION_QUERY,
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

    // Each hint is proven on the stage it widens: condition and location both
    // match and the demographics stage is the one that collapsed (#50).
    describe('hints on a demographics-stage collapse', () => {
      beforeEach(() => {
        mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
        mockService.countStudies.mockResolvedValue(5);
      });

      const noticeFor = async (overrides: Record<string, unknown>) => {
        const ctx = createMockContext({ errors: findEligible.errors });
        await findEligible.handler(findEligible.input!.parse({ ...baseInput, ...overrides }), ctx);
        return getEnrichment(ctx).notice as string;
      };

      it('hints about extreme age in enrichment notice', async () => {
        expect(await noticeFor({ age: 120 })).toContain('extreme');
      });

      it('hints about sex restriction in enrichment notice', async () => {
        expect(await noticeFor({ sex: 'MALE' })).toContain('sex="ALL"');
      });

      it('hints about healthy volunteer restriction in enrichment notice', async () => {
        expect(await noticeFor({ healthyVolunteer: true })).toContain('healthy volunteers');
      });

      it('hints about recruiting-only restriction in enrichment notice', async () => {
        expect(await noticeFor({})).toContain('recruitingOnly=false');
      });

      it('words the demographics-stage notice as it always has', async () => {
        expect(await noticeFor({ age: 120, sex: 'MALE', healthyVolunteer: true })).toBe(
          'No studies found for "Type 2 Diabetes" matching the specified criteria. 5 studies match condition + location, but none pass the age/sex/status filters. Age 120 is at the extreme of typical trial ranges. Few trials enroll this age group. Try sex="ALL" to include studies not restricted by sex. Set recruitingOnly=false to include completed, active, and not-yet-recruiting studies. Many studies do not accept healthy volunteers. Set healthyVolunteer=false if the patient has a relevant condition.',
        );
      });
    });

    it('hints about widening the location in enrichment notice', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      mockService.countStudies.mockImplementation(async (params: { queryLocn?: string }) =>
        params.queryLocn ? 0 : 40,
      );
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('Remove city/state to search the whole country');
      expect(enrichment.notice).toContain('geoFilter');
    });

    // Every step the no-match notice names must widen the stage where the
    // funnel collapsed: advice for a later stage cannot help, and advice that
    // repeats the request sends the caller round in a circle (#185).
    describe('no-match notice names only steps that widen the collapsed stage (#185)', () => {
      const GEO_STEP =
        "geocode the patient's location and replay searchCriteria through clinicaltrials_search_studies with geoFilter=distance(lat,lon,radius), the radius carrying a mi or km suffix (distance(47.6,-122.3,50mi)), in place of locationQuery and with includeUnknownEnrollment=true";
      const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

      const run = async (input: z.input<typeof findEligible.input>) => {
        const result = await runToolContract(findEligible, input);
        const notice = (result.structuredContent as { notice: string }).notice;
        const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');
        return { notice, text };
      };

      beforeEach(() => {
        mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      });

      describe('location stage — the condition matches, the location does not', () => {
        beforeEach(() => {
          mockService.countStudies.mockImplementation(async (params: { queryLocn?: string }) =>
            params.queryLocn ? 0 : 1224,
          );
        });

        it('gives a country-only request the geoFilter replay and no country advice', async () => {
          const { notice } = await run({
            ...baseInput,
            conditions: ['sickle cell'],
            location: { country: 'Tuvalu' },
          });

          expect(notice).toBe(
            `No studies found for "sickle cell" matching the specified criteria. 1224 studies match the condition, but none are in the specified location. To widen the search past the country, ${GEO_STEP}.`,
          );
          expect(notice).not.toContain('just the country');
          expect(notice).not.toContain('Remove city/state');
        });

        it.each([
          { shape: 'city', location: { country: 'United States', city: 'Nome' } },
          { shape: 'state', location: { country: 'United States', state: 'Wyoming' } },
          {
            shape: 'city and state',
            location: { country: 'United States', state: 'Alaska', city: 'Nome' },
          },
        ])(
          'names removing city/state once for a $shape request, then the geoFilter replay',
          async ({ location }) => {
            const { notice } = await run({ ...baseInput, conditions: ['sickle cell'], location });

            expect(notice).toBe(
              `No studies found for "sickle cell" matching the specified criteria. 1224 studies match the condition, but none are in the specified location. Remove city/state to search the whole country, or ${GEO_STEP}.`,
            );
            expect(occurrences(notice, 'city/state')).toBe(1);
            expect(notice).not.toContain('just the country');
          },
        );

        it('reaches content[] once, through the enrichment trailer', async () => {
          const { notice, text } = await run({ ...baseInput, location: { country: 'Tuvalu' } });

          expect(occurrences(text, 'replay searchCriteria')).toBe(1);
          expect(text).toContain('No candidate studies found.');
          expect(notice).toContain('replay searchCriteria');
        });
      });

      describe('condition stage — nothing matches the condition alone', () => {
        // Every later-stage hint would fire here if the branch still offered them.
        const everyLaterHint = {
          ...baseInput,
          conditions: ['qqzxvw nonexistent disorder'],
          age: 120,
          sex: 'MALE' as const,
          healthyVolunteer: true,
          recruitingOnly: true,
        };

        it('names only condition-level steps', async () => {
          const { notice } = await run(everyLaterHint);

          expect(notice).toBe(
            'No studies found for "qqzxvw nonexistent disorder" matching the specified criteria. No study matches the condition alone, before any location, age, sex, healthy-volunteer, or status filter, so relaxing those cannot help. Add a synonym, a broader term, or a MeSH term as another conditions entry (entries are ORed), or use fewer words: an entry with spaces matches as a phrase.',
          );
        });

        it.each([
          'extreme',
          'sex="ALL"',
          'healthyVolunteer=false',
          'recruitingOnly=false',
          'just the country',
          'city/state',
          'geoFilter',
        ])('offers no %s step', async (step) => {
          const { notice } = await run(everyLaterHint);
          expect(notice).not.toContain(step);
        });
      });
    });

    it('sets the candidate notice when studies are found (#147)', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBe(CANDIDATE_NOTICE);
    });
  });

  // `age` is read in `ageUnit`, passed upstream unconverted; ClinicalTrials.gov
  // compares ages across units itself. Years stays the default and its requests
  // and surfaces are unchanged.
  describe('age units (#162)', () => {
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.content as { text: string }[]).map((b) => b.text).join('\n');
    const yearsFilter =
      '(AREA[MinimumAge]RANGE[MIN, 30 years] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[30 years, MAX] OR AREA[MaximumAge]MISSING)';

    beforeEach(() => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    });

    it('sends and echoes a years age with no unit field when ageUnit is omitted', async () => {
      const result = await runToolContract(findEligible, baseInput);

      expect(mockService.searchStudies.mock.calls[0]![0].filterAdvanced).toBe(yearsFilter);
      const sc = (result.structuredContent as { searchCriteria: Record<string, unknown> })
        .searchCriteria;
      expect(sc.age).toBe(30);
      expect(sc).not.toHaveProperty('ageUnit');
      expect(sc.advancedFilter).toBe(yearsFilter);
      expect(readMarkdown(textOf(result))).toContain(
        `Search: conditions=[Type 2 Diabetes] | location=${BASE_LOCATION_QUERY} | age=30 | sex=ALL`,
      );
    });

    it('names an extreme years age without a unit', async () => {
      // The demographics stage collapsed: the one the age note can widen.
      mockService.countStudies.mockResolvedValue(5);
      const result = await runToolContract(findEligible, { ...baseInput, age: 120 });

      expect((result.structuredContent as { notice: string }).notice).toContain(
        ' Age 120 is at the extreme of typical trial ranges. Few trials enroll this age group.',
      );
    });

    it.each(['years', '', ' ', 'Years', 'year', ' YEARS '])(
      'treats ageUnit %j exactly as an omitted unit on both surfaces',
      async (ageUnit) => {
        const omitted = await runToolContract(findEligible, baseInput);
        const omittedCall = mockService.searchStudies.mock.calls[0]![0];
        vi.clearAllMocks();
        mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
        mockService.countStudies.mockResolvedValue(0);

        const given = await runToolContract(findEligible, { ...baseInput, ageUnit });

        expect(given.isError).toBeFalsy();
        expect(mockService.searchStudies.mock.calls[0]![0]).toEqual(omittedCall);
        expect(given.structuredContent).toEqual(omitted.structuredContent);
        expect(textOf(given)).toBe(textOf(omitted));
      },
    );

    it('sends months unconverted in both age clauses and echoes the unit', async () => {
      const result = await runToolContract(findEligible, {
        ...baseInput,
        age: 7,
        ageUnit: 'months',
      });
      const monthsFilter =
        '(AREA[MinimumAge]RANGE[MIN, 7 months] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[7 months, MAX] OR AREA[MaximumAge]MISSING)';

      expect(result.isError).toBeFalsy();
      expect(mockService.searchStudies.mock.calls[0]![0].filterAdvanced).toBe(monthsFilter);
      const sc = (result.structuredContent as { searchCriteria: Record<string, unknown> })
        .searchCriteria;
      expect(sc).toMatchObject({ age: 7, ageUnit: 'months', advancedFilter: monthsFilter });
      const seen = readMarkdown(textOf(result));
      expect(seen).toContain('| age=7 months | sex=ALL');
      expect(seen).toContain(`advancedFilter=${monthsFilter}`);
    });

    it.each(['weeks', 'days'] as const)('sends and echoes %s the same way', async (ageUnit) => {
      const result = await runToolContract(findEligible, { ...baseInput, age: 30, ageUnit });

      const filter = mockService.searchStudies.mock.calls[0]![0].filterAdvanced as string;
      expect(filter).toContain(`AREA[MinimumAge]RANGE[MIN, 30 ${ageUnit}]`);
      expect(filter).toContain(`AREA[MaximumAge]RANGE[30 ${ageUnit}, MAX]`);
      expect(filter).not.toContain('years');
      expect(result.structuredContent).toMatchObject({ searchCriteria: { age: 30, ageUnit } });
      expect(readMarkdown(textOf(result))).toContain(`| age=30 ${ageUnit} | sex=ALL`);
    });

    it.each(['years', 'months', 'weeks', 'days'])('keeps age an integer 0-120 in %s', (ageUnit) => {
      for (const age of [0, 120]) {
        expect(() => findEligible.input!.parse({ ...baseInput, age, ageUnit })).not.toThrow();
      }
      for (const age of [-1, 121, 0.5, 6.5]) {
        expect(() => findEligible.input!.parse({ ...baseInput, age, ageUnit })).toThrow();
      }
    });

    it.each(['Months', 'month', ' MONTH '])(
      'reads ageUnit %j as months on both surfaces',
      async (ageUnit) => {
        const canonical = await runToolContract(findEligible, {
          ...baseInput,
          age: 7,
          ageUnit: 'months',
        });
        const canonicalCall = mockService.searchStudies.mock.calls[0]![0];
        vi.clearAllMocks();
        mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
        mockService.countStudies.mockResolvedValue(0);

        const given = await runToolContract(findEligible, { ...baseInput, age: 7, ageUnit });

        expect(given.isError).toBeFalsy();
        expect(mockService.searchStudies.mock.calls[0]![0]).toEqual(canonicalCall);
        expect(given.structuredContent).toEqual(canonical.structuredContent);
        expect(textOf(given)).toBe(textOf(canonical));
      },
    );

    it.each(['fortnights', 'hours', 'mo', 's', 'monthss', 7])(
      'rejects ageUnit %j',
      async (ageUnit) => {
        const result = await runToolContract(findEligible, { ...baseInput, ageUnit });

        expect(result.isError).toBe(true);
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    // The note judges the age in years: a raw count read as years would call
    // 120 months (10 years) extreme and miss nothing else.
    it.each([
      { age: 7, ageUnit: 'months', extreme: true },
      { age: 12, ageUnit: 'months', extreme: true },
      { age: 13, ageUnit: 'months', extreme: false },
      { age: 120, ageUnit: 'months', extreme: false },
      { age: 52, ageUnit: 'weeks', extreme: true },
      { age: 53, ageUnit: 'weeks', extreme: false },
      { age: 120, ageUnit: 'days', extreme: true },
    ])(
      'judges $age $ageUnit extreme=$extreme on the demographics stage, never the condition stage',
      async ({ age, ageUnit, extreme }) => {
        const note = `Age ${age} ${ageUnit} is at the extreme of typical trial ranges. Few trials enroll this age group.`;
        // Nothing matches the condition, so no age can widen it (#185).
        const none = await runToolContract(findEligible, { ...baseInput, age, ageUnit });
        // Condition + location match, demographics do not: the stage branch.
        mockService.countStudies.mockResolvedValue(5);
        const staged = await runToolContract(findEligible, { ...baseInput, age, ageUnit });

        const noneNotice = (none.structuredContent as { notice: string }).notice;
        expect(noneNotice).not.toContain('is at the extreme');
        const notice = (staged.structuredContent as { notice: string }).notice;
        expect(notice.includes(note)).toBe(extreme);
        expect(notice).not.toMatch(/Age \d+ is at the extreme/);
        expect(textOf(staged).includes(note)).toBe(extreme);
      },
    );
  });

  // maxResults above the per-call cap is served at the cap and disclosed,
  // rather than rejected; the schema sets no maximum above it.
  describe('maxResults cap (#153)', () => {
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.content as { text: string }[]).map((b) => b.text).join('\n');
    const candidates = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        protocolSection: {
          identificationModule: { nctId: `NCT${String(i + 1).padStart(8, '0')}` },
          statusModule: { overallStatus: 'RECRUITING' },
        },
      }));
    const capNotice = (requested: number, shown: number, total: number) =>
      `Requested maxResults ${requested} is above this tool's per-call cap of 50, so this response holds ${shown} of ${total} candidates. Replay searchCriteria through clinicaltrials_search_studies with includeUnknownEnrollment=true to page through the rest.`;

    it('leaves maxResults 50 untouched when more studies match', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: candidates(50), totalCount: 312 });

      const result = await runToolContract(findEligible, { ...baseInput, maxResults: 50 });

      expect(mockService.searchStudies.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty('truncated');
      expect(sc).not.toHaveProperty('shown');
      expect(sc).not.toHaveProperty('cap');
      expect(sc.notice).toBe(CANDIDATE_NOTICE);
    });

    it('fetches the cap and discloses the cut on both surfaces, after the candidate caveat', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: candidates(50), totalCount: 312 });

      const result = await runToolContract(findEligible, { ...baseInput, maxResults: 200 });

      expect(result.isError).toBeFalsy();
      expect(mockService.searchStudies.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).toMatchObject({ truncated: true, shown: 50, cap: 50, totalCount: 312 });
      expect(sc.studies as unknown[]).toHaveLength(50);
      const notice = `${CANDIDATE_NOTICE} ${capNotice(200, 50, 312)}`;
      expect(sc.notice).toBe(notice);
      const text = textOf(result);
      expect(text).toContain('Found 312 candidate studies (showing 50)');
      expect(text).toContain(`> ${notice}`);
      for (const line of ['**truncated:** true', '**shown:** 50', '**cap:** 50']) {
        expect(text).toContain(line);
      }
      expect(text.split(CANDIDATE_NOTICE)).toHaveLength(2);
      expect(`${JSON.stringify(sc)}\n${text}`).not.toMatch(/CT_[A-Z_]+/);
    });

    it('discloses a one-study cut at the lower edge of the band', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: candidates(50), totalCount: 51 });

      const result = await runToolContract(findEligible, { ...baseInput, maxResults: 51 });

      expect(mockService.searchStudies.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
      expect(result.structuredContent).toMatchObject({ truncated: true, shown: 50, cap: 50 });
      expect((result.structuredContent as { notice: string }).notice).toBe(
        `${CANDIDATE_NOTICE} ${capNotice(51, 50, 51)}`,
      );
    });

    it('serves maxResults far above the cap (5000) at the cap and discloses it on both surfaces', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: candidates(50), totalCount: 4000 });

      const result = await runToolContract(findEligible, { ...baseInput, maxResults: 5000 });

      expect(result.isError).toBeFalsy();
      expect(mockService.searchStudies.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).toMatchObject({ truncated: true, shown: 50, cap: 50, totalCount: 4000 });
      expect(sc.studies as unknown[]).toHaveLength(50);
      const notice = `${CANDIDATE_NOTICE} ${capNotice(5000, 50, 4000)}`;
      expect(sc.notice).toBe(notice);
      const text = textOf(result);
      expect(text).toContain(`> ${notice}`);
      for (const line of ['**truncated:** true', '**shown:** 50', '**cap:** 50']) {
        expect(text).toContain(line);
      }
    });

    it('adds nothing when every match fits under the cap', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: candidates(30), totalCount: 30 });

      const result = await runToolContract(findEligible, { ...baseInput, maxResults: 200 });

      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.studies as unknown[]).toHaveLength(30);
      expect(sc).not.toHaveProperty('truncated');
      expect(sc).not.toHaveProperty('shown');
      expect(sc).not.toHaveProperty('cap');
      expect(sc.notice).toBe(CANDIDATE_NOTICE);
    });

    it('keeps the no-match notice and adds no cap fields on an empty result', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });

      const result = await runToolContract(findEligible, { ...baseInput, maxResults: 200 });

      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty('truncated');
      expect(sc.notice).toMatch(/^No studies found for "Type 2 Diabetes"/);
      expect(sc.notice).not.toContain('per-call cap');
    });

    it.each([0, 50.5])('rejects maxResults %j before reaching the service', async (bad) => {
      const result = await runToolContract(findEligible, { ...baseInput, maxResults: bad });

      expect(result.isError).toBe(true);
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    });

    it('advertises no maximum on maxResults or locationLimit', () => {
      type Bounds = { default?: number; maximum?: number; minimum?: number };
      const props = (
        z.toJSONSchema(findEligible.input!) as unknown as { properties: Record<string, Bounds> }
      ).properties;

      for (const key of ['maxResults', 'locationLimit']) {
        // `.int()` alone serializes Zod's safe-integer bound; nothing tighter.
        expect(props[key]?.maximum ?? Number.MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
        expect(props[key]).toMatchObject({ minimum: 1, default: 10 });
      }
    });

    it('describes maxResults by its default and the cap, stated once', () => {
      const { description } = findEligible.input!.shape.maxResults;
      expect(description).toMatch(/^Maximum candidates to return\. Default 10; a larger value/);
      expect(description?.match(/\b50\b/g)).toHaveLength(1);
      expect(description).not.toContain('1000');
    });
  });

  // The tool matches demographics and a fuzzy condition search; it never reads
  // inclusion/exclusion criteria, so a returned study can exclude the very
  // condition requested. Results are candidates, not eligibility determinations.
  describe('candidate framing (#147)', () => {
    const studyWith = (nctId: string) => ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: `Study ${nctId}` },
        statusModule: { overallStatus: 'RECRUITING' },
      },
    });

    const countOf = (text: string, needle: string) => text.split(needle).length - 1;

    it.each([1, 3])('carries the notice once on both surfaces for %i studies', async (n) => {
      const studies = Array.from({ length: n }, (_, i) => studyWith(`NCT0000000${i}`));
      mockService.searchStudies.mockResolvedValue({ studies, totalCount: n });

      const result = await runToolContract(findEligible, baseInput);
      const structured = result.structuredContent as { notice?: string; studies: unknown[] };
      const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');

      expect(structured.studies).toHaveLength(n);
      expect(structured.notice).toBe(CANDIDATE_NOTICE);
      expect(countOf(text, CANDIDATE_NOTICE)).toBe(1);
      expect(text).toContain(`> ${CANDIDATE_NOTICE}`);
    });

    it('keeps the stage-specific recovery notice, with no eligibility caveat, on zero results', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });

      const result = await runToolContract(findEligible, baseInput);
      const structured = result.structuredContent as { notice?: string };
      const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');

      expect(structured.notice).toMatch(/^No studies found for "Type 2 Diabetes"/);
      expect(structured.notice).not.toContain('Inclusion/exclusion');
      expect(text).not.toContain('Inclusion/exclusion');
    });

    it('never calls a result an eligible study on content[]', async () => {
      mockService.searchStudies.mockResolvedValue({
        studies: [studyWith('NCT00000001')],
        totalCount: 7,
      });
      const result = await runToolContract(findEligible, baseInput);
      const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');

      expect(text).toContain('Found 7 candidate studies (showing 1)');
      expect(text).not.toMatch(/eligible stud/i);
    });

    it('mentions eligibility in the description only to say the criteria were not checked', () => {
      const description = findEligible.description;
      expect(description).toContain('inclusion/exclusion criteria are not checked');
      expect(description).toContain('clinicaltrials_get_study_record');
      expect(description).not.toMatch(/eligible (recruiting )?(clinical )?trials/i);
      expect(description).not.toMatch(/matching eligibility criteria/i);
    });

    it('says the same in the studies output description', () => {
      const studiesDescription = findEligible.output.shape.studies.description ?? '';
      expect(studiesDescription).toContain('Candidate studies');
      expect(studiesDescription).toContain('inclusion/exclusion criteria are not checked');
      expect(studiesDescription).toContain('clinicaltrials_get_study_record');
      expect(studiesDescription).not.toMatch(/eligibility (and location )?fields/i);
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
        expect.objectContaining({
          queryLocn: 'SEARCH[Location](AREA[LocationCountry]"United States")',
        }),
        ctx,
      );
    });

    it('declares the blank_value reason on the tool contract', () => {
      expect(findEligible.errors?.map((e) => e.reason)).toContain('blank_value');
    });
  });

  // A comma-joined location reaches upstream as loose tokens, so a study that
  // lists exactly the requested site can score zero — the tool then reports no
  // trials in a location that has them, and tells the patient to remove it.
  describe('location query composition (#118)', () => {
    /** The queryLocn of every upstream call the handler made: the main search, then the two stage counts. */
    const locationArgs = () =>
      [...mockService.searchStudies.mock.calls, ...mockService.countStudies.mock.calls].map(
        (call) => (call[0] as { queryLocn?: string }).queryLocn,
      );

    const runWithLocation = async (location: Record<string, string>) => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, location }), ctx);
      return ctx;
    };

    it('quotes each multiword component and joins with AND', async () => {
      await runWithLocation({
        country: 'United States',
        state: 'New York',
        city: 'East Northport',
      });
      expect(locationArgs()).toContain(
        'SEARCH[Location]("East Northport" AND (AREA[LocationState]"New York" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"United States")',
      );
    });

    it('sends the identical expression to the main search and the location-stage funnel', async () => {
      // A funnel counting a different expression than the search returns is a
      // diagnostic that contradicts the result it is supposed to explain.
      await runWithLocation({
        country: 'United States',
        state: 'New York',
        city: 'East Northport',
      });
      const supplied = locationArgs().filter((locn) => locn !== undefined);
      // Main search + location-stage funnel; the condition-only stage sends none.
      expect(supplied).toHaveLength(2);
      expect(new Set(supplied)).toEqual(
        new Set([
          'SEARCH[Location]("East Northport" AND (AREA[LocationState]"New York" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"United States")',
        ]),
      );
    });

    it('echoes the corrected expression as searchCriteria.location', async () => {
      const ctx = await runWithLocation({
        country: 'United States',
        state: 'New York',
        city: 'East Northport',
      });
      const sc = getEnrichment(ctx).searchCriteria as Record<string, unknown>;
      expect(sc.location).toBe(
        'SEARCH[Location]("East Northport" AND (AREA[LocationState]"New York" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"United States")',
      );
    });

    it('leaves a single-word city bare, AND-joined', async () => {
      await runWithLocation({ country: 'Canada', state: 'Ontario', city: 'Toronto' });
      expect(locationArgs()).toContain(
        'SEARCH[Location](Toronto AND (AREA[LocationState]"Ontario" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"Canada")',
      );
    });

    it('quotes a lone multiword country', async () => {
      await runWithLocation({ country: 'United States' });
      expect(locationArgs()).toContain('SEARCH[Location](AREA[LocationCountry]"United States")');
    });

    it('quotes a lone single-word country too (#164)', async () => {
      await runWithLocation({ country: 'Canada' });
      expect(locationArgs()).toContain('SEARCH[Location](AREA[LocationCountry]"Canada")');
    });

    it('strips an embedded double quote instead of letting it split the phrase', async () => {
      // Upstream has no working escape for a `"` inside a quoted phrase — an
      // unescaped one silently reparses into a plausible but wrong result set.
      await runWithLocation({
        country: 'United States',
        state: 'New York',
        city: 'East "Northport" City',
      });
      expect(locationArgs()).toContain(
        'SEARCH[Location]("East Northport City" AND (AREA[LocationState]"New York" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"United States")',
      );
    });

    it('renders the corrected expression in the content[] reproduce trailer', () => {
      // The trailer is the content[]-only caller's copy of the replay query —
      // it must carry the same expression the search actually ran.
      const text = findEligible.enrichmentTrailer!.searchCriteria!.render!({
        conditions: ['Type 2 Diabetes'],
        location: 'SEARCH[Location]("East Northport" AND "New York" AND "United States")',
        age: 60,
        sex: 'MALE',
        conditionQuery: '"Type 2 Diabetes"',
        statusFilter: ['RECRUITING'],
      });
      expect(readMarkdown(text)).toContain(
        'locationQuery=SEARCH[Location]("East Northport" AND "New York" AND "United States")',
      );
    });
  });

  // A bare AND across location parts matches them across a study's whole site
  // list — the city at one site, the country at another. SEARCH[Location](…)
  // binds every part to the same site (#159).
  describe('single-site location binding (#159)', () => {
    const run = async (location: Record<string, string>) => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, location }), ctx);
      return ctx;
    };
    const mainLocn = () =>
      (mockService.searchStudies.mock.calls[0]![0] as { queryLocn: string }).queryLocn;
    const stageLocns = () =>
      mockService.countStudies.mock.calls.map(
        (call) => (call[0] as { queryLocn?: string }).queryLocn,
      );

    it('wraps the AND-joined parts in SEARCH[Location](…) on the search, the stage count, and the echo', async () => {
      const ctx = await run({ city: 'London', country: 'Canada' });
      const expected = 'SEARCH[Location](London AND AREA[LocationCountry]"Canada")';
      expect(mainLocn()).toBe(expected);
      expect(stageLocns()).toEqual([undefined, expected]);
      expect((getEnrichment(ctx).searchCriteria as { location: string }).location).toBe(expected);
    });

    it('carries the wrapped string into the content[] reproduce trailer', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const result = await runToolContract(findEligible, {
        ...baseInput,
        location: { city: 'London', country: 'United Kingdom' },
      });
      const seen = readMarkdown(
        (result.content as { text: string }[]).map((b) => b.text).join('\n'),
      );
      const expected = 'SEARCH[Location](London AND AREA[LocationCountry]"United Kingdom")';
      expect(seen).toContain(`location=${expected}`);
      expect(seen).toContain(`locationQuery=${expected}`);
      expect(result.structuredContent).toMatchObject({ searchCriteria: { location: expected } });
    });

    it('wraps a lone country too', async () => {
      await run({ country: 'United States' });
      expect(mainLocn()).toBe('SEARCH[Location](AREA[LocationCountry]"United States")');
    });

    // Bare inside the wrapper, a hyphenated part under-matches: 4 cancer studies
    // for Winston-Salem, NC against 202 with the part quoted.
    it.each([
      [
        { city: 'Winston-Salem', state: 'North Carolina' },
        '"Winston-Salem" AND (AREA[LocationState]"North Carolina" OR AREA[LocationState]MISSING)',
      ],
      [{ city: "L'Aquila" }, '"L\'Aquila"'],
      [
        { city: 'St.Louis', state: 'MO' },
        '"St.Louis" AND (AREA[LocationState]"MO" OR AREA[LocationState]MISSING)',
      ],
    ])(
      'quotes a single-token part carrying punctuation (%j) inside the wrapper',
      async (parts, quoted) => {
        await run({ ...parts, country: 'United States' });
        const expected = `SEARCH[Location](${quoted} AND AREA[LocationCountry]"United States")`;
        expect(mainLocn()).toBe(expected);
        expect(stageLocns()[1]).toBe(expected);
      },
    );

    it.each([
      ['a)OR(b', '"a)OR(b"'],
      ['(a', '"(a"'],
      ['a)', '"a)"'],
      ['AREA[LocationCountry]Canada', '"AREA[LocationCountry]Canada"'],
      ['x]y[', '"x]y["'],
    ])(
      'quotes a part containing a grouping character (%j) so it cannot close the wrapper',
      async (city, quoted) => {
        await run({ city, country: 'Canada' });
        const expected = `SEARCH[Location](${quoted} AND AREA[LocationCountry]"Canada")`;
        expect(mainLocn()).toBe(expected);
        expect(stageLocns()[1]).toBe(expected);
      },
    );

    it('keeps the grouping-character part inside the wrapper as one balanced phrase', async () => {
      await run({ city: 'a)OR(b', state: '[x', country: 'Canada' });
      const locn = mainLocn();
      // Outside quoted phrases, the only parentheses left are the wrapper's and
      // the state arm's own.
      const unquoted = locn.replace(/"[^"]*"/g, '');
      expect(unquoted).toBe(
        'SEARCH[Location]( AND (AREA[LocationState] OR AREA[LocationState]MISSING) AND AREA[LocationCountry])',
      );
    });
  });

  // As plain terms, state and country matched any field of a site: a state
  // named like a city or facility (Washington D.C., Washington University in
  // St. Louis) admitted studies with no site there, and Mexico matched New
  // Mexico. Each is bound to its own field and always quoted; a site that files
  // no state passes only when a city locates it (#164).
  describe('state and country bound to their site fields (#164)', () => {
    const run = async (location: Record<string, string>) => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse({ ...baseInput, location }), ctx);
      return ctx;
    };
    const mainLocn = () =>
      (mockService.searchStudies.mock.calls[0]![0] as { queryLocn: string }).queryLocn;
    const stageLocns = () =>
      mockService.countStudies.mock.calls.map(
        (call) => (call[0] as { queryLocn?: string }).queryLocn,
      );
    /** The query with every quoted phrase emptied, reading `\` as an escape the way upstream does. */
    const skeleton = (locn: string) => locn.replace(/"(?:[^"\\]|\\.)*"/g, '""');

    it('binds state and country, with no MISSING arm, when no city is given', async () => {
      const ctx = await run({ state: 'Washington', country: 'United States' });
      const expected =
        'SEARCH[Location](AREA[LocationState]"Washington" AND AREA[LocationCountry]"United States")';
      expect(mainLocn()).toBe(expected);
      expect(stageLocns()).toEqual([undefined, expected]);
      expect((getEnrichment(ctx).searchCriteria as { location: string }).location).toBe(expected);
    });

    it('lets a site that files no state pass when a city is given', async () => {
      await run({ city: 'London', state: 'England', country: 'United Kingdom' });
      expect(mainLocn()).toBe(
        'SEARCH[Location](London AND (AREA[LocationState]"England" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"United Kingdom")',
      );
    });

    it('keeps the city a search term and quotes a single-word country', async () => {
      await run({ city: 'London', country: 'Canada' });
      expect(mainLocn()).toBe('SEARCH[Location](London AND AREA[LocationCountry]"Canada")');
    });

    it('sends a state spelled like the MISSING operator as a literal', async () => {
      await run({ state: 'Missing', country: 'United States' });
      expect(mainLocn()).toBe(
        'SEARCH[Location](AREA[LocationState]"Missing" AND AREA[LocationCountry]"United States")',
      );
    });

    it('strips an embedded double quote from a bound state and country', async () => {
      await run({ state: 'New "York"', country: '"United" States' });
      expect(mainLocn()).toBe(
        'SEARCH[Location](AREA[LocationState]"New York" AND AREA[LocationCountry]"United States")',
      );
    });

    it.each([
      'a)OR(b',
      '(a',
      'x]y[',
      'AREA[LocationCountry]Canada',
      ') OR AREA[OverallStatus]COMPLETED OR (',
    ])('keeps a state and country carrying %j each one literal phrase', async (value) => {
      await run({ city: 'London', state: value, country: value });
      expect(skeleton(mainLocn())).toBe(
        'SEARCH[Location](London AND (AREA[LocationState]"" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"")',
      );
    });

    // A trailing backslash would escape its own closing quote and leave the
    // phrase open, so the next part's closer would regroup the query outside
    // the wrapper. Every quoted slot doubles it.
    it.each([
      [
        { city: 'Paris\\', state: ') OR (x', country: 'France' },
        'SEARCH[Location]("" AND (AREA[LocationState]"" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"")',
      ],
      [
        { state: 'Ile\\', country: ') OR AREA[OverallStatus]COMPLETED OR (' },
        'SEARCH[Location](AREA[LocationState]"" AND AREA[LocationCountry]"")',
      ],
      [
        { city: 'London', state: 'England\\', country: ']) OR (' },
        'SEARCH[Location](London AND (AREA[LocationState]"" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"")',
      ],
      [{ country: 'France\\' }, 'SEARCH[Location](AREA[LocationCountry]"")'],
      [
        { city: 'x\\', state: '\\', country: '\\\\' },
        'SEARCH[Location]("" AND (AREA[LocationState]"" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"")',
      ],
    ])(
      'keeps a trailing backslash in %j from escaping its closing quote',
      async (location, expected) => {
        await run(location);
        expect(skeleton(mainLocn())).toBe(expected);
        expect(stageLocns()[1]).toBe(mainLocn());
      },
    );

    it('doubles the backslash inside a bound state', async () => {
      await run({ state: 'Ile\\', country: 'France' });
      expect(mainLocn()).toBe(
        'SEARCH[Location](AREA[LocationState]"Ile\\\\" AND AREA[LocationCountry]"France")',
      );
    });

    // The country field resolves the registry's synonyms (UK, Türkiye) but
    // folds no diacritics, unlike the state field: México matches no study
    // while Mexico matches every Mexican site. A country carrying diacritics is
    // also tried without them, on the same site field.
    it.each([
      [
        { country: 'México' },
        'SEARCH[Location]((AREA[LocationCountry]"México" OR AREA[LocationCountry]"Mexico"))',
      ],
      [
        { city: 'Monterrey', state: 'Nuevo León', country: 'México' },
        'SEARCH[Location](Monterrey AND (AREA[LocationState]"Nuevo León" OR AREA[LocationState]MISSING) AND (AREA[LocationCountry]"México" OR AREA[LocationCountry]"Mexico"))',
      ],
      [
        { country: 'Türkiye' },
        'SEARCH[Location]((AREA[LocationCountry]"Türkiye" OR AREA[LocationCountry]"Turkiye"))',
      ],
    ])('also tries the country in %j without its diacritics', async (location, expected) => {
      const ctx = await run(location);
      expect(mainLocn()).toBe(expected);
      expect(stageLocns()).toEqual([undefined, expected]);
      expect((getEnrichment(ctx).searchCriteria as { location: string }).location).toBe(expected);
    });

    it('keeps both country arms literal when the country carries grouping characters', async () => {
      await run({ city: 'London', state: 'x', country: 'Mé)x OR (ico\\' });
      expect(skeleton(mainLocn())).toBe(
        'SEARCH[Location](London AND (AREA[LocationState]"" OR AREA[LocationState]MISSING) AND (AREA[LocationCountry]"" OR AREA[LocationCountry]""))',
      );
    });
  });

  // The query builders strip every `"` while building the query, so a value made of
  // quotes and whitespace reaches upstream empty or as a bare `" "` phrase: the
  // filter drops, matches nothing, or breaks the parse. Blankness is judged on
  // the value the builder emits.
  describe('quote-only and whitespace-only values (#145)', () => {
    const usInput = {
      ...baseInput,
      location: { country: 'United States' },
    };

    /** The queryLocn of every upstream call that sent one: the main search, then the location-stage count. */
    const sentLocations = () =>
      [...mockService.searchStudies.mock.calls, ...mockService.countStudies.mock.calls]
        .map((call) => (call[0] as { queryLocn?: string }).queryLocn)
        .filter((locn) => locn !== undefined);

    const run = async (overrides: Record<string, unknown>) => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse({ ...usInput, ...overrides }), ctx);
      return ctx;
    };

    beforeEach(() => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    });

    it.each([[['""']], [['" "']], [['""', 'ALS']], [['Diabetes', '" "']]])(
      'rejects conditions %j as blank_value before any upstream call',
      async (conditions) => {
        await expect(run({ conditions })).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_value', param: 'conditions' },
        });
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it.each(['""', '" "'])(
      'rejects location.country %j as blank_value before any upstream call',
      async (country) => {
        await expect(run({ location: { country } })).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_value', param: 'location.country' },
        });
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it('says that double-quote characters do not count as content', async () => {
      const error = await run({ conditions: ['""'] }).catch((e: unknown) => e);
      expect((error as Error).message).toContain(
        `Double-quote (") characters are stripped before the query is built and do not count as content`,
      );
    });

    // Unicode format characters (\p{Cf}: zero-width space, word joiner, BOM)
    // are invisible and survive String.trim(): a value made of them reaches
    // upstream as a term that answers a bare "Search error".
    it.each([[['​']], [['ALS', '​']], [['"​"']], [['⁠‍']]])(
      'rejects zero-width conditions %j as blank_value before any upstream call',
      async (conditions) => {
        await expect(run({ conditions })).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_value', param: 'conditions' },
        });
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it.each(['​', '﻿​', '"​"'])(
      'rejects a zero-width location.country %j as blank_value before any upstream call',
      async (country) => {
        await expect(run({ location: { country } })).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_value', param: 'location.country' },
        });
        expect(mockService.searchStudies).not.toHaveBeenCalled();
      },
    );

    it('says that invisible format characters do not count as content', async () => {
      const error = await run({ conditions: ['​'] }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('zero-width');
    });

    it.each(['​', ' ⁠ '])(
      'unsets a zero-width city of %j, sending exactly what an omitted city sends',
      async (city) => {
        const ctx = await run({ location: { country: 'United States', city } });
        expect(sentLocations()).toEqual([
          'SEARCH[Location](AREA[LocationCountry]"United States")',
          'SEARCH[Location](AREA[LocationCountry]"United States")',
        ]);
        const sc = getEnrichment(ctx).searchCriteria as Record<string, unknown>;
        expect(sc.location).toBe('SEARCH[Location](AREA[LocationCountry]"United States")');
      },
    );

    it.each([' ', '""', '" "'])(
      'unsets a city of %j, sending exactly what an omitted city sends',
      async (city) => {
        const ctx = await run({ location: { country: 'United States', city } });
        // Main search + location-stage funnel both carry the same string.
        expect(sentLocations()).toEqual([
          'SEARCH[Location](AREA[LocationCountry]"United States")',
          'SEARCH[Location](AREA[LocationCountry]"United States")',
        ]);
        const sc = getEnrichment(ctx).searchCriteria as Record<string, unknown>;
        expect(sc.location).toBe('SEARCH[Location](AREA[LocationCountry]"United States")');
      },
    );

    it('unsets a quote-only state between a city and a country', async () => {
      const ctx = await run({
        location: { city: 'Seattle', state: '""', country: 'United States' },
      });
      expect(sentLocations()).toEqual([
        'SEARCH[Location](Seattle AND AREA[LocationCountry]"United States")',
        'SEARCH[Location](Seattle AND AREA[LocationCountry]"United States")',
      ]);
      const sc = getEnrichment(ctx).searchCriteria as Record<string, unknown>;
      expect(sc.location).toBe(
        'SEARCH[Location](Seattle AND AREA[LocationCountry]"United States")',
      );
    });

    it.each([{ city: '" "' }, { state: '""' }, { city: ' ', state: ' ' }])(
      'gives an unset city or state %j the omitted-city notice, without city/state advice',
      async (parts) => {
        // condition matches, location stage empty: the branch that advises
        // removing city/state only when one was actually applied, and never
        // the country-only request's own location back to it (#185).
        mockService.countStudies.mockImplementation(async (params: { queryLocn?: string }) =>
          params.queryLocn ? 0 : 40,
        );
        const ctx = await run({ location: { country: 'United States', ...parts } });
        const notice = getEnrichment(ctx).notice as string;
        expect(notice).toContain('40 studies match the condition');
        expect(notice).not.toContain('Remove city/state');
        expect(notice).not.toContain('just the country');
        expect(notice).toContain('To widen the search past the country, geocode');
      },
    );

    it('keeps values with non-quote content on the #118 path', async () => {
      await run({
        conditions: ['"ALS"'],
        location: { country: 'United States', city: 'East "Northport" City' },
      });
      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          queryCond: 'ALS',
          queryLocn:
            'SEARCH[Location]("East Northport City" AND AREA[LocationCountry]"United States")',
        }),
        expect.anything(),
      );
    });

    it('leaves an empty-string city unset, as before', async () => {
      await run({ location: { country: 'United States', city: '' } });
      expect(sentLocations()).toEqual([
        'SEARCH[Location](AREA[LocationCountry]"United States")',
        'SEARCH[Location](AREA[LocationCountry]"United States")',
      ]);
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
      expect(text).toContain('Found 1 candidate studies');
      expect(text).toContain(
        'Demographic criteria: Age: 18 Years–65 Years | Sex: ALL | Healthy Volunteers: No',
      );
      expect(text).not.toContain('Eligibility:');
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
      const text = readMarkdown(
        findEligible.enrichmentTrailer!.searchCriteria!.render!({
          conditions: ['Type 2 Diabetes'],
          location: 'SEARCH[Location](Seattle AND Washington AND "United States")',
          age: 30,
          sex: 'ALL',
          conditionQuery: '"Type 2 Diabetes"',
          statusFilter: ['RECRUITING'],
          advancedFilter:
            '(AREA[MinimumAge]RANGE[MIN, 30 years] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[30 years, MAX] OR AREA[MaximumAge]MISSING)',
        }),
      );
      expect(text).toContain('conditions=[Type 2 Diabetes]');
      expect(text).toContain('conditionQuery="Type 2 Diabetes"');
      // location is an applied upstream filter (queryLocn) — it must ride in the
      // reproduce set, else a caller replays a broader, all-locations query (#91-C).
      expect(text).toContain(
        'locationQuery=SEARCH[Location](Seattle AND Washington AND "United States")',
      );
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
      expect((blocks[0] as { text: string }).text).toContain('No candidate studies found.');
    });

    it('shows total when more results exist', () => {
      const blocks = findEligible.format!({
        studies: [
          { protocolSection: { identificationModule: { nctId: 'NCT00000001', briefTitle: 'A' } } },
        ],
        totalCount: 50,
      });
      expect((blocks[0] as { text: string }).text).toContain(
        'Found 50 candidate studies (showing 1)',
      );
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
      // The main search returns studies; the two stages are count-only, told
      // apart by whether they carry the location.
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 2 });
      mockService.countStudies.mockImplementation(async (params: { queryLocn?: string }) =>
        params.queryLocn ? 47 : 298,
      );

      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.funnel).toEqual({
        conditionMatched: 298,
        locationMatched: 47,
        demographicsMatched: 2,
      });
    });

    it('requests both funnel stages through the service count path, never a study search (#160)', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 2 });
      mockService.countStudies.mockImplementation(async (params: { queryLocn?: string }) =>
        params.queryLocn ? 47 : 298,
      );

      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      // One study search — the main one — and exactly the two stage counts.
      expect(mockService.searchStudies).toHaveBeenCalledTimes(1);
      expect(mockService.countStudies.mock.calls.map((call) => call[0])).toEqual([
        { queryCond: '"Type 2 Diabetes"', includeUnknownEnrollment: true },
        {
          queryCond: '"Type 2 Diabetes"',
          queryLocn: BASE_LOCATION_QUERY,
          includeUnknownEnrollment: true,
        },
      ]);

      // Funnel values render unchanged on content[].
      const result = await runToolContract(findEligible, baseInput);
      const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');
      expect(text).toContain('**Funnel:** 298 condition → 47 + location → 2 + demographics');
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

  // The main search and the two funnel counts go upstream one after another,
  // main search first, so once one fails the call sends nothing further and
  // fails with that request's error (#176). The counts stay mandatory.
  describe('upstream request sequence (#176)', () => {
    const fieldInvalid = () =>
      validationError('Error parsing query in Conditions or disease: Unknown area name: `FooBar`', {
        reason: 'field_invalid',
      });
    const tooLong = () =>
      validationError('ClinicalTrials.gov rejected the request as too long (HTTP 414).', {
        reason: 'request_too_long',
      });
    const limited = () =>
      rateLimited('Rate limited by ClinicalTrials.gov after 3 retries', { reason: 'rate_limited' });

    /**
     * Settle `run` with fake timers standing in for the pacer's one-second gap
     * between requests — long enough that a request left queued behind an
     * abort or a rejection would reach the fetch fake too.
     */
    async function throttled<T>(run: () => Promise<T>) {
      vi.useFakeTimers();
      try {
        const outcome = run().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        return await outcome;
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    }

    it.each([
      {
        failing: 'the main search',
        reason: 'field_invalid',
        counts: 0,
        arrange: () => mockService.searchStudies.mockRejectedValue(fieldInvalid()),
      },
      {
        failing: 'the condition-only count',
        reason: 'request_too_long',
        counts: 1,
        arrange: () => {
          mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
          mockService.countStudies.mockRejectedValueOnce(tooLong());
        },
      },
      {
        failing: 'the condition + location count',
        reason: 'rate_limited',
        counts: 2,
        arrange: () => {
          mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
          mockService.countStudies.mockResolvedValueOnce(298).mockRejectedValueOnce(limited());
        },
      },
    ])(
      'fails with the error of $failing and asks for nothing after it',
      async ({ arrange, reason, counts }) => {
        arrange();
        const result = await runToolContract(findEligible, baseInput);

        expect(result.isError).toBe(true);
        expect(
          (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
        ).toBe(reason);
        expect(mockService.searchStudies).toHaveBeenCalledTimes(1);
        expect(mockService.countStudies).toHaveBeenCalledTimes(counts);
      },
    );

    it('asks for each request only once the one before it has answered, main search first', async () => {
      const events: string[] = [];
      const answer =
        <T>(name: string, value: T) =>
        async () => {
          events.push(`ask ${name}`);
          await Promise.resolve();
          events.push(`answer ${name}`);
          return value;
        };
      mockService.searchStudies.mockImplementation(
        answer('search', { studies: [], totalCount: 2 }),
      );
      mockService.countStudies
        .mockImplementationOnce(answer('condition', 298))
        .mockImplementationOnce(answer('location', 47));

      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(findEligible.input!.parse(baseInput), ctx);

      expect(events).toEqual([
        'ask search',
        'answer search',
        'ask condition',
        'answer condition',
        'ask location',
        'answer location',
      ]);
      expect(getEnrichment(ctx).funnel).toEqual({
        conditionMatched: 298,
        locationMatched: 47,
        demographicsMatched: 2,
      });
    });

    // A real service over a fetch fake: the main search answers, then the caller
    // aborts during the first funnel count.
    describe('caller cancellation mid-call', () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };

      async function cancelDuringFirstCount() {
        const { ClinicalTrialsService } = await vi.importActual<
          typeof import('@/services/clinical-trials/clinical-trials-service.js')
        >('@/services/clinical-trials/clinical-trials-service.js');
        const controller = new AbortController();
        const fetchFake = vi.fn(async (input: string | URL | Request) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.origin !== 'https://test.api' || url.pathname !== '/v2/studies') {
            throw new Error('unmocked fetch');
          }
          // A funnel count asks for one study; the main search for a page of them.
          if (url.searchParams.get('pageSize') !== '1') {
            return Response.json({ studies: [study], totalCount: 1 });
          }
          controller.abort();
          throw new DOMException('This operation was aborted', 'AbortError');
        });
        vi.stubGlobal('fetch', fetchFake);
        mockGetService.mockReturnValue(
          new ClinicalTrialsService(
            { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 5000, maxPageSize: 100 },
            { validateFieldsLocally: false },
          ),
        );
        return { fetchFake, signal: controller.signal };
      }

      it('rejects the handler with RequestCancelled and sends no request after the aborted one', async () => {
        const { fetchFake, signal } = await cancelDuringFirstCount();
        const ctx = createMockContext({ errors: findEligible.errors, signal });

        const outcome = await throttled(async () =>
          findEligible.handler(findEligible.input!.parse(baseInput), ctx),
        );

        expect(outcome).toMatchObject({
          error: {
            code: JsonRpcErrorCode.RequestCancelled,
            message: 'Request cancelled by caller',
            cause: { name: 'AbortError' },
          },
        });
        // The main search, then the aborted count — never the location count.
        expect(fetchFake).toHaveBeenCalledTimes(2);
      });

      it('answers RequestCancelled on both surfaces', async () => {
        const { signal } = await cancelDuringFirstCount();

        const outcome = await throttled(() =>
          runToolContract(findEligible, baseInput, { context: { signal } }),
        );

        const result = (outcome as { value: Awaited<ReturnType<typeof runToolContract>> }).value;
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.RequestCancelled,
            message: 'Request cancelled by caller',
          },
        });
        expect(readMarkdown((result.content as { text: string }[])[0]!.text)).toContain(
          'Request cancelled by caller',
        );
      });
    });

    // The issue's own observable, read at the fetch boundary of a real service:
    // the request ClinicalTrials.gov rejects is the call's last, so nothing it
    // would have sent waits in the pacer ahead of the next call's request.
    describe('a rejected request leaves nothing queued upstream', () => {
      it.each([
        {
          rejected: 'a condition ClinicalTrials.gov cannot parse (HTTP 400)',
          conditions: ['AREA[FooBar]x'],
          reason: 'field_invalid',
          answer: () =>
            new Response(
              'Error parsing query in Conditions or disease: Unknown area name: `FooBar`',
              { status: 400, headers: { 'content-type': 'text/plain' } },
            ),
        },
        {
          rejected: 'a condition list too long for one request (HTTP 414)',
          conditions: Array.from(
            { length: 700 },
            (_, i) => `condition${String(i).padStart(4, '0')}`,
          ),
          reason: 'request_too_long',
          answer: () => new Response('<html>414 Request-URI Too Large</html>', { status: 414 }),
        },
      ])(
        'sends one request for $rejected, and the next call’s request goes next',
        async ({ conditions, reason, answer }) => {
          const { ClinicalTrialsService } = await vi.importActual<
            typeof import('@/services/clinical-trials/clinical-trials-service.js')
          >('@/services/clinical-trials/clinical-trials-service.js');
          const sent: URL[] = [];
          vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL | Request) => {
              const url = new URL(input instanceof Request ? input.url : input);
              if (url.origin !== 'https://test.api' || url.pathname !== '/v2/studies') {
                throw new Error('unmocked fetch');
              }
              sent.push(url);
              return url.searchParams.get('query.cond') === 'diabetes'
                ? Response.json({ studies: [], totalCount: 5 })
                : answer();
            }),
          );
          const service = new ClinicalTrialsService(
            { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 5000, maxPageSize: 100 },
            { validateFieldsLocally: false },
          );
          mockGetService.mockReturnValue(service);

          const outcome = await throttled(async () => {
            const result = await runToolContract(findEligible, { ...baseInput, conditions });
            // The next call: the count the issue's repro sends as soon as the first returns.
            const next = await service.countStudies({ queryCond: 'diabetes' }, createMockContext());
            return { result, next };
          });
          const { result, next } = (
            outcome as {
              value: { result: Awaited<ReturnType<typeof runToolContract>>; next: number };
            }
          ).value;

          expect(result.isError).toBe(true);
          expect(
            (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
          ).toBe(reason);
          // find_eligible's one request is its main search, a page of ten — never a
          // one-study funnel count — and the next call's count follows it directly.
          expect(sent.map((u) => u.searchParams.get('pageSize'))).toEqual(['10', '1']);
          expect(sent[1]?.searchParams.get('query.cond')).toBe('diabetes');
          expect(next).toBe(5);
        },
      );
    });
  });

  // The eligibility search projects a fixed field list, so a field-validating
  // service sends it unchecked: no /studies/metadata read, which, hung, ended
  // the call at its 50 s budget before the search went out (#192). Read at the
  // fetch boundary of a real service, since the mechanism is the service
  // skipping that check.
  describe('the eligibility search reads no field metadata (#192)', () => {
    it('sends the search and both counts alone, with /studies/metadata hung', async () => {
      const { ClinicalTrialsService } = await vi.importActual<
        typeof import('@/services/clinical-trials/clinical-trials-service.js')
      >('@/services/clinical-trials/clinical-trials-service.js');
      const paths: string[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        paths.push(url.pathname);
        if (url.pathname === '/v2/studies/metadata') {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return Promise.resolve(Response.json({ studies: [], totalCount: 0 }));
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        mockGetService.mockReturnValue(
          new ClinicalTrialsService(
            { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 30_000, maxPageSize: 100 },
            { validateFieldsLocally: true },
          ),
        );
        let settled = false;
        const outcome = Promise.resolve(
          findEligible.handler(
            findEligible.input!.parse(baseInput),
            createMockContext({ errors: findEligible.errors }),
          ),
        )
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            settled = true;
          });
        while (!settled) await vi.advanceTimersToNextTimerAsync();
        const done = await outcome;
        if ('error' in done) throw done.error;

        // The main search, then the two funnel counts — never the metadata.
        expect(paths).toEqual(['/v2/studies', '/v2/studies', '/v2/studies']);
        expect(done.value.studies).toEqual([]);
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    });
  });

  // A main search answered with a body that is not a search page ends the call
  // once its retries are spent, before either funnel count goes out (#196).
  // Read at the fetch boundary of a real service, since the mechanism is the
  // service's envelope check.
  describe('a malformed main-search body ends the call (#196)', () => {
    it('ends upstream_unavailable on both surfaces and sends neither count', async () => {
      const { ClinicalTrialsService } = await vi.importActual<
        typeof import('@/services/clinical-trials/clinical-trials-service.js')
      >('@/services/clinical-trials/clinical-trials-service.js');
      const sent: URL[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request) => {
        sent.push(new URL(input instanceof Request ? input.url : input));
        return Promise.resolve(Response.json({}));
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        mockGetService.mockReturnValue(
          new ClinicalTrialsService(
            { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 30_000, maxPageSize: 100 },
            { maxRetries: 2, validateFieldsLocally: false },
          ),
        );
        let settled = false;
        const outcome = runToolContract(findEligible, baseInput).finally(() => {
          settled = true;
        });
        while (!settled) await vi.advanceTimersToNextTimerAsync();
        const result = await outcome;
        const error = (
          result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
        ).error;

        // The main search — a page of ten — on each of its three attempts, never
        // a one-study funnel count.
        expect(sent.map((u) => [u.pathname, u.searchParams.get('pageSize')])).toEqual([
          ['/v2/studies', '10'],
          ['/v2/studies', '10'],
          ['/v2/studies', '10'],
        ]);
        expect(result.isError).toBe(true);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({
          reason: 'upstream_unavailable',
          path: '/studies',
          recovery: { hint: expect.stringMatching(/^Retry the same call unchanged/) },
        });
        expect(readMarkdown((result.content as { text: string }[])[0]!.text)).toContain(
          'Recovery: Retry the same call unchanged',
        );
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    });
  });

  // Every string the searchCriteria trailer echoes reads back in content[] as
  // structuredContent carries it, and the no-match notice reads back the
  // conditions it quotes (#177). The value table lives with formatEchoValue in
  // the format-helpers suite; these prove the wiring.
  describe('content[] reads back the echoed criteria (#177)', () => {
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.content as { text: string }[]).map((b) => b.text).join('\n');
    const run = async (input: Record<string, unknown>) => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const result = await runToolContract(findEligible, { ...baseInput, ...input });
      const structured = result.structuredContent as {
        notice: string;
        searchCriteria: Record<string, unknown>;
      };
      return {
        notice: structured.notice,
        sc: structured.searchCriteria,
        seen: readMarkdown(textOf(result)),
      };
    };
    const ageFilter = (age: number) =>
      `(AREA[MinimumAge]RANGE[MIN, ${age} years] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[${age} years, MAX] OR AREA[MaximumAge]MISSING)`;

    it('reads a country-only location back on the Search and Reproduce lines, structuredContent unchanged', async () => {
      const { sc, seen } = await run({
        age: 55,
        conditions: ['cancer'],
        location: { country: 'Mexico' },
      });
      const location = 'SEARCH[Location](AREA[LocationCountry]"Mexico")';

      expect(sc).toEqual({
        conditions: ['cancer'],
        location,
        age: 55,
        sex: 'ALL',
        conditionQuery: 'cancer',
        statusFilter: ['RECRUITING'],
        advancedFilter: ageFilter(55),
      });
      expect(seen).toContain(
        `Search: conditions=[cancer] | location=${location} | age=55 | sex=ALL`,
      );
      expect(seen).toContain(
        `Reproduce via clinicaltrials_search_studies: conditionQuery=cancer | locationQuery=${location} | statusFilter=[RECRUITING] | advancedFilter=${ageFilter(55)} | includeUnknownEnrollment=true`,
      );
    });

    it('reads back a condition shaped like a link', async () => {
      const { sc, seen } = await run({ conditions: ['AREA[Condition](cancer)'] });

      expect(sc.conditionQuery).toBe('AREA[Condition](cancer)');
      expect(seen).toContain('conditions=[AREA[Condition](cancer)] |');
      expect(seen).toContain('conditionQuery=AREA[Condition](cancer) |');
    });

    it('reads back an emphasis-shaped condition in the echo and the no-match notice, raw in structuredContent', async () => {
      const { notice, seen } = await run({ conditions: ['_x_'] });

      expect(notice).toMatch(/^No studies found for "_x_" matching the specified criteria\. /);
      expect(seen).toContain('conditions=[_x_] |');
      expect(seen).toContain('conditionQuery=_x_ |');
      expect(seen).toContain(notice);
    });

    it('reads back a state ending in a backslash, which the query doubles', async () => {
      const { sc, seen } = await run({ location: { country: 'France', state: 'Ile\\' } });
      const location =
        'SEARCH[Location](AREA[LocationState]"Ile\\\\" AND AREA[LocationCountry]"France")';

      expect(sc.location).toBe(location);
      expect(seen).toContain(`location=${location} |`);
      expect(seen).toContain(`locationQuery=${location} |`);
    });

    it('frames each condition on its own, a multi-line one as a block, which the notice quotes across a line break', async () => {
      const conditions = ['Type 2 Diabetes', 'x\n# y'];
      const { notice, sc, seen } = await run({ conditions });

      expect(sc.conditions).toEqual(conditions);
      expect(notice).toMatch(/^No studies found for "Type 2 Diabetes, x\n# y" matching /);
      expect(seen).toContain('Search: conditions=[Type 2 Diabetes,\nx\n# y\n\n] | location=');
      expect(seen).toContain(`conditionQuery=\n${sc.conditionQuery as string}\n`);
      expect(seen).toContain(notice);
    });

    describe('the notice render stays linear on caller-sized text', { timeout: 0 }, () => {
      const render = (notice: string) => findEligible.enrichmentTrailer!.notice!.render!(notice);

      it.each([
        ...LINE_BREAK_SHAPES,
        [
          'a heading-marker run inside quotes',
          (n: number) => `No studies found for "${'#'.repeat(n)}" matching`,
        ],
        ['autolink openers throughout', (n: number) => '<1@'.repeat(n / 3)],
        ['backslashes throughout', (n: number) => '\\'.repeat(n)],
        ['underscores throughout', (n: number) => '_'.repeat(n)],
        ['a long digit run', (n: number) => '1'.repeat(n)],
      ] as const)('%s', (_name, shape) => {
        expectLinearGrowth(render, shape);
      });
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
      geoPoint?: { lat: number; lon: number },
    ) => ({
      facility,
      city,
      state,
      country,
      status,
      ...(geoPoint ? { geoPoint } : {}),
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

    // An output-only ceiling: a limit past the site count means "every site",
    // so it carries no maximum (#153).
    describe('locationLimit past the site count (#153)', () => {
      const seattleSites = (n: number) =>
        Array.from({ length: n }, (_, i) => site(`Seattle ${i}`, 'Seattle', 'Washington'));
      const surfaces = async (locationLimit: number, n: number) => {
        mockService.searchStudies.mockResolvedValue({
          studies: [studyWith('NCT1', seattleSites(n))],
          totalCount: 1,
        });
        const result = await runToolContract(findEligible, { ...baseInput, locationLimit });
        return {
          structured: result.structuredContent as { studies: CandidateStudy[] },
          text: (result.content as { text: string }[]).map((b) => b.text).join('\n'),
        };
      };

      it('returns a list at the limit untrimmed, with no summary or Sites line', async () => {
        const { structured, text } = await surfaces(12, 12);

        expect(facilities(structured.studies[0]!)).toHaveLength(12);
        expect(structured.studies[0]!.locationSummary).toBeUndefined();
        expect(text).not.toContain('Sites: showing');
        expect(text).toContain('Seattle 11, Seattle, Washington, United States [RECRUITING]');
      });

      it('renders a limit far past the site count exactly as a list at the limit', async () => {
        const atLimit = await surfaces(12, 12);
        const past = await surfaces(1_000_000, 12);

        expect(past.structured).toEqual(atLimit.structured);
        expect(past.text).toBe(atLimit.text);
      });

      it('returns every site of a study registering more than 500', async () => {
        const { structured } = await surfaces(100_000, 600);

        expect(facilities(structured.studies[0]!)).toHaveLength(600);
        expect(structured.studies[0]!.locationSummary).toBeUndefined();
      });
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
        // No site here publishes coordinates, so the admission is by match
        // order and the text makes no distance claim (#138).
        expect(text).toContain('none of them is recruiting, so one recruiting site');
        expect(text).not.toContain('nearest');
        expect(text).not.toContain('Deaconess');
      });

      it('surfaces a matched-tier recruiting site listed past the cap inside the cap, admitting nothing', async () => {
        // The recruiting tie-break sorts an open matched site ahead of its
        // closed peers, so it can never sit past the cap while the cap shows
        // only closed sites — the admission rule is never reached for it.
        const candidate = await runOne(
          studyWith('NCT1', [
            ...Array.from({ length: 12 }, (_, i) =>
              site(`Seattle ${i}`, 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            ),
            site('Seattle open', 'Seattle', 'Washington'),
            site('Renton open', 'Renton', 'Washington'),
          ]),
          { locationLimit: 3 },
        );
        expect(facilities(candidate)).toEqual(['Seattle open', 'Seattle 0', 'Seattle 1']);
        expect(candidate.locationSummary?.nearestRecruitingSiteAdded).toBeUndefined();
      });
    });

    describe('recruiting site admitted by distance (#138)', () => {
      const at = (lat: number, lon: number) => ({ lat, lon });
      // Published coordinates from NCT07062965's own site list.
      const SEATTLE = at(47.60621, -122.33207);
      const CHANDLER = at(33.30616, -111.84125);
      const SALT_LAKE_CITY = at(40.76078, -111.89105);

      type Located = Record<string, unknown> & { distanceMi?: number; facility?: string };
      const admittedSite = (candidate: CandidateStudy) =>
        candidate.protocolSection.contactsLocationsModule!.locations!.at(-1) as Located;

      const run = async (study: unknown, overrides: Record<string, unknown> = {}) => {
        mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });
        const ctx = createMockContext({ errors: findEligible.errors });
        const result = await findEligible.handler(
          findEligible.input!.parse({ ...baseInput, ...overrides }),
          ctx,
        );
        return {
          candidate: result.studies[0] as CandidateStudy,
          text: (findEligible.format!(result)[0] as { text: string }).text,
        };
      };

      it('requests LocationGeoPoint alongside the eligibility fields', async () => {
        mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
        const ctx = createMockContext({ errors: findEligible.errors });
        await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
        const fields = mockService.searchStudies.mock.calls[0]![0].fields as string[];
        expect(fields).toContain('LocationGeoPoint');
        expect(fields).toContain('LocationStatus');
      });

      it('admits the nearest recruiting site on the reported study, not the first listed', async () => {
        // NCT07062965 as ClinicalTrials.gov returns it for these fields: one
        // closed Seattle site, and 118 recruiting sites with coordinates, where
        // Chandler, AZ (~1,129 mi) is listed first and Salt Lake City (~700 mi)
        // is the nearest.
        const { candidate, text } = await run(loadStudyFixture('nct07062965'), {
          age: 58,
          sex: 'FEMALE',
          conditions: ['breast cancer'],
          locationLimit: 3,
        });
        expect(facilities(candidate)).toEqual([
          'Fred Hutchinson Cancer Center',
          'Huntsman Cancer Institute',
        ]);
        expect(admittedSite(candidate)).toMatchObject({
          city: 'Salt Lake City',
          status: 'RECRUITING',
          distanceMi: 699.8,
        });
        expect(candidate.locationSummary).toEqual({
          totalLocations: 202,
          matchedLocations: 1,
          locationsTruncated: false,
          nearestRecruitingSiteAdded: true,
          retrieveFullStudyWith: 'clinicaltrials_get_study_record',
        });
        expect(text).toContain(
          'none of them is recruiting, so the nearest recruiting site is included',
        );
        expect(text).toContain(
          'Huntsman Cancer Institute, Salt Lake City, Utah, United States [RECRUITING] (699.8 mi from the nearest matched site)',
        );
        expect(text).not.toContain('Chandler');
      });

      it('lets a nearer site listed later beat a farther site listed earlier', async () => {
        const { candidate } = await run(
          studyWith('NCT07062965', [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('Ironwood', 'Chandler', 'Arizona', 'United States', 'RECRUITING', CHANDLER),
            site(
              'Huntsman',
              'Salt Lake City',
              'Utah',
              'United States',
              'RECRUITING',
              SALT_LAKE_CITY,
            ),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch', 'Huntsman']);
        expect(admittedSite(candidate).distanceMi).toBe(699.8);
      });

      it('carries the same distance in structuredContent and content[] (#46/#91)', async () => {
        const { candidate, text } = await run(
          studyWith('NCT1', [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('Ironwood', 'Chandler', 'Arizona', 'United States', 'RECRUITING', CHANDLER),
          ]),
        );
        const distance = admittedSite(candidate).distanceMi;
        expect(distance).toBe(1129.2);
        // The admitted site completes the study's list, so no Sites line renders
        // (#80) — the distance still reaches content[] on the site itself.
        expect(candidate.locationSummary).toBeUndefined();
        expect(text).not.toContain('registered');
        expect(text).toContain(
          `Ironwood, Chandler, Arizona, United States [RECRUITING] (${distance} mi from the nearest matched site)`,
        );
        // Coordinates are an input to the ranking, not an output: no site in
        // either channel carries them, so neither channel has a leaf the other lacks.
        for (const loc of candidate.protocolSection.contactsLocationsModule!.locations!)
          expect(loc).not.toHaveProperty('geoPoint');
        expect(text).not.toContain('47.60621');
      });

      it('keeps list order between candidates tied on distance', async () => {
        const { candidate } = await run(
          studyWith('NCT1', [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('Ironwood', 'Chandler', 'Arizona', 'United States', 'RECRUITING', CHANDLER),
            site(
              'Huntsman A',
              'Salt Lake City',
              'Utah',
              'United States',
              'RECRUITING',
              SALT_LAKE_CITY,
            ),
            site(
              'Huntsman B',
              'Salt Lake City',
              'Utah',
              'United States',
              'RECRUITING',
              SALT_LAKE_CITY,
            ),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch', 'Huntsman A']);
      });

      it('measures from the nearest matched site, including matched sites past the cap', async () => {
        // Two closed matched sites far apart. The first listed — the only one the
        // cap shows — is nearest the Washington candidate; the second, past the
        // cap, is nearest the Oregon one, which is closer still. Measuring from
        // the first listed or only from the shown sites would pick Washington.
        const north = at(48.75, -122.48);
        const south = at(45.52, -122.68);
        const washington = at(48.42, -122.33);
        const oregon = at(45.44, -122.62);
        const { candidate, text } = await run(
          studyWith('NCT1', [
            site(
              'Seattle north',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              north,
            ),
            site(
              'Seattle south',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              south,
            ),
            site(
              'Washington open',
              'Mount Vernon',
              'Washington',
              'United States',
              'RECRUITING',
              washington,
            ),
            site('Oregon open', 'Milwaukie', 'Oregon', 'United States', 'RECRUITING', oregon),
          ]),
          { locationLimit: 1 },
        );
        expect(facilities(candidate)).toEqual(['Seattle north', 'Oregon open']);
        expect(admittedSite(candidate).distanceMi).toBe(6.2);
        expect(candidate.locationSummary).toMatchObject({
          matchedLocations: 2,
          locationsTruncated: true,
          nearestRecruitingSiteAdded: true,
        });
        expect(text).toContain('6.2 mi from the nearest matched site');
      });

      it('ranks only the candidates that publish coordinates', async () => {
        const { candidate } = await run(
          studyWith('NCT1', [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('Renton open', 'Renton', 'Washington'),
            site(
              'Huntsman',
              'Salt Lake City',
              'Utah',
              'United States',
              'RECRUITING',
              SALT_LAKE_CITY,
            ),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch', 'Huntsman']);
        expect(admittedSite(candidate).distanceMi).toBe(699.8);
      });

      it('keeps the admitted site in the requested country while one there recruits', async () => {
        // Vancouver, BC is ~119 mi from Seattle and Duarte, CA ~957 mi; distance
        // alone would send a patient who named the United States to Canada.
        const { candidate } = await run(
          studyWith('NCT1', [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('BC Cancer', 'Vancouver', '', 'Canada', 'RECRUITING', at(49.24966, -123.11934)),
            site(
              'City of Hope',
              'Duarte',
              'California',
              'United States',
              'RECRUITING',
              at(34.13945, -117.97729),
            ),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch', 'City of Hope']);
        expect(admittedSite(candidate).distanceMi).toBeGreaterThan(900);
      });

      it('crosses the border when no site in the requested country recruits', async () => {
        const { candidate } = await run(
          studyWith('NCT1', [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('Boston', 'Boston', 'Massachusetts', 'United States', 'NOT_YET_RECRUITING'),
            site('BC Cancer', 'Vancouver', '', 'Canada', 'RECRUITING', at(49.24966, -123.11934)),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch', 'BC Cancer']);
        expect(admittedSite(candidate).distanceMi).toBeLessThan(150);
      });

      it('prefers a nearer out-of-state site over a farther in-state one', async () => {
        // Portland, OR: Vancouver, WA sits across the river; Salem, OR is ~44 mi out.
        const { candidate } = await run(
          studyWith('NCT1', [
            site(
              'OHSU',
              'Portland',
              'Oregon',
              'United States',
              'NOT_YET_RECRUITING',
              at(45.52345, -122.67621),
            ),
            site(
              'Salem clinic',
              'Salem',
              'Oregon',
              'United States',
              'RECRUITING',
              at(44.9429, -123.0351),
            ),
            site(
              'Vancouver clinic',
              'Vancouver',
              'Washington',
              'United States',
              'RECRUITING',
              at(45.63873, -122.66149),
            ),
          ]),
          { location: { country: 'United States', state: 'Oregon', city: 'Portland' } },
        );
        expect(facilities(candidate)).toEqual(['OHSU', 'Vancouver clinic']);
        expect(admittedSite(candidate).distanceMi).toBeLessThan(10);
      });

      it('falls back to match order with no distance when no matched site has coordinates', async () => {
        const { candidate, text } = await run(
          studyWith('NCT1', [
            site('Fred Hutch', 'Seattle', 'Washington', 'United States', 'NOT_YET_RECRUITING'),
            site('Ironwood', 'Chandler', 'Arizona', 'United States', 'RECRUITING', CHANDLER),
            site(
              'Huntsman',
              'Salt Lake City',
              'Utah',
              'United States',
              'RECRUITING',
              SALT_LAKE_CITY,
            ),
            site('Elsewhere', 'Boston', 'Massachusetts', 'United States', 'NOT_YET_RECRUITING'),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch', 'Ironwood']);
        expect(admittedSite(candidate)).not.toHaveProperty('distanceMi');
        expect(candidate.locationSummary?.nearestRecruitingSiteAdded).toBe(true);
        expect(text).toContain(
          'none of them is recruiting, so one recruiting site from a wider area',
        );
        expect(text).not.toContain('nearest');
        expect(text).not.toContain(' mi ');
      });

      it('falls back to match order with no distance when no recruiting candidate has coordinates', async () => {
        const { candidate, text } = await run(
          studyWith('NCT1', [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('Ironwood', 'Chandler', 'Arizona'),
            site('Huntsman', 'Salt Lake City', 'Utah'),
            site('Elsewhere', 'Boston', 'Massachusetts', 'United States', 'NOT_YET_RECRUITING'),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch', 'Ironwood']);
        expect(admittedSite(candidate)).not.toHaveProperty('distanceMi');
        expect(text).not.toContain('nearest');
      });

      it('still admits nothing when a matched site is recruiting, coordinates or not', async () => {
        const { candidate } = await run(
          studyWith('NCT1', [
            site('Fred Hutch', 'Seattle', 'Washington', 'United States', 'RECRUITING', SEATTLE),
            site(
              'Huntsman',
              'Salt Lake City',
              'Utah',
              'United States',
              'RECRUITING',
              SALT_LAKE_CITY,
            ),
          ]),
        );
        expect(facilities(candidate)).toEqual(['Fred Hutch']);
        expect(candidate.locationSummary?.nearestRecruitingSiteAdded).toBeUndefined();
      });
    });

    // The query strips `"` from each location part, so a quoted part finds the
    // same studies as the bare one. Sites must be scored against that same
    // stripped value, or the quoted call bounds every study to a coarser tier.
    describe('quoted location parts (#155)', () => {
      const SEATTLE = { lat: 47.60621, lon: -122.33207 };
      const cases = [
        {
          name: 'city',
          bare: { country: 'United States', state: 'Washington', city: 'Seattle' },
          quoted: { country: 'United States', state: 'Washington', city: '"Seattle"' },
          sites: () => [
            site('Seattle A', 'Seattle', 'Washington'),
            site('Spokane', 'Spokane', 'Washington'),
            site('Boston', 'Boston', 'Massachusetts'),
          ],
          expected: ['Seattle A'],
        },
        {
          name: 'state',
          bare: { country: 'United States', state: 'Washington', city: 'Seattle' },
          quoted: { country: 'United States', state: '"Washington"', city: 'Seattle' },
          sites: () => [
            site('Spokane', 'Spokane', 'Washington'),
            site('Boston', 'Boston', 'Massachusetts'),
          ],
          expected: ['Spokane'],
        },
        {
          name: 'country',
          bare: { country: 'United States' },
          quoted: { country: '"United States"' },
          sites: () => [
            site('Boston', 'Boston', 'Massachusetts'),
            site('Toronto', 'Toronto', 'Ontario', 'Canada'),
          ],
          expected: ['Boston'],
        },
        {
          // The recruiting-site fallback keeps candidates in the requested
          // country first; a quoted country must not send the patient to Canada.
          name: 'country, at the recruiting-site fallback',
          bare: { country: 'United States', state: 'Washington', city: 'Seattle' },
          quoted: { country: '"United States"', state: 'Washington', city: 'Seattle' },
          sites: () => [
            site(
              'Fred Hutch',
              'Seattle',
              'Washington',
              'United States',
              'NOT_YET_RECRUITING',
              SEATTLE,
            ),
            site('BC Cancer', 'Vancouver', '', 'Canada', 'RECRUITING', {
              lat: 49.24966,
              lon: -123.11934,
            }),
            site('City of Hope', 'Duarte', 'California', 'United States', 'RECRUITING', {
              lat: 34.13945,
              lon: -117.97729,
            }),
          ],
          expected: ['Fred Hutch', 'City of Hope'],
        },
      ];

      it.each(cases)(
        'a quoted $name returns the same per-study locations as the bare one',
        async ({ bare, quoted, sites, expected }) => {
          const bareCandidate = await runOne(studyWith('NCT1', sites()), { location: bare });
          const quotedCandidate = await runOne(studyWith('NCT1', sites()), { location: quoted });

          expect(facilities(bareCandidate)).toEqual(expected);
          expect(quotedCandidate.protocolSection.contactsLocationsModule?.locations).toEqual(
            bareCandidate.protocolSection.contactsLocationsModule?.locations,
          );
          expect(quotedCandidate.locationSummary).toEqual(bareCandidate.locationSummary);
        },
      );

      it('sends the identical upstream location for the quoted and bare forms', async () => {
        await runOne(studyWith('NCT1', []), {
          location: { country: '"United States"', state: '"Washington"', city: '"Seattle"' },
        });
        expect(mockService.searchStudies).toHaveBeenCalledWith(
          expect.objectContaining({
            queryLocn: BASE_LOCATION_QUERY,
          }),
          expect.anything(),
        );
      });
    });

    // A study qualifies on its whole site list, so a city named in the request
    // can sit in another country (London, UK for a London, Canada request).
    // City and state points go only to sites in the requested country, so a
    // foreign namesake never leads the matched tier (#159).
    describe('country gate on city and state credit (#159)', () => {
      it('bounds a London + Canada request to the Canadian site, not London, UK', async () => {
        const candidate = await runOne(
          studyWith('NCT06898450', [
            site('Guy’s Hospital', 'London', '', 'United Kingdom'),
            site('Princess Margaret', 'Toronto', 'Ontario', 'Canada'),
          ]),
          { location: { city: 'London', country: 'Canada' } },
        );
        expect(facilities(candidate)).toEqual(['Princess Margaret']);
        expect(candidate.locationSummary).toMatchObject({
          totalLocations: 2,
          matchedLocations: 1,
        });
      });

      it('ranks an in-country city site first and keeps it alone in the tier', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('St Thomas', 'London', '', 'United Kingdom'),
            site('Victoria Hospital', 'London', 'Ontario', 'Canada'),
            site('Princess Margaret', 'Toronto', 'Ontario', 'Canada'),
          ]),
          { location: { city: 'London', country: 'Canada' } },
        );
        expect(facilities(candidate)).toEqual(['Victoria Hospital']);
      });

      it('gives no state credit to a site in another country', async () => {
        // Victoria is a state in Australia; the request names Canada.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Peter Mac', 'Melbourne', 'Victoria', 'Australia'),
            site('Princess Margaret', 'Toronto', 'Ontario', 'Canada'),
          ]),
          { location: { state: 'Victoria', country: 'Canada' } },
        );
        expect(facilities(candidate)).toEqual(['Princess Margaret']);
      });

      it('keeps a Seoul, South Korea site in the city tier for a Seoul + Korea request', async () => {
        // The registry spells the country "South Korea"; every word of the
        // requested country appears in it, so the gate applies and the Korean
        // city sites earn credit while the out-of-country namesake does not. A
        // gate that missed "South Korea" would leave the study ungated, and the
        // namesake would join the tier.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Asan', 'Seoul', '', 'South Korea'),
            site('Pusan National', 'Busan', '', 'South Korea'),
            site('Namesake', 'Seoul', '', 'Japan'),
            site('Samsung', 'Seoul', '', 'South Korea'),
          ]),
          { location: { city: 'Seoul', country: 'Korea' } },
        );
        expect(facilities(candidate)).toEqual(['Asan', 'Samsung']);
        expect(candidate.locationSummary).toMatchObject({ totalLocations: 4, matchedLocations: 2 });
      });

      it('compares country words case-insensitively and ignores punctuation', async () => {
        // `KOREA` must pass the gate on `Korea, Republic of` for the namesake to
        // be dropped; a case- or comma-sensitive gate passes no site, and the
        // ungated study keeps both Seoul sites.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Asan', 'Seoul', '', 'Korea, Republic of'),
            site('Pusan National', 'Busan', '', 'Korea, Republic of'),
            site('Namesake', 'Seoul', '', 'Japan'),
          ]),
          { location: { city: 'seoul', country: 'KOREA' } },
        );
        expect(facilities(candidate)).toEqual(['Asan']);
      });

      it('gives no city credit when the site publishes no country', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            { facility: 'No country', city: 'London', status: 'RECRUITING' },
            site('Princess Margaret', 'Toronto', 'Ontario', 'Canada'),
          ]),
          { location: { city: 'London', country: 'Canada' } },
        );
        expect(facilities(candidate)).toEqual(['Princess Margaret']);
      });

      // A study can match a country spelled differently from the registry
      // through a synonym upstream resolves and the synonym table does not carry
      // (CZ for Czechia). With no site passing the gate, the gate would score
      // every site 0 and keep the whole list; the study is scored ungated
      // instead, so the city still bounds it.
      describe('a requested country no site of the study spells the same way', () => {
        const pragueStudy = () =>
          studyWith('NCT06607458', [
            site('City of Hope', 'Duarte', 'California', 'United States'),
            site('Saint John’s', 'Santa Monica', 'California', 'United States'),
            site('Motol', 'Prague', '', 'Czechia'),
            site('Masaryk', 'Brno', '', 'Czechia'),
            site('Bulovka', 'Prague', '', 'Czechia', 'NOT_YET_RECRUITING'),
          ]);

        it('bounds a Prague + CZ request to the Prague sites', async () => {
          const candidate = await runOne(pragueStudy(), {
            location: { city: 'Prague', country: 'CZ' },
          });
          expect(facilities(candidate)).toEqual(['Motol', 'Bulovka']);
          expect(candidate.locationSummary).toMatchObject({
            totalLocations: 5,
            matchedLocations: 2,
            locationsTruncated: false,
          });
        });

        it('renders the same bounded sites on content[]', async () => {
          mockService.searchStudies.mockResolvedValue({ studies: [pragueStudy()], totalCount: 1 });
          const result = await runToolContract(findEligible, {
            ...baseInput,
            location: { city: 'Prague', country: 'CZ' },
          });
          const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');
          expect(text).toContain('Motol, Prague, Czechia');
          expect(text).not.toContain('Duarte');
          expect(text).not.toContain('Santa Monica');
        });

        it('still gates a study that has a site passing it', async () => {
          // One Canadian site is enough to apply the gate, so the London, UK
          // namesake earns no city credit.
          const candidate = await runOne(
            studyWith('NCT1', [
              site('Guy’s Hospital', 'London', '', 'United Kingdom'),
              site('Bulovka', 'Prague', '', 'Czechia'),
              site('Princess Margaret', 'Toronto', 'Ontario', 'Canada'),
            ]),
            { location: { city: 'London', country: 'Canada' } },
          );
          expect(facilities(candidate)).toEqual(['Princess Margaret']);
        });
      });

      it('does not count a partial country-word match ("United Kingdom" vs "United States")', async () => {
        // "United" alone is not the requested country.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Guy’s Hospital', 'London', '', 'United Kingdom'),
            site('Boston', 'Boston', 'Massachusetts', 'United States'),
          ]),
          { location: { city: 'London', country: 'United States' } },
        );
        expect(facilities(candidate)).toEqual(['Boston']);
      });

      it('renders the bounded in-country site on content[] too', async () => {
        const study = studyWith('NCT06898450', [
          site('Guy’s Hospital', 'London', '', 'United Kingdom'),
          site('Princess Margaret', 'Toronto', 'Ontario', 'Canada'),
        ]);
        mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });
        const result = await runToolContract(findEligible, {
          ...baseInput,
          location: { city: 'London', country: 'Canada' },
        });
        const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');
        expect(text).toContain('Princess Margaret, Toronto, Ontario, Canada');
        expect(text).not.toContain('Guy’s Hospital');
      });

      it('splits a country into distinct folded words on non-letter, non-digit runs', () => {
        expect(placeWords('Korea, Republic of')).toEqual(new Set(['korea', 'republic', 'of']));
        expect(placeWords("  Côte d'Ivoire ")).toEqual(new Set(['cote', 'divoire']));
        expect(placeWords('Korea Korea')).toEqual(new Set(['korea']));
        expect(placeWords('--')).toEqual(new Set());
      });

      // Upstream folds case, diacritics, the letters that do not decompose,
      // and periods and apostrophes inside a name; the site ranking folds the
      // same way, so it agrees with the match (#166).
      it.each([
        ['Montréal', ['montreal']],
        ['QUÉBEC', ['quebec']],
        ['Wrocław', ['wroclaw']],
        ['Gießen', ['giessen']],
        ['Næstved', ['naestved']],
        ['Tromsø', ['tromso']],
        ['Diyarbakır', ['diyarbakir']],
        ['İstanbul', ['istanbul']],
        ['ŁÓDŹ', ['lodz']],
        ['Washington D.C.', ['washington', 'dc']],
        ['St. Louis', ['st', 'louis']],
        ['‘Aiea', ['aiea']],
        ['Côte d’Ivoire', ['cote', 'divoire']],
        ['Hradec Králové', ['hradec', 'kralove']],
        ['ʼ.’', []],
      ])('folds %j to its plain words', (name, words) => {
        expect(placeWords(name)).toEqual(new Set(words));
      });

      describe('the requested-country split stays linear on caller-sized text', {
        timeout: 0,
      }, () => {
        it.each([
          ...LINE_BREAK_SHAPES,
          ['separators throughout', (n: number) => ', '.repeat(n / 2)],
          ['one long word', (n: number) => 'k'.repeat(n)],
          [
            'distinct words',
            (n: number) => Array.from({ length: n / 8 }, (_, i) => `w${i}`).join(' '),
          ],
          ['accented letters throughout', (n: number) => 'é'.repeat(n)],
          ['one letter under a long run of combining marks', (n: number) => `a${'́'.repeat(n - 1)}`],
          ['periods and apostrophes throughout', (n: number) => ".'’‘ʼ".repeat(n / 5)],
          ['letters folded by mapping throughout', (n: number) => 'ßæøłı'.repeat(n / 5)],
        ] as const)('%s', (_name, shape) => {
          expectLinearGrowth(placeWords, shape);
        });
      });
    });

    // The registry mixes spellings — Montreal and Quebec, St Louis, Washington
    // D.C., but São Paulo, and Québec for Quebec City — and upstream folds them,
    // so a study is found whichever way the caller writes the place. The site
    // ranking compares the same folded words, so the city sites lead (#166).
    describe('folded place-name spellings (#166)', () => {
      it.each([
        {
          name: 'Montréal / Québec against Montreal / Quebec',
          location: { city: 'Montréal', state: 'Québec', country: 'Canada' },
          sites: () => [
            site('Barrie', 'Barrie', 'Ontario', 'Canada'),
            site('MUHC', 'Montreal', 'Quebec', 'Canada'),
            site('Kitchener', 'Kitchener', 'Ontario', 'Canada'),
            site('CHUM', 'Montreal', 'Quebec', 'Canada'),
          ],
          expected: ['MUHC', 'CHUM'],
        },
        {
          name: 'St. Louis against St Louis',
          location: { city: 'St. Louis', state: 'Missouri', country: 'United States' },
          sites: () => [
            site('Ballwin', 'Ballwin', 'Missouri'),
            site('Siteman', 'St Louis', 'Missouri'),
            site('Cape Girardeau', 'Cape Girardeau', 'Missouri'),
            site('SLU', 'St Louis', 'Missouri'),
          ],
          expected: ['Siteman', 'SLU'],
        },
        {
          name: 'Sao Paulo against São Paulo',
          location: { city: 'Sao Paulo', country: 'Brazil' },
          sites: () => [
            site('Belém', 'Belém', 'Pará', 'Brazil'),
            site('ICESP', 'São Paulo', 'São Paulo', 'Brazil'),
            site('Fortaleza', 'Fortaleza', 'Ceará', 'Brazil'),
          ],
          expected: ['ICESP'],
        },
        {
          name: 'Washington DC against Washington D.C.',
          location: { city: 'Washington DC', country: 'United States' },
          sites: () => [
            site('Bethesda', 'Bethesda', 'Maryland'),
            site('Georgetown', 'Washington D.C.', 'District of Columbia'),
          ],
          expected: ['Georgetown'],
        },
        {
          name: 'Wroclaw against Wrocław',
          location: { city: 'Wroclaw', country: 'Poland' },
          sites: () => [
            site('Warsaw', 'Warsaw', 'Masovian', 'Poland'),
            site('Wrocław Medical', 'Wrocław', 'Lower Silesian', 'Poland'),
          ],
          expected: ['Wrocław Medical'],
        },
        {
          name: 'Quebec against the city filed Québec',
          location: { city: 'Quebec', state: 'Quebec', country: 'Canada' },
          sites: () => [
            site('CHUM', 'Montreal', 'Quebec', 'Canada'),
            site('CHU de Québec', 'Québec', 'Quebec', 'Canada'),
          ],
          expected: ['CHU de Québec'],
        },
      ])('ranks the city sites first for $name', async ({ location, sites, expected }) => {
        const candidate = await runOne(studyWith('NCT1', sites()), { location });
        expect(facilities(candidate)).toEqual(expected);
        expect(candidate.locationSummary).toMatchObject({ matchedLocations: expected.length });
      });

      it('renders the folded-spelling city sites on content[] too', async () => {
        const study = studyWith('NCT05879926', [
          site('Barrie', 'Barrie', 'Ontario', 'Canada'),
          site('MUHC', 'Montreal', 'Quebec', 'Canada'),
        ]);
        mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });
        const result = await runToolContract(findEligible, {
          ...baseInput,
          location: { city: 'Montréal', state: 'Québec', country: 'Canada' },
        });
        const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');
        expect(text).toContain('MUHC, Montreal, Quebec, Canada');
        expect(text).not.toContain('Barrie');
        const sc = result.structuredContent as { studies: CandidateStudy[] };
        expect(facilities(sc.studies[0]!)).toEqual(['MUHC']);
      });

      it('ranks exact spellings as before', async () => {
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Barrie', 'Barrie', 'Ontario', 'Canada'),
            site('MUHC', 'Montreal', 'Quebec', 'Canada'),
          ]),
          { location: { city: 'Montreal', state: 'Quebec', country: 'Canada' } },
        );
        expect(facilities(candidate)).toEqual(['MUHC']);
      });

      it('never matches a name that folds to no words, on either side', async () => {
        // `.` and `-` fold to nothing, as does a blank site city; were an empty
        // fold to match, the two cityless sites would take the city tier.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Blank city', '', 'Ontario', 'Canada'),
            site('Princess Margaret', 'Toronto', 'Ontario', 'Canada'),
            site('Dash city', '-', 'Ontario', 'Canada'),
          ]),
          { location: { city: '.', country: 'Canada' } },
        );
        expect(facilities(candidate)).toEqual(['Blank city', 'Princess Margaret', 'Dash city']);
        expect(candidate.locationSummary).toBeUndefined();
      });

      it('passes the country gate for México on sites filed Mexico', async () => {
        // Guadalajara is also a Spanish city; with the gate applied, the
        // Spanish namesake earns no city credit.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Namesake', 'Guadalajara', 'Castilla-La Mancha', 'Spain'),
            site('Hospital Civil', 'Guadalajara', 'Jalisco', 'Mexico'),
          ]),
          { location: { city: 'Guadalajara', country: 'México' } },
        );
        expect(facilities(candidate)).toEqual(['Hospital Civil']);
      });

      it('gives the country point to every site whose country carries the requested words', async () => {
        // `Korea` passes the gate on `South Korea`; the country tier is the
        // Korean sites, not every site the study registers.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Asan', 'Seoul', '', 'South Korea'),
            site('Tokyo', 'Tokyo', '', 'Japan'),
            site('Pusan National', 'Busan', '', 'South Korea'),
          ]),
          { location: { country: 'Korea' } },
        );
        expect(facilities(candidate)).toEqual(['Asan', 'Pusan National']);
        expect(candidate.locationSummary).toMatchObject({ totalLocations: 3, matchedLocations: 2 });
      });

      describe('the added recruiting site stays in the requested country', () => {
        const at = (lat: number, lon: number) => ({ lat, lon });

        it('takes it from South Korea for a Korea request, over a nearer site in China', async () => {
          // Dandong is ~362 km from Seoul, Jeju ~454 km.
          const candidate = await runOne(
            studyWith('NCT1', [
              site('Asan', 'Seoul', '', 'South Korea', 'NOT_YET_RECRUITING', at(37.5665, 126.978)),
              site('Dandong', 'Dandong', 'Liaoning', 'China', 'RECRUITING', at(40.1292, 124.3947)),
              site('Jeju National', 'Jeju', '', 'South Korea', 'RECRUITING', at(33.4996, 126.5312)),
            ]),
            { location: { city: 'Seoul', country: 'Korea' } },
          );
          expect(facilities(candidate)).toEqual(['Asan', 'Jeju National']);
          expect(candidate.locationSummary).toMatchObject({ nearestRecruitingSiteAdded: true });
        });

        it('takes it from Mexico for a México request, over a nearer site across the border', async () => {
          // San Diego is ~25 km from Tijuana, Mexico City ~2,300 km.
          const candidate = await runOne(
            studyWith('NCT1', [
              site(
                'Tijuana',
                'Tijuana',
                'Baja California',
                'Mexico',
                'NOT_YET_RECRUITING',
                at(32.5149, -117.0382),
              ),
              site(
                'UCSD',
                'San Diego',
                'California',
                'United States',
                'RECRUITING',
                at(32.7157, -117.1611),
              ),
              site(
                'INCan',
                'Mexico City',
                'Ciudad de México',
                'Mexico',
                'RECRUITING',
                at(19.4326, -99.1332),
              ),
            ]),
            { location: { city: 'Tijuana', country: 'México' } },
          );
          expect(facilities(candidate)).toEqual(['Tijuana', 'INCan']);
        });
      });
    });

    // ClinicalTrials.gov resolves country synonyms (USA, UK) and, bound to the
    // United States, state abbreviations (WA), so a study is found whichever
    // spelling the caller writes. The ranking compares each as the registry
    // spelling it resolves to, so its sites rank as that spelling's do, while
    // the query and its echo keep the caller's spelling (#172). The rows
    // themselves are tabled in the place-names suite; these prove the wiring.
    describe('synonyms upstream resolves (#172)', () => {
      /** NCT07864168's shape: the Washington sites file after a dozen others. */
      const washingtonStudy = () =>
        studyWith('NCT07864168', [
          site('Chula Vista', 'Chula Vista', 'California'),
          site('Santa Barbara', 'Santa Barbara', 'California'),
          site('Walnut Creek', 'Walnut Creek', 'California'),
          site('Aurora A', 'Aurora', 'Colorado'),
          site('Aurora B', 'Aurora', 'Colorado'),
          site('Atlanta', 'Atlanta', 'Georgia'),
          site('Idaho Falls', 'Idaho Falls', 'Idaho'),
          site('Austin', 'Austin', 'Texas'),
          site('San Antonio', 'San Antonio', 'Texas'),
          site('Charlottesville', 'Charlottesville', 'Virginia'),
          site('Portland', 'Portland', 'Oregon'),
          site('Boise', 'Boise', 'Idaho'),
          site('Renton', 'Renton', 'Washington'),
          site('Seattle', 'Seattle', 'Washington'),
        ]);

      it('ranks a WA request as Washington: the Washington sites, not the first ten', async () => {
        const abbreviated = await runOne(washingtonStudy(), {
          location: { state: 'WA', country: 'United States' },
        });
        const spelled = await runOne(washingtonStudy(), {
          location: { state: 'Washington', country: 'United States' },
        });
        expect(facilities(abbreviated)).toEqual(['Renton', 'Seattle']);
        expect(abbreviated.locationSummary).toEqual({
          totalLocations: 14,
          matchedLocations: 2,
          locationsTruncated: false,
          retrieveFullStudyWith: 'clinicaltrials_get_study_record',
        });
        expect(abbreviated).toEqual(spelled);
      });

      // The Perth site files state Washington, country Australia, as some
      // registry records do: the gate keeps it out of a United States tier.
      it.each([
        { state: 'WA', country: 'USA' },
        { state: 'wa', country: 'United States' },
      ])('ranks $state + $country as Washington + United States', async (location) => {
        const study = () =>
          studyWith('NCT1', [
            site('Perth', 'Perth', 'Washington', 'Australia'),
            site('Portland', 'Portland', 'Oregon'),
            site('Renton', 'Renton', 'Washington'),
          ]);
        const synonym = await runOne(study(), { location });
        const registry = await runOne(study(), {
          location: { state: 'Washington', country: 'United States' },
        });
        expect(facilities(synonym)).toEqual(['Renton']);
        expect(synonym.locationSummary).toMatchObject({ totalLocations: 3, matchedLocations: 1 });
        expect(synonym).toEqual(registry);
      });

      it('ranks a USA request as United States: the US site, not the Australian one', async () => {
        const study = () =>
          studyWith('NCT07873450', [
            site('Minneapolis', 'Minneapolis', 'Minnesota'),
            site('Nedlands', 'Nedlands', 'Western Australia', 'Australia'),
          ]);
        const synonym = await runOne(study(), { location: { country: 'USA' } });
        const registry = await runOne(study(), { location: { country: 'United States' } });
        expect(facilities(synonym)).toEqual(['Minneapolis']);
        expect(synonym.locationSummary).toMatchObject({ totalLocations: 2, matchedLocations: 1 });
        expect(synonym).toEqual(registry);
      });

      it.each(['UK', 'u.k.'])(
        'gates a London + %s request: London, Ontario earns no city credit',
        async (country) => {
          const candidate = await runOne(
            studyWith('NCT1', [
              site('Victoria Hospital', 'London', 'Ontario', 'Canada'),
              site('St Thomas', 'London', '', 'United Kingdom'),
              site('Christie', 'Manchester', '', 'United Kingdom'),
            ]),
            { location: { city: 'London', country } },
          );
          expect(facilities(candidate)).toEqual(['St Thomas']);
          expect(candidate.locationSummary).toMatchObject({
            totalLocations: 3,
            matchedLocations: 1,
          });
        },
      );

      it('gives a WA + Australia request no credit from the US state rows', async () => {
        // Read as Washington, WA would put the Perth site filed state
        // Washington alone in the tier.
        const candidate = await runOne(
          studyWith('NCT1', [
            site('Fiona Stanley', 'Perth', 'Western Australia', 'Australia'),
            site('Perth Washington', 'Perth', 'Washington', 'Australia'),
            site('Seattle', 'Seattle', 'Washington'),
          ]),
          { location: { state: 'WA', country: 'Australia' } },
        );
        expect(facilities(candidate)).toEqual(['Fiona Stanley', 'Perth Washington']);
        expect(candidate.locationSummary).toMatchObject({ totalLocations: 3, matchedLocations: 2 });
      });

      it('renders the synonym-ranked sites on content[] too', async () => {
        mockService.searchStudies.mockResolvedValue({
          studies: [washingtonStudy()],
          totalCount: 1,
        });
        const result = await runToolContract(findEligible, {
          ...baseInput,
          location: { state: 'WA', country: 'USA' },
        });
        const text = (result.content as { text: string }[]).map((b) => b.text).join('\n');
        expect(text).toContain(
          '  Sites: showing 2 of 14 registered (2 match the requested location). Full site list: clinicaltrials_get_study_record with NCT07864168.',
        );
        expect(text).toContain(
          '  Locations: Renton, Renton, Washington, United States [RECRUITING] | Seattle, Seattle, Washington, United States [RECRUITING]\n',
        );
        expect(text).not.toContain('Chula Vista');
        const sc = result.structuredContent as { studies: CandidateStudy[] };
        expect(facilities(sc.studies[0]!)).toEqual(['Renton', 'Seattle']);
      });

      it('sends and echoes the caller spelling upstream, unchanged', async () => {
        mockService.searchStudies.mockResolvedValue({
          studies: [washingtonStudy()],
          totalCount: 1,
        });
        const ctx = createMockContext({ errors: findEligible.errors });
        await findEligible.handler(
          findEligible.input!.parse({
            ...baseInput,
            location: { city: 'Seattle', state: 'WA', country: 'USA' },
          }),
          ctx,
        );
        const expected =
          'SEARCH[Location](Seattle AND (AREA[LocationState]"WA" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"USA")';
        expect(mockService.searchStudies).toHaveBeenCalledWith(
          expect.objectContaining({ queryLocn: expected }),
          expect.anything(),
        );
        expect((getEnrichment(ctx).searchCriteria as { location: string }).location).toBe(expected);
      });
    });
  });

  // The condition query strips `"`, so a quoted condition finds the same
  // studies as the bare one and must re-rank them the same way (#155 mechanism).
  describe('quoted conditions keep their re-rank tier', () => {
    const conditionStudy = (nctId: string, conditions: string[]) => ({
      protocolSection: { identificationModule: { nctId }, conditionsModule: { conditions } },
    });

    const rankedIds = async (conditions: string[]) => {
      vi.clearAllMocks();
      mockGetService.mockReturnValue(mockService as never);
      // Upstream relevance order puts the subtype (tier 2) ahead of the exact match.
      mockService.searchStudies.mockResolvedValue({
        studies: [
          conditionStudy('NCT_SUBTYPE', ['Type 2 Diabetes Mellitus']),
          conditionStudy('NCT_EXACT', ['Type 2 Diabetes']),
        ],
        totalCount: 2,
      });
      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(
        findEligible.input!.parse({ ...baseInput, conditions }),
        ctx,
      );
      return result.studies.map(
        (s) =>
          (s as { protocolSection: { identificationModule: { nctId: string } } }).protocolSection
            .identificationModule.nctId,
      );
    };

    it('ranks the exact match first for "\\"Type 2 Diabetes\\"" as for the bare condition', async () => {
      const bare = await rankedIds(['Type 2 Diabetes']);
      const quoted = await rankedIds(['"Type 2 Diabetes"']);
      expect(bare).toEqual(['NCT_EXACT', 'NCT_SUBTYPE']);
      expect(quoted).toEqual(bare);
    });
  });
});

describe('conditionMatchScore (#79 lexical condition re-rank)', () => {
  it('scores a quoted requested condition as its bare form', () => {
    expect(conditionMatchScore(['ALS'], ['"ALS"'])).toBe(3);
    expect(conditionMatchScore(['Type 2 Diabetes'], ['"Type 2 Diabetes"'])).toBe(3);
    expect(conditionMatchScore(['Type 2 Diabetes'], [' "Type 2 Diabetes" '])).toBe(3);
  });

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
