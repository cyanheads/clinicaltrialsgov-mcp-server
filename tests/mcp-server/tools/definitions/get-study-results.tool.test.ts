/**
 * @fileoverview Tests for clinicaltrials_get_study_results tool.
 * @module tests/mcp-server/tools/definitions/get-study-results.tool
 */

import {
  JsonRpcErrorCode,
  notFound,
  rateLimited,
  requestCancelled,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { loadStudyFixture, missingLeaves } from '../../../helpers/format-parity.js';

const SECTIONS = ['outcomes', 'adverseEvents', 'participantFlow', 'baseline', 'moreInfo'] as const;

function makeStudy(
  nctId: string,
  hasResults: boolean,
  resultsSection?: Record<string, Record<string, unknown>>,
): RawStudyShape {
  return {
    hasResults,
    protocolSection: {
      identificationModule: { nctId, briefTitle: `Study ${nctId}` },
    },
    ...(resultsSection !== undefined ? { resultsSection } : {}),
  };
}

describe('getStudyResults', () => {
  const mockService = { getStudiesBatch: vi.fn(), getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('accepts a single NCT ID string', () => {
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      expect(input.nctIds).toBe('NCT12345678');
    });

    it('accepts an array of NCT IDs', () => {
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
      });
      expect(input.nctIds).toEqual(['NCT12345678', 'NCT87654321']);
    });

    it('rejects invalid NCT ID', () => {
      expect(() => getStudyResults.input!.parse({ nctIds: 'INVALID' })).toThrow();
    });

    it('rejects array with invalid NCT ID', () => {
      expect(() => getStudyResults.input!.parse({ nctIds: ['NCT12345678', 'BAD'] })).toThrow();
    });

    it('rejects more than 20 NCT IDs', () => {
      const ids = Array.from({ length: 21 }, (_, i) => `NCT${String(i).padStart(8, '0')}`);
      expect(() => getStudyResults.input!.parse({ nctIds: ids })).toThrow();
    });

    it('accepts valid sections enum', () => {
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'outcomes',
      });
      expect(input.sections).toBe('outcomes');
    });

    it('accepts array of sections', () => {
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: ['outcomes', 'adverseEvents'],
      });
      expect(input.sections).toEqual(['outcomes', 'adverseEvents']);
    });

    it('rejects invalid section names', () => {
      expect(() =>
        getStudyResults.input!.parse({
          nctIds: 'NCT12345678',
          sections: 'invalidSection',
        }),
      ).toThrow();
    });

    it('accepts the moreInfo section', () => {
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'moreInfo',
      });
      expect(input.sections).toBe('moreInfo');
    });

    it('defaults summary to false', () => {
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      expect(input.summary).toBe(false);
    });
  });

  describe('handler', () => {
    it('extracts results sections from a study with results', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [{ type: 'PRIMARY', title: 'Outcome 1' }],
        },
        adverseEventsModule: { timeFrame: '12 months' },
        participantFlowModule: { groups: [] },
        baselineCharacteristicsModule: { groups: [] },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.hasResults).toBe(true);
      expect(result.results[0]!.outcomes).toEqual([{ type: 'PRIMARY', title: 'Outcome 1' }]);
      expect(result.results[0]!.adverseEvents).toBeDefined();
      expect(result.results[0]!.participantFlow).toBeDefined();
      expect(result.results[0]!.baseline).toBeDefined();
    });

    it('tracks studies without results', async () => {
      mockService.getStudiesBatch.mockResolvedValue([makeStudy('NCT12345678', false)]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0]!.hasResults).toBe(false);
      expect(result.studiesWithoutResults).toEqual(['NCT12345678']);
    });

    it('filters to requested sections only', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
        adverseEventsModule: { timeFrame: '6 months' },
        participantFlowModule: { groups: [] },
        baselineCharacteristicsModule: { groups: [] },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'outcomes',
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0]!.outcomes).toBeDefined();
      expect(result.results[0]!.adverseEvents).toBeUndefined();
      expect(result.results[0]!.participantFlow).toBeUndefined();
      expect(result.results[0]!.baseline).toBeUndefined();
    });

    it('handles multiple sections filter', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
        adverseEventsModule: { timeFrame: '6 months' },
        participantFlowModule: { groups: [] },
        baselineCharacteristicsModule: { groups: [] },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: ['outcomes', 'baseline'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0]!.outcomes).toBeDefined();
      expect(result.results[0]!.baseline).toBeDefined();
      expect(result.results[0]!.adverseEvents).toBeUndefined();
      expect(result.results[0]!.participantFlow).toBeUndefined();
    });

    it('summarizes outcomes in summary mode', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [
            {
              type: 'PRIMARY',
              title: 'Overall Survival',
              timeFrame: '24 months',
              paramType: 'MEDIAN',
              unitOfMeasure: 'months',
              reportingStatus: 'POSTED',
              groups: [{ id: 'G1' }, { id: 'G2' }],
              classes: [{ id: 'C1' }],
            },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'outcomes',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const outcome = result.results[0]!.outcomes![0]!;

      expect(outcome.type).toBe('PRIMARY');
      expect(outcome.title).toBe('Overall Survival');
      expect(outcome.groupCount).toBe(2);
      expect(outcome.classCount).toBe(1);
      // Full data arrays should NOT be present in summary
      expect(outcome.groups).toBeUndefined();
      expect(outcome.classes).toBeUndefined();
    });

    it('summarizes adverse events in summary mode', async () => {
      const study = makeStudy('NCT12345678', true, {
        adverseEventsModule: {
          timeFrame: '12 months',
          eventGroups: [{ id: 'G1' }],
          seriousEvents: [{ term: 'Death' }],
          otherEvents: [{ term: 'Headache' }, { term: 'Nausea' }],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'adverseEvents',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const ae = result.results[0]!.adverseEvents!;

      expect(ae.timeFrame).toBe('12 months');
      expect(ae.groupCount).toBe(1);
      expect(ae.seriousEventCount).toBe(1);
      expect(ae.otherEventCount).toBe(2);
      // topEvents lists every serious + other term (no stats here → 0 affected).
      expect(ae.topEvents).toHaveLength(3);
    });

    it('ranks topEvents by participants affected across arms in summary mode (#61)', async () => {
      const study = makeStudy('NCT02130466', true, {
        adverseEventsModule: {
          timeFrame: '3 years',
          eventGroups: [
            { id: 'G1', title: 'Placebo' },
            { id: 'G2', title: 'Drug' },
          ],
          seriousEvents: [
            {
              term: 'Anaemia',
              organSystem: 'Blood and lymphatic system disorders',
              stats: [
                { groupId: 'G1', numAffected: 5, numAtRisk: 100 },
                { groupId: 'G2', numAffected: 12, numAtRisk: 100 },
              ],
            },
          ],
          otherEvents: [
            {
              term: 'Headache',
              organSystem: 'Nervous system disorders',
              stats: [
                { groupId: 'G1', numAffected: 30, numAtRisk: 100 },
                { groupId: 'G2', numAffected: 40, numAtRisk: 100 },
              ],
            },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT02130466',
        sections: 'adverseEvents',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const topEvents = result.results[0]!.adverseEvents!.topEvents as Array<{
        term: string;
        organSystem: string;
        kind: string;
        numAffected: number;
        numAtRisk: number;
      }>;

      expect(topEvents).toHaveLength(2);
      // Headache (30+40=70 affected) outranks Anaemia (5+12=17).
      expect(topEvents[0]).toEqual({
        term: 'Headache',
        organSystem: 'Nervous system disorders',
        kind: 'other',
        numAffected: 70,
        numAtRisk: 200,
      });
      expect(topEvents[1]).toMatchObject({ term: 'Anaemia', kind: 'serious', numAffected: 17 });
      // Raw event arrays must not leak into summary mode.
      expect(result.results[0]!.adverseEvents!.seriousEvents).toBeUndefined();
    });

    it('caps topEvents at 20 entries ranked by affected count (#61)', async () => {
      const otherEvents = Array.from({ length: 30 }, (_, i) => ({
        term: `Event ${i}`,
        stats: [{ groupId: 'G1', numAffected: i, numAtRisk: 100 }],
      }));
      const study = makeStudy('NCT02130466', true, {
        adverseEventsModule: { eventGroups: [{ id: 'G1' }], otherEvents },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT02130466',
        sections: 'adverseEvents',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const topEvents = result.results[0]!.adverseEvents!.topEvents as Array<{ term: string }>;
      expect(topEvents).toHaveLength(20);
      expect(topEvents[0]!.term).toBe('Event 29');
    });

    it('summarizes participant flow in summary mode', async () => {
      const study = makeStudy('NCT12345678', true, {
        participantFlowModule: {
          groups: [{ id: 'G1' }, { id: 'G2' }],
          periods: [{ title: 'Overall' }, { title: 'Follow-up' }],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'participantFlow',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const pf = result.results[0]!.participantFlow!;

      expect(pf.groupCount).toBe(2);
      expect(pf.periodCount).toBe(2);
    });

    it('summarizes baseline in summary mode', async () => {
      const study = makeStudy('NCT12345678', true, {
        baselineCharacteristicsModule: {
          groups: [{ id: 'G1' }],
          measures: [
            { title: 'Age', paramType: 'MEAN', unitOfMeasure: 'years' },
            { title: 'Sex', paramType: 'COUNT' },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'baseline',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const bl = result.results[0]!.baseline!;

      expect(bl.groupCount).toBe(1);
      expect(bl.measureCount).toBe(2);
    });

    it('summarizes moreInfo in summary mode — keeps flags + contact, drops otherDetails (#64)', async () => {
      const study = makeStudy('NCT02130466', true, {
        moreInfoModule: {
          limitationsAndCaveats: { description: 'Open-label extension.' },
          certainAgreement: {
            piSponsorEmployee: false,
            restrictiveAgreement: true,
            restrictionType: 'OTHER',
            otherDetails: 'Sponsor reviews abstracts 45 days prior to submission.',
          },
          pointOfContact: {
            title: 'SVP, Global Clinical Development',
            organization: 'Acme Pharma',
            email: 'disclosure@example.com',
            phone: '1-800-000-0000',
          },
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT02130466',
        sections: 'moreInfo',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const mi = result.results[0]!.moreInfo!;
      const agreement = mi.certainAgreement as Record<string, unknown>;

      expect(mi.limitationsAndCaveats).toEqual({ description: 'Open-label extension.' });
      expect(agreement.restrictiveAgreement).toBe(true);
      expect(agreement.restrictionType).toBe('OTHER');
      expect(agreement.piSponsorEmployee).toBe(false);
      // Verbose prose dropped in summary mode.
      expect(agreement.otherDetails).toBeUndefined();
      expect(mi.pointOfContact).toBeDefined();
    });

    it('returns full moreInfo in non-summary mode, including otherDetails (#64)', async () => {
      const study = makeStudy('NCT02130466', true, {
        moreInfoModule: {
          certainAgreement: { restrictiveAgreement: true, otherDetails: 'Full agreement text.' },
          pointOfContact: { title: 'Contact', email: 'x@example.com' },
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT02130466',
        sections: 'moreInfo',
        summary: false,
      });
      const result = await getStudyResults.handler(input, ctx);
      const agreement = result.results[0]!.moreInfo!.certainAgreement as Record<string, unknown>;
      expect(agreement.otherDetails).toBe('Full agreement text.');
    });

    it('includes moreInfo among the default (all) sections (#64)', async () => {
      const study = makeStudy('NCT02130466', true, {
        outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
        moreInfoModule: { pointOfContact: { email: 'x@example.com' } },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT02130466' });
      const result = await getStudyResults.handler(input, ctx);
      expect(result.results[0]!.moreInfo).toBeDefined();
    });

    it('lifts topAnalysis (p-value, CI, method) into summary mode when analyses present', async () => {
      const study = makeStudy('NCT04074161', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [
            {
              type: 'PRIMARY',
              title: 'Change in Body Weight (%)',
              groups: [{ id: 'G1' }, { id: 'G2' }],
              classes: [{ id: 'C1' }],
              analyses: [
                {
                  statisticalMethod: 'ANCOVA',
                  pValue: '<0.0001',
                  paramType: 'Treatment difference',
                  paramValue: '-9.38',
                  ciPctValue: '95',
                  ciNumSides: '2-Sided',
                  ciLowerLimit: '-11.97',
                  ciUpperLimit: '-6.80',
                  nonInferiorityType: 'SUPERIORITY',
                  groupIds: ['G1', 'G2'],
                },
              ],
            },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT04074161',
        sections: 'outcomes',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const outcome = result.results[0]!.outcomes![0]!;

      expect(outcome.topAnalysis).toMatchObject({
        statisticalMethod: 'ANCOVA',
        pValue: '<0.0001',
        paramValue: '-9.38',
        ciLowerLimit: '-11.97',
        ciUpperLimit: '-6.80',
        ciPctValue: '95',
        ciNumSides: '2-Sided',
        nonInferiorityType: 'SUPERIORITY',
        groupIds: ['G1', 'G2'],
      });
      // Raw analyses array must not leak through summary mode.
      expect(outcome.analyses).toBeUndefined();
    });

    it('omits topAnalysis when the measure has no analyses (sparse case)', async () => {
      const study = makeStudy('NCT05891496', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [
            {
              type: 'PRIMARY',
              title: 'Gene Expression',
              groups: [{ id: 'G1' }],
              classes: [{ id: 'C1' }],
            },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT05891496',
        sections: 'outcomes',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const outcome = result.results[0]!.outcomes![0]!;
      expect(outcome.topAnalysis).toBeUndefined();
    });

    it('retains the not-reached arm and renders "not reached" for MEDIAN measures (#76)', async () => {
      const study = makeStudy('NCT02819518', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [
            {
              type: 'SECONDARY',
              title: 'Duration of Response',
              paramType: 'MEDIAN',
              unitOfMeasure: 'Months',
              groups: [
                { id: 'OG000', title: 'Pembrolizumab + Chemotherapy' },
                { id: 'OG001', title: 'Placebo + Chemotherapy' },
              ],
              classes: [
                {
                  categories: [
                    {
                      measurements: [
                        { groupId: 'OG000', value: 'NA' },
                        { groupId: 'OG001', value: '6.5' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT02819518',
        sections: 'outcomes',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const topStats = result.results[0]!.outcomes![0]!.topStats as Array<{
        group: string;
        value: string;
      }>;

      // Both arms retained — the not-reached arm is no longer silently dropped.
      expect(topStats).toHaveLength(2);
      expect(topStats.find((s) => s.group.startsWith('Pembro'))?.value).toBe('not reached');
      expect(topStats.find((s) => s.group.startsWith('Placebo'))?.value).toBe('6.5');
    });

    it('renders NA/NR literally for non-MEDIAN measures but drops empty cells (#76)', async () => {
      const study = makeStudy('NCT02819518', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [
            {
              type: 'SECONDARY',
              title: 'Count of Responders',
              paramType: 'COUNT_OF_PARTICIPANTS',
              groups: [
                { id: 'G1', title: 'Arm A' },
                { id: 'G2', title: 'Arm B' },
                { id: 'G3', title: 'Arm C' },
              ],
              classes: [
                {
                  categories: [
                    {
                      measurements: [
                        { groupId: 'G1', value: 'NA' },
                        { groupId: 'G2', value: '12' },
                        { groupId: 'G3', value: null },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT02819518',
        sections: 'outcomes',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const topStats = result.results[0]!.outcomes![0]!.topStats as Array<{
        group: string;
        value: string;
      }>;

      // NA passes through literally (not MEDIAN); the genuinely-empty cell is dropped.
      expect(topStats).toHaveLength(2);
      expect(topStats.find((s) => s.group === 'Arm A')?.value).toBe('NA');
      expect(topStats.find((s) => s.group === 'Arm B')?.value).toBe('12');
      expect(topStats.some((s) => s.group === 'Arm C')).toBe(false);
    });

    it('renders topAnalysis line in summary format() output', async () => {
      const study = makeStudy('NCT04074161', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [
            {
              type: 'PRIMARY',
              title: 'Change in Body Weight (%)',
              groups: [{ id: 'G1' }, { id: 'G2' }],
              classes: [{ id: 'C1' }],
              analyses: [
                {
                  statisticalMethod: 'ANCOVA',
                  pValue: '<0.0001',
                  paramType: 'Treatment difference',
                  paramValue: '-9.38',
                  ciPctValue: '95',
                  ciLowerLimit: '-11.97',
                  ciUpperLimit: '-6.80',
                },
              ],
            },
          ],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT04074161',
        sections: 'outcomes',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const blocks = getStudyResults.format!(result);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Analysis:');
      expect(text).toContain('Method: ANCOVA');
      expect(text).toContain('p=<0.0001');
      expect(text).toContain('95% CI [-11.97, -6.80]');
    });

    it('returns full data in non-summary mode', async () => {
      const study = makeStudy('NCT12345678', true, {
        adverseEventsModule: {
          timeFrame: '12 months',
          eventGroups: [{ id: 'G1' }],
          seriousEvents: [{ term: 'Death' }],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT12345678',
        sections: 'adverseEvents',
        summary: false,
      });
      const result = await getStudyResults.handler(input, ctx);
      const ae = result.results[0]!.adverseEvents!;

      // Full data should be preserved
      expect(ae.timeFrame).toBe('12 months');
      expect(ae.seriousEvents).toBeDefined();
    });

    it('handles batch of studies', async () => {
      mockService.getStudiesBatch.mockResolvedValue([
        makeStudy('NCT12345678', true, {
          outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
        }),
        makeStudy('NCT87654321', false),
      ]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toHaveLength(2);
      expect(result.results[0]!.hasResults).toBe(true);
      expect(result.results[1]!.hasResults).toBe(false);
      expect(result.studiesWithoutResults).toEqual(['NCT87654321']);
    });

    it('records fetch errors for missing studies in batch', async () => {
      mockService.getStudiesBatch.mockResolvedValue([makeStudy('NCT12345678', false)]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(result.fetchErrors).toEqual([{ nctId: 'NCT87654321', error: 'Study not found' }]);
    });

    it('returns fetchErrors gracefully when all studies are missing from the batch response', async () => {
      mockService.getStudiesBatch.mockResolvedValue([]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toEqual([]);
      expect(result.fetchErrors).toEqual([{ nctId: 'NCT12345678', error: 'Study not found' }]);
    });

    it('falls back to per-ID fetches when batch rejects; valid IDs succeed', async () => {
      // Batch rejects because one ID is bad (API's all-or-nothing behavior).
      mockService.getStudiesBatch.mockRejectedValue(
        new Error('Study ID(s) not found or rejected by API: NCT00000000'),
      );
      // Per-ID fallback: two valid, one invalid.
      mockService.getStudy.mockImplementation(async (nctId: string) => {
        if (nctId === 'NCT00000000') throw new Error('Study NCT00000000 not found');
        return makeStudy(nctId, nctId === 'NCT03722472', {
          outcomeMeasuresModule: { outcomeMeasures: [{ title: 'Measure' }] },
        });
      });

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT03722472', 'NCT05956821', 'NCT00000000'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(mockService.getStudy).toHaveBeenCalledTimes(3);
      expect(result.results).toHaveLength(2);
      expect(result.results.map((r) => r.nctId).sort()).toEqual(['NCT03722472', 'NCT05956821']);
      expect(result.fetchErrors).toEqual([
        { nctId: 'NCT00000000', error: expect.stringContaining('not found') },
      ]);
    });

    it('returns fetchErrors for all IDs when both batch and per-ID fallback fail', async () => {
      mockService.getStudiesBatch.mockRejectedValue(new Error('Batch rejected'));
      mockService.getStudy.mockRejectedValue(new Error('Study not found'));

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT99999999', 'NCT88888888'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toEqual([]);
      expect(result.fetchErrors).toEqual([
        { nctId: 'NCT99999999', error: 'Study not found' },
        { nctId: 'NCT88888888', error: 'Study not found' },
      ]);
    });

    it('handles study with empty resultsSection', async () => {
      mockService.getStudiesBatch.mockResolvedValue([makeStudy('NCT12345678', true, {})]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0]!.hasResults).toBe(true);
      expect(result.results[0]!.outcomes).toBeUndefined();
      expect(result.results[0]!.adverseEvents).toBeUndefined();
    });

    it('handles study with missing resultsSection', async () => {
      mockService.getStudiesBatch.mockResolvedValue([makeStudy('NCT12345678', true)]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0]!.hasResults).toBe(true);
      expect(result.results[0]!.outcomes).toBeUndefined();
    });
  });

  describe('payload caps (#97)', () => {
    /**
     * An outcome measure with a populated classes tree — a cap must trim whole
     * measures, never flatten the ones that survive.
     */
    const outcomeMeasure = (n: number) => ({
      type: n === 1 ? 'PRIMARY' : 'SECONDARY',
      title: `Outcome ${n}`,
      paramType: 'MEAN',
      unitOfMeasure: 'units',
      groups: [{ id: 'OG000', title: `Arm ${n}` }],
      classes: [
        {
          title: `Class ${n}A`,
          categories: [
            { title: `Category ${n}A1`, measurements: [{ groupId: 'OG000', value: `${n}.1` }] },
          ],
        },
        {
          title: `Class ${n}B`,
          categories: [
            { title: `Category ${n}B1`, measurements: [{ groupId: 'OG000', value: `${n}.2` }] },
          ],
        },
      ],
      analyses: [{ statisticalMethod: `Method ${n}`, pValue: `0.0${n}` }],
    });

    const adverseEvent = (kind: string, n: number) => ({
      term: `${kind} term ${n}`,
      organSystem: `${kind} system ${n}`,
      stats: [{ groupId: 'EG000', numAffected: n, numAtRisk: 100 }],
    });

    const resultsStudy = (outcomes: number, serious: number, other: number) =>
      makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: Array.from({ length: outcomes }, (_, i) => outcomeMeasure(i + 1)),
        },
        adverseEventsModule: {
          timeFrame: '12 months',
          eventGroups: [{ id: 'EG000', title: 'All participants' }],
          seriousEvents: Array.from({ length: serious }, (_, i) => adverseEvent('Serious', i + 1)),
          otherEvents: Array.from({ length: other }, (_, i) => adverseEvent('Other', i + 1)),
        },
      });

    const run = async (
      extra: Record<string, unknown>,
      study: RawStudyShape = resultsStudy(4, 3, 5),
    ) => {
      mockService.getStudiesBatch.mockResolvedValue([study]);
      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678', ...extra });
      const result = await getStudyResults.handler(input, ctx);
      return {
        result,
        entry: result.results[0]!,
        text: (getStudyResults.format!(result)[0] as { text: string }).text,
      };
    };

    it('returns every outcome measure and adverse event in full mode when no cap is passed', async () => {
      const { entry } = await run({});
      expect(entry.outcomes).toHaveLength(4);
      expect(entry.adverseEvents!.seriousEvents as unknown[]).toHaveLength(3);
      expect(entry.adverseEvents!.otherEvents as unknown[]).toHaveLength(5);
      expect(entry.filtersApplied).toBeUndefined();
    });

    it('caps outcome measures in full mode and preserves the upstream total', async () => {
      const { entry } = await run({ outcomeLimit: 2 });
      expect(entry.outcomes).toHaveLength(2);
      expect(entry.outcomes!.map((o) => o.title)).toEqual(['Outcome 1', 'Outcome 2']);
      expect(entry.filtersApplied).toEqual({ totalOutcomes: 4, outcomeLimit: 2 });
    });

    it('keeps the full nested tree of every surviving outcome measure', async () => {
      const { entry } = await run({ outcomeLimit: 1 });
      const survivor = entry.outcomes![0] as Record<string, unknown>;
      const classes = survivor.classes as Array<{ categories: Array<{ measurements: unknown[] }> }>;
      expect(classes).toHaveLength(2);
      expect(classes[1]!.categories[0]!.measurements).toHaveLength(1);
      expect(survivor.analyses).toHaveLength(1);
    });

    it('caps serious and other adverse events separately and preserves both totals', async () => {
      const { entry } = await run({ adverseEventLimit: 2 });
      const ae = entry.adverseEvents!;
      expect(ae.seriousEvents as unknown[]).toHaveLength(2);
      expect(ae.otherEvents as unknown[]).toHaveLength(2);
      expect(ae.eventGroups as unknown[]).toHaveLength(1);
      expect(entry.filtersApplied).toEqual({
        totalSeriousEvents: 3,
        totalOtherEvents: 5,
        adverseEventLimit: 2,
      });
    });

    it('records only the adverse-event list the cap actually trimmed', async () => {
      const { entry } = await run({ adverseEventLimit: 3 });
      expect(entry.adverseEvents!.seriousEvents as unknown[]).toHaveLength(3);
      expect(entry.adverseEvents!.otherEvents as unknown[]).toHaveLength(3);
      expect(entry.filtersApplied).toEqual({ totalOtherEvents: 5, adverseEventLimit: 3 });
    });

    it('reports nothing when a cap is at or above the upstream count (#80)', async () => {
      const { entry } = await run({ outcomeLimit: 4, adverseEventLimit: 5 });
      expect(entry.outcomes).toHaveLength(4);
      expect(entry.filtersApplied).toBeUndefined();
    });

    it('applies both caps together', async () => {
      const { entry } = await run({ outcomeLimit: 1, adverseEventLimit: 1 });
      expect(entry.outcomes).toHaveLength(1);
      expect(entry.adverseEvents!.seriousEvents as unknown[]).toHaveLength(1);
      expect(entry.filtersApplied).toEqual({
        totalOutcomes: 4,
        outcomeLimit: 1,
        totalSeriousEvents: 3,
        totalOtherEvents: 5,
        adverseEventLimit: 1,
      });
    });

    it('leaves summary mode uncapped — it is already condensed', async () => {
      const { entry } = await run({ outcomeLimit: 1, adverseEventLimit: 1, summary: true });
      expect(entry.outcomes).toHaveLength(4);
      expect(entry.adverseEvents!.seriousEventCount).toBe(3);
      expect(entry.adverseEvents!.otherEventCount).toBe(5);
      expect(entry.filtersApplied).toBeUndefined();
    });

    it('reports nothing for a study whose results sections are empty', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: { outcomeMeasures: [] },
        adverseEventsModule: { timeFrame: '12 months' },
      });
      const { entry } = await run({ outcomeLimit: 1, adverseEventLimit: 1 }, study);
      expect(entry.outcomes).toEqual([]);
      expect(entry.filtersApplied).toBeUndefined();
    });

    it('caps each study in a batch independently', async () => {
      mockService.getStudiesBatch.mockResolvedValue([
        resultsStudy(4, 3, 5),
        makeStudy('NCT87654321', true, {
          outcomeMeasuresModule: { outcomeMeasures: [outcomeMeasure(9)] },
        }),
      ]);
      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
        outcomeLimit: 2,
      });
      const result = await getStudyResults.handler(input, ctx);
      expect(result.results[0]!.filtersApplied).toEqual({ totalOutcomes: 4, outcomeLimit: 2 });
      expect(result.results[1]!.filtersApplied).toBeUndefined();
      expect(result.results[1]!.outcomes).toHaveLength(1);
    });

    it('rolls the per-study trims up into a batch-level truncated flag on both channels', async () => {
      const { result, text } = await run({ outcomeLimit: 2 });
      expect(result.truncated).toBe(true);
      expect(text).toContain('Truncated: a cap trimmed at least one list.');
    });

    it('omits truncated entirely when no cap trimmed anything', async () => {
      const { result, text } = await run({});
      expect(result.truncated).toBeUndefined();
      expect(text).not.toContain('Truncated:');
    });

    it('sets truncated when only one study in a batch was trimmed', async () => {
      mockService.getStudiesBatch.mockResolvedValue([
        resultsStudy(4, 3, 5),
        makeStudy('NCT87654321', true, {
          outcomeMeasuresModule: { outcomeMeasures: [outcomeMeasure(9)] },
        }),
      ]);
      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
        outcomeLimit: 2,
      });
      const result = await getStudyResults.handler(input, ctx);
      expect(result.results[1]!.filtersApplied).toBeUndefined();
      expect(result.truncated).toBe(true);
    });

    it('rejects a cap below 1', () => {
      expect(() =>
        getStudyResults.input!.parse({ nctIds: 'NCT12345678', outcomeLimit: 0 }),
      ).toThrow();
      expect(() =>
        getStudyResults.input!.parse({ nctIds: 'NCT12345678', adverseEventLimit: 0 }),
      ).toThrow();
    });

    it('discloses the trim on content[] with a route back to the omitted data', async () => {
      const { text } = await run({ outcomeLimit: 2, adverseEventLimit: 2 });
      expect(text).toContain('2 of 4 outcome measures');
      expect(text).toContain('2 of 3 serious');
      expect(text).toContain('2 of 5 other adverse events');
      expect(text).toContain('clinicaltrials_get_study_results');
    });

    it('renders the surviving measures, not the upstream count, in the outcomes header', async () => {
      const { text } = await run({ outcomeLimit: 2 });
      expect(text).toContain('### Outcomes (2 measures)');
      expect(text).not.toContain('Outcome 3');
    });

    it('says nothing about caps when nothing was trimmed', async () => {
      const { text } = await run({});
      expect(text).not.toContain('outcome measures');
    });

    it('keeps channel parity for a capped payload', async () => {
      const { result, text } = await run({ outcomeLimit: 2, adverseEventLimit: 2 });
      expect(missingLeaves(result, text)).toEqual([]);
    });
  });

  describe('error contract', () => {
    it('declares only reasons a handler path can throw (#101)', () => {
      // study_not_found is unreachable here: every missing study lands in
      // fetchErrors on a successful response (per #55). Pinned so a future
      // mechanical contract rollout cannot silently re-add a dead reason.
      expect(getStudyResults.errors?.map((e) => e.reason).sort()).toEqual([
        'blank_value',
        'rate_limited',
      ]);
    });

    it('keeps returning a missing study as a fetchErrors entry, not a thrown contract (#101)', async () => {
      mockService.getStudiesBatch.mockResolvedValue([]);

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const result = await getStudyResults.handler(
        getStudyResults.input!.parse({ nctIds: 'NCT00000000' }),
        ctx,
      );

      expect(result.results).toEqual([]);
      expect(result.fetchErrors).toEqual([{ nctId: 'NCT00000000', error: 'Study not found' }]);
    });
  });

  describe('rate-limit handling (#103)', () => {
    const batchRateLimit = () =>
      rateLimited('Rate limited by ClinicalTrials.gov after 3 retries', {
        path: '/studies',
        reason: 'rate_limited',
      });

    it('throws the declared rate_limited contract instead of falling back per ID', async () => {
      mockService.getStudiesBatch.mockRejectedValue(batchRateLimit());

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT03722472', 'NCT05956821', 'NCT02130466'],
      });

      await expect(getStudyResults.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryable: true },
      });
    });

    it('issues no further upstream requests once the batch is rate-limited', async () => {
      mockService.getStudiesBatch.mockRejectedValue(batchRateLimit());
      mockService.getStudy.mockResolvedValue(makeStudy('NCT03722472', false));

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT03722472', 'NCT05956821', 'NCT02130466'],
      });

      await expect(getStudyResults.handler(input, ctx)).rejects.toThrow();
      expect(mockService.getStudy).not.toHaveBeenCalled();
    });

    it('carries the recovery hint from the declared contract', async () => {
      mockService.getStudiesBatch.mockRejectedValue(batchRateLimit());

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: 'NCT03722472' });
      const err = await Promise.resolve(getStudyResults.handler(input, ctx)).catch(
        (e: unknown) => e,
      );

      expect((err as { data?: { recovery?: { hint?: string } } }).data?.recovery?.hint).toContain(
        'rate-limited',
      );
    });

    it('still falls back per ID for a typed non-rate-limit batch rejection', async () => {
      // Discrimination is on data.reason, not on the error being an McpError.
      mockService.getStudiesBatch.mockRejectedValue(
        notFound('Study ID(s) not found or rejected by API: NCT00000000', {
          reason: 'ids_not_found',
        }),
      );
      mockService.getStudy.mockImplementation(async (nctId: string) => {
        if (nctId === 'NCT00000000') throw new Error('Study NCT00000000 not found');
        return makeStudy(nctId, false);
      });

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({ nctIds: ['NCT03722472', 'NCT00000000'] });
      const result = await getStudyResults.handler(input, ctx);

      expect(mockService.getStudy).toHaveBeenCalledTimes(2);
      expect(result.results.map((r) => r.nctId)).toEqual(['NCT03722472']);
      expect(result.fetchErrors).toEqual([
        { nctId: 'NCT00000000', error: expect.stringContaining('not found') },
      ]);
    });
  });

  describe('caller cancellation', () => {
    it('surfaces RequestCancelled instead of falling back per ID', async () => {
      mockService.getStudiesBatch.mockRejectedValue(
        requestCancelled('Request cancelled by caller'),
      );
      mockService.getStudy.mockResolvedValue(makeStudy('NCT03722472', false));

      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT03722472', 'NCT05956821', 'NCT02130466'],
      });

      await expect(getStudyResults.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });
      expect(mockService.getStudy).not.toHaveBeenCalled();
    });
  });

  describe('blank supplied values (#99)', () => {
    // Through the real `.input.parse()` path — no hand-built input bypassing
    // the schema. A schema `.min(1)` would preempt the handler and surface a
    // bare -32602 carrying no reason and no recovery hint (#109).
    it('answers an empty sections list with the typed blank_value contract', async () => {
      mockService.getStudiesBatch.mockResolvedValue([makeStudy('NCT12345678', true, {})]);
      const ctx = createMockContext({ errors: getStudyResults.errors });

      await expect(
        getStudyResults.handler(
          getStudyResults.input!.parse({ nctIds: 'NCT12345678', sections: [] }),
          ctx,
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_value', param: 'sections' },
      });
      expect(mockService.getStudiesBatch).not.toHaveBeenCalled();
    });

    // nctIds is required and had no handler guard at all: dropping the schema
    // constraint alone would let `[]` through to a zero-iteration loop and
    // answer `{ results: [] }` as a silent success.
    it('answers an empty nctIds list with the typed blank_value contract', async () => {
      const ctx = createMockContext({ errors: getStudyResults.errors });

      await expect(
        getStudyResults.handler(getStudyResults.input!.parse({ nctIds: [] }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_value', param: 'nctIds' },
      });
      expect(mockService.getStudiesBatch).not.toHaveBeenCalled();
    });

    it('still caps nctIds at 20 in the schema', () => {
      const ids = Array.from({ length: 21 }, (_, i) => `NCT${String(i).padStart(8, '0')}`);
      expect(() => getStudyResults.input!.parse({ nctIds: ids })).toThrow();
    });

    it('leaves an omitted sections list meaning "all sections"', async () => {
      mockService.getStudiesBatch.mockResolvedValue([
        makeStudy('NCT12345678', true, {
          outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
          adverseEventsModule: { timeFrame: '6 months' },
          participantFlowModule: { groups: [] },
          baselineCharacteristicsModule: { groups: [] },
          moreInfoModule: { pointOfContact: { email: 'x@example.com' } },
        }),
      ]);
      const ctx = createMockContext({ errors: getStudyResults.errors });
      const result = await getStudyResults.handler(
        getStudyResults.input!.parse({ nctIds: 'NCT12345678' }),
        ctx,
      );

      const entry = result.results[0]!;
      expect(entry.outcomes).toBeDefined();
      expect(entry.adverseEvents).toBeDefined();
      expect(entry.participantFlow).toBeDefined();
      expect(entry.baseline).toBeDefined();
      expect(entry.moreInfo).toBeDefined();
    });

    it('leaves a valid non-empty sections list unaffected', async () => {
      mockService.getStudiesBatch.mockResolvedValue([
        makeStudy('NCT12345678', true, {
          outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
          adverseEventsModule: { timeFrame: '6 months' },
        }),
      ]);
      const ctx = createMockContext({ errors: getStudyResults.errors });
      const result = await getStudyResults.handler(
        getStudyResults.input!.parse({ nctIds: 'NCT12345678', sections: ['outcomes'] }),
        ctx,
      );

      expect(result.results[0]!.outcomes).toBeDefined();
      expect(result.results[0]!.adverseEvents).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders study without results', () => {
      const blocks = getStudyResults.format!({
        results: [{ nctId: 'NCT12345678', title: 'No Data', hasResults: false }],
      });
      expect((blocks[0] as { text: string }).text).toContain('No results available.');
    });

    it('renders outcomes section', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT12345678',
            title: 'Test Study',
            hasResults: true,
            outcomes: [
              {
                type: 'PRIMARY',
                title: 'Overall Survival',
                timeFrame: '24 months',
                paramType: 'MEDIAN',
                unitOfMeasure: 'months',
              },
            ],
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## NCT12345678: Test Study');
      expect(text).toContain('Outcomes');
      expect(text).toContain('Overall Survival');
      expect(text).toContain('24 months');
    });

    it('renders adverse events with summary data', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT12345678',
            title: 'AE Study',
            hasResults: true,
            adverseEvents: {
              timeFrame: '12 months',
              seriousEventCount: 3,
              otherEventCount: 15,
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Adverse Events');
      expect(text).toContain('12 months');
    });

    it('renders the topEvents table in summary-mode adverse events (#61)', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT02130466',
            title: 'AE Study',
            hasResults: true,
            adverseEvents: {
              timeFrame: '3 years',
              seriousEventCount: 1,
              otherEventCount: 1,
              topEvents: [
                {
                  term: 'Headache',
                  organSystem: 'Nervous system disorders',
                  kind: 'other',
                  numAffected: 70,
                  numAtRisk: 200,
                },
                {
                  term: 'Anaemia',
                  organSystem: 'Blood and lymphatic system disorders',
                  kind: 'serious',
                  numAffected: 17,
                  numAtRisk: 200,
                },
              ],
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Most frequent events');
      expect(text).toContain('Headache');
      expect(text).toContain('70/200 affected');
      expect(text).toContain('[other]');
    });

    it('renders every adverse event in full mode without a row cap (#63)', () => {
      const seriousEvents = Array.from({ length: 25 }, (_, i) => ({
        term: `SeriousEvent${i}`,
        stats: [{ groupId: 'G1', numAffected: 1, numAtRisk: 10 }],
      }));
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT02130466',
            title: 'Big AE Study',
            hasResults: true,
            adverseEvents: { eventGroups: [{ id: 'G1', title: 'Arm' }], seriousEvents },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('SeriousEvent0');
      expect(text).toContain('SeriousEvent24');
      expect(text).not.toContain('more');
    });

    it('renders every baseline measure in full mode without a row cap (#63)', () => {
      const measures = Array.from({ length: 20 }, (_, i) => ({
        title: `Measure${i}`,
        classes: [{ categories: [{ measurements: [{ groupId: 'G1', value: `${i}` }] }] }],
      }));
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT02130466',
            title: 'Big BL Study',
            hasResults: true,
            baseline: { groups: [{ id: 'G1', title: 'Arm' }], measures },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Measure0');
      expect(text).toContain('Measure19');
      expect(text).not.toContain('more');
    });

    it('renders participant flow with summary data', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT12345678',
            title: 'PF Study',
            hasResults: true,
            participantFlow: {
              groupCount: 3,
              periodCount: 2,
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Participant Flow');
      expect(text).toContain('3 groups');
      expect(text).toContain('2 periods');
    });

    it('renders baseline with summary data', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT12345678',
            title: 'BL Study',
            hasResults: true,
            baseline: {
              groupCount: 2,
              measures: [{ title: 'Age', unitOfMeasure: 'years' }, { title: 'Sex' }],
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Baseline');
      expect(text).toContain('Age');
    });

    it('renders the not-reached arm in full-mode baseline values (#76)', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT02819518',
            title: 'BL Study',
            hasResults: true,
            baseline: {
              groups: [
                { id: 'G1', title: 'Pembrolizumab' },
                { id: 'G2', title: 'Placebo' },
              ],
              measures: [
                {
                  title: 'Time to Event',
                  paramType: 'MEDIAN',
                  unitOfMeasure: 'Months',
                  classes: [
                    {
                      categories: [
                        {
                          measurements: [
                            { groupId: 'G1', value: 'NA' },
                            { groupId: 'G2', value: '6.5' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      // The not-reached arm survives instead of being filtered out of the row.
      expect(text).toContain('Pembrolizumab: not reached');
      expect(text).toContain('Placebo: 6.5');
    });

    it('renders the moreInfo section — limitations, agreement, contact (#64)', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT02130466',
            title: 'MoreInfo Study',
            hasResults: true,
            moreInfo: {
              limitationsAndCaveats: { description: 'Open-label extension.' },
              certainAgreement: { restrictiveAgreement: true, restrictionType: 'OTHER' },
              pointOfContact: { title: 'SVP', organization: 'Acme', email: 'x@example.com' },
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('More Info');
      expect(text).toContain('Limitations & Caveats:');
      expect(text).toContain('Open-label extension.');
      expect(text).toContain('Certain Agreement:');
      expect(text).toContain('Point of Contact:');
      expect(text).toContain('x@example.com');
    });

    it('renders fetch errors', () => {
      const blocks = getStudyResults.format!({
        results: [],
        fetchErrors: [{ nctId: 'NCT12345678', error: 'timeout' }],
      });
      expect((blocks[0] as { text: string }).text).toContain('NCT12345678: timeout');
    });

    it('renders studiesWithoutResults', () => {
      const blocks = getStudyResults.format!({
        results: [{ nctId: 'NCT12345678', title: 'X', hasResults: false }],
        studiesWithoutResults: ['NCT12345678'],
      });
      expect((blocks[0] as { text: string }).text).toContain('Without results: NCT12345678');
    });

    it('renders multiple studies', () => {
      const blocks = getStudyResults.format!({
        results: [
          { nctId: 'NCT12345678', title: 'Study A', hasResults: false },
          {
            nctId: 'NCT87654321',
            title: 'Study B',
            hasResults: true,
            outcomes: [{ type: 'PRIMARY', title: 'OS' }],
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## NCT12345678: Study A');
      expect(text).toContain('## NCT87654321: Study B');
    });

    it('renders every class, category, and measurement of a measure (#63)', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT03722472',
            title: 'Multi-class Study',
            hasResults: true,
            outcomes: [
              {
                type: 'PRIMARY',
                title: 'Reactogenicity',
                reportingStatus: 'POSTED',
                description: 'Solicited reactions within 7 days.',
                populationDescription: 'Safety population (n=48).',
                groups: [
                  { id: 'OG000', title: 'Single-vial', description: 'Two IM injections.' },
                  { id: 'OG001', title: 'Two-vial', description: 'Reconstituted on site.' },
                ],
                denoms: [{ units: 'Participants', counts: [{ groupId: 'OG000', value: '23' }] }],
                classes: [
                  {
                    title: 'Day 0',
                    categories: [
                      {
                        title: 'Pain',
                        measurements: [
                          { groupId: 'OG000', value: '9', lowerLimit: '4', upperLimit: '14' },
                        ],
                      },
                    ],
                  },
                  {
                    title: 'Day 56',
                    categories: [
                      { title: 'Pain', measurements: [{ groupId: 'OG001', value: '7' }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('reporting: POSTED');
      expect(text).toContain('Solicited reactions within 7 days.');
      expect(text).toContain('Population: Safety population (n=48).');
      expect(text).toContain('OG000: Single-vial');
      expect(text).toContain('Two IM injections.');
      expect(text).toContain('Denominator (Participants): Single-vial: 23');
      // The second class was previously unreachable — extractTopStats only ever
      // read classes[0].categories[0].
      expect(text).toContain('Day 0');
      expect(text).toContain('Day 56');
      expect(text).toContain('Pain: Single-vial: 9 [4 to 14]');
      expect(text).toContain('Pain: Two-vial: 7');
    });

    it('renders adverse-event coding metadata and notes in full mode (#63)', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT03722472',
            title: 'AE Study',
            hasResults: true,
            adverseEvents: {
              frequencyThreshold: '0',
              timeFrame: '421 days',
              description: 'Solicited and unsolicited events.',
              eventGroups: [{ id: 'EG000', title: 'Single-vial', description: 'Arm detail.' }],
              otherEvents: [
                {
                  term: 'Arthralgia',
                  organSystem: 'Musculoskeletal and connective tissue disorders',
                  sourceVocabulary: 'MedDRA 21.1',
                  assessmentType: 'SYSTEMATIC_ASSESSMENT',
                  notes: 'Injection related reactions',
                  stats: [{ groupId: 'EG000', numAffected: 4, numAtRisk: 23 }],
                },
              ],
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Solicited and unsolicited events.');
      expect(text).toContain('Frequency threshold: 0%');
      expect(text).toContain('EG000: Single-vial');
      expect(text).toContain('Arm detail.');
      expect(text).toContain('MedDRA 21.1');
      expect(text).toContain('SYSTEMATIC_ASSESSMENT');
      expect(text).toContain('Injection related reactions');
    });

    it('renders reportingStatus and class count in summary mode (#63)', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT03722472',
            title: 'Summary Study',
            hasResults: true,
            outcomes: [
              {
                type: 'PRIMARY',
                title: 'Reactogenicity',
                reportingStatus: 'POSTED',
                groupCount: 2,
                classCount: 3,
              },
            ],
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('reporting: POSTED');
      expect(text).toContain('2 groups');
      expect(text).toContain('3 classes');
    });

    it('renders baseline group and measure counts in summary mode (#63)', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT03722472',
            title: 'Summary Study',
            hasResults: true,
            baseline: {
              groupCount: 3,
              measureCount: 4,
              measures: [{ title: 'Age', paramType: 'MEAN', unitOfMeasure: 'years' }],
            },
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('3 groups');
      expect(text).toContain('4 measures');
      expect(text).toContain('- Age (MEAN, years)');
    });
  });

  describe('channel parity — every populated leaf reaches content[] (#63)', () => {
    /**
     * Reverse parity against a verbatim API results payload, one section per
     * call so a section's leaves cannot be satisfied by another's text.
     */
    const render = async (section: (typeof SECTIONS)[number], summary: boolean) => {
      mockService.getStudiesBatch.mockResolvedValue([
        loadStudyFixture('nct03722472') as RawStudyShape,
      ]);
      const ctx = createMockContext({ errors: getStudyResults.errors });
      const input = getStudyResults.input!.parse({
        nctIds: 'NCT03722472',
        sections: section,
        summary,
      });
      const result = await getStudyResults.handler(input, ctx);
      return { result, text: (getStudyResults.format!(result)[0] as { text: string }).text };
    };

    for (const section of SECTIONS) {
      it(`renders every ${section} leaf in full mode`, async () => {
        const { result, text } = await render(section, false);
        expect(missingLeaves(result, text)).toEqual([]);
      });

      it(`renders every ${section} leaf in summary mode`, async () => {
        const { result, text } = await render(section, true);
        expect(missingLeaves(result, text)).toEqual([]);
      });
    }

    it('renders every field of a fully-populated statistical analysis (#63)', () => {
      const analysis = {
        statisticalMethod: 'ANCOVA',
        statisticalComment: 'Adjusted for baseline.',
        pValue: '<0.0001',
        pValueComment: 'Two-sided.',
        testedNonInferiority: true,
        nonInferiorityType: 'SUPERIORITY',
        nonInferiorityComment: 'Margin 1.3.',
        paramType: 'Treatment difference',
        paramValue: '-9.38',
        dispersionType: 'Standard Error',
        dispersionValue: '1.31',
        ciPctValue: '95',
        ciNumSides: '2-Sided',
        ciLowerLimit: '-11.97',
        ciUpperLimit: '-6.80',
        ciLowerLimitComment: 'Lower bound truncated.',
        ciUpperLimitComment: 'Upper bound truncated.',
        estimateComment: 'Least-squares mean.',
        otherAnalysisDescription: 'Sensitivity analysis.',
        groupIds: ['OG000', 'OG001'],
        groupDescription: 'Active versus placebo.',
      };
      const output = {
        results: [
          {
            nctId: 'NCT04074161',
            title: 'Analysis Study',
            hasResults: true,
            outcomes: [{ title: 'Body Weight', analyses: [analysis] }],
          },
        ],
      };
      const text = (getStudyResults.format!(output)[0] as { text: string }).text;
      expect(missingLeaves(output, text)).toEqual([]);
      expect(text).toContain('95% 2-Sided CI [-11.97, -6.80]');
    });

    it('surfaces reportingStatus for summarized outcomes (#63)', async () => {
      const { result, text } = await render('outcomes', true);
      const outcomes = result.results[0]!.outcomes!;
      expect(outcomes.length).toBeGreaterThan(1);
      for (const outcome of outcomes) expect(outcome.reportingStatus).toBeDefined();
      expect(text).toContain('reporting: POSTED');
    });

    it('walks the whole classes tree in full mode, not just the first entry (#63)', async () => {
      const { result, text } = await render('outcomes', false);
      const outcomes = result.results[0]!.outcomes!;
      const deepest = outcomes.find(
        (o) => ((o.classes as unknown[] | undefined)?.length ?? 0) > 1,
      ) as Record<string, unknown> | undefined;
      expect(deepest).toBeDefined();
      const classes = deepest!.classes as Array<{ title?: string }>;
      for (const cls of classes) if (cls.title) expect(text).toContain(cls.title);
    });
  });
});
