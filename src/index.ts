#!/usr/bin/env node
/**
 * @fileoverview ClinicalTrials.gov MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initClinicalTrialsService } from './services/clinical-trials/clinical-trials-service.js';

await createApp({
  name: 'clinicaltrialsgov-mcp-server',
  title: 'clinicaltrialsgov-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  sessionMode: 'stateless',
  instructions: `Use the clinicaltrials_* tools to access the ClinicalTrials.gov registry — public, read-only, 600K+ studies. Studies are addressed by NCT ID (NCT followed by 8 digits). Field names for the fields, advancedFilter, and sort parameters are PascalCase leaves (NCTId, OverallStatus, EnrollmentCount) — call clinicaltrials_get_field_definitions to discover them and clinicaltrials_get_field_values for valid enum values. Typical workflow: clinicaltrials_search_studies (compact per-study index by default, including hasResults; pass fields for specific leaves) → clinicaltrials_get_study_record → clinicaltrials_get_study_results (only when hasResults=true). Use clinicaltrials_get_study_count for cheap breakdowns and clinicaltrials_find_eligible for patient matching.`,
  landing: {
    requireAuth: false,
  },
  setup() {
    initClinicalTrialsService();
  },
});
