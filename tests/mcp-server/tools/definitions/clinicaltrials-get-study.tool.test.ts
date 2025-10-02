/**
 * @fileoverview Tests for the clinicaltrials_get_study tool definition.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-get-study.tool.test
 */
import { container } from 'tsyringe';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ClinicalTrialsProvider } from '../../../../src/container/tokens.js';
import { getStudyTool } from '../../../../src/mcp-server/tools/definitions/clinicaltrials-get-study.tool.js';
import type { IClinicalTrialsProvider } from '../../../../src/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { Study } from '../../../../src/services/clinical-trials-gov/types.js';
import {
  JsonRpcErrorCode,
  McpError,
} from '../../../../src/types-global/errors.js';
import { requestContextService } from '../../../../src/utils/index.js';

describe('getStudyTool', () => {
  let mockProvider: IClinicalTrialsProvider;

  beforeEach(() => {
    // Create a mock provider
    mockProvider = {
      fetchStudy: vi.fn(),
      listStudies: vi.fn(),
      getStudyMetadata: vi.fn(),
      getApiStats: vi.fn(),
    } as unknown as IClinicalTrialsProvider;

    // Register the mock in the DI container
    container.clearInstances();
    container.registerInstance(ClinicalTrialsProvider, mockProvider);
  });

  it('should have the correct name, title, and description', () => {
    expect(getStudyTool.name).toBe('clinicaltrials_get_study');
    expect(getStudyTool.title).toBe('Get Clinical Study');
    expect(getStudyTool.description).toContain(
      'Fetches one or more clinical trial studies',
    );
  });

  it('should have correct annotations', () => {
    expect(getStudyTool.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('should fetch a single study successfully', async () => {
    const mockStudy: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT12345678',
          officialTitle: 'Test Study Title',
          briefTitle: 'Brief Test',
        },
        descriptionModule: {
          briefSummary: 'This is a test study',
        },
        statusModule: {
          overallStatus: 'Recruiting',
        },
        conditionsModule: {
          conditions: ['Cancer', 'Lung Cancer'],
        },
        armsInterventionsModule: {
          interventions: [{ name: 'Drug A', type: 'Drug' }],
        },
        sponsorCollaboratorsModule: {
          leadSponsor: {
            name: 'Test Sponsor',
            class: 'INDUSTRY',
          },
        },
      },
    };

    (mockProvider.fetchStudy as Mock).mockResolvedValue(mockStudy as Study);

    const input = { nctIds: 'NCT12345678', summaryOnly: false };
    const parsedInput = getStudyTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    // Note: The logic is wrapped with withToolAuth, so we test the unwrapped logic
    // In a real scenario, you'd need to unwrap or mock the auth layer
    const result = await getStudyTool.logic(parsedInput, context, sdkContext);

    expect(result.studies).toHaveLength(1);
    expect(result.studies[0]).toEqual(mockStudy);
    expect(result.errors).toBeUndefined();
    expect(mockProvider.fetchStudy).toHaveBeenCalledWith(
      'NCT12345678',
      context,
    );
  });

  it('should fetch multiple studies successfully', async () => {
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
      .mockResolvedValueOnce(mockStudy2 as Study);

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222'],
      summaryOnly: false,
    };
    const parsedInput = getStudyTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await getStudyTool.logic(parsedInput, context, sdkContext);

    expect(result.studies).toHaveLength(2);
    expect(result.errors).toBeUndefined();
    expect(mockProvider.fetchStudy).toHaveBeenCalledTimes(2);
  });

  it('should return summaries when summaryOnly is true', async () => {
    const mockStudy: Partial<Study> = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT12345678',
          officialTitle: 'Test Study',
        },
        descriptionModule: {
          briefSummary: 'Summary text',
        },
        statusModule: {
          overallStatus: 'Completed',
        },
        conditionsModule: {
          conditions: ['Diabetes'],
        },
        armsInterventionsModule: {
          interventions: [{ name: 'Intervention X', type: 'Behavioral' }],
        },
        sponsorCollaboratorsModule: {
          leadSponsor: { name: 'Sponsor Y' },
        },
      },
    };

    (mockProvider.fetchStudy as Mock).mockResolvedValue(mockStudy as Study);

    const input = { nctIds: 'NCT12345678', summaryOnly: true };
    const parsedInput = getStudyTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await getStudyTool.logic(parsedInput, context, sdkContext);

    expect(result.studies).toHaveLength(1);
    const summary = result.studies[0]!;
    expect(summary).toHaveProperty('nctId', 'NCT12345678');
    expect(summary).toHaveProperty('title', 'Test Study');
    expect(summary).toHaveProperty('briefSummary', 'Summary text');
    expect(summary).toHaveProperty('overallStatus', 'Completed');
    expect(summary).toHaveProperty('conditions', ['Diabetes']);
    expect(summary).toHaveProperty('leadSponsor', 'Sponsor Y');
  });

  it('should handle partial failures and return errors', async () => {
    const mockStudy: Partial<Study> = {
      protocolSection: {
        identificationModule: { nctId: 'NCT11111111' },
      },
    };

    (mockProvider.fetchStudy as Mock)
      .mockResolvedValueOnce(mockStudy as Study)
      .mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.NotFound, 'Study not found'),
      );

    const input = {
      nctIds: ['NCT11111111', 'NCT99999999'],
      summaryOnly: false,
    };
    const parsedInput = getStudyTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await getStudyTool.logic(parsedInput, context, sdkContext);

    expect(result.studies).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toEqual({
      nctId: 'NCT99999999',
      error: 'Study not found',
    });
  });

  it('should throw when all studies fail to fetch', async () => {
    (mockProvider.fetchStudy as Mock).mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'API unavailable'),
    );

    const input = {
      nctIds: ['NCT11111111', 'NCT22222222'],
      summaryOnly: false,
    };
    const parsedInput = getStudyTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await expect(
      getStudyTool.logic(parsedInput, context, sdkContext),
    ).rejects.toThrow(McpError);
  });

  it('should validate NCT ID format', () => {
    expect(() =>
      getStudyTool.inputSchema.parse({ nctIds: 'INVALID123' }),
    ).toThrow();

    expect(
      () => getStudyTool.inputSchema.parse({ nctIds: 'NCT1234567' }), // Only 7 digits
    ).toThrow();

    expect(() =>
      getStudyTool.inputSchema.parse({ nctIds: 'NCT12345678' }),
    ).not.toThrow();
  });

  it('should enforce maximum of 5 NCT IDs', () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => `NCT1234567${i}`);

    expect(() => getStudyTool.inputSchema.parse({ nctIds: tooMany })).toThrow();
  });

  it('should format response as JSON string', () => {
    const mockOutput = {
      studies: [
        {
          nctId: 'NCT12345678',
          title: 'Test',
        },
      ],
    };

    const formatted = getStudyTool.responseFormatter!(mockOutput as any);

    expect(formatted).toHaveLength(1);
    expect(formatted[0]!.type).toBe('text');
    expect(formatted[0]).toHaveProperty('text');
    expect(typeof (formatted[0] as any).text).toBe('string');
    expect(() => JSON.parse((formatted[0] as any).text)).not.toThrow();
  });
});
