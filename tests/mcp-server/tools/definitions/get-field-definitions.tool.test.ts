/**
 * @fileoverview Tests for clinicaltrials_get_field_definitions tool.
 * @module tests/mcp-server/tools/definitions/get-field-definitions.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { getFieldDefinitions } from '@/mcp-server/tools/definitions/get-field-definitions.tool.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';

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
            description: 'The NCT identifier',
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
      },
    ],
  },
];

describe('getFieldDefinitions', () => {
  const mockService = { getMetadata: vi.fn(), searchFieldDefinitions: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('accepts no parameters (top-level overview)', () => {
      expect(() => getFieldDefinitions.input!.parse({})).not.toThrow();
    });

    it('accepts a path parameter', () => {
      const input = getFieldDefinitions.input!.parse({ path: 'protocolSection.statusModule' });
      expect(input.path).toBe('protocolSection.statusModule');
    });

    it('accepts a query parameter', () => {
      const input = getFieldDefinitions.input!.parse({ query: 'enrollment' });
      expect(input.query).toBe('enrollment');
    });

    it('accepts includeIndexedOnly flag', () => {
      const input = getFieldDefinitions.input!.parse({ includeIndexedOnly: true });
      expect(input.includeIndexedOnly).toBe(true);
    });

    it('defaults limit to 20', () => {
      const input = getFieldDefinitions.input!.parse({ query: 'sponsor' });
      expect(input.limit).toBe(20);
    });
  });

  describe('handler', () => {
    it('returns top-level overview when no path provided', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext();
      const input = getFieldDefinitions.input!.parse({});
      const result = await getFieldDefinitions.handler(input, ctx);

      expect(result.fields).toHaveLength(2);
      expect(result.fields[0]!.name).toBe('protocolSection');
      expect(result.fields[0]!.children).toBeDefined();
      expect(result.fields[0]!.children).toHaveLength(2);
      expect(result.resolvedPath).toBeUndefined();
    });

    it('includes child summaries in overview', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext();
      const result = await getFieldDefinitions.handler(getFieldDefinitions.input!.parse({}), ctx);

      const protocolChildren = result.fields[0]!.children!;
      expect(protocolChildren[0]!).toMatchObject({
        name: 'identificationModule',
        piece: 'IdentificationModule',
        hasChildren: true,
      });
    });

    it('returns totalFields count for overview', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext();
      const result = await getFieldDefinitions.handler(getFieldDefinitions.input!.parse({}), ctx);

      // 2 top-level sections + 2 children of protocolSection + 1 child of resultsSection = 5
      expect(result.totalFields).toBe(5);
    });

    it('navigates to a path and returns flattened children', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext();
      const input = getFieldDefinitions.input!.parse({
        path: 'protocolSection.identificationModule',
      });
      const result = await getFieldDefinitions.handler(input, ctx);

      expect(result.resolvedPath).toBe('protocolSection.identificationModule');
      expect(result.fields).toHaveLength(2);
      expect(result.fields[0]!.name).toBe('nctId');
      expect(result.fields[0]!.piece).toBe('NCTId');
      expect(result.fields[0]!.path).toBe('protocolSection.identificationModule.nctId');
      expect(result.fields[1]!.name).toBe('briefTitle');
    });

    it('throws on invalid path', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext({ errors: getFieldDefinitions.errors });
      const input = getFieldDefinitions.input!.parse({ path: 'nonexistent.path' });

      await expect(getFieldDefinitions.handler(input, ctx)).rejects.toThrow(
        /Path 'nonexistent.path' not found/,
      );
    });

    it('includes available section names in error for invalid path', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext({ errors: getFieldDefinitions.errors });
      const input = getFieldDefinitions.input!.parse({ path: 'badSection' });

      await expect(getFieldDefinitions.handler(input, ctx)).rejects.toThrow(
        /protocolSection.*resultsSection/,
      );
    });

    it('navigates single-level path', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext();
      const input = getFieldDefinitions.input!.parse({ path: 'protocolSection' });
      const result = await getFieldDefinitions.handler(input, ctx);

      expect(result.resolvedPath).toBe('protocolSection');
      expect(result.fields.some((f) => f.name === 'nctId')).toBe(true);
    });

    it('recursively flattens nested children', async () => {
      mockService.getMetadata.mockResolvedValue(sampleTree);
      const ctx = createMockContext();
      const input = getFieldDefinitions.input!.parse({ path: 'protocolSection' });
      const result = await getFieldDefinitions.handler(input, ctx);

      // identificationModule + its 2 children + statusModule + its 1 child = 5
      expect(result.totalFields).toBe(5);
    });

    it('passes includeIndexedOnly to service', async () => {
      mockService.getMetadata.mockResolvedValue([]);
      const ctx = createMockContext();
      await getFieldDefinitions.handler(
        getFieldDefinitions.input!.parse({ includeIndexedOnly: true }),
        ctx,
      );

      expect(mockService.getMetadata).toHaveBeenCalledWith(true, ctx);
    });

    it('defaults includeIndexedOnly to false', async () => {
      mockService.getMetadata.mockResolvedValue([]);
      const ctx = createMockContext();
      await getFieldDefinitions.handler(getFieldDefinitions.input!.parse({}), ctx);

      expect(mockService.getMetadata).toHaveBeenCalledWith(false, ctx);
    });

    it('routes to searchFieldDefinitions when query is provided', async () => {
      mockService.searchFieldDefinitions.mockResolvedValue([
        {
          name: 'enrollmentInfo',
          piece: 'EnrollmentCount',
          path: 'protocolSection.designModule.enrollmentInfo.count',
          type: 'INTEGER',
        },
      ]);
      const ctx = createMockContext();
      const input = getFieldDefinitions.input!.parse({ query: 'enrollment', limit: 5 });
      const result = await getFieldDefinitions.handler(input, ctx);

      expect(mockService.searchFieldDefinitions).toHaveBeenCalledWith('enrollment', 5, ctx);
      expect(mockService.getMetadata).not.toHaveBeenCalled();
      expect(result.searchQuery).toBe('enrollment');
      expect(result.fields).toHaveLength(1);
      expect(result.fields[0]!.piece).toBe('EnrollmentCount');
    });

    it('rejects providing both query and path', async () => {
      const ctx = createMockContext();
      const input = getFieldDefinitions.input!.parse({
        query: 'enrollment',
        path: 'protocolSection',
      });

      await expect(getFieldDefinitions.handler(input, ctx)).rejects.toThrow(
        /Provide either `query` or `path`/,
      );
    });
  });

  describe('format', () => {
    it('renders overview with children and arrows', () => {
      const blocks = getFieldDefinitions.format!({
        fields: [
          {
            name: 'protocolSection',
            children: [
              { name: 'identificationModule', piece: 'IdentificationModule', hasChildren: true },
              { name: 'statusModule', piece: 'StatusModule', type: 'OBJECT', isEnum: false },
            ],
          },
        ],
        totalFields: 3,
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('protocolSection');
      expect(text).toContain('identificationModule [IdentificationModule]');
      expect(text).toContain('→'); // arrow for hasChildren
    });

    it('renders path result with field details', () => {
      const blocks = getFieldDefinitions.format!({
        fields: [
          { name: 'nctId', piece: 'NCTId', sourceType: 'STRING' },
          { name: 'overallStatus', piece: 'OverallStatus', sourceType: 'STRING', isEnum: true },
        ],
        totalFields: 2,
        resolvedPath: 'protocolSection.identificationModule',
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('protocolSection.identificationModule');
      expect(text).toContain('2 fields');
      expect(text).toContain('nctId [NCTId]');
      expect(text).toContain('ENUM');
    });

    it('renders empty result', () => {
      const blocks = getFieldDefinitions.format!({ fields: [], totalFields: 0 });
      expect((blocks[0] as { text: string }).text).toContain('No fields found');
    });

    it('renders search results with the query in the header', () => {
      const blocks = getFieldDefinitions.format!({
        fields: [
          {
            name: 'enrollmentInfo',
            piece: 'EnrollmentCount',
            path: 'protocolSection.designModule.enrollmentInfo.count',
            type: 'INTEGER',
          },
        ],
        totalFields: 1,
        searchQuery: 'enrollment',
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain("matching 'enrollment'");
      expect(text).toContain('EnrollmentCount');
    });
  });
});
