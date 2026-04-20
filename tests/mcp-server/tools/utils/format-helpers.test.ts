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

  it('respects the outer maxLines budget', () => {
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
    // 4 content lines + possible "... and N more fields" summary
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.some((l) => /more fields/.test(l))).toBe(true);
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
