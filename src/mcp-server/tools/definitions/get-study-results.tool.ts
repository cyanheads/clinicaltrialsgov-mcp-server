/**
 * @fileoverview Extract outcomes, adverse events, participant flow, baseline, and results metadata from completed studies.
 * @module mcp-server/tools/definitions/get-study-results.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../utils/_schemas.js';
import { blankValueMessage, firstBlankListParam, toArray } from '../utils/query-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

const VALID_SECTIONS = [
  'outcomes',
  'adverseEvents',
  'participantFlow',
  'baseline',
  'moreInfo',
] as const;
type Section = (typeof VALID_SECTIONS)[number];

/** Map section names to resultsSection module keys. */
const SECTION_MAP: Record<Section, string> = {
  outcomes: 'outcomeMeasuresModule',
  adverseEvents: 'adverseEventsModule',
  participantFlow: 'participantFlowModule',
  baseline: 'baselineCharacteristicsModule',
  moreInfo: 'moreInfoModule',
};

/**
 * Resolve a measurement value for the condensed/text channels. The caller's
 * `!= null` guard drops genuinely-empty cells; the `"NA"`/`"NR"` sentinels are
 * NOT dropped — for time-to-event MEDIAN measures they encode "median not
 * reached", and silently dropping them removes an entire arm from the rendered
 * measure (the comparator then reads as the headline result). Surface that
 * explicitly for MEDIAN; pass other sentinel-bearing values through unchanged.
 */
function displayMeasurementValue(value: unknown, paramType: unknown): string {
  const v = String(value);
  return (v === 'NA' || v === 'NR') && paramType === 'MEDIAN' ? 'not reached' : v;
}

/**
 * Extract top-line per-group stats from a raw outcome object for summary mode's
 * `topStats`. Reads only the first class/category — deliberate condensation, and
 * the reason full mode walks the whole tree in format() instead of calling this.
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
    .filter((m) => m.value != null)
    .map((m) => ({
      group: groupMap.get(m.groupId as string) ?? (m.groupId as string),
      value: displayMeasurementValue(m.value, o.paramType),
      ...(m.spread != null ? { spread: m.spread as string } : {}),
    }));
  return stats.length ? stats : undefined;
}

/**
 * Extract topline statistical analysis from a raw outcome object. Returns the
 * first analysis (typically the primary one), keeping only present fields so
 * the summary stays compact.
 */
