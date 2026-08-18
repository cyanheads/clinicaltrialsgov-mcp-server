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

/** One step of a leaf's path: an object key, plus the array entry it addresses. */
interface PathPart {
  /** Bracketed entry suffix (`[0]`, or `[0][1]` for nested arrays); empty when the key holds no array. */
  entry: string;
  /** The object key. */
  key: string;
  /** Whether an indexed array holds 2+ entries — only then does the suffix earn a place in the label. */
  repeated: boolean;
}

interface Leaf {
  path: PathPart[];
  value: string;
}

/** Mark the innermost path part as addressing entry `index` of a `total`-item array. */
function withEntry(path: PathPart[], index: number, total: number): PathPart[] {
  const owner = path.at(-1);
  if (!owner) return path;
  return [
    ...path.slice(0, -1),
    { ...owner, entry: `${owner.entry}[${index}]`, repeated: owner.repeated || total > 1 },
  ];
}

/**
 * Build a leaf's rendered label and its dedup key.
 *
 * The label is the last two meaningful segments, humanized, carrying the entry
 * index of any repeated array among them (`Secondary Id Infos[1] > Id`) so a
 * `content[]`-only reader can attribute each line to its originating entry.
 * Single-entry arrays keep the plain label — the common case stays quiet.
 *
 * The key adds the fully-qualified path of the entry the leaf sits in, so
 * entries of one array never collapse into each other and two arrays that
 * humanize alike (`conditionBrowseModule.meshes` / `interventionBrowseModule.meshes`)
 * never cross-merge on a shared index. Leaves outside any array key on the label
 * alone, consolidating same-labelled paths exactly as before.
 */
function describeLeaf(path: PathPart[]): { label: string; key: string } {
  const meaningful = path.filter((part) => !STRUCTURAL.has(part.key));
  const label = meaningful
    .slice(-2)
    .map((part) => `${humanizeSegment(part.key)}${part.repeated ? part.entry : ''}`)
    .join(' > ');

  const innermostEntry = meaningful.findLastIndex((part) => part.entry !== '');
  if (innermostEntry < 0) return { label, key: label };
  const entryPath = meaningful
    .slice(0, innermostEntry + 1)
    .map((part) => `${part.key}${part.entry}`)
    .join('.');
  return { label, key: `${entryPath}|${label}` };
}

/** Recursively collect primitive leaf values from a nested object. */
function collectLeaves(obj: unknown, path: PathPart[], out: Leaf[]): void {
  if (obj == null || obj === '') return;
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    out.push({ path, value: String(obj) });
    return;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return;
    if (obj.every((v) => typeof v !== 'object' || v === null)) {
      out.push({ path, value: obj.join(', ') });
      return;
    }
    // No per-array cap — the outer `maxLines` budget in formatRemainingStudyFields
    // already bounds total output. Capping here silently hid data from callers.
    for (let i = 0; i < obj.length; i++) {
      collectLeaves(obj[i], withEntry(path, i, obj.length), out);
    }
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      collectLeaves(value, [...path, { key, entry: '', repeated: false }], out);
    }
  }
}

/** Check if a leaf's path starts with any rendered prefix. */
function isRendered(path: PathPart[], renderedPrefixes: ReadonlySet<string>): boolean {
  const dotted = path.map((part) => part.key).join('.');
  for (const prefix of renderedPrefixes) {
    if (dotted === prefix || dotted.startsWith(`${prefix}.`)) return true;
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

  const remaining = leaves.filter((leaf) => !isRendered(leaf.path, renderedPrefixes));
  if (remaining.length === 0) return [];

  // Count only cap-dropped fields as "uncovered" — dedup-dropped leaves aren't
  // truncation, just consolidation. Pre-fix logic counted both, lying about
  // truncation whenever multiple array entries shared a label. A cap-dropped key
  // is recorded as seen so a field repeating past the cap counts once, not once
  // per occurrence.
  const seen = new Set<string>();
  const lines: string[] = [];
  let dropped = 0;
  for (const leaf of remaining) {
    const { label, key } = describeLeaf(leaf.path);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    if (lines.length >= maxLines) {
      dropped++;
      continue;
    }
    lines.push(`  ${label}: ${truncate(leaf.value, maxValueLen)}`);
  }

  if (dropped > 0) {
    lines.push(`  … and ${dropped} more fields`);
  }

  return lines;
}
