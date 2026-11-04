/**
 * @fileoverview Indexing and ranked-search utilities over the ClinicalTrials.gov
 * field model. Flattens the metadata tree into a flat list of valid field
 * identifiers (PascalCase `piece` names), provides a scoring function used
 * for both keyword discovery and "did you mean" suggestions on validation, and
 * corrects the case of `AREA[…]` field names in caller expressions — record
 * pieces first, then the index-only pieces and search areas beyond them.
 * @module services/clinical-trials/field-search
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { FieldNode, SearchAreaGroup } from './types.js';

/** A flattened entry for one field in the ClinicalTrials.gov data model. */
export interface FieldIndexEntry {
  /**
   * Legacy names upstream also resolves inside `AREA[…]` (`OVERALL-STATUS` for
   * OverallStatus, `SPONSOR` for LeadSponsorName). Absent when the node lists none.
   */
  altPieceNames?: string[];
  /** Field description from the data model. */
  description?: string;
  /**
   * Whether any ancestor node on this entry's path is array-typed (own `type`
   * ending in `[]`). A scalar leaf under a repeated object occurs once per
   * repetition, so it carries the same multi-valued cardinality an array-typed
   * leaf does. Additive and independent of `type`, which stays the node's own
   * declared type. Absent (not `false`) when no ancestor repeats.
   */
  hasArrayAncestor?: boolean;
  /** Whether the field is an enum. */
  isEnum?: boolean;
  /** camelCase tree name. */
  name: string;
  /** Full dot-notation path in the study record. */
  path: string;
  /** PascalCase identifier used in `fields`, `AREA[]`, and `sort` parameters. */
  piece: string;
  /** Source data type from the upstream model. */
  sourceType?: string;
  /** Data type (STRING, INTEGER, DATE, ENUM, BOOLEAN, etc.). */
  type?: string;
}

/**
 * Walk the metadata tree and emit one entry per node that has a `piece` name.
 *
 * The walk threads repeated-ancestor state down the path: a node whose own
 * `type` ends in `[]` marks everything beneath it, so a scalar leaf under a
 * repeated object (`LocationCountry` under `locations: Location[]`) is
 * recoverable as multi-valued. The flag describes ancestry only — an
 * array-typed node does not set it on itself, since its own `type` already
 * says so.
 */
export function flattenMetadata(tree: FieldNode[]): FieldIndexEntry[] {
  const entries: FieldIndexEntry[] = [];
  const walk = (nodes: FieldNode[], parentPath: string, underArray: boolean) => {
    for (const node of nodes) {
      const path = parentPath ? `${parentPath}.${node.name}` : node.name;
      if (node.piece) {
        const e: FieldIndexEntry = { piece: node.piece, path, name: node.name };
        if (node.type) e.type = node.type;
        if (node.sourceType) e.sourceType = node.sourceType;
        if (node.isEnum != null) e.isEnum = node.isEnum;
        if (node.description) e.description = node.description;
        if (node.altPieceNames?.length) e.altPieceNames = node.altPieceNames;
        if (underArray) e.hasArrayAncestor = true;
        entries.push(e);
      }
      if (node.children) walk(node.children, path, underArray || isArrayType(node.type));
    }
  };
  walk(tree, '', false);
  return entries;
}

/** Whether a metadata node's own declared type marks it as repeated (`Location[]`). */
export function isArrayType(type: string | undefined): boolean {
  return type?.endsWith('[]') ?? false;
}

/** Tokenize a string into lowercase parts: splits CamelCase, digits, words. */
function tokens(s: string): string[] {
  const parts = s.match(/[A-Z][a-z]+|[A-Z]+(?=[A-Z]|$)|[a-z]+|\d+/g) ?? [];
  return parts.map((t) => t.toLowerCase());
}

