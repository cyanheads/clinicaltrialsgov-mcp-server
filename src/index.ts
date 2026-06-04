#!/usr/bin/env node
/**
 * @fileoverview ClinicalTrials.gov MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getMirrorConfig } from './config/server-config.js';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initClinicalTrialsService } from './services/clinical-trials/clinical-trials-service.js';
import { getClinicalTrialsMirror, initMirror } from './services/clinical-trials/mirror/index.js';

await createApp({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: `Use the clinicaltrials_* tools to access the ClinicalTrials.gov registry — public, read-only, ~577K studies. Studies are addressed by NCT ID (NCT followed by 8 digits). Field names for the fields, advancedFilter, and sort parameters are PascalCase leaves (NCTId, OverallStatus, EnrollmentCount) — call clinicaltrials_get_field_definitions to discover them and clinicaltrials_get_field_values for valid enum values. Typical workflow: clinicaltrials_search_studies (pass fields to trim ~70KB records) → clinicaltrials_get_study_record → clinicaltrials_get_study_results (only when hasResults=true). Use clinicaltrials_get_study_count for cheap breakdowns and clinicaltrials_find_eligible for patient matching.`,
  landing: {
    requireAuth: false,
  },
  async setup({ config }) {
    initClinicalTrialsService();

    const mirrorConfig = getMirrorConfig();
    if (mirrorConfig.enabled) {
      initMirror(mirrorConfig);

      // Schedule incremental refresh on HTTP transport only — stdio operators
      // run the server per-request and don't benefit from a persistent cron.
      // The full init must be run out-of-band (bootstrap script, CLI, or manual runSync).
      if (config.mcpTransportType === 'http') {
        const mirror = getClinicalTrialsMirror();
        if (mirror) {
          await schedulerService.schedule(
            'ct-mirror-refresh',
            mirrorConfig.refreshCron,
            async (_ctx) => {
              await mirror.runSync({ mode: 'refresh' });
            },
            'Incremental ClinicalTrials.gov mirror refresh',
          );
          schedulerService.start('ct-mirror-refresh');
        }
      }
    }
  },
});
