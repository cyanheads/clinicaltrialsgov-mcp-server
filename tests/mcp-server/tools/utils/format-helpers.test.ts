/**
 * @fileoverview Tests for study format helpers.
 * @module tests/mcp-server/tools/utils/format-helpers
 */

import { describe, expect, it } from 'vitest';
import { formatRemainingStudyFields } from '@/mcp-server/tools/utils/format-helpers.js';

describe('formatRemainingStudyFields', () => {
  it('returns empty array when all fields are already rendered', () => {
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT12345678', briefTitle: 'Title' },
      },
    };
    const rendered = new Set([
      'protocolSection.identificationModule.nctId',
      'protocolSection.identificationModule.briefTitle',
    ]);
    expect(formatRemainingStudyFields(study, rendered)).toEqual([]);
  });

  it('flattens primitive arrays to a single comma-joined leaf', () => {
    const study = {
      protocolSection: { conditionsModule: { keywords: ['a', 'b', 'c', 'd', 'e'] } },
    };
    const lines = formatRemainingStudyFields(study, new Set());
    expect(lines.some((l) => l.includes('a, b, c, d, e'))).toBe(true);
  });

  it('does not emit a "+N more" truncation sentinel for object arrays (regression for #19)', () => {
    // Old behavior: hard-capped object arrays at 3 items and emitted a
    // `[…]: +N more` sentinel. The outer `maxLines` budget already bounds
    // total output, so the per-array cap added noise (and misleadingly
    // suggested truncation occurred even when `maxLines` wouldn't have cut).
    const study = {
      protocolSection: {
        referencesModule: {
          references: [
            { pmid: '1', citation: 'Ref 1' },
            { pmid: '2', citation: 'Ref 2' },
            { pmid: '3', citation: 'Ref 3' },
            { pmid: '4', citation: 'Ref 4' },
            { pmid: '5', citation: 'Ref 5' },
            { pmid: '6', citation: 'Ref 6' },
          ],
        },
      },
    };
    const output = formatRemainingStudyFields(study, new Set(), { maxLines: 20 }).join('\n');
    expect(output).not.toMatch(/\+\d+ more$/m);
    expect(output).not.toContain('[…]');
  });

  it('respects the outer maxLines budget for distinct labels', () => {
    // 6 distinct field labels with maxLines: 3 — the cap should drop 3 and
    // emit a truthful "and 3 more fields" footer.
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT1', briefTitle: 'T', acronym: 'A' },
        statusModule: { overallStatus: 'RECRUITING', studyFirstSubmitDate: '2026-01-01' },
        descriptionModule: { briefSummary: 'S' },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxLines: 3 });
    expect(lines.length).toBe(4); // 3 content + 1 summary
    expect(lines.some((l) => /and 3 more fields/.test(l))).toBe(true);
  });

  it('does not emit "+N more" when leaves dedup below the cap (regression for #38)', () => {
    // 20 interventions all sharing the same label dedup to a single line.
    // Pre-fix logic counted dedup-dropped leaves toward the truncation
    // footer, lying about a cap that didn't actually fire.
    const study = {
      protocolSection: {
        armsInterventionsModule: {
          interventions: Array.from({ length: 20 }, (_, i) => ({
            name: `Drug${i}`,
            type: 'DRUG',
          })),
        },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxLines: 4 });
    expect(lines.some((l) => /more fields/.test(l))).toBe(false);
  });

  it('renders all fields when maxLines is Infinity (regression for #38)', () => {
    // Explicit-fields path passes Infinity so every requested leaf renders.
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT1', briefTitle: 'T' },
        statusModule: {
          startDateStruct: { date: '2024-01-01' },
          primaryCompletionDateStruct: { date: '2025-01-01' },
        },
        armsInterventionsModule: { interventions: [{ name: 'Drug', type: 'DRUG' }] },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(lines.some((l) => /more fields/.test(l))).toBe(false);
    expect(lines.some((l) => l.includes('NCT1'))).toBe(true);
    expect(lines.some((l) => l.includes('Drug'))).toBe(true);
    expect(lines.some((l) => l.includes('2024-01-01'))).toBe(true);
  });

  it('truncates long string values at maxValueLen', () => {
    const longString = 'x'.repeat(500);
    const study = {
      protocolSection: { descriptionModule: { detailedDescription: longString } },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxValueLen: 50 });
    const descLine = lines.find((l) => l.includes('x'));
    expect(descLine).toBeDefined();
    expect(descLine!.endsWith('…')).toBe(true);
  });

  it('skips structural path segments in labels', () => {
    const study = {
      protocolSection: { statusModule: { overallStatus: 'RECRUITING' } },
    };
    const lines = formatRemainingStudyFields(study, new Set());
    const line = lines.find((l) => l.includes('RECRUITING'));
    expect(line).toBeDefined();
    expect(line).not.toContain('protocolSection');
  });
});
