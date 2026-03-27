/**
 * @fileoverview Extract outcomes, adverse events, participant flow, and baseline from completed studies.
 * @module mcp-server/tools/definitions/get-study-results.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';

const VALID_SECTIONS = ['outcomes', 'adverseEvents', 'participantFlow', 'baseline'] as const;
type Section = (typeof VALID_SECTIONS)[number];

/** Map section names to resultsSection module keys. */
const SECTION_MAP: Record<Section, string> = {
  outcomes: 'outcomeMeasuresModule',
  adverseEvents: 'adverseEventsModule',
  participantFlow: 'participantFlowModule',
  baseline: 'baselineCharacteristicsModule',
};

export const getStudyResults = tool('clinicaltrials_get_study_results', {
  description: `Fetch trial results data for completed studies — outcome measures with statistics, adverse events, participant flow, and baseline characteristics. Only available for studies where hasResults is true. Use search_studies first to find studies with results.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    nctIds: z
      .union([z.string(), z.array(z.string())])
      .describe(
        'One or more NCT IDs (max 5). E.g., "NCT12345678" or ["NCT12345678", "NCT87654321"].',
      ),
    sections: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        `Filter which sections to return. Values: outcomes, adverseEvents, participantFlow, baseline. Omit for all sections.`,
      ),
  }),

  output: z.object({
    results: z
      .array(
        z.object({
          nctId: z.string().describe('NCT identifier.'),
          title: z.string().describe('Study title.'),
          hasResults: z.boolean().describe('Whether study has posted results.'),
          outcomes: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe('Outcome measures with statistics.'),
          adverseEvents: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Adverse events data.'),
          participantFlow: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Participant flow data.'),
          baseline: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Baseline characteristics.'),
        }),
      )
      .describe('Results per study.'),
    studiesWithoutResults: z
      .array(z.string())
      .optional()
      .describe('NCT IDs that do not have results data.'),
    fetchErrors: z
      .array(
        z.object({
          nctId: z.string().describe('NCT ID.'),
          error: z.string().describe('Error message.'),
        }),
      )
      .optional()
      .describe('Studies that could not be fetched.'),
  }),

  async handler(input, ctx) {
    const nctIds = (Array.isArray(input.nctIds) ? input.nctIds : [input.nctIds]).slice(0, 5);
    const sections: Section[] = input.sections
      ? (Array.isArray(input.sections) ? input.sections : [input.sections]).filter(
          (s): s is Section => VALID_SECTIONS.includes(s as Section),
        )
      : [...VALID_SECTIONS];

    interface StudyResult {
      adverseEvents?: Record<string, unknown>;
      baseline?: Record<string, unknown>;
      hasResults: boolean;
      nctId: string;
      outcomes?: Record<string, unknown>[];
      participantFlow?: Record<string, unknown>;
      title: string;
    }

    const service = getClinicalTrialsService();
    const results: StudyResult[] = [];
    const studiesWithoutResults: string[] = [];
    const fetchErrors: Array<{ nctId: string; error: string }> = [];

    await Promise.all(
      nctIds.map(async (nctId) => {
        try {
          const study = (await service.getStudy(nctId, ctx)) as RawStudyShape;
          const title = study.protocolSection?.identificationModule?.briefTitle ?? 'Unknown';
          const hasResults = study.hasResults === true;

          if (!hasResults) {
            studiesWithoutResults.push(nctId);
            results.push({ nctId, title, hasResults: false });
            return;
          }

          const rs = study.resultsSection ?? {};
          const entry: StudyResult = { nctId, title, hasResults: true };
          for (const section of sections) {
            const moduleKey = SECTION_MAP[section];
            const data = rs[moduleKey];
            if (data) {
              if (section === 'outcomes') {
                entry.outcomes =
                  (data.outcomeMeasures as Record<string, unknown>[] | undefined) ?? [];
              } else {
                entry[section] = data;
              }
            }
          }
          results.push(entry);
        } catch (err) {
          fetchErrors.push({ nctId, error: (err as Error).message });
        }
      }),
    );

    if (results.length === 0 && fetchErrors.length > 0) {
      throw new Error(
        `All studies failed to fetch: ${fetchErrors.map((e) => `${e.nctId}: ${e.error}`).join('; ')}`,
      );
    }

    ctx.log.info('Results extracted', {
      resultCount: results.length,
      withoutResults: studiesWithoutResults.length,
      errors: fetchErrors.length,
    });

    return {
      results,
      ...(studiesWithoutResults.length > 0 ? { studiesWithoutResults } : {}),
      ...(fetchErrors.length > 0 ? { fetchErrors } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const r of result.results) {
      lines.push(`## ${r.nctId}: ${r.title}`);
      if (!r.hasResults) {
        lines.push('No results available.');
        continue;
      }
      if (r.outcomes && r.outcomes.length > 0)
        lines.push(`- Outcomes: ${r.outcomes.length} measures`);
      if (r.adverseEvents) lines.push('- Adverse Events: data available');
      if (r.participantFlow) lines.push('- Participant Flow: data available');
      if (r.baseline) lines.push('- Baseline Characteristics: data available');
    }
    if (result.studiesWithoutResults?.length)
      lines.push(`\nWithout results: ${result.studiesWithoutResults.join(', ')}`);
    if (result.fetchErrors?.length)
      lines.push(
        `\nFetch errors: ${result.fetchErrors.map((e) => `${e.nctId}: ${e.error}`).join(', ')}`,
      );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
