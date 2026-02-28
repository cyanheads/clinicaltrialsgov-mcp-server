/**
 * @fileoverview Complete, declarative definition for the 'clinicaltrials_search_studies' tool.
 * Searches for clinical trials using queries and filters with pagination support.
 *
 * @module src/mcp-server/tools/definitions/clinicaltrials-search-studies.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { container } from '@/container/index.js';
import { z } from 'zod';

import { ClinicalTrialsProvider } from '@/container/core/tokens.js';
import type {
  SdkContext,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import type { IClinicalTrialsProvider } from '@/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import { PagedStudiesSchema } from '@/services/clinical-trials-gov/types.js';
import { logger, type RequestContext } from '@/utils/index.js';

const TOOL_NAME = 'clinicaltrials_search_studies';
const TOOL_TITLE = 'Search Clinical Trials';
const TOOL_DESCRIPTION =
  'Searches for clinical trial studies from ClinicalTrials.gov using queries and filters. Supports pagination, sorting, and advanced filtering.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Valid overall status values for the ClinicalTrials.gov API filter.overallStatus parameter.
 */
const OverallStatusSchema = z.enum([
  'ACTIVE_NOT_RECRUITING',
  'COMPLETED',
  'ENROLLING_BY_INVITATION',
  'NOT_YET_RECRUITING',
  'RECRUITING',
  'SUSPENDED',
  'TERMINATED',
  'WITHDRAWN',
  'AVAILABLE',
  'NO_LONGER_AVAILABLE',
  'TEMPORARILY_NOT_AVAILABLE',
  'APPROVED_FOR_MARKETING',
  'WITHHELD',
  'UNKNOWN',
]);

/** Valid phase values for the ClinicalTrials.gov API filter.phase parameter. */
const PhaseFilterSchema = z.enum([
  'EARLY_PHASE1',
  'PHASE1',
  'PHASE2',
  'PHASE3',
  'PHASE4',
  'NA',
]);

const InputSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe(
        'General full-text search query across all fields (conditions, interventions, sponsors, etc.).',
      ),
    conditionQuery: z
      .string()
      .optional()
      .describe(
        'Condition-specific search — searches only the condition/synonym index. More precise than general query for disease/condition searches (e.g., "Type 2 Diabetes", "non-small cell lung cancer").',
      ),
    interventionQuery: z
      .string()
      .optional()
      .describe(
        'Intervention-specific search — searches only intervention/treatment fields (e.g., "pembrolizumab", "cognitive behavioral therapy").',
      ),
    sponsorQuery: z
      .string()
      .optional()
      .describe(
        'Sponsor-specific search — searches the SponsorsModule which includes both lead sponsor and collaborator names (e.g., "Pfizer", "National Cancer Institute"). To filter strictly by lead sponsor, use filter with AREA[LeadSponsorName] instead.',
      ),
    filter: z
      .string()
      .optional()
      .describe(
        "Advanced filter expression using AREA[] syntax. Examples: 'AREA[MinimumAge]RANGE[MIN, 18 years]', 'AREA[StudyType]INTERVENTIONAL', 'AREA[Phase](PHASE1 OR PHASE2)'. Combine with AND/OR. Use statusFilter/phaseFilter for simpler status/phase filtering.",
      ),
    statusFilter: z
      .union([
        OverallStatusSchema.describe('A single status to filter by.'),
        z
          .array(OverallStatusSchema)
          .min(1)
          .describe('An array of statuses to filter by.'),
      ])
      .optional()
      .describe(
        'Filter by overall study status. Accepts one or more values: RECRUITING, COMPLETED, ACTIVE_NOT_RECRUITING, NOT_YET_RECRUITING, etc.',
      ),
    phaseFilter: z
      .union([
        PhaseFilterSchema.describe('A single phase to filter by.'),
        z
          .array(PhaseFilterSchema)
          .min(1)
          .describe('An array of phases to filter by.'),
      ])
      .optional()
      .describe(
        'Filter by trial phase. Accepts one or more values: EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4, NA.',
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(10)
      .describe(
        'Number of studies to return per page (1-200). Defaults to 10.',
      ),
    pageToken: z
      .string()
      .optional()
      .describe('Token for retrieving the next page of results.'),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort order specification. Use valid API field names with optional :asc/:desc suffix (e.g., "LastUpdatePostDate:desc", "EnrollmentCount", "@relevance").',
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Specific fields to return (reduces payload size). STRONGLY RECOMMENDED — without this, the full study record (~70KB each) is returned. Example: ["NCTId", "BriefTitle", "OverallStatus", "Phase", "LeadSponsorName", "BriefSummary", "Condition", "InterventionName"]. Use full data only when you need detailed eligibility criteria, locations, or results.',
      ),
    country: z
      .string()
      .optional()
      .describe(
        'Filter studies by country (e.g., "United States", "Canada"). Searches location/facility fields.',
      ),
    state: z
      .string()
      .optional()
      .describe(
        'Filter studies by state or province (e.g., "California", "Ontario"). Searches location/facility fields.',
      ),
    city: z
      .string()
      .optional()
      .describe(
        'Filter studies by city (e.g., "New York", "Toronto"). Searches location/facility fields.',
      ),
    geoFilter: z
      .string()
      .optional()
      .describe(
        'Geographic proximity filter. Format: "distance(lat,lon,distanceMiles)" — e.g., "distance(39.0035,-77.1013,50)" for studies within 50 miles of Bethesda, MD.',
      ),
  })
  .describe('Input parameters for searching clinical trial studies.');

