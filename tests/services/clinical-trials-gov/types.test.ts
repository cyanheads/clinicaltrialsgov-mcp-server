/**
 * @fileoverview Test suite for ClinicalTrials.gov service Zod schemas and types
 * @module tests/services/clinical-trials-gov/types.test
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  StudySchema,
  PagedStudiesSchema,
  StudyMetadataSchema,
  Status,
} from '@/services/clinical-trials-gov/types.js';
import type {
  Study,
  PagedStudies,
  StudyMetadata,
  FieldNode,
} from '@/services/clinical-trials-gov/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal study: empty object (all top-level fields are optional) */
const minimalStudy = {};

/** Full study with all nested modules populated */
const fullStudy = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT00000001',
      orgStudyIdInfo: { id: 'ORG-001' },
      organization: { fullName: 'Test Org', class: 'INDUSTRY' },
      briefTitle: 'A Brief Title',
      officialTitle: 'An Official Title',
      acronym: 'ABT',
    },
    statusModule: {
      overallStatus: 'RECRUITING',
      lastKnownStatus: 'RECRUITING',
      startDateStruct: { date: '2024-01-01', type: 'ACTUAL' },
      primaryCompletionDateStruct: { date: '2025-06-01', type: 'ESTIMATED' },
      completionDateStruct: { date: '2025-12-01', type: 'ESTIMATED' },
      lastUpdatePostDateStruct: { date: '2024-03-15', type: 'ACTUAL' },
    },
    sponsorCollaboratorsModule: {
      responsibleParty: { type: 'PRINCIPAL_INVESTIGATOR' },
      leadSponsor: { name: 'Sponsor Corp', class: 'INDUSTRY' },
      collaborators: [{ name: 'Collab University', class: 'OTHER' }],
    },
    descriptionModule: {
      briefSummary: 'A brief summary of the study.',
      detailedDescription: 'A detailed description of the study.',
    },
    conditionsModule: {
      conditions: ['Type 2 Diabetes', 'Hypertension'],
      keywords: ['diabetes', 'blood pressure'],
    },
    armsInterventionsModule: {
      arms: [
        { name: 'Experimental', type: 'EXPERIMENTAL', description: 'Drug arm' },
      ],
      interventions: [
        {
          type: 'DRUG',
          name: 'Metformin',
          description: 'Oral medication',
          armNames: ['Experimental'],
        },
      ],
    },
    designModule: {
      studyType: 'INTERVENTIONAL',
      phases: ['PHASE3'],
      designInfo: {
        allocation: 'RANDOMIZED',
        interventionModel: 'PARALLEL',
        primaryPurpose: 'TREATMENT',
        maskingInfo: { masking: 'DOUBLE' },
      },
    },
    eligibilityModule: {
      eligibilityCriteria: 'Inclusion: age >= 18',
      healthyVolunteers: false,
      sex: 'ALL',
      minimumAge: '18 Years',
      stdAges: ['ADULT', 'OLDER_ADULT'],
    },
    contactsLocationsModule: {
      locations: [
        { city: 'Seattle', state: 'Washington', country: 'United States' },
      ],
    },
    oversightModule: {
      oversightHasDmc: true,
      isFdaRegulatedDrug: true,
      isFdaRegulatedDevice: false,
    },
    outcomesModule: {
      primaryOutcomes: [
        {
          measure: 'HbA1c change',
          description: 'Change from baseline',
          timeFrame: '6 months',
        },
      ],
      secondaryOutcomes: [
        {
          measure: 'Blood pressure',
          description: 'Systolic BP',
          timeFrame: '6 months',
        },
      ],
      otherOutcomes: [
        {
          measure: 'Quality of life',
          description: 'SF-36',
          timeFrame: '12 months',
        },
      ],
    },
    referencesModule: {
      references: [
        { pmid: '12345678', type: 'RESULT', citation: 'Smith et al. 2024' },
      ],
    },
    ipdSharingStatementModule: {
      ipdSharing: 'NO',
      description: 'Not sharing',
      url: 'https://example.com',
    },
  },
  derivedSection: {
    miscInfoModule: { versionHolder: '2024-03-15' },
    conditionBrowseModule: {
      meshes: [{ id: 'D003924', term: 'Diabetes Mellitus, Type 2' }],
      ancestors: [{ id: 'D003920', term: 'Diabetes Mellitus' }],
      browseLeaves: [
        {
          id: 'M7115',
          name: 'Diabetes Mellitus, Type 2',
          asFound: 'Type 2 Diabetes',
          relevance: 'HIGH',
        },
      ],
      browseBranches: [
        { abbrev: 'BC18', name: 'Nutritional and Metabolic Diseases' },
      ],
    },
    interventionBrowseModule: {
      meshes: [{ id: 'D008687', term: 'Metformin' }],
      ancestors: [{ id: 'D007004', term: 'Hypoglycemic Agents' }],
      browseLeaves: [{ id: 'M11698', name: 'Metformin', relevance: 'HIGH' }],
      browseBranches: [{ abbrev: 'Hypo', name: 'Hypoglycemic Agents' }],
    },
  },
  hasResults: false,
};

