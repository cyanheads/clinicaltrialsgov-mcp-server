/**
 * @fileoverview Search clinical trial studies from ClinicalTrials.gov.
 * @module mcp-server/tools/definitions/search-studies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape, StudyLocation } from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../utils/_schemas.js';
import { formatRemainingStudyFields } from '../utils/format-helpers.js';
import {
  haversineMi,
  type LocationWithDistance,
  parseGeoFilterCenter,
} from '../utils/geo-helpers.js';
import { buildAdvancedFilter, toArray } from '../utils/query-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

const { maxPageSize } = getServerConfig();

/** Dot-notation prefixes already rendered by the search formatter. */
const SEARCH_RENDERED = new Set([
  'protocolSection.identificationModule.nctId',
  'protocolSection.identificationModule.briefTitle',
  'protocolSection.statusModule.overallStatus',
  'protocolSection.designModule.phases',
  'protocolSection.designModule.enrollmentInfo',
  'protocolSection.sponsorCollaboratorsModule.leadSponsor',
  'protocolSection.conditionsModule.conditions',
  'protocolSection.contactsLocationsModule.locations',
]);

/**
 * When a geoFilter is active, re-rank each study's `locations[]` by proximity to
 * the filter center so the matched site leads instead of the upstream-order first
 * entry — mirroring get_study_record's nearLocation → distanceMi annotation.
 * Sites with a geoPoint are sorted nearest-first and annotated with distanceMi;
 * sites without coordinates are preserved at the end (re-rank only, never filter).
 * Mutates each study's locations array in place.
 */
function reRankLocationsByProximity(
  studies: RawStudyShape[],
  center: { lat: number; lon: number },
): void {
  for (const study of studies) {
    const locationsModule = study.protocolSection?.contactsLocationsModule;
    const locations = locationsModule?.locations;
    if (!locationsModule || !locations?.length) continue;
    const withGeo = locations
      .filter(
        (l): l is StudyLocation & { geoPoint: { lat: number; lon: number } } => l.geoPoint != null,
      )
      .map((l) => ({ ...l, distanceMi: haversineMi(center, l.geoPoint) }))
      .sort((a, b) => a.distanceMi - b.distanceMi);
    const withoutGeo = locations.filter((l) => l.geoPoint == null);
    locationsModule.locations = [...withGeo, ...withoutGeo];
  }
}

/** The lead/nearest site of a study, bounded to the fields the formatter renders. */
interface NearestSite {
  city?: string;
  country?: string;
  distanceMi?: number;
  facility?: string;
  state?: string;
}

/**
 * The headline fields shared by the compact index projection and the
 * requested-fields renderer. Loosely optional (`| undefined`) so both a clean
 * projection and inline record reads (which yield explicit `undefined`) satisfy
 * it under exactOptionalPropertyTypes.
 */
interface StudyHeaderFields {
  briefTitle?: string | undefined;
  conditions?: string[] | undefined;
  enrollmentCount?: number | undefined;
  leadSponsor?: string | undefined;
  nctId?: string | undefined;
  overallStatus?: string | undefined;
  phases?: string[] | undefined;
}

/**
 * Compact per-study index projection returned when the caller passes no explicit
 * `fields`. It carries exactly what `format()` renders — no more — so a client
 * reading only `structuredContent` and one reading only `content[]` see the same
 * data. The full ~70KB record is intentionally NOT carried: search is an index.
 * Callers who need specific leaves at full fidelity pass `fields`; callers who
 * need one complete record use clinicaltrials_get_study_record.
 */
interface StudyIndexEntry extends StudyHeaderFields {
  /** Bounded locations summary — the lead/nearest site plus the total site count. */
  locations?: { nearest?: NearestSite; total: number };
}

/** Pick the rendered subset of the lead/nearest site for the index projection. */
function pickNearest(loc: LocationWithDistance): NearestSite {
  const site: NearestSite = {};
  if (loc.facility != null) site.facility = loc.facility;
  if (loc.city != null) site.city = loc.city;
  if (loc.state != null) site.state = loc.state;
  if (loc.country != null) site.country = loc.country;
  if (loc.distanceMi != null) site.distanceMi = loc.distanceMi;
  return site;
}

