/**
 * @fileoverview Shared formatting helpers for tool format() functions.
 * @module mcp-server/tools/utils/format-helpers
 */

/** Truncate a string, appending ellipsis when trimmed. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Strip common structural suffixes and split camelCase for readability. */
function humanizeSegment(segment: string): string {
  return segment
    .replace(/Module$/, '')
    .replace(/Struct$/, '')
    .replace(/Info$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Structural path segments skipped when building labels. */
const STRUCTURAL = new Set(['protocolSection', 'resultsSection', 'derivedSection']);

/** Build a human-readable label from path segments. */
function labelFromPath(segments: string[]): string {
  const meaningful = segments.filter((s) => !s.startsWith('[') && !STRUCTURAL.has(s));
  return meaningful.slice(-2).map(humanizeSegment).join(' > ');
}

interface Leaf {
  segments: string[];
  value: string;
}

/** Recursively collect primitive leaf values from a nested object. */
function collectLeaves(obj: unknown, segments: string[], out: Leaf[]): void {
  if (obj == null || obj === '') return;
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    out.push({ segments, value: String(obj) });
    return;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return;
    if (obj.every((v) => typeof v !== 'object' || v === null)) {
      out.push({ segments, value: obj.join(', ') });
      return;
    }
    // No per-array cap — the outer `maxLines` budget in formatRemainingStudyFields
    // already bounds total output. Capping here silently hid data from callers.
    for (let i = 0; i < obj.length; i++) {
      collectLeaves(obj[i], [...segments, `[${i}]`], out);
    }
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      collectLeaves(value, [...segments, key], out);
    }
  }
}

/** Check if a leaf's path starts with any rendered prefix. */
function isRendered(segments: string[], renderedPrefixes: ReadonlySet<string>): boolean {
  const path = segments.filter((s) => !s.startsWith('[')).join('.');
  for (const prefix of renderedPrefixes) {
    if (path === prefix || path.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

/**
 * Render study fields not already covered by the primary formatter.
 * `renderedPrefixes` uses dot-notation paths matching the study structure
 * (e.g., `"protocolSection.identificationModule.nctId"`).
 *
 * Returns indented lines suitable for appending after a study's primary output.
 */
export function formatRemainingStudyFields(
  study: Record<string, unknown>,
  renderedPrefixes: ReadonlySet<string>,
  { maxLines = 8, maxValueLen = 200 } = {},
): string[] {
  const leaves: Leaf[] = [];
  collectLeaves(study, [], leaves);

  const remaining = leaves.filter((leaf) => !isRendered(leaf.segments, renderedPrefixes));
  if (remaining.length === 0) return [];

  // Count only cap-dropped fields as "uncovered" — dedup-dropped leaves aren't
  // truncation, just consolidation. Pre-fix logic counted both, lying about
  // truncation whenever multiple array entries shared a label.
  const seen = new Set<string>();
  const lines: string[] = [];
  let dropped = 0;
  for (const leaf of remaining) {
    const label = labelFromPath(leaf.segments);
    if (!label || seen.has(label)) continue;
    if (lines.length >= maxLines) {
      dropped++;
      continue;
    }
    seen.add(label);
    lines.push(`  ${label}: ${truncate(leaf.value, maxValueLen)}`);
  }

  if (dropped > 0) {
    lines.push(`  … and ${dropped} more fields`);
  }

  return lines;
}
