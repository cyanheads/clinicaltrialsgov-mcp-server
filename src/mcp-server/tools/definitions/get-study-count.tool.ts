/**
 * @fileoverview Lightweight study count tool — no data fetched, just the total.
 * @module mcp-server/tools/definitions/get-study-count.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import { buildAdvancedFilter, toArray } from '../utils/query-helpers.js';

export const getStudyCount = tool('clinicaltrials_get_study_count', {
  description: `Get total study count matching a query without fetching study data. Fast and lightweight. Use for quick statistics or to build breakdowns by calling multiple times with different filters (e.g., count by phase, count by status, count recruiting vs completed for a condition).`,
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
    sponsorQuery: z.string().optional().describe('Sponsor/collaborator name search.'),
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
        'Advanced filter using AREA[] Essie syntax. E.g., "AREA[StudyType]INTERVENTIONAL", "AREA[EnrollmentCount]RANGE[100, 1000]". Combine with AND/OR/NOT and parentheses.',
      ),
  }),

  output: z.object({
    totalCount: z.number().describe('Total studies matching the query/filters.'),
    searchCriteria: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Echo of query/filter criteria used.'),
    noMatchHints: z
      .array(z.string())
      .optional()
      .describe('Suggestions when no studies match (totalCount is 0).'),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const result = await service.searchStudies(
      {
        queryTerm: input.query,
        queryCond: input.conditionQuery,
        queryIntr: input.interventionQuery,
        querySpons: input.sponsorQuery,
        filterOverallStatus: toArray(input.statusFilter),
        filterAdvanced: buildAdvancedFilter(toArray(input.phaseFilter), input.advancedFilter),
        countTotal: true,
        pageSize: 0,
      },
      ctx,
    );
    const totalCount = result.totalCount ?? 0;
    ctx.log.info('Count completed', { totalCount });

    const criteria: Record<string, unknown> = {};
    if (input.query) criteria.query = input.query;
    if (input.conditionQuery) criteria.conditionQuery = input.conditionQuery;
    if (input.interventionQuery) criteria.interventionQuery = input.interventionQuery;
    if (input.sponsorQuery) criteria.sponsorQuery = input.sponsorQuery;
    if (input.statusFilter) criteria.statusFilter = input.statusFilter;
    if (input.phaseFilter) criteria.phaseFilter = input.phaseFilter;
    if (input.advancedFilter) criteria.advancedFilter = input.advancedFilter;

    return {
      totalCount,
      ...(Object.keys(criteria).length > 0 ? { searchCriteria: criteria } : {}),
      ...(totalCount === 0 ? { noMatchHints: ['Try broader search terms or fewer filters.'] } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [`${result.totalCount} studies match the specified criteria.`];
    if (result.searchCriteria && Object.keys(result.searchCriteria).length > 0) {
      const parts = Object.entries(result.searchCriteria).map(([k, v]) => `${k}=${v}`);
      lines.push(`Criteria: ${parts.join(', ')}`);
    }
    for (const hint of result.noMatchHints ?? []) lines.push(hint);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