// ---------------------------------------------------------------------------
// StudySchema
// ---------------------------------------------------------------------------

describe('StudySchema', () => {
  it('accepts a minimal empty study', () => {
    const result = StudySchema.parse(minimalStudy);
    expect(result).toEqual({});
  });

  it('accepts a full study with all nested modules', () => {
    const result = StudySchema.parse(fullStudy);
    expect(result.protocolSection?.identificationModule?.nctId).toBe(
      'NCT00000001',
    );
    expect(result.hasResults).toBe(false);
    expect(result.derivedSection?.miscInfoModule?.versionHolder).toBe(
      '2024-03-15',
    );
  });

  it('accepts a study with only some modules present', () => {
    const partial = {
      protocolSection: {
        identificationModule: { nctId: 'NCT99999999' },
        conditionsModule: { conditions: ['Cancer'] },
      },
    };
    const result = StudySchema.parse(partial);
    expect(result.protocolSection?.identificationModule?.nctId).toBe(
      'NCT99999999',
    );
    expect(result.protocolSection?.conditionsModule?.conditions).toEqual([
      'Cancer',
    ]);
    // Other modules should be absent
    expect(result.protocolSection?.statusModule).toBeUndefined();
    expect(result.protocolSection?.designModule).toBeUndefined();
  });

  describe('passthrough behavior', () => {
    it('preserves unknown top-level fields', () => {
      const study = { customField: 'extra', anotherField: 42 };
      const result = StudySchema.parse(study);
      expect(result).toHaveProperty('customField', 'extra');
      expect(result).toHaveProperty('anotherField', 42);
    });

    it('preserves unknown fields within protocolSection', () => {
      const study = {
        protocolSection: {
          identificationModule: { nctId: 'NCT00000002' },
          unknownModule: { data: true },
        },
      };
      const result = StudySchema.parse(study);
      expect(
        (result.protocolSection as Record<string, unknown>)['unknownModule'],
      ).toEqual({ data: true });
    });

    it('preserves unknown fields within nested modules', () => {
      const study = {
        protocolSection: {
          identificationModule: {
            nctId: 'NCT00000003',
            unknownNestedField: 'hello',
          },
        },
      };
      const result = StudySchema.parse(study);
      expect(
        (
          result.protocolSection?.identificationModule as Record<
            string,
            unknown
          >
        )['unknownNestedField'],
      ).toBe('hello');
    });
  });

  describe('identificationModule validation', () => {
    it('requires nctId as a string when identificationModule is present', () => {
      const study = {
        protocolSection: {
          identificationModule: { nctId: 'NCT12345678' },
        },
      };
      expect(
        StudySchema.parse(study).protocolSection?.identificationModule?.nctId,
      ).toBe('NCT12345678');
    });

    it('rejects identificationModule with missing nctId', () => {
      const study = {
        protocolSection: {
          identificationModule: { briefTitle: 'No NCT ID' },
        },
      };
      expect(() => StudySchema.parse(study)).toThrow(ZodError);
    });

    it('rejects identificationModule with non-string nctId', () => {
      const study = {
        protocolSection: {
          identificationModule: { nctId: 12345 },
        },
      };
      expect(() => StudySchema.parse(study)).toThrow(ZodError);
    });
  });

  describe('nested optional modules', () => {
    it.each([
      'statusModule',
      'sponsorCollaboratorsModule',
      'descriptionModule',
      'conditionsModule',
      'armsInterventionsModule',
      'designModule',
      'eligibilityModule',
      'contactsLocationsModule',
      'oversightModule',
      'outcomesModule',
      'referencesModule',
      'ipdSharingStatementModule',
    ] as const)('protocolSection.%s is optional', (moduleName) => {
      // Without the module
      const withoutModule = { protocolSection: {} };
      const resultWithout = StudySchema.parse(withoutModule);
      expect(resultWithout.protocolSection?.[moduleName]).toBeUndefined();

      // With the module as an empty object (all fields within are optional)
      const withModule = { protocolSection: { [moduleName]: {} } };
      const resultWith = StudySchema.parse(withModule);
      expect(resultWith.protocolSection?.[moduleName]).toBeDefined();
    });
  });

  describe('derivedSection', () => {
    it('is optional', () => {
      const result = StudySchema.parse({});
      expect(result.derivedSection).toBeUndefined();
    });

    it('accepts valid derivedSection with conditionBrowseModule', () => {
      const study = {
        derivedSection: {
          conditionBrowseModule: {
            meshes: [{ id: 'D000001', term: 'Test' }],
          },
        },
      };
      const result = StudySchema.parse(study);
      expect(result.derivedSection?.conditionBrowseModule?.meshes).toHaveLength(
        1,
      );
    });

    it('accepts valid derivedSection with interventionBrowseModule', () => {
      const study = {
        derivedSection: {
          interventionBrowseModule: {
            browseLeaves: [{ id: 'L1', name: 'Leaf', relevance: 'LOW' }],
            browseBranches: [{ abbrev: 'AB', name: 'Branch' }],
          },
        },
      };
      const result = StudySchema.parse(study);
      expect(
        result.derivedSection?.interventionBrowseModule?.browseLeaves,
      ).toHaveLength(1);
      expect(
        result.derivedSection?.interventionBrowseModule?.browseBranches,
      ).toHaveLength(1);
    });

    it('preserves unknown fields via passthrough', () => {
      const study = {
        derivedSection: {
          customDerivedField: 'extra',
        },
      };
      const result = StudySchema.parse(study);
      expect(
        (result.derivedSection as Record<string, unknown>)[
          'customDerivedField'
        ],
      ).toBe('extra');
    });
  });

  describe('hasResults', () => {
    it('is optional', () => {
      const result = StudySchema.parse({});
      expect(result.hasResults).toBeUndefined();
    });

    it('accepts true', () => {
      expect(StudySchema.parse({ hasResults: true }).hasResults).toBe(true);
    });

    it('accepts false', () => {
      expect(StudySchema.parse({ hasResults: false }).hasResults).toBe(false);
    });

    it('rejects non-boolean hasResults', () => {
      expect(() => StudySchema.parse({ hasResults: 'yes' })).toThrow(ZodError);
    });
  });

  describe('complex nested validation', () => {
    it('validates armsInterventionsModule arms and interventions arrays', () => {
      const study = {
        protocolSection: {
          armsInterventionsModule: {
            arms: [
              { name: 'Arm 1', type: 'EXPERIMENTAL', description: 'Test arm' },
              { name: 'Arm 2', type: 'PLACEBO_COMPARATOR' },
            ],
            interventions: [
              { type: 'DRUG', name: 'Drug A', armNames: ['Arm 1'] },
            ],
          },
        },
      };
      const result = StudySchema.parse(study);
      expect(
        result.protocolSection?.armsInterventionsModule?.arms,
      ).toHaveLength(2);
      expect(
        result.protocolSection?.armsInterventionsModule?.interventions,
      ).toHaveLength(1);
    });

    it('validates outcomesModule with all outcome types', () => {
      const study = {
        protocolSection: {
          outcomesModule: {
            primaryOutcomes: [{ measure: 'Primary' }],
            secondaryOutcomes: [{ measure: 'Secondary', timeFrame: '1 year' }],
            otherOutcomes: [],
          },
        },
      };
      const result = StudySchema.parse(study);
      expect(
        result.protocolSection?.outcomesModule?.primaryOutcomes,
      ).toHaveLength(1);
      expect(
        result.protocolSection?.outcomesModule?.secondaryOutcomes,
      ).toHaveLength(1);
      expect(
        result.protocolSection?.outcomesModule?.otherOutcomes,
      ).toHaveLength(0);
    });

    it('validates contactsLocationsModule with multiple locations', () => {
      const study = {
        protocolSection: {
          contactsLocationsModule: {
            locations: [
              { city: 'Seattle', state: 'WA', country: 'United States' },
              { city: 'London', country: 'United Kingdom' },
              { country: 'Japan' },
            ],
          },
        },
      };
      const result = StudySchema.parse(study);
      expect(
        result.protocolSection?.contactsLocationsModule?.locations,
      ).toHaveLength(3);
    });

    it('validates eligibilityModule boolean and string fields', () => {
      const study = {
        protocolSection: {
          eligibilityModule: {
            healthyVolunteers: true,
            sex: 'FEMALE',
            minimumAge: '21 Years',
            stdAges: ['ADULT'],
          },
        },
      };
      const result = StudySchema.parse(study);
      expect(result.protocolSection?.eligibilityModule?.healthyVolunteers).toBe(
        true,
      );
      expect(result.protocolSection?.eligibilityModule?.sex).toBe('FEMALE');
    });

    it('rejects invalid types in deeply nested fields', () => {
      const study = {
        protocolSection: {
          eligibilityModule: {
            healthyVolunteers: 'yes', // should be boolean
          },
        },
      };
      expect(() => StudySchema.parse(study)).toThrow(ZodError);
    });
  });
});

