/**
 * @fileoverview Barrel export for all prompt definitions.
 * @module mcp-server/prompts/definitions
 */

import type { AnyPromptDefinition } from '@cyanheads/mcp-ts-core';
import { analyzeTrialLandscape } from './analyze-trial-landscape.prompt.js';

export const allPromptDefinitions: AnyPromptDefinition[] = [analyzeTrialLandscape];
