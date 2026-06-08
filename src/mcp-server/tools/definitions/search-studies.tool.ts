/**
 * @fileoverview Search clinical trial studies from ClinicalTrials.gov.
 * @module mcp-server/tools/definitions/search-studies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../utils/_schemas.js';
import { formatRemainingStudyFields } from '../utils/format-helpers.js';
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
]);

export const searchStudies = tool('clinicaltrials_search_studies', {
  description: `Search for clinical trial studies from ClinicalTrials.gov. Supports full-text and field-specific queries, status/phase/geographic filters, pagination, sorting, and field selection. Use the fields parameter to reduce payload size — full study records are ~70KB each.`,
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
        `Geographic proximity filter. Format: distance(lat,lon,radius). E.g., "distance(47.6062,-122.3321,50mi)" for studies within 50 miles of Seattle.`,
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
        `Sort order. Format: FieldName:asc or FieldName:desc. E.g., "LastUpdatePostDate:desc", "EnrollmentCount:desc". Max 2 fields comma-separated. Use clinicaltrials_get_field_definitions to find sortable field names.`,
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
        'Matching studies. Each entry is a nested ClinicalTrials.gov study record — top-level keys: protocolSection, derivedSection, hasResults, resultsSection, documentSection. Use clinicaltrials_get_field_definitions to explore the schema.',
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
        'Echo of the explicit fields parameter — present only when the caller passed fields. Lifts the default truncation cap so all requested leaves render in full.',
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

    return {
      ...result,
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
    // Lift the per-study truncation cap when the caller asked for explicit
    // fields — they've already opted into payload control, so silently dropping
    // any of them is the wrong default.
    const overflowOpts = result.requestedFields?.length
      ? { maxLines: Number.POSITIVE_INFINITY }
      : undefined;
    for (const study of result.studies) {
      const s = study as RawStudyShape;
      const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
      const title = s.protocolSection?.identificationModule?.briefTitle;
      const status = s.protocolSection?.statusModule?.overallStatus ?? '';
      const phases = s.protocolSection?.designModule?.phases;
      const enrollment = s.protocolSection?.designModule?.enrollmentInfo?.count;
      const sponsor = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name;
      const conditions = s.protocolSection?.conditionsModule?.conditions;

      const meta: string[] = [];
      if (phases?.length) meta.push(phases.join('/'));
      if (enrollment != null) meta.push(`N=${enrollment}`);
      if (sponsor) meta.push(sponsor);
      if (conditions?.length) meta.push(conditions.join(', '));

      const titleStr = title ? `: ${title}` : '';
      const statusStr = status ? ` [${status}]` : '';
      const metaStr = meta.length ? `\n  ${meta.join(' | ')}` : '';
      lines.push(`- **${nctId}**${titleStr}${statusStr}${metaStr}`);
      lines.push(
        ...formatRemainingStudyFields(
          study as Record<string, unknown>,
          SEARCH_RENDERED,
          overflowOpts,
        ),
      );
    }
    if (result.nextPageToken) {
      lines.push('\n(More results available — pass pageToken to paginate)');
      lines.push(`nextPageToken: ${result.nextPageToken}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
