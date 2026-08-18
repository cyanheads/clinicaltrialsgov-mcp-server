/**
 * @fileoverview Single clinical study resource by NCT ID, bounded to a size a
 * client can hold. A resource read takes no arguments, so the caps are fixed
 * server-side and every omission is disclosed with the tool that retrieves it.
 * @module mcp-server/resources/definitions/study.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../../tools/utils/_schemas.js';
import { RECOVERY_HINTS } from '../../tools/utils/recovery-hints.js';
import { applyFilters, summarizeResults } from '../../tools/utils/study-filters.js';

/**
 * Fixed cap on each of the study's three unbounded protocol lists — locations,
 * secondary/other outcomes, references. Deliberately below the per-list maxima
 * clinicaltrials_get_study_record accepts (500 / 100 / 100): that tool is the
 * retrieval path for a caller who wants more, and it can be asked for the full
 * list. A read of this resource cannot.
 */
const LIST_LIMIT = 50;

export const studyResource = resource('clinicaltrials://{nctId}', {
  name: 'Clinical Trial Study',
  description: `Fetch a single clinical study by NCT ID as JSON. The protocol record comes back whole apart from three capped lists (locations, secondary/other outcomes, references — ${LIST_LIMIT} each), and the results data, which reaches ~600KB on a large trial, is replaced by its counts. Anything omitted is reported in truncated, filtersApplied, and resultsSummary, with the tool that retrieves it named in retrieval.`,
  mimeType: 'application/json',
  errors: [
    {
      reason: 'study_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The provided NCT ID does not match any study at ClinicalTrials.gov.',
      recovery: RECOVERY_HINTS.study_not_found,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
    },
  ],
  params: z.object({
    nctId: nctIdSchema.describe('NCT identifier (e.g., NCT03722472).'),
  }),

  output: z.object({
    nctId: z.string().describe('NCT identifier of the study read.'),
    study: z
      .record(z.string(), z.unknown())
      .describe(
        'The study record with the caps below already applied. Top-level keys: protocolSection (identification, status, sponsor, conditions, design, arms/interventions, outcomes, eligibility, contacts/locations), derivedSection (MeSH-normalized terms), documentSection, hasResults. resultsSection is omitted — see resultsSummary.',
      ),
    resultsSummary: z
      .object({
        outcomeMeasures: z.number().int().optional().describe('Posted outcome measures.'),
        seriousAdverseEvents: z
          .number()
          .int()
          .optional()
          .describe('Distinct serious adverse-event terms.'),
        otherAdverseEvents: z
          .number()
          .int()
          .optional()
          .describe('Distinct other (non-serious) adverse-event terms.'),
        participantFlowPeriods: z.number().int().optional().describe('Participant-flow periods.'),
        baselineMeasures: z.number().int().optional().describe('Baseline characteristic measures.'),
      })
      .optional()
      .describe(
        'Counts of the posted results data omitted from study, present when the study has results to count. Fetch the data itself with clinicaltrials_get_study_results.',
      ),
    filtersApplied: z
      .object({
        totalLocations: z
          .number()
          .int()
          .optional()
          .describe('Upstream location count before the cap trimmed the list.'),
        locationLimit: z
          .number()
          .int()
          .optional()
          .describe('The location cap — present only when it trimmed the list.'),
        totalSecondaryOutcomes: z
          .number()
          .int()
          .optional()
          .describe('Upstream secondary outcomes count before the cap trimmed the list.'),
        totalOtherOutcomes: z
          .number()
          .int()
          .optional()
          .describe('Upstream other outcomes count before the cap trimmed the list.'),
        totalReferences: z
          .number()
          .int()
          .optional()
          .describe('Upstream reference count before the cap trimmed the list.'),
        outcomeLimit: z
          .number()
          .int()
          .optional()
          .describe('The outcome cap — present only when it trimmed a list.'),
        referenceLimit: z
          .number()
          .int()
          .optional()
          .describe('The reference cap — present only when it trimmed the list.'),
      })
      .describe(
        'Which caps trimmed a list, with the upstream total for each. Empty when every list came back whole. Primary outcomes and seeAlsoLinks are never capped.',
      ),
    truncated: z
      .boolean()
      .describe('True when results data or any capped list was omitted from study.'),
    retrieval: z
      .object({
        nctId: z.string().describe('NCT identifier to pass to either tool.'),
        studyRecordTool: z
          .string()
          .describe(
            'Tool that returns the protocol record with caller-controlled locationLimit / outcomeLimit / referenceLimit — omit them for the uncapped lists.',
          ),
        studyResultsTool: z
          .string()
          .describe(
            'Tool that returns the omitted results data, by section and with its own outcomeLimit / adverseEventLimit caps.',
          ),
      })
      .optional()
      .describe('How to retrieve what was omitted. Present only when truncated is true.'),
  }),

  async handler(params, ctx) {
    const service = getClinicalTrialsService();
    const raw = (await service.getStudy(params.nctId, ctx)) as RawStudyShape;

    const { study, meta } = applyFilters(raw, {
      locationLimit: LIST_LIMIT,
      outcomeLimit: LIST_LIMIT,
      referenceLimit: LIST_LIMIT,
    });

    // The results data is the tail that overflows a context window — a large
    // trial carries ~600KB of it against ~70KB of protocol. Carry its counts
    // and point at the tool that fetches it section by section.
    const resultsSummary = summarizeResults(study);
    const droppedResults = study.resultsSection != null;
    const studyOut: Record<string, unknown> = { ...study };
    delete studyOut.resultsSection;

    const truncated = droppedResults || Object.keys(meta).length > 0;
    ctx.log.info('Study fetched', { nctId: params.nctId, truncated });

    return {
      nctId: params.nctId,
      study: studyOut,
      ...(resultsSummary ? { resultsSummary } : {}),
      filtersApplied: meta,
      truncated,
      ...(truncated
        ? {
            retrieval: {
              nctId: params.nctId,
              studyRecordTool: 'clinicaltrials_get_study_record',
              studyResultsTool: 'clinicaltrials_get_study_results',
            },
          }
        : {}),
    };
  },
});
