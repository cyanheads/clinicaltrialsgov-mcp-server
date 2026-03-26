/**
 * @fileoverview Barrel export for all prompt definitions.
 * @module mcp-server/prompts/definitions
 */

import { analyzeTrialLandscape } from "./analyze-trial-landscape.prompt.js";

export const allPromptDefinitions = [analyzeTrialLandscape];
