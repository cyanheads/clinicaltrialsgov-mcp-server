/**
 * @fileoverview Complete, declarative definition for the 'clinicaltrials_get_study' tool.
 * Fetches one or more clinical studies from ClinicalTrials.gov by their NCT IDs.
 *
 * @module src/mcp-server/tools/definitions/clinicaltrials-get-study.tool
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
import {
  StudySchema,
  type Study,
} from '@/services/clinical-trials-gov/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger, type RequestContext } from '@/utils/index.js';

const TOOL_NAME = 'clinicaltrials_get_study';
const TOOL_TITLE = 'Get Clinical Study';
const TOOL_DESCRIPTION =
  'Fetches one or more clinical trial studies from ClinicalTrials.gov by their NCT ID(s). Returns full study data or concise summaries.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Zod schema for a summarized study, containing only essential fields for a concise overview.
 */
const StudySummarySchema = z
  .object({
    nctId: z.string().optional().describe('The NCT identifier of the study.'),
    title: z.string().optional().describe('The official title of the study.'),
    briefSummary: z
      .string()
      .optional()
      .describe('A brief summary of the study purpose.'),
    overallStatus: z
      .string()
      .optional()
      .describe('The current recruitment status of the study.'),
    conditions: z
      .array(z.string())
      .optional()
      .describe('List of medical conditions being studied.'),
    interventions: z
      .array(
        z.object({
          name: z.string().optional().describe('Name of the intervention.'),
          type: z.string().optional().describe('Type of intervention.'),
        }),
      )
      .optional()
      .describe('List of interventions being tested.'),
    leadSponsor: z
      .string()
      .optional()
      .describe('The lead sponsor organization.'),
  })
  .passthrough()
  .describe('Concise summary of a clinical trial study.');

const InputSchema = z
  .object({
    nctIds: z
      .union([
        z
          .string()
          .regex(/^[Nn][Cc][Tt]\d{8}$/, 'NCT ID must be 8 digits')
          .describe('A single NCT ID (e.g., "NCT12345678").'),
        z
          .array(
            z.string().regex(/^[Nn][Cc][Tt]\d{8}$/, 'NCT ID must be 8 digits'),
          )
          .min(1, 'At least one NCT ID is required.')
          .max(5, 'Maximum 5 NCT IDs allowed per request.')
          .describe('An array of up to 5 NCT IDs.'),
      ])
      .describe(
        'A single NCT ID (e.g., "NCT12345678") or an array of up to 5 NCT IDs to fetch.',
      ),
    summaryOnly: z
      .boolean()
      .default(false)
      .describe(
        'If true, returns concise summaries. If false (default), returns full study data.',
      ),
  })
  .describe('Input parameters for fetching clinical trial studies.');

const OutputSchema = z
  .object({
    studies: z
      .array(z.union([StudySchema, StudySummarySchema]))
      .describe('Array of full study data or summaries.'),
    errors: z
      .array(
        z.object({
          nctId: z.string().describe('The NCT ID that failed.'),
          error: z.string().describe('Error message for this NCT ID.'),
        }),
      )
      .optional()
      .describe('List of errors encountered for specific NCT IDs.'),
  })
  .describe('Response containing study data and any errors.');

type GetStudyInput = z.infer<typeof InputSchema>;
type StudySummary = z.infer<typeof StudySummarySchema>;
type GetStudyOutput = z.infer<typeof OutputSchema>;

/**
 * Extracts a concise summary from a full study object.
 */
function createStudySummary(study: Study): StudySummary {
  return {
    nctId: study.protocolSection?.identificationModule?.nctId,
    title: study.protocolSection?.identificationModule?.officialTitle,
    briefSummary: study.protocolSection?.descriptionModule?.briefSummary,
    overallStatus: study.protocolSection?.statusModule?.overallStatus,
    conditions: study.protocolSection?.conditionsModule?.conditions,
    interventions:
      study.protocolSection?.armsInterventionsModule?.interventions?.map(
        (i) => ({
          name: i.name,
          type: i.type,
        }),
      ),
    leadSponsor:
      study.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name,
  };
}

/**
 * Fetches one or more clinical studies from ClinicalTrials.gov by their NCT IDs.
 * Uses batch filter.ids endpoint for multi-study requests (single API call)
 * and direct fetchStudy for single-study requests.
 */
