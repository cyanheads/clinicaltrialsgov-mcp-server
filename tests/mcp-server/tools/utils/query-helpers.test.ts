/**
 * @fileoverview Tests for query helper utilities.
 * @module tests/query-helpers
 */

import { describe, expect, it } from 'vitest';
import {
  blankValueMessage,
  buildAdvancedFilter,
  firstBlankListParam,
  firstInvalidPhase,
  invalidPhaseRejection,
  normalizePhaseFilter,
  normalizeStatusFilter,
  PHASE_VALUES,
  queryTermContent,
  quoteQueryTerm,
  splitListEntries,
  toArray,
} from '@/mcp-server/tools/utils/query-helpers.js';

describe('splitListEntries (#152)', () => {
  it('returns undefined when the list is omitted', () => {
    expect(splitListEntries(undefined)).toBeUndefined();
  });

  it.each([
    [['NCTId,BriefTitle'], ['NCTId', 'BriefTitle']],
    [['NCTId|BriefTitle'], ['NCTId', 'BriefTitle']],
    [['NCTId, BriefTitle'], ['NCTId', 'BriefTitle']],
    [[' NCTId | BriefTitle ,OverallStatus'], ['NCTId', 'BriefTitle', 'OverallStatus']],
    [['NCTId,'], ['NCTId']],
    [
      ['NCTId', 'BriefTitle'],
      ['NCTId', 'BriefTitle'],
    ],
    [
      ['NCTId,BriefTitle', 'Phase'],
      ['NCTId', 'BriefTitle', 'Phase'],
    ],
  ])('splits %j into %j', (input, output) => {
    expect(splitListEntries(input)).toEqual(output);
  });

  it('keeps an entry that splits to nothing as a blank the blank-value check catches', () => {
    expect(splitListEntries([','])).toEqual(['']);
    expect(splitListEntries(['NCTId', ''])).toEqual(['NCTId', '']);
    expect(splitListEntries(['NCTId', ' | '])).toEqual(['NCTId', '']);
    expect(splitListEntries([])).toEqual([]);
    for (const list of [[','], ['NCTId', ''], []]) {
      expect(firstBlankListParam({ fields: splitListEntries(list) })).toBe('fields');
    }
  });

  it('drops repeated names, keeping the first occurrence in order', () => {
    expect(splitListEntries(['NCTId,BriefTitle,NCTId', 'BriefTitle|Phase'])).toEqual([
      'NCTId',
      'BriefTitle',
      'Phase',
    ]);
    expect(splitListEntries(['NCTId,'.repeat(1000)])).toEqual(['NCTId']);
  });

  it('treats a piece of only invisible format characters as empty', () => {
    expect(splitListEntries(['​'])).toEqual(['']);
    expect(splitListEntries(['NCTId,​', '⁠ | ‍'])).toEqual(['NCTId', '']);
    expect(firstBlankListParam({ fields: splitListEntries(['​']) })).toBe('fields');
  });
});

