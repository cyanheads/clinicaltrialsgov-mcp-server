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

/**
 * Extract top-line per-group stats from a raw outcome object (full mode).
 * Returns undefined if no measurement values are present.
 */
function extractTopStats(
  o: Record<string, unknown>,
): Array<{ group: string; value: string; spread?: string }> | undefined {
  const groups = o.groups as Array<Record<string, unknown>> | undefined;
  const classes = o.classes as Array<Record<string, unknown>> | undefined;
  if (!groups?.length || !classes?.length) return;
  const firstClass = classes[0] as Record<string, unknown>;
  const categories = firstClass.categories as Array<Record<string, unknown>> | undefined;
  const measurements = categories?.[0]?.measurements as Array<Record<string, unknown>> | undefined;
  if (!measurements?.length) return;
  const groupMap = new Map(groups.map((g) => [g.id as string, (g.title ?? g.id) as string]));
  const stats = measurements
    .filter((m) => m.value != null && m.value !== 'NA' && m.value !== 'NR')
    .map((m) => ({
      group: groupMap.get(m.groupId as string) ?? (m.groupId as string),
      value: m.value as string,
      ...(m.spread != null ? { spread: m.spread as string } : {}),
    }));
  return stats.length ? stats : undefined;
}

/** Condense a full outcome measure to its essential metadata plus top-line per-group stats. */
function summarizeOutcome(o: Record<string, unknown>) {
  const groups = o.groups as Array<Record<string, unknown>> | undefined;
  const classes = o.classes as Array<Record<string, unknown>> | undefined;
  const topStats = extractTopStats(o);
  return {
    type: o.type,
    title: o.title,
    timeFrame: o.timeFrame,
    paramType: o.paramType,
    unitOfMeasure: o.unitOfMeasure,
    reportingStatus: o.reportingStatus,
    groupCount: groups?.length,
    classCount: classes?.length,
    ...(topStats ? { topStats } : {}),
  };
}

/** Condense the adverse events module to counts. */
function summarizeAdverseEvents(ae: Record<string, unknown>) {
  const events = ae.eventGroups as Array<Record<string, unknown>> | undefined;
  return {
    timeFrame: ae.timeFrame,
    groupCount: Array.isArray(events) ? events.length : undefined,
    seriousEventCount: Array.isArray(ae.seriousEvents) ? ae.seriousEvents.length : undefined,
    otherEventCount: Array.isArray(ae.otherEvents) ? ae.otherEvents.length : undefined,
  };
}

/** Condense participant flow to period/group counts. */
function summarizeParticipantFlow(pf: Record<string, unknown>) {
  const groups = pf.groups as Array<Record<string, unknown>> | undefined;
  const periods = pf.periods as Array<Record<string, unknown>> | undefined;
  return {
    groupCount: Array.isArray(groups) ? groups.length : undefined,
    periodCount: Array.isArray(periods) ? periods.length : undefined,
  };
}

