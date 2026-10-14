/**
 * @fileoverview Security tests for tool inputs: injection, oversized inputs,
 * no-secret-leaks, and path traversal prevention.
 * @module tests/mcp-server/tools/security
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock service — hoisted so vi.mock can close over it
// ---------------------------------------------------------------------------

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';
import { getFieldDefinitions } from '@/mcp-server/tools/definitions/get-field-definitions.tool.js';
import { getFieldValues } from '@/mcp-server/tools/definitions/get-field-values.tool.js';
import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';
import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Assert that no string in `output` contains a known secret pattern.
 * The test server has no real secrets — asserts env-var names aren't leaked.
 */
function assertNoSecretLeak(output: unknown) {
  const text = JSON.stringify(output);
  // No env var names that could carry credentials should appear in output
  expect(text).not.toMatch(/CT_API_BASE_URL|CT_REQUEST_TIMEOUT_MS|CT_MAX_PAGE_SIZE/);
  // No process.env patterns
  expect(text).not.toContain('process.env');
}

// ---------------------------------------------------------------------------
// Injection payloads
// ---------------------------------------------------------------------------

const INJECTION_PAYLOADS = [
  // SQL/query injection
  "'; DROP TABLE studies; --",
  "1' OR '1'='1",
  "' UNION SELECT * FROM studies --",
  // URL/path traversal
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  // Prototype pollution
  '__proto__',
  'constructor.prototype',
  '[object Object]',
  // Script injection
  '<script>alert(1)</script>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional injection payload test
  '${7*7}',
  '{{7*7}}',
  // Null bytes
  'normal\x00injection',
  // Unicode normalization attack
  '‮anormaltext',
];

const OVERSIZED_INPUTS = {
  string1k: 'A'.repeat(1_000),
  string10k: 'B'.repeat(10_000),
  string100k: 'C'.repeat(100_000),
};

// ---------------------------------------------------------------------------
// searchStudies — input validation security
// ---------------------------------------------------------------------------

