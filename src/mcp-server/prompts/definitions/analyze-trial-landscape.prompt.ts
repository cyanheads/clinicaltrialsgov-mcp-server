/**
 * @fileoverview Prompt guiding systematic clinical trial landscape analysis.
 * @module mcp-server/prompts/definitions/analyze-trial-landscape.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const analyzeTrialLandscape = prompt('analyze_trial_landscape', {
  description:
    'Guides analysis of a clinical trial landscape using the ClinicalTrials.gov MCP tools. Adaptable workflow for breakdowns by status, phase, sponsor, geography, etc.',

  args: z.object({
    // `.min(1)` serializes to an advertised minLength: 1 in prompts/list.
    // Requiredness follows the emitted schema, so a `.default()`ed arg would
    // advertise as optional — topic carries none because it is required on
    // its own merits.
    topic: z.string().min(1).describe('Disease, condition, or research area to analyze.'),
    focusAreas: z
      .string()
      .optional()
      .describe(
        'Comma-separated aspects to focus on, e.g.: "status, phases, sponsors, geography, timeline, interventions".',
      ),
  }),

  generate: (args) => {
    // `.min(1)` passes for a whitespace-only topic, which renders as an empty
    // heading and asks the model to analyze nothing. Prompts have no error
    // contract — the framework's registration catch converts this throw into
    // an McpError carrying the message.
    if (args.topic.trim().length === 0) {
      throw new Error(
        "Prompt argument 'topic' was supplied with a blank value. Provide a disease, condition, or research area containing non-whitespace.",
      );
    }

    const areas =
      args.focusAreas
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const focus = areas.length
      ? `Focus the analysis on: **${areas.join(', ')}**.`
      : 'Cover whatever dimensions seem most informative — status distribution, phase breakdown, top sponsors, recent activity, geographic spread, or intervention types.';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Analyze the clinical trial landscape for: **${args.topic}**

Use the ClinicalTrials.gov MCP tools to build a data-driven analysis. Most useful for landscape work:

- **clinicaltrials_get_study_count** — fast counts for a query with optional filters (status, phase, etc.). Use this to build breakdowns and comparisons.
- **clinicaltrials_search_studies** — full study search with field selection, sorting, and pagination. Use to sample key studies, identify sponsors, or examine recent activity.
- **clinicaltrials_get_field_values** — discover valid filter values and their frequency. Useful when you need to know what values exist for a field.
- **clinicaltrials_get_field_definitions** — discover available field names by keyword or path. Use when you need a field name for filtering or sorting that you don't already know.
- **clinicaltrials_get_study_results** — fetch outcomes, adverse events, participant flow, and baseline for completed studies. Use when the analysis benefits from outcome trends across completed trials.

${focus}

Present findings as tables where the data supports it. Cite specific NCT IDs for notable studies. Note trends, gaps, or patterns worth highlighting.`,
        },
      },
    ];
  },
});
