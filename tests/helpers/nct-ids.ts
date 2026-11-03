/**
 * @fileoverview NCT ID generator for tests that need a list of distinct, well-formed IDs.
 * @module tests/helpers/nct-ids
 */

/** `count` consecutive NCT IDs, numbered from `from` (`NCT00000000`, `NCT00000001`, …). */
export function nctIds(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, i) => `NCT${String(from + i).padStart(8, '0')}`);
}
