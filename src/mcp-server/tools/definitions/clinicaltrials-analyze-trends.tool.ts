/**
 * @fileoverview Complete, declarative definition for the 'clinicaltrials_analyze_trends' tool.
 * Performs statistical analysis on clinical trial data by fetching matching studies and aggregating metrics.
 *
 * @module src/mcp-server/tools/definitions/clinicaltrials-analyze-trends.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { container } from '@/container/index.js';
import { z } from 'zod';

import { AppConfig, ClinicalTrialsProvider } from '@/container/core/tokens.js';
import type {
  SdkContext,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import type { IClinicalTrialsProvider } from '@/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { Study } from '@/services/clinical-trials-gov/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger, type RequestContext } from '@/utils/index.js';

const TOOL_NAME = 'clinicaltrials_analyze_trends';
const TOOL_TITLE = 'Analyze Clinical Trial Trends';
const TOOL_DESCRIPTION =
  'Performs statistical analysis on clinical trial studies matching search criteria. Aggregates data by status, country, sponsor type, phase, year, month, study type, or intervention type. May fetch up to 5000 studies.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const API_CALL_DELAY_MS = 250;

/**
 * A simple promise-based delay function.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Defines the types of analysis that can be performed.
 */
const AnalysisTypeSchema = z.enum([
  'countByStatus',
  'countByCountry',
  'countBySponsorType',
  'countByPhase',
  'countByYear',
  'countByMonth',
  'countByStudyType',
  'countByInterventionType',
]);

const InputSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe(
        'General search query for conditions, interventions, sponsors, or other terms.',
      ),
    filter: z
      .string()
      .optional()
      .describe(
        'Advanced filter expression using the ClinicalTrials.gov filter syntax.',
      ),
    analysisType: z
      .union([
        AnalysisTypeSchema.describe('A single analysis type to perform.'),
        z
          .array(AnalysisTypeSchema)
          .min(1)
          .describe('An array of analysis types to perform.'),
      ])
      .describe(
        'Specify one or more analysis types: countByStatus, countByCountry, countBySponsorType, countByPhase, countByYear, countByMonth, countByStudyType, or countByInterventionType.',
      ),
  })
  .describe('Input parameters for analyzing clinical trial trends.');

const AnalysisResultSchema = z
  .object({
    analysisType: AnalysisTypeSchema.describe(
      'The type of analysis performed.',
    ),
    totalStudies: z
      .number()
      .int()
      .describe('Total number of studies included in this analysis.'),
    results: z
      .record(z.string(), z.number())
      .describe(
        'Aggregated counts by category (e.g., status, country, phase).',
      ),
  })
  .describe('Result of a single analysis type.');

const OutputSchema = z
  .object({
    analysis: z
      .array(AnalysisResultSchema)
      .describe('Array of analysis results, one per requested analysis type.'),
  })
  .describe('Trend analysis results for clinical trial studies.');

type AnalyzeTrendsInput = z.infer<typeof InputSchema>;
type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
type AnalyzeTrendsOutput = z.infer<typeof OutputSchema>;

/**
 * Fetches all studies for a given query, handling pagination.
 * Throws if the total count exceeds the configured limit.
 * Checks the AbortSignal between pages to support cancellation.
 */
async function fetchAllStudies(
  query: string | undefined,
  filter: string | undefined,
  appContext: RequestContext,
  signal?: AbortSignal,
): Promise<Study[]> {
  const config =
    container.resolve<
      ReturnType<typeof import('@/config/index.js').parseConfig>
    >(AppConfig);
  const provider = container.resolve<IClinicalTrialsProvider>(
    ClinicalTrialsProvider,
  );

  const maxStudies = config.maxStudiesForAnalysis;
  const PAGE_SIZE = 1000;

  logger.debug('Fetching all studies for analysis...', { ...appContext });

  // First page doubles as the total-count check — no wasted request.
  const firstPage = await provider.listStudies(
    {
      ...(query && { query }),
      ...(filter && { filter }),
      pageSize: PAGE_SIZE,
    },
    appContext,
  );

  const totalStudies = firstPage.totalCount ?? 0;

  if (totalStudies > maxStudies) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      `The query returned ${totalStudies} studies, which exceeds the limit of ${maxStudies} for analysis. Please provide a more specific query.`,
      { totalStudies, limit: maxStudies },
    );
  }

  const allStudies: Study[] = firstPage.studies ? [...firstPage.studies] : [];

  if (allStudies.length === 0 || !firstPage.nextPageToken) {
    return allStudies;
  }

  // Fetch remaining pages
  let pageToken: string | undefined = firstPage.nextPageToken;

  while (pageToken && allStudies.length < totalStudies) {
    signal?.throwIfAborted();
    await delay(API_CALL_DELAY_MS);

    const pagedStudies = await provider.listStudies(
      {
        ...(query && { query }),
        ...(filter && { filter }),
        pageToken,
        pageSize: PAGE_SIZE,
      },
      appContext,
    );

    if (pagedStudies.studies) {
      allStudies.push(...pagedStudies.studies);
    }

    pageToken = pagedStudies.nextPageToken;
  }

  logger.info(`Fetched a total of ${allStudies.length} studies for analysis.`, {
    ...appContext,
  });

  return allStudies;
}

