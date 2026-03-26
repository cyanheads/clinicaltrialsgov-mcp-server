/**
 * @fileoverview Prompt guiding systematic clinical trial landscape analysis.
 * @module mcp-server/prompts/definitions/analyze-trial-landscape.prompt
 */

import { prompt, z } from "@cyanheads/mcp-ts-core";

export const analyzeTrialLandscape = prompt("analyze_trial_landscape", {
  description:
    "Guides systematic analysis of a clinical trial landscape using study counts and search. " +
    "Teaches the multi-call workflow for building breakdowns by phase, status, year, sponsor type, etc.",

  args: z.object({
    topic: z
      .string()
      .describe("Disease, condition, or research area to analyze."),
    focusAreas: z
      .array(z.string())
      .optional()
      .describe(
        "Specific aspects to analyze: status, phases, sponsors, geography, timeline, interventions.",
      ),
  }),

  generate: (args) => {
    const focus = args.focusAreas?.length
      ? args.focusAreas.join(", ")
      : "all aspects (status, phases, sponsors, geography, timeline, interventions)";

    return [
      {
        role: "user",
        content: {
          type: "text",
          text: `You are analyzing the clinical trial landscape for: **${args.topic}**

Use the ClinicalTrials.gov MCP tools to build a comprehensive analysis. Follow this workflow:

1. **Get a baseline count** — call \`clinicaltrials_get_study_count\` with conditionQuery="${args.topic}" to get the total number of trials.

2. **Break down by status** — call \`clinicaltrials_get_study_count\` for each status (RECRUITING, COMPLETED, ACTIVE_NOT_RECRUITING, TERMINATED, etc.) with the same conditionQuery plus statusFilter. Present as a table.

3. **Break down by phase** — call \`clinicaltrials_get_study_count\` for each phase (EARLY_PHASE1 through PHASE4, NA) with phaseFilter. Present as a table.

4. **Identify top sponsors** — call \`clinicaltrials_search_studies\` with conditionQuery, fields=["LeadSponsorName"], pageSize=100, and examine sponsor distribution.

5. **Recent activity** — call \`clinicaltrials_search_studies\` sorted by LastUpdatePostDate:desc to see recent trial activity.

6. **Sample key studies** — call \`clinicaltrials_search_studies\` with fields=["NCTId","BriefTitle","Phase","OverallStatus","LeadSponsorName","EnrollmentCount","Condition","InterventionName"] to get representative trials.

Present findings as structured tables and a narrative summary. Note any trends, gaps, or notable patterns. Cite specific NCT IDs for key findings.

Focus areas: ${focus}`,
        },
      },
    ];
  },
});
