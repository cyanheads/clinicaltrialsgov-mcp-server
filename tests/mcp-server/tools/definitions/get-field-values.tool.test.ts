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
      const input = getFieldValues.input!.parse({ fields: 'OverallStatus' });
      expect(input.fields).toBe('OverallStatus');
    });

    it('accepts an array of fields', () => {
      const input = getFieldValues.input!.parse({ fields: ['OverallStatus', 'Phase'] });
      expect(input.fields).toEqual(['OverallStatus', 'Phase']);
    });

    it('requires fields parameter', () => {
      expect(() => getFieldValues.input!.parse({})).toThrow();
    });

    it('rejects an empty fields array (#82)', () => {
      expect(() => getFieldValues.input!.parse({ fields: [] })).toThrow();
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
      const input = getFieldValues.input!.parse({ fields: 'OverallStatus' });
      const result = await getFieldValues.handler(input, ctx);

      expect(result.fieldStats).toBe(stats);
      expect(mockService.getFieldValues).toHaveBeenCalledWith(['OverallStatus'], ctx);
    });

    it('normalizes single string to array', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext();
      await getFieldValues.handler(getFieldValues.input!.parse({ fields: 'Phase' }), ctx);

      expect(mockService.getFieldValues).toHaveBeenCalledWith(['Phase'], ctx);
    });

    it('passes array of fields through', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext();
      const fields = ['OverallStatus', 'Phase'];
      await getFieldValues.handler(getFieldValues.input!.parse({ fields }), ctx);

      expect(mockService.getFieldValues).toHaveBeenCalledWith(fields, ctx);
    });

    it('normalizes a JSON-stringified fields array (regression for #75)', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext();
      await getFieldValues.handler(
        getFieldValues.input!.parse({ fields: '["OverallStatus","Phase"]' }),
        ctx,
      );

      expect(mockService.getFieldValues).toHaveBeenCalledWith(['OverallStatus', 'Phase'], ctx);
    });

    it('propagates service errors', async () => {
      mockService.getFieldValues.mockRejectedValue(new Error('Invalid field'));
      const ctx = createMockContext();
      await expect(
        getFieldValues.handler(getFieldValues.input!.parse({ fields: 'BadField' }), ctx),
      ).rejects.toThrow('Invalid field');
    });

    it('rejects an empty stringified array instead of dumping the full catalog (#82)', async () => {
      const ctx = createMockContext({ errors: getFieldValues.errors });
      // A genuine JSON string "[]" validates as a string, normalizes to [] in the
      // handler, and must fail fast rather than omitting the upstream fields param.
      const input = getFieldValues.input!.parse({ fields: '[]' });
      await expect(getFieldValues.handler(input, ctx)).rejects.toThrow(/at least one/i);
      expect(mockService.getFieldValues).not.toHaveBeenCalled();
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
      expect((blocks[0] as { text: string }).text).toContain(
        '**OverallStatus** — OverallStatus (ENUM, 3 unique values)',
      );
      expect((blocks[0] as { text: string }).text).toContain('RECRUITING:');
      expect((blocks[0] as { text: string }).text).toContain('COMPLETED:');
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
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**HasResults** — HasResults (boolean)');
      expect(text).toContain('true: 50000');
      expect(text).toContain('false: 400000');
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
      expect((blocks[0] as { text: string }).text).toContain('missing in 100000 studies');
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
      expect((blocks[0] as { text: string }).text).not.toContain('missing');
    });

    it('renders every fetched topValue with no truncation tail (#90)', () => {
      const topValues = Array.from({ length: 20 }, (_, i) => ({
        value: `Value${i}`,
        studiesCount: 100 - i,
      }));
      const blocks = getFieldValues.format!({
        fieldStats: [{ field: 'F', piece: 'F', type: 'ENUM', uniqueValuesCount: 20, topValues }],
      });
      const text = (blocks[0] as { text: string }).text;
      const lines = text.split('\n');
      // 1 header + all 20 values, no tail — every fetched value reaches content[],
      // and uniqueValuesCount === fetched count means nothing was capped.
      expect(lines).toHaveLength(21);
      for (let i = 0; i < 20; i++) expect(text).toContain(`Value${i}: ${100 - i} studies`);
      expect(text).not.toContain('capped at 250');
      expect(text).not.toContain('Showing all');
    });

    it('discloses the upstream 250-cap when more unique values exist than were fetched (#90)', () => {
      // Mirrors the reported Condition case: 250 fetched, ~131k unique upstream.
      const topValues = Array.from({ length: 250 }, (_, i) => ({
        value: `Condition ${i}`,
        studiesCount: 5000 - i,
      }));
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'Condition',
            piece: 'Condition',
            type: 'STRING',
            uniqueValuesCount: 131547,
            topValues,
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      // The 16th value (index 15) and the last (249) both render — no first-15 cap.
      expect(text).toContain('Condition 0: 5000 studies');
      expect(text).toContain('Condition 15: 4985 studies');
      expect(text).toContain('Condition 249: 4751 studies');
      // Reframed disclosure: honest that the tail is beyond the API cap, not trimmed by us.
      expect(text).toContain(
        'Showing all 250 fetched values (of 131547 unique; topValues capped at 250 by the API).',
      );
      expect(text).not.toContain('and 235 more');
    });

    it('renders no disclosure tail when all unique values are shown (#90)', () => {
      const topValues = Array.from({ length: 10 }, (_, i) => ({
        value: `Value${i}`,
        studiesCount: 100 - i,
      }));
      const blocks = getFieldValues.format!({
        fieldStats: [{ field: 'F', piece: 'F', type: 'ENUM', uniqueValuesCount: 10, topValues }],
      });
      const text = (blocks[0] as { text: string }).text;
      // uniqueValuesCount === fetched count → nothing capped, no disclosure line.
      expect(text).not.toContain('Showing all');
      expect(text).not.toContain('capped at 250');
      for (let i = 0; i < 10; i++) expect(text).toContain(`Value${i}:`);
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
      expect((blocks[0] as { text: string }).text).toContain('**UnpopulatedField**');
      expect((blocks[0] as { text: string }).text).toContain('No recorded values for this field.');
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
      expect((blocks[0] as { text: string }).text).toContain('No recorded values for this field.');
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
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**OverallStatus**');
      expect(text).toContain('**Phase**');
    });

    it('appends the multi-valued note when multiValued is true (#85)', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'Phase',
            piece: 'Phase',
            type: 'ENUM',
            multiValued: true,
            uniqueValuesCount: 6,
            missingStudiesCount: 139770,
            topValues: [
              { value: 'PHASE2', studiesCount: 200000 },
              { value: 'PHASE3', studiesCount: 150000 },
            ],
          },
        ],
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('multi-valued field');
      expect(text).toContain('counts may exceed the study total');
    });

    it('omits the multi-valued note when multiValued is false or absent (#85)', () => {
      const blocks = getFieldValues.format!({
        fieldStats: [
          {
            field: 'OverallStatus',
            piece: 'OverallStatus',
            type: 'ENUM',
            uniqueValuesCount: 14,
            topValues: [{ value: 'COMPLETED', studiesCount: 200000 }],
          },
        ],
      });
      expect((blocks[0] as { text: string }).text).not.toContain('multi-valued');
    });
  });
});
