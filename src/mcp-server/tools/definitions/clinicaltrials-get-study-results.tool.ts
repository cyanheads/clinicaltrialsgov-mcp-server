/**
 * @fileoverview Tool definition for fetching and formatting trial results data.
 * Extracts resultsSection (outcomes, adverse events, participant flow, baseline)
 * for completed studies where hasResults is true.
 *
 * @module src/mcp-server/tools/definitions/clinicaltrials-get-study-results.tool
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
import type { Study } from '@/services/clinical-trials-gov/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger, type RequestContext } from '@/utils/index.js';

const TOOL_NAME = 'clinicaltrials_get_study_results';
const TOOL_TITLE = 'Get Clinical Trial Results';
const TOOL_DESCRIPTION =
  'Fetches trial results data for completed studies — outcome statistics, adverse events, participant flow, and baseline characteristics. Only available for studies where hasResults is true.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const NCT_ID_REGEX = /^[Nn][Cc][Tt]\d{8}$/;

const ResultsSectionFilter = z.enum([
  'outcomes',
  'adverseEvents',
  'participantFlow',
  'baseline',
]);

const InputSchema = z
  .object({
    nctIds: z
      .union([
        z
          .string()
          .regex(NCT_ID_REGEX, 'Must be a valid NCT ID (e.g., NCT12345678)'),
        z
          .array(
            z
              .string()
              .regex(
                NCT_ID_REGEX,
                'Must be a valid NCT ID (e.g., NCT12345678)',
              ),
          )
          .min(1)
          .max(5),
      ])
      .describe('One or more NCT identifiers to fetch results for (max 5).'),
    sections: z
      .union([
        ResultsSectionFilter.describe('A single results section to include.'),
        z
          .array(ResultsSectionFilter)
          .min(1)
          .describe('An array of results sections to include.'),
      ])
      .optional()
      .describe(
        'Filter which results sections to return. Omit to include all available sections: outcomes, adverseEvents, participantFlow, baseline.',
      ),
  })
  .describe('Input parameters for fetching clinical trial results.');

const StudyResultsSchema = z
  .object({
    nctId: z.string().describe('The NCT identifier'),
    title: z.string().optional().describe('Study title'),
    hasResults: z.boolean().describe('Whether the study has results'),
    outcomes: z
      .array(
        z
          .object({
            type: z
              .string()
              .optional()
              .describe('Primary, Secondary, or Other'),
            title: z.string().optional().describe('Outcome measure title'),
            description: z.string().optional().describe('Outcome description'),
            timeFrame: z
              .string()
              .optional()
              .describe('Time frame for measurement'),
            unitOfMeasure: z.string().optional().describe('Unit of measure'),
            groups: z
              .array(
                z.object({
                  title: z.string().optional(),
                  description: z.string().optional(),
                }),
              )
              .optional()
              .describe('Arm/group definitions'),
            measurements: z
              .array(
                z.object({
                  category: z.string().optional(),
                  values: z
                    .array(
                      z.object({
                        groupTitle: z.string().optional(),
                        value: z.string().optional(),
                        spread: z.string().optional(),
                      }),
                    )
                    .optional(),
                }),
              )
              .optional()
              .describe('Measurement data per group'),
            analyses: z
              .array(
                z.object({
                  pValue: z.string().optional(),
                  method: z.string().optional(),
                }),
              )
              .optional()
              .describe('Statistical analyses'),
          })
          .passthrough(),
      )
      .optional()
      .describe('Outcome measures with results'),
    adverseEvents: z
      .object({
        timeFrame: z.string().optional(),
        description: z.string().optional(),
        groups: z
          .array(
            z.object({
              title: z.string().optional(),
              seriousNumAffected: z.number().optional(),
              seriousNumAtRisk: z.number().optional(),
              otherNumAffected: z.number().optional(),
              otherNumAtRisk: z.number().optional(),
            }),
          )
          .optional(),
        seriousEventCount: z.number().optional(),
        otherEventCount: z.number().optional(),
      })
      .optional()
      .describe('Adverse events summary'),
    participantFlow: z
      .object({
        groups: z
          .array(
            z.object({
              title: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
        periods: z
          .array(
            z.object({
              title: z.string().optional(),
              milestones: z
                .array(
                  z.object({
                    type: z.string().optional(),
                    counts: z.array(z.string()).optional(),
                  }),
                )
                .optional(),
            }),
          )
          .optional(),
      })
      .optional()
      .describe('Participant flow through the study'),
    baseline: z
      .object({
        groups: z
          .array(
            z.object({
              title: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
        measures: z
          .array(
            z.object({
              title: z.string().optional(),
              paramType: z.string().optional(),
              unitOfMeasure: z.string().optional(),
              measurements: z
                .array(
                  z.object({
                    category: z.string().optional(),
                    values: z
                      .array(
                        z.object({
                          groupTitle: z.string().optional(),
                          value: z.string().optional(),
                          spread: z.string().optional(),
                        }),
                      )
                      .optional(),
                  }),
                )
                .optional()
                .describe('Measurement data per group'),
            }),
          )
          .optional(),
      })
      .optional()
      .describe('Baseline characteristics'),
  })
  .describe('Results data for a single study.');

const OutputSchema = z
  .object({
    results: z
      .array(StudyResultsSchema)
      .describe('Results for each requested study'),
    studiesWithoutResults: z
      .array(z.string())
      .optional()
      .describe('NCT IDs of studies that do not have results available'),
    fetchErrors: z
      .array(
        z.object({
          nctId: z.string().describe('The NCT ID that failed to fetch.'),
          error: z.string().describe('Error message.'),
        }),
      )
      .optional()
      .describe('NCT IDs that failed to fetch, with error details'),
  })
  .describe('Clinical trial results data.');

type GetStudyResultsInput = z.infer<typeof InputSchema>;
type GetStudyResultsOutput = z.infer<typeof OutputSchema>;

/**
 * Extracts formatted results from a study's resultsSection.
 */
