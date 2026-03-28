/**
 * @fileoverview Search clinical trial studies from ClinicalTrials.gov.
 * @module mcp-server/tools/definitions/search-studies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { buildAdvancedFilter, toArray } from '../utils/query-helpers.js';

const { maxPageSize } = getServerConfig();

export const searchStudies = tool('clinicaltrials_search_studies', {
  description: `Search for clinical trial studies from ClinicalTrials.gov. Supports full-text and field-specific queries, status/phase/geographic filters, pagination, sorting, and field selection. Use the fields parameter to reduce payload size — full study records are ~70KB each.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    query: z.string().optional().describe('General full-text search across all fields.'),
    conditionQuery: z
      .string()
      .optional()
      .describe(
        'Condition/disease-specific search. E.g., "Type 2 Diabetes", "non-small cell lung cancer".',
      ),
    interventionQuery: z
      .string()
      .optional()
      .describe(
        'Intervention/treatment search. E.g., "pembrolizumab", "cognitive behavioral therapy".',
      ),
    locationQuery: z
      .string()
      .optional()
      .describe('Location search — city, state, country, or facility name.'),
    sponsorQuery: z.string().optional().describe('Sponsor/collaborator name search.'),
    titleQuery: z.string().optional().describe('Search within study titles and acronyms only.'),
    outcomeQuery: z.string().optional().describe('Search within outcome measure fields.'),
    statusFilter: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        `Filter by study status. Values: RECRUITING, COMPLETED, ACTIVE_NOT_RECRUITING, NOT_YET_RECRUITING, ENROLLING_BY_INVITATION, SUSPENDED, TERMINATED, WITHDRAWN, UNKNOWN, WITHHELD, NO_LONGER_AVAILABLE, AVAILABLE, APPROVED_FOR_MARKETING, TEMPORARILY_NOT_AVAILABLE.`,
      ),
    phaseFilter: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('Filter by trial phase. Values: EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4, NA.'),
    advancedFilter: z
      .string()
      .optional()
      .describe(
        `Advanced filter using AREA[] Essie syntax. E.g., "AREA[StudyType]INTERVENTIONAL", "AREA[EnrollmentCount]RANGE[100, 1000]". Combine with AND/OR/NOT and parentheses.`,
      ),
    geoFilter: z
      .string()
      .optional()
      .describe(
        `Geographic proximity filter. Format: distance(lat,lon,radius). E.g., "distance(47.6062,-122.3321,50mi)" for studies within 50 miles of Seattle.`,
      ),
    nctIds: z
      .union([
        z.string().regex(/^NCT\d{8}$/, 'NCT IDs must match format NCTxxxxxxxx (8 digits).'),
        z.array(
          z.string().regex(/^NCT\d{8}$/, 'NCT IDs must match format NCTxxxxxxxx (8 digits).'),
        ),
      ])
      .optional()
      .describe('Filter to specific NCT IDs for batch lookups.'),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        `Fields to return (PascalCase piece names). Strongly recommended to reduce payload. Common: NCTId, BriefTitle, OverallStatus, Phase, LeadSponsorName, Condition, InterventionName, BriefSummary, EnrollmentCount, StartDate.`,
      ),
    sort: z
      .string()
      .optional()
      .describe(
        `Sort order. Format: FieldName:asc or FieldName:desc. E.g., "LastUpdatePostDate:desc", "EnrollmentCount:desc". Max 2 fields comma-separated.`,
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
  }),

  output: z.object({
    studies: z.array(z.record(z.string(), z.unknown())).describe('Matching studies.'),
    totalCount: z
      .number()
      .optional()
      .describe('Total matching studies (first page only when countTotal=true).'),
    nextPageToken: z.string().optional().describe('Token for the next page. Absent on last page.'),
    searchCriteria: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Echo of query/filter criteria used. Present when results are empty.'),
    noMatchHints: z
      .array(z.string())
      .optional()
      .describe('Suggestions for broadening the search when no results are found.'),
  }),

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
      },
      ctx,
    );
    ctx.log.info('Search completed', {
      count: result.studies.length,
      totalCount: result.totalCount,
    });

    // Echo search criteria on empty results so callers know what produced zero matches
    if (result.studies.length === 0) {
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

      const hints: string[] = [];
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
      if (hasQuery && hasFilter)
        hints.push('Try removing filters to broaden results, or use broader search terms.');
      else if (hasQuery) hints.push('Try broader or alternative search terms.');
      else if (hasFilter) hints.push('Try removing or broadening filters.');
      if (input.statusFilter)
        hints.push(
          'Remove statusFilter to include studies in all statuses (completed, terminated, etc.).',
        );
      if (input.phaseFilter) hints.push('Remove phaseFilter to include all trial phases.');

      return { ...result, searchCriteria: criteria, noMatchHints: hints };
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const count = result.studies.length;
    if (count === 0) {
      lines.push('No studies matched the search criteria.');
      if (result.searchCriteria && Object.keys(result.searchCriteria).length > 0) {
        const parts = Object.entries(result.searchCriteria).map(([k, v]) => `${k}=${v}`);
        lines.push(`Criteria: ${parts.join(', ')}`);
      }
      if (result.noMatchHints?.length) {
        for (const hint of result.noMatchHints) lines.push(hint);
      } else {
        lines.push('Try broader search terms or fewer filters.');
      }
      return [{ type: 'text', text: lines.join('\n') }];
    }
    if (result.totalCount !== undefined) {
      lines.push(`Found ${count} studies (${result.totalCount} total matching)`);
    } else {
      lines.push(`Found ${count} studies`);
    }
    for (const study of result.studies) {
      const s = study as RawStudyShape;
      const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
      const title = s.protocolSection?.identificationModule?.briefTitle ?? 'Untitled';
      const status = s.protocolSection?.statusModule?.overallStatus ?? '';
      const phases = s.protocolSection?.designModule?.phases;
      const enrollment = s.protocolSection?.designModule?.enrollmentInfo?.count;
      const sponsor = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name;
      const conditions = s.protocolSection?.conditionsModule?.conditions;

      const meta: string[] = [];
      if (phases?.length) meta.push(phases.join('/'));
      if (enrollment != null) meta.push(`N=${enrollment}`);
      if (sponsor) meta.push(sponsor);
      if (conditions?.length) meta.push(conditions.slice(0, 2).join(', '));

      const statusStr = status ? ` [${status}]` : '';
      const metaStr = meta.length ? `\n  ${meta.join(' | ')}` : '';
      lines.push(`- **${nctId}**: ${title}${statusStr}${metaStr}`);
    }
    if (result.nextPageToken)
      lines.push('\n(More results available — use nextPageToken to paginate)');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