// ---------------------------------------------------------------------------
// PagedStudiesSchema
// ---------------------------------------------------------------------------

describe('PagedStudiesSchema', () => {
  it('accepts valid paged studies with a studies array', () => {
    const paged = { studies: [fullStudy] };
    const result = PagedStudiesSchema.parse(paged);
    expect(result.studies).toHaveLength(1);
  });

  it('accepts paged studies with nextPageToken and totalCount', () => {
    const paged = {
      studies: [minimalStudy],
      nextPageToken: 'abc123',
      totalCount: 42,
    };
    const result = PagedStudiesSchema.parse(paged);
    expect(result.nextPageToken).toBe('abc123');
    expect(result.totalCount).toBe(42);
  });

  it('accepts paged studies without optional fields', () => {
    const paged = { studies: [] };
    const result = PagedStudiesSchema.parse(paged);
    expect(result.nextPageToken).toBeUndefined();
    expect(result.totalCount).toBeUndefined();
  });

  it('accepts empty studies array', () => {
    const result = PagedStudiesSchema.parse({ studies: [] });
    expect(result.studies).toEqual([]);
  });

  it('validates each study in the array', () => {
    const paged = {
      studies: [
        { protocolSection: { identificationModule: { nctId: 'NCT00000001' } } },
        { hasResults: true },
        {},
      ],
    };
    const result = PagedStudiesSchema.parse(paged);
    expect(result.studies).toHaveLength(3);
  });

  it('rejects invalid study in the array', () => {
    const paged = {
      studies: [
        {
          protocolSection: {
            identificationModule: { nctId: 123 }, // nctId must be string
          },
        },
      ],
    };
    expect(() => PagedStudiesSchema.parse(paged)).toThrow();
  });

  it('rejects missing studies field', () => {
    expect(() => PagedStudiesSchema.parse({})).toThrow();
  });

  it('rejects studies as non-array', () => {
    expect(() =>
      PagedStudiesSchema.parse({ studies: 'not-an-array' }),
    ).toThrow();
  });

  it('preserves unknown fields via passthrough', () => {
    const paged = {
      studies: [],
      extraField: 'preserved',
      anotherExtra: 99,
    };
    const result = PagedStudiesSchema.parse(paged);
    expect(result).toHaveProperty('extraField', 'preserved');
    expect(result).toHaveProperty('anotherExtra', 99);
  });
});