function extractResults(
  study: Study,
  sections: Set<string>,
): z.infer<typeof StudyResultsSchema> {
  const nctId = study.protocolSection?.identificationModule?.nctId ?? 'Unknown';
  const title = study.protocolSection?.identificationModule?.briefTitle;
  const rs = study.resultsSection;

  const result: z.infer<typeof StudyResultsSchema> = {
    nctId,
    title,
    hasResults: study.hasResults ?? false,
  };

  if (sections.has('outcomes') && rs?.outcomeMeasuresModule?.outcomeMeasures) {
    result.outcomes = rs.outcomeMeasuresModule.outcomeMeasures.map((om) => {
      const groupMap = new Map(
        (om.groups ?? []).map((g) => [g.id, g.title ?? g.id ?? '']),
      );
      return {
        type: om.type,
        title: om.title,
        description: om.description,
        timeFrame: om.timeFrame,
        unitOfMeasure: om.unitOfMeasure,
        groups: om.groups?.map((g) => ({
          title: g.title,
          description: g.description,
        })),
        measurements: om.classes?.flatMap(
          (cls) =>
            cls.categories?.map((cat) => ({
              category: cat.title ?? cls.title,
              values: cat.measurements?.map((m) => ({
                groupTitle: groupMap.get(m.groupId ?? '') ?? m.groupId,
                value: m.value,
                spread: m.spread,
              })),
            })) ?? [],
        ),
        analyses: om.analyses?.map((a) => ({
          pValue: a.pValue,
          method: a.statisticalMethod,
        })),
      };
    });
  }

  if (sections.has('adverseEvents') && rs?.adverseEventsModule) {
    const ae = rs.adverseEventsModule;
    result.adverseEvents = {
      timeFrame: ae.timeFrame,
      description: ae.description,
      groups: ae.eventGroups?.map((g) => ({
        title: g.title,
        seriousNumAffected: g.seriousNumAffected,
        seriousNumAtRisk: g.seriousNumAtRisk,
        otherNumAffected: g.otherNumAffected,
        otherNumAtRisk: g.otherNumAtRisk,
      })),
      seriousEventCount: ae.seriousEvents?.length,
      otherEventCount: ae.otherEvents?.length,
    };
  }

  if (sections.has('participantFlow') && rs?.participantFlowModule) {
    const pf = rs.participantFlowModule;
    result.participantFlow = {
      groups: pf.groups?.map((g) => ({
        title: g.title,
        description: g.description,
      })),
      periods: pf.periods?.map((p) => ({
        title: p.title,
        milestones: p.milestones?.map((m) => ({
          type: m.type,
          counts: m.achievements?.map(
            (a) => `${a.numSubjects ?? '?'} subjects`,
          ),
        })),
      })),
    };
  }

  if (sections.has('baseline') && rs?.baselineCharacteristicsModule) {
    const bl = rs.baselineCharacteristicsModule;
    const blGroupMap = new Map(
      (bl.groups ?? []).map((g) => [g.id, g.title ?? g.id ?? '']),
    );
    result.baseline = {
      groups: bl.groups?.map((g) => ({
        title: g.title,
        description: g.description,
      })),
      measures: bl.measures?.map((m) => ({
        title: m.title,
        paramType: m.paramType,
        unitOfMeasure: m.unitOfMeasure,
        measurements: m.classes?.flatMap(
          (cls) =>
            cls.categories?.map((cat) => ({
              category: (cat.title ?? cls.title) as string | undefined,
              values: cat.measurements?.map((meas) => ({
                groupTitle: blGroupMap.get(meas.groupId ?? '') ?? meas.groupId,
                value: meas.value,
                spread: meas.spread,
              })),
            })) ?? [],
        ),
      })),
    };
  }

  return result;
}

