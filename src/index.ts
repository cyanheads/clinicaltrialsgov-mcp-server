#!/usr/bin/env node
/**
 * @fileoverview ClinicalTrials.gov MCP server entry point.
 * @module index
 */

import { createApp } from "@cyanheads/mcp-ts-core";
import { initClinicalTrialsService } from "./services/clinical-trials/clinical-trials-service.js";
import { allToolDefinitions } from "./mcp-server/tools/definitions/index.js";
import { allResourceDefinitions } from "./mcp-server/resources/definitions/index.js";
import { allPromptDefinitions } from "./mcp-server/prompts/definitions/index.js";

await createApp({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  setup() {
    initClinicalTrialsService();
  },
});