/** Light singularization: drop a trailing 's' on tokens of length ≥ 4 (skips "ss"). */
function stem(t: string): string {
  if (t.length >= 4 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Iterative Levenshtein distance with two-row buffer. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const prev: number[] = new Array(lb + 1);
  const curr: number[] = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const left = curr[j - 1] ?? 0;
      const up = prev[j] ?? 0;
      const diag = prev[j - 1] ?? 0;
      curr[j] = Math.min(left + 1, up + 1, diag + cost);
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[lb] ?? 0;
}

/**
 * Score a query against a single field index entry. Higher = better match.
 * 0 means no relevance signal.
 */
function scoreEntry(query: string, entry: FieldIndexEntry): number {
  const ql = query.toLowerCase().trim();
  if (!ql) return 0;
  const piece = entry.piece.toLowerCase();

  if (piece === ql) return 10_000;
  if (piece.startsWith(ql)) return 5_000 + Math.round((ql.length / piece.length) * 1_000);
  if (piece.includes(ql)) return 3_000 + Math.round((ql.length / piece.length) * 1_000);
  if (ql.includes(piece) && piece.length >= 4)
    return 2_500 + Math.round((piece.length / ql.length) * 1_000);

  const qSet = new Set([
    ...ql
      .split(/[\s.]+/)
      .filter(Boolean)
      .map(stem),
    ...tokens(query).map(stem),
  ]);
  const pieceTokens = new Set(tokens(entry.piece).map(stem));
  const pieceTokensArr = [...pieceTokens];
  const pathTokens = new Set(entry.path.split('.').flatMap(tokens).map(stem));
  const descTokens = new Set(
    (entry.description ?? '').toLowerCase().split(/\W+/).filter(Boolean).map(stem),
  );

  let pieceHits = 0;
  let pathHits = 0;
  let descHits = 0;
  for (const qt of qSet) {
    if (pieceTokens.has(qt)) pieceHits += 1;
    else if (pieceTokensArr.some((t) => t.startsWith(qt) && qt.length >= 3)) pieceHits += 0.6;
    else if (pieceTokensArr.some((t) => t.includes(qt) && qt.length >= 4)) pieceHits += 0.3;

    if (pathTokens.has(qt)) pathHits += 1;
    if (descTokens.has(qt)) descHits += 1;
  }

  // Reward fields whose identity the match mostly covers: hitting 1 of
  // OverallStatus's 2 tokens beats 1 of ExpandedAccessStatusForNCTId's 6.
  // Without this, every field sharing one common token (e.g. "Status") ties and
  // breaks by index order, sinking the canonical short field below long ones.
  const pieceCoverage = pieceHits / Math.max(1, pieceTokens.size);

  const denom = Math.max(1, qSet.size);
  return Math.round(
    (pieceHits * 200 + pieceCoverage * 300 + pathHits * 60 + descHits * 30) / denom,
  );
}

/**
 * Rank entries by relevance to query and return the top `limit` along with the
 * pre-cap match total, so callers can disclose truncation accurately — the slice
 * alone can't distinguish "exactly `limit` matched" from "more than `limit`".
 */
export function searchFields(
  query: string,
  entries: FieldIndexEntry[],
  limit: number,
): { entries: FieldIndexEntry[]; total: number } {
  const scored = entries.map((e) => ({ e, s: scoreEntry(query, e) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return { entries: scored.slice(0, Math.max(1, limit)).map((x) => x.e), total: scored.length };
}

/**
 * Floor a keyword-scored suggestion must clear. Sits above the most a candidate
 * can earn with no piece-name evidence at all — a lone path token (60), a lone
 * description token (30), or both (90) — so a coincidence in the metadata
 * surrounding a field never reads as a did-you-mean.
 */
const MIN_SUGGESTION_SCORE = 100;

/**
 * Ceiling on edit distance as a fraction of the longer string, for the fallback
 * path. A near miss stays well under it (`Enrolment` → `EnrollmentCount` is
 * 0.40); a name sharing no structure with any piece sits at or near 1.0.
 */
const MAX_SUGGESTION_DISTANCE_RATIO = 0.5;

/**
 * Edits an index-only piece or search area may sit from the input and still
 * lead the suggestions: `NumLocation` → `NumLocations` (1), `NumberOfLocations`
 * → `NumLocations` through its alt name `NUMBER-OF-LOCATIONS` (2).
 */
const MAX_EXTENDED_SUGGESTION_EDITS = 2;

/**
 * Suggest the closest valid `piece` names to an invalid input. Uses the same
 * keyword scoring first, falls back to Levenshtein distance for typos that
 * don't share token-level signal (e.g., `ConditionList` → `Condition`).
 *
 * Both paths drop candidates clearing no minimum similarity, so an input
 * related to no piece name yields nothing rather than the nearest of the
 * unrelated. Callers already render the no-suggestion case: the message still
 * names the invalid input and points at `clinicaltrials_get_field_definitions`.
 *
 * `extras` — index-only pieces and search areas — never enter that ranking.
 * Scored beside the record pieces they would reorder it: `numphases` contains
 * `phases`, so `NumPhases` would outrank `Phase` for `Phases`, and every search
 * area shares the `Search` token. An extended name instead leads the list only
 * when it is a near miss of the input (see nearExtendedNames), ahead of the
 * record pieces ranked as above.
 */
export function nearestPieces(
  invalid: string,
  entries: FieldIndexEntry[],
  n = 3,
  extras: readonly ExtendedName[] = [],
): string[] {
  return [...nearExtendedNames(invalid, extras), ...nearestRecordPieces(invalid, entries, n)].slice(
    0,
    n,
  );
}

/**
 * The extended pieces within MAX_EXTENDED_SUGGESTION_EDITS of `invalid`,
 * case-insensitive, matched on the piece or any of its alt names and named by
 * the piece, nearest first. A name exactly as the caller wrote it is skipped —
 * it is the name they sent. A name whose length differs from the input's by
 * more than the limit cannot be within it, so a long input costs one length
 * comparison per name rather than an edit-distance table.
 */
function nearExtendedNames(invalid: string, extras: readonly ExtendedName[]): string[] {
  if (extras.length === 0) return [];
  const target = invalid.toLowerCase();
  const nearest = new Map<string, number>();
  for (const { piece, names } of extras) {
    for (const name of names) {
      if (
        name === invalid ||
        Math.abs(name.length - target.length) > MAX_EXTENDED_SUGGESTION_EDITS
      ) {
        continue;
      }
      const dist = levenshtein(target, name.toLowerCase());
      if (dist <= MAX_EXTENDED_SUGGESTION_EDITS && dist < (nearest.get(piece) ?? Infinity)) {
        nearest.set(piece, dist);
      }
    }
  }
  return [...nearest].sort((a, b) => a[1] - b[1]).map(([piece]) => piece);
}

/** nearestPieces over the record entries alone. */
function nearestRecordPieces(invalid: string, entries: FieldIndexEntry[], n: number): string[] {
  const scored = entries
    .map((e) => ({ piece: e.piece, score: scoreEntry(invalid, e) }))
    .filter((x) => x.score >= MIN_SUGGESTION_SCORE);
  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map((x) => x.piece);
  }
  const target = invalid.toLowerCase();
  return entries
    .map((e) => {
      const piece = e.piece.toLowerCase();
      const dist = levenshtein(target, piece);
      return { piece: e.piece, dist, ratio: dist / Math.max(target.length, piece.length) };
    })
    .filter((x) => x.ratio <= MAX_SUGGESTION_DISTANCE_RATIO)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n)
    .map((x) => x.piece);
}

/** The names a tier resolves as written, and the piece each lowercased form names. */
export interface NameFold {
  /**
   * Lowercased name → the piece it names, for each lowercased form that reaches
   * exactly one piece. A form two pieces share is left out, so a fold never
   * picks between them.
   */
  fold: Map<string, string>;
  /** Every name upstream resolves as written: each piece and its altPieceNames. */
  names: Set<string>;
}

/** Fold each `[name, piece]` pair into one NameFold. */
function foldNames(pairs: Iterable<readonly [name: string, piece: string]>): NameFold {
  const names = new Set<string>();
  const targets = new Map<string, Set<string>>();
  for (const [name, piece] of pairs) {
    names.add(name);
    const key = name.toLowerCase();
    const pieces = targets.get(key) ?? new Set<string>();
    pieces.add(piece);
    targets.set(key, pieces);
  }
  const fold = new Map<string, string>();
  for (const [key, pieces] of targets) {
    const [piece] = pieces;
    if (pieces.size === 1 && piece) fold.set(key, piece);
  }
  return { fold, names };
}

/** An entry's piece and each of its altPieceNames, every one paired with the piece. */
const entryNames = ({ piece, altPieceNames = [] }: FieldIndexEntry) =>
  [piece, ...altPieceNames].map((name) => [name, piece] as const);

/**
 * The names `AREA[…]` resolves among the record pieces. Upstream refuses a
 * `STRUCT` piece there (`LeadSponsor`, `Collaborator` — a group of fields), so
 * the index holds every other piece plus the legacy `altPieceNames` each lists
 * (`OVERALL-STATUS`, `COLLABORATOR`). Leaving the `STRUCT` pieces out is also
 * what keeps the case fold unambiguous: `collaborator` would otherwise name both
 * `Collaborator` and, through its alt name `COLLABORATOR`, `CollaboratorName`.
 */
export interface AreaIndex extends NameFold {
  /** The non-`STRUCT` entries: the pieces AREA[] searches, and the pool its suggestions come from. */
  entries: FieldIndexEntry[];
  /**
   * The `STRUCT` pieces as written: record names AREA[] refuses rather than
   * misses. No index-only piece or search area shares one, so naming one never
   * reads the second tier.
   */
  refused: Set<string>;
}

/** Build the AREA[] name index from the flattened field index. */
export function buildAreaIndex(entries: FieldIndexEntry[]): AreaIndex {
  const queryable = entries.filter((e) => e.sourceType !== 'STRUCT');
  return {
    entries: queryable,
    ...foldNames(queryable.flatMap(entryNames)),
    refused: new Set(entries.filter((e) => e.sourceType === 'STRUCT').map((e) => e.piece)),
  };
}

/**
 * A name AREA[] resolves beyond the record pieces. `index-only`: a search-index
 * piece holding no record value (`NumLocations`, `StudyFirstPostYear`), which
 * `sort` takes too. `search-area`: a group of fields AREA[] searches under one
 * name (`ConditionSearch`), which `sort` refuses (`Unknown sort field`).
 */
export interface ExtendedName {
  kind: 'index-only' | 'search-area';
  /** Every spelling upstream resolves as written: the piece, then its altPieceNames. */
  names: string[];
  /** The spelling a rewrite sends and a suggestion names. */
  piece: string;
}

/**
 * The index-only pieces in a `/studies/metadata?includeIndexedOnly=true` tree:
 * the nodes it flags `indexedOnly`, at whatever depth they sit, with their alt
 * names. Every other node is a record piece the default read already holds.
 */
export function indexOnlyNames(tree: FieldNode[]): ExtendedName[] {
  const found: ExtendedName[] = [];
  const walk = (nodes: FieldNode[]) => {
    for (const node of nodes) {
      if (node.indexedOnly && node.piece) {
        found.push({
          kind: 'index-only',
          piece: node.piece,
          names: [node.piece, ...(node.altPieceNames ?? [])],
        });
      }
      if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return found;
}

/** The areas a `/studies/search-areas` response lists. */
export function searchAreaNames(groups: SearchAreaGroup[]): ExtendedName[] {
  return groups.flatMap(({ areas }) =>
    areas.map(({ name }): ExtendedName => ({ kind: 'search-area', piece: name, names: [name] })),
  );
}

/**
 * The second tier, consulted only for a name the record tier leaves unresolved.
 * Each lookup folds the record names in with the extended ones, so a lowercased
 * form an extended name shares with any other name folds to neither.
 */
export interface ExtendedIndex {
  /** AREA[] lookup: the record AREA names, every index-only name, and every search area. */
  area: NameFold;
  /** The index-only pieces and search areas, the pool a near-miss suggestion comes from. */
  extras: ExtendedName[];
  /** `sort` lookup: every record piece and every index-only name — no search area. */
  sort: NameFold;
}

/** Build the second tier from the default metadata read's entries and the extended names. */
export function buildExtendedIndex(
  entries: FieldIndexEntry[],
  extras: ExtendedName[],
): ExtendedIndex {
  const extraNames = (kind?: ExtendedName['kind']) =>
    extras
      .filter((e) => kind === undefined || e.kind === kind)
      .flatMap(({ piece, names }) => names.map((name) => [name, piece] as const));
  return {
    area: foldNames([
      ...entries.filter((e) => e.sourceType !== 'STRUCT').flatMap(entryNames),
      ...extraNames(),
    ]),
    extras,
    sort: foldNames([
      ...entries.map(({ piece }) => [piece, piece] as const),
      ...extraNames('index-only'),
    ]),
  };
}

/**
 * The spelling to send for `name`: the name itself when a tier holds it as
 * written, else the piece its lowercased form folds to; undefined when neither
 * tier resolves it. The record tier decides whenever it can, so the second tier
 * changes nothing the record tier resolves.
 */
export function resolveName(
  name: string,
  record: NameFold,
  extended?: NameFold,
): string | undefined {
  if (record.names.has(name)) return name;
  const key = name.toLowerCase();
  const folded = record.fold.get(key);
  if (folded || !extended) return folded;
  return extended.names.has(name) ? name : extended.fold.get(key);
}

/**
 * Whether the record tier leaves an AREA[] name unresolved, so the second tier
 * may hold it. A `STRUCT` piece is refused, not missed, and an empty name is no
 * name at all: neither reads the second tier.
 */
export function missesRecordTier(name: string, index: AreaIndex): boolean {
  return name !== '' && !index.refused.has(name) && resolveName(name, index) === undefined;
}

/** One AREA[] name a rewrite changed: as the caller wrote it, and the piece sent in its place. */
export interface AreaNameRewrite {
  from: string;
  to: string;
}

/**
 * Each AREA[] name in an Essie expression, trimmed, with the offset it starts at.
 *
 * One left-to-right pass, no backtracking. Outside a double-quoted literal the
 * uppercase `AREA[` opens a name that ends at the next `]`, inside
 * `SEARCH[Location](…)` as anywhere else; upstream's keywords are uppercase only.
 * Inside a literal `\` escapes the next character and `"` closes it, so literal
 * text is never read as a name, and an unclosed literal leaves the rest
 * unscanned. When no `]` follows an `AREA[`, none can close a later one either,
 * so the scan stops there.
 */
function* areaNames(expression: string): Generator<{ name: string; start: number }> {
  let inLiteral = false;
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (inLiteral) {
      if (c === '\\') i++;
      else if (c === '"') inLiteral = false;
      i++;
    } else if (c === '"') {
      inLiteral = true;
      i++;
    } else if (c === 'A' && expression.startsWith('AREA[', i)) {
      const start = i + 'AREA['.length;
      const end = expression.indexOf(']', start);
      if (end === -1) return;
      const raw = expression.slice(start, end);
      yield { name: raw.trim(), start: start + raw.length - raw.trimStart().length };
      i = end + 1;
    } else {
      i++;
    }
  }
}

/**
 * Rewrite each AREA[] name in an Essie expression that misses only by case to
 * the piece it names: `AREA[overallstatus]` → `AREA[OverallStatus]`, and a
 * legacy alt name in another case to its piece, `AREA[Sponsor]` →
 * `AREA[LeadSponsorName]` (upstream resolves `SPONSOR`). With `extended`, a name
 * the record tier leaves unresolved is looked up there the same way:
 * `AREA[numlocations]` → `AREA[NumLocations]`, `AREA[conditionsearch]` →
 * `AREA[ConditionSearch]`. A name a tier holds as written goes out unchanged,
 * and so does one that folds to no single piece, left for upstream to judge — so
 * a rewrite only ever turns a request upstream would refuse into one it accepts.
 * Surrounding whitespace inside the brackets is kept; upstream trims it.
 */
export function rewriteAreaNames(
  expression: string,
  index: AreaIndex,
  extended?: NameFold,
): { rewrites: AreaNameRewrite[]; text: string } {
  const rewrites: AreaNameRewrite[] = [];
  let text = '';
  let copied = 0;
  for (const { name, start } of areaNames(expression)) {
    const piece = resolveName(name, index, extended);
    if (piece === undefined || piece === name) continue;
    text += expression.slice(copied, start) + piece;
    copied = start + name.length;
    rewrites.push({ from: name, to: piece });
  }
  return rewrites.length === 0
    ? { rewrites, text: expression }
    : { rewrites, text: text + expression.slice(copied) };
}

/**
 * An AREA index as the service hands it out: the record tier, plus the loader
 * for the second tier a record-tier miss consults. Without `extended`, names
 * resolve in the record tier alone.
 */
export interface AreaLookup extends AreaIndex {
  /**
   * The second tier, read at most once per call; undefined when it cannot be
   * read, which leaves the call as it would be without one.
   *
   * @throws the caller's cancellation.
   */
  extended?: () => Promise<ExtendedIndex | undefined>;
}

/** Whether some AREA[] name in `expression` misses the record tier. */
function missesAnywhere(expression: string, index: AreaIndex): boolean {
  for (const { name } of areaNames(expression)) {
    if (missesRecordTier(name, index)) return true;
  }
  return false;
}

/**
 * Apply rewriteAreaNames to each caller expression, keyed by the parameter it
 * came from, and log the rewrites as a notice. The index loads only when an
 * expression contains `AREA[`, so a call naming no AREA[] field never waits on
 * it, and the second tier loads only when a name misses the record tier; with
 * no index, every expression passes through unchanged.
 */
export async function normalizeAreaNames<K extends string>(
  expressions: Record<K, string | undefined>,
  loadIndex: () => Promise<AreaLookup | undefined>,
  log: Context['log'],
): Promise<Record<K, string | undefined>> {
  const params = Object.keys(expressions) as K[];
  if (!params.some((param) => expressions[param]?.includes('AREA['))) return expressions;
  const index = await loadIndex();
  if (!index) return expressions;
  const missed = params.some((param) => missesAnywhere(expressions[param] ?? '', index));
  const extended = missed && index.extended ? (await index.extended())?.area : undefined;
  const normalized = { ...expressions };
  const rewrites: Array<AreaNameRewrite & { param: K }> = [];
  for (const param of params) {
    const expression = expressions[param];
    if (!expression) continue;
    const result = rewriteAreaNames(expression, index, extended);
    normalized[param] = result.text;
    for (const rewrite of result.rewrites) rewrites.push({ param, ...rewrite });
  }
  if (rewrites.length > 0) log.notice('AREA[] field names auto-corrected', { rewrites });
  return normalized;
}
