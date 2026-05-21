/**
 * @fileoverview Tests for clinicaltrials_get_study_record tool.
 * @module tests/mcp-server/tools/definitions/get-study.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';

describe('getStudy', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('accepts valid NCT ID', () => {
      expect(() => getStudy.input!.parse({ nctId: 'NCT12345678' })).not.toThrow();
    });

    it('rejects invalid NCT ID format', () => {
      expect(() => getStudy.input!.parse({ nctId: 'INVALID' })).toThrow();
      expect(() => getStudy.input!.parse({ nctId: 'NCT1234' })).toThrow();
      expect(() => getStudy.input!.parse({ nctId: 'nct12345678' })).toThrow();
    });

    it('rejects missing nctId', () => {
      expect(() => getStudy.input!.parse({})).toThrow();
    });
  });

  describe('handler', () => {
    it('returns study for valid nctId', async () => {
      const study = {
        protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
      };
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const result = await getStudy.handler(getStudy.input!.parse({ nctId: 'NCT12345678' }), ctx);

      expect(result.study).toStrictEqual(study);
      expect(mockService.getStudy).toHaveBeenCalledWith('NCT12345678', ctx);
    });

    it('propagates service errors', async () => {
      mockService.getStudy.mockRejectedValue(new Error('Not found'));
      const ctx = createMockContext();
      await expect(
        getStudy.handler(getStudy.input!.parse({ nctId: 'NCT12345678' }), ctx),
      ).rejects.toThrow('Not found');
    });
  });

  describe('filter parity — structuredContent and format() carry the same data (#46)', () => {
    const buildStudy = (overrides: Record<string, unknown> = {}) => ({
      protocolSection: {
        identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
        ...overrides,
      },
    });

    const getStructuredLocations = (result: { study: Record<string, unknown> }) => {
      const ps = (
        result.study as {
          protocolSection?: { contactsLocationsModule?: { locations?: unknown[] } };
        }
      ).protocolSection;
      return ps?.contactsLocationsModule?.locations ?? [];
    };

    const getStructuredSecondary = (result: { study: Record<string, unknown> }) => {
      const ps = (
        result.study as { protocolSection?: { outcomesModule?: { secondaryOutcomes?: unknown[] } } }
      ).protocolSection;
      return ps?.outcomesModule?.secondaryOutcomes ?? [];
    };

    it('locationLimit caps locations in both surfaces and records the upstream total', async () => {
      const locations = Array.from({ length: 30 }, (_, i) => ({
        facility: `Hospital ${i}`,
        country: 'US',
      }));
      mockService.getStudy.mockResolvedValue(
        buildStudy({ contactsLocationsModule: { locations } }),
      );

      const ctx = createMockContext();
      const result = await getStudy.handler(
        getStudy.input!.parse({ nctId: 'NCT12345678', locationLimit: 5 }),
        ctx,
      );

      expect(getStructuredLocations(result)).toHaveLength(5);
      expect(result.filtersApplied.totalLocations).toBe(30);
      expect(result.filtersApplied.locationLimit).toBe(5);

      const text = (getStudy.format!(result)[0] as { text: string }).text;
      expect(text).toContain('## Locations (5 of 30 total)');
      for (let i = 0; i < 5; i++) expect(text).toContain(`Hospital ${i}`);
      expect(text).not.toContain('Hospital 5,');
      expect(text).not.toContain('Hospital 29');
    });

    it('locationLimit omitted (default) leaves the full list intact in both surfaces', async () => {
      const locations = Array.from({ length: 30 }, (_, i) => ({
        facility: `Hospital ${i}`,
        country: 'US',
      }));
      mockService.getStudy.mockResolvedValue(
        buildStudy({ contactsLocationsModule: { locations } }),
      );

      const ctx = createMockContext();
      const result = await getStudy.handler(getStudy.input!.parse({ nctId: 'NCT12345678' }), ctx);

      expect(getStructuredLocations(result)).toHaveLength(30);

      const text = (getStudy.format!(result)[0] as { text: string }).text;
      expect(text).toContain('## Locations (30 total)');
      for (let i = 0; i < 30; i++) expect(text).toContain(`Hospital ${i}`);
    });

    it('outcomeLimit caps secondary and other outcomes in both surfaces', async () => {
      const secondaryOutcomes = Array.from({ length: 20 }, (_, i) => ({
        measure: `Secondary ${i}`,
      }));
      const otherOutcomes = Array.from({ length: 8 }, (_, i) => ({
        measure: `Other ${i}`,
      }));
      mockService.getStudy.mockResolvedValue(
        buildStudy({ outcomesModule: { secondaryOutcomes, otherOutcomes } }),
      );

      const ctx = createMockContext();
      const result = await getStudy.handler(
        getStudy.input!.parse({ nctId: 'NCT12345678', outcomeLimit: 3 }),
        ctx,
      );

      expect(getStructuredSecondary(result)).toHaveLength(3);
      expect(result.filtersApplied.totalSecondaryOutcomes).toBe(20);
      expect(result.filtersApplied.totalOtherOutcomes).toBe(8);

      const text = (getStudy.format!(result)[0] as { text: string }).text;
      expect(text).toContain('## Secondary Outcomes (3 of 20)');
      expect(text).toContain('## Other Outcomes (3 of 8)');
      expect(text).toContain('Secondary 2');
      expect(text).not.toContain('Secondary 3');
    });

    it('nearLocation filters by radius, sorts by distance, and annotates distanceMi in both surfaces', async () => {
      mockService.getStudy.mockResolvedValue(
        buildStudy({
          contactsLocationsModule: {
            locations: [
              {
                facility: 'Boston General',
                country: 'US',
                geoPoint: { lat: 42.3601, lon: -71.0589 },
              },
              {
                facility: 'Portland Clinic',
                country: 'US',
                geoPoint: { lat: 45.5152, lon: -122.6784 },
              },
              {
                facility: 'Seattle Med',
                country: 'US',
                geoPoint: { lat: 47.6062, lon: -122.3321 },
              },
            ],
          },
        }),
      );

      const ctx = createMockContext();
      const result = await getStudy.handler(
        getStudy.input!.parse({
          nctId: 'NCT12345678',
          nearLocation: { lat: 47.6062, lon: -122.3321, radiusMi: 250 },
        }),
        ctx,
      );

      const locs = getStructuredLocations(result) as Array<{
        facility: string;
        distanceMi?: number;
      }>;
      expect(locs.map((l) => l.facility)).toEqual(['Seattle Med', 'Portland Clinic']);
      expect(locs[0]?.distanceMi).toBeCloseTo(0, 0);
      expect(locs[1]?.distanceMi).toBeGreaterThan(100);
      expect(result.filtersApplied.totalLocations).toBe(3);

      const text = (getStudy.format!(result)[0] as { text: string }).text;
      expect(text).toContain('within 250 mi');
      expect(text).toContain('of 3 total');
      expect(text).toContain('Seattle Med');
      expect(text).toContain('Portland Clinic');
      expect(text).not.toContain('Boston General');
      expect(text.indexOf('Seattle Med')).toBeLessThan(text.indexOf('Portland Clinic'));
      expect(text).toMatch(/Seattle Med.*\(0\.0 mi\)/);
    });

    it('nearLocation drops locations without coordinates and records the count', async () => {
      mockService.getStudy.mockResolvedValue(
        buildStudy({
          contactsLocationsModule: {
            locations: [
              { facility: 'Has Coords', geoPoint: { lat: 47.6062, lon: -122.3321 } },
              { facility: 'No Coords' },
              { facility: 'Also No Coords' },
            ],
          },
        }),
      );

      const ctx = createMockContext();
      const result = await getStudy.handler(
        getStudy.input!.parse({
          nctId: 'NCT12345678',
          nearLocation: { lat: 47.6062, lon: -122.3321, radiusMi: 50 },
        }),
        ctx,
      );

      expect(getStructuredLocations(result)).toHaveLength(1);
      expect(result.filtersApplied.locationsWithoutGeo).toBe(2);

      const text = (getStudy.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Has Coords');
      expect(text).toContain('2 without coordinates skipped');
      expect(text).not.toContain('No Coords,');
    });

    it('nearLocation combined with locationLimit applies both in both surfaces', async () => {
      const here = { lat: 47.6062, lon: -122.3321 };
      mockService.getStudy.mockResolvedValue(
        buildStudy({
          contactsLocationsModule: {
            locations: Array.from({ length: 6 }, (_, i) => ({
              facility: `Site ${i}`,
              geoPoint: { lat: here.lat + i * 0.01, lon: here.lon },
            })),
          },
        }),
      );

      const ctx = createMockContext();
      const result = await getStudy.handler(
        getStudy.input!.parse({
          nctId: 'NCT12345678',
          nearLocation: { ...here, radiusMi: 100 },
          locationLimit: 3,
        }),
        ctx,
      );

      const locs = getStructuredLocations(result) as Array<{ facility: string }>;
      expect(locs).toHaveLength(3);
      expect(locs.map((l) => l.facility)).toEqual(['Site 0', 'Site 1', 'Site 2']);

      const text = (getStudy.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Site 0');
      expect(text).toContain('Site 2');
      expect(text).not.toContain('Site 3');
    });
  });

  describe('format', () => {
    it('renders study header with NCT ID and title', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'My Study' },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain('# Study NCT12345678: My Study');
    });

    it('falls back to officialTitle when briefTitle missing', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', officialTitle: 'Official Title' },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain('# Study NCT12345678: Official Title');
    });

    it('shows Untitled when no title', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: { identificationModule: { nctId: 'NCT12345678' } },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain('# Study NCT12345678: Untitled');
    });

    it('shows Unknown when no nctId', () => {
      const blocks = getStudy.format!({ study: {} });
      expect((blocks[0] as { text: string }).text).toContain('# Study Unknown: Untitled');
    });

    it('renders acronym', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X', acronym: 'ACME' },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain('**Acronym:** ACME');
    });

    it('renders status with design info', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            statusModule: { overallStatus: 'RECRUITING' },
            designModule: {
              studyType: 'INTERVENTIONAL',
              phases: ['PHASE3'],
              enrollmentInfo: { count: 500 },
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('RECRUITING');
      expect(text).toContain('INTERVENTIONAL');
      expect(text).toContain('PHASE3');
      expect(text).toContain('N=500');
    });

    it('renders dates', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            statusModule: {
              startDateStruct: { date: '2024-01-01' },
              primaryCompletionDateStruct: { date: '2025-06-01' },
              completionDateStruct: { date: '2025-12-31' },
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Start: 2024-01-01');
      expect(text).toContain('Primary Completion: 2025-06-01');
      expect(text).toContain('Completion: 2025-12-31');
    });

    it('renders sponsor with class', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            sponsorCollaboratorsModule: {
              leadSponsor: { name: 'Pfizer', class: 'INDUSTRY' },
            },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain('**Sponsor:** Pfizer (INDUSTRY)');
    });

    it('renders conditions', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            conditionsModule: { conditions: ['Diabetes', 'Hypertension'] },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain(
        '**Conditions:** Diabetes, Hypertension',
      );
    });

    it('renders summary', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            descriptionModule: { briefSummary: 'This study evaluates...' },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain('## Summary');
      expect((blocks[0] as { text: string }).text).toContain('This study evaluates...');
    });

    it('renders eligibility section', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            eligibilityModule: {
              minimumAge: '18 Years',
              maximumAge: '65 Years',
              sex: 'ALL',
              healthyVolunteers: false,
              stdAges: ['ADULT', 'OLDER_ADULT'],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Eligibility');
      expect(text).toContain('18 Years');
      expect(text).toContain('65 Years');
      expect(text).toContain('**Sex:** ALL');
      expect(text).toContain('**Healthy Volunteers:** No');
      expect(text).toContain('ADULT, OLDER_ADULT');
    });

    it('renders eligibility with only minAge', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            eligibilityModule: { minimumAge: '18 Years' },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toMatch(/≥ 18 Years/);
    });

    it('renders eligibility with only maxAge', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            eligibilityModule: { maximumAge: '65 Years' },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toMatch(/≤ 65 Years/);
    });

    it('renders interventions', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            armsInterventionsModule: {
              interventions: [
                { type: 'DRUG', name: 'Aspirin', description: 'Low dose aspirin' },
                { name: 'Placebo' },
              ],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Interventions');
      expect(text).toContain('**DRUG:** Aspirin');
      expect(text).toContain('Low dose aspirin');
      expect(text).toContain('**Intervention:** Placebo');
    });

    it('renders arm groups', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            armsInterventionsModule: {
              armGroups: [
                { label: 'Treatment', type: 'EXPERIMENTAL', description: 'Active drug' },
                { label: 'Control', type: 'PLACEBO_COMPARATOR' },
              ],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Arms');
      expect(text).toContain('**Treatment** (EXPERIMENTAL)');
      expect(text).toContain('Active drug');
    });

    it('renders primary and secondary outcomes', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            outcomesModule: {
              primaryOutcomes: [{ measure: 'Overall Survival', timeFrame: '24 months' }],
              secondaryOutcomes: [{ measure: 'PFS', timeFrame: '12 months' }, { measure: 'ORR' }],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Primary Outcomes');
      expect(text).toContain('Overall Survival [24 months]');
      expect(text).toContain('## Secondary Outcomes');
      expect(text).toContain('PFS [12 months]');
      expect(text).toContain('ORR');
    });

    it('renders every secondary outcome without truncation (regression for #46)', () => {
      const secondaryOutcomes = Array.from({ length: 8 }, (_, i) => ({
        measure: `Outcome ${i}`,
      }));
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            outcomesModule: { secondaryOutcomes },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('... and');
      for (let i = 0; i < 8; i++) expect(text).toContain(`Outcome ${i}`);
    });

    it('renders central contacts', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            contactsLocationsModule: {
              centralContacts: [
                { name: 'Dr. Smith', role: 'PI', phone: '555-1234', email: 'smith@test.com' },
              ],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Contacts');
      expect(text).toContain('Dr. Smith');
      expect(text).toContain('smith@test.com');
    });

    it('renders locations with recruiting priority', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            contactsLocationsModule: {
              locations: [
                {
                  facility: 'General Hospital',
                  city: 'Seattle',
                  state: 'WA',
                  country: 'United States',
                  status: 'RECRUITING',
                },
                {
                  facility: 'Other Hospital',
                  city: 'Portland',
                  state: 'OR',
                  country: 'United States',
                  status: 'NOT_YET_RECRUITING',
                },
              ],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Locations (2 total)');
      expect(text).toContain('General Hospital');
      expect(text).toContain('[RECRUITING]');
    });

    it('renders detailedDescription section (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            descriptionModule: {
              briefSummary: 'Short summary.',
              detailedDescription: 'Detailed multi-paragraph description goes here.',
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Detailed Description');
      expect(text).toContain('Detailed multi-paragraph description');
    });

    it('renders submission and update dates (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            statusModule: {
              studyFirstSubmitDate: '2020-01-15',
              studyFirstPostDateStruct: { date: '2020-02-01' },
              lastUpdateSubmitDate: '2024-06-10',
              lastUpdatePostDateStruct: { date: '2024-06-15' },
              statusVerifiedDate: '2024-06',
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('First Submit: 2020-01-15');
      expect(text).toContain('Last Update Post: 2024-06-15');
      expect(text).toContain('Verified: 2024-06');
    });

    it('renders otherOutcomes (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            outcomesModule: {
              otherOutcomes: [{ measure: 'Exploratory Biomarker', timeFrame: '6 months' }],
            },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain('## Other Outcomes');
      expect((blocks[0] as { text: string }).text).toContain('Exploratory Biomarker [6 months]');
    });

    it('renders oversight module (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            oversightModule: {
              oversightHasDmc: true,
              isFdaRegulatedDrug: true,
              isFdaRegulatedDevice: false,
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**Oversight:**');
      expect(text).toContain('DMC: Yes');
      expect(text).toContain('FDA-Regulated Drug: Yes');
      expect(text).toContain('FDA-Regulated Device: No');
    });

    it('renders ipdSharingStatementModule (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            ipdSharingStatementModule: {
              ipdSharing: 'YES',
              timeFrame: '6 months after publication',
              description: 'Individual participant data available upon request.',
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## IPD Sharing');
      expect(text).toContain('**Plan:** YES');
      expect(text).toContain('6 months after publication');
    });

    it('renders referencesModule (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            referencesModule: {
              references: [
                {
                  pmid: '12345',
                  citation: 'Smith J. Relevant prior work. 2020.',
                  type: 'BACKGROUND',
                },
              ],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## References');
      expect(text).toContain('Smith J. Relevant prior work');
      expect(text).toContain('PMID: 12345');
      expect(text).toContain('[BACKGROUND]');
    });

    it('renders collaborators (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            sponsorCollaboratorsModule: {
              leadSponsor: { name: 'Pfizer', class: 'INDUSTRY' },
              collaborators: [
                { name: 'NIH', class: 'FEDERAL' },
                { name: 'Academic Partner', class: 'OTHER' },
              ],
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**Collaborators:** NIH (FEDERAL), Academic Partner (OTHER)');
    });

    it('renders keywords (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            conditionsModule: {
              conditions: ['Diabetes'],
              keywords: ['insulin resistance', 'glycemic control'],
            },
          },
        },
      });
      expect((blocks[0] as { text: string }).text).toContain(
        '**Keywords:** insulin resistance, glycemic control',
      );
    });

    it('renders design details (regression for #18)', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            designModule: {
              designInfo: {
                allocation: 'RANDOMIZED',
                interventionModel: 'PARALLEL',
                primaryPurpose: 'TREATMENT',
                maskingInfo: { masking: 'DOUBLE' },
              },
            },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**Design:**');
      expect(text).toContain('Allocation: RANDOMIZED');
      expect(text).toContain('Model: PARALLEL');
      expect(text).toContain('Purpose: TREATMENT');
      expect(text).toContain('Masking: DOUBLE');
    });

    it('renders every location without truncation (regression for #46)', () => {
      const locations = Array.from({ length: 30 }, (_, i) => ({
        facility: `Hospital ${i}`,
        country: 'US',
      }));
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            contactsLocationsModule: { locations },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('## Locations (30 total)');
      expect(text).not.toContain('... and');
      for (let i = 0; i < 30; i++) expect(text).toContain(`Hospital ${i}`);
    });

    it('renders every reference without truncation (regression for #46)', () => {
      const references = Array.from({ length: 15 }, (_, i) => ({
        pmid: `${10000 + i}`,
        citation: `Citation ${i}.`,
      }));
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X' },
            referencesModule: { references },
          },
        },
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('... and');
      for (let i = 0; i < 15; i++) expect(text).toContain(`Citation ${i}.`);
    });
  });
});
