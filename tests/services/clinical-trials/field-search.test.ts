/**
 * @fileoverview Tests for field-search utilities: flattenMetadata, searchFields,
 * nearestPieces, the AREA[] name index and rewrite, and the second tier of
 * index-only pieces and search areas behind it.
 * @module tests/services/clinical-trials/field-search
 */

import { createMockLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  type AreaIndex,
  type AreaLookup,
  buildAreaIndex,
  buildExtendedIndex,
  buildFieldIndex,
  type ExtendedName,
  type FieldIndexEntry,
  flattenMetadata,
  indexOnlyNames,
  isSortable,
  isStruct,
  missesRecordTier,
  type NameFold,
  nearestPieces,
  normalizeAreaNames,
  resolveName,
  rewriteAreaNames,
  searchAreaNames,
  searchFields,
} from '@/services/clinical-trials/field-search.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';
import {
  AREA_METADATA,
  areaIndex,
  INDEXED_METADATA,
  LIVE_INDEX_ONLY,
  LIVE_RECORD_PIECES,
  LIVE_SEARCH_AREAS,
  RECORD_METADATA,
  SEARCH_AREAS,
  STRUCT_PIECES,
} from '../../helpers/area-metadata.js';
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

// ---------------------------------------------------------------------------
// The field index (#184, #189, #191)
// ---------------------------------------------------------------------------

describe('buildFieldIndex', () => {
  const entries = flattenMetadata(AREA_METADATA);
  const index = buildFieldIndex(AREA_METADATA);
  /** Two pieces and two paths that differ only by case, under one section. */
  const caseTwins: FieldNode[] = [
    {
      name: 'section',
      piece: 'Section',
      sourceType: 'STRUCT',
      children: [
        { name: 'item', piece: 'NctItem', sourceType: 'TEXT', type: 'text' },
        { name: 'Item', piece: 'NCTItem', sourceType: 'TEXT', type: 'text' },
      ],
    },
  ];

  it('holds the flattened entries and the AREA index built from them', () => {
    expect(index.entries).toEqual(entries);
    expect(index.area).toEqual(buildAreaIndex(entries));
  });

  it('folds each lowered piece to its piece, and a lowered form two pieces share to neither', () => {
    expect(index.caseFold.get('overallstatus')).toBe('OverallStatus');
    expect(index.caseFold.get('leadsponsor')).toBe('LeadSponsor');
    expect(index.caseFold.size).toBe(entries.length);
    const twins = buildFieldIndex(caseTwins).caseFold;
    expect(twins.has('nctitem')).toBe(false);
    expect(twins.get('section')).toBe('Section');
  });

  it('keys every record piece to its own entry, STRUCT groups included', () => {
    expect([...index.byPiece.keys()]).toEqual(entries.map((e) => e.piece));
    for (const entry of index.entries) expect(index.byPiece.get(entry.piece)).toBe(entry);
    expect(index.byPiece.has('NumLocations')).toBe(false);
  });

  it('maps every metadata path to its piece, as written and in any case (#189)', () => {
    for (const { path, piece } of entries) {
      expect(index.paths.exact.get(path), path).toBe(piece);
      expect(index.paths.fold.get(path.toLowerCase()), path).toBe(piece);
    }
    expect(index.paths.exact.get('protocolSection.statusModule.overallStatus')).toBe(
      'OverallStatus',
    );
    expect(index.paths.exact.has('protocolSection.statusModule.OverallStatus')).toBe(false);
    expect(index.paths.fold.get('protocolsection.statusmodule.overallstatus')).toBe(
      'OverallStatus',
    );
    expect(index.paths.exact.has('protocolSection.statusModule.nope')).toBe(false);
    expect(index.paths.exact.has('OverallStatus')).toBe(false);
  });

  it('folds a lowered path two paths share to neither, while each still resolves as written (#189)', () => {
    const { paths } = buildFieldIndex(caseTwins);
    expect(paths.exact.get('section.item')).toBe('NctItem');
    expect(paths.exact.get('section.Item')).toBe('NCTItem');
    expect(paths.fold.has('section.item')).toBe(false);
    expect(paths.fold.get('section')).toBe('Section');
  });

  it('maps no piece to a path longer than the piece, so the mapping never lengthens a request', () => {
    for (const [path, piece] of index.paths.exact) {
      expect(piece.length, path).toBeLessThanOrEqual(path.length);
    }
  });

  it('builds an empty index from an empty tree', () => {
    const empty = buildFieldIndex([]);
    expect([empty.entries, [...empty.byPiece], [...empty.caseFold]]).toEqual([[], [], []]);
    expect([[...empty.paths.exact], [...empty.paths.fold]]).toEqual([[], []]);
  });
});

