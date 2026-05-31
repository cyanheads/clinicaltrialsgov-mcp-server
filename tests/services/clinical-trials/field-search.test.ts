/**
 * @fileoverview Tests for field-search utilities: flattenMetadata, searchFields, nearestPieces.
 * @module tests/services/clinical-trials/field-search
 */

import { describe, expect, it } from 'vitest';
import {
  flattenMetadata,
  nearestPieces,
  searchFields,
} from '@/services/clinical-trials/field-search.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';

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

  it('skips nodes where piece is undefined or falsy', () => {
    const tree: FieldNode[] = [
      { name: 'container', type: 'OBJECT', children: [{ name: 'inner', type: 'STRING' }] },
    ];
    expect(flattenMetadata(tree)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchFields
// ---------------------------------------------------------------------------

describe('searchFields', () => {
  it('returns empty array for empty entries', () => {
    expect(searchFields('enrollment', [], 5)).toEqual([]);
  });

  it('returns empty array for empty query string', () => {
    const e = flattenMetadata(sampleTree);
    // scoreEntry returns 0 for empty query, so nothing passes the filter
    expect(searchFields('', e, 5)).toEqual([]);
  });

  it('returns empty array when no entries match', () => {
    const e = flattenMetadata(sampleTree);
    expect(searchFields('zzznomatch', e, 5)).toEqual([]);
  });

  it('finds exact piece match first', () => {
    const e = flattenMetadata(sampleTree);
    const results = searchFields('NCTId', e, 5);
    expect(results[0]?.piece).toBe('NCTId');
  });

  it('finds partial substring match', () => {
    const e = flattenMetadata(sampleTree);
    const results = searchFields('enrollment', e, 5);
    expect(results.some((r) => r.piece === 'EnrollmentCount')).toBe(true);
  });

  it('respects the limit parameter', () => {
    const e = flattenMetadata(sampleTree);
    const results = searchFields('module', e, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('ranks status-related entries before unrelated entries like BriefTitle', () => {
    const e = flattenMetadata(sampleTree);
    // "OverallStatus" and "StatusModule" both contain "status" — both should rank before "BriefTitle"
    const results = searchFields('status', e, 10);
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
    const results = searchFields('identifier', e, 5);
    expect(results.some((r) => r.piece === 'NCTId')).toBe(true);
  });

  it('handles limit=1 returning only the top match', () => {
    const e = flattenMetadata(sampleTree);
    const results = searchFields('enrollment', e, 1);
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