/**
 * Project a full study record to the compact index entry the formatter renders.
 * Only keys with a value are set, mirroring the get-study `applyFilters()` /
 * `summarizeResults()` structural-projection style. With an active geoFilter the
 * handler has already re-ranked `locations[]`, so `locations[0]` is the nearest
 * matched site and its `distanceMi` rides along.
 */
function projectStudyIndex(study: RawStudyShape): Record<string, unknown> {
  const ps = study.protocolSection;
  const id = ps?.identificationModule;
  const design = ps?.designModule;
  const entry: StudyIndexEntry = {};
  if (id?.nctId != null) entry.nctId = id.nctId;
  if (id?.briefTitle != null) entry.briefTitle = id.briefTitle;
  const status = ps?.statusModule?.overallStatus;
  if (status != null) entry.overallStatus = status;
  if (design?.phases?.length) entry.phases = design.phases;
  const enrollment = design?.enrollmentInfo?.count;
  if (enrollment != null) entry.enrollmentCount = enrollment;
  const sponsor = ps?.sponsorCollaboratorsModule?.leadSponsor?.name;
  if (sponsor != null) entry.leadSponsor = sponsor;
  const conditions = ps?.conditionsModule?.conditions;
  if (conditions?.length) entry.conditions = conditions;

  const locations = ps?.contactsLocationsModule?.locations as LocationWithDistance[] | undefined;
  if (locations?.length) {
    const lead = locations[0];
    const nearest = lead ? pickNearest(lead) : undefined;
    entry.locations = {
      total: locations.length,
      ...(nearest && Object.keys(nearest).length > 0 ? { nearest } : {}),
    };
  }
  // Fresh object literal — assignable to the opaque Record<string, unknown> the
  // output schema declares (mirrors get-study's `{ ...study }`).
  return { ...entry };
}

/** Render the shared `- **NCT**: title [status]` headline + meta line. */
function renderStudyHeaderLine(e: StudyHeaderFields): string {
  const nctId = e.nctId ?? 'Unknown';
  const titleStr = e.briefTitle ? `: ${e.briefTitle}` : '';
  const statusStr = e.overallStatus ? ` [${e.overallStatus}]` : '';
  const meta: string[] = [];
  if (e.phases?.length) meta.push(e.phases.join('/'));
  if (e.enrollmentCount != null) meta.push(`N=${e.enrollmentCount}`);
  if (e.leadSponsor) meta.push(e.leadSponsor);
  if (e.conditions?.length) meta.push(e.conditions.join(', '));
  const metaStr = meta.length ? `\n  ${meta.join(' | ')}` : '';
  return `- **${nctId}**${titleStr}${statusStr}${metaStr}`;
}

/** Render one compact index entry (the default, no-`fields` search projection). */
function renderIndexEntry(entry: StudyIndexEntry): string[] {
  const lines: string[] = [renderStudyHeaderLine(entry)];

  // Surface the study's site — the headline carries no location. With an active
  // geoFilter the projection's nearest site is annotated with distanceMi: lead
  // with it. Without one, show the lead registered site. Either way the total
  // site count discloses how many sites the full record holds.
  const near = entry.locations?.nearest;
  if (near) {
    const place = [near.facility, near.city, near.state, near.country].filter(Boolean).join(', ');
    if (place) {
      const total = entry.locations?.total ?? 0;
      if (near.distanceMi != null) {
        const totalStr = total > 1 ? ` of ${total} sites` : '';
        lines.push(
          `  Nearest site: ${place} (${near.distanceMi.toFixed(1)} mi from geoFilter center${totalStr})`,
        );
      } else {
        const totalStr = total > 1 ? ` (1 of ${total} sites)` : '';
        lines.push(`  Site: ${place}${totalStr}`);
      }
    }
  }
  return lines;
}

/**
 * Render every site in a requested-`fields` study. The field-dump fallback dedups
 * object-array leaves by label (so it would collapse `locations[]` to the lead
 * site) and SEARCH_RENDERED suppresses the `locations` subtree from it — a
 * dedicated loop is the only way sites 2..N reach content[]. Carries every typed
 * StudyLocation leaf (place, status, distance, geoPoint) so any requested
 * location field has channel parity. Mirrors get-study's Locations loop.
 */