function extractTopAnalysis(o: Record<string, unknown>): Record<string, unknown> | undefined {
  const analyses = o.analyses as Array<Record<string, unknown>> | undefined;
  const a = analyses?.[0];
  if (!a) return;
  const keys = [
    'statisticalMethod',
    'pValue',
    'pValueComment',
    'paramType',
    'paramValue',
    'ciPctValue',
    'ciNumSides',
    'ciLowerLimit',
    'ciUpperLimit',
    'nonInferiorityType',
    'estimateComment',
    'groupIds',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (a[k] != null) out[k] = a[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Condense a full outcome measure to its essential metadata plus top-line per-group stats. */
function summarizeOutcome(o: Record<string, unknown>) {
  const groups = o.groups as Array<Record<string, unknown>> | undefined;
  const classes = o.classes as Array<Record<string, unknown>> | undefined;
  const topStats = extractTopStats(o);
  const topAnalysis = extractTopAnalysis(o);
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
    ...(topAnalysis ? { topAnalysis } : {}),
  };
}

const TOP_EVENTS_LIMIT = 20;

interface TopAdverseEvent {
  kind: 'serious' | 'other';
  numAffected: number;
  numAtRisk: number;
  organSystem: string;
  term: string;
}

/** Sum an adverse event's per-group stats into trial-wide affected/at-risk totals. */
function aggregateEventStats(ev: Record<string, unknown>): {
  numAffected: number;
  numAtRisk: number;
} {
  const stats = (ev.stats as Array<Record<string, unknown>> | undefined) ?? [];
  let numAffected = 0;
  let numAtRisk = 0;
  for (const s of stats) {
    numAffected += Number(s.numAffected) || 0;
    numAtRisk += Number(s.numAtRisk) || 0;
  }
  return { numAffected, numAtRisk };
}

/**
 * Rank the most frequent adverse events across serious and other groups,
 * aggregating each term's affected/at-risk counts across all arms. Trial-wide
 * incidence view for summary mode — "which AEs and how common" in ~5KB rather
 * than the full ~450KB nested structure.
 */
function topAdverseEvents(ae: Record<string, unknown>): TopAdverseEvent[] {
  const collect = (events: unknown, kind: 'serious' | 'other'): TopAdverseEvent[] =>
    Array.isArray(events)
      ? (events as Array<Record<string, unknown>>).map((ev) => ({
          term: (ev.term as string) ?? 'Unspecified',
          organSystem: (ev.organSystem as string) ?? '',
          kind,
          ...aggregateEventStats(ev),
        }))
      : [];
  return [...collect(ae.seriousEvents, 'serious'), ...collect(ae.otherEvents, 'other')]
    .sort((a, b) => b.numAffected - a.numAffected)
    .slice(0, TOP_EVENTS_LIMIT);
}

/** Condense the adverse events module to counts plus a ranked top-events view. */
function summarizeAdverseEvents(ae: Record<string, unknown>) {
  const events = ae.eventGroups as Array<Record<string, unknown>> | undefined;
  const topEvents = topAdverseEvents(ae);
  return {
    timeFrame: ae.timeFrame,
    groupCount: Array.isArray(events) ? events.length : undefined,
    seriousEventCount: Array.isArray(ae.seriousEvents) ? ae.seriousEvents.length : undefined,
    otherEventCount: Array.isArray(ae.otherEvents) ? ae.otherEvents.length : undefined,
    ...(topEvents.length > 0 ? { topEvents } : {}),
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

/**
 * Condense the more-info module — keep the small metadata (limitations, contact,
 * agreement flags) and drop only the verbose `certainAgreement.otherDetails` prose.
 */
function summarizeMoreInfo(mi: Record<string, unknown>) {
  const agreement = mi.certainAgreement as Record<string, unknown> | undefined;
  return {
    ...(mi.limitationsAndCaveats ? { limitationsAndCaveats: mi.limitationsAndCaveats } : {}),
    ...(agreement
      ? {
          certainAgreement: {
            piSponsorEmployee: agreement.piSponsorEmployee,
            restrictiveAgreement: agreement.restrictiveAgreement,
            restrictionType: agreement.restrictionType,
          },
        }
      : {}),
    ...(mi.pointOfContact ? { pointOfContact: mi.pointOfContact } : {}),
  };
}

/** What a caller-requested cap actually trimmed on one study's results. */
interface ResultsFilterMeta {
  adverseEventLimit?: number;
  outcomeLimit?: number;
  totalOtherEvents?: number;
  totalOutcomes?: number;
  totalSeriousEvents?: number;
}

/**
 * Cap a study's outcome measure list. The cap drops whole measures — every
 * surviving one keeps its complete groups/classes/measurements/analyses tree.
 * Recorded in `meta` only when the slice actually removed something; echoing a
 * cap that trimmed nothing would report a filter that was never applied (#80).
 */
function capOutcomes(
  measures: Record<string, unknown>[],
  limit: number | undefined,
  meta: ResultsFilterMeta,
): Record<string, unknown>[] {
  if (limit == null || measures.length <= limit) return measures;
  meta.totalOutcomes = measures.length;
  meta.outcomeLimit = limit;
  return measures.slice(0, limit);
}

/**
 * Cap the serious and other event lists of a full-mode adverse-events module.
 * The two lists are capped independently — one list exceeding the limit says
 * nothing about the other — and the event group roster is never capped, since
 * every per-event stat joins back to it by id.
 */
function capAdverseEvents(
  ae: Record<string, unknown>,
  limit: number | undefined,
  meta: ResultsFilterMeta,
): Record<string, unknown> {
  if (limit == null) return ae;
  const next = { ...ae };
  let trimmed = false;
  const serious = ae.seriousEvents as unknown[] | undefined;
  if (serious && serious.length > limit) {
    meta.totalSeriousEvents = serious.length;
    next.seriousEvents = serious.slice(0, limit);
    trimmed = true;
  }
  const other = ae.otherEvents as unknown[] | undefined;
  if (other && other.length > limit) {
    meta.totalOtherEvents = other.length;
    next.otherEvents = other.slice(0, limit);
    trimmed = true;
  }
  if (!trimmed) return ae;
  meta.adverseEventLimit = limit;
  return next;
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

/** Coerce a raw value to a trimmed display string, or undefined when absent/blank. */
function text(value: unknown): string | undefined {
  if (value == null) return;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Render the arm roster for a results section. `id` is the join key every
 * measurement, count, and stat references, and `description` is the arm's
 * definition — both belong on the text channel alongside the title.
 */
function renderGroupRoster(obj: RO, indent: string, lines: string[], label = 'Groups'): void {
  const groups = (obj.groups ?? obj.eventGroups) as Array<RO> | undefined;
  if (!groups?.length) return;
  lines.push(`${indent}${label}:`);
  for (const g of groups) {
    const head = [text(g.id), text(g.title)].filter(Boolean).join(': ');
    lines.push(`${indent}- ${head || 'Group'}`);
    const desc = text(g.description);
    if (desc) lines.push(`${indent}  ${desc}`);
    const rollup = [
      g.deathsNumAffected != null
        ? `deaths ${g.deathsNumAffected}/${g.deathsNumAtRisk ?? '?'}`
        : '',
      g.seriousNumAffected != null
        ? `serious ${g.seriousNumAffected}/${g.seriousNumAtRisk ?? '?'}`
        : '',
      g.otherNumAffected != null ? `other ${g.otherNumAffected}/${g.otherNumAtRisk ?? '?'}` : '',
    ].filter(Boolean);
    if (rollup.length) lines.push(`${indent}  ${rollup.join(' | ')}`);
  }
}

/** Render denominator rows — the units and the per-group counts they apply to. */
function renderDenoms(
  denoms: unknown,
  gm: Map<string, string>,
  indent: string,
  lines: string[],
): void {
  for (const d of (denoms as Array<RO> | undefined) ?? []) {
    const counts = ((d.counts as Array<RO> | undefined) ?? [])
      .map((c) => {
        const g = shortGroup(gm.get(c.groupId as string) ?? String(c.groupId));
        return c.value != null ? `${g}: ${c.value}` : g;
      })
      .join(', ');
    const units = text(d.units);
    const label = units ? `Denominator (${units})` : 'Denominator';
    lines.push(`${indent}${[label, counts].filter(Boolean).join(': ')}`);
  }
}

/**
 * Render per-group participant counts as `Group: subjects / units (comment)`
 * segments — the shape both participant-flow milestone achievements and
 * drop/withdraw reasons publish.
 */
function countsByGroup(rows: unknown, gm: Map<string, string>): string {
  return ((rows as Array<RO> | undefined) ?? [])
    .map((r) => {
      const gName = shortGroup(gm.get(r.groupId as string) ?? (r.groupId as string));
      const comment = text(r.comment);
      const count = [r.numSubjects, r.numUnits].filter((v) => v != null).join(' / ') || '?';
      return `${gName}: ${count}${comment ? ` (${comment})` : ''}`;
    })
    .join(', ');
}

/** Render one measurement cell — value, spread, confidence limits, and comment. */
function measurementCell(m: RO, gm: Map<string, string>, paramType: unknown): string | undefined {
  const parts: string[] = [];
  if (m.value != null) parts.push(displayMeasurementValue(m.value, paramType));
  if (m.spread != null) parts.push(`±${m.spread}`);
  if (m.lowerLimit != null || m.upperLimit != null)
    parts.push(`[${m.lowerLimit ?? ''} to ${m.upperLimit ?? ''}]`);
  const comment = text(m.comment);
  if (comment) parts.push(`(${comment})`);
  if (parts.length === 0) return;
  const g = shortGroup(gm.get(m.groupId as string) ?? String(m.groupId));
  return `${g}: ${parts.join(' ')}`;
}

/**
 * Walk a measure's complete classes → categories → measurements tree. Every
 * level carries data — class and category titles, per-class denominators, and
 * the per-group cells — so reading only the first entry drops the rest of the
 * measure from the text channel.
 */
function renderClasses(
  classes: unknown,
  gm: Map<string, string>,
  paramType: unknown,
  indent: string,
  lines: string[],
): void {
  for (const cls of (classes as Array<RO> | undefined) ?? []) {
    const clsTitle = text(cls.title);
    if (clsTitle) lines.push(`${indent}_${clsTitle}_`);
    renderDenoms(cls.denoms, gm, `${indent}  `, lines);
    for (const cat of (cls.categories as Array<RO> | undefined) ?? []) {
      const catTitle = text(cat.title);
      const cells = ((cat.measurements as Array<RO> | undefined) ?? [])
        .map((m) => measurementCell(m, gm, paramType))
        .filter((v): v is string => Boolean(v));
      // Label the row even when upstream titles neither the class nor the
      // category, so a measurement row is never mistaken for a denominator row.
      const prefix = catTitle ?? clsTitle ?? 'Values';
      if (cells.length > 0) lines.push(`${indent}  ${prefix}: ${cells.join(', ')}`);
      else if (catTitle) lines.push(`${indent}  ${catTitle}`);
    }
  }
}

/** Render one analysis (summary or full) as a single-line bullet. */
function formatAnalysisLine(a: RO): string {
  const ci = [
    a.ciPctValue != null ? `${a.ciPctValue}%` : '',
    text(a.ciNumSides),
    a.ciLowerLimit != null || a.ciUpperLimit != null
      ? `CI [${a.ciLowerLimit ?? ''}, ${a.ciUpperLimit ?? ''}]`
      : '',
    text(a.ciLowerLimitComment),
    text(a.ciUpperLimitComment),
  ]
    .filter(Boolean)
    .join(' ');
  const parts = [
    a.statisticalMethod ? `Method: ${a.statisticalMethod}` : '',
    text(a.statisticalComment),
    a.pValue ? `p=${a.pValue}` : '',
    text(a.pValueComment),
    a.testedNonInferiority != null
      ? `non-inferiority tested: ${a.testedNonInferiority ? 'yes' : 'no'}`
      : '',
    a.nonInferiorityType ? `(${a.nonInferiorityType})` : '',
    text(a.nonInferiorityComment),
    a.paramValue ? `${a.paramType ?? 'estimate'}=${a.paramValue}` : '',
    a.dispersionType ? `dispersion: ${a.dispersionType}` : '',
    a.dispersionValue != null ? `±${a.dispersionValue}` : '',
    ci,
    text(a.estimateComment),
    text(a.otherAnalysisDescription),
    Array.isArray(a.groupIds) ? `groups: ${(a.groupIds as string[]).join(', ')}` : '',
    text(a.groupDescription),
  ].filter(Boolean);
  return parts.length ? `  Analysis: ${parts.join(', ')}` : '';
}

/**
 * Disclose a trim on the text channel. Both channels carry the same capped
 * data, so the counts and the route back to the omitted rows have to reach the
 * caller who only reads `content[]`.
 */
function formatCaps(meta: RO, lines: string[]) {
  const parts = [
    meta.totalOutcomes != null
      ? `${meta.outcomeLimit} of ${meta.totalOutcomes} outcome measures`
      : '',
    meta.totalSeriousEvents != null
      ? `${meta.adverseEventLimit} of ${meta.totalSeriousEvents} serious adverse events`
      : '',
    meta.totalOtherEvents != null
      ? `${meta.adverseEventLimit} of ${meta.totalOtherEvents} other adverse events`
      : '',
  ].filter(Boolean);
  if (!parts.length) return;
  lines.push(
    `_Capped: returning ${parts.join('; ')}. Raise outcomeLimit / adverseEventLimit on clinicaltrials_get_study_results, or narrow sections and re-run, to reach the omitted rows._`,
  );
}

function formatOutcomes(outcomes: RO[], lines: string[]) {
  lines.push(`\n### Outcomes (${outcomes.length} measures)`);
  for (const o of outcomes) {
    const gm = groupMap(o);
    const title = text(o.title) ?? 'Untitled';
    const timeFrame = text(o.timeFrame);
    const groupCount =
      (o.groupCount as number | undefined) ??
      (Array.isArray(o.groups) ? (o.groups as unknown[]).length : undefined);
    const classCount =
      (o.classCount as number | undefined) ??
      (Array.isArray(o.classes) ? (o.classes as unknown[]).length : undefined);
    const meta = [
      text(o.type),
      text(o.paramType),
      text(o.dispersionType),
      text(o.unitOfMeasure),
      groupCount != null ? `${groupCount} groups` : '',
      classCount != null ? `${classCount} classes` : '',
      o.reportingStatus ? `reporting: ${o.reportingStatus as string}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`- **${title}**${meta ? ` (${meta})` : ''}${timeFrame ? ` [${timeFrame}]` : ''}`);

    const description = text(o.description);
    if (description) lines.push(`  ${description}`);
    const population = text(o.populationDescription);
    if (population) lines.push(`  Population: ${population}`);
    const unitsAnalyzed = text(o.typeUnitsAnalyzed);
    const denomUnits = text(o.denomUnitsSelected);
    const anticipatedPosting = text(o.anticipatedPostingDate);
    const outcomeUnits = [
      unitsAnalyzed ? `Units analyzed: ${unitsAnalyzed}` : '',
      denomUnits ? `Denominator units: ${denomUnits}` : '',
      anticipatedPosting ? `Anticipated posting: ${anticipatedPosting}` : '',
    ].filter(Boolean);
    if (outcomeUnits.length) lines.push(`  ${outcomeUnits.join(' | ')}`);

    // Summary mode: the per-group top-line stats the handler condensed.
    const topStats = o.topStats as
      | Array<{ group: string; spread?: string; value: string }>
      | undefined;
    if (topStats?.length) {
      lines.push(
        `  ${topStats.map((s) => `${s.group}: ${s.value}${s.spread ? ` ±${s.spread}` : ''}`).join(' | ')}`,
      );
    }

    // Full mode: the complete arm roster, denominators, and measurement tree.
    renderGroupRoster(o, '  ', lines);
    renderDenoms(o.denoms, gm, '  ', lines);
    renderClasses(o.classes, gm, o.paramType, '  ', lines);

    // Summary mode: single condensed analysis lifted from analyses[0].
    const topAnalysis = o.topAnalysis as RO | undefined;
    if (topAnalysis) {
      const line = formatAnalysisLine(topAnalysis);
      if (line) lines.push(line);
    }

    // Full mode: render every analysis on the measure.
    for (const a of (o.analyses as Array<RO> | undefined) ?? []) {
      const line = formatAnalysisLine(a);
      if (line) lines.push(line);
    }
  }
}

function formatAdverseEvents(ae: RO, lines: string[]) {
  lines.push('\n### Adverse Events');
  const gm = groupMap(ae);
  const timeFrame = text(ae.timeFrame);
  if (timeFrame) lines.push(`Assessment period: ${timeFrame}`);
  const description = text(ae.description);
  if (description) lines.push(description);
  const threshold = text(ae.frequencyThreshold);
  if (threshold) lines.push(`Frequency threshold: ${threshold}%`);
  const mortality = text(ae.allCauseMortalityComment);
  if (mortality) lines.push(`All-cause mortality: ${mortality}`);

  // Summary shape — counts plus the ranked top-events view, no raw event arrays.
  // Detected on the summarizer's own keys, so a full module that happens to
  // publish no events still takes the full path and renders its event groups.
  if ('groupCount' in ae || 'seriousEventCount' in ae || 'otherEventCount' in ae) {
    const parts = [
      ae.groupCount != null ? `${ae.groupCount} groups` : '',
      ae.seriousEventCount != null ? `${ae.seriousEventCount} serious events` : '',
      ae.otherEventCount != null ? `${ae.otherEventCount} other events` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(' | '));
    const topEvents = ae.topEvents as Array<RO> | undefined;
    if (topEvents?.length) {
      lines.push(`\n**Most frequent events** (top ${topEvents.length} by participants affected)`);
      for (const ev of topEvents) {
        const sys = ev.organSystem ? ` _(${ev.organSystem as string})_` : '';
        lines.push(`- ${ev.term}${sys} — ${ev.numAffected}/${ev.numAtRisk} affected [${ev.kind}]`);
      }
    }
    return;
  }

  // Full shape — every event group, event, and per-group stat the handler
  // returned. Payload control is summary mode (which condenses per item), never
  // a format()-side cap or a per-event field subset (channel parity).
  renderGroupRoster(ae, '', lines, 'Event Groups');

  const renderEvents = (label: string, events: RO[]) => {
    lines.push(`\n**${label}** (${events.length})`);
    for (const ev of events) {
      const meta = [
        text(ev.organSystem),
        text(ev.sourceVocabulary),
        text(ev.assessmentType),
      ].filter(Boolean);
      const statStr = ((ev.stats as Array<RO> | undefined) ?? [])
        .map((s) => {
          const gName = shortGroup(gm.get(s.groupId as string) ?? (s.groupId as string));
          const events_ = s.numEvents != null ? ` (${s.numEvents} events)` : '';
          return `${gName}: ${s.numAffected}/${s.numAtRisk}${events_}`;
        })
        .join(', ');
      lines.push(
        `- ${ev.term}${meta.length ? ` _(${meta.join(' | ')})_` : ''}${statStr ? ` — ${statStr}` : ''}`,
      );
      const notes = text(ev.notes);
      if (notes) lines.push(`  ${notes}`);
    }
  };

  const serious = ae.seriousEvents as Array<RO> | undefined;
  const other = ae.otherEvents as Array<RO> | undefined;
  if (serious?.length) renderEvents('Serious Events', serious);
  if (other?.length) renderEvents('Other Events', other);
}

function formatParticipantFlow(pf: RO, lines: string[]) {
  lines.push('\n### Participant Flow');
  const gm = groupMap(pf);

  // Summary shape — only counts.
  if ('groupCount' in pf || 'periodCount' in pf) {
    const parts = [
      pf.groupCount != null ? `${pf.groupCount} groups` : '',
      pf.periodCount != null ? `${pf.periodCount} periods` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(' | '));
    return;
  }

  // Full shape — recruitment context, the arm roster, then per-period milestones.
  const recruitment = text(pf.recruitmentDetails);
  if (recruitment) lines.push(`Recruitment: ${recruitment}`);
  const preAssignment = text(pf.preAssignmentDetails);
  if (preAssignment) lines.push(`Pre-assignment: ${preAssignment}`);
  const unitsAnalyzed = text(pf.typeUnitsAnalyzed);
  if (unitsAnalyzed) lines.push(`Units analyzed: ${unitsAnalyzed}`);
  renderGroupRoster(pf, '', lines);

  for (const period of (pf.periods as Array<RO> | undefined) ?? []) {
    const periodTitle = text(period.title);
    if (periodTitle) lines.push(`\n**${periodTitle}**`);
    for (const ms of (period.milestones as Array<RO> | undefined) ?? []) {
      const achStr = countsByGroup(ms.achievements, gm);
      const msComment = text(ms.comment);
      lines.push(
        `- **${text(ms.type) ?? 'Milestone'}**: ${achStr}${msComment ? ` — ${msComment}` : ''}`,
      );
    }

    for (const d of (period.dropWithdraws as Array<RO> | undefined) ?? []) {
      const rStr = countsByGroup(d.reasons, gm);
      const dComment = text(d.comment);
      lines.push(
        `- Drop/Withdraw — ${text(d.type) ?? 'reason'}: ${rStr}${dComment ? ` — ${dComment}` : ''}`,
      );
    }
  }
}

function formatBaseline(bl: RO, lines: string[]) {
  lines.push('\n### Baseline Characteristics');
  const gm = groupMap(bl);
  const measures = bl.measures as Array<RO> | undefined;

  // Summary shape — counts plus each measure's identifying metadata.
  if ('groupCount' in bl || 'measureCount' in bl) {
    const parts = [
      bl.groupCount != null ? `${bl.groupCount} groups` : '',
      bl.measureCount != null ? `${bl.measureCount} measures` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(' | '));
    for (const m of measures ?? []) {
      const meta = [text(m.paramType), text(m.unitOfMeasure)].filter(Boolean);
      lines.push(`- ${text(m.title) ?? 'Measure'}${meta.length ? ` (${meta.join(', ')})` : ''}`);
    }
    return;
  }

  // Full shape — population context, the arm roster, then every measure's tree.
  const population = text(bl.populationDescription);
  if (population) lines.push(`Population: ${population}`);
  const unitsAnalyzed = text(bl.typeUnitsAnalyzed);
  if (unitsAnalyzed) lines.push(`Units analyzed: ${unitsAnalyzed}`);
  renderGroupRoster(bl, '', lines);
  renderDenoms(bl.denoms, gm, '', lines);

  for (const m of measures ?? []) {
    const title = text(m.title) ?? 'Measure';
    const unit = text(m.unitOfMeasure);
    const desc = [text(m.paramType), text(m.dispersionType)].filter(Boolean).join(', ');
    lines.push(`- **${title}**${unit ? ` (${unit})` : ''}${desc ? ` [${desc}]` : ''}`);
    const mDescription = text(m.description);
    if (mDescription) lines.push(`  ${mDescription}`);
    const mPopulation = text(m.populationDescription);
    if (mPopulation) lines.push(`  Population: ${mPopulation}`);
    if (m.calculatePct != null) lines.push(`  Percentages: ${m.calculatePct ? 'yes' : 'no'}`);
    const denomUnits = text(m.denomUnitsSelected);
    if (denomUnits) lines.push(`  Denominator units: ${denomUnits}`);
    renderDenoms(m.denoms, gm, '  ', lines);
    renderClasses(m.classes, gm, m.paramType, '  ', lines);
  }
}

function formatMoreInfo(mi: RO, lines: string[]) {
  // Header is unconditional, matching the sibling section renderers — keeps the
  // section visible on the content[] channel for format-parity, whose synthetic
  // sample for an opaque record carries none of the named sub-keys below.
  lines.push('\n### More Info');
  const lim = mi.limitationsAndCaveats as { description?: string } | undefined;
  const agr = mi.certainAgreement as RO | undefined;
  const poc = mi.pointOfContact as RO | undefined;
  if (lim?.description) lines.push(`**Limitations & Caveats:** ${lim.description}`);
  if (agr) {
    const parts = [
      agr.restrictiveAgreement != null
        ? `Restrictive agreement: ${agr.restrictiveAgreement ? 'yes' : 'no'}`
        : '',
      agr.restrictionType ? `Type: ${agr.restrictionType as string}` : '',
      agr.piSponsorEmployee != null
        ? `PI is sponsor employee: ${agr.piSponsorEmployee ? 'yes' : 'no'}`
        : '',
    ].filter(Boolean);
    if (parts.length) lines.push(`**Certain Agreement:** ${parts.join(' | ')}`);
    if (agr.otherDetails) lines.push(`  ${agr.otherDetails as string}`);
  }
  if (poc) {
    const phone = poc.phoneExt ? `${poc.phone} ext. ${poc.phoneExt}` : poc.phone;
    const parts = [poc.title, poc.organization, poc.email, phone].filter(Boolean);
    if (parts.length) lines.push(`**Point of Contact:** ${parts.join(' | ')}`);
  }
}

export const getStudyResults = tool('clinicaltrials_get_study_results', {
  description: `Fetch clinical trial results data from ClinicalTrials.gov for completed studies — outcome measures with statistics, adverse events, participant flow, baseline characteristics, and results metadata (limitations & caveats, certain-agreement disclosure restrictions, results point of contact). Only available for studies where hasResults is true. Use clinicaltrials_search_studies first to find studies with results. A results-rich record can exceed 500KB per study in full mode — bound it with summary=true, narrower sections, or the outcomeLimit / adverseEventLimit caps, whose trims are reported per study in filtersApplied.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'blank_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parameter was supplied with a blank, whitespace-only, or empty-list value.',
      recovery: RECOVERY_HINTS.blank_value,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
    },
  ],

  input: z.object({
    nctIds: z
      .union([
        nctIdSchema.describe('A single NCT ID.'),
        z.array(nctIdSchema).max(20).describe('Multiple NCT IDs (max 20).'),
      ])
      .describe(
        'One or more NCT IDs (max 20) — an empty list is rejected. E.g., "NCT12345678" or ["NCT12345678", "NCT87654321"]. Use summary=true for large batches to avoid large payloads.',
      ),
    sections: z
      .union([
        z.enum(VALID_SECTIONS).describe('A single section name.'),
        z.array(z.enum(VALID_SECTIONS)).describe('Multiple section names.'),
      ])
      .optional()
      .describe(
        `Filter which sections to return. Values: outcomes, adverseEvents, participantFlow, baseline, moreInfo. Omit for all sections — an empty list is rejected, not treated as omission.`,
      ),
    summary: z
      .boolean()
      .default(false)
      .describe(
        'Return condensed summaries instead of full data. Full mode renders every row and field on both output channels, so a large results set can exceed 500KB per study; summary mode reduces that to ~5KB. Summaries include outcome titles, types, timeframes, group counts, and top-level stats — omitting individual measurements, analyses, and per-group data. For a middle ground, keep full mode and cap the two lists that carry the bulk with outcomeLimit / adverseEventLimit.',
      ),
    outcomeLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Optional cap on the number of outcome measures returned per study, taken in the order ClinicalTrials.gov publishes them. Omit for no cap (every measure). Applies to full mode only — summary mode is already condensed. Each surviving measure keeps its complete groups/classes/measurements/analyses tree. Upstream total preserved in filtersApplied.totalOutcomes only when the cap trims the list.',
      ),
    adverseEventLimit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Optional cap on the number of serious and other adverse events returned per study, applied to each list separately in upstream order. Omit for no cap (every event). Applies to full mode only — summary mode already ranks the top 20 by participants affected. Event groups are never capped. Upstream totals preserved in filtersApplied.totalSeriousEvents / totalOtherEvents only when the cap trims a list.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            nctId: z.string().describe('NCT identifier.'),
            title: z.string().describe('Study title.'),
            hasResults: z.boolean().describe('Whether study has posted results.'),
            outcomes: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe(
                'Outcome measures with per-group statistics. Summary mode (compact): type, title, timeFrame, paramType, unitOfMeasure, group/class counts, plus topStats (per-group measurements) and topAnalysis (statisticalMethod, pValue, paramType/Value, ciPctValue/Lower/Upper, nonInferiorityType, groupIds — lifted from analyses[0]) when present. Full mode (default): adds raw groups, classes, categories, measurements, and analyses arrays.',
              ),
            adverseEvents: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Adverse events. Summary mode: timeFrame, groupCount, seriousEventCount, otherEventCount, plus topEvents — the most frequent events ranked by participants affected, aggregated across arms (term, organSystem, kind, numAffected, numAtRisk). Full mode: adds eventGroups, seriousEvents, otherEvents with per-event term and per-group affected/at-risk stats.',
              ),
            participantFlow: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Participant flow milestones and drop-outs. Summary mode: groupCount, periodCount. Full mode: adds groups and periods with per-period milestones, achievements, and dropWithdraws.',
              ),
            baseline: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Baseline characteristics. Summary mode: groupCount, measureCount, and measures (title, paramType, unitOfMeasure). Full mode: adds groups and measures with per-group classes/categories/measurements.',
              ),
            moreInfo: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Results metadata from moreInfoModule. Summary mode: limitationsAndCaveats, certainAgreement flags (piSponsorEmployee, restrictiveAgreement, restrictionType), and pointOfContact. Full mode: adds certainAgreement.otherDetails.',
              ),
            filtersApplied: z
              .object({
                totalOutcomes: z
                  .number()
                  .int()
                  .optional()
                  .describe('Upstream outcome measure count before outcomeLimit trimmed the list.'),
                outcomeLimit: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Echo of the outcomeLimit input — present only when the cap trimmed the list.',
                  ),
                totalSeriousEvents: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Upstream serious adverse event count before adverseEventLimit trimmed the list.',
                  ),
                totalOtherEvents: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Upstream other adverse event count before adverseEventLimit trimmed the list.',
                  ),
                adverseEventLimit: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Echo of the adverseEventLimit input — present only when the cap trimmed a list.',
                  ),
              })
              .optional()
              .describe(
                'What a cap trimmed on this study — present only when a cap actually reduced a list. Absent means the payload is the complete upstream set for the requested sections.',
              ),
          })
          .describe('Extracted results for one study.'),
      )
      .describe('Results per study.'),
    studiesWithoutResults: z
      .array(z.string())
      .optional()
      .describe('NCT IDs that do not have results data.'),
    fetchErrors: z
      .array(
        z
          .object({
            nctId: z.string().describe('NCT ID.'),
            error: z.string().describe('Error message.'),
          })
          .describe('A single fetch error.'),
      )
      .optional()
      .describe('Studies that could not be fetched.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when a cap trimmed a list on at least one study; absent when nothing was trimmed, matching filtersApplied one level down. Which study and which list is named in that study’s filtersApplied.',
      ),
  }),

  async handler(input, ctx) {
    const nctIds = toArray(input.nctIds);
    const requestedSections = input.sections
      ? Array.isArray(input.sections)
        ? input.sections
        : [input.sections]
      : undefined;
    // An empty list is a supplied blank, not omission, and each arm answers it
    // with a different silent wrong answer: an empty `nctIds` runs the per-ID
    // loop zero times and reports `{ results: [] }` as a success, while `[]` is
    // truthy so a length-blind sections ternary takes the explicit-sections
    // branch with nothing in it and returns a study stripped of every results
    // module. Judged here rather than at the schema — a schema-only rejection
    // runs before the handler and surfaces as a bare -32602 with no reason and
    // no recovery hint.
    const blankParam = firstBlankListParam({ nctIds, sections: requestedSections });
    if (blankParam) {
      throw ctx.fail('blank_value', blankValueMessage(blankParam), {
        param: blankParam,
        ...ctx.recoveryFor('blank_value'),
      });
    }
    const sections: Section[] = requestedSections ?? [...VALID_SECTIONS];

    interface StudyResult {
      adverseEvents?: Record<string, unknown>;
      baseline?: Record<string, unknown>;
      filtersApplied?: ResultsFilterMeta;
      hasResults: boolean;
      moreInfo?: Record<string, unknown>;
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
      // A rate limit is a whole-request failure, not a per-ID one: every
      // fallback request would hit the same limit, so answering a 429 with up
      // to 20 more sequential requests is the worst possible response. Surface
      // the declared retryable contract instead and issue nothing further.
      // Keyed on the service's typed `data.reason` — the tag it sets once its
      // retry budget is spent against a 429 — never on upstream message text.
      if (err instanceof McpError && err.data?.reason === 'rate_limited') {
        throw ctx.fail('rate_limited', err.message, ctx.recoveryFor('rate_limited'), {
          cause: err,
        });
      }
      // A cancelled caller is the same shape of whole-request failure: the
      // fallback would walk every ID only to record the same cancellation
      // against each one, returning a result nobody is waiting for. Rethrow so
      // the baseline RequestCancelled code reaches the transport intact.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.RequestCancelled) throw err;
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
      // Caps are applied here, once, ahead of both the returned value and
      // format() — a format()-side cap would leave structuredContent carrying
      // rows the text channel never shows (#46).
      const meta: ResultsFilterMeta = {};
      for (const section of sections) {
        const moduleKey = SECTION_MAP[section];
        const data = rs[moduleKey];
        if (data) {
          if (section === 'outcomes') {
            const measures = (data.outcomeMeasures as Record<string, unknown>[] | undefined) ?? [];
            entry.outcomes = input.summary
              ? measures.map(summarizeOutcome)
              : capOutcomes(measures, input.outcomeLimit, meta);
          } else if (input.summary) {
            if (section === 'adverseEvents') entry.adverseEvents = summarizeAdverseEvents(data);
            else if (section === 'participantFlow')
              entry.participantFlow = summarizeParticipantFlow(data);
            else if (section === 'baseline') entry.baseline = summarizeBaseline(data);
            else if (section === 'moreInfo') entry.moreInfo = summarizeMoreInfo(data);
          } else if (section === 'adverseEvents') {
            entry.adverseEvents = capAdverseEvents(data, input.adverseEventLimit, meta);
          } else {
            entry[section] = data;
          }
        }
      }
      if (Object.keys(meta).length > 0) entry.filtersApplied = meta;
      results.push(entry);
    }

    // Batch-level roll-up of the per-study filtersApplied, which is only ever
    // set when a cap actually trimmed. A caller reading one boolean learns
    // whether any list is short before walking every study to find out.
    const truncated = results.some((r) => r.filtersApplied !== undefined);

    ctx.log.info('Results extracted', {
      resultCount: results.length,
      withoutResults: studiesWithoutResults.length,
      errors: fetchErrors.length,
      truncated,
    });

    return {
      results,
      ...(studiesWithoutResults.length > 0 ? { studiesWithoutResults } : {}),
      ...(fetchErrors.length > 0 ? { fetchErrors } : {}),
      ...(truncated ? { truncated } : {}),
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

      if (r.filtersApplied) formatCaps(r.filtersApplied, lines);
      if (r.outcomes?.length) formatOutcomes(r.outcomes, lines);
      if (r.adverseEvents) formatAdverseEvents(r.adverseEvents, lines);
      if (r.participantFlow) formatParticipantFlow(r.participantFlow, lines);
      if (r.baseline) formatBaseline(r.baseline, lines);
      if (r.moreInfo) formatMoreInfo(r.moreInfo, lines);
      lines.push('');
    }

    if (result.studiesWithoutResults?.length)
      lines.push(`Without results: ${result.studiesWithoutResults.join(', ')}`);
    if (result.fetchErrors?.length)
      lines.push(
        `Fetch errors: ${result.fetchErrors.map((e) => `${e.nctId}: ${e.error}`).join(', ')}`,
      );
    // The per-study cap lines above say which list was trimmed; this says a trim
    // happened at all, so a reader who skimmed the studies still sees it.
    if (result.truncated)
      lines.push('Truncated: a cap trimmed at least one list. See filtersApplied per study.');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
