/**
 * @fileoverview Extract outcomes, adverse events, participant flow, and baseline from completed studies.
 * @module mcp-server/tools/definitions/get-study-results.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../utils/_schemas.js';

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

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

type RO = Record<string, unknown>;

/** Build a groupId→title lookup from a groups array. */
function groupMap(obj: RO): Map<string, string> {
  const groups = (obj.groups ?? obj.eventGroups) as Array<RO> | undefined;
  return new Map((groups ?? []).map((g) => [g.id as string, (g.title ?? g.id) as string]));
}

/** Truncate a group title to keep tables readable. */
function shortGroup(title: string, max = 40): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}

function formatOutcomes(outcomes: RO[], lines: string[]) {
  lines.push(`\n### Outcomes (${outcomes.length} measures)`);
  for (const o of outcomes) {
    const type = (o.type as string) ?? '';
    const title = (o.title as string) ?? 'Untitled';
    const timeFrame = (o.timeFrame as string) ?? '';
    const paramType = (o.paramType as string) ?? '';
    const unitOfMeasure = (o.unitOfMeasure as string) ?? '';
    const groupCount =
      (o.groupCount as number | undefined) ??
      (Array.isArray(o.groups) ? (o.groups as unknown[]).length : undefined);
    const meta = [type, paramType, unitOfMeasure, groupCount != null ? `${groupCount} groups` : '']
      .filter(Boolean)
      .join(', ');
    const tf = timeFrame ? ` [${timeFrame}]` : '';
    lines.push(`- **${title}**${meta ? ` (${meta})` : ''}${tf}`);

    const topStats =
      (o.topStats as Array<{ group: string; value: string; spread?: string }> | undefined) ??
      extractTopStats(o as RO);
    if (topStats?.length) {
      lines.push(
        `  ${topStats.map((s) => `${s.group}: ${s.value}${s.spread ? ` ±${s.spread}` : ''}`).join(' | ')}`,
      );
    }

    // Full mode: render analyses if present
    const analyses = o.analyses as Array<RO> | undefined;
    if (analyses?.length) {
      for (const a of analyses) {
        const parts = [
          a.statisticalMethod ? `Method: ${a.statisticalMethod}` : '',
          a.pValue ? `p=${a.pValue}` : '',
          a.paramValue ? `${a.paramType ?? 'estimate'}=${a.paramValue}` : '',
          a.ciLowerLimit != null && a.ciUpperLimit != null
            ? `${a.ciPctValue ?? 95}% CI [${a.ciLowerLimit}, ${a.ciUpperLimit}]`
            : '',
        ].filter(Boolean);
        if (parts.length) lines.push(`  Analysis: ${parts.join(', ')}`);
      }
    }
  }
}

function formatAdverseEvents(ae: RO, lines: string[]) {
  lines.push('\n### Adverse Events');
  const gm = groupMap(ae);
  const timeFrame = ae.timeFrame as string | undefined;
  if (timeFrame) lines.push(`Assessment period: ${timeFrame}`);

  const serious = ae.seriousEvents as Array<RO> | undefined;
  const other = ae.otherEvents as Array<RO> | undefined;

  // Summary shape — only counts, no event arrays
  if (!serious && !other) {
    const parts = [
      gm.size ? `${gm.size} groups` : '',
      ae.seriousEventCount != null ? `${ae.seriousEventCount} serious events` : '',
      ae.otherEventCount != null ? `${ae.otherEventCount} other events` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(' | '));
    return;
  }

  // Full shape — render actual events with per-group stats
  const renderEvents = (label: string, events: RO[]) => {
    lines.push(`\n**${label}** (${events.length})`);
    for (const ev of events.slice(0, 20)) {
      const stats = ev.stats as Array<RO> | undefined;
      const statStr = (stats ?? [])
        .map((s) => {
          const gName = shortGroup(gm.get(s.groupId as string) ?? (s.groupId as string));
          return `${gName}: ${s.numAffected}/${s.numAtRisk}`;
        })
        .join(', ');
      lines.push(`- ${ev.term}${statStr ? ` — ${statStr}` : ''}`);
    }
    if (events.length > 20) lines.push(`  ... and ${events.length - 20} more`);
  };

  if (serious?.length) renderEvents('Serious Events', serious);
  if (other?.length) renderEvents('Other Events', other);
}

function formatParticipantFlow(pf: RO, lines: string[]) {
  lines.push('\n### Participant Flow');
  const gm = groupMap(pf);
  const periods = pf.periods as Array<RO> | undefined;

  // Summary shape — only counts
  if (!periods) {
    const parts = [
      pf.groupCount != null ? `${pf.groupCount} groups` : '',
      pf.periodCount != null ? `${pf.periodCount} periods` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(' | '));
    return;
  }

  // Full shape — render milestones with per-group counts
  for (const period of periods) {
    if (periods.length > 1) lines.push(`\n**${(period.title as string) ?? 'Period'}**`);
    const milestones = period.milestones as Array<RO> | undefined;
    for (const ms of milestones ?? []) {
      const achievements = ms.achievements as Array<RO> | undefined;
      const achStr = (achievements ?? [])
        .map((a) => {
          const gName = shortGroup(gm.get(a.groupId as string) ?? (a.groupId as string));
          return `${gName}: ${a.numSubjects ?? a.numUnits ?? '?'}`;
        })
        .join(', ');
      lines.push(`- **${(ms.type as string) ?? 'Milestone'}**: ${achStr}`);
    }

    const drops = period.dropWithdraws as Array<RO> | undefined;
    if (drops?.length) {
      for (const d of drops) {
        const reasons = d.reasons as Array<RO> | undefined;
        const rStr = (reasons ?? [])
          .map((r) => {
            const gName = shortGroup(gm.get(r.groupId as string) ?? (r.groupId as string));
            return `${gName}: ${r.numSubjects ?? '?'}`;
          })
          .join(', ');
        lines.push(`- Drop/Withdraw — ${(d.type as string) ?? 'reason'}: ${rStr}`);
      }
    }
  }
}

