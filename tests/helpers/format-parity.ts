/**
 * @fileoverview Channel-parity helpers. `content[]` (markdown) and
 * `structuredContent` (JSON) must carry the same data, so these walk a tool's
 * structured payload for primitive leaves and report the ones the rendered text
 * never mentions. Any limiting is a handler decision applied to both channels —
 * a leaf reachable in one channel and not the other is the defect.
 * @module tests/helpers/format-parity
 */

import { readFileSync } from 'node:fs';

/** One primitive value in a structured payload, with the path that reached it. */
export interface StructuredLeaf {
  path: string;
  value: string;
}

/** Collect every primitive leaf of a structured payload, with its dotted path. */
export function collectLeaves(
  node: unknown,
  path = '',
  out: StructuredLeaf[] = [],
): StructuredLeaf[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) collectLeaves(item, `${path}[${i}]`, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>))
      collectLeaves(value, path ? `${path}.${key}` : key, out);
    return out;
  }
  out.push({ path, value: String(node) });
  return out;
}

/**
 * Structured leaves whose literal value is absent from the rendered text.
 *
 * Booleans are excluded: they render as a word (`Yes`/`No`, `yes`/`no`) rather
 * than the literal `true`/`false`, so their parity is asserted field by field in
 * the caller's own expectations. Empty strings carry no data to render.
 */
export function missingLeaves(structured: unknown, renderedText: string): StructuredLeaf[] {
  return collectLeaves(structured).filter(({ value }) => {
    if (value.length === 0) return false;
    if (value === 'true' || value === 'false') return false;
    return !renderedText.includes(value);
  });
}

/** Load a verbatim ClinicalTrials.gov study record from `tests/fixtures`. */
export function loadStudyFixture(name: string): Record<string, unknown> {
  const url = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}
