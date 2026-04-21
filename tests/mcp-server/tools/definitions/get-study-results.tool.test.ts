/**
 * @fileoverview Tests for clinicaltrials_get_study_results tool.
 * @module tests/mcp-server/tools/definitions/get-study-results.tool
 */

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
  const mockService = { getStudiesBatch: vi.fn() };

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

      const ctx = createMockContext();
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

      const ctx = createMockContext();
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

      const ctx = createMockContext();
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

      const ctx = createMockContext();
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

      const ctx = createMockContext();
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

      const ctx = createMockContext();
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
    });

    it('summarizes participant flow in summary mode', async () => {
      const study = makeStudy('NCT12345678', true, {
        participantFlowModule: {
          groups: [{ id: 'G1' }, { id: 'G2' }],
          periods: [{ title: 'Overall' }, { title: 'Follow-up' }],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext();
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

      const ctx = createMockContext();
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

    it('returns full data in non-summary mode', async () => {
      const study = makeStudy('NCT12345678', true, {
        adverseEventsModule: {
          timeFrame: '12 months',
          eventGroups: [{ id: 'G1' }],
          seriousEvents: [{ term: 'Death' }],
        },
      });
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const ctx = createMockContext();
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

      const ctx = createMockContext();
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

      const ctx = createMockContext();
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(result.fetchErrors).toEqual([{ nctId: 'NCT87654321', error: 'Study not found' }]);
    });

    it('returns fetchErrors gracefully when all studies are missing from the batch response', async () => {
      mockService.getStudiesBatch.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toEqual([]);
      expect(result.fetchErrors).toEqual([{ nctId: 'NCT12345678', error: 'Study not found' }]);
    });

    it('catches getStudiesBatch throw and returns fetchErrors for all ids', async () => {
      mockService.getStudiesBatch.mockRejectedValue(
        new Error('Study ID(s) not found or rejected by API: NCT99999999'),
      );

      const ctx = createMockContext();
      const input = getStudyResults.input!.parse({
        nctIds: ['NCT99999999', 'NCT88888888'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toEqual([]);
      expect(result.fetchErrors).toEqual([
        { nctId: 'NCT99999999', error: expect.stringContaining('rejected by API') },
        { nctId: 'NCT88888888', error: expect.stringContaining('rejected by API') },
      ]);
    });

    it('handles study with empty resultsSection', async () => {
      mockService.getStudiesBatch.mockResolvedValue([makeStudy('NCT12345678', true, {})]);

      const ctx = createMockContext();
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0]!.hasResults).toBe(true);
      expect(result.results[0]!.outcomes).toBeUndefined();
      expect(result.results[0]!.adverseEvents).toBeUndefined();
    });

    it('handles study with missing resultsSection', async () => {
      mockService.getStudiesBatch.mockResolvedValue([makeStudy('NCT12345678', true)]);

      const ctx = createMockContext();
      const input = getStudyResults.input!.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0]!.hasResults).toBe(true);
      expect(result.results[0]!.outcomes).toBeUndefined();
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
  });
});
