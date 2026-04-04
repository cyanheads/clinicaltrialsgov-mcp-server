/**
 * @fileoverview Tests for clinicaltrials_get_study_results tool.
 * @module tests/get-study-results.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));

import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
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
    resultsSection,
  };
}

describe('getStudyResults', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
  });

  describe('handler', () => {
    it('extracts results sections from a study with results', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: {
          outcomeMeasures: [{ type: 'PRIMARY', title: 'Outcome 1' }],
        },
        adverseEventsModule: { timeFrame: '12 months' },
        participantFlowModule: { flowGroups: [] },
        baselineCharacteristicsModule: { baselineGroups: [] },
      });
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].hasResults).toBe(true);
      expect(result.results[0].outcomes).toEqual([{ type: 'PRIMARY', title: 'Outcome 1' }]);
      expect(result.results[0].adverseEvents).toBeDefined();
      expect(result.results[0].participantFlow).toBeDefined();
      expect(result.results[0].baseline).toBeDefined();
    });

    it('tracks studies without results', async () => {
      mockService.getStudy.mockResolvedValue(makeStudy('NCT12345678', false));

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({ nctIds: 'NCT12345678' });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0].hasResults).toBe(false);
      expect(result.studiesWithoutResults).toEqual(['NCT12345678']);
    });

    it('filters to requested sections only', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
        adverseEventsModule: { timeFrame: '6 months' },
        participantFlowModule: { flowGroups: [] },
        baselineCharacteristicsModule: { baselineGroups: [] },
      });
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({
        nctIds: 'NCT12345678',
        sections: 'outcomes',
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0].outcomes).toBeDefined();
      expect(result.results[0].adverseEvents).toBeUndefined();
      expect(result.results[0].participantFlow).toBeUndefined();
      expect(result.results[0].baseline).toBeUndefined();
    });

    it('ignores invalid section names', async () => {
      const study = makeStudy('NCT12345678', true, {
        outcomeMeasuresModule: { outcomeMeasures: [{ title: 'X' }] },
      });
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({
        nctIds: 'NCT12345678',
        sections: ['outcomes', 'invalidSection'],
      });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results[0].outcomes).toBeDefined();
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
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({
        nctIds: 'NCT12345678',
        sections: 'outcomes',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const outcome = result.results[0].outcomes![0];

      expect(outcome.type).toBe('PRIMARY');
      expect(outcome.title).toBe('Overall Survival');
      expect(outcome.groupCount).toBe(2);
      expect(outcome.classCount).toBe(1);
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
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({
        nctIds: 'NCT12345678',
        sections: 'adverseEvents',
        summary: true,
      });
      const result = await getStudyResults.handler(input, ctx);
      const ae = result.results[0].adverseEvents!;

      expect(ae.timeFrame).toBe('12 months');
      expect(ae.groupCount).toBe(1);
      expect(ae.seriousEventCount).toBe(1);
      expect(ae.otherEventCount).toBe(2);
    });

    it('caps nctIds at 5', async () => {
      const ids = [
        'NCT00000001',
        'NCT00000002',
        'NCT00000003',
        'NCT00000004',
        'NCT00000005',
        'NCT00000006',
      ];
      mockService.getStudy.mockResolvedValue(makeStudy('NCT00000001', false));

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({ nctIds: ids });
      await getStudyResults.handler(input, ctx);

      expect(mockService.getStudy).toHaveBeenCalledTimes(5);
    });

    it('collects fetch errors without failing', async () => {
      mockService.getStudy
        .mockResolvedValueOnce(makeStudy('NCT12345678', false))
        .mockRejectedValueOnce(new Error('Network error'));

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({ nctIds: ['NCT12345678', 'NCT87654321'] });
      const result = await getStudyResults.handler(input, ctx);

      expect(result.results).toHaveLength(1);
      expect(result.fetchErrors).toEqual([{ nctId: 'NCT87654321', error: 'Network error' }]);
    });

    it('throws when all studies fail to fetch', async () => {
      mockService.getStudy.mockRejectedValue(new Error('Down'));

      const ctx = createMockContext();
      const input = getStudyResults.input.parse({ nctIds: 'NCT12345678' });

      await expect(getStudyResults.handler(input, ctx)).rejects.toThrow('All studies failed');
    });
  });

  describe('format', () => {
    it('renders study with results', () => {
      const blocks = getStudyResults.format!({
        results: [
          {
            nctId: 'NCT12345678',
            title: 'Test Study',
            hasResults: true,
            outcomes: [{ type: 'PRIMARY' }],
            adverseEvents: { timeFrame: '12 months' },
          },
        ],
      });
      expect(blocks[0].text).toContain('## NCT12345678: Test Study');
      expect(blocks[0].text).toContain('Outcomes: 1 measures');
      expect(blocks[0].text).toContain('Adverse Events: data available');
    });

    it('renders study without results', () => {
      const blocks = getStudyResults.format!({
        results: [{ nctId: 'NCT12345678', title: 'No Data', hasResults: false }],
      });
      expect(blocks[0].text).toContain('No results available.');
    });

    it('renders fetch errors', () => {
      const blocks = getStudyResults.format!({
        results: [],
        fetchErrors: [{ nctId: 'NCT12345678', error: 'timeout' }],
      });
      expect(blocks[0].text).toContain('NCT12345678: timeout');
    });

    it('renders studies without results list', () => {
      const blocks = getStudyResults.format!({
        results: [{ nctId: 'NCT12345678', title: 'X', hasResults: false }],
        studiesWithoutResults: ['NCT12345678'],
      });
      expect(blocks[0].text).toContain('Without results: NCT12345678');
    });
  });
});
