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
      expect(() => getStudy.input.parse({ nctId: 'NCT12345678' })).not.toThrow();
    });

    it('rejects invalid NCT ID format', () => {
      expect(() => getStudy.input.parse({ nctId: 'INVALID' })).toThrow();
      expect(() => getStudy.input.parse({ nctId: 'NCT1234' })).toThrow();
      expect(() => getStudy.input.parse({ nctId: 'nct12345678' })).toThrow();
    });

    it('rejects missing nctId', () => {
      expect(() => getStudy.input.parse({})).toThrow();
    });
  });

  describe('handler', () => {
    it('returns study for valid nctId', async () => {
      const study = {
        protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
      };
      mockService.getStudy.mockResolvedValue(study);

      const ctx = createMockContext();
      const result = await getStudy.handler(getStudy.input.parse({ nctId: 'NCT12345678' }), ctx);

      expect(result.study).toBe(study);
      expect(mockService.getStudy).toHaveBeenCalledWith('NCT12345678', ctx);
    });

    it('propagates service errors', async () => {
      mockService.getStudy.mockRejectedValue(new Error('Not found'));
      const ctx = createMockContext();
      await expect(
        getStudy.handler(getStudy.input.parse({ nctId: 'NCT12345678' }), ctx),
      ).rejects.toThrow('Not found');
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
      expect(blocks[0].text).toContain('# NCT12345678: My Study');
    });

    it('falls back to officialTitle when briefTitle missing', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', officialTitle: 'Official Title' },
          },
        },
      });
      expect(blocks[0].text).toContain('# NCT12345678: Official Title');
    });

    it('shows Untitled when no title', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: { identificationModule: { nctId: 'NCT12345678' } },
        },
      });
      expect(blocks[0].text).toContain('# NCT12345678: Untitled');
    });

    it('shows Unknown when no nctId', () => {
      const blocks = getStudy.format!({ study: {} });
      expect(blocks[0].text).toContain('# Unknown: Untitled');
    });

    it('renders acronym', () => {
      const blocks = getStudy.format!({
        study: {
          protocolSection: {
            identificationModule: { nctId: 'NCT12345678', briefTitle: 'X', acronym: 'ACME' },
          },
        },
      });
      expect(blocks[0].text).toContain('**Acronym:** ACME');
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
      const text = blocks[0].text;
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
      const text = blocks[0].text;
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
      expect(blocks[0].text).toContain('**Sponsor:** Pfizer (INDUSTRY)');
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
      expect(blocks[0].text).toContain('**Conditions:** Diabetes, Hypertension');
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
      expect(blocks[0].text).toContain('## Summary');
      expect(blocks[0].text).toContain('This study evaluates...');
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
      const text = blocks[0].text;
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
      expect(blocks[0].text).toMatch(/≥ 18 Years/);
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
      expect(blocks[0].text).toMatch(/≤ 65 Years/);
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
      const text = blocks[0].text;
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
      const text = blocks[0].text;
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
      const text = blocks[0].text;
      expect(text).toContain('## Primary Outcomes');
      expect(text).toContain('Overall Survival [24 months]');
      expect(text).toContain('## Secondary Outcomes');
      expect(text).toContain('PFS [12 months]');
      expect(text).toContain('ORR');
    });

    it('truncates secondary outcomes beyond 5', () => {
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
      expect(blocks[0].text).toContain('... and 3 more');
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
      const text = blocks[0].text;
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
      const text = blocks[0].text;
      expect(text).toContain('## Locations (2 total)');
      expect(text).toContain('General Hospital');
      expect(text).toContain('[RECRUITING]');
    });

    it('truncates locations beyond 10', () => {
      const locations = Array.from({ length: 15 }, (_, i) => ({
        facility: `Hospital ${i}`,
        city: `City ${i}`,
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
      expect(blocks[0].text).toContain('... and 5 more');
    });
  });
});
