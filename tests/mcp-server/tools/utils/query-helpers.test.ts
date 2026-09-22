/**
 * @fileoverview Tests for query helper utilities.
 * @module tests/query-helpers
 */

import { describe, expect, it } from 'vitest';
import {
  blankValueMessage,
  buildAdvancedFilter,
  normalizeStatusFilter,
  quoteQueryTerm,
  toArray,
} from '@/mcp-server/tools/utils/query-helpers.js';

describe('normalizeStatusFilter (#140)', () => {
  it('returns undefined when the filter is omitted', () => {
    expect(normalizeStatusFilter(undefined)).toBeUndefined();
  });

  it.each([
    ['recruiting', 'RECRUITING'],
    ['Active Not Recruiting', 'ACTIVE_NOT_RECRUITING'],
    ['not-yet-recruiting', 'NOT_YET_RECRUITING'],
    ['  enrolling \t by - invitation  ', 'ENROLLING_BY_INVITATION'],
    ['no__longer__available', 'NO_LONGER_AVAILABLE'],
    ['APPROVED_FOR_MARKETING', 'APPROVED_FOR_MARKETING'],
  ])('canonicalizes %j to %s', (raw, canonical) => {
    expect(normalizeStatusFilter(raw)).toEqual([canonical]);
  });

  it('normalizes each entry of a list and of a stringified list', () => {
    expect(normalizeStatusFilter(['recruiting', 'Completed'])).toEqual(['RECRUITING', 'COMPLETED']);
    expect(normalizeStatusFilter('["recruiting","withdrawn"]')).toEqual([
      'RECRUITING',
      'WITHDRAWN',
    ]);
  });

  it('leaves a delimiter-joined canonical value intact', () => {
    // Upstream splits filter.overallStatus on `|` and `,`; neither is a separator run here.
    expect(normalizeStatusFilter('RECRUITING|COMPLETED')).toEqual(['RECRUITING|COMPLETED']);
    expect(normalizeStatusFilter('recruiting,completed')).toEqual(['RECRUITING,COMPLETED']);
  });

  it('drops whitespace around a delimiter instead of turning it into an underscore', () => {
    // Upstream rejects ` COMPLETED` and `RECRUITING ` alike, and `_COMPLETED` would
    // name a value the caller never sent.
    expect(normalizeStatusFilter('recruiting, completed')).toEqual(['RECRUITING,COMPLETED']);
    expect(normalizeStatusFilter('Recruiting | Not Yet Recruiting')).toEqual([
      'RECRUITING|NOT_YET_RECRUITING',
    ]);
    expect(normalizeStatusFilter(['active not recruiting ,withdrawn'])).toEqual([
      'ACTIVE_NOT_RECRUITING,WITHDRAWN',
    ]);
  });

  it('maps the registry display labels that differ from their API value', () => {
    expect(normalizeStatusFilter('Active, not recruiting')).toEqual(['ACTIVE_NOT_RECRUITING']);
    expect(normalizeStatusFilter('Unknown status')).toEqual(['UNKNOWN']);
    expect(normalizeStatusFilter(['Recruiting', 'Active, not recruiting'])).toEqual([
      'RECRUITING',
      'ACTIVE_NOT_RECRUITING',
    ]);
    expect(normalizeStatusFilter('Recruiting, Active, not recruiting | Unknown status')).toEqual([
      'RECRUITING,ACTIVE_NOT_RECRUITING|UNKNOWN',
    ]);
    // Only a whole list token is aliased.
    expect(normalizeStatusFilter('INACTIVE,NOT_RECRUITING')).toEqual(['INACTIVE,NOT_RECRUITING']);
  });

  it('reduces a blank entry to an empty string, which the blank-value check still catches', () => {
    expect(normalizeStatusFilter(['RECRUITING', ' \t '])).toEqual(['RECRUITING', '']);
    expect(normalizeStatusFilter([])).toEqual([]);
  });

  it('maps a value with no canonical match to its normalized form, never to a different status', () => {
    expect(normalizeStatusFilter('open to enrollment')).toEqual(['OPEN_TO_ENROLLMENT']);
  });
});

describe('toArray', () => {
  it('returns undefined for undefined input', () => {
    expect(toArray(undefined)).toBeUndefined();
  });

  it('wraps a string in an array', () => {
    expect(toArray('RECRUITING')).toEqual(['RECRUITING']);
  });

  it('passes arrays through unchanged', () => {
    const arr = ['RECRUITING', 'COMPLETED'];
    expect(toArray(arr)).toBe(arr);
  });

  it('handles empty string', () => {
    expect(toArray('')).toEqual(['']);
  });

  it('handles empty array', () => {
    expect(toArray([])).toEqual([]);
  });

  it('parses a JSON-stringified string array (#75)', () => {
    expect(toArray('["RECRUITING","COMPLETED"]')).toEqual(['RECRUITING', 'COMPLETED']);
  });

  it('parses a single-element JSON-stringified array (#75)', () => {
    expect(toArray('["OverallStatus"]')).toEqual(['OverallStatus']);
  });

  it('parses a whitespace-padded JSON-stringified array (#75)', () => {
    expect(toArray('  ["PHASE1", "PHASE2"]  ')).toEqual(['PHASE1', 'PHASE2']);
  });

  it('scalar-wraps a truncated "[" string rather than parsing (#75)', () => {
    expect(toArray('[')).toEqual(['[']);
  });

  it('scalar-wraps a JSON array with non-string elements (#75)', () => {
    expect(toArray('[1, 2]')).toEqual(['[1, 2]']);
  });

  it('scalar-wraps a JSON object string — only [-leading values are parsed (#75)', () => {
    expect(toArray('{"a":1}')).toEqual(['{"a":1}']);
  });
});