async function getStudyResultsLogic(
  input: GetStudyResultsInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GetStudyResultsOutput> {
  logger.debug('Executing getStudyResultsLogic', {
    ...appContext,
    toolInput: input,
  });

  const provider = container.resolve<IClinicalTrialsProvider>(
    ClinicalTrialsProvider,
  );
  const nctIds = Array.isArray(input.nctIds) ? input.nctIds : [input.nctIds];
  const sectionList = input.sections
    ? Array.isArray(input.sections)
      ? input.sections
      : [input.sections]
    : ['outcomes', 'adverseEvents', 'participantFlow', 'baseline'];
  const sections = new Set(sectionList);

  const fetchResults = await Promise.allSettled(
    nctIds.map((id) => provider.fetchStudy(id.toUpperCase(), appContext)),
  );

  const results: z.infer<typeof StudyResultsSchema>[] = [];
  const studiesWithoutResults: string[] = [];
  const fetchErrors: { nctId: string; error: string }[] = [];

  for (const [i, settlement] of fetchResults.entries()) {
    const nctId = (nctIds[i] ?? '').toUpperCase();
    if (settlement.status === 'rejected') {
      const reason: unknown = settlement.reason;
      const msg =
        reason instanceof McpError
          ? reason.message
          : reason instanceof Error
            ? reason.message
            : 'An unexpected error occurred';
      fetchErrors.push({ nctId, error: msg });
      continue;
    }
    const study = settlement.value;
    if (!study.hasResults || !study.resultsSection) {
      studiesWithoutResults.push(nctId);
      continue;
    }
    results.push(extractResults(study, sections));
  }

  if (fetchErrors.length === nctIds.length) {
    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Failed to fetch all requested studies: ${fetchErrors.map((e) => `${e.nctId}: ${e.error}`).join('; ')}`,
    );
  }

  return {
    results,
    ...(studiesWithoutResults.length > 0 ? { studiesWithoutResults } : {}),
    ...(fetchErrors.length > 0 ? { fetchErrors } : {}),
  };
}

function responseFormatter(result: GetStudyResultsOutput): ContentBlock[] {
  const parts: string[] = [];

  if (result.fetchErrors?.length) {
    parts.push(
      `> **Fetch errors:** ${result.fetchErrors.map((e) => `${e.nctId}: ${e.error}`).join('; ')}\n`,
    );
  }

  if (result.studiesWithoutResults?.length) {
    parts.push(
      `> **Note:** ${result.studiesWithoutResults.join(', ')} — no results available.\n`,
    );
  }

  for (const study of result.results) {
    parts.push(`# ${study.title ?? study.nctId}`);
    parts.push(`**NCT ID:** ${study.nctId}\n`);

    if (study.outcomes?.length) {
      parts.push(`## Outcome Measures (${study.outcomes.length})`);
      for (const om of study.outcomes) {
        parts.push(`### ${om.type ?? 'Outcome'}: ${om.title ?? 'Untitled'}`);
        if (om.description) parts.push(om.description);
        if (om.timeFrame) parts.push(`**Time Frame:** ${om.timeFrame}`);
        if (om.unitOfMeasure) parts.push(`**Unit:** ${om.unitOfMeasure}`);
        if (om.analyses?.length) {
          for (const a of om.analyses) {
            if (a.pValue)
              parts.push(
                `**p-value:** ${a.pValue} (${a.method ?? 'method not specified'})`,
              );
          }
        }
        parts.push('');
      }
    }

    if (study.adverseEvents) {
      parts.push(`## Adverse Events`);
      if (study.adverseEvents.timeFrame)
        parts.push(`**Time Frame:** ${study.adverseEvents.timeFrame}`);
      if (study.adverseEvents.groups?.length) {
        for (const g of study.adverseEvents.groups) {
          const serious =
            g.seriousNumAffected != null
              ? `${g.seriousNumAffected}/${g.seriousNumAtRisk} serious`
              : '';
          const other =
            g.otherNumAffected != null
              ? `${g.otherNumAffected}/${g.otherNumAtRisk} other`
              : '';
          parts.push(
            `- **${g.title}:** ${[serious, other].filter(Boolean).join(', ')}`,
          );
        }
      }
      parts.push(
        `- Serious event types: ${study.adverseEvents.seriousEventCount ?? 0}`,
      );
      parts.push(
        `- Other event types: ${study.adverseEvents.otherEventCount ?? 0}`,
      );
      parts.push('');
    }

    if (study.participantFlow) {
      parts.push(`## Participant Flow`);
      if (study.participantFlow.groups?.length) {
        parts.push(
          `**Groups:** ${study.participantFlow.groups.map((g) => g.title).join(', ')}`,
        );
      }
      parts.push('');
    }

    if (study.baseline) {
      parts.push(`## Baseline Characteristics`);
      if (study.baseline.measures?.length) {
        parts.push(`${study.baseline.measures.length} measures recorded`);
        for (const m of study.baseline.measures.slice(0, 10)) {
          const header = `- **${m.title}** (${m.paramType ?? 'N/A'}, ${m.unitOfMeasure ?? 'N/A'})`;
          const values = m.measurements
            ?.flatMap((meas) => meas.values ?? [])
            .map(
              (v) =>
                `  - ${v.groupTitle}: ${v.value ?? 'N/A'}${v.spread ? ` (${v.spread})` : ''}`,
            );
          parts.push(header);
          if (values?.length) parts.push(...values);
        }
        if (study.baseline.measures.length > 10) {
          parts.push(`- ...and ${study.baseline.measures.length - 10} more`);
        }
      }
      parts.push('');
    }

    parts.push('---\n');
  }

  return [{ type: 'text', text: parts.join('\n') }];
}

export const getStudyResultsTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:clinicaltrials:read'], getStudyResultsLogic),
  responseFormatter,
};
