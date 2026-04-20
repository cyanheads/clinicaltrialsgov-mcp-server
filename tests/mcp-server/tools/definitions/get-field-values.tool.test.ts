/**
 * @fileoverview Tests for clinicaltrials_get_field_values tool.
 * @module tests/mcp-server/tools/definitions/get-field-values.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { getFieldValues } from '@/mcp-server/tools/definitions/get-field-values.tool.js';

describe('getFieldValues', () => {
  const mockService = { getFieldValues: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('accepts a single field string', () => {
      const input = getFieldValues.input.parse({ fields: 'OverallStatus' });
      expect(input.fields).toBe('OverallStatus');
    });

    it('accepts an array of fields', () => {
      const input = getFieldValues.input.parse({ fields: ['OverallStatus', 'Phase'] });
      expect(input.fields).toEqual(['OverallStatus', 'Phase']);
    });

    it('requires fields parameter', () => {
      expect(() => getFieldValues.input.parse({})).toThrow();
    });
  });

  describe('handler', () => {
    it('returns field stats for a single field string', async () => {
      const stats = [
        {
          field: 'OverallStatus',
          piece: 'OverallStatus',
          type: 'ENUM',
          uniqueValuesCount: 14,
          topValues: [{ value: 'COMPLETED', studiesCount: 200000 }],
        },
      ];
      mockService.getFieldValues.mockResolvedValue(stats);

      const ctx = createMockContext();
      const input = getFieldValues.input.parse({ fields: 'OverallStatus' });
      const result = await getFieldValues.handler(input, ctx);

      expect(result.fieldStats).toBe(stats);
      expect(mockService.getFieldValues).toHaveBeenCalledWith(['OverallStatus'], ctx);
    });

    it('normalizes single string to array', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext();
      await getFieldValues.handler(getFieldValues.input.parse({ fields: 'Phase' }), ctx);

      expect(mockService.getFieldValues).toHaveBeenCalledWith(['Phase'], ctx);
    });

    it('passes array of fields through', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext();
      const fields = ['OverallStatus', 'Phase'];
      await getFieldValues.handler(getFieldValues.input.parse({ fields }), ctx);

      expect(mockService.getFieldValues).toHaveBeenCalledWith(fields, ctx);
    });

    it('propagates service errors', async () => {
      mockService.getFieldValues.mockRejectedValue(new Error('Invalid field'));
      const ctx = createMockContext();
      await expect(
        getFieldValues.handler(getFieldValues.input.parse({ fields: 'BadField' }), ctx),
      ).rejects.toThrow('Invalid field');
    });
  });

  describe('format', () => {
    it('renders ENUM field stats with top values', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'OverallStatus',
            piece: 'OverallStatus',
            type: 'ENUM',
            uniqueValuesCount: 3,
            topValues: [
              { value: 'RECRUITING', studiesCount: 50000 },
              { value: 'COMPLETED', studiesCount: 200000 },
            ],
          },
        ],
      });
      expect(blocks[0].text).toContain('**OverallStatus** (3 unique values)');
      expect(blocks[0].text).toContain('RECRUITING:');
      expect(blocks[0].text).toContain('COMPLETED:');
    });

    it('renders BOOLEAN field stats', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'HasResults',
            piece: 'HasResults',
            type: 'BOOLEAN',
            trueCount: 50000,
            falseCount: 400000,
          },
        ],
      });
      const text = blocks[0].text;
      expect(text).toContain('**HasResults** (boolean)');
      expect(text).toContain('true:');
      expect(text).toContain('50,000');
      expect(text).toContain('false:');
      expect(text).toContain('400,000');
    });

    it('shows missing studies count', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'Phase',
            piece: 'Phase',
            type: 'ENUM',
            uniqueValuesCount: 6,
            missingStudiesCount: 100000,
            topValues: [{ value: 'PHASE3', studiesCount: 50000 }],
          },
        ],
      });
      expect(blocks[0].text).toContain('missing in 100,000 studies');
    });

    it('does not show missing count when zero', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'Phase',
            piece: 'Phase',
            type: 'ENUM',
            uniqueValuesCount: 6,
            missingStudiesCount: 0,
            topValues: [{ value: 'PHASE3', studiesCount: 50000 }],
          },
        ],
      });
      expect(blocks[0].text).not.toContain('missing');
    });

    it('truncates to 15 values per field', () => {
      const topValues = Array.from({ length: 20 }, (_, i) => ({
        value: `Value${i}`,
        studiesCount: 100 - i,
      }));
      const blocks = getFieldValues.format!({
        fieldStats: [{ field: 'F', piece: 'F', type: 'ENUM', uniqueValuesCount: 20, topValues }],
      });
      const lines = blocks[0].text.split('\n');
      // 1 header + 15 values = 16 lines
      expect(lines).toHaveLength(16);
    });

    it('emits empty-values fallback when topValues is missing', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'UnpopulatedField',
            piece: 'UnpopulatedField',
            type: 'STRING',
            uniqueValuesCount: 0,
            // no topValues property — simulates the optional-field shape
          },
        ],
      });
      expect(blocks[0].text).toContain('**UnpopulatedField**');
      expect(blocks[0].text).toContain('No recorded values for this field.');
    });

    it('emits empty-values fallback when topValues is an empty array', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'EmptyField',
            piece: 'EmptyField',
            type: 'ENUM',
            uniqueValuesCount: 0,
            topValues: [],
          },
        ],
      });
      expect(blocks[0].text).toContain('No recorded values for this field.');
    });

    it('renders multiple fields', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'OverallStatus',
            piece: 'OverallStatus',
            type: 'ENUM',
            uniqueValuesCount: 3,
            topValues: [{ value: 'RECRUITING', studiesCount: 50000 }],
          },
          {
            field: 'Phase',
            piece: 'Phase',
            type: 'ENUM',
            uniqueValuesCount: 6,
            topValues: [{ value: 'PHASE3', studiesCount: 40000 }],
          },
        ],
      });
      const text = blocks[0].text;
      expect(text).toContain('**OverallStatus**');
      expect(text).toContain('**Phase**');
    });
  });
});
