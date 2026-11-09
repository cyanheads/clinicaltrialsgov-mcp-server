/**
 * @fileoverview Security tests for tool inputs: injection, oversized inputs,
 * no-secret-leaks, and path traversal prevention.
 * @module tests/mcp-server/tools/security
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock service — hoisted so vi.mock can close over it
// ---------------------------------------------------------------------------

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';
import { getFieldDefinitions } from '@/mcp-server/tools/definitions/get-field-definitions.tool.js';
import { getFieldValues } from '@/mcp-server/tools/definitions/get-field-values.tool.js';
import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';
import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Assert that no string in `output` contains a known secret pattern.
 * The test server has no real secrets — asserts env-var names aren't leaked.
 */
function assertNoSecretLeak(output: unknown) {
  const text = JSON.stringify(output);
  // No env var names that could carry credentials should appear in output
  expect(text).not.toMatch(/CT_API_BASE_URL|CT_REQUEST_TIMEOUT_MS|CT_MAX_PAGE_SIZE/);
  // No process.env patterns
  expect(text).not.toContain('process.env');
}

// ---------------------------------------------------------------------------
// Injection payloads
// ---------------------------------------------------------------------------

const INJECTION_PAYLOADS = [
  // SQL/query injection
  "'; DROP TABLE studies; --",
  "1' OR '1'='1",
  "' UNION SELECT * FROM studies --",
  // URL/path traversal
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  // Prototype pollution
  '__proto__',
  'constructor.prototype',
  '[object Object]',
  // Script injection
  '<script>alert(1)</script>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional injection payload test
  '${7*7}',
  '{{7*7}}',
  // Null bytes
  'normal\x00injection',
  // Unicode normalization attack
  '‮anormaltext',
];

const OVERSIZED_INPUTS = {
  string1k: 'A'.repeat(1_000),
  string10k: 'B'.repeat(10_000),
  string100k: 'C'.repeat(100_000),
};

// ---------------------------------------------------------------------------
// Line-break tables (#180)
// ---------------------------------------------------------------------------

/**
 * Registry values for a line-break table. `br` makes a value for a single-line
 * slot, whose break would open a forged `## Forged <field>` heading if left
 * in; `prose` makes a long-form prose value, which keeps its break. Each is
 * recorded under its field name, so a table checks exactly the values its
 * fixture placed.
 */
function lineBreakValues(lineBreak: string) {
  const single = new Map<string, string>();
  const block = new Map<string, string>();
  const record = (map: Map<string, string>, field: string, value: string) => {
    map.set(field, value);
    return value;
  };
  return {
    single,
    block,
    br: (field: string, value = `${field} start${lineBreak}## Forged ${field}`) =>
      record(single, field, value),
    prose: (field: string) => record(block, field, `${field} start${lineBreak}## Kept ${field}`),
  };
}

/**
 * What a rendering did with the values `lineBreakValues` recorded: lines that
 * open with a forged heading, single-line values absent from the text or not
 * kept whole on one line with their break folded to a space, and prose values
 * not rendered verbatim. All three are empty when every slot holds.
 */
function lineBreakFindings(
  text: string,
  { single, block }: ReturnType<typeof lineBreakValues>,
  lineBreak: string,
) {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    forgedHeadings: lines.filter((l) => /^\s*## Forged/.test(l)),
    unfolded: [...single]
      .filter(([field, value]) => {
        const rendered = lines.filter((l) => new RegExp(`## Forged ${field}(?![A-Za-z])`).test(l));
        const folded = value.replace(lineBreak, ' ');
        return rendered.length === 0 || rendered.some((l) => !l.includes(folded));
      })
      .map(([field]) => field),
    proseChanged: [...block].filter(([, value]) => !text.includes(value)).map(([field]) => field),
  };
}

const NO_LINE_BREAK_FINDINGS = { forgedHeadings: [], unfolded: [], proseChanged: [] };

// ---------------------------------------------------------------------------
// searchStudies — input validation security
// ---------------------------------------------------------------------------

