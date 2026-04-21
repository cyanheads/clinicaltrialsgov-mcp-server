/**
 * @fileoverview Prompt guiding systematic clinical trial landscape analysis.
 * @module mcp-server/prompts/definitions/analyze-trial-landscape.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const analyzeTrialLandscape = prompt('analyze_trial_landscape', {
  description:
    'Guides analysis of a clinical trial landscape using the ClinicalTrials.gov MCP tools. Adaptable workflow for breakdowns by status, phase, sponsor, geography, etc.',

  args: z.object({
    topic: z.string().describe('Disease, condition, or research area to analyze.'),
    focusAreas: z
      .string()
      .optional()
      .describe(
        'Comma-separated aspects to focus on, e.g.: "status, phases, sponsors, geography, timeline, interventions".',
      ),
  }),

  generate: (args) => {
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

Use the ClinicalTrials.gov MCP tools to build a data-driven analysis. Available tools:

- **clinicaltrials_get_study_count** — fast counts for a query with optional filters (status, phase, etc.). Use this to build breakdowns and comparisons.
- **clinicaltrials_search_studies** — full study search with field selection, sorting, and pagination. Use to sample key studies, identify sponsors, or examine recent activity.
- **clinicaltrials_get_field_values** — discover valid filter values and their frequency. Useful when you need to know what values exist for a field.

${focus}

Present findings as tables where the data supports it. Cite specific NCT IDs for notable studies. Note trends, gaps, or patterns worth highlighting.`,
        },
      },
    ];
  },
});
