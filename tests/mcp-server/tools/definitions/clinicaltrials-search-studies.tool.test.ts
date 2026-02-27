/**
 * @fileoverview Tests for the clinicaltrials_search_studies tool definition.
 * Covers metadata, input schema validation, logic function, and response formatting.
 * @module tests/mcp-server/tools/definitions/clinicaltrials-search-studies.tool.test
 */
import { container } from '@/container/core/container.js';
import { ClinicalTrialsProvider } from '@/container/core/tokens.js';
import { McpError } from '@/types-global/errors.js';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { searchStudiesTool } from '../../../../src/mcp-server/tools/definitions/clinicaltrials-search-studies.tool.js';
import type { IClinicalTrialsProvider } from '../../../../src/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { PagedStudies } from '../../../../src/services/clinical-trials-gov/types.js';
import { requestContextService } from '../../../../src/utils/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStudy(nctId: string, title: string, status: string) {
  return {
    protocolSection: {
      identificationModule: { nctId, briefTitle: title },
      statusModule: { overallStatus: status },
    },
  };
}

function makePagedStudies(overrides: Partial<PagedStudies> = {}): PagedStudies {
  return {
    studies: [],
    totalCount: 0,
    ...overrides,
  };
}

const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'test-request-id',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
} as any;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('searchStudiesTool', () => {
  let mockProvider: IClinicalTrialsProvider;

  beforeEach(() => {
    mockProvider = {
      fetchStudy: vi.fn(),
      listStudies: vi.fn(),
      getFieldValues: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as IClinicalTrialsProvider;

    container.clearInstances();
    container.registerValue(ClinicalTrialsProvider, mockProvider);
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  describe('metadata', () => {
    it('should have the correct name', () => {
      expect(searchStudiesTool.name).toBe('clinicaltrials_search_studies');
    });

    it('should have a human-readable title', () => {
      expect(searchStudiesTool.title).toBe('Search Clinical Trials');
    });

    it('should have a description mentioning search functionality', () => {
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

    it('should have inputSchema, outputSchema, logic, and responseFormatter', () => {
      expect(searchStudiesTool.inputSchema).toBeDefined();
      expect(typeof searchStudiesTool.inputSchema.parse).toBe('function');
      expect(searchStudiesTool.outputSchema).toBeDefined();
      expect(typeof searchStudiesTool.outputSchema.parse).toBe('function');
      expect(typeof searchStudiesTool.logic).toBe('function');
      expect(typeof searchStudiesTool.responseFormatter).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // Input Schema Validation
  // -----------------------------------------------------------------------

  describe('inputSchema', () => {
    it('should accept an empty object and apply defaults', () => {
      const parsed = searchStudiesTool.inputSchema.parse({});
      expect(parsed.pageSize).toBe(10);
      expect(parsed.query).toBeUndefined();
      expect(parsed.filter).toBeUndefined();
      expect(parsed.pageToken).toBeUndefined();
      expect(parsed.sort).toBeUndefined();
      expect(parsed.fields).toBeUndefined();
      expect(parsed.country).toBeUndefined();
      expect(parsed.state).toBeUndefined();
      expect(parsed.city).toBeUndefined();
    });

    it('should accept a full input with all fields', () => {
      const input = {
        query: 'cancer',
        filter: 'AREA[OverallStatus]Recruiting',
        pageSize: 50,
        pageToken: 'abc123',
        sort: 'LastUpdateDate:desc',
        fields: ['NCTId', 'BriefTitle'],
        country: 'United States',
        state: 'California',
        city: 'San Francisco',
      };
      const parsed = searchStudiesTool.inputSchema.parse(input);
      expect(parsed).toMatchObject(input);
    });

    it('should default pageSize to 10 when not provided', () => {
      const parsed = searchStudiesTool.inputSchema.parse({ query: 'test' });
      expect(parsed.pageSize).toBe(10);
    });

    it('should accept pageSize at lower boundary (1)', () => {
      const parsed = searchStudiesTool.inputSchema.parse({ pageSize: 1 });
      expect(parsed.pageSize).toBe(1);
    });

    it('should accept pageSize at upper boundary (200)', () => {
      const parsed = searchStudiesTool.inputSchema.parse({ pageSize: 200 });
      expect(parsed.pageSize).toBe(200);
    });

    it('should reject pageSize of 0', () => {
      const result = searchStudiesTool.inputSchema.safeParse({ pageSize: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject pageSize of 201', () => {
      const result = searchStudiesTool.inputSchema.safeParse({ pageSize: 201 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer pageSize', () => {
      const result = searchStudiesTool.inputSchema.safeParse({
        pageSize: 10.5,
      });
      expect(result.success).toBe(false);
    });

    it('should reject fields as a non-array type', () => {
      const result = searchStudiesTool.inputSchema.safeParse({
        fields: 'NCTId',
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative pageSize', () => {
      const result = searchStudiesTool.inputSchema.safeParse({ pageSize: -5 });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Logic
  // -----------------------------------------------------------------------

  describe('logic', () => {
    it('should return paged studies from the provider', async () => {
      const pagedStudies = makePagedStudies({
        studies: [makeStudy('NCT12345678', 'Cancer Study', 'Recruiting')],
        totalCount: 1,
      });
      (mockProvider.listStudies as Mock).mockResolvedValue(pagedStudies);

      const input = searchStudiesTool.inputSchema.parse({ query: 'cancer' });
      const context = requestContextService.createRequestContext({
        operation: 'test-search',
      });

      const result = await searchStudiesTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(result.pagedStudies).toEqual(pagedStudies);
    });

    it('should handle empty results', async () => {
      const pagedStudies = makePagedStudies({ studies: [], totalCount: 0 });
      (mockProvider.listStudies as Mock).mockResolvedValue(pagedStudies);

      const input = searchStudiesTool.inputSchema.parse({
        query: 'nonexistent',
      });
      const context = requestContextService.createRequestContext({
        operation: 'test-search-empty',
      });

      const result = await searchStudiesTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(result.pagedStudies.studies).toEqual([]);
      expect(result.pagedStudies.totalCount).toBe(0);
    });

    it('should pass query and default pageSize to provider', async () => {
      (mockProvider.listStudies as Mock).mockResolvedValue(makePagedStudies());

      const input = searchStudiesTool.inputSchema.parse({ query: 'diabetes' });
      const context = requestContextService.createRequestContext({
        operation: 'test-params',
      });

      await searchStudiesTool.logic(input, context, mockSdkContext);

      expect(mockProvider.listStudies).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'diabetes', pageSize: 10 }),
        context,
      );
    });

    it('should pass filter parameter to provider', async () => {
      (mockProvider.listStudies as Mock).mockResolvedValue(makePagedStudies());

      const input = searchStudiesTool.inputSchema.parse({
        filter: 'AREA[OverallStatus]Recruiting',
        pageSize: 20,
      });
      const context = requestContextService.createRequestContext({
        operation: 'test-filter',
      });

      await searchStudiesTool.logic(input, context, mockSdkContext);

      expect(mockProvider.listStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: 'AREA[OverallStatus]Recruiting',
          pageSize: 20,
        }),
        context,
      );
    });

    it('should pass pageToken for pagination', async () => {
      const pagedStudies = makePagedStudies({
        totalCount: 100,
        nextPageToken: 'next-token-456',
      });
      (mockProvider.listStudies as Mock).mockResolvedValue(pagedStudies);

      const input = searchStudiesTool.inputSchema.parse({
        query: 'diabetes',
        pageToken: 'token-123',
      });
      const context = requestContextService.createRequestContext({
        operation: 'test-pagination',
      });

      const result = await searchStudiesTool.logic(
        input,
        context,
        mockSdkContext,
      );

      expect(result.pagedStudies.nextPageToken).toBe('next-token-456');
      expect(mockProvider.listStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: 'token-123' }),
        context,
      );
    });

    it('should combine location fields into locationQuery for the provider', async () => {
      (mockProvider.listStudies as Mock).mockResolvedValue(makePagedStudies());

      const input = searchStudiesTool.inputSchema.parse({
        country: 'United States',
        state: 'California',
        city: 'San Francisco',
      });
      const context = requestContextService.createRequestContext({
        operation: 'test-location',
      });

      await searchStudiesTool.logic(input, context, mockSdkContext);

      expect(mockProvider.listStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          locationQuery: 'San Francisco, California, United States',
        }),
        context,
      );
      // Individual location fields should NOT be passed to the provider
      const calledWith = (mockProvider.listStudies as Mock).mock.calls[0]![0];
      expect(calledWith).not.toHaveProperty('country');
      expect(calledWith).not.toHaveProperty('state');
      expect(calledWith).not.toHaveProperty('city');
    });

    it('should pass field selection to provider', async () => {
      (mockProvider.listStudies as Mock).mockResolvedValue(makePagedStudies());

      const input = searchStudiesTool.inputSchema.parse({
        query: 'covid',
        fields: ['NCTId', 'BriefTitle', 'OverallStatus'],
      });
      const context = requestContextService.createRequestContext({
        operation: 'test-fields',
      });

      await searchStudiesTool.logic(input, context, mockSdkContext);

      expect(mockProvider.listStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: ['NCTId', 'BriefTitle', 'OverallStatus'],
        }),
        context,
      );
    });

    it('should pass sort parameter to provider', async () => {
      (mockProvider.listStudies as Mock).mockResolvedValue(makePagedStudies());

      const input = searchStudiesTool.inputSchema.parse({
        query: 'alzheimer',
        sort: 'LastUpdateDate:desc',
      });
      const context = requestContextService.createRequestContext({
        operation: 'test-sort',
      });

      await searchStudiesTool.logic(input, context, mockSdkContext);

      expect(mockProvider.listStudies).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'LastUpdateDate:desc' }),
        context,
      );
    });

    it('should omit undefined optional fields from provider params', async () => {
      (mockProvider.listStudies as Mock).mockResolvedValue(makePagedStudies());

      const input = searchStudiesTool.inputSchema.parse({ query: 'test' });
      const context = requestContextService.createRequestContext({
        operation: 'test-omit-undefined',
      });

      await searchStudiesTool.logic(input, context, mockSdkContext);

      const calledWith = (mockProvider.listStudies as Mock).mock.calls[0]![0];
      expect(calledWith).not.toHaveProperty('filter');
      expect(calledWith).not.toHaveProperty('pageToken');
      expect(calledWith).not.toHaveProperty('sort');
      expect(calledWith).not.toHaveProperty('fields');
      expect(calledWith).not.toHaveProperty('country');
      expect(calledWith).not.toHaveProperty('state');
      expect(calledWith).not.toHaveProperty('city');
      // pageSize and query should be present
      expect(calledWith).toHaveProperty('query', 'test');
      expect(calledWith).toHaveProperty('pageSize', 10);
    });

    it('should propagate McpError from provider', async () => {
      const error = new McpError(-32000, 'API rate limit exceeded');
      (mockProvider.listStudies as Mock).mockRejectedValue(error);

      const input = searchStudiesTool.inputSchema.parse({ query: 'test' });
      const context = requestContextService.createRequestContext({
        operation: 'test-error',
      });

      await expect(
        searchStudiesTool.logic(input, context, mockSdkContext),
      ).rejects.toThrow(error);
    });

    it('should propagate generic errors from provider', async () => {
      (mockProvider.listStudies as Mock).mockRejectedValue(
        new Error('Network timeout'),
      );

      const input = searchStudiesTool.inputSchema.parse({ query: 'test' });
      const context = requestContextService.createRequestContext({
        operation: 'test-generic-error',
      });

      await expect(
        searchStudiesTool.logic(input, context, mockSdkContext),
      ).rejects.toThrow('Network timeout');
    });
  });

  // -----------------------------------------------------------------------
  // Response Formatter
  // -----------------------------------------------------------------------

  describe('responseFormatter', () => {
    const formatter = searchStudiesTool.responseFormatter!;

    it('should format multiple studies with total count', () => {
      const result = {
        pagedStudies: makePagedStudies({
          studies: [
            makeStudy('NCT11111111', 'Study One', 'Recruiting'),
            makeStudy('NCT22222222', 'Study Two', 'Completed'),
          ],
          totalCount: 100,
        }),
      };

      const formatted = formatter(result as any);

      expect(formatted).toHaveLength(1);
      expect(formatted[0]!.type).toBe('text');
      const text = (formatted[0] as any).text as string;
      expect(text).toContain('Found 2 studies');
      expect(text).toContain('of 100 total');
      expect(text).toContain('NCT11111111');
      expect(text).toContain('Study One');
      expect(text).toContain('Recruiting');
      expect(text).toContain('NCT22222222');
      expect(text).toContain('Study Two');
      expect(text).toContain('Completed');
    });

    it('should use singular "study" for a single result', () => {
      const result = {
        pagedStudies: makePagedStudies({
          studies: [makeStudy('NCT11111111', 'Only Study', 'Recruiting')],
          totalCount: 1,
        }),
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;
      expect(text).toContain('Found 1 study');
      expect(text).not.toContain('Found 1 studies');
    });

    it('should format empty results', () => {
      const result = {
        pagedStudies: makePagedStudies({ studies: [], totalCount: 0 }),
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;
      expect(text).toContain('Found 0 studies');
    });

    it('should include pagination info when nextPageToken exists', () => {
      const result = {
        pagedStudies: makePagedStudies({
          studies: [makeStudy('NCT11111111', 'Study One', 'Recruiting')],
          totalCount: 50,
          nextPageToken: 'page-2-token',
        }),
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;
      expect(text).toContain('(more pages available)');
      expect(text).toContain('Next page token: page-2-token');
    });

    it('should not include pagination info when no nextPageToken', () => {
      const result = {
        pagedStudies: makePagedStudies({
          studies: [makeStudy('NCT11111111', 'Study One', 'Recruiting')],
          totalCount: 1,
        }),
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;
      expect(text).not.toContain('(more pages available)');
      expect(text).not.toContain('Next page token');
    });

    it('should truncate study list at 5 and show "...and N more"', () => {
      const studies = Array.from({ length: 8 }, (_, i) =>
        makeStudy(`NCT0000000${i}`, `Study ${i}`, 'Recruiting'),
      );
      const result = {
        pagedStudies: makePagedStudies({ studies, totalCount: 200 }),
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;

      // First 5 should be present
      expect(text).toContain('NCT00000000');
      expect(text).toContain('NCT00000004');
      // 6th and beyond should NOT be listed
      expect(text).not.toContain('NCT00000005');
      expect(text).not.toContain('NCT00000007');
      // "...and 3 more" for 8 - 5 = 3
      expect(text).toContain('...and 3 more');
    });

    it('should show exactly 5 studies without "more" when count is 5', () => {
      const studies = Array.from({ length: 5 }, (_, i) =>
        makeStudy(`NCT0000000${i}`, `Study ${i}`, 'Active'),
      );
      const result = {
        pagedStudies: makePagedStudies({ studies, totalCount: 5 }),
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;

      expect(text).toContain('NCT00000004');
      expect(text).not.toContain('...and');
    });

    it('should handle studies with missing protocol section fields', () => {
      const result = {
        pagedStudies: makePagedStudies({
          studies: [
            { protocolSection: {} },
            { protocolSection: { identificationModule: {} } },
            {},
          ] as any,
          totalCount: 3,
        }),
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;
      expect(text).toContain('Found 3 studies');
      expect(text).toContain('Unknown');
      expect(text).toContain('No title');
      expect(text).toContain('Unknown status');
    });

    it('should omit totalCount from summary when it is undefined', () => {
      const result = {
        pagedStudies: {
          studies: [makeStudy('NCT11111111', 'Study One', 'Recruiting')],
        },
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;
      expect(text).toContain('Found 1 study');
      expect(text).not.toContain('of');
      expect(text).not.toContain('total');
    });

    it('should handle undefined studies array', () => {
      const result = {
        pagedStudies: { totalCount: 0 },
      };

      const formatted = formatter(result as any);
      const text = (formatted[0] as any).text as string;
      expect(text).toContain('Found 0 studies');
    });
  });
});
