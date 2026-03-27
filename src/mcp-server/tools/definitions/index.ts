/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions
 */

import { findEligible } from './find-eligible.tool.js';
import { getEnums } from './get-enums.tool.js';
import { getFieldDefinitions } from './get-field-definitions.tool.js';
import { getFieldValues } from './get-field-values.tool.js';
import { getStudy } from './get-study.tool.js';
import { getStudyCount } from './get-study-count.tool.js';
import { getStudyResults } from './get-study-results.tool.js';
import { searchStudies } from './search-studies.tool.js';

export const allToolDefinitions = [
  searchStudies,
  getStudy,
  getStudyCount,
  getFieldValues,
  getFieldDefinitions,
  getEnums,
  getStudyResults,
  findEligible,
];