describe('searchStudies — injection and oversized inputs', () => {
  const mockService = { searchStudies: vi.fn(), maxPageSize: 200 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
  });

  it.each(INJECTION_PAYLOADS)(
    'query field passes injection payload %s to the service (Zod does not sanitize strings)',
    async (payload) => {
      // Zod does not strip or reject arbitrary strings in free-text fields.
      // The important invariant is no crash and no prototype pollution.
      const ctx = createMockContext({ errors: searchStudies.errors });
      const input = searchStudies.input!.parse({ query: payload });
      await expect(searchStudies.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('rejects NCT ID injection that does not match NCTxxxxxxxx format', () => {
    expect(() => searchStudies.input!.parse({ nctIds: "'; DROP TABLE --" })).toThrow();
  });

  it('rejects NCT ID array containing injection payload', () => {
    expect(() => searchStudies.input!.parse({ nctIds: ['NCT12345678', "' OR 1=1 --"] })).toThrow();
  });

  it('oversized query string — handler does not crash', async () => {
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    const ctx = createMockContext({ errors: searchStudies.errors });
    const input = searchStudies.input!.parse({ query: OVERSIZED_INPUTS.string1k });
    await expect(searchStudies.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    mockService.searchStudies.mockResolvedValue({
      studies: [{ nctId: 'NCT12345678' }],
      totalCount: 1,
    });
    const ctx = createMockContext({ errors: searchStudies.errors });
    const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);
    assertNoSecretLeak(result);
  });

  it('per-page cap disclosure names numbers, never the env var (#153)', async () => {
    mockService.searchStudies.mockResolvedValue({
      studies: Array.from({ length: 200 }, () => ({ nctId: 'NCT12345678' })),
      totalCount: 900,
      nextPageToken: 'tok_page2',
    });
    const result = await runToolContract(searchStudies, { query: 'cancer', pageSize: 999 });
    expect(result.structuredContent).toMatchObject({ truncated: true, cap: 200 });
    // The disclosure exists and states the cap as a number, so the leak check below has text to scan.
    expect((result.structuredContent as { notice?: string }).notice).toContain(
      'per-page cap of 200',
    );
    assertNoSecretLeak(result);
  });

  it.each(['', '   '])(
    'rejects a blank query (%j) rather than searching the whole registry',
    async (query) => {
      const ctx = createMockContext({ errors: searchStudies.errors });
      await expect(
        searchStudies.handler(searchStudies.input!.parse({ query }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    },
  );

  // phaseFilter entries are interpolated into AREA[Phase]<entry>; an
  // expression there must be refused, never forwarded to widen the cohort (#144).
  it.each([
    'PHASE3 OR AREA[StudyType]OBSERVATIONAL',
    'PHASE3) OR (AREA[StudyType]OBSERVATIONAL',
    'NOT AREA[StudyType]INTERVENTIONAL',
    ...INJECTION_PAYLOADS,
  ])('refuses the phaseFilter payload %j with enum_invalid before any request', async (payload) => {
    const ctx = createMockContext({ errors: searchStudies.errors });
    await expect(
      searchStudies.handler(searchStudies.input!.parse({ phaseFilter: ['PHASE3', payload] }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'enum_invalid', param: 'phaseFilter' } });
    expect(mockService.searchStudies).not.toHaveBeenCalled();
  });

  // fields entries are split on `,`/`|` and handed to the service, which
  // validates each piece; a payload must neither crash the handler nor be
  // judged blank, and every piece of a joined payload reaches the service (#152).
  it.each([
    ...INJECTION_PAYLOADS.map((payload) => [payload, [payload]] as const),
    ["NCTId,'; DROP TABLE studies; --", ['NCTId', "'; DROP TABLE studies; --"]] as const,
    ['__proto__|constructor', ['__proto__', 'constructor']] as const,
  ])('passes the fields payload %j to the service as the names %j', async (payload, names) => {
    const ctx = createMockContext({ errors: searchStudies.errors });
    const input = searchStudies.input!.parse({ fields: [payload] });
    const result = await searchStudies.handler(input, ctx);
    expect(mockService.searchStudies).toHaveBeenCalledWith(
      expect.objectContaining({ fields: names }),
      ctx,
    );
    expect(result.requestedFields).toEqual(names);
  });

  /**
   * Every registry string the index entry, the requested-fields header and
   * site lines, and the field dump write into a single-line slot is flattened,
   * so a line break in it cannot end the line and start a forged heading,
   * bullet, or row; long-form prose in the dump keeps its breaks (#180).
   */
  it.each(['\r\n', '\n', '\r'])(
    'keeps a %j in any single-line slot from starting a new content[] line (#180)',
    async (lineBreak) => {
      const record = ({ br }: ReturnType<typeof lineBreakValues>) => ({
        hasResults: false,
        protocolSection: {
          identificationModule: { nctId: br('nctId'), briefTitle: br('briefTitle') },
          statusModule: {
            overallStatus: br('overallStatus'),
            startDateStruct: { date: br('startDate') },
            primaryCompletionDateStruct: { date: br('primaryCompletionDate') },
          },
          designModule: { phases: [br('phase')], enrollmentInfo: { count: 10 } },
          sponsorCollaboratorsModule: { leadSponsor: { name: br('leadSponsor') } },
          conditionsModule: { conditions: [br('condition')] },
          contactsLocationsModule: {
            locations: [
              {
                facility: br('facility'),
                city: br('city'),
                state: br('state'),
                country: br('country'),
                status: br('siteStatus'),
                geoPoint: { lat: 47.6, lon: -122.3 },
              },
              { facility: 'Second site' },
            ],
          },
        },
      });
      const render = async (input: Record<string, unknown>, study: unknown) => {
        mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });
        const ctx = createMockContext({ errors: searchStudies.errors });
        const result = await searchStudies.handler(searchStudies.input!.parse(input), ctx);
        return { result, text: (searchStudies.format!(result)[0] as { text: string }).text };
      };

      // The compact index: the lead site, and the nearest site under a geoFilter.
      for (const input of [{}, { geoFilter: 'distance(47.6,-122.3,50mi)' }]) {
        const values = lineBreakValues(lineBreak);
        const study = record(values);
        const { result, text } = await render(input, study);
        expect(lineBreakFindings(text, values, lineBreak), JSON.stringify(input)).toEqual(
          NO_LINE_BREAK_FINDINGS,
        );
        // structuredContent keeps every upstream value verbatim.
        const site = study.protocolSection.contactsLocationsModule.locations[0]!;
        expect(result.studies[0]).toMatchObject({
          briefTitle: study.protocolSection.identificationModule.briefTitle,
          leadSponsor: study.protocolSection.sponsorCollaboratorsModule.leadSponsor.name,
          conditions: study.protocolSection.conditionsModule.conditions,
          locations: { nearest: { facility: site.facility, country: site.country } },
        });
      }

      // Requested fields: the header, every site line, and the field dump.
      const values = lineBreakValues(lineBreak);
      const base = record(values);
      const [lead, second] = base.protocolSection.contactsLocationsModule.locations;
      const study = {
        ...base,
        protocolSection: {
          ...base.protocolSection,
          identificationModule: {
            ...base.protocolSection.identificationModule,
            officialTitle: values.br('officialTitle'),
          },
          descriptionModule: { briefSummary: values.prose('briefSummary') },
          contactsLocationsModule: { locations: [{ ...lead, zip: values.br('zip') }, second] },
        },
      };
      const { result, text } = await render({ fields: ['NCTId', 'BriefTitle'] }, study);
      expect(lineBreakFindings(text, values, lineBreak)).toEqual(NO_LINE_BREAK_FINDINGS);
      expect(result.studies[0]).toEqual(study);
    },
  );
});

// ---------------------------------------------------------------------------
// getStudy — NCT ID injection and output safety
// ---------------------------------------------------------------------------

describe('getStudy — injection and output safety', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  it.each([
    "'; DROP TABLE studies; --",
    '../../../etc/passwd',
    '%2e%2e%2fNCT12345678',
    'NCT1234567A', // invalid — too short + non-numeric
  ])('rejects invalid NCT ID pattern: %s', (payload) => {
    expect(() => getStudy.input!.parse({ nctId: payload })).toThrow();
  });

  it('format output does not leak env var names', async () => {
    mockService.getStudy.mockResolvedValue({
      protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
    });
    const ctx = createMockContext({ errors: getStudy.errors });
    const result = await getStudy.handler(getStudy.input!.parse({ nctId: 'NCT12345678' }), ctx);
    assertNoSecretLeak(result);
    const formatted = getStudy.format!(result);
    assertNoSecretLeak(formatted);
  });

  /**
   * Every registry string the record writes into a single-line slot — the
   * title heading, `**Label:** value` lines, bullets, and their indented
   * detail rows — is flattened, so a line break in it cannot end the line and
   * start a forged heading, bullet, or row. A prose field under its own
   * heading or label keeps its breaks (#180).
   */
  it.each(['\r\n', '\n', '\r'])(
    'keeps a %j in any single-line slot from starting a new content[] line (#180)',
    async (lineBreak) => {
      const values = lineBreakValues(lineBreak);
      const { br, prose } = values;
      const dated = (field: string) => ({ date: br(field), type: br(`${field}Type`) });
      const study = {
        hasResults: false,
        protocolSection: {
          identificationModule: {
            nctId: br('nctId'),
            briefTitle: br('briefTitle'),
            officialTitle: br('officialTitle'),
            acronym: br('acronym'),
            nctIdAliases: [br('nctIdAlias')],
            orgStudyIdInfo: { id: br('orgStudyId'), type: br('orgStudyIdType') },
            organization: { fullName: br('organization'), class: br('organizationClass') },
            secondaryIdInfos: [
              {
                id: br('secondaryId'),
                type: br('secondaryIdType'),
                domain: br('secondaryIdDomain'),
                link: br('secondaryIdLink'),
              },
            ],
          },
          statusModule: {
            overallStatus: br('overallStatus'),
            lastKnownStatus: br('lastKnownStatus'),
            whyStopped: br('whyStopped'),
            startDateStruct: dated('startDate'),
            primaryCompletionDateStruct: { date: br('primaryCompletionDate') },
            completionDateStruct: { date: br('completionDate') },
            studyFirstSubmitDate: br('firstSubmit'),
            studyFirstSubmitQcDate: br('firstSubmitQc'),
            studyFirstPostDateStruct: { date: br('firstPost') },
            resultsFirstSubmitDate: br('resultsFirstSubmit'),
            resultsFirstSubmitQcDate: br('resultsFirstSubmitQc'),
            resultsFirstPostDateStruct: { date: br('resultsFirstPost') },
            dispFirstSubmitDate: br('dispFirstSubmit'),
            dispFirstSubmitQcDate: br('dispFirstSubmitQc'),
            dispFirstPostDateStruct: { date: br('dispFirstPost') },
            lastUpdateSubmitDate: br('lastUpdateSubmit'),
            lastUpdatePostDateStruct: { date: br('lastUpdatePost') },
            statusVerifiedDate: br('verified'),
            expandedAccessInfo: {
              hasExpandedAccess: true,
              nctId: br('expandedAccessNctId'),
              statusForNctId: br('expandedAccessStatus'),
            },
          },
          sponsorCollaboratorsModule: {
            leadSponsor: { name: br('leadSponsor'), class: br('leadSponsorClass') },
            collaborators: [{ name: br('collaborator'), class: br('collaboratorClass') }],
            responsibleParty: {
              type: br('responsiblePartyType'),
              investigatorFullName: br('investigatorFullName'),
              investigatorTitle: br('investigatorTitle'),
              investigatorAffiliation: br('investigatorAffiliation'),
              oldNameTitle: br('oldNameTitle'),
              oldOrganization: br('oldOrganization'),
            },
          },
          descriptionModule: {
            briefSummary: prose('briefSummary'),
            detailedDescription: prose('detailedDescription'),
          },
          conditionsModule: { conditions: [br('condition')], keywords: [br('keyword')] },
          designModule: {
            studyType: br('studyType'),
            phases: [br('phase')],
            enrollmentInfo: { count: 10, type: br('enrollmentType') },
            designInfo: {
              allocation: br('allocation'),
              interventionModel: br('interventionModel'),
              primaryPurpose: br('primaryPurpose'),
              observationalModel: br('observationalModel'),
              timePerspective: br('timePerspective'),
              interventionModelDescription: prose('interventionModelDescription'),
              maskingInfo: {
                masking: br('masking'),
                whoMasked: [br('whoMasked')],
                maskingDescription: prose('maskingDescription'),
              },
            },
            targetDuration: br('targetDuration'),
            bioSpec: { retention: br('bioSpecRetention'), description: br('bioSpecDescription') },
          },
          armsInterventionsModule: {
            interventions: [
              {
                type: br('interventionType'),
                name: br('interventionName'),
                description: br('interventionDescription'),
                otherNames: [br('interventionOtherName')],
                armGroupLabels: [br('interventionArmLabel')],
              },
            ],
            armGroups: [
              {
                label: br('armLabel'),
                type: br('armType'),
                description: br('armDescription'),
                interventionNames: [br('armInterventionName')],
              },
            ],
          },
          outcomesModule: {
            primaryOutcomes: [
              {
                measure: br('primaryMeasure'),
                timeFrame: br('primaryTimeFrame'),
                description: prose('primaryDescription'),
              },
            ],
            secondaryOutcomes: [
              { measure: br('secondaryMeasure'), timeFrame: br('secondaryTimeFrame') },
            ],
            otherOutcomes: [{ measure: br('otherMeasure'), timeFrame: br('otherTimeFrame') }],
          },
          eligibilityModule: {
            minimumAge: br('minimumAge'),
            maximumAge: br('maximumAge'),
            sex: br('sex'),
            genderBased: true,
            genderDescription: prose('genderDescription'),
            healthyVolunteers: false,
            stdAges: [br('stdAge')],
            samplingMethod: br('samplingMethod'),
            studyPopulation: prose('studyPopulation'),
            eligibilityCriteria: prose('eligibilityCriteria'),
          },
          contactsLocationsModule: {
            centralContacts: [
              {
                name: br('centralName'),
                role: br('centralRole'),
                phone: br('centralPhone'),
                phoneExt: br('centralPhoneExt'),
                email: br('centralEmail'),
              },
            ],
            overallOfficials: [
              {
                name: br('officialName'),
                role: br('officialRole'),
                affiliation: br('officialAffiliation'),
              },
            ],
            locations: [
              {
                facility: br('facility'),
                city: br('city'),
                state: br('state'),
                zip: br('zip'),
                country: br('country'),
                status: br('siteStatus'),
                contacts: [{ name: br('siteContactName'), email: br('siteContactEmail') }],
              },
            ],
          },
          ipdSharingStatementModule: {
            ipdSharing: br('ipdSharing'),
            infoTypes: [br('ipdInfoType')],
            timeFrame: br('ipdTimeFrame'),
            accessCriteria: prose('ipdAccessCriteria'),
            url: br('ipdUrl'),
            description: prose('ipdDescription'),
          },
          referencesModule: {
            references: [
              {
                citation: br('citation'),
                pmid: br('pmid'),
                type: br('referenceType'),
                retractions: [{ source: br('retractionSource'), pmid: br('retractionPmid') }],
              },
            ],
            seeAlsoLinks: [{ label: br('seeAlsoLabel'), url: br('seeAlsoUrl') }],
            availIpds: [
              {
                type: br('availIpdType'),
                id: br('availIpdId'),
                url: br('availIpdUrl'),
                comment: br('availIpdComment'),
              },
            ],
          },
        },
        derivedSection: {
          conditionBrowseModule: {
            meshes: [{ term: br('conditionMesh'), id: br('conditionMeshId') }],
            browseLeaves: [
              {
                name: br('conditionLeaf'),
                id: br('conditionLeafId'),
                relevance: br('conditionLeafRelevance'),
                asFound: br('conditionLeafAsFound'),
              },
            ],
            ancestors: [{ term: br('conditionAncestor'), id: br('conditionAncestorId') }],
            browseBranches: [{ name: br('conditionBranch'), abbrev: br('conditionBranchAbbrev') }],
          },
          interventionBrowseModule: { meshes: [{ term: br('interventionMesh') }] },
          miscInfoModule: {
            versionHolder: br('versionHolder'),
            removedCountries: [br('removedCountry')],
            submissionTracking: {
              estimatedResultsFirstSubmitDate: br('estimatedResultsFirstSubmit'),
              firstMcpInfo: { postDateStruct: { date: br('firstMcpPost') } },
              submissionInfos: [
                {
                  releaseDate: br('submissionRelease'),
                  unreleaseDate: br('submissionUnrelease'),
                  resetDate: br('submissionReset'),
                },
              ],
            },
          },
        },
        documentSection: {
          largeDocumentModule: {
            largeDocs: [
              {
                label: br('docLabel'),
                typeAbbrev: br('docType'),
                date: br('docDate'),
                filename: br('docFilename'),
                uploadDate: br('docUploadDate'),
                hasProtocol: true,
                size: 10,
              },
            ],
          },
        },
        annotationSection: {
          annotationModule: {
            unpostedAnnotation: {
              unpostedResponsibleParty: br('unpostedParty'),
              unpostedEvents: [{ type: br('unpostedType'), date: br('unpostedDate') }],
            },
            violationAnnotation: {
              violationEvents: [
                {
                  type: br('violationType'),
                  creationDate: br('violationCreated'),
                  issuedDate: br('violationIssued'),
                  releaseDate: br('violationReleased'),
                  postedDate: br('violationPosted'),
                  resetDate: br('violationReset'),
                  description: prose('violationDescription'),
                },
              ],
            },
          },
        },
      };
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext({ errors: getStudy.errors });
      const result = await getStudy.handler(getStudy.input!.parse({ nctId: 'NCT12345678' }), ctx);
      const text = (getStudy.format!(result)[0] as { text: string }).text;

      expect(lineBreakFindings(text, values, lineBreak)).toEqual(NO_LINE_BREAK_FINDINGS);
      // structuredContent keeps every upstream value verbatim.
      expect(result.study).toMatchObject(study);
    },
  );
});

// ---------------------------------------------------------------------------
// getStudyCount — injection and output safety
// ---------------------------------------------------------------------------

describe('getStudyCount — injection and output safety', () => {
  const mockService = { countStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.countStudies.mockResolvedValue(42);
  });

  it.each(INJECTION_PAYLOADS)(
    'accepts free-text payload %s without crashing (no validation on plain strings)',
    async (payload) => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      const input = getStudyCount.input!.parse({ conditionQuery: payload });
      await expect(getStudyCount.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('oversized conditionQuery does not crash', async () => {
    const ctx = createMockContext({ errors: getStudyCount.errors });
    const input = getStudyCount.input!.parse({ conditionQuery: OVERSIZED_INPUTS.string1k });
    await expect(getStudyCount.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    const ctx = createMockContext({ errors: getStudyCount.errors });
    const result = await getStudyCount.handler(getStudyCount.input!.parse({}), ctx);
    assertNoSecretLeak(result);
  });

  it.each(['', '   '])(
    'rejects a blank conditionQuery (%j) rather than counting the whole registry',
    async (conditionQuery) => {
      const ctx = createMockContext({ errors: getStudyCount.errors });
      await expect(
        getStudyCount.handler(getStudyCount.input!.parse({ conditionQuery }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.countStudies).not.toHaveBeenCalled();
    },
  );

  it.each([
    'PHASE3 OR AREA[StudyType]OBSERVATIONAL',
    'NOT AREA[StudyType]INTERVENTIONAL',
    ...INJECTION_PAYLOADS,
  ])('refuses the phaseFilter payload %j with enum_invalid before any request', async (payload) => {
    const ctx = createMockContext({ errors: getStudyCount.errors });
    await expect(
      getStudyCount.handler(getStudyCount.input!.parse({ phaseFilter: payload }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'enum_invalid', param: 'phaseFilter' } });
    expect(mockService.countStudies).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getStudyResults — injection and output safety
// ---------------------------------------------------------------------------

describe('getStudyResults — injection and output safety', () => {
  const mockService = { getStudiesBatch: vi.fn(), getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getStudiesBatch.mockResolvedValue([]);
  });

  it.each(["'; DROP TABLE --", '../../../etc/passwd', '__proto__'])(
    'rejects injection payload %s as NCT ID',
    (payload) => {
      expect(() => getStudyResults.input!.parse({ nctIds: payload })).toThrow();
    },
  );

  // The nctId alias (#151) resolves in the argument stage `input.parse()` skips.
  it.each(["'; DROP TABLE --", '../../../etc/passwd', '__proto__'])(
    'rejects injection payload %s sent under the nctId alias',
    async (payload) => {
      const result = await runToolContract(getStudyResults, { nctId: payload } as never);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        'nctIds: NCT IDs must match format NCTxxxxxxxx (8 digits).',
      );
      expect(mockService.getStudiesBatch).not.toHaveBeenCalled();
    },
  );

  it('format output does not leak env var names', () => {
    const formatted = getStudyResults.format!({
      results: [{ nctId: 'NCT12345678', title: 'Test', hasResults: false }],
    });
    assertNoSecretLeak(formatted);
  });

  it('rejects an array past the 500-entry ceiling before fetching (#153)', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `NCT${String(i).padStart(8, '0')}`);
    expect(() => getStudyResults.input!.parse({ nctIds: ids })).toThrow();
    const result = await runToolContract(getStudyResults, { nctIds: ids });
    expect(result.isError).toBe(true);
    expect(mockService.getStudiesBatch).not.toHaveBeenCalled();
  });

  it('per-call cap disclosure names numbers, never an env var (#153)', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `NCT${String(i).padStart(8, '0')}`);
    const result = await runToolContract(getStudyResults, { nctIds: ids });
    expect(result.structuredContent).toMatchObject({ deferredNctIds: ids.slice(20) });
    expect(JSON.stringify(result.content)).toContain('per-call cap of 20');
    assertNoSecretLeak(result);
  });

  it.each(['outcomeOffset', 'seriousEventOffset', 'otherEventOffset'])(
    'rejects a non-integer, negative, or non-finite %s',
    (param) => {
      for (const bad of [-1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          getStudyResults.input!.parse({ nctIds: 'NCT12345678', [param]: bad }),
        ).toThrow();
      }
    },
  );

  it('renders a bounded window and an alias resolution without leaking env var names', () => {
    const formatted = getStudyResults.format!({
      results: [
        {
          nctId: 'NCT12345678',
          canonicalNctId: 'NCT87654321',
          title: 'Test',
          hasResults: true,
          filtersApplied: {
            totalOutcomes: 40,
            outcomeLimit: 5,
            outcomeOffset: 10,
            nextOutcomeOffset: 15,
          },
        },
        {
          // A summary-mode page of the same window (#149).
          nctId: 'NCT11111111',
          title: 'Summary Test',
          hasResults: true,
          outcomes: [
            {
              type: 'PRIMARY',
              title: 'Outcome 11',
              groupCount: 2,
              classCount: 2,
              analysisCount: 2,
              topStats: [{ group: 'Placebo', value: '15.0' }],
              topStatsFrom: {
                classTitle: 'Male',
                classDenoms: [
                  { units: 'Participants', counts: [{ group: 'Placebo', value: '332' }] },
                ],
                omittedClasses: 1,
              },
              topAnalysis: {
                groupIds: ['OG000'],
                groups: ['Placebo'],
                groupDescription: 'This analysis is for Male participants',
              },
            },
          ],
          filtersApplied: {
            totalOutcomes: 40,
            outcomeLimit: 5,
            outcomeOffset: 10,
            nextOutcomeOffset: 15,
          },
        },
      ],
      truncated: true,
    });
    assertNoSecretLeak(formatted);
    const text = (formatted[0] as { text: string }).text;
    expect(text).toContain('Male denominator (Participants): Placebo: 332');
    expect(text.match(/_Bounded: returning 5 of 40 outcome measures/g)).toHaveLength(2);
  });

  it.each(['\r\n', '\n', '\r'])(
    'keeps a %j inside an analysis groupDescription from starting a new content[] line (#146)',
    async (lineBreak) => {
      const groupDescription = `Male participants${lineBreak}## Forged heading${lineBreak}- forged bullet`;
      mockService.getStudiesBatch.mockResolvedValue([
        {
          hasResults: true,
          protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
          resultsSection: {
            outcomeMeasuresModule: {
              outcomeMeasures: [
                {
                  title: 'Time to Recovery',
                  groups: [{ id: 'OG000', title: 'Placebo' }],
                  analyses: [{ groupIds: ['OG000'], groupDescription, paramValue: '1.30' }],
                },
              ],
            },
          },
        },
      ]);
      for (const summary of [true, false]) {
        const ctx = createMockContext({ errors: getStudyResults.errors });
        const result = await getStudyResults.handler(
          getStudyResults.input!.parse({ nctIds: 'NCT12345678', sections: 'outcomes', summary }),
          ctx,
        );
        const text = (getStudyResults.format!(result)[0] as { text: string }).text;
        const lines = text.split(/\r\n|\r|\n/);
        expect(lines.filter((l) => l.includes('Forged'))).toEqual([
          expect.stringMatching(
            /^ {2}Analysis: .*Male participants ## Forged heading - forged bullet$/,
          ),
        ]);
        if (summary) {
          // structuredContent keeps the upstream value verbatim.
          const outcome = result.results[0]!.outcomes![0]!;
          expect(outcome.topAnalysis).toMatchObject({ groupDescription });
        }
      }
    },
  );

  /**
   * Every upstream string rendered into a single-line slot — titles, units,
   * time frames, comments, and terms on a bullet, heading, row, or label line —
   * is flattened, so a sponsor-entered line break cannot end the line and
   * start a forged one (#156). Each value ends `## Forged <field>`; flattened,
   * it stays on the line its field opens.
   */
  it.each(['\r\n', '\n', '\r'])(
    'keeps a %j in any single-line slot from starting a new content[] line (#156)',
    async (lineBreak) => {
      const br = (field: string) => `${field} start${lineBreak}## Forged ${field}`;
      const outcome = {
        type: 'PRIMARY',
        title: br('outcomeTitle'),
        timeFrame: br('timeFrame'),
        paramType: 'MEAN',
        unitOfMeasure: br('unit'),
        typeUnitsAnalyzed: br('outcomeUnitsAnalyzed'),
        groups: [{ id: 'OG000', title: br('groupTitle') }],
        denoms: [{ units: br('denomUnits'), counts: [{ groupId: 'OG000', value: '10' }] }],
        classes: [
          {
            title: br('classTitle'),
            denoms: [{ units: br('classDenomUnits'), counts: [{ groupId: 'OG000', value: '9' }] }],
            categories: [
              {
                title: br('categoryTitle'),
                measurements: [{ groupId: 'OG000', value: '5', comment: br('cellComment') }],
              },
            ],
          },
          {
            title: 'Second class',
            categories: [{ measurements: [{ groupId: 'OG000', value: '6' }] }],
          },
        ],
        analyses: [
          {
            groupIds: ['OG000'],
            statisticalMethod: br('statisticalMethod'),
            statisticalComment: br('statisticalComment'),
            pValue: '0.01',
            pValueComment: br('pValueComment'),
            nonInferiorityType: 'SUPERIORITY',
            nonInferiorityComment: br('nonInferiorityComment'),
            paramType: 'Mean Difference',
            paramValue: '1.3',
            ciPctValue: '95',
            ciLowerLimit: '1',
            ciUpperLimit: '2',
            ciLowerLimitComment: br('ciLowerLimitComment'),
            ciUpperLimitComment: br('ciUpperLimitComment'),
            estimateComment: br('estimateComment'),
            otherAnalysisDescription: br('otherAnalysisDescription'),
          },
        ],
      };
      const study = {
        hasResults: true,
        protocolSection: {
          identificationModule: { nctId: 'NCT12345678', briefTitle: br('briefTitle') },
        },
        resultsSection: {
          outcomeMeasuresModule: { outcomeMeasures: [outcome] },
          baselineCharacteristicsModule: {
            typeUnitsAnalyzed: br('baselineUnitsAnalyzed'),
            groups: [{ id: 'BG000', title: br('baselineGroup') }],
            measures: [
              {
                title: br('baselineMeasure'),
                paramType: 'COUNT_OF_PARTICIPANTS',
                unitOfMeasure: br('baselineUnit'),
                denomUnitsSelected: br('baselineDenomUnits'),
                classes: [
                  {
                    title: br('baselineClass'),
                    categories: [
                      {
                        title: br('baselineCategory'),
                        measurements: [{ groupId: 'BG000', value: '3' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          adverseEventsModule: {
            timeFrame: br('aeTimeFrame'),
            frequencyThreshold: br('aeThreshold'),
            eventGroups: [{ id: 'EG000', title: br('aeGroupTitle') }],
            seriousEvents: [
              {
                term: br('aeTerm'),
                organSystem: br('aeOrganSystem'),
                stats: [{ groupId: 'EG000', numAffected: 1, numAtRisk: 10 }],
              },
            ],
          },
          participantFlowModule: {
            typeUnitsAnalyzed: br('flowUnitsAnalyzed'),
            groups: [{ id: 'FG000', title: br('flowGroup') }],
            periods: [
              {
                title: br('periodTitle'),
                milestones: [
                  {
                    type: br('milestoneType'),
                    comment: br('milestoneComment'),
                    achievements: [
                      { groupId: 'FG000', numSubjects: '10', comment: br('achievementComment') },
                    ],
                  },
                ],
                dropWithdraws: [
                  {
                    type: br('dropType'),
                    comment: br('dropComment'),
                    reasons: [{ groupId: 'FG000', numSubjects: '1' }],
                  },
                ],
              },
            ],
          },
          moreInfoModule: {
            certainAgreement: { restrictiveAgreement: true, restrictionType: br('restriction') },
            pointOfContact: { title: br('pocTitle'), organization: br('pocOrganization') },
          },
        },
      };
      mockService.getStudiesBatch.mockResolvedValue([study]);

      const everywhere = [
        'briefTitle',
        'outcomeTitle',
        'timeFrame',
        'unit',
        'groupTitle',
        'denomUnits',
        'classTitle',
        'classDenomUnits',
        'categoryTitle',
        'cellComment',
        'statisticalMethod',
        'pValueComment',
        'estimateComment',
        'baselineMeasure',
        'baselineUnit',
        'aeTimeFrame',
        'aeThreshold',
        'aeGroupTitle',
        'aeTerm',
        'aeOrganSystem',
        'restriction',
        'pocTitle',
        'pocOrganization',
      ];
      const fullOnly = [
        'outcomeUnitsAnalyzed',
        'statisticalComment',
        'nonInferiorityComment',
        'ciLowerLimitComment',
        'ciUpperLimitComment',
        'otherAnalysisDescription',
        'baselineUnitsAnalyzed',
        'baselineGroup',
        'baselineDenomUnits',
        'baselineClass',
        'baselineCategory',
        'flowUnitsAnalyzed',
        'flowGroup',
        'periodTitle',
        'milestoneType',
        'milestoneComment',
        'achievementComment',
        'dropType',
        'dropComment',
      ];

      for (const summary of [true, false]) {
        const ctx = createMockContext({ errors: getStudyResults.errors });
        const result = await getStudyResults.handler(
          getStudyResults.input!.parse({ nctIds: 'NCT12345678', summary }),
          ctx,
        );
        const lines = (getStudyResults.format!(result)[0] as { text: string }).text.split(
          /\r\n|\r|\n/,
        );

        expect(lines.filter((l) => /^\s*## Forged/.test(l))).toEqual([]);
        for (const field of summary ? everywhere : [...everywhere, ...fullOnly]) {
          const rendered = lines.filter((l) =>
            new RegExp(`## Forged ${field}(?![A-Za-z])`).test(l),
          );
          expect(rendered, field).not.toEqual([]);
          for (const line of rendered) {
            expect(line, field).toContain(`${field} start ## Forged ${field}`);
          }
        }

        // structuredContent keeps every upstream value verbatim.
        const r = result.results[0]!;
        expect(r.title).toBe(br('briefTitle'));
        const shown = r.outcomes![0]!;
        expect(shown).toMatchObject({ title: br('outcomeTitle'), timeFrame: br('timeFrame') });
        if (summary) {
          expect(shown.topStatsFrom).toMatchObject({
            classTitle: br('classTitle'),
            categoryTitle: br('categoryTitle'),
          });
          expect(shown.topAnalysis).toMatchObject({ estimateComment: br('estimateComment') });
        } else {
          expect(shown).toEqual(outcome);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// getFieldValues — injection and output safety
// ---------------------------------------------------------------------------

describe('getFieldValues — injection and output safety', () => {
  const mockService = { getFieldValues: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getFieldValues.mockResolvedValue([]);
  });

  it.each(INJECTION_PAYLOADS)(
    'passes injection payload %s as field name string to service (no crash)',
    async (payload) => {
      const ctx = createMockContext({ errors: getFieldValues.errors });
      // Zod accepts any string for field names — the API rejects invalid ones
      const input = getFieldValues.input!.parse({ fields: payload });
      await expect(getFieldValues.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('output does not contain env var names', async () => {
    mockService.getFieldValues.mockResolvedValue([
      { field: 'OverallStatus', piece: 'OverallStatus', type: 'ENUM', topValues: [] },
    ]);
    const ctx = createMockContext({ errors: getFieldValues.errors });
    const result = await getFieldValues.handler(
      getFieldValues.input!.parse({ fields: 'OverallStatus' }),
      ctx,
    );
    assertNoSecretLeak(result);
  });
});

// ---------------------------------------------------------------------------
// getFieldDefinitions — path traversal and injection
// ---------------------------------------------------------------------------

describe('getFieldDefinitions — path traversal and injection', () => {
  const mockService = { getMetadata: vi.fn(), searchFieldDefinitions: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getMetadata.mockResolvedValue([]);
    mockService.searchFieldDefinitions.mockResolvedValue({ entries: [], total: 0 });
  });

  it.each(['../../../etc/passwd', '..\\windows\\system32', '%2e%2e%2f'])(
    'drill mode with path traversal payload "%s" throws (path not found) and does not crash',
    async (payload) => {
      const ctx = createMockContext({ errors: getFieldDefinitions.errors });
      const input = getFieldDefinitions.input!.parse({ mode: 'drill', path: payload });
      // Handler should throw "path not found" since no such node exists — not a crash
      await expect(getFieldDefinitions.handler(input, ctx)).rejects.toThrow();
    },
  );

  it.each(INJECTION_PAYLOADS)(
    'search mode passes injection payload %s to searchFieldDefinitions without crash',
    async (payload) => {
      const ctx = createMockContext({ errors: getFieldDefinitions.errors });
      const input = getFieldDefinitions.input!.parse({ mode: 'search', query: payload });
      await expect(getFieldDefinitions.handler(input, ctx)).resolves.toBeDefined();
    },
  );

  it('format output does not leak env var names', async () => {
    const ctx = createMockContext({ errors: getFieldDefinitions.errors });
    const result = await getFieldDefinitions.handler(
      getFieldDefinitions.input!.parse({ mode: 'overview' }),
      ctx,
    );
    assertNoSecretLeak(result);
    const formatted = getFieldDefinitions.format!(result);
    assertNoSecretLeak(formatted);
  });
});

// ---------------------------------------------------------------------------
// findEligible — injection and output safety
// ---------------------------------------------------------------------------

describe('findEligible — injection and output safety', () => {
  const mockService = { countStudies: vi.fn(), searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    mockService.countStudies.mockResolvedValue(0);
  });

  const baseInput = {
    age: 30,
    sex: 'ALL' as const,
    conditions: ['Diabetes'],
    location: { country: 'United States' },
  };

  it.each(INJECTION_PAYLOADS)('condition payload %s passes without crash', async (payload) => {
    const ctx = createMockContext({ errors: findEligible.errors });
    const input = findEligible.input!.parse({
      ...baseInput,
      conditions: [payload],
    });
    await expect(findEligible.handler(input, ctx)).resolves.toBeDefined();
  });

  it('rejects empty conditions array without reaching the service', async () => {
    const ctx = createMockContext({ errors: findEligible.errors });
    await expect(
      findEligible.handler(findEligible.input!.parse({ ...baseInput, conditions: [] }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'blank_value', param: 'conditions' } });
    expect(mockService.searchStudies).not.toHaveBeenCalled();
  });

  it('rejects age below 0', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, age: -1 })).toThrow();
  });

  it('rejects age above 120', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, age: 999 })).toThrow();
  });

  it('rejects invalid sex values', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, sex: 'UNKNOWN' as never })).toThrow();
  });

  it.each([5000, Number.MAX_SAFE_INTEGER])(
    'never asks upstream for more than the per-call cap, whatever maxResults says (%d)',
    async (maxResults) => {
      mockService.searchStudies.mockResolvedValue({
        studies: Array.from({ length: 50 }, (_, i) => ({
          protocolSection: { identificationModule: { nctId: `NCT${String(i).padStart(8, '0')}` } },
        })),
        totalCount: 312,
      });
      const result = await runToolContract(findEligible, { ...baseInput, maxResults });

      expect(result.isError).toBeFalsy();
      expect(mockService.searchStudies).toHaveBeenCalledTimes(1);
      expect(mockService.searchStudies.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
      expect(result.structuredContent).toMatchObject({ truncated: true, shown: 50, cap: 50 });
    },
  );

  it('rejects a maxResults past the safe-integer range before reaching the service', async () => {
    const result = await runToolContract(findEligible, { ...baseInput, maxResults: 2 ** 53 });

    expect(result.isError).toBe(true);
    expect(mockService.searchStudies).not.toHaveBeenCalled();
  });

  it('names numbers, never an env var, in the maxResults cap disclosure', async () => {
    mockService.searchStudies.mockResolvedValue({
      studies: Array.from({ length: 50 }, (_, i) => ({
        protocolSection: { identificationModule: { nctId: `NCT${String(i).padStart(8, '0')}` } },
      })),
      totalCount: 312,
    });
    const result = await runToolContract(findEligible, { ...baseInput, maxResults: 1000 });
    expect(result.structuredContent).toMatchObject({ truncated: true, cap: 50 });
    // The disclosure exists and states the cap as a number, so the leak check below has text to scan.
    expect((result.structuredContent as { notice?: string }).notice).toContain(
      'per-call cap of 50',
    );
    assertNoSecretLeak(result);
  });

  it('location city injection payload does not crash handler', async () => {
    const ctx = createMockContext({ errors: findEligible.errors });
    const input = findEligible.input!.parse({
      ...baseInput,
      location: { country: 'United States', city: "'; DROP TABLE --" },
    });
    await expect(findEligible.handler(input, ctx)).resolves.toBeDefined();
  });

  // state and country are bound as quoted AREA[…] literals inside
  // SEARCH[Location](…) (#164): no payload may close its phrase, the state arm,
  // or the wrapper and regroup the query around the rest of it.
  it.each([
    ...INJECTION_PAYLOADS,
    'a)OR(b',
    ') OR AREA[OverallStatus]COMPLETED OR (',
    'MISSING',
    'x\\',
    '") OR ("',
  ])(
    'location state and country payload %j stays one literal inside the wrapper',
    async (payload) => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await findEligible.handler(
        findEligible.input!.parse({
          ...baseInput,
          location: { city: 'London', state: payload, country: payload },
        }),
        ctx,
      );
      const { queryLocn } = mockService.searchStudies.mock.calls[0]![0] as { queryLocn: string };
      // Quoted phrases emptied, reading `\` as an escape the way upstream does.
      expect(queryLocn.replace(/"(?:[^"\\]|\\.)*"/g, '""')).toBe(
        'SEARCH[Location](London AND (AREA[LocationState]"" OR AREA[LocationState]MISSING) AND AREA[LocationCountry]"")',
      );
    },
  );

  it('output does not contain env var names', async () => {
    const ctx = createMockContext({ errors: findEligible.errors });
    const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
    assertNoSecretLeak(result);
  });

  it('format output does not contain env var names', () => {
    const formatted = findEligible.format!({ studies: [], totalCount: 0 });
    assertNoSecretLeak(formatted);
  });

  /**
   * Every registry string a candidate writes into a single-line slot — its
   * headline, meta, interventions, demographics, sites, contacts, the Sites
   * bound line, and the field dump — is flattened, so a line break in it cannot
   * end the line and start a forged heading or candidate. The summary, a prose
   * field under its own label, keeps its breaks (#180).
   */
  it.each(['\r\n', '\n', '\r'])(
    'keeps a %j in any single-line slot from starting a new content[] line (#180)',
    async (lineBreak) => {
      const values = lineBreakValues(lineBreak);
      const { br, prose } = values;
      // The matched site: its country still carries the requested one's words.
      const matchedSite = {
        facility: br('facility'),
        city: br('city'),
        state: br('state'),
        country: br('country', `country start United States${lineBreak}## Forged country`),
        status: br('siteStatus'),
      };
      const study = {
        protocolSection: {
          identificationModule: { nctId: br('nctId'), briefTitle: br('briefTitle') },
          statusModule: { overallStatus: br('overallStatus') },
          designModule: { phases: [br('phase')], enrollmentInfo: { count: 10 } },
          sponsorCollaboratorsModule: { leadSponsor: { name: br('leadSponsor') } },
          conditionsModule: { conditions: [br('condition')] },
          armsInterventionsModule: { interventions: [{ name: br('interventionName') }] },
          descriptionModule: { briefSummary: prose('briefSummary') },
          eligibilityModule: {
            minimumAge: br('minimumAge'),
            maximumAge: br('maximumAge'),
            sex: br('sex'),
            healthyVolunteers: false,
          },
          contactsLocationsModule: {
            centralContacts: [
              { name: br('contactName'), phone: br('contactPhone'), email: br('contactEmail') },
            ],
            // The closed foreign site is bounded out, so the Sites line renders.
            locations: [matchedSite, { facility: 'Toronto site', country: 'Canada' }],
          },
          // Not rendered by a dedicated line, so both reach the field dump.
          outcomesModule: {
            primaryOutcomes: [
              { measure: br('dumpMeasure'), description: prose('dumpDescription') },
            ],
          },
        },
      };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });
      mockService.countStudies.mockResolvedValue(1);

      const ctx = createMockContext({ errors: findEligible.errors });
      const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
      const text = (findEligible.format!(result)[0] as { text: string }).text;

      expect(text).toContain('Sites: showing 1 of 2 registered');
      expect(lineBreakFindings(text, values, lineBreak)).toEqual(NO_LINE_BREAK_FINDINGS);
      // structuredContent keeps every upstream value verbatim.
      expect(result.studies[0]).toMatchObject({
        protocolSection: {
          identificationModule: study.protocolSection.identificationModule,
          descriptionModule: study.protocolSection.descriptionModule,
          contactsLocationsModule: { locations: [matchedSite] },
        },
      });
    },
  );

  // Quote-only forms are blank too: the query builder strips `"` (#145). So are
  // zero-width forms: U+200B survives String.trim() but carries no content.
  it.each(['', '   ', '""', '" "', '​', '"​"'])(
    'rejects a blank condition entry (%j) rather than matching every trial',
    async (condition) => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expect(
        findEligible.handler(
          findEligible.input!.parse({ ...baseInput, conditions: [condition] }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', '""', '" "', '​'])(
    'rejects a blank location.country (%j)',
    async (country) => {
      const ctx = createMockContext({ errors: findEligible.errors });
      await expect(
        findEligible.handler(
          findEligible.input!.parse({ ...baseInput, location: { country } }),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'blank_value' } });
      expect(mockService.searchStudies).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Cross-cutting: format() output never leaks env vars
// ---------------------------------------------------------------------------

describe('format() outputs — no environment variable leaks', () => {
  it('searchStudies.format never leaks env var names', () => {
    const output = searchStudies.format!({ studies: [] });
    assertNoSecretLeak(output);
  });

  it('getStudyCount.format never leaks env var names', () => {
    const output = getStudyCount.format!({ totalCount: 0 });
    assertNoSecretLeak(output);
  });

  it('getStudyResults.format never leaks env var names', () => {
    const output = getStudyResults.format!({ results: [] });
    assertNoSecretLeak(output);
  });

  it('getFieldValues.format never leaks env var names', () => {
    const output = getFieldValues.format!({ fieldStats: [] });
    assertNoSecretLeak(output);
  });

  it('getFieldDefinitions.format never leaks env var names', () => {
    const output = getFieldDefinitions.format!({ fields: [], totalFields: 0 });
    assertNoSecretLeak(output);
  });

  it('findEligible.format never leaks env var names', () => {
    const output = findEligible.format!({ studies: [], totalCount: 0 });
    assertNoSecretLeak(output);
  });
});