function renderSiteLines(locations: LocationWithDistance[]): string[] {
  const lines = [`  Locations (${locations.length}):`];
  for (const loc of locations) {
    const place = [loc.facility, loc.city, loc.state, loc.country].filter(Boolean).join(', ');
    const statusNote = loc.status ? ` [${loc.status}]` : '';
    const distNote = loc.distanceMi != null ? ` (${loc.distanceMi.toFixed(1)} mi)` : '';
    const geoNote = loc.geoPoint ? ` @${loc.geoPoint.lat},${loc.geoPoint.lon}` : '';
    lines.push(`    - ${place || '(unnamed site)'}${statusNote}${distNote}${geoNote}`);
  }
  return lines;
}

/**
 * Render a study when the caller passed explicit `fields` — the record is the
 * upstream projection (just the requested leaves), carried at full fidelity in
 * structuredContent. Renders the standard index line, every requested site
 * distinctly, then the remaining requested leaves via the field dump with the
 * truncation cap lifted, so content[] mirrors the record leaf-for-leaf.
 */
function renderRequestedFieldsStudy(study: Record<string, unknown>): string[] {
  const s = study as RawStudyShape;
  const ps = s.protocolSection;
  const lines: string[] = [
    renderStudyHeaderLine({
      nctId: ps?.identificationModule?.nctId,
      briefTitle: ps?.identificationModule?.briefTitle,
      overallStatus: ps?.statusModule?.overallStatus,
      phases: ps?.designModule?.phases,
      enrollmentCount: ps?.designModule?.enrollmentInfo?.count,
      leadSponsor: ps?.sponsorCollaboratorsModule?.leadSponsor?.name,
      conditions: ps?.conditionsModule?.conditions,
    }),
  ];

  const locations = ps?.contactsLocationsModule?.locations as LocationWithDistance[] | undefined;
  if (locations?.length) lines.push(...renderSiteLines(locations));

  // The caller opted into payload control, so render every remaining requested
  // leaf at full length — silently dropping or clipping any of them is the wrong
  // default. Lift both caps: maxLines so no leaf is omitted, maxValueLen so a long
  // primitive (e.g. a 543-char BriefSummary) reaches content[] intact, matching
  // structuredContent (#89).
  lines.push(
    ...formatRemainingStudyFields(study, SEARCH_RENDERED, {
      maxLines: Number.POSITIVE_INFINITY,
      maxValueLen: Number.POSITIVE_INFINITY,
    }),
  );
  return lines;
}

