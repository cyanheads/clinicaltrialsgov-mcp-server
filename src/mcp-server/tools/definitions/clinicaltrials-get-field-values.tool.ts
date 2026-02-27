/**
 * @fileoverview Tool definition for discovering valid enum values for ClinicalTrials.gov fields.
 * Wraps the /stats/fieldValues/{fieldName} endpoint to help build informed queries.
 *
 * @module src/mcp-server/tools/definitions/clinicaltrials-get-field-values.tool
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
import { logger, type RequestContext } from '@/utils/index.js';

const TOOL_NAME = 'clinicaltrials_get_field_values';
const TOOL_TITLE = 'Get ClinicalTrials.gov Field Values';
const TOOL_DESCRIPTION =
  'Discovers valid enum values for a ClinicalTrials.gov API field, with study counts per value. Use to explore available filter options before constructing a search (e.g., valid OverallStatus, Phase, InterventionType, StudyType, LeadSponsorClass values).';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const InputSchema = z
  .object({
    fieldName: z
      .string()
      .min(1)
      .describe(
        'The API field name to retrieve values for. Common fields: OverallStatus, Phase, StudyType, InterventionType, LeadSponsorClass, Sex, StdAge, DesignAllocation, DesignPrimaryPurpose.',
      ),
  })
  .describe('Input parameters for fetching field values.');

const OutputSchema = z
  .object({
    fieldName: z.string().describe('The queried field name'),
    values: z
      .array(
        z.object({
          value: z.string().describe('The field value'),
          count: z.number().describe('Number of studies with this value'),
        }),
      )
      .describe(
        'Available values with study counts, sorted by count descending',
      ),
    totalValues: z.number().describe('Total number of distinct values'),
  })
  .describe('Field values response.');

type GetFieldValuesInput = z.infer<typeof InputSchema>;
type GetFieldValuesOutput = z.infer<typeof OutputSchema>;

async function getFieldValuesLogic(
  input: GetFieldValuesInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GetFieldValuesOutput> {
  logger.debug('Executing getFieldValuesLogic', {
    ...appContext,
    toolInput: input,
  });

  const provider = container.resolve<IClinicalTrialsProvider>(
    ClinicalTrialsProvider,
  );
  const values = await provider.getFieldValues(input.fieldName, appContext);

  // Sort by count descending for relevance
  const sorted = values.sort((a, b) => b.count - a.count);

  return {
    fieldName: input.fieldName,
    values: sorted,
    totalValues: sorted.length,
  };
}

function responseFormatter(result: GetFieldValuesOutput): ContentBlock[] {
  const lines = [
    `# Field Values: ${result.fieldName}`,
    `**${result.totalValues}** distinct values\n`,
  ];

  for (const { value, count } of result.values) {
    lines.push(`- **${value}**: ${count.toLocaleString()} studies`);
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

export const getFieldValuesTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:clinicaltrials:read'], getFieldValuesLogic),
  responseFormatter,
};
