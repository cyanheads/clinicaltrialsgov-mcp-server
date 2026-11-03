/**
 * @fileoverview Tests for field-search utilities: flattenMetadata, searchFields,
 * nearestPieces, and the AREA[] name index and rewrite.
 * @module tests/services/clinical-trials/field-search
 */

import { createMockLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  type AreaIndex,
  buildAreaIndex,
  type FieldIndexEntry,
  flattenMetadata,
  nearestPieces,
  normalizeAreaNames,
  rewriteAreaNames,
  searchFields,
} from '@/services/clinical-trials/field-search.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';
import { AREA_METADATA, areaIndex, STRUCT_PIECES } from '../../helpers/area-metadata.js';
import { expectLinearGrowth, LINE_BREAK_SHAPES } from '../../helpers/cpu-timing.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleTree: FieldNode[] = [
  {
    name: 'protocolSection',
    children: [
      {
        name: 'identificationModule',
        piece: 'IdentificationModule',
        type: 'OBJECT',
        children: [
          {
            name: 'nctId',
            piece: 'NCTId',
            sourceType: 'STRING',
            type: 'STRING',
            isEnum: false,
            description: 'The NCT identifier for the study.',
          },
          {
            name: 'briefTitle',
            piece: 'BriefTitle',
            sourceType: 'STRING',
            type: 'STRING',
            isEnum: false,
          },
        ],
      },
      {
        name: 'statusModule',
        piece: 'StatusModule',
        type: 'OBJECT',
        children: [
          {
            name: 'overallStatus',
            piece: 'OverallStatus',
            sourceType: 'STRING',
            type: 'STRING',
            isEnum: true,
            description: 'Overall recruitment status of the study.',
          },
        ],
      },
      {
        name: 'designModule',
        piece: 'DesignModule',
        type: 'OBJECT',
        children: [
          {
            name: 'studyType',
            piece: 'StudyType',
            sourceType: 'STRING',
            type: 'STRING',
            isEnum: true,
          },
          {
            name: 'enrollmentInfo',
            type: 'OBJECT',
            children: [
              {
                name: 'count',
                piece: 'EnrollmentCount',
                sourceType: 'INTEGER',
                type: 'INTEGER',
                description: 'Number of participants enrolled in the study.',
              },
            ],
          },
        ],
      },
      {
        name: 'sponsorCollaboratorsModule',
        type: 'OBJECT',
        children: [
          {
            name: 'leadSponsor',
            type: 'OBJECT',
            children: [
              {
                name: 'name',
                piece: 'LeadSponsorName',
                sourceType: 'STRING',
                type: 'STRING',
              },
            ],
          },
          {
            name: 'collaborators',
            type: 'ARRAY',
            children: [
              {
                name: 'name',
                piece: 'CollaboratorName',
                sourceType: 'STRING',
                type: 'STRING',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'resultsSection',
    children: [
      {
        name: 'outcomeMeasuresModule',
        piece: 'OutcomeMeasuresModule',
        type: 'OBJECT',
        children: [
          {
            name: 'outcomeMeasures',
            piece: 'OutcomeMeasure',
            type: 'ARRAY',
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// flattenMetadata
// ---------------------------------------------------------------------------

describe('flattenMetadata', () => {
  it('returns empty array for empty tree', () => {
    expect(flattenMetadata([])).toEqual([]);
  });

  it('returns only nodes with a piece property', () => {
    const entries = flattenMetadata(sampleTree);
    for (const e of entries) {
      expect(e.piece).toBeTruthy();
    }
  });

  it('emits all expected piece names from nested tree', () => {
    const pieces = flattenMetadata(sampleTree).map((e) => e.piece);
    expect(pieces).toContain('NCTId');
    expect(pieces).toContain('BriefTitle');
    expect(pieces).toContain('OverallStatus');
    expect(pieces).toContain('EnrollmentCount');
    expect(pieces).toContain('LeadSponsorName');
    expect(pieces).toContain('CollaboratorName');
  });

  it('includes IdentificationModule and StatusModule (intermediate OBJECT nodes with piece)', () => {
    const pieces = flattenMetadata(sampleTree).map((e) => e.piece);
    expect(pieces).toContain('IdentificationModule');
    expect(pieces).toContain('StatusModule');
  });

  it('builds dot-notation paths correctly', () => {
    const entries = flattenMetadata(sampleTree);
    const nctEntry = entries.find((e) => e.piece === 'NCTId');
    expect(nctEntry?.path).toBe('protocolSection.identificationModule.nctId');

    const enrollEntry = entries.find((e) => e.piece === 'EnrollmentCount');
    expect(enrollEntry?.path).toBe('protocolSection.designModule.enrollmentInfo.count');
  });

  it('copies type, sourceType, isEnum, and description when present', () => {
    const entries = flattenMetadata(sampleTree);
    const nctEntry = entries.find((e) => e.piece === 'NCTId')!;
    expect(nctEntry.type).toBe('STRING');
    expect(nctEntry.sourceType).toBe('STRING');
    expect(nctEntry.isEnum).toBe(false);
    expect(nctEntry.description).toContain('NCT identifier');
  });

  it('does not include description when absent', () => {
    const entries = flattenMetadata(sampleTree);
    const briefTitle = entries.find((e) => e.piece === 'BriefTitle')!;
    expect(briefTitle.description).toBeUndefined();
  });

  it('handles nodes with no children property', () => {
    const tree: FieldNode[] = [{ name: 'leaf', piece: 'Leaf', type: 'STRING' }];
    const entries = flattenMetadata(tree);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.piece).toBe('Leaf');
    expect(entries[0]!.path).toBe('leaf');
  });

  it('handles deeply nested structure without accumulating parent segments as duplicates', () => {
    const deep: FieldNode[] = [
      {
        name: 'a',
        children: [
          {
            name: 'b',
            children: [{ name: 'c', piece: 'DeepField', type: 'STRING' }],
          },
        ],
      },
    ];
    const entries = flattenMetadata(deep);
    expect(entries[0]!.path).toBe('a.b.c');
  });

  // Repeated-ancestor cardinality (#121). The upstream marker is a node's own
  // `type` ending in `[]` (`Location[]`, `Contact[]`); a scalar leaf beneath one
  // occurs once per repetition and carries the same cardinality as an
  // array-typed leaf.
  describe('hasArrayAncestor', () => {
    const repeatedTree: FieldNode[] = [
      {
        name: 'protocolSection',
        children: [
          {
            name: 'statusModule',
            children: [{ name: 'overallStatus', piece: 'OverallStatus', type: 'Status' }],
          },
          {
            name: 'designModule',
            children: [{ name: 'phases', piece: 'Phase', type: 'Phase[]', isEnum: true }],
          },
          {
            name: 'contactsLocationsModule',
            children: [
              {
                name: 'locations',
                piece: 'Location',
                type: 'Location[]',
                children: [
                  { name: 'country', piece: 'LocationCountry', type: 'text' },
                  {
                    name: 'contacts',
                    piece: 'LocationContact',
                    type: 'Contact[]',
                    children: [{ name: 'name', piece: 'LocationContactName', type: 'text' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    const byPiece = (piece: string) =>
      flattenMetadata(repeatedTree).find((e) => e.piece === piece)!;

    it('flags a scalar leaf nested under an array-typed ancestor', () => {
      expect(byPiece('LocationCountry').hasArrayAncestor).toBe(true);
    });

    it('flags a leaf two array-typed ancestors deep', () => {
      expect(byPiece('LocationContactName').hasArrayAncestor).toBe(true);
    });

    it('leaves a field with no array-typed ancestor unflagged rather than false', () => {
      expect(byPiece('OverallStatus').hasArrayAncestor).toBeUndefined();
      expect('hasArrayAncestor' in byPiece('OverallStatus')).toBe(false);
    });

    it('does not flag an array-typed node on itself — its own type already says so', () => {
      const phase = byPiece('Phase');
      expect(phase.type).toBe('Phase[]');
      expect(phase.hasArrayAncestor).toBeUndefined();
    });

    it('flags the nested array-typed node but not the outermost one', () => {
      expect(byPiece('Location').hasArrayAncestor).toBeUndefined();
      expect(byPiece('LocationContact').hasArrayAncestor).toBe(true);
    });

    it("leaves each entry's own declared type untouched", () => {
      expect(byPiece('LocationCountry').type).toBe('text');
      expect(byPiece('LocationContactName').type).toBe('text');
    });
  });

  it('skips nodes where piece is undefined or falsy', () => {
    const tree: FieldNode[] = [
      { name: 'container', type: 'OBJECT', children: [{ name: 'inner', type: 'STRING' }] },
    ];
    expect(flattenMetadata(tree)).toEqual([]);
  });

  // Upstream resolves these legacy names inside AREA[] too (#170).
  it('carries a node’s altPieceNames, and leaves the key off a node listing none', () => {
    const entries = flattenMetadata(AREA_METADATA);
    const byPiece = (piece: string) => entries.find((e) => e.piece === piece)!;
    expect(byPiece('LeadSponsorName').altPieceNames).toEqual(['SPONSOR', 'LEAD-SPONSOR']);
    expect(byPiece('LocationCity').altPieceNames).toEqual(['LOCATION-CITY', 'CITY']);
    expect(byPiece('LocationCity').path).toBe(
      'protocolSection.contactsLocationsModule.locations.city',
    );
    expect('altPieceNames' in byPiece('NCTId')).toBe(false);
    expect('altPieceNames' in byPiece('LeadSponsor')).toBe(false);
    expect(
      'altPieceNames' in flattenMetadata([{ name: 'x', piece: 'X', altPieceNames: [] }])[0]!,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// searchFields
// ---------------------------------------------------------------------------

describe('searchFields', () => {
  it('returns empty entries and zero total for empty entries', () => {
    expect(searchFields('enrollment', [], 5)).toEqual({ entries: [], total: 0 });
  });

  it('returns empty entries for empty query string', () => {
    const e = flattenMetadata(sampleTree);
    // scoreEntry returns 0 for empty query, so nothing passes the filter
    expect(searchFields('', e, 5).entries).toEqual([]);
  });

  it('returns empty entries when no entries match', () => {
    const e = flattenMetadata(sampleTree);
    expect(searchFields('zzznomatch', e, 5).entries).toEqual([]);
  });

  it('finds exact piece match first', () => {
    const e = flattenMetadata(sampleTree);
    const { entries: results } = searchFields('NCTId', e, 5);
    expect(results[0]?.piece).toBe('NCTId');
  });

  it('finds partial substring match', () => {
    const e = flattenMetadata(sampleTree);
    const { entries: results } = searchFields('enrollment', e, 5);
    expect(results.some((r) => r.piece === 'EnrollmentCount')).toBe(true);
  });

  it('respects the limit parameter', () => {
    const e = flattenMetadata(sampleTree);
    const { entries: results } = searchFields('module', e, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('reports the pre-cap match total alongside the capped entries (#77)', () => {
    const e = flattenMetadata(sampleTree);
    // "module" matches several *Module pieces; cap to 2 and confirm total exceeds it.
    const { entries: results, total } = searchFields('module', e, 2);
    expect(results).toHaveLength(2);
    expect(total).toBeGreaterThan(2);
  });

  it('ranks status-related entries before unrelated entries like BriefTitle', () => {
    const e = flattenMetadata(sampleTree);
    // "OverallStatus" and "StatusModule" both contain "status" — both should rank before "BriefTitle"
    const { entries: results } = searchFields('status', e, 10);
    const overallStatusIdx = results.findIndex((r) => r.piece === 'OverallStatus');
    const briefTitleIdx = results.findIndex((r) => r.piece === 'BriefTitle');
    expect(overallStatusIdx).toBeGreaterThan(-1);
    if (briefTitleIdx !== -1) {
      expect(overallStatusIdx).toBeLessThan(briefTitleIdx);
    }
  });

  it('finds results from description text', () => {
    // "NCTId" has description "The NCT identifier for the study."
    // Searching "identifier" should surface it.
    const e = flattenMetadata(sampleTree);
    const { entries: results } = searchFields('identifier', e, 5);
    expect(results.some((r) => r.piece === 'NCTId')).toBe(true);
  });

  it('handles limit=1 returning only the top match', () => {
    const e = flattenMetadata(sampleTree);
    const { entries: results } = searchFields('enrollment', e, 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.piece).toBe('EnrollmentCount');
  });

  it('handles unicode and special chars in query without throwing', () => {
    const e = flattenMetadata(sampleTree);
    expect(() => searchFields('café enrollment', e, 5)).not.toThrow();
  });

  it('handles very long query string without throwing', () => {
    const e = flattenMetadata(sampleTree);
    const longQuery = 'enrollment'.repeat(100);
    expect(() => searchFields(longQuery, e, 5)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// nearestPieces
// ---------------------------------------------------------------------------

describe('nearestPieces', () => {
  it('returns empty array for empty entries', () => {
    expect(nearestPieces('NCTId', [], 3)).toEqual([]);
  });

  it('finds the exact match when present', () => {
    const e = flattenMetadata(sampleTree);
    const results = nearestPieces('NCTId', e, 3);
    expect(results[0]).toBe('NCTId');
  });

  it('finds close typo: ConditionList → Condition-like via Levenshtein fallback', () => {
    // Build entries with only "Condition" as piece to exercise the Levenshtein path
    const e = [
      {
        piece: 'Condition',
        path: 'protocolSection.conditionsModule.conditions',
        name: 'conditions',
      },
    ];
    const results = nearestPieces('ConditionList', e, 3);
    expect(results).toContain('Condition');
  });

  it('returns at most n results', () => {
    const e = flattenMetadata(sampleTree);
    const results = nearestPieces('study', e, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('handles empty invalid string without throwing', () => {
    const e = flattenMetadata(sampleTree);
    expect(() => nearestPieces('', e, 3)).not.toThrow();
  });

  it('exercises token-based scoring path for keyword-overlap match', () => {
    const e = flattenMetadata(sampleTree);
    // "enroll" has clear token overlap with "EnrollmentCount"
    const results = nearestPieces('enroll', e, 3);
    expect(results.some((p) => p.includes('Enrollment'))).toBe(true);
  });

  it('uses Levenshtein distance when token scoring yields no positives', () => {
    // No token overlap — should fall back to edit-distance comparison
    const e = [{ piece: 'AbcDef', path: 'x.abcDef', name: 'abcDef' }];
    const results = nearestPieces('AbcXXX', e, 3);
    expect(results).toContain('AbcDef');
  });

  it('suggests the Enrollment family for a one-letter misspelling (#112)', () => {
    const e = flattenMetadata(sampleTree);
    const results = nearestPieces('Enrolment', e, 3);
    expect(results).toContain('EnrollmentCount');
  });

  it('suggests the canonical casing for a case-only mistake (#112)', () => {
    const e = flattenMetadata(sampleTree);
    const results = nearestPieces('enrollmentcount', e, 3);
    expect(results[0]).toBe('EnrollmentCount');
  });

  it('offers nothing when no piece is close to the input (#112)', () => {
    // Every candidate is an edit-distance away equal to the longer string's
    // length — no shared structure at all. Three confident-looking names sent a
    // caller after a field the scorer had no reason to propose.
    const e = flattenMetadata(sampleTree);
    expect(nearestPieces('Bogus', e, 3)).toEqual([]);
  });

  it('offers nothing when the only overlap is a description word (#112)', () => {
    // 'field' appears in the description and nowhere in the piece name or path.
    // A lone description coincidence is not a did-you-mean.
    const e = [
      {
        piece: 'ConditionMesh',
        path: 'x.conditionMesh',
        name: 'conditionMesh',
        description: 'Field-level MeSH term for the condition.',
      },
    ];
    expect(nearestPieces('MyField', e, 3)).toEqual([]);
  });

  it('ranks the short canonical field above longer fields sharing one token (#60)', () => {
    // All three share only "status"; "recruitment" matches none. Field-token
    // coverage must lift the 2-token OverallStatus above the 3- and 6-token
    // fields, which otherwise tie on a single common token and break by index
    // order — sinking the canonical enum below a DATE and a niche long field.
    const e = [
      {
        piece: 'ExpandedAccessStatusForNCTId',
        path: 'x.expandedAccessStatusForNCTId',
        name: 'expandedAccessStatusForNCTId',
      },
      { piece: 'StatusVerifiedDate', path: 'x.statusVerifiedDate', name: 'statusVerifiedDate' },
      { piece: 'OverallStatus', path: 'x.overallStatus', name: 'overallStatus' },
    ];
    const results = nearestPieces('RecruitmentStatus', e, 3);
    expect(results[0]).toBe('OverallStatus');
  });
});

// ---------------------------------------------------------------------------
// AREA[] names (#170)
// ---------------------------------------------------------------------------

describe('buildAreaIndex (#170)', () => {
  const index = areaIndex();

  it('holds every non-STRUCT piece, and no STRUCT group upstream refuses inside AREA[]', () => {
    expect(index.entries.map((e) => e.piece)).toEqual([
      'NCTId',
      'OverallStatus',
      'StudyFirstSubmitQCDate',
      'LeadSponsorName',
      'LeadSponsorClass',
      'CollaboratorName',
      'CollaboratorClass',
      'InterventionType',
      'InterventionName',
      'LocationStatus',
      'LocationCity',
      'AgreementPISponsorEmployee',
    ]);
    for (const group of ['LeadSponsor', 'Collaborator', 'Intervention', 'Location']) {
      expect(index.names.has(group)).toBe(false);
    }
  });

  it('resolves each piece and its legacy alt names as written', () => {
    for (const name of ['OverallStatus', 'OVERALL-STATUS', 'COLLABORATOR', 'SPONSOR', 'CITY']) {
      expect(index.names.has(name)).toBe(true);
    }
  });

  it('folds each lowered name to its piece, alt names to the piece they stand for', () => {
    expect(index.fold.get('overallstatus')).toBe('OverallStatus');
    expect(index.fold.get('overall-status')).toBe('OverallStatus');
    expect(index.fold.get('studyfirstsubmitqcdate')).toBe('StudyFirstSubmitQCDate');
    expect(index.fold.get('sponsor')).toBe('LeadSponsorName');
    // Without the STRUCT pieces, `collaborator` reaches one piece: the leaf its alt name names.
    expect(index.fold.get('collaborator')).toBe('CollaboratorName');
    expect(index.fold.get('intervention')).toBe('InterventionName');
    expect(index.fold.has('leadsponsor')).toBe(false);
  });

  it('drops a lowered form two pieces share, keeping both exact spellings', () => {
    const entries: FieldIndexEntry[] = [
      { piece: 'StartDate', path: 'a.startDate', name: 'startDate', sourceType: 'DATE' },
      {
        piece: 'StartDateType',
        path: 'a.startDateType',
        name: 'startDateType',
        sourceType: 'TEXT',
        altPieceNames: ['STARTDATE'],
      },
    ];
    const shared = buildAreaIndex(entries);
    expect(shared.fold.has('startdate')).toBe(false);
    expect(shared.fold.get('startdatetype')).toBe('StartDateType');
    expect(shared.names.has('StartDate')).toBe(true);
    expect(shared.names.has('STARTDATE')).toBe(true);
    expect(rewriteAreaNames('AREA[startdate]2024', shared).text).toBe('AREA[startdate]2024');
  });

  it('builds an empty index from no entries', () => {
    const empty = buildAreaIndex([]);
    expect([empty.entries, [...empty.fold], [...empty.names]]).toEqual([[], [], []]);
  });
});

describe('rewriteAreaNames (#170)', () => {
  const index = areaIndex();
  const rewrite = (expression: string) => rewriteAreaNames(expression, index).text;

  it.each([
    ['AREA[overallstatus]RECRUITING', 'AREA[OverallStatus]RECRUITING'],
    [
      'AREA[StudyFirstSubmitQcDate]RANGE[2024-01-01,MAX]',
      'AREA[StudyFirstSubmitQCDate]RANGE[2024-01-01,MAX]',
    ],
    ['AREA[overall-status]RECRUITING', 'AREA[OverallStatus]RECRUITING'],
    ['AREA[Sponsor]Pfizer', 'AREA[LeadSponsorName]Pfizer'],
    ['AREA[collaborator]Pfizer', 'AREA[CollaboratorName]Pfizer'],
    // The STRUCT piece's own spelling folds to the leaf its alt name names, never to itself.
    ['AREA[Collaborator]Pfizer', 'AREA[CollaboratorName]Pfizer'],
    [
      'SEARCH[Location](AREA[locationcity]Seattle AND AREA[LocationStatus]RECRUITING)',
      'SEARCH[Location](AREA[LocationCity]Seattle AND AREA[LocationStatus]RECRUITING)',
    ],
    ['AREA[ overallstatus ]RECRUITING', 'AREA[ OverallStatus ]RECRUITING'],
    [
      '(AREA[overallstatus]RECRUITING OR AREA[OVERALL-status]COMPLETED) AND NOT AREA[sponsor]x',
      '(AREA[OverallStatus]RECRUITING OR AREA[OverallStatus]COMPLETED) AND NOT AREA[LeadSponsorName]x',
    ],
  ])('rewrites %j to %j', (expression, expected) => {
    expect(rewrite(expression)).toBe(expected);
  });

  it.each([
    ['a piece as written', 'AREA[OverallStatus]RECRUITING'],
    ['an alt name as written', 'AREA[OVERALL-STATUS]RECRUITING'],
    ['the alt name of a STRUCT piece’s lowered spelling', 'AREA[COLLABORATOR]Pfizer'],
    ['a name with whitespace upstream trims', 'AREA[ OverallStatus ]RECRUITING'],
    ['an indexed-only piece outside the index', 'AREA[NumLocations]RANGE[100,MAX]'],
    ['a search area outside the index', 'AREA[ConditionSearch]diabetes'],
    ['a mis-cased name outside the index', 'AREA[numlocations]RANGE[100,MAX]'],
    ['a STRUCT piece no fold reaches', 'AREA[LeadSponsor]Pfizer'],
    ['an unknown name', 'AREA[NotARealField]x'],
    ['an empty name', 'AREA[]x'],
    ['the lowercase keyword upstream rejects', 'area[overallstatus]RECRUITING'],
    ['a whole quoted literal', '"AREA[overallstatus]RECRUITING"'],
    ['a name left open', 'AREA[overallstatus RECRUITING'],
    ['a nested opener', 'AREA[AREA[overallstatus]RECRUITING'],
    ['an unclosed literal', '"asthma AREA[overallstatus]RECRUITING'],
  ])('leaves %s byte-identical', (_label, expression) => {
    const result = rewriteAreaNames(expression, index);
    expect(result.text).toBe(expression);
    expect(result.rewrites).toEqual([]);
  });

  it('reads a literal’s escapes: an escaped quote stays inside, an escaped backslash does not', () => {
    expect(rewrite('"a \\" AREA[overallstatus]x" AREA[overallstatus]y')).toBe(
      '"a \\" AREA[overallstatus]x" AREA[OverallStatus]y',
    );
    expect(rewrite('"a \\\\" AREA[overallstatus]y')).toBe('"a \\\\" AREA[OverallStatus]y');
  });

  it('rewrites the names before an unclosed literal and none after it', () => {
    expect(rewrite('AREA[overallstatus]x "open AREA[overallstatus]y')).toBe(
      'AREA[OverallStatus]x "open AREA[overallstatus]y',
    );
  });

  it('rewrites the names before an unclosed AREA[ and stops there', () => {
    expect(rewrite('AREA[overallstatus]x AND AREA[sponsor')).toBe(
      'AREA[OverallStatus]x AND AREA[sponsor',
    );
  });

  it('reports each rewrite as the caller wrote the name and the piece sent', () => {
    expect(
      rewriteAreaNames('AREA[ overallstatus ]x AND AREA[Sponsor]y AND AREA[OverallStatus]z', index)
        .rewrites,
    ).toEqual([
      { from: 'overallstatus', to: 'OverallStatus' },
      { from: 'Sponsor', to: 'LeadSponsorName' },
    ]);
  });

  it('is idempotent: its own output has nothing left to rewrite', () => {
    const once = rewrite('AREA[overallstatus]x OR AREA[collaborator]y OR AREA[city]Seattle');
    expect(rewriteAreaNames(once, index)).toEqual({ rewrites: [], text: once });
  });

  it('never rewrites to a STRUCT piece', () => {
    const names = flattenMetadata(AREA_METADATA).flatMap((e) => [
      e.piece,
      ...(e.altPieceNames ?? []),
    ]);
    for (const name of names) {
      for (const variant of [name, name.toLowerCase(), name.toUpperCase()]) {
        for (const { to } of rewriteAreaNames(`AREA[${variant}]x`, index).rewrites) {
          expect(STRUCT_PIECES.has(to)).toBe(false);
        }
      }
    }
  });

  describe('stays linear on caller-sized text', () => {
    type Check = (input: string, out: ReturnType<typeof rewriteAreaNames>) => boolean;
    const unchanged: Check = (input, out) => out.text === input && out.rewrites.length === 0;
    /** Each shape with the output its whole input must produce, checked on every timed run. */
    const shapes: Array<[name: string, shape: (n: number) => string, check: Check]> = [
      ...LINE_BREAK_SHAPES.map(([name, shape]): [string, (n: number) => string, Check] => [
        name,
        shape,
        unchanged,
      ]),
      ['repeated AREA[ with no ]', (n) => 'AREA['.repeat(n / 5), unchanged],
      ['nested AREA[AREA[… closed once', (n) => `${'AREA['.repeat(n / 5)}x]y`, unchanged],
      ['an unclosed " literal', (n) => `"${'AREA[overallstatus]x '.repeat(n / 21)}`, unchanged],
      [
        'a long run of \\ escapes in a literal',
        (n) => `"${'\\'.repeat(n)}" AREA[overallstatus]x`,
        (input, out) => out.rewrites.length === 1 && out.text.length === input.length,
      ],
      ['a long run of \\ outside a literal', (n) => '\\'.repeat(n), unchanged],
      ['one long name', (n) => `AREA[${'x'.repeat(n)}]y`, unchanged],
      [
        'every name rewritten',
        (n) => 'AREA[overallstatus]x '.repeat(n / 21),
        (input, out) =>
          out.rewrites.length === Math.floor(input.length / 21) &&
          out.text.length === input.length &&
          out.text.startsWith('AREA[OverallStatus]x '),
      ],
    ];

    it.each(shapes)('%s', (_name, shape, check) => {
      expectLinearGrowth((input) => {
        const out = rewriteAreaNames(input, index);
        if (!check(input, out)) throw new Error(`unexpected output at ${input.length} chars`);
      }, shape);
    });
  });
});

describe('normalizeAreaNames (#170)', () => {
  const loaded = (): Promise<AreaIndex | undefined> => Promise.resolve(areaIndex());

  it('never loads the index when no expression names an AREA[] field', async () => {
    const loadIndex = vi.fn(loaded);
    const log = createMockLogger();
    const expressions = { query: 'diabetes', advancedFilter: undefined };
    await expect(normalizeAreaNames(expressions, loadIndex, log)).resolves.toBe(expressions);
    expect(loadIndex).not.toHaveBeenCalled();
    expect(log.calls).toEqual([]);
  });

  it('rewrites each expression, leaves absent ones absent, and logs each rewrite with its parameter', async () => {
    const log = createMockLogger();
    const result = await normalizeAreaNames(
      {
        query: 'AREA[overallstatus]RECRUITING',
        conditionQuery: 'asthma',
        titleQuery: undefined,
        advancedFilter: 'AREA[Sponsor]Pfizer AND AREA[OverallStatus]COMPLETED',
      },
      loaded,
      log,
    );
    expect(result).toEqual({
      query: 'AREA[OverallStatus]RECRUITING',
      conditionQuery: 'asthma',
      titleQuery: undefined,
      advancedFilter: 'AREA[LeadSponsorName]Pfizer AND AREA[OverallStatus]COMPLETED',
    });
    expect(log.calls).toEqual([
      {
        level: 'notice',
        msg: 'AREA[] field names auto-corrected',
        data: {
          rewrites: [
            { param: 'query', from: 'overallstatus', to: 'OverallStatus' },
            { param: 'advancedFilter', from: 'Sponsor', to: 'LeadSponsorName' },
          ],
        },
      },
    ]);
  });

  it('passes every expression through unchanged when the index is unavailable', async () => {
    const log = createMockLogger();
    const expressions = { advancedFilter: 'AREA[overallstatus]RECRUITING' };
    await expect(
      normalizeAreaNames(expressions, () => Promise.resolve(undefined), log),
    ).resolves.toBe(expressions);
    expect(log.calls).toEqual([]);
  });

  it('logs nothing when the only AREA[ sits inside a quoted literal', async () => {
    const log = createMockLogger();
    const expressions = { query: '"AREA[overallstatus]RECRUITING"' };
    await expect(normalizeAreaNames(expressions, loaded, log)).resolves.toEqual(expressions);
    expect(log.calls).toEqual([]);
  });

  it('lets a failure to load the index reach the caller', async () => {
    const cancelled = new Error('Request cancelled by caller');
    await expect(
      normalizeAreaNames(
        { advancedFilter: 'AREA[x]y' },
        () => Promise.reject(cancelled),
        createMockLogger(),
      ),
    ).rejects.toBe(cancelled);
  });
});
