/**
 * @fileoverview Tests for the clinicaltrials_search_studies tool definition.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-search-studies.tool.test
 */
import { container } from 'tsyringe';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ClinicalTrialsProvider } from '../../../../src/container/tokens.js';
import { searchStudiesTool } from '../../../../src/mcp-server/tools/definitions/clinicaltrials-search-studies.tool.js';
import type { IClinicalTrialsProvider } from '../../../../src/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { PagedStudies } from '../../../../src/services/clinical-trials-gov/types.js';
import { requestContextService } from '../../../../src/utils/index.js';

describe('searchStudiesTool', () => {
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
    expect(searchStudiesTool.name).toBe('clinicaltrials_search_studies');
    expect(searchStudiesTool.title).toBe('Search Clinical Trials');
    expect(searchStudiesTool.description).toContain(
      'Searches for clinical trial studies',
    );
  });

  it('should have correct annotations', () => {
    expect(searchStudiesTool.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('should search studies with query parameter', async () => {
    const mockPagedStudies: PagedStudies = {
      studies: [
        {
          protocolSection: {
            identificationModule: {
              nctId: 'NCT12345678',
              briefTitle: 'Cancer Study',
            },
            statusModule: {
              overallStatus: 'Recruiting',
            },
          },
        },
      ],
      totalCount: 1,
      nextPageToken: undefined,
    };

    (mockProvider.listStudies as Mock).mockResolvedValue(mockPagedStudies);

    const input = { query: 'cancer', pageSize: 10 };
    const parsedInput = searchStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await searchStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.pagedStudies).toEqual(mockPagedStudies);
    expect(mockProvider.listStudies).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'cancer', pageSize: 10 }),
      context,
    );
  });

  it('should search studies with filter parameter', async () => {
    const mockPagedStudies: PagedStudies = {
      studies: [],
      totalCount: 0,
    };

    (mockProvider.listStudies as Mock).mockResolvedValue(mockPagedStudies);

    const input = {
      filter: 'AREA[OverallStatus]Recruiting',
      pageSize: 20,
    };
    const parsedInput = searchStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await searchStudiesTool.logic(parsedInput, context, sdkContext);

    expect(mockProvider.listStudies).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: 'AREA[OverallStatus]Recruiting',
        pageSize: 20,
      }),
      context,
    );
  });

  it('should support pagination with pageToken', async () => {
    const mockPagedStudies: PagedStudies = {
      studies: [],
      totalCount: 100,
      nextPageToken: 'next-token-456',
    };

    (mockProvider.listStudies as Mock).mockResolvedValue(mockPagedStudies);

    const input = {
      query: 'diabetes',
      pageSize: 10,
      pageToken: 'token-123',
    };
    const parsedInput = searchStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    const result = await searchStudiesTool.logic(
      parsedInput,
      context,
      sdkContext,
    );

    expect(result.pagedStudies.nextPageToken).toBe('next-token-456');
    expect(mockProvider.listStudies).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: 'token-123' }),
      context,
    );
  });

  it('should support location filters', async () => {
    const mockPagedStudies: PagedStudies = {
      studies: [],
      totalCount: 50,
    };

    (mockProvider.listStudies as Mock).mockResolvedValue(mockPagedStudies);

    const input = {
      country: 'United States',
      state: 'California',
      city: 'San Francisco',
      pageSize: 15,
    };
    const parsedInput = searchStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await searchStudiesTool.logic(parsedInput, context, sdkContext);

    expect(mockProvider.listStudies).toHaveBeenCalledWith(
      expect.objectContaining({
        country: 'United States',
        state: 'California',
        city: 'San Francisco',
      }),
      context,
    );
  });

  it('should support field selection', async () => {
    const mockPagedStudies: PagedStudies = {
      studies: [],
      totalCount: 10,
    };

    (mockProvider.listStudies as Mock).mockResolvedValue(mockPagedStudies);

    const input = {
      query: 'covid',
      fields: ['NCTId', 'BriefTitle', 'OverallStatus'],
      pageSize: 10,
    };
    const parsedInput = searchStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await searchStudiesTool.logic(parsedInput, context, sdkContext);

    expect(mockProvider.listStudies).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: ['NCTId', 'BriefTitle', 'OverallStatus'],
      }),
      context,
    );
  });

  it('should support sorting', async () => {
    const mockPagedStudies: PagedStudies = {
      studies: [],
      totalCount: 25,
    };

    (mockProvider.listStudies as Mock).mockResolvedValue(mockPagedStudies);

    const input = {
      query: 'alzheimer',
      sort: 'LastUpdateDate:desc',
      pageSize: 10,
    };
    const parsedInput = searchStudiesTool.inputSchema.parse(input);
    const context = requestContextService.createRequestContext();
    const sdkContext = {} as any;

    await searchStudiesTool.logic(parsedInput, context, sdkContext);

    expect(mockProvider.listStudies).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'LastUpdateDate:desc' }),
      context,
    );
  });

  it('should enforce pageSize limits', () => {
    expect(() =>
      searchStudiesTool.inputSchema.parse({ pageSize: 0 }),
    ).toThrow();

    expect(() =>
      searchStudiesTool.inputSchema.parse({ pageSize: 201 }),
    ).toThrow();

    expect(() =>
      searchStudiesTool.inputSchema.parse({ pageSize: 100 }),
    ).not.toThrow();
  });

  it('should use default pageSize of 10', () => {
    const parsed = searchStudiesTool.inputSchema.parse({});
    expect(parsed.pageSize).toBe(10);
  });

  it('should format response with study summaries', () => {
    const mockOutput = {
      pagedStudies: {
        studies: [
          {
            protocolSection: {
              identificationModule: {
                nctId: 'NCT11111111',
                briefTitle: 'Study One',
              },
              statusModule: {
                overallStatus: 'Recruiting',
              },
            },
          },
          {
            protocolSection: {
              identificationModule: {
                nctId: 'NCT22222222',
                briefTitle: 'Study Two',
              },
              statusModule: {
                overallStatus: 'Completed',
              },
            },
          },
        ],
        totalCount: 100,
        nextPageToken: 'next-token',
      },
    };

    const formatted = searchStudiesTool.responseFormatter!(mockOutput as any);

    expect(formatted).toHaveLength(1);
    expect(formatted[0]!.type).toBe('text');
    const text = (formatted[0]! as any).text;
    expect(text).toContain('Found 2 studies');
    expect(text).toContain('of 100 total');
    expect(text).toContain('NCT11111111');
    expect(text).toContain('Study One');
    expect(text).toContain('Recruiting');
    expect(text).toContain('next-token');
  });

  it('should handle empty results', () => {
    const mockOutput = {
      pagedStudies: {
        studies: [],
        totalCount: 0,
      },
    };

    const formatted = searchStudiesTool.responseFormatter!(mockOutput as any);

    expect(formatted[0]!.type).toBe('text');
    const text = (formatted[0]! as any).text;
    expect(text).toContain('Found 0 studies');
  });
});
