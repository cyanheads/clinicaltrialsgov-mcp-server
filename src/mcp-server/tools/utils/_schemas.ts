/**
 * @fileoverview Shared Zod schemas used across tool inputs and resource params.
 * @module mcp-server/tools/utils/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

const NCT_ID_MESSAGE = 'NCT IDs must match format NCTxxxxxxxx (8 digits).';

/** Canonical NCT identifier schema, e.g. NCT03722472. */
export const nctIdSchema = z.string().regex(/^NCT\d{8}$/, NCT_ID_MESSAGE);
