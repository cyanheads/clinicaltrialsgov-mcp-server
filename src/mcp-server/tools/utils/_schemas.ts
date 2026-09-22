/**
 * @fileoverview Shared Zod schemas used across tool inputs and resource params.
 * @module mcp-server/tools/utils/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

const NCT_ID_MESSAGE = 'NCT IDs must match format NCTxxxxxxxx (8 digits).';

/**
 * Canonical NCT identifier schema, e.g. NCT03722472. Surrounding whitespace is
 * trimmed and the value uppercased before the format check, so `nct03722472`
 * parses to `NCT03722472` — upstream resolves every casing to the same study,
 * and handlers key Sets and Maps on the canonical string. The preprocess step
 * is invisible to JSON Schema emission: the advertised `pattern` stays
 * `^NCT\d{8}$`.
 */
export const nctIdSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().regex(/^NCT\d{8}$/, NCT_ID_MESSAGE),
);
