/**
 * @fileoverview Lightweight study count tool — no data fetched, just the total.
 * @module mcp-server/tools/definitions/get-study-count.tool
 */

import { tool, z } from "@cyanheads/mcp-ts-core";
import { getClinicalTrialsService } from "@/services/clinical-trials/clinical-trials-service.js";

/** Normalize string | string[] to string[]. */
function toArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return;
  return Array.isArray(v) ? v : [v];
}

/** Build AREA[] phase filter and combine with user's advancedFilter. */
function buildAdvancedFilter(
  phaseFilter?: string[],
  advancedFilter?: string,
): string | undefined {
  const parts: string[] = [];
  if (phaseFilter?.length) {
    const expr =
      phaseFilter.length === 1
        ? `AREA[Phase]${phaseFilter[0]}`
        : `(${phaseFilter.map((p) => `AREA[Phase]${p}`).join(" OR ")})`;
    parts.push(expr);
  }
  if (advancedFilter) parts.push(advancedFilter);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

export const getStudyCount = tool("clinicaltrials_get_study_count", {
  description:
    "Get total study count matching a query without fetching study data. Fast and lightweight. " +
    "Use for quick statistics or to build breakdowns by calling multiple times with different filters " +
    "(e.g., count by phase, count by status, count recruiting vs completed for a condition).",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    query: z.string().optional().describe("General full-text search."),
    conditionQuery: z.string().optional().describe("Condition/disease search."),
    interventionQuery: z
      .string()
      .optional()
      .describe("Intervention/treatment search."),
    sponsorQuery: z.string().optional().describe("Sponsor search."),
    statusFilter: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Filter by study status. Values: RECRUITING, COMPLETED, ACTIVE_NOT_RECRUITING, " +
          "NOT_YET_RECRUITING, ENROLLING_BY_INVITATION, SUSPENDED, TERMINATED, WITHDRAWN.",
      ),
    phaseFilter: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Filter by trial phase. Values: EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4, NA.",
      ),
    advancedFilter: z
      .string()
      .optional()
      .describe("Advanced AREA[] filter expression."),
  }),

  output: z.object({
    totalCount: z
      .number()
      .describe("Total studies matching the query/filters."),
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
        filterAdvanced: buildAdvancedFilter(
          toArray(input.phaseFilter),
          input.advancedFilter,
        ),
        countTotal: true,
        pageSize: 0,
      },
      ctx,
    );
    const totalCount = result.totalCount ?? 0;
    ctx.log.info("Count completed", { totalCount });
    return { totalCount };
  },

  format: (result) => [
    {
      type: "text",
      text: `${result.totalCount} studies match the specified criteria.`,
    },
  ],
});
