/**
 * @fileoverview Tests for clinicaltrials://{nctId} resource.
 * @module tests/mcp-server/resources/definitions/study.resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { studyResource } from '@/mcp-server/resources/definitions/study.resource.js';

describe('studyResource', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  const params = studyResource.params!;

  describe('params validation', () => {
    it('accepts valid NCT ID', () => {
      expect(() => params.parse({ nctId: 'NCT03722472' })).not.toThrow();
    });

    it('rejects invalid NCT ID', () => {
      expect(() => params.parse({ nctId: 'bad' })).toThrow();
      expect(() => params.parse({ nctId: 'NCT1234' })).toThrow();
    });

    it('rejects lowercase nct prefix', () => {
      expect(() => params.parse({ nctId: 'nct03722472' })).toThrow();
    });

    it('rejects NCT ID with wrong digit count', () => {
      expect(() => params.parse({ nctId: 'NCT123456789' })).toThrow();
    });
  });

  const read = async (study: unknown, nctId = 'NCT03722472') => {
    mockService.getStudy.mockResolvedValue(study);
    const ctx = createMockContext({ errors: studyResource.errors });
    const parsed = params.parse({ nctId });
    return (await studyResource.handler(parsed, ctx)) as ReadResult;
  };

  interface ReadResult {
    filtersApplied: Record<string, number>;
    nctId: string;
    resultsSummary?: Record<string, number>;
    retrieval?: Record<string, string>;
    study: Record<string, any>;
    truncated: boolean;
  }

  /** Build a study whose location, outcome, and reference lists exceed any cap. */
  const bulkStudy = (counts: { locations?: number; outcomes?: number; references?: number }) => ({
    protocolSection: {
      identificationModule: { nctId: 'NCT03722472', briefTitle: 'Bulk Study' },
      contactsLocationsModule: {
        locations: Array.from({ length: counts.locations ?? 0 }, (_, i) => ({
          facility: `Site ${i}`,
          city: 'Boston',
          country: 'United States',
        })),
      },
      outcomesModule: {
        primaryOutcomes: [{ measure: 'Primary' }],
        secondaryOutcomes: Array.from({ length: counts.outcomes ?? 0 }, (_, i) => ({
          measure: `Secondary ${i}`,
        })),
      },
      referencesModule: {
        references: Array.from({ length: counts.references ?? 0 }, (_, i) => ({
          pmid: String(i),
          citation: `Citation ${i}`,
        })),
      },
    },
  });

  describe('handler', () => {
    it('returns study data for valid params', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT03722472' } } };
      const result = await read(study);

      expect(result.study).toEqual(study);
      expect(result.nctId).toBe('NCT03722472');
      expect(mockService.getStudy).toHaveBeenCalledWith('NCT03722472', expect.anything());
    });

    it('reports an untrimmed study as complete, with no retrieval pointers (#102)', async () => {
      const result = await read({
        hasResults: false,
        protocolSection: { identificationModule: { nctId: 'NCT03722472' } },
      });

      expect(result.truncated).toBe(false);
      expect(result.retrieval).toBeUndefined();
      expect(result.resultsSummary).toBeUndefined();
      expect(result.filtersApplied).toEqual({});
    });

    it('drops resultsSection and reports its counts plus a retrieval route (#102)', async () => {
      const result = await read({
        hasResults: true,
        protocolSection: { identificationModule: { nctId: 'NCT03722472' } },
        resultsSection: {
          outcomeMeasuresModule: { outcomeMeasures: [{ title: 'A' }, { title: 'B' }] },
          adverseEventsModule: {
            seriousEvents: [{ term: 'S1' }],
            otherEvents: [{ term: 'O1' }, { term: 'O2' }, { term: 'O3' }],
          },
          participantFlowModule: { periods: [{ title: 'P1' }] },
          baselineCharacteristicsModule: { measures: [{ title: 'Age' }] },
        },
      });

      expect(result.study.resultsSection).toBeUndefined();
      expect(result.study.hasResults).toBe(true);
      expect(result.resultsSummary).toEqual({
        outcomeMeasures: 2,
        seriousAdverseEvents: 1,
        otherAdverseEvents: 3,
        participantFlowPeriods: 1,
        baselineMeasures: 1,
      });
      expect(result.truncated).toBe(true);
      expect(result.retrieval).toEqual({
        nctId: 'NCT03722472',
        studyRecordTool: 'clinicaltrials_get_study_record',
        studyResultsTool: 'clinicaltrials_get_study_results',
      });
    });

    it('caps locations and preserves the upstream total (#102)', async () => {
      const result = await read(bulkStudy({ locations: 120 }));
      const locations = result.study.protocolSection.contactsLocationsModule.locations;

      expect(locations).toHaveLength(50);
      expect(locations[0].facility).toBe('Site 0');
      expect(result.filtersApplied.totalLocations).toBe(120);
      expect(result.filtersApplied.locationLimit).toBe(50);
      expect(result.truncated).toBe(true);
      expect(result.retrieval!.studyRecordTool).toBe('clinicaltrials_get_study_record');
    });

    it('caps secondary outcomes and references, never primary outcomes (#102)', async () => {
      const result = await read(bulkStudy({ outcomes: 80, references: 90 }));
      const outcomes = result.study.protocolSection.outcomesModule;

      expect(outcomes.secondaryOutcomes).toHaveLength(50);
      expect(outcomes.primaryOutcomes).toHaveLength(1);
      expect(result.study.protocolSection.referencesModule.references).toHaveLength(50);
      expect(result.filtersApplied.totalSecondaryOutcomes).toBe(80);
      expect(result.filtersApplied.outcomeLimit).toBe(50);
      expect(result.filtersApplied.totalReferences).toBe(90);
      expect(result.filtersApplied.referenceLimit).toBe(50);
    });

    it('reports no cap for lists at or below the limit (#80)', async () => {
      const result = await read(bulkStudy({ locations: 50, outcomes: 3, references: 2 }));

      expect(result.study.protocolSection.contactsLocationsModule.locations).toHaveLength(50);
      expect(result.filtersApplied).toEqual({});
      expect(result.truncated).toBe(false);
    });

    it('handles a study with no protocolSection at all', async () => {
      const result = await read({ hasResults: false });

      expect(result.truncated).toBe(false);
      expect(result.study).toEqual({ hasResults: false });
    });

    it('validates against its own output schema', async () => {
      const result = await read(bulkStudy({ locations: 120 }));
      expect(() => studyResource.output!.parse(result)).not.toThrow();
    });

    it('propagates service errors', async () => {
      mockService.getStudy.mockRejectedValue(new Error('Not found'));
      const ctx = createMockContext({ errors: studyResource.errors });
      const parsed = params.parse({ nctId: 'NCT03722472' });

      await expect(studyResource.handler(parsed, ctx)).rejects.toThrow('Not found');
    });
  });

  describe('metadata', () => {
    it('has correct MIME type', () => {
      expect(studyResource.mimeType).toBe('application/json');
    });

    it('has description', () => {
      expect(studyResource.description).toBeTruthy();
    });
  });
});