describe('normalizePhaseFilter (#144)', () => {
  it('returns undefined when the filter is omitted', () => {
    expect(normalizePhaseFilter(undefined)).toBeUndefined();
  });

  it.each([
    ['phase3', 'PHASE3'],
    [' Phase3 ', 'PHASE3'],
    ['Phase 3', 'PHASE3'],
    ['phase-3', 'PHASE3'],
    ['"PHASE3"', 'PHASE3'],
    ["'PHASE3'", 'PHASE3'],
    ['na', 'NA'],
    ['Not Applicable', 'NA'],
    ['not_applicable', 'NA'],
    ['early_phase1', 'EARLY_PHASE1'],
    ['Early Phase 1', 'EARLY_PHASE1'],
    ['EARLY PHASE1', 'EARLY_PHASE1'],
    ['phase\t4', 'PHASE4'],
  ])('resolves %j to %s', (raw, canonical) => {
    expect(normalizePhaseFilter(raw)).toEqual([canonical]);
  });

  it('leaves every canonical value unchanged', () => {
    expect(normalizePhaseFilter([...PHASE_VALUES])).toEqual([...PHASE_VALUES]);
  });

  it('splits delimiter-joined and stringified lists before resolving', () => {
    expect(normalizePhaseFilter('PHASE2,PHASE3')).toEqual(['PHASE2', 'PHASE3']);
    expect(normalizePhaseFilter('phase 2 | Phase 3')).toEqual(['PHASE2', 'PHASE3']);
    expect(normalizePhaseFilter('["phase1","Phase 2"]')).toEqual(['PHASE1', 'PHASE2']);
    expect(normalizePhaseFilter(['Not Applicable', 'early phase 1,phase1'])).toEqual([
      'NA',
      'EARLY_PHASE1',
      'PHASE1',
    ]);
  });

  it('returns an entry naming no phase as written (trimmed), never as a different phase', () => {
    expect(normalizePhaseFilter(' PHASE3 OR AREA[StudyType]OBSERVATIONAL ')).toEqual([
      'PHASE3 OR AREA[StudyType]OBSERVATIONAL',
    ]);
    expect(normalizePhaseFilter(['PHASE5', '3', 'PHASE1/PHASE2', '(PHASE3)'])).toEqual([
      'PHASE5',
      '3',
      'PHASE1/PHASE2',
      '(PHASE3)',
    ]);
  });

  it('reduces a blank entry, or one that splits to nothing, to an empty string', () => {
    expect(normalizePhaseFilter(',')).toEqual(['']);
    expect(normalizePhaseFilter(['PHASE3', ' '])).toEqual(['PHASE3', '']);
    expect(normalizePhaseFilter([])).toEqual([]);
  });

  it('reduces an entry of only quotes, whitespace, and format characters to an empty string', () => {
    for (const blank of ['""', '" "', "''", '​', '"​"', ' ⁠ , "" ']) {
      expect(normalizePhaseFilter(blank)).toEqual(['']);
    }
    expect(normalizePhaseFilter(['PHASE3', '""'])).toEqual(['PHASE3', '']);
    expect(normalizePhaseFilter('PHASE3,""')).toEqual(['PHASE3']);
  });

  it('returns the whole entry a non-phase piece came from, not the split fragment', () => {
    expect(normalizePhaseFilter('RANGE[PHASE1,PHASE3]')).toEqual([
      'RANGE[PHASE1,PHASE3]',
      'RANGE[PHASE1,PHASE3]',
    ]);
    expect(normalizePhaseFilter(['PHASE2', ' phase3|PHASE5 '])).toEqual([
      'PHASE2',
      'PHASE3',
      'phase3|PHASE5',
    ]);
    expect(firstInvalidPhase(normalizePhaseFilter('RANGE[PHASE1,PHASE3]'))).toBe(
      'RANGE[PHASE1,PHASE3]',
    );
  });
});

describe('firstInvalidPhase (#144)', () => {
  it('names the first entry that is not a canonical phase', () => {
    expect(firstInvalidPhase(['PHASE3', 'PHASE2 OR PHASE3', 'PHASE5'])).toBe('PHASE2 OR PHASE3');
  });

  it('passes an omitted filter and an all-canonical list', () => {
    expect(firstInvalidPhase(undefined)).toBeUndefined();
    expect(firstInvalidPhase([...PHASE_VALUES])).toBeUndefined();
  });
});

describe('invalidPhaseRejection (#144)', () => {
  it('names the value, the six phases, the list form, and advancedFilter', () => {
    const { message, hint } = invalidPhaseRejection('PHASE2 OR PHASE3');
    expect(message).toBe(
      "Invalid value for `phaseFilter`: 'PHASE2 OR PHASE3' is not a trial phase. Each phaseFilter entry must be one of NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4 — search expressions are not accepted here.",
    );
    expect(hint).toBe(
      'Use one of NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4 per phaseFilter entry, and pass a list such as ["PHASE2","PHASE3"] to match any of several phases. Put every other criterion, including OR/NOT expressions, in advancedFilter.',
    );
  });
});

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

describe('queryTermContent (#145)', () => {
  it('is empty for a value of only quotes and whitespace', () => {
    for (const term of ['', ' ', '""', '" "', ' "\t" ']) expect(queryTermContent(term)).toBe('');
  });

  it('is empty for a value of only invisible format characters, quotes, and whitespace', () => {
    for (const term of ['​', '"​"', ' ⁠‍ ', '﻿​']) {
      expect(queryTermContent(term)).toBe('');
    }
  });

  it('keeps the inner text of a value with non-quote content', () => {
    expect(queryTermContent('"ALS"')).toBe('ALS');
    expect(queryTermContent(' East "Northport" City ')).toBe('East Northport City');
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

  it('keeps the shared text byte-for-byte — tool-specific additions live in the tool (#145)', () => {
    expect(blankValueMessage('nctIds')).toBe(
      "Parameter 'nctIds' was supplied with a blank value — an empty or whitespace-only string, an empty list, or a list carrying a blank entry. Supply a value containing non-whitespace, or for a list at least one non-blank entry; omit the parameter entirely only if it is optional and you meant to leave it unset.",
    );
  });
});