const OutputSchema = z.object({
  pagedStudies: PagedStudiesSchema,
});

type SearchStudiesInput = z.infer<typeof InputSchema>;
type SearchStudiesOutput = z.infer<typeof OutputSchema>;

/**
 * Searches for clinical studies using a combination of queries and filters.
 * Supports pagination, sorting, and advanced filtering.
 */
async function searchStudiesLogic(
  input: SearchStudiesInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<SearchStudiesOutput> {
  logger.debug('Executing searchStudiesLogic', {
    ...appContext,
    toolInput: input,
  });

  const provider = container.resolve<IClinicalTrialsProvider>(
    ClinicalTrialsProvider,
  );

  // Build location query from country/state/city components
  const locationParts = [input.city, input.state, input.country].filter(
    Boolean,
  );
  const locationQuery =
    locationParts.length > 0 ? locationParts.join(', ') : undefined;

  // Normalize enum filters to comma-separated strings for the provider
  const normalizeFilter = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v.join(',') : v;
  const statusFilter = normalizeFilter(input.statusFilter);
  const phaseFilter = normalizeFilter(input.phaseFilter);

  const pagedStudies = await provider.listStudies(
    {
      ...(input.query && { query: input.query }),
      ...(input.conditionQuery && { conditionQuery: input.conditionQuery }),
      ...(input.interventionQuery && {
        interventionQuery: input.interventionQuery,
      }),
      ...(input.sponsorQuery && { sponsorQuery: input.sponsorQuery }),
      ...(locationQuery && { locationQuery }),
      ...(input.filter && { filter: input.filter }),
      ...(statusFilter && { statusFilter }),
      ...(phaseFilter && { phaseFilter }),
      ...(input.geoFilter && { geoFilter: input.geoFilter }),
      pageSize: input.pageSize,
      ...(input.pageToken && { pageToken: input.pageToken }),
      ...(input.sort && { sort: input.sort }),
      ...(input.fields && { fields: input.fields }),
    },
    appContext,
  );

  logger.info(
    `Successfully searched studies: ${pagedStudies.studies?.length ?? 0} results`,
    {
      ...appContext,
      totalCount: pagedStudies.totalCount,
    },
  );

  return { pagedStudies };
}

function responseFormatter(result: SearchStudiesOutput): ContentBlock[] {
  const { pagedStudies } = result;
  const studyCount = pagedStudies.studies?.length ?? 0;
  const totalCount = pagedStudies.totalCount;
  const hasMore = !!pagedStudies.nextPageToken;

  const summary = [
    `Found ${studyCount} ${studyCount === 1 ? 'study' : 'studies'}`,
    totalCount ? `of ${totalCount} total` : null,
    hasMore ? '(more pages available)' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const studyList = (pagedStudies.studies ?? [])
    .slice(0, 5)
    .map((s) => {
      const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
      const title =
        s.protocolSection?.identificationModule?.briefTitle ?? 'No title';
      const status =
        s.protocolSection?.statusModule?.overallStatus ?? 'Unknown status';
      return `• ${nctId}: ${title}\n  Status: ${status}`;
    })
    .join('\n');

  const moreStudies = studyCount > 5 ? `\n...and ${studyCount - 5} more` : '';

  const pagination = hasMore
    ? `\n\nNext page token: ${pagedStudies.nextPageToken}`
    : '';

  return [
    {
      type: 'text',
      text: `${summary}\n\n${studyList}${moreStudies}${pagination}`,
    },
  ];
}

export const searchStudiesTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:clinicaltrials:read'], searchStudiesLogic),
  responseFormatter,
};
