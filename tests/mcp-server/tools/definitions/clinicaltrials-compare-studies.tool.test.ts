/**
 * @fileoverview Tests for the clinicaltrials_compare_studies tool definition.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-compare-studies.tool.test
 */
import { container } from 'tsyringe';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ClinicalTrialsProvider } from '../../../../src/container/tokens.js';
import { compareStudiesTool } from '../../../../src/mcp-server/tools/definitions/clinicaltrials-compare-studies.tool.js';
import type { IClinicalTrialsProvider } from '../../../../src/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { Study } from '../../../../src/services/clinical-trials-gov/types.js';
import {
  JsonRpcErrorCode,
  McpError,
} from '../../../../src/types-global/errors.js';
import { requestContextService } from '../../../../src/utils/index.js';

describe('compareStudiesTool', () => {
  let mockProvider: IClinicalTrialsProvider;

  beforeEach(() => {
    mockProvider = {
      fetchStudy: vi.fn(),
      listStudies: vi.fn(),
      getStudyMetadata: vi.fn(),
      getApiStats: vi.fn(),
    } as unknown as IClinicalTrialsProvider;

    container.clearInstances();
    container.registerInstance(ClinicalTrialsProvider, mockProvider);
  });

  it('should have the correct name, title, and description', () => {
    expect(compareStudiesTool.name).toBe('clinicaltrials_compare_studies');
    expect(compareStudiesTool.title).toBe('Compare Clinical Studies');
    expect(compareStudiesTool.description).toContain('side-by-side comparison');
  });

  it('should have correct annotations', () => {
    expect(compareStudiesTool.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('should compare two studies successfully', async () => {
    const mockStudy1: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT11111111',
          officialTitle: 'Study One',
        },
        statusModule: {
          overallStatus: 'Recruiting',
        },
        designModule: {
          studyType: 'Interventional',
          phases: ['Phase 2'],
        },
      },
    };

    const mockStudy2: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT22222222',
          officialTitle: 'Study Two',
        },
        statusModule: {
          overallStatus: 'Completed',
        },
        designModule: {
          studyType: 'Interventional',
          phases: ['Phase 3'],
        },
      },
    };

    (mockProvider.fetchStudy as Mock)
      .mockResolvedValueOnce(mockStudy1 as Study)
      .mockResolvedValueOnce(mockStudy2 as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222'],
      compareFields: 'all',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.comparisons).toHaveLength(2);
    expect(result.comparisons[0]!.nctId).toBe('NCT11111111');
    expect(result.comparisons[1]!.nctId).toBe('NCT22222222');
    expect(result.summary.totalStudies).toBe(2);
  });

  it('should compare specific fields only', async () => {
    const mockStudy1: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT11111111',
          officialTitle: 'Study One',
        },
        designModule: {
          studyType: 'Interventional',
          phases: ['Phase 2'],
        },
        eligibilityModule: {
          sex: 'ALL',
          minimumAge: '18 Years',
        },
      },
    };

    const mockStudy2: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT22222222',
          officialTitle: 'Study Two',
        },
        designModule: {
          studyType: 'Observational',
          phases: ['Phase 3'],
        },
        eligibilityModule: {
          sex: 'FEMALE',
          minimumAge: '21 Years',
        },
      },
    };

    (mockProvider.fetchStudy as Mock)
      .mockResolvedValueOnce(mockStudy1 as Study)
      .mockResolvedValueOnce(mockStudy2 as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222'],
      compareFields: ['design', 'eligibility'],
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.comparisons[0]!.design).toBeDefined();
    expect(result.comparisons[0]!.eligibility).toBeDefined();
    expect(result.comparisons[0]!.interventions).toBeUndefined();
    expect(result.comparisons[0]!.sponsors).toBeUndefined();
  });

  it('should extract eligibility information', async () => {
    const mockStudy: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT11111111',
          officialTitle: 'Test Study',
        },
        eligibilityModule: {
          sex: 'ALL',
          minimumAge: '18 Years',
          healthyVolunteers: true,
          stdAges: ['ADULT', 'OLDER_ADULT'],
          eligibilityCriteria: 'Must be over 18 and healthy',
        },
      },
    };

    (mockProvider.fetchStudy as Mock).mockResolvedValue(mockStudy as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT11111111'],
      compareFields: 'eligibility',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    const comparison = result.comparisons[0]!;
    expect(comparison.eligibility?.sex).toBe('ALL');
    expect(comparison.eligibility?.minimumAge).toBe('18 Years');
    expect(comparison.eligibility?.healthyVolunteers).toBe(true);
    expect(comparison.eligibility?.stdAges).toEqual(['ADULT', 'OLDER_ADULT']);
    expect(comparison.eligibility?.criteria).toContain('Must be over 18');
  });

  it('should extract intervention information', async () => {
    const mockStudy: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT11111111',
          officialTitle: 'Test Study',
        },
        armsInterventionsModule: {
          interventions: [
            {
              type: 'Drug',
              name: 'Aspirin',
              description: 'Daily aspirin treatment',
            },
            {
              type: 'Behavioral',
              name: 'Exercise',
              description: 'Daily exercise routine',
            },
          ],
        },
      },
    };

    (mockProvider.fetchStudy as Mock).mockResolvedValue(mockStudy as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT11111111'],
      compareFields: 'interventions',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    const interventions = result.comparisons[0]!.interventions;
    expect(interventions).toHaveLength(2);
    expect(interventions![0]!.type).toBe('Drug');
    expect(interventions![0]!.name).toBe('Aspirin');
    expect(interventions![1]!.type).toBe('Behavioral');
  });

  it('should extract sponsor information', async () => {
    const mockStudy: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT11111111',
          officialTitle: 'Test Study',
        },
        sponsorCollaboratorsModule: {
          leadSponsor: {
            name: 'Big Pharma Inc',
            class: 'INDUSTRY',
          },
          collaborators: [{ name: 'University Hospital', class: 'OTHER' }],
        },
      },
    };

    (mockProvider.fetchStudy as Mock).mockResolvedValue(mockStudy as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT11111111'],
      compareFields: 'sponsors',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    const sponsors = result.comparisons[0]!.sponsors;
    expect(sponsors?.leadSponsor?.name).toBe('Big Pharma Inc');
    expect(sponsors?.leadSponsor?.class).toBe('INDUSTRY');
    expect(sponsors?.collaborators).toHaveLength(1);
    expect(sponsors?.collaborators![0]!.name).toBe('University Hospital');
  });

  it('should extract location summaries', async () => {
    const mockStudy: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT11111111',
          officialTitle: 'Test Study',
        },
        contactsLocationsModule: {
          locations: [
            { country: 'United States', city: 'New York' },
            { country: 'United States', city: 'New York' },
            { country: 'United States', city: 'Boston' },
            { country: 'Canada', city: 'Toronto' },
          ],
        },
      },
    };

    (mockProvider.fetchStudy as Mock).mockResolvedValue(mockStudy as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT11111111'],
      compareFields: 'locations',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    const locations = result.comparisons[0]!.locations;
    expect(locations?.totalCount).toBe(4);
    expect(locations?.countries).toContain('United States');
    expect(locations?.countries).toContain('Canada');
    expect(locations?.topCities).toContain('New York');
  });

  it('should detect commonalities across studies', async () => {
    const mockStudy1: Partial<Study> = {
      protocolSection: {
        identificationModule: { nctId: 'NCT11111111' },
        statusModule: { overallStatus: 'Recruiting' },
        designModule: { phases: ['Phase 2'] },
        sponsorCollaboratorsModule: {
          leadSponsor: { name: 'Sponsor A' },
        },
      },
    };

    const mockStudy2: Partial<Study> = {
      protocolSection: {
        identificationModule: { nctId: 'NCT22222222' },
        statusModule: { overallStatus: 'Recruiting' },
        designModule: { phases: ['Phase 2'] },
        sponsorCollaboratorsModule: {
          leadSponsor: { name: 'Sponsor A' },
        },
      },
    };

    (mockProvider.fetchStudy as Mock)
      .mockResolvedValueOnce(mockStudy1 as Study)
      .mockResolvedValueOnce(mockStudy2 as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222'],
      compareFields: 'all',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.summary.commonalities).toBeDefined();
    expect(
      result.summary.commonalities?.some((c) => c.includes('Phase 2')),
    ).toBe(true);
    expect(
      result.summary.commonalities?.some((c) => c.includes('Recruiting')),
    ).toBe(true);
  });

  it('should detect differences across studies', async () => {
    const mockStudy1: Partial<Study> = {
      protocolSection: {
        identificationModule: { nctId: 'NCT11111111' },
        statusModule: { overallStatus: 'Recruiting' },
        designModule: { phases: ['Phase 2'] },
      },
    };

    const mockStudy2: Partial<Study> = {
      protocolSection: {
        identificationModule: { nctId: 'NCT22222222' },
        statusModule: { overallStatus: 'Completed' },
        designModule: { phases: ['Phase 3'] },
      },
    };

    (mockProvider.fetchStudy as Mock)
      .mockResolvedValueOnce(mockStudy1 as Study)
      .mockResolvedValueOnce(mockStudy2 as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222'],
      compareFields: 'all',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.summary.differences).toBeDefined();
    expect(result.summary.differences?.some((d) => d.includes('phases'))).toBe(
      true,
    );
    expect(
      result.summary.differences?.some((d) => d.includes('statuses')),
    ).toBe(true);
  });

  it('should throw when less than 2 studies can be fetched', async () => {
    (mockProvider.fetchStudy as Mock)
      .mockResolvedValueOnce({
        protocolSection: { identificationModule: { nctId: 'NCT11111111' } },
      } as Study)
      .mockRejectedValueOnce(new McpError(-32602, 'Not found'));

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222'],
      compareFields: 'all',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await expect(
      compareStudiesTool.logic(parsedInput, context, sdkContext),
    ).rejects.toThrow('Insufficient studies for comparison');
  });

  it('should handle partial failures with errors array', async () => {
    const mockStudy1: Partial<Study> = {
      protocolSection: {
        identificationModule: { nctId: 'NCT11111111' },
      },
    };

    const mockStudy2: Partial<Study> = {
      protocolSection: {
        identificationModule: { nctId: 'NCT22222222' },
      },
    };

    (mockProvider.fetchStudy as Mock)
      .mockResolvedValueOnce(mockStudy1 as Study)
      .mockResolvedValueOnce(mockStudy2 as Study)
      .mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.NotFound, 'Not found'),
      );

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222', 'NCT99999999'],
      compareFields: 'all',
    };
    const parsedInput = compareStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await compareStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.comparisons).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]!.nctId).toBe('NCT99999999');
  });

  it('should validate NCT ID format', () => {
    expect(() =>
      compareStudiesTool.inputSchema.parse({
        nctIds: ['INVALID123', 'NCT12345678'],
      }),
    ).toThrow();

    expect(() =>
      compareStudiesTool.inputSchema.parse({
        nctIds: ['NCT12345678', 'NCT87654321'],
      }),
    ).not.toThrow();
  });

  it('should require at least 2 NCT IDs', () => {
    expect(() =>
      compareStudiesTool.inputSchema.parse({ nctIds: ['NCT12345678'] }),
    ).toThrow();
  });

  it('should enforce maximum of 5 NCT IDs', () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => `NCT1234567${i}`);

    expect(() =>
      compareStudiesTool.inputSchema.parse({ nctIds: tooMany }),
    ).toThrow();
  });

  it('should format response with markdown', () => {
    const mockOutput = {
      comparisons: [
        {
          nctId: 'NCT11111111',
          title: 'Study One',
          status: { overallStatus: 'Recruiting' },
        },
        {
          nctId: 'NCT22222222',
          title: 'Study Two',
          status: { overallStatus: 'Completed' },
        },
      ],
      summary: {
        totalStudies: 2,
        comparedFields: ['all'],
        differences: ['Different statuses: Recruiting, Completed'],
      },
    };

    const formatted = compareStudiesTool.responseFormatter!(mockOutput as any);

    expect(formatted).toHaveLength(1);
    expect(formatted[0]!.type).toBe('text');
    const text = (formatted[0]! as any).text;
    expect(text).toContain('# Comparison of 2 Clinical Trials');
    expect(text).toContain('NCT11111111');
    expect(text).toContain('Study One');
    expect(text).toContain('Key Differences');
  });
});