/**
 * Performs a statistical analysis on a set of clinical trials matching the given criteria.
 */
async function analyzeTrendsLogic(
  input: AnalyzeTrendsInput,
  appContext: RequestContext,
  sdkContext: SdkContext,
): Promise<AnalyzeTrendsOutput> {
  logger.debug('Executing analyzeTrendsLogic', {
    ...appContext,
    toolInput: input,
  });

  const allStudies = await fetchAllStudies(
    input.query,
    input.filter,
    appContext,
    sdkContext.signal,
  );

  const analysisTypes = Array.isArray(input.analysisType)
    ? input.analysisType
    : [input.analysisType];

  const finalResults: AnalysisResult[] = [];

  for (const type of analysisTypes) {
    const results: Record<string, number> = {};

    for (const study of allStudies) {
      let key: string | undefined;

      switch (type) {
        case 'countByStatus':
          key = study.protocolSection?.statusModule?.overallStatus ?? 'Unknown';
          break;

        case 'countByCountry': {
          // Deduplicate countries per study — a study with 10 US sites
          // should count as 1 for "United States", not 10.
          const countries = new Set<string>();
          for (const loc of study.protocolSection?.contactsLocationsModule
            ?.locations ?? []) {
            countries.add(loc.country ?? 'Unknown');
          }
          for (const country of countries) {
            results[country] = (results[country] ?? 0) + 1;
          }
          continue;
        }

        case 'countBySponsorType':
          key =
            study.protocolSection?.sponsorCollaboratorsModule?.leadSponsor
              ?.class ?? 'Unknown';
          break;

        case 'countByPhase': {
          const phases = study.protocolSection?.designModule?.phases ?? [
            'Unknown',
          ];
          for (const phase of phases) {
            const phaseKey = phase ?? 'Unknown';
            results[phaseKey] = (results[phaseKey] ?? 0) + 1;
          }
          continue;
        }

        case 'countByYear': {
          const startDate =
            study.protocolSection?.statusModule?.startDateStruct?.date;
          if (startDate) {
            const year = startDate.substring(0, 4); // Extract YYYY from date
            results[year] = (results[year] ?? 0) + 1;
          } else {
            results.Unknown = (results.Unknown ?? 0) + 1;
          }
          continue;
        }

        case 'countByMonth': {
          const startDate =
            study.protocolSection?.statusModule?.startDateStruct?.date;
          if (startDate && startDate.length >= 7) {
            const yearMonth = startDate.substring(0, 7); // Extract YYYY-MM from date
            results[yearMonth] = (results[yearMonth] ?? 0) + 1;
          } else {
            results.Unknown = (results.Unknown ?? 0) + 1;
          }
          continue;
        }

        case 'countByStudyType':
          key = study.protocolSection?.designModule?.studyType ?? 'Unknown';
          break;

        case 'countByInterventionType': {
          const interventions =
            study.protocolSection?.armsInterventionsModule?.interventions;
          if (interventions?.length) {
            // Deduplicate intervention types per study
            const types = new Set<string>();
            for (const intr of interventions) {
              types.add(intr.type ?? 'Unknown');
            }
            for (const intrType of types) {
              results[intrType] = (results[intrType] ?? 0) + 1;
            }
          } else {
            results.Unknown = (results.Unknown ?? 0) + 1;
          }
          continue;
        }
      }

      if (key) {
        results[key] = (results[key] ?? 0) + 1;
      }
    }

    finalResults.push({
      analysisType: type,
      totalStudies: allStudies.length,
      results,
    });
  }

  logger.info('Successfully completed trend analysis', {
    ...appContext,
    analysisCount: finalResults.length,
  });

  return { analysis: finalResults };
}

function responseFormatter(result: AnalyzeTrendsOutput): ContentBlock[] {
  const analysisCount = result.analysis.length;

  const summaries = result.analysis.map((analysis) => {
    const topEntries = Object.entries(analysis.results)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const categoryList = topEntries
      .map(([category, count]) => {
        const percentage = ((count / analysis.totalStudies) * 100).toFixed(1);
        return `  • ${category}: ${count} (${percentage}%)`;
      })
      .join('\n');

    const more =
      Object.keys(analysis.results).length > 10
        ? `  ...and ${Object.keys(analysis.results).length - 10} more`
        : '';

    return [
      `Analysis: ${analysis.analysisType}`,
      `Total Studies: ${analysis.totalStudies}`,
      'Top Categories:',
      categoryList,
      more,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    {
      type: 'text',
      text: `Completed ${analysisCount} ${analysisCount === 1 ? 'analysis' : 'analyses'}\n\n${summaries.join('\n\n---\n\n')}`,
    },
  ];
}

export const analyzeTrendsTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:clinicaltrials:read'], analyzeTrendsLogic),
  responseFormatter,
};
