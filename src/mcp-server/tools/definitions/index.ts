/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions
 */

import { searchStudies } from "./search-studies.tool.js";
import { getStudyCount } from "./get-study-count.tool.js";
import { getFieldValues } from "./get-field-values.tool.js";
import { getStudyResults } from "./get-study-results.tool.js";
import { findEligible } from "./find-eligible.tool.js";

export const allToolDefinitions = [
  searchStudies,
  getStudyCount,
  getFieldValues,
  getStudyResults,
  findEligible,
];