describe('isSortable (#184)', () => {
  it('accepts the date and numeric types upstream sorts on, with or without []', () => {
    for (const type of [
      'NormalizedDate',
      'PartialDate',
      'DateTimeMinutes',
      'integer',
      'long',
      'short',
      'integer[]',
      'NormalizedDate[]',
    ]) {
      expect(isSortable(type), type).toBe(true);
    }
  });

  it('refuses every type upstream answers with Unsupported sort field type, and an absent type', () => {
    // Each answered `Unsupported sort field type: <type>` when probed (2026-11-09).
    for (const type of [
      'text',
      'text[]',
      'markup',
      'nct',
      'nct[]',
      'boolean',
      'NormalizedTime',
      'GeoPoint',
      'GeoName',
      'Status',
      'Phase[]',
      'BrowseLeafRelevance',
      'keyword',
      'Sponsor',
      'PartialDateStruct',
      'DateStruct',
      'INTEGER',
      '',
      undefined,
    ]) {
      expect(isSortable(type), String(type)).toBe(false);
    }
  });
});

describe('isStruct (#191)', () => {
  it('marks the STRUCT groups and nothing else', () => {
    const marked = flattenMetadata(AREA_METADATA).filter(isStruct);
    expect(new Set(marked.map((e) => e.piece))).toEqual(STRUCT_PIECES);
    expect(marked.length).toBeGreaterThan(0);
    expect(isStruct({ piece: 'X', path: 'x', name: 'x' })).toBe(false);
    expect(isStruct({ piece: 'X', path: 'x', name: 'x', sourceType: 'TEXT' })).toBe(false);
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

// ---------------------------------------------------------------------------
// Index-only pieces and search areas (#179)
// ---------------------------------------------------------------------------

describe('index-only pieces and search areas (#179)', () => {
  /** An index-only piece as indexOnlyNames emits it: the piece, then its alt names. */
  const indexOnly = (piece: string, ...alts: string[]): ExtendedName => ({
    kind: 'index-only',
    piece,
    names: [piece, ...alts],
  });
  /** The same piece from a node that lists its metadata `type` (#184). */
  const typed = (type: string, name: ExtendedName): ExtendedName => ({ ...name, type });
  /** A search area as searchAreaNames emits it. */
  const searchArea = (piece: string): ExtendedName => ({
    kind: 'search-area',
    piece,
    names: [piece],
  });

  /** The record tier the service builds from the default metadata read. */
  const recordIndex = () => buildAreaIndex(flattenMetadata(RECORD_METADATA));
  /** The second tier the service builds from the same read and the two extended reads. */
  const extendedIndex = () =>
    buildExtendedIndex(flattenMetadata(RECORD_METADATA), [
      ...indexOnlyNames(INDEXED_METADATA),
      ...searchAreaNames(SEARCH_AREAS),
    ]);

  /** The live record pool, each entry's path its piece (see LIVE_RECORD_PIECES). */
  const LIVE_ENTRIES: FieldIndexEntry[] = LIVE_RECORD_PIECES.map((piece) => ({
    piece,
    path: piece,
    name: piece,
  }));
  /** The live second tier: all 77 index-only pieces with their alt names, and all 19 search areas. */
  const LIVE_EXTRAS: ExtendedName[] = [
    ...LIVE_INDEX_ONLY.map(([piece, ...alts]) => indexOnly(piece!, ...alts)),
    ...LIVE_SEARCH_AREAS.map((piece) => searchArea(piece)),
  ];

  describe('indexOnlyNames', () => {
    it('finds every indexedOnly node with its alt names, two and three levels below a section, in tree order', () => {
      expect(indexOnlyNames(INDEXED_METADATA)).toEqual([
        // protocolSection.statusModule.lastUpdatePostDateStruct.lastUpdatePostYear
        typed('short', indexOnly('LastUpdatePostYear')),
        // protocolSection.contactsLocationsModule.locations.countryCode
        typed('keyword', indexOnly('LocationCountryCode')),
        // protocolSection.contactsLocationsModule.numLocations
        typed('short', indexOnly('NumLocations', 'NUMBER-OF-LOCATIONS')),
        // protocolSection.conditionsModule.numConditions
        typed('short', indexOnly('NumConditions', 'NUMBER-OF-CONDITIONS')),
      ]);
    });

    it('finds none in the default read, which holds record pieces only', () => {
      expect(flattenMetadata(RECORD_METADATA).length).toBeGreaterThan(0);
      expect(indexOnlyNames(RECORD_METADATA)).toEqual([]);
      expect(indexOnlyNames([])).toEqual([]);
    });

    it('walks below a flagged node with no piece, skipping it and every unflagged piece', () => {
      const tree: FieldNode[] = [
        {
          name: 'section',
          piece: 'Section',
          children: [
            {
              name: 'counts',
              indexedOnly: true,
              children: [{ name: 'numThings', piece: 'NumThings', indexedOnly: true }],
            },
            { name: 'thing', piece: 'Thing', indexedOnly: false },
            { name: 'numOthers', piece: 'NumOthers', indexedOnly: true, altPieceNames: [] },
          ],
        },
      ];
      expect(indexOnlyNames(tree)).toEqual([indexOnly('NumThings'), indexOnly('NumOthers')]);
    });
  });

  describe('searchAreaNames', () => {
    it('lists every area of every group, in order', () => {
      expect(
        searchAreaNames([...SEARCH_AREAS, { name: 'Other', areas: [{ name: 'TitleSearch' }] }]),
      ).toEqual([
        searchArea('BasicSearch'),
        searchArea('ConditionSearch'),
        searchArea('LocationSearch'),
        searchArea('TitleSearch'),
      ]);
    });

    it('lists none for no groups, or a group with no areas', () => {
      expect(searchAreaNames([])).toEqual([]);
      expect(searchAreaNames([{ name: 'Empty', areas: [] }])).toEqual([]);
    });
  });

  describe('buildExtendedIndex', () => {
    const extended = extendedIndex();

    it('resolves every record AREA name, index-only name, and search area as written for AREA[]', () => {
      for (const name of [
        'OverallStatus',
        'OVERALL-STATUS',
        'CONDITIONS',
        'NumLocations',
        'NUMBER-OF-LOCATIONS',
        'LastUpdatePostYear',
        'ConditionSearch',
        'BasicSearch',
      ]) {
        expect(extended.area.names.has(name), name).toBe(true);
      }
      for (const group of ['LeadSponsor', 'ConditionsModule']) {
        expect(extended.area.names.has(group), group).toBe(false);
      }
    });

    it('folds each lowered name to its piece for AREA[], alt names included', () => {
      expect(extended.area.fold.get('numlocations')).toBe('NumLocations');
      expect(extended.area.fold.get('number-of-locations')).toBe('NumLocations');
      expect(extended.area.fold.get('number-of-conditions')).toBe('NumConditions');
      expect(extended.area.fold.get('locationcountrycode')).toBe('LocationCountryCode');
      expect(extended.area.fold.get('conditionsearch')).toBe('ConditionSearch');
      expect(extended.area.fold.get('overallstatus')).toBe('OverallStatus');
    });

    it('resolves record pieces and index-only names for sort, never a search area', () => {
      for (const name of [
        'NumLocations',
        'NUMBER-OF-LOCATIONS',
        'LastUpdatePostDate',
        'LeadSponsor',
      ]) {
        expect(extended.sort.names.has(name), name).toBe(true);
      }
      // As before #179, sort takes no record alt name; upstream refuses every search area there.
      for (const name of ['OVERALL-STATUS', 'ConditionSearch', 'BasicSearch']) {
        expect(extended.sort.names.has(name), name).toBe(false);
      }
      expect(extended.sort.fold.get('number-of-locations')).toBe('NumLocations');
      expect(extended.sort.fold.has('conditionsearch')).toBe(false);
    });

    it('keeps the extended names it was built from as the suggestion pool', () => {
      expect(extended.extras).toEqual([
        typed('short', indexOnly('LastUpdatePostYear')),
        typed('keyword', indexOnly('LocationCountryCode')),
        typed('short', indexOnly('NumLocations', 'NUMBER-OF-LOCATIONS')),
        typed('short', indexOnly('NumConditions', 'NUMBER-OF-CONDITIONS')),
        searchArea('BasicSearch'),
        searchArea('ConditionSearch'),
        searchArea('LocationSearch'),
      ]);
    });

    it('folds every live index-only and search-area name to its piece', () => {
      const live = buildExtendedIndex(LIVE_ENTRIES, LIVE_EXTRAS);
      const names = LIVE_EXTRAS.flatMap(({ kind, piece, names }) =>
        names.map((name) => ({ kind, key: name.toLowerCase(), piece })),
      );

      expect(LIVE_EXTRAS).toHaveLength(77 + 19);
      expect(names).toHaveLength(77 + 10 + 19);
      for (const { kind, key, piece } of names) {
        expect(live.area.fold.get(key), key).toBe(piece);
        expect(live.sort.fold.get(key), key).toBe(kind === 'index-only' ? piece : undefined);
      }
    });
  });

  describe('resolveName', () => {
    const record = recordIndex();
    const extended = extendedIndex().area;

    it.each([
      ['a record piece as written', 'OverallStatus', 'OverallStatus'],
      ['a record alt name as written', 'OVERALL-STATUS', 'OVERALL-STATUS'],
      ['a record piece off by case', 'overallstatus', 'OverallStatus'],
      ['a record alt name off by case, as its piece', 'sponsor', 'LeadSponsorName'],
      ['an index-only piece as written', 'NumLocations', 'NumLocations'],
      ['an index-only alt name as written', 'NUMBER-OF-LOCATIONS', 'NUMBER-OF-LOCATIONS'],
      ['an index-only piece off by case', 'numlocations', 'NumLocations'],
      ['an index-only alt name off by case, as its piece', 'number-of-locations', 'NumLocations'],
      ['a search area as written', 'ConditionSearch', 'ConditionSearch'],
      ['a search area off by case', 'CONDITIONSEARCH', 'ConditionSearch'],
      ['a name neither tier holds', 'NotARealField', undefined],
    ])('resolves %s', (_label, name, expected) => {
      expect(resolveName(name, record, extended)).toBe(expected);
    });

    it('resolves in the record tier alone without a second tier', () => {
      expect(resolveName('overallstatus', record)).toBe('OverallStatus');
      expect(resolveName('NumLocations', record)).toBeUndefined();
      expect(resolveName('numlocations', record)).toBeUndefined();
    });

    it('lets the record tier decide whenever it can', () => {
      const elsewhere: NameFold = {
        names: new Set(['overallstatus']),
        fold: new Map([
          ['overallstatus', 'Elsewhere'],
          ['numlocations', 'Elsewhere'],
        ]),
      };
      expect(resolveName('OverallStatus', record, elsewhere)).toBe('OverallStatus');
      expect(resolveName('overallstatus', record, elsewhere)).toBe('OverallStatus');
      expect(resolveName('numlocations', record, elsewhere)).toBe('Elsewhere');
    });
  });

  describe('missesRecordTier', () => {
    const index = recordIndex();

    it.each([
      ['an index-only piece', 'NumLocations'],
      ['an index-only piece off by case', 'numlocations'],
      ['a search area', 'ConditionSearch'],
      ['an unknown name', 'NotARealField'],
      // Refused only as written: in another case a STRUCT piece is a miss like any other.
      ['a STRUCT piece off by case', 'leadsponsor'],
    ])('is true for %s', (_label, name) => {
      expect(missesRecordTier(name, index)).toBe(true);
    });

    it.each([
      ['a record piece as written', 'OverallStatus'],
      ['a record piece off by case', 'overallstatus'],
      ['a record alt name', 'OVERALL-STATUS'],
      ['a STRUCT piece, which upstream refuses', 'LeadSponsor'],
      ['a STRUCT piece an alt name also folds', 'Collaborator'],
      ['an empty name', ''],
    ])('is false for %s', (_label, name) => {
      expect(missesRecordTier(name, index)).toBe(false);
    });
  });

  describe('AreaIndex.refused', () => {
    it('holds the STRUCT pieces as written, none of them a name the index resolves', () => {
      const index = areaIndex();
      expect([...index.refused].sort()).toEqual(
        [
          'ProtocolSection',
          'IdentificationModule',
          'StatusModule',
          'SponsorCollaboratorsModule',
          'LeadSponsor',
          'Collaborator',
          'ArmsInterventionsModule',
          'Intervention',
          'ContactsLocationsModule',
          'Location',
          'ResultsSection',
          'MoreInfoModule',
          'CertainAgreement',
        ].sort(),
      );
      expect([...index.refused].filter((piece) => index.names.has(piece))).toEqual([]);
      expect(buildAreaIndex([]).refused.size).toBe(0);
    });
  });

  describe('lowered forms the second tier shares', () => {
    it('rewrites no lowered form two extended names share, while a lone one still folds', () => {
      const index = recordIndex();
      const { area, sort } = buildExtendedIndex(flattenMetadata(RECORD_METADATA), [
        indexOnly('NumLocations', 'NUMBER-OF-LOCATIONS'),
        searchArea('Number-Of-Locations'),
        indexOnly('NumConditions'),
        searchArea('NUMCONDITIONS'),
      ]);
      const out = rewriteAreaNames(
        'AREA[number-of-locations]x AND AREA[numconditions]y AND AREA[numlocations]z',
        index,
        area,
      );

      expect(out.text).toBe(
        'AREA[number-of-locations]x AND AREA[numconditions]y AND AREA[NumLocations]z',
      );
      expect(out.rewrites).toEqual([{ from: 'numlocations', to: 'NumLocations' }]);
      // Each spelling still goes out as written.
      const asWritten =
        'AREA[NUMBER-OF-LOCATIONS]x AND AREA[Number-Of-Locations]y AND AREA[NumConditions]z AND AREA[NUMCONDITIONS]w';
      expect(rewriteAreaNames(asWritten, index, area)).toEqual({ rewrites: [], text: asWritten });
      // sort holds no search area, so there the form it shared names a single piece.
      expect(sort.fold.get('numconditions')).toBe('NumConditions');
    });

    it('rewrites no lowered form two record pieces share, though an extended name shares it too', () => {
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
      const index = buildAreaIndex(entries);
      const { area } = buildExtendedIndex(entries, [
        indexOnly('Startdate'),
        indexOnly('NumStartDates'),
      ]);
      const out = rewriteAreaNames(
        'AREA[startdate]2024 AND AREA[numstartdates]x AND AREA[Startdate]y',
        index,
        area,
      );

      // The record tier leaves `startdate` to the second, which must not pick the extended name.
      expect(missesRecordTier('startdate', index)).toBe(true);
      expect(out.text).toBe('AREA[startdate]2024 AND AREA[NumStartDates]x AND AREA[Startdate]y');
      expect(out.rewrites).toEqual([{ from: 'numstartdates', to: 'NumStartDates' }]);
    });

    it('changes nothing the record tier resolves, though an extended name shares its lowered form', () => {
      const { area } = buildExtendedIndex(flattenMetadata(RECORD_METADATA), [
        searchArea('OVERALLSTATUS'),
      ]);
      expect(
        rewriteAreaNames('AREA[overallstatus]x AND AREA[OverallStatus]y', recordIndex(), area).text,
      ).toBe('AREA[OverallStatus]x AND AREA[OverallStatus]y');
    });
  });

  describe('normalizeAreaNames with a second tier', () => {
    /** A loader handing out the record tier with `extended` behind it. */
    const lookup = (extended: NonNullable<AreaLookup['extended']>) => () =>
      Promise.resolve<AreaLookup>({ ...recordIndex(), extended });

    it.each([
      ['a record piece as written', 'AREA[OverallStatus]x', 'AREA[OverallStatus]x'],
      ['a record piece off by case', 'AREA[overallstatus]x', 'AREA[OverallStatus]x'],
      ['a record alt name in another case', 'AREA[Sponsor]x', 'AREA[LeadSponsorName]x'],
      ['a STRUCT piece exactly as written', 'AREA[LeadSponsor]x', 'AREA[LeadSponsor]x'],
      ['an empty name', 'AREA[]x', 'AREA[]x'],
      [
        'a missing name inside a quoted literal',
        '"AREA[numlocations]x" AND AREA[OverallStatus]y',
        '"AREA[numlocations]x" AND AREA[OverallStatus]y',
      ],
    ])('never reads the second tier for %s', async (_label, advancedFilter, sent) => {
      const extended = vi.fn(() => Promise.resolve(extendedIndex()));
      await expect(
        normalizeAreaNames({ advancedFilter }, lookup(extended), createMockLogger()),
      ).resolves.toEqual({ advancedFilter: sent });
      expect(extended).not.toHaveBeenCalled();
    });

    it('reads the second tier once for every name that misses, across expressions', async () => {
      const extended = vi.fn(() => Promise.resolve(extendedIndex()));
      const log = createMockLogger();
      const result = await normalizeAreaNames(
        {
          advancedFilter: 'AREA[numlocations]RANGE[100,MAX] AND AREA[overallstatus]RECRUITING',
          query: 'AREA[conditionsearch]diabetes',
          conditionQuery: 'AREA[number-of-locations]RANGE[1,MAX]',
          titleQuery: undefined,
        },
        lookup(extended),
        log,
      );

      expect(extended).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        advancedFilter: 'AREA[NumLocations]RANGE[100,MAX] AND AREA[OverallStatus]RECRUITING',
        query: 'AREA[ConditionSearch]diabetes',
        conditionQuery: 'AREA[NumLocations]RANGE[1,MAX]',
        titleQuery: undefined,
      });
      expect(log.calls).toEqual([
        {
          level: 'notice',
          msg: 'AREA[] field names auto-corrected',
          data: {
            rewrites: [
              { param: 'advancedFilter', from: 'numlocations', to: 'NumLocations' },
              { param: 'advancedFilter', from: 'overallstatus', to: 'OverallStatus' },
              { param: 'query', from: 'conditionsearch', to: 'ConditionSearch' },
              { param: 'conditionQuery', from: 'number-of-locations', to: 'NumLocations' },
            ],
          },
        },
      ]);
    });

    it('corrects in the record tier alone when the second tier cannot be read', async () => {
      const extended = vi.fn(() => Promise.resolve(undefined));
      await expect(
        normalizeAreaNames(
          { advancedFilter: 'AREA[numlocations]RANGE[100,MAX] AND AREA[overallstatus]RECRUITING' },
          lookup(extended),
          createMockLogger(),
        ),
      ).resolves.toEqual({
        advancedFilter: 'AREA[numlocations]RANGE[100,MAX] AND AREA[OverallStatus]RECRUITING',
      });
      expect(extended).toHaveBeenCalledTimes(1);
    });

    it('lets the caller’s cancellation through from the second tier', async () => {
      const cancelled = new Error('Request cancelled by caller');
      const extended = vi.fn(() => Promise.reject(cancelled));
      const log = createMockLogger();
      await expect(
        normalizeAreaNames(
          { advancedFilter: 'AREA[numlocations]x AND AREA[overallstatus]y' },
          lookup(extended),
          log,
        ),
      ).rejects.toBe(cancelled);
      expect(extended).toHaveBeenCalledTimes(1);
      expect(log.calls).toEqual([]);
    });
  });

  describe('nearestPieces with the second tier', () => {
    // A plain merge of the pools would reorder these (`Phases` → NumPhases ahead of Phase).
    it.each([
      ['Phases', ['Phase']],
      [
        'InterventionNames',
        ['InterventionName', 'InterventionOtherName', 'ArmGroupInterventionName'],
      ],
      ['ConditionList', ['Condition', 'ConditionMeshId', 'ConditionMeshTerm']],
      ['LeadSponsor', ['LeadSponsorName', 'LeadSponsorClass', 'AgreementPISponsorEmployee']],
      ['FirstPostDate', ['DispFirstPostDate', 'StudyFirstPostDate', 'ResultsFirstPostDate']],
      ['NotARealField', []],
    ])('keeps today’s record ranking for %s, extended names or none', (input, expected) => {
      expect(nearestPieces(input, LIVE_ENTRIES, 3, LIVE_EXTRAS)).toEqual(expected);
      expect(nearestPieces(input, LIVE_ENTRIES, 3)).toEqual(expected);
    });

    it.each([
      ['NumLocation', 'NumLocations'],
      // Two edits from NumLocations' alt name, NUMBER-OF-LOCATIONS.
      ['NumberOfLocations', 'NumLocations'],
      ['ConditionSearches', 'ConditionSearch'],
    ])(
      'leads the suggestions for %s with %s, which the record pieces never offer',
      (input, lead) => {
        const suggested = nearestPieces(input, LIVE_ENTRIES, 3, LIVE_EXTRAS);
        expect(suggested[0]).toBe(lead);
        expect(suggested).toHaveLength(3);
        expect(nearestPieces(input, LIVE_ENTRIES, 3)).not.toContain(lead);
      },
    );

    it('matches case-insensitively, but never offers back the spelling the caller sent', () => {
      expect(nearestPieces('conditionsearch', [], 3, LIVE_EXTRAS)).toEqual(['ConditionSearch']);
      expect(nearestPieces('number-of-locations', [], 3, LIVE_EXTRAS)).toEqual(['NumLocations']);
      expect(nearestPieces('ConditionSearch', [], 3, LIVE_EXTRAS)).toEqual([]);
      expect(nearestPieces('NUMBER-OF-LOCATIONS', [], 3, LIVE_EXTRAS)).toEqual([]);
    });

    it('orders extended near misses nearest first, stops at two edits, and keeps to n', () => {
      // NCIdSearch is one edit from NCTIdSearch and two from IdSearch.
      expect(nearestPieces('NCIdSearch', [], 3, LIVE_EXTRAS)).toEqual(['NCTIdSearch', 'IdSearch']);
      expect(nearestPieces('NCIdSearch', [], 1, LIVE_EXTRAS)).toEqual(['NCTIdSearch']);
      expect(nearestPieces('NumLocatio', [], 3, LIVE_EXTRAS)).toEqual(['NumLocations']);
      expect(nearestPieces('NumLocati', [], 3, LIVE_EXTRAS)).toEqual([]);
    });
  });

  describe('stays linear on caller-sized text with the second tier', () => {
    // The extended names alone: the record ranking nearestPieces runs beside them predates #179.
    it.each([
      ...LINE_BREAK_SHAPES,
      ['a long digit run', (n: number) => '7'.repeat(n)],
      ['repeated near misses of an index-only piece', (n: number) => 'NumLocation'.repeat(n / 11)],
    ] as const)('nearestPieces over the extended names: %s', (_name, shape) => {
      expectLinearGrowth((input) => {
        if (nearestPieces(input, [], 3, LIVE_EXTRAS).length > 0) {
          throw new Error(`unexpected suggestion at ${input.length} chars`);
        }
      }, shape);
    });

    describe('rewriteAreaNames with both tiers', () => {
      const index = recordIndex();
      const { area } = extendedIndex();
      type Check = (input: string, out: ReturnType<typeof rewriteAreaNames>) => boolean;
      const unchanged: Check = (input, out) => out.text === input && out.rewrites.length === 0;
      const rewritten = 'AREA[NumLocations]x ';
      const shapes: Array<[name: string, shape: (n: number) => string, check: Check]> = [
        ...LINE_BREAK_SHAPES.map(([name, shape]): [string, (n: number) => string, Check] => [
          name,
          shape,
          unchanged,
        ]),
        [
          'every name an index-only piece off by case',
          (n) => 'AREA[numlocations]x '.repeat(n / 20),
          (input, out) =>
            out.rewrites.length === Math.floor(input.length / 20) &&
            out.text.length === input.length &&
            out.text.startsWith(rewritten) &&
            out.text.endsWith(rewritten),
        ],
        ['one long digit-run name neither tier holds', (n) => `AREA[${'7'.repeat(n)}]x`, unchanged],
      ];

      it.each(shapes)('%s', (_name, shape, check) => {
        expectLinearGrowth((input) => {
          const out = rewriteAreaNames(input, index, area);
          if (!check(input, out)) throw new Error(`unexpected output at ${input.length} chars`);
        }, shape);
      });
    });
  });
});
