/**
 * @fileoverview Tests for clinicaltrials_get_field_values tool.
 * @module tests/mcp-server/tools/definitions/get-field-values.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { missingLeaves } from '../../../helpers/format-parity.js';

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

    it('accepts an empty fields array at the schema so the handler can judge it (#109)', () => {
      // The rejection moves to the handler, which is the only layer that can
      // carry a reason and a recovery hint — see the blank_value case below.
      expect(() => getFieldValues.input!.parse({ fields: [] })).not.toThrow();
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

      const ctx = createMockContext({ errors: getFieldValues.errors });
      const input = getFieldValues.input!.parse({ fields: 'OverallStatus' });
      const result = await getFieldValues.handler(input, ctx);

      expect(result.fieldStats).toBe(stats);
      expect(mockService.getFieldValues).toHaveBeenCalledWith(['OverallStatus'], ctx);
    });

    it('normalizes single string to array', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext({ errors: getFieldValues.errors });
      await getFieldValues.handler(getFieldValues.input!.parse({ fields: 'Phase' }), ctx);

      expect(mockService.getFieldValues).toHaveBeenCalledWith(['Phase'], ctx);
    });

    it('passes array of fields through', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext({ errors: getFieldValues.errors });
      const fields = ['OverallStatus', 'Phase'];
      await getFieldValues.handler(getFieldValues.input!.parse({ fields }), ctx);

      expect(mockService.getFieldValues).toHaveBeenCalledWith(fields, ctx);
    });

    it('normalizes a JSON-stringified fields array (regression for #75)', async () => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext({ errors: getFieldValues.errors });
      await getFieldValues.handler(
        getFieldValues.input!.parse({ fields: '["OverallStatus","Phase"]' }),
        ctx,
      );

      expect(mockService.getFieldValues).toHaveBeenCalledWith(['OverallStatus', 'Phase'], ctx);
    });

    it('propagates service errors', async () => {
      mockService.getFieldValues.mockRejectedValue(new Error('Invalid field'));
      const ctx = createMockContext({ errors: getFieldValues.errors });
      await expect(
        getFieldValues.handler(getFieldValues.input!.parse({ fields: 'BadField' }), ctx),
      ).rejects.toThrow('Invalid field');
    });

    // Both empty forms — the real array and the stringified '[]' LLM callers
    // sometimes send — resolve to [] after toArray and must fail fast rather
    // than dropping the upstream fields param and dumping the full catalog
    // (#82). The reason is blank_value, not field_invalid: field_invalid's
    // recovery hint sends the caller to browse the field tree, which answers a
    // question a caller who supplied [] did not ask (#109).
    it.each([[[]], ['[]']])(
      'answers an empty fields list (%j) with the typed blank_value contract',
      async (fields) => {
        const ctx = createMockContext({ errors: getFieldValues.errors });
        const input = getFieldValues.input!.parse({ fields });
        await expect(getFieldValues.handler(input, ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_value', param: 'fields' },
        });
        expect(mockService.getFieldValues).not.toHaveBeenCalled();
      },
    );

    it('answers a fields list carrying a blank entry with the blank_value contract', async () => {
      const ctx = createMockContext({ errors: getFieldValues.errors });
      const input = getFieldValues.input!.parse({ fields: ['OverallStatus', '  '] });
      await expect(getFieldValues.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_value', param: 'fields' },
      });
      expect(mockService.getFieldValues).not.toHaveBeenCalled();
    });

    it('declares the blank_value reason on the tool contract', () => {
      expect(getFieldValues.errors?.map((e) => e.reason)).toContain('blank_value');
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

  // Upstream keys the statistics shape on `type`. INTEGER/NUMBER carry a
  // numeric range, DATE a date range plus its precisions, STRING an optional
  // longest value — none of which the ENUM/STRING value-bucket rendering can
  // express, so routing them through it reported a populated range as an empty
  // dataset (#119).
  describe('format — range and date statistics variants (#119)', () => {
    const render = (stat: Record<string, unknown>) =>
      (
        getFieldValues.format!({
          fieldStats: [stat as never],
        })[0] as { text: string }
      ).text;

    it('renders min, max, and avg for an INTEGER field', () => {
      const text = render({
        field: 'protocolSection.designModule.enrollmentInfo.count',
        piece: 'EnrollmentCount',
        type: 'INTEGER',
        missingStudiesCount: 90210,
        min: 1234567,
        max: 88888888,
        avg: 5481.161989122102,
      });
      expect(text).toContain(
        '**EnrollmentCount** — protocolSection.designModule.enrollmentInfo.count (INTEGER):',
      );
      expect(text).toContain('min: 1234567');
      expect(text).toContain('max: 88888888');
      // No rounding: the average reaches content[] with every digit the API sent.
      expect(text).toContain('avg: 5481.161989122102');
      expect(text).toContain('(missing in 90210 studies)');
    });

    it('does not print the ENUM/STRING empty-values line or a unique count for INTEGER', () => {
      const text = render({
        field: 'protocolSection.designModule.enrollmentInfo.count',
        piece: 'EnrollmentCount',
        type: 'INTEGER',
        missingStudiesCount: 90210,
        min: 1234567,
        max: 88888888,
        avg: 5481.161989122102,
      });
      expect(text).not.toContain('No recorded values for this field.');
      expect(text).not.toContain('unique values');
    });

    // No live field returns NUMBER today (`types=NUMBER` answers `[]`), but it
    // is a documented response shape — structurally IntegerStats with floats.
    it('renders float min, max, and avg for a NUMBER field', () => {
      const text = render({
        field: 'protocolSection.syntheticModule.ratio',
        piece: 'SyntheticRatio',
        type: 'NUMBER',
        missingStudiesCount: 606,
        min: 0.125,
        max: 99.875,
        avg: 42.4242,
      });
      expect(text).toContain(
        '**SyntheticRatio** — protocolSection.syntheticModule.ratio (NUMBER):',
      );
      expect(text).toContain('min: 0.125');
      expect(text).toContain('max: 99.875');
      expect(text).toContain('avg: 42.4242');
      expect(text).not.toContain('No recorded values for this field.');
      expect(text).not.toContain('unique values');
    });

    it('renders a DATE range and every format, preserving partial dates verbatim', () => {
      const text = render({
        field: 'protocolSection.statusModule.startDateStruct.date',
        piece: 'StartDate',
        type: 'DATE',
        missingStudiesCount: 5362,
        min: '1900-01',
        max: '2099-01-01',
        formats: ['yyyy-MM', 'yyyy-MM-dd'],
      });
      expect(text).toContain(
        '**StartDate** — protocolSection.statusModule.startDateStruct.date (DATE):',
      );
      // A month-precision bound stays month-precision — no Date coercion anywhere.
      expect(text).toContain('min: 1900-01');
      expect(text).not.toContain('1900-01-01');
      expect(text).toContain('max: 2099-01-01');
      expect(text).toContain('date formats: yyyy-MM, yyyy-MM-dd');
      expect(text).not.toContain('No recorded values for this field.');
      expect(text).not.toContain('unique values');
    });

    it('renders a DATE carrying formats but no computed range', () => {
      const text = render({
        field: 'protocolSection.statusModule.someDate',
        piece: 'SomeDate',
        type: 'DATE',
        missingStudiesCount: 4,
        formats: ['yyyy-MM-dd'],
      });
      expect(text).toContain('date formats: yyyy-MM-dd');
      expect(text).not.toContain('min:');
      expect(text).not.toContain('max:');
      expect(text).not.toContain('No recorded values for this field.');
      expect(text).not.toContain('No date range or formats reported');
    });

    it('names the right variant when a DATE reports no range and no formats', () => {
      const text = render({
        field: 'protocolSection.statusModule.someDate',
        piece: 'SomeDate',
        type: 'DATE',
        missingStudiesCount: 4,
      });
      expect(text).toContain('No date range or formats reported for this field.');
      // The ENUM/STRING line (#25) would name the wrong variant here.
      expect(text).not.toContain('No recorded values for this field.');
    });

    it('names the right variant when an INTEGER reports no range and no average', () => {
      const text = render({
        field: 'protocolSection.designModule.someCount',
        piece: 'SomeCount',
        type: 'INTEGER',
        missingStudiesCount: 4,
      });
      expect(text).toContain('No range or average reported for this field.');
      expect(text).not.toContain('No recorded values for this field.');
    });

    it('renders the longest value, its length, and its NCT ID for a STRING field', () => {
      const text = render({
        field: 'protocolSection.designModule.targetDuration',
        piece: 'TargetDuration',
        type: 'STRING',
        missingStudiesCount: 584791,
        uniqueValuesCount: 241,
        topValues: [{ value: '6 Months', studiesCount: 3042 }],
        longest: { value: '2250 Months', length: 11, nctId: 'NCT05910151' },
      });
      expect(text).toContain('longest value: "2250 Months" (11 characters, in NCT05910151)');
      // The STRING value buckets and the 250-cap disclosure are untouched.
      expect(text).toContain('6 Months: 3042 studies');
      expect(text).toContain('241 unique values');
    });

    it('renders an ENUM field unchanged when no longest is present', () => {
      const text = render({
        field: 'protocolSection.statusModule.overallStatus',
        piece: 'OverallStatus',
        type: 'ENUM',
        missingStudiesCount: 0,
        uniqueValuesCount: 14,
        topValues: [{ value: 'COMPLETED', studiesCount: 262626 }],
      });
      expect(text).toContain(
        '**OverallStatus** — protocolSection.statusModule.overallStatus (ENUM, 14 unique values):',
      );
      expect(text).toContain('COMPLETED: 262626 studies');
      expect(text).not.toContain('longest value');
    });
  });

  // A single request mixing variants must route each field through its own
  // branch — the shared `format()` loop is where cross-contamination would show.
  describe('format — mixed-variant request (#119)', () => {
    const mixed = {
      fieldStats: [
        {
          field: 'protocolSection.statusModule.overallStatus',
          piece: 'OverallStatus',
          type: 'ENUM',
          missingStudiesCount: 7777,
          uniqueValuesCount: 14,
          topValues: [{ value: 'COMPLETED', studiesCount: 262626 }],
        },
        {
          field: 'protocolSection.designModule.enrollmentInfo.count',
          piece: 'EnrollmentCount',
          type: 'INTEGER',
          missingStudiesCount: 90210,
          min: 1234567,
          max: 88888888,
          avg: 5481.161989122102,
        },
        {
          field: 'protocolSection.statusModule.startDateStruct.date',
          piece: 'StartDate',
          type: 'DATE',
          missingStudiesCount: 5362,
          min: '1900-01',
          max: '2099-01-01',
          formats: ['yyyy-MM', 'yyyy-MM-dd'],
        },
        {
          field: 'protocolSection.designModule.targetDuration',
          piece: 'TargetDuration',
          type: 'STRING',
          missingStudiesCount: 584791,
          uniqueValuesCount: 241,
          topValues: [{ value: '6 Months', studiesCount: 3042 }],
          longest: { value: '2250 Months', length: 11, nctId: 'NCT05910151' },
        },
      ],
    };

    it('renders each field through its own branch with no cross-contamination', () => {
      const text = (getFieldValues.format!(mixed as never)[0] as { text: string }).text;

      expect(text).toContain('(ENUM, 14 unique values)');
      expect(text).toContain('COMPLETED: 262626 studies');
      expect(text).toContain('(INTEGER):');
      expect(text).toContain('avg: 5481.161989122102');
      expect(text).toContain('(DATE):');
      expect(text).toContain('date formats: yyyy-MM, yyyy-MM-dd');
      expect(text).toContain('(STRING, 241 unique values)');
      expect(text).toContain('longest value: "2250 Months" (11 characters, in NCT05910151)');
      // Not one of the four is an empty dataset.
      expect(text).not.toContain('No recorded values for this field.');
      // Only the two bucket-bearing fields get a unique count.
      expect(text.match(/unique values/g)).toHaveLength(2);
    });

    it('carries every structured leaf into content[] (format parity)', () => {
      const text = (getFieldValues.format!(mixed as never)[0] as { text: string }).text;
      expect(missingLeaves(mixed, text)).toEqual([]);
    });
  });
});
