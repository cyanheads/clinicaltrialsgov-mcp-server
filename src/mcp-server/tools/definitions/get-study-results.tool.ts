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

/**
 * Which section each offset bounds. An offset is only meaningful when the call
 * returns that section's list in full mode, so this is also the table the
 * handler validates against before fetching anything.
 */
const OFFSET_SECTIONS = [
  ['outcomeOffset', 'outcomes'],
  ['seriousEventOffset', 'adverseEvents'],
  ['otherEventOffset', 'adverseEvents'],
] as const satisfies ReadonlyArray<readonly [string, Section]>;

/** Map section names to resultsSection module keys. */
const SECTION_MAP: Record<Section, string> = {
  outcomes: 'outcomeMeasuresModule',
  adverseEvents: 'adverseEventsModule',
  participantFlow: 'participantFlowModule',
  baseline: 'baselineCharacteristicsModule',
  moreInfo: 'moreInfoModule',
};

/** Coerce a raw value to a trimmed display string, or undefined when absent/blank. */
function text(value: unknown): string | undefined {
  if (value == null) return;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

/** Render a section's group count, singular for one group. */
function groupsLabel(count: unknown): string {
  return `${count} ${count === 1 ? 'group' : 'groups'}`;
}

/** The measurement fields both channels render, common to the raw and condensed shapes. */
interface MeasurementFields {
  comment?: unknown;
  lowerLimit?: unknown;
  spread?: unknown;
  upperLimit?: unknown;
  value?: unknown;
}

/** One per-group cell of the summary projection, carried verbatim from upstream. */
interface TopStat extends MeasurementFields {
  comment?: string;
  group: string;
  lowerLimit?: string;
  spread?: string;
  upperLimit?: string;
  value: string;
}

/** Which cell of the classes tree the summary kept, and what it stands in for. */
interface TopStatsProvenance {
  categoryTitle?: string;
  classTitle?: string;
  note?: string;
  omittedCategories?: number;
  omittedClasses?: number;
}

/**
 * Label the projected cell and disclose the siblings it displaced. Upstream
 * titles a class or category exactly when more than one exists, so the title
 * that disambiguates a retained value is the one the projection would otherwise
 * discard. Returns undefined when the measure holds a single untitled cell —
 * nothing to name and nothing omitted.
 */
function topStatsProvenance(
  firstClass: Record<string, unknown>,
  categories: Array<Record<string, unknown>>,
  classCount: number,
): TopStatsProvenance | undefined {
  const omittedClasses = classCount - 1;
  const omittedCategories = categories.length - 1;
  const classTitle = text(firstClass.title);
  const categoryTitle = text(categories[0]?.title);
  const dropped = [
    omittedClasses > 0 ? `${omittedClasses} of ${classCount} classes` : '',
    omittedCategories > 0
      ? `${omittedCategories} of ${categories.length} categories in the shown class`
      : '',
  ].filter(Boolean);
  const from: TopStatsProvenance = {
    ...(classTitle ? { classTitle } : {}),
    ...(categoryTitle ? { categoryTitle } : {}),
    ...(omittedClasses > 0 ? { omittedClasses } : {}),
    ...(omittedCategories > 0 ? { omittedCategories } : {}),
    ...(dropped.length
      ? {
          note: `Summary projects one cell: ${dropped.join(' and ')} omitted. Re-run with summary: false for the complete measurement tree.`,
        }
      : {}),
  };
  return Object.keys(from).length > 0 ? from : undefined;
}

/**
 * Project one cell of a measure's classes tree into summary mode's `topStats`.
 * Reads only `classes[0].categories[0]` — deliberate condensation (#63), and the
 * reason full mode walks the whole tree in format() instead of calling this. The
 * cell travels with the titles that say what it measures and a count of the
 * siblings it displaced, so a retained value is never read as the whole measure.
 *
 * Values are carried verbatim. The caller's `!= null` guard drops genuinely-empty
 * cells; the `NA`/`NR` sentinels stay, as does the record's own `comment` — the
 * only place ClinicalTrials.gov says why a value is missing. Nothing is inferred
 * from `paramType`: an `NA` median is "not reached" only when the comment says so.
 */
function extractTopStats(
  o: Record<string, unknown>,
): { from?: TopStatsProvenance; stats: TopStat[] } | undefined {
  const groups = o.groups as Array<Record<string, unknown>> | undefined;
  const classes = o.classes as Array<Record<string, unknown>> | undefined;
  if (!groups?.length || !classes?.length) return;
  const firstClass = classes[0] as Record<string, unknown>;
  const categories = firstClass.categories as Array<Record<string, unknown>> | undefined;
  if (!categories?.length) return;
  const measurements = categories[0]?.measurements as Array<Record<string, unknown>> | undefined;
  if (!measurements?.length) return;
  const groupMap = new Map(groups.map((g) => [g.id as string, (g.title ?? g.id) as string]));
  const stats: TopStat[] = measurements
    .filter((m) => m.value != null)
    .map((m) => {
      const comment = text(m.comment);
      return {
        group: groupMap.get(m.groupId as string) ?? (m.groupId as string),
        value: String(m.value),
        ...(m.spread != null ? { spread: String(m.spread) } : {}),
        ...(m.lowerLimit != null ? { lowerLimit: String(m.lowerLimit) } : {}),
        ...(m.upperLimit != null ? { upperLimit: String(m.upperLimit) } : {}),
        ...(comment ? { comment } : {}),
      };
    });
  if (!stats.length) return;
  const from = topStatsProvenance(firstClass, categories, classes.length);
  return { stats, ...(from ? { from } : {}) };
}

/**
 * Condense a measure's denominators — what each retained value is counted out
 * of. Keyed by group title rather than group id: summary mode carries no group
 * roster, so an id would reach the caller with nothing to resolve it against.
 */
function condenseDenoms(
  denoms: unknown,
  groups: Array<Record<string, unknown>>,
): Array<{ counts: Array<{ group: string; value: string }>; units?: string }> | undefined {
  const rows = denoms as Array<Record<string, unknown>> | undefined;
  if (!rows?.length) return;
  const titles = new Map(groups.map((g) => [g.id as string, (g.title ?? g.id) as string]));
  const condensed = rows
    .map((d) => {
      const units = text(d.units);
      return {
        ...(units ? { units } : {}),
        counts: ((d.counts as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((c) => c.value != null)
          .map((c) => ({
            group: titles.get(c.groupId as string) ?? (c.groupId as string),
            value: String(c.value),
          })),
      };
    })
    .filter((d) => d.counts.length > 0);
  return condensed.length ? condensed : undefined;
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
  const projection = extractTopStats(o);
  const topAnalysis = extractTopAnalysis(o);
  const denoms = condenseDenoms(o.denoms, groups ?? []);
  const dispersionType = text(o.dispersionType);
  return {
    type: o.type,
    title: o.title,
    timeFrame: o.timeFrame,
    paramType: o.paramType,
    // Measure-level qualifier: without it a retained `spread` renders as a bare
    // `±` value with nothing saying whether it is an SD, an SE, or a CI half-width.
    ...(dispersionType ? { dispersionType } : {}),
    unitOfMeasure: o.unitOfMeasure,
    reportingStatus: o.reportingStatus,
    groupCount: groups?.length,
    classCount: classes?.length,
    ...(denoms ? { denoms } : {}),
    ...(projection ? { topStats: projection.stats } : {}),
    ...(projection?.from ? { topStatsFrom: projection.from } : {}),
    ...(topAnalysis ? { topAnalysis } : {}),
  };
}

const TOP_EVENTS_LIMIT = 20;

/** One event group's affected/at-risk count for a single adverse event. */
interface EventGroupStat {
  groupId: string;
  numAffected: number;
  numAtRisk: number;
}

interface TopAdverseEvent {
  byGroup: EventGroupStat[];
  kind: 'serious' | 'other';
  organSystem: string;
  term: string;
}

/**
 * An adverse event's per-group stats, one row per event group, keyed by group
 * id against the `eventGroups` roster the summary carries — the full-mode
 * convention (#128). Twenty events each repeating every group's title cost more
 * than the counts they label, and two titles can differ only in a trailing
 * "(Second Course)". Never summed: event groups can overlap (a crossover or
 * second-course group re-counts participants of its parent arm), so a
 * cross-group total is not a participant count and its ratio is not an incidence.
 */
function eventStatsByGroup(ev: Record<string, unknown>): EventGroupStat[] {
  const stats = (ev.stats as Array<Record<string, unknown>> | undefined) ?? [];
  return stats.map((s) => ({
    groupId: s.groupId as string,
    numAffected: Number(s.numAffected) || 0,
    numAtRisk: Number(s.numAtRisk) || 0,
  }));
}

/** The most participants one event group reports for an event — its ranking key. */
function peakAffected(ev: TopAdverseEvent): number {
  return Math.max(0, ...ev.byGroup.map((s) => s.numAffected));
}

/**
 * Rank the most frequent adverse events across serious and other events for
 * summary mode — "which AEs and how common, per arm" in a few KB rather than the
 * full ~450KB nested structure. Ranked by the largest single group's count, a
 * figure upstream actually reports, so which events make the cut never depends
 * on a sum that can double-count. The sort is stable: ties keep serious events
 * first, then upstream order.
 */
function topAdverseEvents(ae: Record<string, unknown>): TopAdverseEvent[] {
  const collect = (events: unknown, kind: 'serious' | 'other'): TopAdverseEvent[] =>
    Array.isArray(events)
      ? (events as Array<Record<string, unknown>>).map((ev) => ({
          term: (ev.term as string) ?? 'Unspecified',
          organSystem: (ev.organSystem as string) ?? '',
          kind,
          byGroup: eventStatsByGroup(ev),
        }))
      : [];
  return [...collect(ae.seriousEvents, 'serious'), ...collect(ae.otherEvents, 'other')]
    .sort((a, b) => peakAffected(b) - peakAffected(a))
    .slice(0, TOP_EVENTS_LIMIT);
}

/**
 * Condense the adverse events module to counts, the event group roster the
 * top-events rows are keyed against (id and title only), and a ranked
 * top-events view.
 */
function summarizeAdverseEvents(ae: Record<string, unknown>) {
  const groups = ae.eventGroups as Array<Record<string, unknown>> | undefined;
  const topEvents = topAdverseEvents(ae);
  return {
    timeFrame: ae.timeFrame,
    groupCount: Array.isArray(groups) ? groups.length : undefined,
    seriousEventCount: Array.isArray(ae.seriousEvents) ? ae.seriousEvents.length : undefined,
    otherEventCount: Array.isArray(ae.otherEvents) ? ae.otherEvents.length : undefined,
    ...(groups?.length
      ? {
          eventGroups: groups.map((g) => {
            const title = text(g.title);
            return { id: g.id as string, ...(title ? { title } : {}) };
          }),
        }
      : {}),
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

/** What the caller-requested bounds actually trimmed on one study's results. */
interface ResultsFilterMeta {
  adverseEventLimit?: number | undefined;
  nextOtherEventOffset?: number | undefined;
  nextOutcomeOffset?: number | undefined;
  nextSeriousEventOffset?: number | undefined;
  otherEventOffset?: number | undefined;
  outcomeLimit?: number | undefined;
  outcomeOffset?: number | undefined;
  seriousEventOffset?: number | undefined;
  totalOtherEvents?: number | undefined;
  totalOutcomes?: number | undefined;
  totalSeriousEvents?: number | undefined;
}

/** One list's caller-supplied bounds — where to start, and how many to take. */
interface ListBound {
  limit?: number | undefined;
  offset?: number | undefined;
}

/** A windowed list plus what the window left out, or `items` alone when it left out nothing. */
interface ListWindow<T> {
  items: T[];
  /** Echo of the applied limit — set only when the limit is what cut the tail. */
  limit?: number;
  /** Where the next page starts — set only when items remain past the window. */
  next?: number;
  /** Echo of the applied offset — set only when it skipped a prefix. */
  offset?: number;
  /** Upstream length — set whenever the window trimmed either end. */
  total?: number;
}

/**
 * Slice one upstream list to the caller's offset/limit window and report what
 * the window left out.
 *
 * A window that starts at zero and reaches the end trimmed nothing, so it
 * returns the list alone and the caller discloses no filter — echoing a bound
 * that removed nothing reports a filter that was never applied (#80). An offset
 * past the end is not an error: the window is empty and `total` says why.
 *
 * `next` is the resume point and exists only when the limit cut the tail, which
 * is the only way items can remain past the window.
 */
function windowList<T>(items: T[], { offset, limit }: ListBound): ListWindow<T> {
  const applied = offset ?? 0;
  const start = Math.min(applied, items.length);
  const end = limit == null ? items.length : Math.min(start + limit, items.length);
  if (start === 0 && end === items.length) return { items };
  const cutTail = limit != null && end < items.length;
  return {
    items: items.slice(start, end),
    total: items.length,
    ...(applied > 0 ? { offset: applied } : {}),
    ...(cutTail ? { limit, next: end } : {}),
  };
}

/**
 * Window a study's outcome measure list. The bound drops whole measures — every
 * surviving one keeps its complete groups/classes/measurements/analyses tree.
 */
function capOutcomes(
  measures: Record<string, unknown>[],
  bound: ListBound,
  meta: ResultsFilterMeta,
): Record<string, unknown>[] {
  const w = windowList(measures, bound);
  if (w.total != null) {
    meta.totalOutcomes = w.total;
    if (w.limit != null) meta.outcomeLimit = w.limit;
    if (w.offset != null) meta.outcomeOffset = w.offset;
    if (w.next != null) meta.nextOutcomeOffset = w.next;
  }
  return w.items;
}

/**
 * Window the serious and other event lists of a full-mode adverse-events
 * module. The two walk on their own axes — their lengths are uncorrelated, so
 * one position across both would overrun the shorter list and under-serve the
 * longer — while the event group roster is never bounded, since every per-event
 * stat joins back to it by id and a page without its roster carries unjoinable
 * numbers.
 */
function capAdverseEvents(
  ae: Record<string, unknown>,
  serious: ListBound,
  other: ListBound,
  meta: ResultsFilterMeta,
): Record<string, unknown> {
  const next = { ...ae };
  let trimmed = false;

  const seriousEvents = ae.seriousEvents as unknown[] | undefined;
  if (seriousEvents) {
    const w = windowList(seriousEvents, serious);
    if (w.total != null) {
      next.seriousEvents = w.items;
      meta.totalSeriousEvents = w.total;
      if (w.limit != null) meta.adverseEventLimit = w.limit;
      if (w.offset != null) meta.seriousEventOffset = w.offset;
      if (w.next != null) meta.nextSeriousEventOffset = w.next;
      trimmed = true;
    }
  }

  const otherEvents = ae.otherEvents as unknown[] | undefined;
  if (otherEvents) {
    const w = windowList(otherEvents, other);
    if (w.total != null) {
      next.otherEvents = w.items;
      meta.totalOtherEvents = w.total;
      if (w.limit != null) meta.adverseEventLimit = w.limit;
      if (w.offset != null) meta.otherEventOffset = w.offset;
      if (w.next != null) meta.nextOtherEventOffset = w.next;
      trimmed = true;
    }
  }

  return trimmed ? next : ae;
}

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

type RO = Record<string, unknown>;

/**
 * Key a rendered cell by the group id it belongs to. The id is the join key
 * upstream publishes and `renderGroupRoster` prints untruncated once per
 * section; a shortened title is not a substitute, since two arms can differ
 * only past the truncation point and then render the same label (#128).
 */
function cellGroup(groupId: unknown): string {
  return text(groupId) ?? 'Group';
}

/**
 * Render one cell's value, spread, limit range, and comment — '' when it carries
 * none of them. Shared by the full-mode tree walk and the summary projection so
 * both channels present the same cell the same way by construction.
 */
function cellValue(m: MeasurementFields): string {
  const comment = text(m.comment);
  return [
    m.value != null ? String(m.value) : '',
    m.spread != null ? `±${m.spread}` : '',
    m.lowerLimit != null || m.upperLimit != null
      ? `[${m.lowerLimit ?? ''} to ${m.upperLimit ?? ''}]`
      : '',
    comment ? `(${comment})` : '',
  ]
    .filter(Boolean)
    .join(' ');
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

/**
 * Render denominator rows — the units and the per-group counts they apply to.
 * Full-mode rows key on the upstream `groupId`; summary-mode rows arrive from
 * `condenseDenoms` already resolved to a `group` title, since that channel
 * publishes no roster to resolve an id against.
 */
function renderDenoms(denoms: unknown, indent: string, lines: string[]): void {
  for (const d of (denoms as Array<RO> | undefined) ?? []) {
    const counts = ((d.counts as Array<RO> | undefined) ?? [])
      .map((c) => {
        const g = text(c.group) ?? cellGroup(c.groupId);
        return c.value != null ? `${g}: ${c.value}` : g;
      })
      .join(', ');
    const units = text(d.units);
    const label = units ? `Denominator (${units})` : 'Denominator';
    lines.push(`${indent}${[label, counts].filter(Boolean).join(': ')}`);
  }
}

/**
 * Render per-group participant counts as `GroupId: subjects / units (comment)`
 * segments — the shape both participant-flow milestone achievements and
 * drop/withdraw reasons publish.
 */
function countsByGroup(rows: unknown): string {
  return ((rows as Array<RO> | undefined) ?? [])
    .map((r) => {
      const comment = text(r.comment);
      const count = [r.numSubjects, r.numUnits].filter((v) => v != null).join(' / ') || '?';
      return `${cellGroup(r.groupId)}: ${count}${comment ? ` (${comment})` : ''}`;
    })
    .join(', ');
}

/** Render one measurement cell, keyed by its group id — undefined when empty. */
function measurementCell(m: RO): string | undefined {
  const value = cellValue(m);
  return value ? `${cellGroup(m.groupId)}: ${value}` : undefined;
}

/**
 * Walk a measure's complete classes → categories → measurements tree. Every
 * level carries data — class and category titles, per-class denominators, and
 * the per-group cells — so reading only the first entry drops the rest of the
 * measure from the text channel.
 */
function renderClasses(classes: unknown, indent: string, lines: string[]): void {
  for (const cls of (classes as Array<RO> | undefined) ?? []) {
    const clsTitle = text(cls.title);
    if (clsTitle) lines.push(`${indent}_${clsTitle}_`);
    renderDenoms(cls.denoms, `${indent}  `, lines);
    for (const cat of (cls.categories as Array<RO> | undefined) ?? []) {
      const catTitle = text(cat.title);
      const cells = ((cat.measurements as Array<RO> | undefined) ?? [])
        .map(measurementCell)
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
 * Render one bounded list's disclosure: how much of it came back, where the
 * window started, and where the next one starts. Every number `filtersApplied`
 * carries is named here — a continuation value the text channel never prints is
 * reachable in one channel and not the other, which is the parity defect the
 * bounds exist inside of, not beside.
 */
function formatBound({
  noun,
  offsetParam,
  total,
  limit,
  offset,
  next,
}: {
  limit?: number | undefined;
  next?: number | undefined;
  noun: string;
  offset?: number | undefined;
  offsetParam: string;
  total?: number | undefined;
}): string {
  // No upstream total means this list was never trimmed — nothing to disclose.
  if (total == null) return '';
  const head = limit != null ? `${limit} of ${total} ${noun}` : `${total} ${noun} upstream`;
  const tail = [
    offset != null ? `from ${offsetParam} ${offset}` : '',
    next != null ? `next ${offsetParam} ${next}` : '',
  ].filter(Boolean);
  return tail.length ? `${head} (${tail.join('; ')})` : head;
}

/**
 * Disclose a trim on the text channel. Both channels carry the same bounded
 * data, so the counts and the route back to the omitted rows have to reach the
 * caller who only reads `content[]`.
 *
 * `adverseEventLimit` covers both event lists, so which list it actually cut is
 * read off that list's own `next` offset — items remain past a window only when
 * a limit cut the tail.
 */
function formatCaps(meta: ResultsFilterMeta, lines: string[]) {
  const aeLimit = meta.adverseEventLimit;
  const parts = [
    formatBound({
      noun: 'outcome measures',
      offsetParam: 'outcomeOffset',
      total: meta.totalOutcomes,
      limit: meta.outcomeLimit,
      offset: meta.outcomeOffset,
      next: meta.nextOutcomeOffset,
    }),
    formatBound({
      noun: 'serious adverse events',
      offsetParam: 'seriousEventOffset',
      total: meta.totalSeriousEvents,
      limit: meta.nextSeriousEventOffset != null ? aeLimit : undefined,
      offset: meta.seriousEventOffset,
      next: meta.nextSeriousEventOffset,
    }),
    formatBound({
      noun: 'other adverse events',
      offsetParam: 'otherEventOffset',
      total: meta.totalOtherEvents,
      limit: meta.nextOtherEventOffset != null ? aeLimit : undefined,
      offset: meta.otherEventOffset,
      next: meta.nextOtherEventOffset,
    }),
  ].filter(Boolean);
  if (!parts.length) return;
  lines.push(
    `_Bounded: returning ${parts.join('; ')}. Re-run clinicaltrials_get_study_results with the named next offset to continue a list, raise outcomeLimit / adverseEventLimit, or narrow sections, to reach the omitted rows._`,
  );
}

function formatOutcomes(outcomes: RO[], lines: string[]) {
  lines.push(`\n### Outcomes (${outcomes.length} measures)`);
  for (const o of outcomes) {
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
      groupCount != null ? groupsLabel(groupCount) : '',
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

    // The arm roster and measure-level denominators. Summary mode publishes no
    // roster, so the first call is a full-mode no-op there; denominators reach
    // both modes and `renderDenoms` reads whichever group key each shape carries.
    renderGroupRoster(o, '  ', lines);
    renderDenoms(o.denoms, '  ', lines);

    // Summary mode: the one class/category cell the handler projected, labelled
    // with the titles it came from and what it stands in for.
    const topStats = o.topStats as TopStat[] | undefined;
    if (topStats?.length) {
      const from = o.topStatsFrom as TopStatsProvenance | undefined;
      const label = [from?.classTitle, from?.categoryTitle].filter(Boolean).join(' — ');
      const cells = topStats.map((s) => `${s.group}: ${cellValue(s)}`);
      lines.push(`  ${label ? `${label}: ` : ''}${cells.join(' | ')}`);
      if (from?.note) lines.push(`  _${from.note}_`);
    }

    // Full mode: the complete classes → categories → measurements tree.
    renderClasses(o.classes, '  ', lines);

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
  const timeFrame = text(ae.timeFrame);
  if (timeFrame) lines.push(`Assessment period: ${timeFrame}`);
  const description = text(ae.description);
  if (description) lines.push(description);
  const threshold = text(ae.frequencyThreshold);
  if (threshold) lines.push(`Frequency threshold: ${threshold}%`);
  const mortality = text(ae.allCauseMortalityComment);
  if (mortality) lines.push(`All-cause mortality: ${mortality}`);

  // Summary shape — counts, the id/title roster, and the ranked top-events view
  // keyed against it; no raw event arrays. Detected on the summarizer's own
  // keys, so a full module that happens to publish no events still takes the
  // full path and renders its event groups.
  if ('groupCount' in ae || 'seriousEventCount' in ae || 'otherEventCount' in ae) {
    const parts = [
      ae.groupCount != null ? groupsLabel(ae.groupCount) : '',
      ae.seriousEventCount != null ? `${ae.seriousEventCount} serious events` : '',
      ae.otherEventCount != null ? `${ae.otherEventCount} other events` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(' | '));
    renderGroupRoster(ae, '', lines, 'Event Groups');
    const topEvents = ae.topEvents as Array<RO> | undefined;
    if (topEvents?.length) {
      lines.push(
        `\n**Most frequent events** (top ${topEvents.length} by participants affected in any one event group; affected/at risk per group)`,
      );
      for (const ev of topEvents) {
        const sys = ev.organSystem ? ` _(${ev.organSystem as string})_` : '';
        const cells = ((ev.byGroup as Array<RO> | undefined) ?? [])
          .map((s) => `${cellGroup(s.groupId)}: ${s.numAffected}/${s.numAtRisk}`)
          .join(' | ');
        lines.push(`- ${ev.term}${sys} [${ev.kind}]${cells ? ` — ${cells}` : ''}`);
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
          const events_ = s.numEvents != null ? ` (${s.numEvents} events)` : '';
          return `${cellGroup(s.groupId)}: ${s.numAffected}/${s.numAtRisk}${events_}`;
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

  // Summary shape — only counts.
  if ('groupCount' in pf || 'periodCount' in pf) {
    const parts = [
      pf.groupCount != null ? groupsLabel(pf.groupCount) : '',
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
      const achStr = countsByGroup(ms.achievements);
      const msComment = text(ms.comment);
      lines.push(
        `- **${text(ms.type) ?? 'Milestone'}**: ${achStr}${msComment ? ` — ${msComment}` : ''}`,
      );
    }

    for (const d of (period.dropWithdraws as Array<RO> | undefined) ?? []) {
      const rStr = countsByGroup(d.reasons);
      const dComment = text(d.comment);
      lines.push(
        `- Drop/Withdraw — ${text(d.type) ?? 'reason'}: ${rStr}${dComment ? ` — ${dComment}` : ''}`,
      );
    }
  }
}

function formatBaseline(bl: RO, lines: string[]) {
  lines.push('\n### Baseline Characteristics');
  const measures = bl.measures as Array<RO> | undefined;

  // Summary shape — counts plus each measure's identifying metadata.
  if ('groupCount' in bl || 'measureCount' in bl) {
    const parts = [
      bl.groupCount != null ? groupsLabel(bl.groupCount) : '',
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
  renderDenoms(bl.denoms, '', lines);

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
    renderDenoms(m.denoms, '  ', lines);
    renderClasses(m.classes, '  ', lines);
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
  description: `Fetch clinical trial results data from ClinicalTrials.gov for completed studies — outcome measures with statistics, adverse events, participant flow, baseline characteristics, and results metadata (limitations & caveats, certain-agreement disclosure restrictions, results point of contact). Only available for studies where hasResults is true. Use clinicaltrials_search_studies first to find studies with results. A results-rich record can exceed 500KB per study in full mode — bound it with summary=true, narrower sections, or the outcomeLimit / adverseEventLimit caps. A bounded list is resumable: outcomeOffset / seriousEventOffset / otherEventOffset start the next window, and each study's filtersApplied reports what was trimmed and the next offset for every list left short. A previous (alias) NCT ID resolves to its canonical study, named in canonicalNctId.`,
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
      reason: 'offset_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An offset was supplied for a list this call does not return — summary mode returns a condensed projection rather than a bounded window, or the sections filter excludes the offset’s own section.',
      recovery:
        'Drop the offset, or re-run with summary: false and the offset’s own section named in sections — outcomes for outcomeOffset, adverseEvents for seriousEventOffset and otherEventOffset.',
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
        'One or more NCT IDs (max 20) — an empty list is rejected, and a repeated ID collapses to one results entry in first-occurrence order. E.g., "NCT12345678" or ["NCT12345678", "NCT87654321"]. Use summary=true for large batches to avoid large payloads.',
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
        'Return condensed summaries instead of full data. Full mode renders every row and field on both output channels, so a large results set can exceed 500KB per study; summary mode typically cuts that to a few KB, scaling with the measure count rather than to a fixed ceiling. An outcome summary keeps the title, type, timeframe, paramType, dispersionType, unit, group/class counts, per-group denominators, one statistical analysis, and a top-line projection of a single class/category cell — labelled with the class and category titles it came from and a count of the siblings it omits. The measurements outside that cell and the remaining analyses are dropped; re-run with summary=false to reach them. For a middle ground, keep full mode and cap the two lists that carry the bulk with outcomeLimit / adverseEventLimit.',
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
        'Optional cap on the number of serious and other adverse events returned per study, applied to each list separately in upstream order. Omit for no cap (every event). Applies to full mode only — summary mode already ranks the top 20 by the most participants affected in any one event group. Event groups are never capped. Upstream totals preserved in filtersApplied.totalSeriousEvents / totalOtherEvents only when the cap trims a list.',
      ),
    outcomeOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Optional index of the first outcome measure to return, in the order ClinicalTrials.gov publishes them. Omit or 0 to start at the first. Pair with outcomeLimit to page a long list: each response reports filtersApplied.nextOutcomeOffset for the study, and the list is exhausted when that field is absent. Applied to every study in the call. An offset at or past the end returns an empty list with filtersApplied.totalOutcomes stating the upstream length, not an error. Rejected with summary: true or when sections excludes outcomes.',
      ),
    seriousEventOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Optional index of the first serious adverse event to return, in upstream order. Omit or 0 to start at the first. Pages independently of otherEventOffset — the two lists have uncorrelated lengths — and pairs with adverseEventLimit, which bounds each list separately. Continue from filtersApplied.nextSeriousEventOffset until that field is absent. Applied to every study in the call. Rejected with summary: true or when sections excludes adverseEvents.',
      ),
    otherEventOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Optional index of the first other (non-serious) adverse event to return, in upstream order. Omit or 0 to start at the first. Pages independently of seriousEventOffset and pairs with adverseEventLimit. Continue from filtersApplied.nextOtherEventOffset until that field is absent. Applied to every study in the call. Rejected with summary: true or when sections excludes adverseEvents.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            nctId: z
              .string()
              .describe(
                'The NCT identifier as requested, trimmed and uppercased. When it is a previous (alias) ID, ClinicalTrials.gov answers with the canonical record and canonicalNctId names it.',
              ),
            canonicalNctId: z
              .string()
              .optional()
              .describe(
                'The canonical NCT identifier of the study that answered — present only when the requested nctId is a previous (alias) ID pointing at a different record. Absent means nctId is already canonical. Requesting an alias and its own canonical ID together returns one entry per requested ID, both carrying the same study.',
              ),
            title: z.string().describe('Study title.'),
            hasResults: z.boolean().describe('Whether study has posted results.'),
            outcomes: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe(
                'Outcome measures with per-group statistics. Summary mode (compact): type, title, timeFrame, paramType, dispersionType, unitOfMeasure, group/class counts, denoms (per-group denominators keyed by group title), topStats (the per-group cells of one class/category — each carrying the upstream value verbatim, including an NA/NR sentinel, plus spread, lowerLimit/upperLimit, and the record’s own comment when present), topStatsFrom (classTitle / categoryTitle naming where that cell came from, with omittedClasses / omittedCategories counts and a note pointing at summary=false when siblings were dropped), and topAnalysis (statisticalMethod, pValue, paramType/Value, ciPctValue/Lower/Upper, nonInferiorityType, groupIds — lifted from analyses[0]) when present. Full mode (default): adds raw groups, classes, categories, measurements, and analyses arrays.',
              ),
            adverseEvents: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Adverse events. Summary mode: timeFrame, groupCount, seriousEventCount, otherEventCount, eventGroups (id and title of each event group), plus topEvents — up to 20 events ranked by the most participants affected in any one event group, each with term, organSystem, kind, and byGroup (one { groupId, numAffected, numAtRisk } row per event group; resolve groupId against eventGroups). Counts are never pooled across groups: groups can overlap (a crossover or second-course group re-counts participants of its parent arm), so compare arms row by row. Full mode: eventGroups with descriptions and per-group totals, plus seriousEvents and otherEvents with per-event term and per-group affected/at-risk stats.',
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
                  .describe('Upstream outcome measure count, before the bounds trimmed the list.'),
                outcomeLimit: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Echo of the outcomeLimit input — present only when the cap cut measures off the end of the window.',
                  ),
                outcomeOffset: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Echo of the outcomeOffset input — present only when it skipped measures before the window.',
                  ),
                nextOutcomeOffset: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'The outcomeOffset to request next for this study — present only when measures remain past the window. Absent means this study’s outcome list is exhausted.',
                  ),
                totalSeriousEvents: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Upstream serious adverse event count, before the bounds trimmed the list.',
                  ),
                totalOtherEvents: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Upstream other adverse event count, before the bounds trimmed the list.',
                  ),
                adverseEventLimit: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Echo of the adverseEventLimit input — present only when the cap cut events off the end of a window. Which list it cut is named by that list’s own next offset.',
                  ),
                seriousEventOffset: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Echo of the seriousEventOffset input — present only when it skipped events before the window.',
                  ),
                nextSeriousEventOffset: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'The seriousEventOffset to request next for this study — present only when serious events remain past the window. Absent means this study’s serious event list is exhausted.',
                  ),
                otherEventOffset: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'Echo of the otherEventOffset input — present only when it skipped events before the window.',
                  ),
                nextOtherEventOffset: z
                  .number()
                  .int()
                  .optional()
                  .describe(
                    'The otherEventOffset to request next for this study — present only when other events remain past the window. Absent means this study’s other event list is exhausted.',
                  ),
              })
              .optional()
              .describe(
                'What the outcomeLimit / adverseEventLimit caps and the outcomeOffset / seriousEventOffset / otherEventOffset offsets trimmed on this study, plus the next offset for each list left short. Present only when a bound actually reduced a list — a window that started at zero and reached the end trimmed nothing. Absent means the payload is the complete upstream set for the requested sections. Offsets apply uniformly to every study in the call, so continuation is reported per study: each exhausts its lists at a different index.',
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
        'True when a bound — a cap or an offset — trimmed a list on at least one study; absent when nothing was trimmed, matching filtersApplied one level down. Which study, which list, and where to resume is named in that study’s filtersApplied.',
      ),
  }),

  async handler(input, ctx) {
    // Deduplicated on the requested ID, first occurrence winning: the same ID
    // twice named one study once, and answering it with two byte-identical
    // entries spent the caller's payload on a copy. An alias and its own
    // canonical ID stay distinct here — they are different requested IDs, and
    // each gets its own entry even though upstream returns one record.
    const nctIds = [...new Set(toArray(input.nctIds))];
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

    // An offset the call cannot honor is answered, not swallowed. Summary mode
    // condenses every measure rather than returning a window, and a section the
    // caller filtered out has no list to start from — either way the caller
    // asked to resume a list this call never bounds, and a silently ignored
    // offset returns page one again while the caller believes they advanced.
    for (const [param, section] of OFFSET_SECTIONS) {
      if (input[param] == null) continue;
      if (input.summary) {
        throw ctx.fail(
          'offset_not_applicable',
          `Parameter '${param}' has no effect in summary mode, which returns a condensed projection of the whole '${section}' section rather than a bounded window of it.`,
          { param, ...ctx.recoveryFor('offset_not_applicable') },
        );
      }
      if (!sections.includes(section)) {
        throw ctx.fail(
          'offset_not_applicable',
          `Parameter '${param}' bounds the '${section}' section, which this call's sections filter excludes.`,
          { param, section, ...ctx.recoveryFor('offset_not_applicable') },
        );
      }
    }

    interface StudyResult {
      adverseEvents?: Record<string, unknown>;
      baseline?: Record<string, unknown>;
      canonicalNctId?: string;
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
      // The batch endpoint rejects the whole request when a single ID is
      // malformed — an ordinary nonexistent-but-well-formed ID is answered 200
      // with the record simply absent, so only a format rejection reaches here.
      // Fall back to per-ID fetches so valid IDs still succeed and only failing
      // IDs land in fetchErrors. Sequential to honor the service's rate limit
      // (~1 req/sec).
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

    // Keyed by every ID a study answers to, not just its canonical one. A
    // previous (alias) NCT ID resolves upstream to the canonical record on both
    // fetch paths — the batch endpoint rewrites it silently, the single-study
    // endpoint 301-redirects — so a canonical-only map misses every requested
    // alias and reports an existing study as not found (#127).
    const studyMap = new Map<string, RawStudyShape>();
    for (const study of fetched) {
      const ids = study.protocolSection?.identificationModule;
      for (const id of [ids?.nctId, ...(ids?.nctIdAliases ?? [])]) {
        if (id != null) studyMap.set(id, study);
      }
    }

    for (const nctId of nctIds) {
      if (erroredIds.has(nctId)) continue;
      const study = studyMap.get(nctId);
      if (!study) {
        fetchErrors.push({ nctId, error: 'Study not found' });
        continue;
      }

      const title = study.protocolSection?.identificationModule?.briefTitle ?? 'Unknown';
      const hasResults = study.hasResults === true;
      // Disclosed only when the two differ — the caller followed an older
      // citation and needs to know which study actually answered.
      const canonical = study.protocolSection?.identificationModule?.nctId;
      const canonicalNctId = canonical != null && canonical !== nctId ? canonical : undefined;
      const identity = { nctId, ...(canonicalNctId ? { canonicalNctId } : {}), title };

      if (!hasResults) {
        studiesWithoutResults.push(nctId);
        results.push({ ...identity, hasResults: false });
        continue;
      }

      const rs = study.resultsSection ?? {};
      const entry: StudyResult = { ...identity, hasResults: true };
      // Bounds are applied here, once, ahead of both the returned value and
      // format() — a format()-side bound would leave structuredContent carrying
      // rows the text channel never shows (#46). The same offsets apply to every
      // study in the call; each study's own continuation lives in its
      // filtersApplied, since each exhausts its lists at a different index.
      const meta: ResultsFilterMeta = {};
      for (const section of sections) {
        const moduleKey = SECTION_MAP[section];
        const data = rs[moduleKey];
        if (data) {
          if (section === 'outcomes') {
            const measures = (data.outcomeMeasures as Record<string, unknown>[] | undefined) ?? [];
            entry.outcomes = input.summary
              ? measures.map(summarizeOutcome)
              : capOutcomes(
                  measures,
                  { limit: input.outcomeLimit, offset: input.outcomeOffset },
                  meta,
                );
          } else if (input.summary) {
            if (section === 'adverseEvents') entry.adverseEvents = summarizeAdverseEvents(data);
            else if (section === 'participantFlow')
              entry.participantFlow = summarizeParticipantFlow(data);
            else if (section === 'baseline') entry.baseline = summarizeBaseline(data);
            else if (section === 'moreInfo') entry.moreInfo = summarizeMoreInfo(data);
          } else if (section === 'adverseEvents') {
            entry.adverseEvents = capAdverseEvents(
              data,
              { limit: input.adverseEventLimit, offset: input.seriousEventOffset },
              { limit: input.adverseEventLimit, offset: input.otherEventOffset },
              meta,
            );
          } else {
            entry[section] = data;
          }
        }
      }
      if (Object.keys(meta).length > 0) entry.filtersApplied = meta;
      results.push(entry);
    }

    // Batch-level roll-up of the per-study filtersApplied, which is only ever
    // set when a bound actually trimmed. A caller reading one boolean learns
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
      // The requested ID leads — it is what the caller asked for — with the
      // canonical ID named beside it when following an alias landed elsewhere.
      const id = r.canonicalNctId ? `${r.nctId} (canonical ${r.canonicalNctId})` : r.nctId;
      lines.push(`## ${id}: ${r.title}`);
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
    // The per-study bound lines above say which list was trimmed; this says a
    // trim happened at all, so a reader who skimmed the studies still sees it.
    if (result.truncated)
      lines.push('Truncated: a bound trimmed at least one list. See filtersApplied per study.');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
