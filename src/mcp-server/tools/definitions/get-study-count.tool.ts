/**
 * @fileoverview Lightweight study count tool — no data fetched, just the total.
 * @module mcp-server/tools/definitions/get-study-count.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import { buildAdvancedFilter, toArray } from '../utils/query-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

export const getStudyCount = tool('clinicaltrials_get_study_count', {
  description: `Get total clinical trial study count from ClinicalTrials.gov matching a query, without fetching study data. Fast and lightweight. Use for quick statistics or to build breakdowns by calling multiple times with different filters (e.g., count by phase, count by status, count recruiting vs completed for a condition).`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'field_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A field name in the advanced filter or AREA[] expression is invalid (often a module name instead of a piece name).',
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
      when: 'A free-text query or advancedFilter expression uses syntax the upstream Essie parser rejects — typically a reserved character ([, ], (, ), or comma) in a query/conditionQuery/etc. value.',
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
        'General free-text search across all fields. Plain words plus AND, OR, NOT only — reserved chars `[ ] ( ) ,` will fail. For field-scoped searches, use the dedicated *Query parameters (conditionQuery, interventionQuery, etc.) or advancedFilter with AREA[FieldName]value.',
      ),
    conditionQuery: z
      .string()
      .optional()
      .describe(
        'Condition/disease-specific search. E.g., "Type 2 Diabetes", "non-small cell lung cancer". Plain words plus AND/OR/NOT only — reserved chars: [ ] ( ) ,',
      ),
    interventionQuery: z
      .string()
      .optional()
      .describe(
        'Intervention/treatment search. E.g., "pembrolizumab", "cognitive behavioral therapy". Plain words plus AND/OR/NOT only — reserved chars: [ ] ( ) ,',
      ),
    locationQuery: z
      .string()
      .optional()
      .describe(
        'Location search — city, state, country, or facility name. Plain words plus AND/OR/NOT only — reserved chars: [ ] ( ) ,',
      ),
    sponsorQuery: z
      .string()
      .optional()
      .describe(
        'Sponsor/collaborator name search. Plain words plus AND/OR/NOT only — reserved chars: [ ] ( ) ,',
      ),
    titleQuery: z
      .string()
      .optional()
      .describe(
        'Search within study titles and acronyms only. Plain words plus AND/OR/NOT only — reserved chars: [ ] ( ) ,',
      ),
    outcomeQuery: z
      .string()
      .optional()
      .describe(
        'Search within outcome measure fields. Plain words plus AND/OR/NOT only — reserved chars: [ ] ( ) ,',
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
        'Advanced filter using AREA[FieldName]value syntax. Examples: "AREA[StudyType]INTERVENTIONAL", "AREA[EnrollmentCount]RANGE[100, 1000]", "AREA[Phase]PHASE2 AND AREA[StudyType]INTERVENTIONAL", "(AREA[Phase]PHASE3 OR AREA[Phase]PHASE4) AND AREA[StudyType]INTERVENTIONAL". AND/OR/NOT join complete AREA[FieldName]value expressions; parentheses group them. Call clinicaltrials_get_field_definitions to find AREA[]-compatible field names.',
      ),
    includeUnknownEnrollment: z
      .boolean()
      .default(false)
      .describe(
        'Include studies whose EnrollmentCount is the upstream "unknown" sentinel (99999999). Excluded by default — the sentinel pollutes RANGE[N, MAX] queries. Set true for data-quality audits.',
      ),
  }),

  output: z.object({
    totalCount: z.number().describe('Total studies matching the query/filters.'),
  }),

  // Agent-facing context — query echo and empty-result guidance, disjoint from output.
  enrichment: {
    searchCriteria: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Echo of active query/filter criteria applied to this count.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when totalCount is 0 — suggests how to broaden the query or filters.',
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
        filterAdvanced: buildAdvancedFilter(toArray(input.phaseFilter), input.advancedFilter),
        countTotal: true,
        pageSize: 0,
        includeUnknownEnrollment: input.includeUnknownEnrollment,
      },
      ctx,
    );
    const totalCount = result.totalCount ?? 0;
    ctx.log.info('Count completed', { totalCount });

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

    if (Object.keys(criteria).length > 0) ctx.enrich({ searchCriteria: criteria });
    if (totalCount === 0) ctx.enrich.notice('Try broader search terms or fewer filters.');

    return { totalCount };
  },

  format: (result) => [
    { type: 'text', text: `${result.totalCount} studies match the specified criteria.` },
  ],
});
