/**
 * @fileoverview Download URL for a study's uploaded large documents (protocol,
 * SAP, ICF). The API's `LargeDoc` schema carries a bare `filename` and no URL,
 * so the location is assembled here from the CDN's observed layout rather than
 * read from upstream data. Kept in its own module so tests that mock the
 * service module still reach it.
 * @module services/clinical-trials/document-url
 */

/** Where ClinicalTrials.gov serves uploaded study documents. */
const DOCUMENT_CDN_BASE = 'https://cdn.clinicaltrials.gov/large-docs';

/**
 * Location of one uploaded study document.
 *
 * The path is `{base}/{XX}/{nctId}/{filename}`, where `XX` is the last two
 * digits of the NCT number — a per-study shard, not a fixed segment: the same
 * filename under another study's prefix 404s. Taken from the record's own NCT
 * ID rather than the one a caller asked for, since upstream resolves a previous
 * (alias) ID to its canonical record and the shard follows the canonical ID.
 *
 * This is an observed CDN pattern, not a documented API contract — the official
 * OpenAPI v2 `LargeDoc` schema defines no URL field of any kind.
 */
export function buildDocumentDownloadUrl(nctId: string, filename: string): string {
  const shard = nctId.slice(-2);
  return `${DOCUMENT_CDN_BASE}/${shard}/${nctId}/${encodeURIComponent(filename)}`;
}
