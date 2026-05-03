/**
 * @fileoverview Indexing and ranked-search utilities over the ClinicalTrials.gov
 * field model. Flattens the metadata tree into a flat list of valid field
 * identifiers (PascalCase `piece` names) and provides a scoring function used
 * for both keyword discovery and "did you mean" suggestions on validation.
 * @module services/clinical-trials/field-search
 */

import type { FieldNode } from './types.js';

/** A flattened entry for one field in the ClinicalTrials.gov data model. */
export interface FieldIndexEntry {
  /** Field description from the data model. */
  description?: string;
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

/** Walk the metadata tree and emit one entry per node that has a `piece` name. */
export function flattenMetadata(tree: FieldNode[]): FieldIndexEntry[] {
  const entries: FieldIndexEntry[] = [];
  const walk = (nodes: FieldNode[], parentPath: string) => {
    for (const node of nodes) {
      const path = parentPath ? `${parentPath}.${node.name}` : node.name;
      if (node.piece) {
        const e: FieldIndexEntry = { piece: node.piece, path, name: node.name };
        if (node.type) e.type = node.type;
        if (node.sourceType) e.sourceType = node.sourceType;
        if (node.isEnum != null) e.isEnum = node.isEnum;
        if (node.description) e.description = node.description;
        entries.push(e);
      }
      if (node.children) walk(node.children, path);
    }
  };
  walk(tree, '');
  return entries;
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

  const denom = Math.max(1, qSet.size);
  return Math.round((pieceHits * 200 + pathHits * 60 + descHits * 30) / denom);
}

/** Rank entries by relevance to query and return the top `limit`. */
export function searchFields(
  query: string,
  entries: FieldIndexEntry[],
  limit: number,
): FieldIndexEntry[] {
  const scored = entries.map((e) => ({ e, s: scoreEntry(query, e) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, Math.max(1, limit)).map((x) => x.e);
}

/**
 * Suggest the closest valid `piece` names to an invalid input. Uses the same
 * keyword scoring first, falls back to Levenshtein distance for typos that
 * don't share token-level signal (e.g., `ConditionList` → `Condition`).
 */
export function nearestPieces(invalid: string, entries: FieldIndexEntry[], n = 3): string[] {
  const scored = entries
    .map((e) => ({ piece: e.piece, score: scoreEntry(invalid, e) }))
    .filter((x) => x.score > 0);
  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map((x) => x.piece);
  }
  const target = invalid.toLowerCase();
  return entries
    .map((e) => ({ piece: e.piece, dist: levenshtein(target, e.piece.toLowerCase()) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n)
    .map((x) => x.piece);
}
