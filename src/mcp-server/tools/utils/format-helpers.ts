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

/** The default label window: the last two meaningful segments. */
const LABEL_WINDOW = 2;

/**
 * Render the last `width` meaningful segments as a label, carrying the entry
 * index of any repeated array among them (`Secondary Id Infos[1] > Id`) so a
 * `content[]`-only reader can attribute each line to its originating entry.
 * Single-entry arrays keep the plain label — the common case stays quiet.
 */
function labelAt(meaningful: PathPart[], width: number): string {
  return meaningful
    .slice(-width)
    .map((part) => `${humanizeSegment(part.key)}${part.repeated ? part.entry : ''}`)
    .join(' > ');
}

/**
 * Build a leaf's default-width label and its dedup key.
 *
 * The key adds the fully-qualified path of the entry the leaf sits in, so
 * entries of one array never collapse into each other and two arrays that
 * humanize alike (`conditionBrowseModule.meshes` / `interventionBrowseModule.meshes`)
 * never cross-merge on a shared index. Leaves outside any array key on the label
 * alone, consolidating same-labelled paths exactly as before.
 *
 * The key is always built from the default-width label, never from a widened
 * one, so display widening (see `disambiguateLabels`) can never change which
 * leaves consolidate — and therefore never disturbs the truncation footer.
 */
function describeLeaf(meaningful: PathPart[]): { label: string; key: string } {
  const label = labelAt(meaningful, LABEL_WINDOW);
  const innermostEntry = meaningful.findLastIndex((part) => part.entry !== '');
  if (innermostEntry < 0) return { label, key: label };
  const entryPath = meaningful
    .slice(0, innermostEntry + 1)
    .map((part) => `${part.key}${part.entry}`)
    .join('.');
  return { label, key: `${entryPath}|${label}` };
}

/** A leaf paired with its meaningful path, dedup key, shape, and the label to render. */
interface DescribedLeaf {
  key: string;
  label: string;
  meaningful: PathPart[];
  /** The leaf's path with array indices stripped — every entry of one array shares it. */
  shape: string;
  value: string;
}

/**
 * Widen the label window of any leaves whose labels collide, until each rendered
 * label identifies the record its value came from.
 *
 * Two distinct leaves can share a default-width label whenever the distinguishing
 * segment sits outside the window — `conditionBrowseModule.meshes[i].term` and
 * `interventionBrowseModule.meshes[i].term` both render `Meshes[i] > Term`. Same
 * label under two different dedup keys is exactly that ambiguity. Leaves that
 * share a key are consolidated by the dedup rather than rendered side by side,
 * so they are never ambiguous and never widen — which keeps same-labelled
 * non-array paths collapsing as before.
 *
 * Width is tracked per shape, not per leaf, so every entry of one array widens
 * together: an array whose last entry has no counterpart in the colliding array
 * would otherwise keep a narrow label while its siblings widened.
 */
function disambiguateLabels(items: DescribedLeaf[]): void {
  const widths = new Map<string, number>();
  const depths = new Map<string, number>();
  let maxDepth = 0;
  for (const item of items) {
    widths.set(item.shape, LABEL_WINDOW);
    depths.set(item.shape, item.meaningful.length);
    maxDepth = Math.max(maxDepth, item.meaningful.length);
  }

  // Each pass widens every shape involved in a collision by one segment. Bounded
  // by the deepest path: past that, widening cannot change any label.
  for (let pass = LABEL_WINDOW; pass < maxDepth; pass++) {
    const byLabel = new Map<string, DescribedLeaf[]>();
    for (const item of items) {
      const group = byLabel.get(item.label);
      if (group) group.push(item);
      else byLabel.set(item.label, [item]);
    }

    const ambiguous = new Set<string>();
    for (const group of byLabel.values()) {
      if (new Set(group.map((item) => item.key)).size < 2) continue;
      for (const item of group) ambiguous.add(item.shape);
    }

    let widened = false;
    for (const shape of ambiguous) {
      const width = widths.get(shape) ?? LABEL_WINDOW;
      if (width >= (depths.get(shape) ?? 0)) continue;
      widths.set(shape, width + 1);
      widened = true;
    }
    if (!widened) return;

    for (const item of items) {
      item.label = labelAt(item.meaningful, widths.get(item.shape) ?? LABEL_WINDOW);
    }
  }
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

  const described = remaining.map((leaf) => {
    const meaningful = leaf.path.filter((part) => !STRUCTURAL.has(part.key));
    return {
      ...describeLeaf(meaningful),
      meaningful,
      shape: meaningful.map((part) => part.key).join('.'),
      value: leaf.value,
    };
  });
  disambiguateLabels(described);

  // Count only cap-dropped fields as "uncovered" — dedup-dropped leaves aren't
  // truncation, just consolidation. Pre-fix logic counted both, lying about
  // truncation whenever multiple array entries shared a label. A cap-dropped key
  // is recorded as seen so a field repeating past the cap counts once, not once
  // per occurrence.
  const seen = new Set<string>();
  const lines: string[] = [];
  let dropped = 0;
  for (const { label, key, value } of described) {
    if (!label || seen.has(key)) continue;
    seen.add(key);
    if (lines.length >= maxLines) {
      dropped++;
      continue;
    }
    lines.push(`  ${label}: ${truncate(value, maxValueLen)}`);
  }

  if (dropped > 0) {
    lines.push(`  … and ${dropped} more fields`);
  }

  return lines;
}