function formatBaseline(bl: RO, lines: string[]) {
  lines.push('\n### Baseline Characteristics');
  const gm = groupMap(bl);
  const measures = bl.measures as Array<RO> | undefined;

  // Summary shape — just titles (no classes array on first measure means summarized)
  const firstMeasure = measures?.[0];
  if (
    measures?.length &&
    firstMeasure &&
    !(firstMeasure.classes as Array<RO> | undefined)?.length
  ) {
    if (gm.size) lines.push(`${gm.size} groups`);
    for (const m of measures.slice(0, 10)) {
      const unit = (m.unitOfMeasure as string) ? ` (${m.unitOfMeasure as string})` : '';
      lines.push(`- ${(m.title as string) ?? 'Measure'}${unit}`);
    }
    if (measures.length > 10) lines.push(`... and ${measures.length - 10} more`);
    return;
  }

  // Full shape — render per-group values
  if (gm.size) lines.push(`Groups: ${[...gm.values()].map((g) => shortGroup(g)).join(', ')}`);

  for (const m of (measures ?? []).slice(0, 15)) {
    const title = (m.title as string) ?? 'Measure';
    const unit = (m.unitOfMeasure as string) ? ` (${m.unitOfMeasure as string})` : '';
    const paramType = (m.paramType as string) ?? '';
    const dispersion = (m.dispersionType as string) ?? '';
    const desc = [paramType, dispersion].filter(Boolean).join(', ');
    lines.push(`- **${title}**${unit}${desc ? ` [${desc}]` : ''}`);

    const classes = m.classes as Array<RO> | undefined;
    for (const cls of classes ?? []) {
      const clsTitle = cls.title as string | undefined;
      const categories = cls.categories as Array<RO> | undefined;
      for (const cat of categories ?? []) {
        const catTitle = cat.title as string | undefined;
        const prefix = clsTitle ?? catTitle ?? '';
        const measurements = cat.measurements as Array<RO> | undefined;
        const vals = (measurements ?? [])
          .filter((v) => v.value != null && v.value !== 'NA' && v.value !== 'NR')
          .map((v) => {
            const gName = shortGroup(gm.get(v.groupId as string) ?? (v.groupId as string));
            const spread = v.spread != null ? ` ±${v.spread}` : '';
            return `${gName}: ${v.value}${spread}`;
          })
          .join(', ');
        if (vals) lines.push(`  ${prefix ? `${prefix}: ` : ''}${vals}`);
      }
    }
  }
  if ((measures ?? []).length > 15) lines.push(`... and ${(measures ?? []).length - 15} more`);
}

export const getStudyResults = tool('clinicaltrials_get_study_results', {
  description: `Fetch trial results data for completed studies — outcome measures with statistics, adverse events, participant flow, and baseline characteristics. Only available for studies where hasResults is true. Use clinicaltrials_search_studies first to find studies with results.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    nctIds: z
      .union([nctIdSchema, z.array(nctIdSchema).min(1).max(20)])
      .describe(
        'One or more NCT IDs (max 20). E.g., "NCT12345678" or ["NCT12345678", "NCT87654321"]. Use summary=true for large batches to avoid large payloads.',
      ),
    sections: z
      .union([z.enum(VALID_SECTIONS), z.array(z.enum(VALID_SECTIONS))])
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
      ? Array.isArray(input.sections)
        ? input.sections
        : [input.sections]
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
    const erroredIds = new Set<string>();

    let fetched: RawStudyShape[];
    try {
      fetched = (await service.getStudiesBatch(nctIds, ctx)) as RawStudyShape[];
    } catch (err) {
      // The batch endpoint rejects the whole request if any single ID is
      // malformed or nonexistent. Fall back to per-ID fetches so valid IDs
      // still succeed and only failing IDs land in fetchErrors. Sequential
      // to honor the service's rate limit (~1 req/sec).
      const batchMessage = err instanceof Error ? err.message : String(err);
      ctx.log.warning('Batch fetch rejected; falling back to per-ID fetches', {
        count: nctIds.length,
        error: batchMessage,
      });
      fetched = [];
      for (const nctId of nctIds) {
        try {
          fetched.push((await service.getStudy(nctId, ctx)) as RawStudyShape);
        } catch (perIdErr) {
          const perIdMessage = perIdErr instanceof Error ? perIdErr.message : String(perIdErr);
          fetchErrors.push({ nctId, error: perIdMessage });
          erroredIds.add(nctId);
        }
      }
    }

    const studyMap = new Map(
      fetched
        .map((s) => [s.protocolSection?.identificationModule?.nctId, s])
        .filter((e): e is [string, RawStudyShape] => e[0] != null),
    );

    for (const nctId of nctIds) {
      if (erroredIds.has(nctId)) continue;
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
            const measures = (data.outcomeMeasures as Record<string, unknown>[] | undefined) ?? [];
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
        lines.push('No results available.\n');
        continue;
      }

      if (r.outcomes?.length) formatOutcomes(r.outcomes, lines);
      if (r.adverseEvents) formatAdverseEvents(r.adverseEvents, lines);
      if (r.participantFlow) formatParticipantFlow(r.participantFlow, lines);
      if (r.baseline) formatBaseline(r.baseline, lines);
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