describe('buildAdvancedFilter', () => {
  it('returns undefined when both args are empty', () => {
    expect(buildAdvancedFilter(undefined, undefined)).toBeUndefined();
    expect(buildAdvancedFilter([], undefined)).toBeUndefined();
    expect(buildAdvancedFilter([], '')).toBeUndefined();
  });

  it('builds single phase filter', () => {
    expect(buildAdvancedFilter(['PHASE3'])).toBe('AREA[Phase]PHASE3');
  });

  it('builds multi-phase filter with OR', () => {
    expect(buildAdvancedFilter(['PHASE1', 'PHASE2'])).toBe(
      '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2)',
    );
  });

  it('passes through advancedFilter alone', () => {
    expect(buildAdvancedFilter(undefined, 'AREA[StudyType]INTERVENTIONAL')).toBe(
      'AREA[StudyType]INTERVENTIONAL',
    );
  });

  it('combines phase filter with advancedFilter using AND', () => {
    expect(buildAdvancedFilter(['PHASE3'], 'AREA[StudyType]INTERVENTIONAL')).toBe(
      'AREA[Phase]PHASE3 AND (AREA[StudyType]INTERVENTIONAL)',
    );
  });

  it('combines multi-phase filter with advancedFilter', () => {
    expect(buildAdvancedFilter(['PHASE1', 'PHASE2'], 'AREA[StudyType]INTERVENTIONAL')).toBe(
      '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2) AND (AREA[StudyType]INTERVENTIONAL)',
    );
  });

  // Essie applies no precedence rule that scopes a trailing OR back under a
  // preceding AND, so an ungrouped caller expression let the OR branch escape
  // the phase constraint entirely — a PHASE3 search returning phase-less
  // observational studies (#117).
  it('groups an OR-carrying advancedFilter under the phase constraint (#117)', () => {
    expect(
      buildAdvancedFilter(
        ['PHASE3'],
        'AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL',
      ),
    ).toBe('AREA[Phase]PHASE3 AND (AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL)');
  });

  it('groups an OR-carrying advancedFilter under a multi-phase constraint (#117)', () => {
    expect(
      buildAdvancedFilter(
        ['PHASE3', 'PHASE4'],
        'AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL',
      ),
    ).toBe(
      '(AREA[Phase]PHASE3 OR AREA[Phase]PHASE4) AND (AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL)',
    );
  });

  // Essie tolerates redundant nested parentheses, so the wrap is unconditional
  // rather than conditional on detecting the caller's own grouping — a detector
  // would have to reimplement the parser to know whether an outer `(` closes at
  // the end of the expression or mid-way (#117).
  it('wraps an already-parenthesized advancedFilter without corrupting it (#117)', () => {
    expect(
      buildAdvancedFilter(
        ['PHASE3'],
        '(AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL)',
      ),
    ).toBe(
      'AREA[Phase]PHASE3 AND ((AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL))',
    );
  });

  it('leaves an advancedFilter-only expression ungrouped (#117)', () => {
    // No AND boundary exists to leak past, so the caller's expression reaches
    // upstream exactly as written.
    expect(
      buildAdvancedFilter(
        undefined,
        'AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL',
      ),
    ).toBe('AREA[StudyType]INTERVENTIONAL OR AREA[StudyType]OBSERVATIONAL');
  });
});

describe('quoteQueryTerm (#118)', () => {
  it('quotes a multiword term so it matches as a literal phrase', () => {
    expect(quoteQueryTerm('East Northport')).toBe('"East Northport"');
    expect(quoteQueryTerm('United States')).toBe('"United States"');
  });

  it('leaves a single-word term bare', () => {
    expect(quoteQueryTerm('Toronto')).toBe('Toronto');
    expect(quoteQueryTerm('Asthma')).toBe('Asthma');
  });

  // Upstream Essie has no working escape for a `"` inside a quoted phrase: an
  // unescaped one silently reparses into a different query and a backslash-
  // escaped one matches nothing. Stripping is the only safe handling.
  it('strips an embedded double quote rather than escaping it', () => {
    expect(quoteQueryTerm('East "Northport" City')).toBe('"East Northport City"');
    expect(quoteQueryTerm('Sea"ttle')).toBe('Seattle');
  });

  it('quotes on any whitespace, not just a literal space', () => {
    expect(quoteQueryTerm('New\tYork')).toBe('"New\tYork"');
  });
});

describe('blankValueMessage', () => {
  it('names the parameter and every blank shape it covers', () => {
    const msg = blankValueMessage('nctIds');
    expect(msg).toContain("Parameter 'nctIds'");
    expect(msg).toContain('empty or whitespace-only string');
    expect(msg).toContain('empty list');
    expect(msg).toContain('list carrying a blank entry');
  });

  it('leads the recovery clause with supplying a value, not omitting it (#113)', () => {
    // nctIds is required — a caller who omits it gets a bare -32602.
    const msg = blankValueMessage('nctIds');
    expect(msg.indexOf('Supply a value containing non-whitespace')).toBeGreaterThan(-1);
    expect(msg.indexOf('Supply a value containing non-whitespace')).toBeLessThan(
      msg.indexOf('omit'),
    );
  });

  it('spells out the list-entry recovery, not just the scalar one (#113)', () => {
    expect(blankValueMessage('fields')).toContain('non-blank entry');
  });
});
