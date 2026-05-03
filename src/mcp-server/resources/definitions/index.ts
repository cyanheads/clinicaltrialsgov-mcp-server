/**
 * @fileoverview Barrel export for all resource definitions.
 * @module mcp-server/resources/definitions
 */

import type { AnyResourceDefinition } from '@cyanheads/mcp-ts-core';
import { studyResource } from './study.resource.js';

export const allResourceDefinitions: AnyResourceDefinition[] = [studyResource];