export const searchStudies = tool('clinicaltrials_search_studies', {
  description: `Search for clinical trial studies from ClinicalTrials.gov. Supports full-text and field-specific queries, status/phase/geographic filters, pagination, sorting, and field selection. Returns a compact per-study index by default; pass the fields parameter to get specific leaves at full fidelity — full study records are ~70KB each.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'ids_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more NCT IDs in the nctIds filter are not present at ClinicalTrials.gov.',
      recovery: RECOVERY_HINTS.ids_not_found,
    },
    {
      reason: 'field_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A field name in the fields parameter or AREA[] expression is invalid (often a module name instead of a piece name).',
      recovery: RECOVERY_HINTS.field_invalid,
    },
    {
      reason: 'enum_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'statusFilter or phaseFilter contains a value ClinicalTrials.gov does not accept.',
      recovery: RECOVERY_HINTS.enum_invalid,
    },
    {
      reason: 'query_parse_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A free-text query or advancedFilter expression uses syntax the upstream Essie parser rejects — typically `[ ]` (AREA[]-reserved) or an unmatched `(` / `)` in a query/conditionQuery/etc. value.',
      recovery: RECOVERY_HINTS.query_parse_error,
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
    query: z
      .string()
      .optional()
      .describe(
        'General free-text search across all fields. Plain words plus AND, OR, NOT. `[ ]` are reserved (advancedFilter AREA[] only); `( )` group sub-expressions and work when matched; `,` acts as AND. For field-scoped searches, use the dedicated *Query parameters (conditionQuery, interventionQuery, etc.) or advancedFilter with AREA[FieldName]value.',
      ),
    conditionQuery: z
      .string()
      .optional()
      .describe(
        'Condition/disease-specific search. E.g., "Type 2 Diabetes", "non-small cell lung cancer". Plain words plus AND/OR/NOT. `[ ]` are reserved; `( )` group sub-expressions when matched; `,` acts as AND.',
      ),
    interventionQuery: z
      .string()
      .optional()
      .describe(
        'Intervention/treatment search. E.g., "pembrolizumab", "cognitive behavioral therapy". Plain words plus AND/OR/NOT. `[ ]` are reserved; `( )` group sub-expressions when matched; `,` acts as AND.',
      ),
    locationQuery: z
      .string()
      .optional()
      .describe(
        'Location search — city, state, country, or facility name. Plain words plus AND/OR/NOT. `[ ]` are reserved; `( )` group sub-expressions when matched; `,` acts as AND.',
      ),
    sponsorQuery: z
      .string()
      .optional()
      .describe(
        'Sponsor/collaborator name search. Plain words plus AND/OR/NOT. `[ ]` are reserved; `( )` group sub-expressions when matched; `,` acts as AND.',
      ),
    titleQuery: z
      .string()
      .optional()
      .describe(
        'Search within study titles and acronyms only. Plain words plus AND/OR/NOT. `[ ]` are reserved; `( )` group sub-expressions when matched; `,` acts as AND.',
      ),
    outcomeQuery: z
      .string()
      .optional()
      .describe(
        'Search within outcome measure fields. Plain words plus AND/OR/NOT. `[ ]` are reserved; `( )` group sub-expressions when matched; `,` acts as AND.',
      ),
    statusFilter: z
      .union([
        z.string().describe('A single status value.'),
        z.array(z.string()).describe('Multiple status values (OR).'),
      ])
      .optional()
      .describe(
        `Filter by study status. Values: RECRUITING, COMPLETED, ACTIVE_NOT_RECRUITING, NOT_YET_RECRUITING, ENROLLING_BY_INVITATION, SUSPENDED, TERMINATED, WITHDRAWN, UNKNOWN, WITHHELD, NO_LONGER_AVAILABLE, AVAILABLE, APPROVED_FOR_MARKETING, TEMPORARILY_NOT_AVAILABLE.`,
      ),
    phaseFilter: z
      .union([
        z.string().describe('A single phase value.'),
        z.array(z.string()).describe('Multiple phase values (OR).'),
      ])
      .optional()
      .describe('Filter by trial phase. Values: EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4, NA.'),
    advancedFilter: z
      .string()
      .optional()
      .describe(
        `Advanced filter using AREA[FieldName]value syntax. Examples: "AREA[StudyType]INTERVENTIONAL", "AREA[EnrollmentCount]RANGE[100, 1000]", "AREA[Phase]PHASE2 AND AREA[StudyType]INTERVENTIONAL", "(AREA[Phase]PHASE3 OR AREA[Phase]PHASE4) AND AREA[StudyType]INTERVENTIONAL". AND/OR/NOT join complete AREA[FieldName]value expressions; parentheses group them. Call clinicaltrials_get_field_definitions to find AREA[]-compatible field names.`,
      ),
    geoFilter: z
      .string()
      .optional()
      .describe(
        `Geographic proximity filter. Format: distance(lat,lon,radius). E.g., "distance(47.6062,-122.3321,50mi)" for studies within 50 miles of Seattle. When set, each study's locations are re-sorted by proximity to the center so the nearest matched site leads, annotated with its distance in miles; the full location list is preserved.`,
      ),
    nctIds: z
      .union([
        nctIdSchema.describe('A single NCT ID.'),
        z.array(nctIdSchema).describe('Multiple NCT IDs (OR).'),
      ])
      .optional()
      .describe('Filter to specific NCT IDs for batch lookups.'),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        `PascalCase leaf names to return; strongly recommended since full records are ~70KB. Common leaves: NCTId, BriefTitle, BriefSummary, OverallStatus, Phase, LeadSponsorName, Condition. Call clinicaltrials_get_field_definitions with a concept query (e.g., "adverse events", "eligibility") to find the exact leaf for any concept.`,
      ),
    sort: z
      .string()
      .optional()
      .describe(
        `Sort order. Format: FieldName:asc or FieldName:desc. E.g., "LastUpdatePostDate:desc", "EnrollmentCount:desc". Max 2 fields comma-separated. For "largest trials" queries, pair EnrollmentCount:desc with advancedFilter "AREA[StudyType]INTERVENTIONAL" — the top enrollment counts are observational registry/claims studies enrolling tens of millions. Enrollment counts are sponsor-reported and not validated upstream beyond the unknown-enrollment sentinel exclusion. Use clinicaltrials_get_field_definitions to find sortable field names.`,
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(maxPageSize)
      .default(10)
      .describe(`Results per page, 1–${maxPageSize}.`),
    pageToken: z.string().optional().describe('Pagination cursor from a previous response.'),
    countTotal: z
      .boolean()
      .default(true)
      .describe('Include total study count in response. Only computed on the first page.'),
    includeUnknownEnrollment: z
      .boolean()
      .default(false)
      .describe(
        'Include studies whose EnrollmentCount is the upstream "unknown" sentinel (99999999). Excluded by default — the sentinel pollutes RANGE[N, MAX] queries and EnrollmentCount:desc sorts. Set true for data-quality audits or when targeting unknown-enrollment studies specifically.',
      ),
  }),

  output: z.object({
    studies: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Matching studies. By default each entry is a COMPACT index projection — nctId, briefTitle, overallStatus, phases, enrollmentCount, leadSponsor, conditions, and a bounded locations summary ({ total, nearest }) — mirroring the rendered result, NOT the full ~70KB record. Pass the fields parameter to receive exactly the requested leaves at full fidelity instead (e.g. all locations). Fetch a full single record with clinicaltrials_get_study_record.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe('Total matching studies (first page only when countTotal=true).'),
    nextPageToken: z.string().optional().describe('Token for the next page. Absent on last page.'),
    requestedFields: z
      .array(z.string())
      .optional()
      .describe(
        'Echo of the explicit fields parameter — present only when the caller passed fields. Signals that studies carry the requested leaves at full fidelity (not the default compact index) and that the rendered truncation cap is lifted so all of them appear.',
      ),
  }),

  // Agent-facing context — query echo and empty-result guidance, disjoint from output.
  enrichment: {
    searchCriteria: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Echo of active query/filter criteria applied to this search, including sentinelFilterActive when the default unknown-enrollment exclusion is in effect. Present on every response.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no studies matched — echoes the constraint and suggests how to broaden. Absent on pages with results.',
      ),
  },

  enrichmentTrailer: {
    searchCriteria: {
      render: (criteria) => {
        if (!criteria || Object.keys(criteria).length === 0) return '';
        const parts = Object.entries(criteria).map(([k, v]) =>
          Array.isArray(v) ? `- **${k}:** [${(v as unknown[]).join(', ')}]` : `- **${k}:** ${v}`,
        );
        return `**Search Criteria:**\n${parts.join('\n')}`;
      },
    },
  },

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const result = await service.searchStudies(
      {
        queryTerm: input.query,
        queryCond: input.conditionQuery,
        queryIntr: input.interventionQuery,
        queryLocn: input.locationQuery,
        querySpons: input.sponsorQuery,
        queryTitles: input.titleQuery,
        queryOutc: input.outcomeQuery,
        filterOverallStatus: toArray(input.statusFilter),
        filterGeo: input.geoFilter,
        filterIds: toArray(input.nctIds),
        filterAdvanced: buildAdvancedFilter(toArray(input.phaseFilter), input.advancedFilter),
        fields: input.fields,
        sort: input.sort,
        countTotal: input.countTotal,
        pageSize: input.pageSize,
        pageToken: input.pageToken,
        includeUnknownEnrollment: input.includeUnknownEnrollment,
      },
      ctx,
    );
    ctx.log.info('Search completed', {
      count: result.studies.length,
      totalCount: result.totalCount,
    });

    // With an active geoFilter, lead each study with its matched (nearest) site:
    // upstream returns locations in registration order, so the first entry is
    // often a far-away site and the filter reads as broken. Re-rank only — the
    // full locations[] set is preserved.
    const geoCenter = parseGeoFilterCenter(input.geoFilter);
    if (geoCenter) reRankLocationsByProximity(result.studies as RawStudyShape[], geoCenter);

    // Echo the applied search criteria on every response (not only empty ones)
    // so agents can confirm which filters were actually in effect when a result
    // set is smaller than expected. sentinelFilterActive flags the default
    // unknown-enrollment exclusion, which silently drops EnrollmentCount=99999999
    // studies from RANGE/EnrollmentCount:desc queries.
    const criteria: Record<string, unknown> = {};
    if (input.query) criteria.query = input.query;
    if (input.conditionQuery) criteria.conditionQuery = input.conditionQuery;
    if (input.interventionQuery) criteria.interventionQuery = input.interventionQuery;
    if (input.locationQuery) criteria.locationQuery = input.locationQuery;
    if (input.sponsorQuery) criteria.sponsorQuery = input.sponsorQuery;
    if (input.titleQuery) criteria.titleQuery = input.titleQuery;
    if (input.outcomeQuery) criteria.outcomeQuery = input.outcomeQuery;
    if (input.statusFilter) criteria.statusFilter = input.statusFilter;
    if (input.phaseFilter) criteria.phaseFilter = input.phaseFilter;
    if (input.advancedFilter) criteria.advancedFilter = input.advancedFilter;
    if (input.geoFilter) criteria.geoFilter = input.geoFilter;
    if (input.nctIds) criteria.nctIds = input.nctIds;
    if (!input.includeUnknownEnrollment) criteria.sentinelFilterActive = true;
    if (Object.keys(criteria).length > 0) ctx.enrich({ searchCriteria: criteria });

    // Recovery guidance only when nothing matched.
    if (result.studies.length === 0) {
      const hasQuery =
        input.query ||
        input.conditionQuery ||
        input.interventionQuery ||
        input.titleQuery ||
        input.outcomeQuery ||
        input.sponsorQuery;
      const hasFilter =
        input.statusFilter ||
        input.phaseFilter ||
        input.advancedFilter ||
        input.geoFilter ||
        input.locationQuery;

      const noticeParts: string[] = [];
      if (hasQuery && hasFilter)
        noticeParts.push('Try removing filters to broaden results, or use broader search terms.');
      else if (hasQuery) noticeParts.push('Try broader or alternative search terms.');
      else if (hasFilter) noticeParts.push('Try removing or broadening filters.');
      if (input.statusFilter)
        noticeParts.push(
          'Remove statusFilter to include studies in all statuses (completed, terminated, etc.).',
        );
      if (input.phaseFilter) noticeParts.push('Remove phaseFilter to include all trial phases.');

      if (noticeParts.length > 0) ctx.enrich.notice(noticeParts.join(' '));
    }

    // Bound structuredContent to what format() renders. Without explicit fields,
    // search is an index: project each study to the compact entry (rendered
    // summary + a bounded nearest-site/total-count locations summary) so a
    // content[]-only client and a structuredContent client see the same data,
    // not a full ~70KB record in one channel and a summary in the other. With
    // explicit fields the caller opted into a projection — upstream already
    // trimmed each record to the requested leaves, so those flow through at full
    // fidelity and format() renders all of them.
    const studies: Record<string, unknown>[] = input.fields?.length
      ? result.studies
      : (result.studies as RawStudyShape[]).map(projectStudyIndex);

    return {
      ...result,
      studies,
      ...(input.fields?.length ? { requestedFields: input.fields } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const count = result.studies.length;
    if (count === 0) {
      lines.push('No studies matched the search criteria.');
    } else if (result.totalCount !== undefined) {
      lines.push(`Found ${count} studies (${result.totalCount} total matching)`);
    } else {
      lines.push(`Found ${count} studies`);
    }
    if (result.requestedFields?.length) {
      lines.push(`Requested fields: ${result.requestedFields.join(', ')}`);
    }

    // Two render modes, matching the two structuredContent shapes the handler
    // produces. Default: each study is a compact index entry. Explicit fields:
    // each study is the upstream-trimmed record, rendered leaf-for-leaf.
    const explicitFields = Boolean(result.requestedFields?.length);
    for (const study of result.studies) {
      lines.push(
        ...(explicitFields
          ? renderRequestedFieldsStudy(study as Record<string, unknown>)
          : renderIndexEntry(study as StudyIndexEntry)),
      );
    }

    if (result.nextPageToken) {
      lines.push('\n(More results available — pass pageToken to paginate)');
      lines.push(`nextPageToken: ${result.nextPageToken}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
