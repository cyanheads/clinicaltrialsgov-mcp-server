/**
 * @fileoverview Tests for the large-document download URL builder.
 * @module tests/services/clinical-trials/document-url
 */

import { describe, expect, it } from 'vitest';

import { buildDocumentDownloadUrl } from '@/services/clinical-trials/document-url.js';

describe('buildDocumentDownloadUrl', () => {
  it('builds the CDN path from the last two digits of the NCT number', () => {
    expect(buildDocumentDownloadUrl('NCT03722472', 'Prot_000.pdf')).toBe(
      'https://cdn.clinicaltrials.gov/large-docs/72/NCT03722472/Prot_000.pdf',
    );
    expect(buildDocumentDownloadUrl('NCT03722472', 'SAP_001.pdf')).toBe(
      'https://cdn.clinicaltrials.gov/large-docs/72/NCT03722472/SAP_001.pdf',
    );
  });

  it('keeps a zero-padded prefix at the 00 boundary', () => {
    // The prefix is the NCT number's own last two digits, so a study ending in
    // 00 gets `00` — not a trimmed `0`, which resolves to nothing upstream.
    expect(buildDocumentDownloadUrl('NCT03607500', 'Prot_SAP_000.pdf')).toBe(
      'https://cdn.clinicaltrials.gov/large-docs/00/NCT03607500/Prot_SAP_000.pdf',
    );
    expect(buildDocumentDownloadUrl('NCT00000009', 'ICF_002.pdf')).toBe(
      'https://cdn.clinicaltrials.gov/large-docs/09/NCT00000009/ICF_002.pdf',
    );
  });

  it('derives a distinct prefix per NCT ID', () => {
    // A fixed prefix would 404: the segment is keyed to the study, not global.
    const a = buildDocumentDownloadUrl('NCT02798952', 'Prot_000.pdf');
    const b = buildDocumentDownloadUrl('NCT03789097', 'Prot_000.pdf');
    expect(a).toContain('/large-docs/52/');
    expect(b).toContain('/large-docs/97/');
  });

  it('URL-encodes the filename as a single path segment', () => {
    // Filenames are upstream data landing in a URL path — encode rather than
    // trust. A separator inside the name must not escape the segment.
    expect(buildDocumentDownloadUrl('NCT03722472', 'Study Protocol v2.pdf')).toBe(
      'https://cdn.clinicaltrials.gov/large-docs/72/NCT03722472/Study%20Protocol%20v2.pdf',
    );
    expect(buildDocumentDownloadUrl('NCT03722472', '../../etc/passwd')).toBe(
      'https://cdn.clinicaltrials.gov/large-docs/72/NCT03722472/..%2F..%2Fetc%2Fpasswd',
    );
    expect(buildDocumentDownloadUrl('NCT03722472', 'Prot?a=1&b=2.pdf')).toBe(
      'https://cdn.clinicaltrials.gov/large-docs/72/NCT03722472/Prot%3Fa%3D1%26b%3D2.pdf',
    );
  });
});
