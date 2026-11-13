/**
 * @fileoverview Shared formatting helpers for tool format() functions and
 * searchCriteria enrichment trailers.
 * @module mcp-server/tools/utils/format-helpers
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * Flatten CR/LF in upstream text interpolated into a single line, so a line
 * break in the value cannot start a new `content[]` line and forge structure:
 * each whitespace run holding a CR or LF becomes one space, and every other
 * run is kept as is. Runs in time linear in the input. Applied to a value, or
 * to a whole rendered row whose every part is meant to share one line.
 * `structuredContent` keeps the value verbatim.
 */
export function oneLine(value: string): string;
export function oneLine(value: string | undefined): string | undefined;
export function oneLine(value: string | undefined): string | undefined {
  // A lone whitespace character needs folding only when it is a break, so the
  // single spaces between words never reach the callback.
  return value?.replace(/\s{2,}|[\r\n]/g, (run) => (/[\r\n]/.test(run) ? ' ' : run));
}

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

/** A record's key → its humanized segment, built once per key. */
type Humanize = (segment: string) => string;

/**
 * `humanizeSegment` memoized for one record's dump: a record repeats its few
 * hundred distinct keys across every leaf, and each leaf's label is built from
 * them at least once. The memo lives as long as the dump that created it.
 */
function memoizedHumanize(): Humanize {
  const bySegment = new Map<string, string>();
  return (segment) => {
    let humanized = bySegment.get(segment);
    if (humanized === undefined) {
      humanized = humanizeSegment(segment);
      bySegment.set(segment, humanized);
    }
    return humanized;
  };
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
function labelAt(meaningful: PathPart[], width: number, humanize: Humanize): string {
  return meaningful
    .slice(-width)
    .map((part) => `${humanize(part.key)}${part.repeated ? part.entry : ''}`)
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
function describeLeaf(meaningful: PathPart[], humanize: Humanize): { label: string; key: string } {
  const label = labelAt(meaningful, LABEL_WINDOW, humanize);
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

/** The leaves of one shape and the label window they share. */
interface ShapeLabels {
  /** The shape's meaningful segments — the widest window it can take. */
  depth: number;
  leaves: DescribedLeaf[];
  /** Segments its labels show. */
  width: number;
}

/** Whether a label's leaves sit under two or more dedup keys, so the label misattributes. */
function mixesKeys(group: Iterable<DescribedLeaf>): boolean {
  let first: string | undefined;
  for (const { key } of group) {
    if (first === undefined) first = key;
    else if (key !== first) return true;
  }
  return false;
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
 *
 * The leaves under each label are kept across passes. The first pass checks
 * every label; each later pass checks only the labels a widened leaf moved
 * into, since a label gains a collision only by gaining leaves, and every shape
 * in a label already found colliding has either widened out of it or reached
 * its full depth. Only the leaves of a widened shape are relabelled.
 */
function disambiguateLabels(items: DescribedLeaf[], humanize: Humanize): void {
  const shapes = new Map<string, ShapeLabels>();
  const byLabel = new Map<string, Set<DescribedLeaf>>();
  const join = (item: DescribedLeaf) => {
    const group = byLabel.get(item.label);
    if (group) group.add(item);
    else byLabel.set(item.label, new Set([item]));
  };
  let maxDepth = 0;
  for (const item of items) {
    const shape = shapes.get(item.shape);
    if (shape) shape.leaves.push(item);
    else {
      shapes.set(item.shape, {
        depth: item.meaningful.length,
        leaves: [item],
        width: LABEL_WINDOW,
      });
    }
    maxDepth = Math.max(maxDepth, item.meaningful.length);
    join(item);
  }

  // Each pass widens every shape involved in a collision by one segment. Bounded
  // by the deepest path: past that, widening cannot change any label.
  let toCheck: Iterable<string> = [...byLabel.keys()];
  for (let pass = LABEL_WINDOW; pass < maxDepth; pass++) {
    const ambiguous = new Set<string>();
    for (const label of toCheck) {
      const group = byLabel.get(label);
      if (!group || !mixesKeys(group)) continue;
      for (const item of group) ambiguous.add(item.shape);
    }

    const joined = new Set<string>();
    for (const name of ambiguous) {
      const shape = shapes.get(name);
      if (!shape || shape.width >= shape.depth) continue;
      shape.width++;
      for (const item of shape.leaves) {
        const group = byLabel.get(item.label);
        if (group?.delete(item) && group.size === 0) byLabel.delete(item.label);
        item.label = labelAt(item.meaningful, shape.width, humanize);
        join(item);
        joined.add(item.label);
      }
    }
    if (joined.size === 0) return;
    toCheck = joined;
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

/**
 * Leaf keys holding long-form prose: summaries, descriptions, criteria,
 * populations, details, notes. Their rows keep their line breaks, as a
 * prose field the tools render under its own label does; every other row
 * renders on one line.
 */
const PROSE_LEAF = /(?:description|summary|criteria|population|details|notes)$/i;

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
 * Returns indented lines suitable for appending after a study's primary output,
 * one row per field: a line break in a value folds to a space, unless the leaf
 * is long-form prose (`PROSE_LEAF`), which keeps its breaks.
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

  const humanize = memoizedHumanize();
  const described = remaining.map((leaf) => {
    const meaningful = leaf.path.filter((part) => !STRUCTURAL.has(part.key));
    return {
      ...describeLeaf(meaningful, humanize),
      meaningful,
      shape: meaningful.map((part) => part.key).join('.'),
      value: leaf.value,
    };
  });
  disambiguateLabels(described, humanize);

  // Count only cap-dropped fields as "uncovered" — dedup-dropped leaves aren't
  // truncation, just consolidation. Pre-fix logic counted both, lying about
  // truncation whenever multiple array entries shared a label. A cap-dropped key
  // is recorded as seen so a field repeating past the cap counts once, not once
  // per occurrence.
  const seen = new Set<string>();
  const lines: string[] = [];
  let dropped = 0;
  for (const { label, key, meaningful, value } of described) {
    if (!label || seen.has(key)) continue;
    seen.add(key);
    if (lines.length >= maxLines) {
      dropped++;
      continue;
    }
    const row = `  ${label}: ${truncate(value, maxValueLen)}`;
    lines.push(PROSE_LEAF.test(meaningful.at(-1)?.key ?? '') ? row : oneLine(row));
  }

  if (dropped > 0) {
    lines.push(`  … and ${dropped} more fields`);
  }

  return lines;
}

/**
 * A searchCriteria value as Markdown a CommonMark parse reads back as written,
 * so a `content[]`-only caller can copy it into its next call unchanged. A
 * string is a code literal: a code span sized past its longest backtick run,
 * or, when it holds a line break, a fenced block on lines of its own — a code
 * span cannot hold one, since the block parse ends the line there and reads
 * the next as a heading, list item, or quote. Each entry of a list renders the
 * same way, inside `[…]`; a number or boolean renders as itself.
 */
export function formatEchoValue(value: unknown): string {
  if (typeof value === 'string') {
    return /[\r\n]/.test(value)
      ? `\n${markdown().codeBlock(value).build()}\n`
      : markdown().inlineCode(value).build();
  }
  if (Array.isArray(value)) return `[${value.map(formatEchoValue).join(', ')}]`;
  return String(value);
}

/**
 * The searchCriteria trailer of `clinicaltrials_search_studies` and
 * `clinicaltrials_get_study_count`: one `- **key:** value` line per criterion.
 */
export function formatSearchCriteria(criteria: Record<string, unknown>): string {
  const lines = Object.entries(criteria).map(
    ([key, value]) => `- **${key}:** ${formatEchoValue(value)}`,
  );
  return `**Search Criteria:**\n${lines.join('\n')}`;
}