// ---------------------------------------------------------------------------
// StudyMetadataSchema
// ---------------------------------------------------------------------------

describe('StudyMetadataSchema', () => {
  it('accepts minimal metadata with only nctId', () => {
    const result = StudyMetadataSchema.parse({ nctId: 'NCT00000001' });
    expect(result.nctId).toBe('NCT00000001');
    expect(result.title).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(result.startDate).toBeUndefined();
    expect(result.completionDate).toBeUndefined();
    expect(result.lastUpdateDate).toBeUndefined();
  });

  it('accepts full metadata with all optional fields', () => {
    const metadata = {
      nctId: 'NCT00000002',
      title: 'Study Title',
      status: 'RECRUITING',
      startDate: '2024-01-01',
      completionDate: '2025-12-31',
      lastUpdateDate: '2024-06-15',
    };
    const result = StudyMetadataSchema.parse(metadata);
    expect(result).toEqual(metadata);
  });

  it('rejects missing nctId', () => {
    expect(() => StudyMetadataSchema.parse({ title: 'No ID' })).toThrow(
      ZodError,
    );
  });

  it('rejects non-string nctId', () => {
    expect(() => StudyMetadataSchema.parse({ nctId: 12345 })).toThrow(ZodError);
  });

  it('rejects null nctId', () => {
    expect(() => StudyMetadataSchema.parse({ nctId: null })).toThrow(ZodError);
  });

  it('accepts partial optional fields', () => {
    const result = StudyMetadataSchema.parse({
      nctId: 'NCT00000003',
      status: 'COMPLETED',
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.title).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

describe('Status enum', () => {
  it('has exactly 9 values', () => {
    const values = Object.values(Status);
    expect(values).toHaveLength(9);
  });

  it.each([
    ['ActiveNotRecruiting', 'ACTIVE_NOT_RECRUITING'],
    ['Completed', 'COMPLETED'],
    ['EnrollingByInvitation', 'ENROLLING_BY_INVITATION'],
    ['NotYetRecruiting', 'NOT_YET_RECRUITING'],
    ['Recruiting', 'RECRUITING'],
    ['Suspended', 'SUSPENDED'],
    ['Terminated', 'TERMINATED'],
    ['Withdrawn', 'WITHDRAWN'],
    ['Unknown', 'UNKNOWN'],
  ] as const)('Status.%s equals "%s"', (key, value) => {
    expect(Status[key as keyof typeof Status]).toBe(value);
  });

  it('enum keys can be used for reverse lookup', () => {
    // TypeScript enums support reverse mapping for numeric enums only,
    // but string enums do not. Verify the values are accessible as expected.
    expect(Status.Recruiting).toBe('RECRUITING');
    expect(Status.Unknown).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// FieldNode interface (structural check)
// ---------------------------------------------------------------------------

describe('FieldNode interface', () => {
  it('satisfies the interface shape with required fields', () => {
    const node: FieldNode = {
      name: 'protocolSection',
      type: 'object',
      description: 'The protocol section of a study',
    };
    expect(node.name).toBe('protocolSection');
    expect(node.type).toBe('object');
    expect(node.description).toBe('The protocol section of a study');
    expect(node.children).toBeUndefined();
  });

  it('satisfies the interface shape with optional children', () => {
    const node: FieldNode = {
      name: 'parent',
      type: 'object',
      description: 'A parent node',
      children: [
        { name: 'child1', type: 'string', description: 'First child' },
        {
          name: 'child2',
          type: 'object',
          description: 'Second child',
          children: [
            { name: 'grandchild', type: 'number', description: 'Nested' },
          ],
        },
      ],
    };
    expect(node.children).toHaveLength(2);
    expect(node.children?.[1]?.children).toHaveLength(1);
    expect(node.children?.[1]?.children?.[0]?.name).toBe('grandchild');
  });
});

// ---------------------------------------------------------------------------
// Type inference checks (compile-time + runtime structural)
// ---------------------------------------------------------------------------

describe('Type inference', () => {
  it('Study type is inferred correctly from StudySchema', () => {
    const study: Study = StudySchema.parse(fullStudy);
    // Access typed fields to verify inference works
    expect(study.protocolSection?.identificationModule?.nctId).toBe(
      'NCT00000001',
    );
    expect(study.hasResults).toBe(false);
  });

  it('PagedStudies type matches schema output', () => {
    const paged: PagedStudies = PagedStudiesSchema.parse({
      studies: [fullStudy],
      nextPageToken: 'tok',
      totalCount: 1,
    });
    expect(paged.studies).toHaveLength(1);
    expect(paged.nextPageToken).toBe('tok');
  });

  it('StudyMetadata type matches schema output', () => {
    const metadata: StudyMetadata = StudyMetadataSchema.parse({
      nctId: 'NCT00000001',
      title: 'Test',
    });
    expect(metadata.nctId).toBe('NCT00000001');
    expect(metadata.title).toBe('Test');
  });
});
