/**
 * @fileoverview Barrel file for all resource definitions.
 * Re-exports all resource definitions and provides an array for easy iteration.
 * @module src/mcp-server/resources/definitions
 */

import type { ResourceDefinition } from '../utils/resourceDefinition.js';

// import { echoResourceDefinition } from './echo.resource.js';

/**
 * An array containing all resource definitions for easy iteration.
 * This is used by the registration system to automatically discover and register
 * all available resources.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const allResourceDefinitions: ResourceDefinition<any, any>[] = []; // [echoResourceDefinition];