/** Condense baseline characteristics to measure count. */
function summarizeBaseline(bl: Record<string, unknown>) {
  const groups = bl.groups as Array<Record<string, unknown>> | undefined;
  const measures = bl.measures as Array<Record<string, unknown>> | undefined;
  return {
    groupCount: Array.isArray(groups) ? groups.length : undefined,
    measureCount: Array.isArray(measures) ? measures.length : undefined,
    measures: Array.isArray(measures)
      ? measures.map((m) => ({
          title: m.title,
          paramType: m.paramType,
          unitOfMeasure: m.unitOfMeasure,
        }))
      : undefined,
  };
}

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
        'One or more NCT IDs. E.g., "NCT12345678" or ["NCT12345678", "NCT87654321"]. Use summary=true for large batches to avoid large payloads.',
      ),
    sections: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        `Filter which sections to return. Values: outcomes, adverseEvents, participantFlow, baseline. Omit for all sections.`,
      ),
    summary: z
      .boolean()
      .default(false)
      .describe(
        'Return condensed summaries instead of full data. Reduces payload from ~200KB to ~5KB per study. Summaries include outcome titles, types, timeframes, group counts, and top-level stats — omitting individual measurements, analyses, and per-group data.',
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
    const nctIds = Array.isArray(input.nctIds) ? input.nctIds : [input.nctIds];
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

    const fetched = (await service.getStudiesBatch(nctIds, ctx)) as RawStudyShape[];
    const studyMap = new Map(
      fetched
        .map((s) => [s.protocolSection?.identificationModule?.nctId, s])
        .filter((e): e is [string, RawStudyShape] => e[0] != null),
    );

    for (const nctId of nctIds) {
      const study = studyMap.get(nctId);
      if (!study) {
        fetchErrors.push({ nctId, error: 'Study not found' });
        continue;
      }

      const title = study.protocolSection?.identificationModule?.briefTitle ?? 'Unknown';
      const hasResults = study.hasResults === true;

      if (!hasResults) {
        studiesWithoutResults.push(nctId);
        results.push({ nctId, title, hasResults: false });
        continue;
      }

      const rs = study.resultsSection ?? {};
      const entry: StudyResult = { nctId, title, hasResults: true };
      for (const section of sections) {
        const moduleKey = SECTION_MAP[section];
        const data = rs[moduleKey];
        if (data) {
          if (section === 'outcomes') {
            const measures =
              (data.outcomeMeasures as Record<string, unknown>[] | undefined) ?? [];
            entry.outcomes = input.summary ? measures.map(summarizeOutcome) : measures;
          } else if (input.summary) {
            if (section === 'adverseEvents') entry.adverseEvents = summarizeAdverseEvents(data);
            else if (section === 'participantFlow')
              entry.participantFlow = summarizeParticipantFlow(data);
            else if (section === 'baseline') entry.baseline = summarizeBaseline(data);
          } else {
            entry[section] = data;
          }
        }
      }
      results.push(entry);
    }

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
        lines.push('');
        continue;
      }

      // Outcomes — render title, type, timeframe, and per-group top-line stats
      if (r.outcomes && r.outcomes.length > 0) {
        lines.push(`\n### Outcomes (${r.outcomes.length} measures)`);
        for (const o of r.outcomes) {
          const type = (o.type as string) ?? '';
          const title = (o.title as string) ?? 'Untitled';
          const timeFrame = (o.timeFrame as string) ?? '';
          const paramType = (o.paramType as string) ?? '';
          const unitOfMeasure = (o.unitOfMeasure as string) ?? '';
          const groupCount =
            (o.groupCount as number | undefined) ??
            (Array.isArray(o.groups) ? (o.groups as unknown[]).length : undefined);
          const meta = [
            type,
            paramType,
            unitOfMeasure,
            groupCount != null ? `${groupCount} groups` : '',
          ]
            .filter(Boolean)
            .join(', ');
          const tf = timeFrame ? ` [${timeFrame}]` : '';
          lines.push(`- **${title}**${meta ? ` (${meta})` : ''}${tf}`);

          // Top-line stats: from summary shape (topStats) or extracted from full shape
          const topStats =
            (o.topStats as Array<{ group: string; value: string; spread?: string }> | undefined) ??
            extractTopStats(o as Record<string, unknown>);
          if (topStats?.length) {
            const statsStr = topStats
              .map((s) => `${s.group}: ${s.value}${s.spread ? ` ±${s.spread}` : ''}`)
              .join(' | ');
            lines.push(`  ${statsStr}`);
          }
        }
      }

      // Adverse events — render time frame and event counts
      if (r.adverseEvents) {
        const ae = r.adverseEvents;
        lines.push('\n### Adverse Events');
        // Works for both summary shape (groupCount, seriousEventCount) and full shape (eventGroups[], seriousEvents[])
        const timeFrame = ae.timeFrame as string | undefined;
        const groupCount =
          (ae.groupCount as number | undefined) ??
          (Array.isArray(ae.eventGroups) ? (ae.eventGroups as unknown[]).length : undefined);
        const seriousCount =
          (ae.seriousEventCount as number | undefined) ??
          (Array.isArray(ae.seriousEvents) ? (ae.seriousEvents as unknown[]).length : undefined);
        const otherCount =
          (ae.otherEventCount as number | undefined) ??
          (Array.isArray(ae.otherEvents) ? (ae.otherEvents as unknown[]).length : undefined);
        const parts = [
          timeFrame ? `Assessment: ${timeFrame}` : '',
          groupCount != null ? `${groupCount} groups` : '',
          seriousCount != null ? `${seriousCount} serious events` : '',
          otherCount != null ? `${otherCount} other events` : '',
        ].filter(Boolean);
        if (parts.length) lines.push(parts.join(' | '));
      }

      // Participant flow — group and period counts
      if (r.participantFlow) {
        const pf = r.participantFlow;
        lines.push('\n### Participant Flow');
        const groupCount =
          (pf.groupCount as number | undefined) ??
          (pf.numFlowGroups as number | undefined) ??
          (Array.isArray(pf.groups) ? (pf.groups as unknown[]).length : undefined);
        const periodCount =
          (pf.periodCount as number | undefined) ??
          (pf.numFlowPeriods as number | undefined) ??
          (Array.isArray(pf.periods) ? (pf.periods as unknown[]).length : undefined);
        const parts = [
          groupCount != null ? `${groupCount} groups` : '',
          periodCount != null ? `${periodCount} periods` : '',
        ].filter(Boolean);
        if (parts.length) lines.push(parts.join(' | '));
      }

      // Baseline characteristics — measure list
      if (r.baseline) {
        const bl = r.baseline;
        lines.push('\n### Baseline Characteristics');
        const measureList =
          (bl.measures as Record<string, unknown>[] | undefined) ??
          (bl.baselineMeasures as Record<string, unknown>[] | undefined);
        const groupCount =
          (bl.groupCount as number | undefined) ??
          (bl.numBaselineGroups as number | undefined) ??
          (Array.isArray(bl.groups) ? (bl.groups as unknown[]).length : undefined);
        if (groupCount != null) lines.push(`${groupCount} groups`);
        if (measureList?.length) {
          for (const m of measureList.slice(0, 10)) {
            const unit = (m.unitOfMeasure as string) ? ` (${m.unitOfMeasure as string})` : '';
            lines.push(`- ${(m.title as string) ?? (m.paramType as string) ?? 'Measure'}${unit}`);
          }
          if (measureList.length > 10) lines.push(`... and ${measureList.length - 10} more`);
        }
      }

      lines.push('');
    }

    if (result.studiesWithoutResults?.length)
      lines.push(`Without results: ${result.studiesWithoutResults.join(', ')}`);
    if (result.fetchErrors?.length)
      lines.push(
        `Fetch errors: ${result.fetchErrors.map((e) => `${e.nctId}: ${e.error}`).join(', ')}`,
      );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
