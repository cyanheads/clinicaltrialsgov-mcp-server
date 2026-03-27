/**
 * @fileoverview Search clinical trial studies from ClinicalTrials.gov.
 * @module mcp-server/tools/definitions/search-studies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { buildAdvancedFilter, toArray } from '../utils/query-helpers.js';

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
      .union([z.string(), z.array(z.string())])
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
    pageSize: z.number().int().min(1).max(1000).default(10).describe('Results per page, 1–1000.'),
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
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const count = result.studies.length;
    if (result.totalCount !== undefined) {
      lines.push(`Found ${count} studies (${result.totalCount} total matching)`);
    } else {
      lines.push(`Found ${count} studies`);
    }
    for (const study of result.studies.slice(0, 5)) {
      const s = study as RawStudyShape;
      const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
      const title = s.protocolSection?.identificationModule?.briefTitle ?? 'Untitled';
      const status = s.protocolSection?.statusModule?.overallStatus ?? '';
      lines.push(`- ${nctId}: ${title}${status ? ` [${status}]` : ''}`);
    }
    if (count > 5) lines.push(`... and ${count - 5} more`);
    if (result.nextPageToken)
      lines.push('(More results available — use nextPageToken to paginate)');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