async function getStudyLogic(
  input: GetStudyInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GetStudyOutput> {
  const nctIds = Array.isArray(input.nctIds) ? input.nctIds : [input.nctIds];
  const normalizedIds = nctIds.map((id) => id.toUpperCase());

  logger.debug(
    `Executing getStudyLogic for NCT IDs: ${normalizedIds.join(', ')}`,
    {
      ...appContext,
      toolInput: input,
    },
  );

  const provider = container.resolve<IClinicalTrialsProvider>(
    ClinicalTrialsProvider,
  );

  const studies: (Study | StudySummary)[] = [];
  const errors: { nctId: string; error: string }[] = [];

  if (normalizedIds.length === 1) {
    // Single study — direct fetch
    const singleId = normalizedIds[0] ?? '';
    const study = await provider.fetchStudy(singleId, appContext);
    logger.info(`Successfully fetched study ${singleId}`, {
      ...appContext,
    });
    studies.push(input.summaryOnly ? createStudySummary(study) : study);
  } else {
    // Multi-study — try batch fetch first, fall back to individual fetches on failure.
    // NOTE: try/catch here is intentional — the batch API call could fail entirely
    // (network error, malformed filter), in which case we retry individually to
    // preserve partial-success semantics.
    let batchSucceeded = false;
    try {
      const pagedStudies = await provider.listStudies(
        {
          filter: `AREA[NCTId](${normalizedIds.join(' OR ')})`,
          pageSize: normalizedIds.length,
        },
        appContext,
      );

      const fetchedMap = new Map<string, Study>();
      for (const study of pagedStudies.studies ?? []) {
        const id =
          study.protocolSection?.identificationModule?.nctId?.toUpperCase();
        if (id) fetchedMap.set(id, study);
      }

      for (const id of normalizedIds) {
        const study = fetchedMap.get(id);
        if (study) {
          studies.push(input.summaryOnly ? createStudySummary(study) : study);
        } else {
          errors.push({
            nctId: id,
            error: 'Study not found in batch response',
          });
        }
      }
      batchSucceeded = true;
    } catch (batchError) {
      logger.warning(
        '[get_study] Batch fetch failed, falling back to individual fetches',
        {
          ...appContext,
          error: batchError,
        },
      );
    }

    // Fallback: individual fetches with per-ID error handling
    if (!batchSucceeded) {
      const settled = await Promise.all(
        normalizedIds.map(async (nctId) => {
          try {
            const study = await provider.fetchStudy(nctId, appContext);
            return { ok: true as const, nctId, study };
          } catch (error) {
            const msg =
              error instanceof McpError
                ? error.message
                : 'An unexpected error occurred';
            return { ok: false as const, nctId, error: msg };
          }
        }),
      );
      for (const entry of settled) {
        if (entry.ok) {
          studies.push(
            input.summaryOnly ? createStudySummary(entry.study) : entry.study,
          );
        } else {
          errors.push({ nctId: entry.nctId, error: entry.error });
        }
      }
    }

    logger.info(`Fetched ${studies.length}/${normalizedIds.length} studies`, {
      ...appContext,
      missing: errors.length,
    });
  }

  if (studies.length === 0 && errors.length > 0) {
    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Failed to fetch any studies. Errors: ${errors.map((e) => `${e.nctId}: ${e.error}`).join('; ')}`,
      { errors },
    );
  }

  const result: GetStudyOutput = { studies };
  if (errors.length > 0) {
    result.errors = errors;
  }

  return result;
}

function responseFormatter(result: GetStudyOutput): ContentBlock[] {
  // Single study: full JSON is fine
  if (result.studies.length === 1 && !result.errors?.length) {
    return [{ type: 'text', text: JSON.stringify(result.studies[0], null, 2) }];
  }

  // Multi-study: text summary + structured content
  const parts: string[] = [`# ${result.studies.length} Studies Retrieved\n`];

  if (result.errors?.length) {
    parts.push(
      `> **Errors:** ${result.errors.map((e) => `${e.nctId}: ${e.error}`).join('; ')}\n`,
    );
  }

  for (const study of result.studies) {
    // If it's already a summary (has nctId at top level), use it directly.
    // Otherwise extract summary from the full Study object.
    const isSummary = 'nctId' in study && typeof study.nctId === 'string';
    const summary = isSummary
      ? (study as StudySummary)
      : createStudySummary(study as Study);
    const nctId = summary.nctId ?? 'Unknown';
    const title = summary.title ?? 'No title';
    const status = summary.overallStatus ?? 'Unknown';
    const conditions = summary.conditions ?? [];
    const sponsor = summary.leadSponsor ?? 'N/A';

    parts.push(`## ${nctId}: ${title}`);
    parts.push(`- **Status:** ${status}`);
    if (conditions.length > 0)
      parts.push(`- **Conditions:** ${conditions.join(', ')}`);
    parts.push(`- **Sponsor:** ${sponsor}`);
    parts.push('');
  }

  return [{ type: 'text', text: parts.join('\n') }];
}

export const getStudyTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:clinicaltrials:read'], getStudyLogic),
  responseFormatter,
};
