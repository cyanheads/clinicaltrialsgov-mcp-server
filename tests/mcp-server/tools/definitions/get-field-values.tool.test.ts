/**
 * @fileoverview Tests for clinicaltrials_get_field_values tool.
 * @module tests/get-field-values.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));

import { getFieldValues } from '@/mcp-server/tools/definitions/get-field-values.tool.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

describe('getFieldValues', () => {
  const mockService = { getFieldValues: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
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
    it('renders field stats with top values', () => {
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
  });
});
