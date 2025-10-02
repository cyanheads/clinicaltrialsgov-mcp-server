/**
 * @fileoverview Tests for the clinicaltrials_analyze_trends tool definition.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-analyze-trends.tool.test
 */
import { container } from 'tsyringe';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  AppConfig,
  ClinicalTrialsProvider,
} from '../../../../src/container/tokens.js';
import { analyzeTrendsTool } from '../../../../src/mcp-server/tools/definitions/clinicaltrials-analyze-trends.tool.js';
import type { IClinicalTrialsProvider } from '../../../../src/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { Study } from '../../../../src/services/clinical-trials-gov/types.js';
import { McpError } from '../../../../src/types-global/errors.js';
import { requestContextService } from '../../../../src/utils/index.js';

describe('analyzeTrendsTool', () => {
  let mockProvider: IClinicalTrialsProvider;
  let mockConfig: any;

  beforeEach(() => {
    mockProvider = {
      fetchStudy: vi.fn(),
      listStudies: vi.fn(),
      getStudyMetadata: vi.fn(),
      getApiStats: vi.fn(),
    } as unknown as IClinicalTrialsProvider;

    mockConfig = {
      maxStudiesForAnalysis: 5000,
    };

    container.clearInstances();
    container.registerInstance(ClinicalTrialsProvider, mockProvider);
    container.registerInstance(AppConfig, mockConfig);
  });

  it('should have the correct name, title, and description', () => {
    expect(analyzeTrendsTool.name).toBe('clinicaltrials_analyze_trends');
    expect(analyzeTrendsTool.title).toBe('Analyze Clinical Trial Trends');
    expect(analyzeTrendsTool.description).toContain('statistical analysis');
  });

  it('should have correct annotations', () => {
    expect(analyzeTrendsTool.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('should analyze studies by status', async () => {
    const mockStudies: Partial<Study>[] = [
      {
        protocolSection: {
          statusModule: { overallStatus: 'Recruiting' },
        },
      },
      {
        protocolSection: {
          statusModule: { overallStatus: 'Recruiting' },
        },
      },
      {
        protocolSection: {
          statusModule: { overallStatus: 'Completed' },
        },
      },
    ];

    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({
        studies: [],
        totalCount: 3,
      })
      .mockResolvedValueOnce({
        studies: mockStudies as Study[],
        totalCount: 3,
      });

    const input = { analysisType: 'countByStatus' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis).toHaveLength(1);
    expect(result.analysis[0]!.analysisType).toBe('countByStatus');
    expect(result.analysis[0]!.totalStudies).toBe(3);
    expect(result.analysis[0]!.results).toEqual({
      Recruiting: 2,
      Completed: 1,
    });
  });

  it('should analyze studies by country', async () => {
    const mockStudies: Partial<Study>[] = [
      {
        protocolSection: {
          contactsLocationsModule: {
            locations: [
              { country: 'United States' },
              { country: 'United States' },
            ],
          },
        },
      },
      {
        protocolSection: {
          contactsLocationsModule: {
            locations: [{ country: 'Canada' }],
          },
        },
      },
    ];

    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 2 })
      .mockResolvedValueOnce({
        studies: mockStudies as Study[],
        totalCount: 2,
      });

    const input = { analysisType: 'countByCountry' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis[0]!.results).toEqual({
      'United States': 2,
      Canada: 1,
    });
  });

  it('should analyze studies by phase', async () => {
    const mockStudies: Partial<Study>[] = [
      {
        protocolSection: {
          designModule: {
            phases: ['Phase 1', 'Phase 2'],
          },
        },
      },
      {
        protocolSection: {
          designModule: {
            phases: ['Phase 2'],
          },
        },
      },
    ];

    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 2 })
      .mockResolvedValueOnce({
        studies: mockStudies as Study[],
        totalCount: 2,
      });

    const input = { analysisType: 'countByPhase' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis[0]!.results).toEqual({
      'Phase 1': 1,
      'Phase 2': 2,
    });
  });

  it('should analyze studies by year', async () => {
    const mockStudies: Partial<Study>[] = [
      {
        protocolSection: {
          statusModule: {
            startDateStruct: { date: '2023-01-15' },
          },
        },
      },
      {
        protocolSection: {
          statusModule: {
            startDateStruct: { date: '2023-06-20' },
          },
        },
      },
      {
        protocolSection: {
          statusModule: {
            startDateStruct: { date: '2024-03-10' },
          },
        },
      },
    ];

    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 3 })
      .mockResolvedValueOnce({
        studies: mockStudies as Study[],
        totalCount: 3,
      });

    const input = { analysisType: 'countByYear' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis[0]!.results).toEqual({
      '2023': 2,
      '2024': 1,
    });
  });

  it('should analyze studies by month', async () => {
    const mockStudies: Partial<Study>[] = [
      {
        protocolSection: {
          statusModule: {
            startDateStruct: { date: '2023-01-15' },
          },
        },
      },
      {
        protocolSection: {
          statusModule: {
            startDateStruct: { date: '2023-01-20' },
          },
        },
      },
      {
        protocolSection: {
          statusModule: {
            startDateStruct: { date: '2023-02-10' },
          },
        },
      },
    ];

    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 3 })
      .mockResolvedValueOnce({
        studies: mockStudies as Study[],
        totalCount: 3,
      });

    const input = { analysisType: 'countByMonth' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis[0]!.results).toEqual({
      '2023-01': 2,
      '2023-02': 1,
    });
  });

  it('should analyze studies by sponsor type', async () => {
    const mockStudies: Partial<Study>[] = [
      {
        protocolSection: {
          sponsorCollaboratorsModule: {
            leadSponsor: { class: 'INDUSTRY' },
          },
        },
      },
      {
        protocolSection: {
          sponsorCollaboratorsModule: {
            leadSponsor: { class: 'INDUSTRY' },
          },
        },
      },
      {
        protocolSection: {
          sponsorCollaboratorsModule: {
            leadSponsor: { class: 'NIH' },
          },
        },
      },
    ];

    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 3 })
      .mockResolvedValueOnce({
        studies: mockStudies as Study[],
        totalCount: 3,
      });

    const input = { analysisType: 'countBySponsorType' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis[0]!.results).toEqual({
      INDUSTRY: 2,
      NIH: 1,
    });
  });

  it('should support multiple analysis types', async () => {
    const mockStudies: Partial<Study>[] = [
      {
        protocolSection: {
          statusModule: { overallStatus: 'Recruiting' },
          designModule: { phases: ['Phase 2'] },
        },
      },
    ];

    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 1 })
      .mockResolvedValueOnce({
        studies: mockStudies as Study[],
        totalCount: 1,
      });

    const input = { analysisType: ['countByStatus', 'countByPhase'] };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis).toHaveLength(2);
    expect(result.analysis[0]!.analysisType).toBe('countByStatus');
    expect(result.analysis[1]!.analysisType).toBe('countByPhase');
  });

  it('should throw when study count exceeds limit', async () => {
    (mockProvider.listStudies as Mock).mockResolvedValue({
      studies: [],
      totalCount: 10000,
    });

    const input = { analysisType: 'countByStatus' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await expect(
      analyzeTrendsTool.logic(parsedInput, context, sdkContext),
    ).rejects.toThrow(McpError);

    await expect(
      analyzeTrendsTool.logic(parsedInput, context, sdkContext),
    ).rejects.toThrow('exceeds the limit');
  });

  it('should handle empty result sets', async () => {
    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 0 })
      .mockResolvedValueOnce({
        studies: [],
        totalCount: 0,
      });

    const input = { analysisType: 'countByStatus' };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await analyzeTrendsTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.analysis[0]!.totalStudies).toBe(0);
    expect(result.analysis[0]!.results).toEqual({});
  });

  it('should format response with analysis summaries', () => {
    const mockOutput = {
      analysis: [
        {
          analysisType: 'countByStatus' as const,
          totalStudies: 100,
          results: {
            Recruiting: 60,
            Completed: 30,
            'Not yet recruiting': 10,
          },
        },
      ],
    };

    const formatted = analyzeTrendsTool.responseFormatter!(mockOutput);

    expect(formatted).toHaveLength(1);
    expect(formatted[0]!.type).toBe('text');
    const text = (formatted[0]! as any).text;
    expect(text).toContain('Completed 1 analysis');
    expect(text).toContain('Total Studies: 100');
    expect(text).toContain('Recruiting: 60 (60.0%)');
    expect(text).toContain('Completed: 30 (30.0%)');
  });

  it('should support query and filter parameters', async () => {
    (mockProvider.listStudies as Mock)
      .mockResolvedValueOnce({ studies: [], totalCount: 5 })
      .mockResolvedValueOnce({
        studies: [],
        totalCount: 5,
      });

    const input = {
      query: 'cancer',
      filter: 'AREA[OverallStatus]Recruiting',
      analysisType: 'countByPhase',
    };
    const parsedInput = analyzeTrendsTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await analyzeTrendsTool.logic(parsedInput, context, sdkContext);

    expect(mockProvider.listStudies).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'cancer',
        filter: 'AREA[OverallStatus]Recruiting',
        pageSize: 1,
      }),
      context,
    );
  });
});