describe('searchStudies — injection and oversized inputs', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
  });

  it.each(INJECTION_PAYLOADS)(
    'query field passes injection payload %s to the service (Zod does not sanitize strings)',
    async (payload) => {
      // Zod does not strip or reject arbitrary strings in free-text fields.
      // The important invariant is no crash and no prototype pollution.
      const ctx = createMockContext({ errors: searchStudies.errors });
      const input = searchStudies.input!.parse({ query: payload });
      await expect(searchStudies.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('rejects NCT ID injection that does not match NCTxxxxxxxx format', () => {
    expect(() => searchStudies.input!.parse({ nctIds: "'; DROP TABLE --" })).toThrow();
  });

  it('rejects NCT ID array containing injection payload', () => {
    expect(() => searchStudies.input!.parse({ nctIds: ['NCT12345678', "' OR 1=1 --"] })).toThrow();
  });

  it('oversized query string — handler does not crash', async () => {
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    const ctx = createMockContext({ errors: searchStudies.errors });
    const input = searchStudies.input!.parse({ query: OVERSIZED_INPUTS.string1k });
    await expect(searchStudies.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    mockService.searchStudies.mockResolvedValue({
      studies: [{ nctId: 'NCT12345678' }],
      totalCount: 1,
    });
    const ctx = createMockContext({ errors: searchStudies.errors });
    const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);
    assertNoSecretLeak(result);
  });

  it.each(['', '   '])(
    'rejects a blank query (%j) rather than searching the whole registry',
    async (query) => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(searchStudies.input!.parse({ query }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    },
  );

  // phaseFilter entries are interpolated into AREA[Phase]<entry>; an
  // expression there must be refused, never forwarded to widen the cohort (#144).
  it.each([
    'PHASE3 OR AREA[StudyType]OBSERVATIONAL',
    'PHASE3) OR (AREA[StudyType]OBSERVATIONAL',
    'NOT AREA[StudyType]INTERVENTIONAL',
    ...INJECTION_PAYLOADS,
  ])('refuses the phaseFilter payload %j with enum_invalid before any request', async (payload) => {
    const ctx = createMockContext({ errors: searchStudies.errors });
    await expect(
      searchStudies.handler(searchStudies.input!.parse({ phaseFilter: ['PHASE3', payload] }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'enum_invalid', param: 'phaseFilter' } });
    expect(mockService.searchStudies).not.toHaveBeenCalled();
  });

  // fields entries are split on `,`/`|` and handed to the service, which
  // validates each piece; a payload must neither crash the handler nor be
  // judged blank, and every piece of a joined payload reaches the service (#152).
  it.each([
    ...INJECTION_PAYLOADS.map((payload) => [payload, [payload]] as const),
    ["NCTId,'; DROP TABLE studies; --", ['NCTId', "'; DROP TABLE studies; --"]] as const,
    ['__proto__|constructor', ['__proto__', 'constructor']] as const,
  ])('passes the fields payload %j to the service as the names %j', async (payload, names) => {
    const ctx = createMockContext({ errors: searchStudies.errors });
    const input = searchStudies.input!.parse({ fields: [payload] });
    const result = await searchStudies.handler(input, ctx);
    expect(mockService.searchStudies).toHaveBeenCalledWith(
      expect.objectContaining({ fields: names }),
      ctx,
    );
    expect(result.requestedFields).toEqual(names);
  });
});

// ---------------------------------------------------------------------------
// getStudy — NCT ID injection and output safety
// ---------------------------------------------------------------------------

describe('getStudy — injection and output safety', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  it.each([
    "'; DROP TABLE studies; --",
    '../../../etc/passwd',
    '%2e%2e%2fNCT12345678',
    'NCT1234567A', // invalid — too short + non-numeric
  ])('rejects invalid NCT ID pattern: %s', (payload) => {
    expect(() => getStudy.input!.parse({ nctId: payload })).toThrow();
  });

  it('format output does not leak env var names', async () => {
    mockService.getStudy.mockResolvedValue({
      protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
    });
    const ctx = createMockContext({ errors: getStudy.errors });
    const result = await getStudy.handler(getStudy.input!.parse({ nctId: 'NCT12345678' }), ctx);
    assertNoSecretLeak(result);
    const formatted = getStudy.format!(result);
    assertNoSecretLeak(formatted);
  });
});

// ---------------------------------------------------------------------------
// getStudyCount — injection and output safety
// ---------------------------------------------------------------------------

describe('getStudyCount — injection and output safety', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 42 });
  });

  it.each(INJECTION_PAYLOADS)(
    'accepts free-text payload %s without crashing (no validation on plain strings)',
    async (payload) => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      const input = getStudyCount.input!.parse({ conditionQuery: payload });
      await expect(getStudyCount.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('oversized conditionQuery does not crash', async () => {
    const ctx = createMockContext({ errors: getStudyCount.errors });
    const input = getStudyCount.input!.parse({ conditionQuery: OVERSIZED_INPUTS.string1k });
    await expect(getStudyCount.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    const ctx = createMockContext({ errors: getStudyCount.errors });
    const result = await getStudyCount.handler(getStudyCount.input!.parse({}), ctx);
    assertNoSecretLeak(result);
  });

  it.each(['', '   '])(
    'rejects a blank conditionQuery (%j) rather than counting the whole registry',
    async (conditionQuery) => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await expect(
        getStudyCount.handler(getStudyCount.input!.parse({ conditionQuery }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    },
  );

  it.each([
    'PHASE3 OR AREA[StudyType]OBSERVATIONAL',
    'NOT AREA[StudyType]INTERVENTIONAL',
    ...INJECTION_PAYLOADS,
  ])('refuses the phaseFilter payload %j with enum_invalid before any request', async (payload) => {
    const ctx = createMockContext({ errors: getStudyCount.errors });
    await expect(
      getStudyCount.handler(getStudyCount.input!.parse({ phaseFilter: payload }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'enum_invalid', param: 'phaseFilter' } });
    expect(mockService.searchStudies).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getStudyResults — injection and output safety
// ---------------------------------------------------------------------------

describe('getStudyResults — injection and output safety', () => {
  const mockService = { getStudiesBatch: vi.fn(), getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getStudiesBatch.mockResolvedValue([]);
  });

  it.each(["'; DROP TABLE --", '../../../etc/passwd', '__proto__'])(
    'rejects injection payload %s as NCT ID',
    (payload) => {
      expect(() => getStudyResults.input!.parse({ nctIds: payload })).toThrow();
    },
  );

  // The nctId alias (#151) resolves in the argument stage `input.parse()` skips.
  it.each(["'; DROP TABLE --", '../../../etc/passwd', '__proto__'])(
    'rejects injection payload %s sent under the nctId alias',
    async (payload) => {
      const result = await runToolContract(getStudyResults, { nctId: payload } as never);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        'nctIds: NCT IDs must match format NCTxxxxxxxx (8 digits).',
      );
      expect(mockService.getStudiesBatch).not.toHaveBeenCalled();
    },
  );

  it('format output does not leak env var names', () => {
    const formatted = getStudyResults.format!({
      results: [{ nctId: 'NCT12345678', title: 'Test', hasResults: false }],
    });
    assertNoSecretLeak(formatted);
  });

  it('rejects array exceeding 20 NCT IDs', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `NCT${String(i).padStart(8, '0')}`);
    expect(() => getStudyResults.input!.parse({ nctIds: ids })).toThrow();
  });

  it.each(['outcomeOffset', 'seriousEventOffset', 'otherEventOffset'])(
    'rejects a non-integer, negative, or non-finite %s',
    (param) => {
      for (const bad of [-1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          getStudyResults.input!.parse({ nctIds: 'NCT12345678', [param]: bad }),
        ).toThrow();
      }
    },
  );

  it('renders a bounded window and an alias resolution without leaking env var names', () => {
    const formatted = getStudyResults.format!({
      results: [
        {
          nctId: 'NCT12345678',
          canonicalNctId: 'NCT87654321',
          title: 'Test',
          hasResults: true,
          filtersApplied: {
            totalOutcomes: 40,
            outcomeLimit: 5,
            outcomeOffset: 10,
            nextOutcomeOffset: 15,
          },
        },
        {
          // A summary-mode page of the same window (#149).
          nctId: 'NCT11111111',
          title: 'Summary Test',
          hasResults: true,
          outcomes: [
            {
              type: 'PRIMARY',
              title: 'Outcome 11',
              groupCount: 2,
              classCount: 2,
              analysisCount: 2,
              topStats: [{ group: 'Placebo', value: '15.0' }],
              topStatsFrom: {
                classTitle: 'Male',
                classDenoms: [
                  { units: 'Participants', counts: [{ group: 'Placebo', value: '332' }] },
                ],
                omittedClasses: 1,
              },
              topAnalysis: {
                groupIds: ['OG000'],
                groups: ['Placebo'],
                groupDescription: 'This analysis is for Male participants',
              },
            },
          ],
          filtersApplied: {
            totalOutcomes: 40,
            outcomeLimit: 5,
            outcomeOffset: 10,
            nextOutcomeOffset: 15,
          },
        },
      ],
      truncated: true,
    });
    assertNoSecretLeak(formatted);
    const text = (formatted[0] as { text: string }).text;
    expect(text).toContain('Male denominator (Participants): Placebo: 332');
    expect(text.match(/_Bounded: returning 5 of 40 outcome measures/g)).toHaveLength(2);
  });

  it.each(['\r\n', '\n', '\r'])(
    'keeps a %j inside an analysis groupDescription from starting a new content[] line (#146)',
    async (lineBreak) => {
      const groupDescription = `Male participants${lineBreak}## Forged heading${lineBreak}- forged bullet`;
      mockService.getStudiesBatch.mockResolvedValue([
        {
          hasResults: true,
          protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
          resultsSection: {
            outcomeMeasuresModule: {
              outcomeMeasures: [
                {
                  title: 'Time to Recovery',
                  groups: [{ id: 'OG000', title: 'Placebo' }],
                  analyses: [{ groupIds: ['OG000'], groupDescription, paramValue: '1.30' }],
                },
              ],
            },
          },
        },
      ]);
      for (const summary of [true, false]) {
        const ctx = createMockContext({ errors: getStudyResults.errors });
        const result = await getStudyResults.handler(
          getStudyResults.input!.parse({ nctIds: 'NCT12345678', sections: 'outcomes', summary }),
          ctx,
        );
        const text = (getStudyResults.format!(result)[0] as { text: string }).text;
        const lines = text.split(/\r\n|\r|\n/);
        expect(lines.filter((l) => l.includes('Forged'))).toEqual([
          expect.stringMatching(
            /^ {2}Analysis: .*Male participants ## Forged heading - forged bullet$/,
          ),
        ]);
        if (summary) {
          // structuredContent keeps the upstream value verbatim.
          const outcome = result.results[0]!.outcomes![0]!;
          expect(outcome.topAnalysis).toMatchObject({ groupDescription });
        }
      }
    },
  );

  /**
   * Every upstream string rendered into a single-line slot — titles, units,
   * time frames, comments, and terms on a bullet, heading, row, or label line —
   * is flattened, so a sponsor-entered line break cannot end the line and
   * start a forged one (#156). Each value ends `## Forged <field>`; flattened,
   * it stays on the line its field opens.
   */
  it.each(['\r\n', '\n', '\r'])(
    'keeps a %j in any single-line slot from starting a new content[] line (#156)',
    async (lineBreak) => {
      const br = (field: string) => `${field} start${lineBreak}## Forged ${field}`;
      const outcome = {
        type: 'PRIMARY',
        title: br('outcomeTitle'),
        timeFrame: br('timeFrame'),
        paramType: 'MEAN',
        unitOfMeasure: br('unit'),
        typeUnitsAnalyzed: br('outcomeUnitsAnalyzed'),
        groups: [{ id: 'OG000', title: br('groupTitle') }],
        denoms: [{ units: br('denomUnits'), counts: [{ groupId: 'OG000', value: '10' }] }],
        classes: [
          {
            title: br('classTitle'),
            denoms: [{ units: br('classDenomUnits'), counts: [{ groupId: 'OG000', value: '9' }] }],
            categories: [
              {
                title: br('categoryTitle'),
                measurements: [{ groupId: 'OG000', value: '5', comment: br('cellComment') }],
              },
            ],
          },
          {
            title: 'Second class',
            categories: [{ measurements: [{ groupId: 'OG000', value: '6' }] }],
          },
        ],
        analyses: [
          {
            groupIds: ['OG000'],
            statisticalMethod: br('statisticalMethod'),
            statisticalComment: br('statisticalComment'),
            pValue: '0.01',
            pValueComment: br('pValueComment'),
            nonInferiorityType: 'SUPERIORITY',
            nonInferiorityComment: br('nonInferiorityComment'),
            paramType: 'Mean Difference',
            paramValue: '1.3',
            ciPctValue: '95',
            ciLowerLimit: '1',
            ciUpperLimit: '2',
            ciLowerLimitComment: br('ciLowerLimitComment'),
            ciUpperLimitComment: br('ciUpperLimitComment'),
            estimateComment: br('estimateComment'),
            otherAnalysisDescription: br('otherAnalysisDescription'),
          },
        ],
      };
      const study = {
        hasResults: true,
        protocolSection: {
          identificationModule: { nctId: 'NCT12345678', briefTitle: br('briefTitle') },
        },
        resultsSection: {
          outcomeMeasuresModule: { outcomeMeasures: [outcome] },
          baselineCharacteristicsModule: {
            typeUnitsAnalyzed: br('baselineUnitsAnalyzed'),
            groups: [{ id: 'BG000', title: br('baselineGroup') }],
            measures: [
              {
                title: br('baselineMeasure'),
                paramType: 'COUNT_OF_PARTICIPANTS',
                unitOfMeasure: br('baselineUnit'),
                denomUnitsSelected: br('baselineDenomUnits'),
                classes: [
                  {
                    title: br('baselineClass'),
                    categories: [
                      {
                        title: br('baselineCategory'),
                        measurements: [{ groupId: 'BG000', value: '3' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          adverseEventsModule: {
            timeFrame: br('aeTimeFrame'),
            frequencyThreshold: br('aeThreshold'),
            eventGroups: [{ id: 'EG000', title: br('aeGroupTitle') }],
            seriousEvents: [
              {
                term: br('aeTerm'),
                organSystem: br('aeOrganSystem'),
                stats: [{ groupId: 'EG000', numAffected: 1, numAtRisk: 10 }],
              },
            ],
          },
          participantFlowModule: {
            typeUnitsAnalyzed: br('flowUnitsAnalyzed'),
            groups: [{ id: 'FG000', title: br('flowGroup') }],
            periods: [
              {
                title: br('periodTitle'),
                milestones: [
                  {
                    type: br('milestoneType'),
                    comment: br('milestoneComment'),
                    achievements: [
                      { groupId: 'FG000', numSubjects: '10', comment: br('achievementComment') },
                    ],
                  },
                ],
                dropWithdraws: [
                  {
                    type: br('dropType'),
                    comment: br('dropComment'),
                    reasons: [{ groupId: 'FG000', numSubjects: '1' }],
                  },
                ],
              },
            ],
          },
          moreInfoModule: {
            certainAgreement: { restrictiveAgreement: true, restrictionType: br('restriction') },
            pointOfContact: { title: br('pocTitle'), organization: br('pocOrganization') },
          },
        },
      };
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const everywhere = [
        'briefTitle',
        'outcomeTitle',
        'timeFrame',
        'unit',
        'groupTitle',
        'denomUnits',
        'classTitle',
        'classDenomUnits',
        'categoryTitle',
        'cellComment',
        'statisticalMethod',
        'pValueComment',
        'estimateComment',
        'baselineMeasure',
        'baselineUnit',
        'aeTimeFrame',
        'aeGroupTitle',
        'aeTerm',
        'aeOrganSystem',
        'restriction',
        'pocTitle',
        'pocOrganization',
      ];
      const fullOnly = [
        'outcomeUnitsAnalyzed',
        'statisticalComment',
        'nonInferiorityComment',
        'ciLowerLimitComment',
        'ciUpperLimitComment',
        'otherAnalysisDescription',
        'baselineUnitsAnalyzed',
        'baselineGroup',
        'baselineDenomUnits',
        'baselineClass',
        'baselineCategory',
        'aeThreshold',
        'flowUnitsAnalyzed',
        'flowGroup',
        'periodTitle',
        'milestoneType',
        'milestoneComment',
        'achievementComment',
        'dropType',
        'dropComment',
      ];

      for (const summary of [true, false]) {
        const ctx = createMockContext({ errors: getStudyResults.errors });
        const result = await getStudyResults.handler(
          getStudyResults.input!.parse({ nctIds: 'NCT12345678', summary }),
          ctx,
        );
        const lines = (getStudyResults.format!(result)[0] as { text: string }).text.split(
          /\r\n|\r|\n/,
        );

        expect(lines.filter((l) => /^\s*## Forged/.test(l))).toEqual([]);
        for (const field of summary ? everywhere : [...everywhere, ...fullOnly]) {
          const rendered = lines.filter((l) =>
            new RegExp(`## Forged ${field}(?![A-Za-z])`).test(l),
          );
          expect(rendered, field).not.toEqual([]);
          for (const line of rendered) {
            expect(line, field).toContain(`${field} start ## Forged ${field}`);
          }
        }

        // structuredContent keeps every upstream value verbatim.
        const r = result.results[0]!;
        expect(r.title).toBe(br('briefTitle'));
        const shown = r.outcomes![0]!;
        expect(shown).toMatchObject({ title: br('outcomeTitle'), timeFrame: br('timeFrame') });
        if (summary) {
          expect(shown.topStatsFrom).toMatchObject({
            classTitle: br('classTitle'),
            categoryTitle: br('categoryTitle'),
          });
          expect(shown.topAnalysis).toMatchObject({ estimateComment: br('estimateComment') });
        } else {
          expect(shown).toEqual(outcome);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// getFieldValues — injection and output safety
// ---------------------------------------------------------------------------

describe('getFieldValues — injection and output safety', () => {
  const mockService = { getFieldValues: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getFieldValues.mockResolvedValue([]);
  });

  it.each(INJECTION_PAYLOADS)(
    'passes injection payload %s as field name string to service (no crash)',
    async (payload) => {
      const ctx = createMockContext({ errors: getFieldValues.errors });
      // Zod accepts any string for field names — the API rejects invalid ones
      const input = getFieldValues.input!.parse({ fields: payload });
      await expect(getFieldValues.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('output does not contain env var names', async () => {
    mockService.getFieldValues.mockResolvedValue([
      { field: 'OverallStatus', piece: 'OverallStatus', type: 'ENUM', topValues: [] },
    ]);
    const ctx = createMockContext({ errors: getFieldValues.errors });
    const result = await getFieldValues.handler(
      getFieldValues.input!.parse({ fields: 'OverallStatus' }),
      ctx,
    );
    assertNoSecretLeak(result);
  });
});

// ---------------------------------------------------------------------------
// getFieldDefinitions — path traversal and injection
// ---------------------------------------------------------------------------

describe('getFieldDefinitions — path traversal and injection', () => {
  const mockService = { getMetadata: vi.fn(), searchFieldDefinitions: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getMetadata.mockResolvedValue([]);
    mockService.searchFieldDefinitions.mockResolvedValue({ entries: [], total: 0 });
  });

  it.each(['../../../etc/passwd', '..\\windows\\system32', '%2e%2e%2f'])(
    'drill mode with path traversal payload "%s" throws (path not found) and does not crash',
    async (payload) => {
      const ctx = createMockContext({ errors: getFieldDefinitions.errors });
      const input = getFieldDefinitions.input!.parse({ mode: 'drill', path: payload });
      // Handler should throw "path not found" since no such node exists — not a crash
      await expect(getFieldDefinitions.handler(input, ctx)).rejects.toThrow();
    },
  );

  it.each(INJECTION_PAYLOADS)(
    'search mode passes injection payload %s to searchFieldDefinitions without crash',
    async (payload) => {
      const ctx = createMockContext({ errors: getFieldDefinitions.errors });
      const input = getFieldDefinitions.input!.parse({ mode: 'search', query: payload });
      await expect(getFieldDefinitions.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('format output does not leak env var names', async () => {
    const ctx = createMockContext({ errors: getFieldDefinitions.errors });
    const result = await getFieldDefinitions.handler(
      getFieldDefinitions.input!.parse({ mode: 'overview' }),
      ctx,
    );
    assertNoSecretLeak(result);
    const formatted = getFieldDefinitions.format!(result);
    assertNoSecretLeak(formatted);
  });
});

// ---------------------------------------------------------------------------
// findEligible — injection and output safety
// ---------------------------------------------------------------------------

describe('findEligible — injection and output safety', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
  });

  const baseInput = {
    age: 30,
    sex: 'ALL' as const,
    conditions: ['Diabetes'],
    location: { country: 'United States' },
  };

  it.each(INJECTION_PAYLOADS)('condition payload %s passes without crash', async (payload) => {
    const ctx = createMockContext({ errors: findEligible.errors });
    const input = findEligible.input!.parse({
      ...baseInput,
      conditions: [payload],
    });
    await expect(findEligible.handler(input, ctx)).resolves.toBeDefined();
  });

  it('rejects empty conditions array without reaching the service', async () => {
    const ctx = createMockContext({ errors: findEligible.errors });
    await expect(
      findEligible.handler(findEligible.input!.parse({ ...baseInput, conditions: [] }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'blank_value', param: 'conditions' } });
    expect(mockService.searchStudies).not.toHaveBeenCalled();
  });

  it('rejects age below 0', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, age: -1 })).toThrow();
  });

  it('rejects age above 120', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, age: 999 })).toThrow();
  });

  it('rejects invalid sex values', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, sex: 'UNKNOWN' as never })).toThrow();
  });

  it('rejects maxResults above 50', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, maxResults: 51 })).toThrow();
  });

  it('location city injection payload does not crash handler', async () => {
    const ctx = createMockContext({ errors: findEligible.errors });
    const input = findEligible.input!.parse({
      ...baseInput,
      location: { country: 'United States', city: "'; DROP TABLE --" },
    });
    await expect(findEligible.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    const ctx = createMockContext({ errors: findEligible.errors });
    const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
    assertNoSecretLeak(result);
  });

  it('format output does not contain env var names', () => {
    const formatted = findEligible.format!({ studies: [], totalCount: 0 });
    assertNoSecretLeak(formatted);
  });

  // Quote-only forms are blank too: the query builder strips `"` (#145). So are
  // zero-width forms: U+200B survives String.trim() but carries no content.
  it.each(['', '   ', '""', '" "', '​', '"​"'])(
    'rejects a blank condition entry (%j) rather than matching every trial',
    async (condition) => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expect(
        findEligible.handler(
          findEligible.input!.parse({ ...baseInput, conditions: [condition] }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', '""', '" "', '​'])(
    'rejects a blank location.country (%j)',
    async (country) => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expect(
        findEligible.handler(
          findEligible.input!.parse({ ...baseInput, location: { country } }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Cross-cutting: format() output never leaks env vars
// ---------------------------------------------------------------------------

describe('format() outputs — no environment variable leaks', () => {
  it('searchStudies.format never leaks env var names', () => {
    const output = searchStudies.format!({ studies: [] });
    assertNoSecretLeak(output);
  });

  it('getStudyCount.format never leaks env var names', () => {
    const output = getStudyCount.format!({ totalCount: 0 });
    assertNoSecretLeak(output);
  });

  it('getStudyResults.format never leaks env var names', () => {
    const output = getStudyResults.format!({ results: [] });
    assertNoSecretLeak(output);
  });

  it('getFieldValues.format never leaks env var names', () => {
    const output = getFieldValues.format!({ fieldStats: [] });
    assertNoSecretLeak(output);
  });

  it('getFieldDefinitions.format never leaks env var names', () => {
    const output = getFieldDefinitions.format!({ fields: [], totalFields: 0 });
    assertNoSecretLeak(output);
  });

  it('findEligible.format never leaks env var names', () => {
    const output = findEligible.format!({ studies: [], totalCount: 0 });
    assertNoSecretLeak(output);
  });
});
