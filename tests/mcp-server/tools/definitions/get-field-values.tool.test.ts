/**
 * @fileoverview Tests for clinicaltrials_get_field_values tool.
 * @module tests/mcp-server/tools/definitions/get-field-values.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
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

      expect(result.fieldStats).toEqual(stats);
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

    // ClinicalTrials.gov's own `fields` parameter is comma- or pipe-delimited
    // and no piece name contains either delimiter (#152).
    it.each([
      ['Phase,StudyType'],
      [['Phase|StudyType']],
      [['Phase, StudyType']],
      [['Phase', 'StudyType,']],
    ])('splits the joined fields %j into separate names', async (fields) => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext({ errors: getFieldValues.errors });
      await getFieldValues.handler(getFieldValues.input!.parse({ fields }), ctx);
      expect(mockService.getFieldValues).toHaveBeenCalledWith(['Phase', 'StudyType'], ctx);
    });

    it.each([[[',']], [['Phase', '']], [',']])(
      'answers %j with blank_value, never a field named after the delimiter',
      async (fields) => {
        const ctx = createMockContext({ errors: getFieldValues.errors });
        await expect(
          getFieldValues.handler(getFieldValues.input!.parse({ fields }), ctx),
        ).rejects.toMatchObject({ data: { reason: 'blank_value', param: 'fields' } });
        expect(mockService.getFieldValues).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a joined string', 'Phase,StudyType,Phase', ['Phase', 'StudyType']],
      ['a list', ['StudyType|Phase', 'Phase', 'StudyType'], ['StudyType', 'Phase']],
      ['"Phase," x1000', 'Phase,'.repeat(1000), ['Phase']],
    ])('requests each field of %s once, in first-seen order', async (_label, fields, deduped) => {
      mockService.getFieldValues.mockResolvedValue([]);
      const ctx = createMockContext({ errors: getFieldValues.errors });
      await getFieldValues.handler(getFieldValues.input!.parse({ fields }), ctx);
      expect(mockService.getFieldValues).toHaveBeenCalledWith(deduped, ctx);
    });

    it('answers a fields entry of only zero-width characters with blank_value', async () => {
      const ctx = createMockContext({ errors: getFieldValues.errors });
      await expect(
        getFieldValues.handler(getFieldValues.input!.parse({ fields: ['Phase', '​'] }), ctx),
      ).rejects.toMatchObject({ data: { reason: 'blank_value', param: 'fields' } });
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

  /** Run stats through the handler, then render the handler's result. */
  const present = async (stats: Record<string, unknown>[]) => {
    mockService.getFieldValues.mockResolvedValue(stats);
    const ctx = createMockContext({ errors: getFieldValues.errors });
    const input = getFieldValues.input!.parse({ fields: stats.map((s) => s.piece as string) });
    const result = await getFieldValues.handler(input, ctx);
    const text = (getFieldValues.format!(result)[0] as { text: string }).text;
    return { result, text, enrichment: getEnrichment(ctx) };
  };

  /** A STRING stat carrying `value` as its longest recorded value. */
  const withLongest = (
    piece: string,
    value: string,
    nctId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    field: `protocolSection.someModule.${piece}`,
    piece,
    type: 'STRING',
    missingStudiesCount: 1077,
    uniqueValuesCount: 0,
    longest: { value, length: value.length, nctId },
    ...extra,
  });

  /**
   * A longest value is a whole recorded value — 32,344 characters for
   * DetailedDescription — so the handler bounds it before either surface reads
   * it, and a notice names the call that returns the full text (#161).
   */
  describe('longest value preview (#161)', () => {
    const description = `START ${'d'.repeat(32_000)} ${'e'.repeat(333)} END`;
    const criteria = `Inclusion: ${'c'.repeat(20_192)}`;

    it('cuts a value over 2,000 characters to a prefix flagged truncated, keeping length and nctId', async () => {
      const { result } = await present([
        withLongest('DetailedDescription', description, 'NCT06708767'),
      ]);
      const longest = result.fieldStats[0]!.longest!;

      expect(description).toHaveLength(32_344);
      expect(longest.value).toHaveLength(2000);
      expect(description.startsWith(longest.value)).toBe(true);
      expect(longest).toEqual({
        value: description.slice(0, 2000),
        length: 32_344,
        nctId: 'NCT06708767',
        truncated: true,
      });
    });

    it.each([
      ['an 11-character value', 11, false],
      ['a value of exactly 2,000 characters', 2000, false],
      ['a value of 2,001 characters', 2001, true],
    ])('previews %s only past the bound', async (_label, size, cut) => {
      const value = 'v'.repeat(size);
      const { result } = await present([withLongest('TargetDuration', value, 'NCT05910151')]);
      const longest = result.fieldStats[0]!.longest!;

      expect(longest.length).toBe(size);
      expect(longest.value).toHaveLength(cut ? 2000 : size);
      expect('truncated' in longest).toBe(cut);
    });

    it('never splits a surrogate pair at the cut', async () => {
      /**
       * The emoji's high surrogate is the 2,000th code unit: a plain 2,000-unit
       * cut would end the preview on half a character.
       */
      const straddling = `${'a'.repeat(1999)}😀${'b'.repeat(500)}`;
      // Here the pair ends exactly at the bound and survives whole.
      const ending = `${'a'.repeat(1998)}😀${'b'.repeat(500)}`;
      const { result } = await present([
        withLongest('BriefSummary', straddling, 'NCT00000001'),
        withLongest('OfficialTitle', ending, 'NCT00000002'),
      ]);
      const [first, second] = result.fieldStats.map((s) => s.longest!);

      expect(first!.value).toBe('a'.repeat(1999));
      expect(first!.length).toBe(straddling.length);
      expect(first!.truncated).toBe(true);
      expect(second!.value).toBe(`${'a'.repeat(1998)}😀`);
      expect(second!.value).toHaveLength(2000);
      for (const { value } of [first!, second!]) expect(value).not.toMatch(/[\uD800-\uDBFF]$/);
    });

    it('names the exact search_studies arguments for each truncated field in a notice', async () => {
      const { enrichment } = await present([
        withLongest('DetailedDescription', description, 'NCT06708767'),
        withLongest('EligibilityCriteria', criteria, 'NCT07217301'),
        withLongest('PrimaryOutcomeDescription', 'p'.repeat(1108), 'NCT06956534'),
      ]);
      // The whole PrimaryOutcomeDescription is not previewed, so it has no retrieval line.
      expect(enrichment.notice).toBe(
        'longest.value is a preview of at most the first 2000 characters where longest.truncated is true; longest.length is the full length. Full text — DetailedDescription: clinicaltrials_search_studies with {"nctIds":["NCT06708767"],"fields":["DetailedDescription"]}; EligibilityCriteria: clinicaltrials_search_studies with {"nctIds":["NCT07217301"],"fields":["EligibilityCriteria"]}.',
      );
    });

    it('adds no notice when nothing was truncated', async () => {
      const { enrichment } = await present([
        withLongest('TargetDuration', '2250 Months', 'NCT05910151', { uniqueValuesCount: 241 }),
      ]);
      expect(enrichment.notice).toBeUndefined();
    });

    it('leaves every other statistic of a previewed field untouched', async () => {
      const topValues = [{ value: 'A citation', studiesCount: 12 }];
      const { result } = await present([
        withLongest('ReferenceCitation', 'r'.repeat(32_179), 'NCT07664540', {
          uniqueValuesCount: 512_345,
          multiValued: true,
          missingStudiesCount: 300_000,
          topValues,
        }),
      ]);
      const stat = result.fieldStats[0]!;

      expect(stat.uniqueValuesCount).toBe(512_345);
      expect(stat.multiValued).toBe(true);
      expect(stat.missingStudiesCount).toBe(300_000);
      expect(stat.topValues).toEqual(topValues);
    });

    it('states the bound and the full length on the preview line', async () => {
      const { text } = await present([
        withLongest('DetailedDescription', description, 'NCT06708767'),
      ]);

      expect(text).toContain(
        `  longest value (first 2000 of 32344 characters, in NCT06708767): "${description.slice(0, 2000)}"`,
      );
      expect(text).not.toContain(' END');
    });

    it('carries the same preview on both surfaces (format parity)', async () => {
      const { result, text } = await present([
        withLongest('DetailedDescription', description, 'NCT06708767'),
        withLongest('EligibilityCriteria', `Inclusion:\n- age 18+\r\n${criteria}`, 'NCT07217301'),
      ]);
      expect(missingLeaves(result, text)).toEqual([]);
    });
  });

  /**
   * A value with line breaks interpolated as one quoted line would start new
   * lines of the field listing — a heading, a list item, a forged field header.
   */
  describe('multi-line longest value (#161)', () => {
    const multiLine = [
      'Inclusion Criteria:',
      '',
      '# Not a heading',
      '- not a list item',
      '1. nor this',
      '**Phase** — protocolSection.designModule.phases (ENUM, 9 unique values):',
      '  PHASE9: 1 studies\r',
      'a ```` run of four backticks',
      '~~~',
    ].join('\n');

    it('renders the value as one fenced block that keeps every line break', async () => {
      const { text } = await present([
        withLongest('EligibilityCriteria', multiLine, 'NCT07217301'),
      ]);
      const fence = '`````';

      expect(text).toContain(
        `  longest value (${multiLine.length} characters, in NCT07217301):\n${fence}\n${multiLine}\n${fence}`,
      );
      // The fence outruns every backtick run in the value, so no line closes it early.
      expect(text.split(fence)).toHaveLength(3);
      expect(text).not.toContain(`longest value: "Inclusion`);
    });

    it('fences a value whose only line break is a carriage return', async () => {
      const value = 'first line\rsecond line';
      const { text } = await present([withLongest('BriefSummary', value, 'NCT00000003')]);
      expect(text).toContain(`\n\`\`\`\n${value}\n\`\`\``);
    });

    it('fences a truncated preview and states the bound', async () => {
      const value = `${multiLine}\n${'x'.repeat(5000)}`;
      const { result, text } = await present([
        withLongest('EligibilityCriteria', value, 'NCT07217301'),
      ]);
      const preview = result.fieldStats[0]!.longest!.value;

      expect(text).toContain(
        `  longest value (first 2000 of ${value.length} characters, in NCT07217301):\n\`\`\`\`\`\n${preview}\n\`\`\`\`\``,
      );
    });

    it('keeps structuredContent verbatim', async () => {
      const { result } = await present([
        withLongest('EligibilityCriteria', multiLine, 'NCT07217301'),
      ]);
      expect(result.fieldStats[0]!.longest!.value).toBe(multiLine);
    });
  });

  const commonmark = new MarkdownIt('commonmark');

  type InlineToken = { type: string; content: string; children: InlineToken[] | null };

  /** The text a reader sees, each line break as `\n`. */
  const seen = (children: InlineToken[]): string =>
    children
      .map((c) =>
        c.type === 'softbreak' || c.type === 'hardbreak'
          ? '\n'
          : c.children?.length
            ? seen(c.children)
            : c.type === 'text' || c.type === 'code_inline'
              ? c.content
              : '',
      )
      .join('');

  /** content[] as a CommonMark reader gets it. */
  const read = (text: string) => {
    const tokens = commonmark.parse(text, {});
    const inline = tokens.filter((t) => t.type === 'inline');
    const children = inline.flatMap((t) => (t.children ?? []) as InlineToken[]);
    return {
      blocks: [
        ...new Set(
          tokens.filter((t) => t.nesting !== -1 && t.type !== 'inline').map((t) => t.type),
        ),
      ].sort(),
      lines: inline.flatMap((t) => seen((t.children ?? []) as InlineToken[]).split('\n')),
      fences: tokens.filter((t) => t.type === 'fence').map((t) => t.content),
      // The field header's **piece** is the only markup the listing writes itself.
      markup: children
        .map((c) => c.type)
        .filter((type) => !['text', 'softbreak', 'strong_open', 'strong_close'].includes(type)),
    };
  };

  /**
   * A single-line longest value sits inside quotes on its preview line, where an
   * email in angle brackets would render as an autolink and an emphasis run or
   * backticks as markup. The reader must see the value exactly.
   */
  describe('single-line longest value renders inertly in content[]', () => {
    const cases = [
      {
        label: 'an email in angle brackets',
        value: 'Contact <zzPDL_MED_Sarcoma_Clinical_Trials@mskcc.org> for enrollment questions',
      },
      { label: 'an emphasis run', value: 'Dose of *high* exposure in ng*hr/mL (_AUC_)' },
      { label: 'backticks', value: 'Uses the `ALT` marker and one stray ` tick' },
      { label: 'a link and an entity', value: '[site](https://example.org) &amp; partners' },
      { label: 'a trailing backslash', value: 'Path C:\\trials\\' },
    ];

    it.each(cases)('shows $label exactly, with no markup', async ({ value }) => {
      const { text } = await present([withLongest('BriefTitle', value, 'NCT00000001')]);
      const { lines, markup } = read(text);
      expect(markup).toEqual([]);
      expect(lines).toContain(
        `longest value: "${value}" (${value.length} characters, in NCT00000001)`,
      );
    });

    it('shows a truncated preview with markup exactly', async () => {
      const value = `*bold* and \`code\` ${'x'.repeat(2500)}`;
      const { result, text } = await present([withLongest('BriefSummary', value, 'NCT00000002')]);
      const preview = result.fieldStats[0]!.longest!.value;
      const { lines, markup } = read(text);
      expect(markup).toEqual([]);
      expect(lines).toContain(
        `longest value (first 2000 of ${value.length} characters, in NCT00000002): "${preview}"`,
      );
    });

    it('leaves a value with nothing to escape byte-identical', async () => {
      const value = 'cdrh_docs at <=18 years, 5 * 3 & [18F]FDG';
      const { text } = await present([withLongest('BriefTitle', value, 'NCT00000003')]);
      expect(text).toContain(`  longest value: "${value}" (${value.length} characters`);
    });

    it('keeps the value verbatim in structuredContent', async () => {
      const { result } = await present([withLongest('BriefTitle', cases[0]!.value, 'NCT1')]);
      expect(result.fieldStats[0]!.longest!.value).toBe(cases[0]!.value);
    });
  });

  /**
   * Each topValues entry starts a content[] line, so a value such as
   * "# fallopian tubes" or ">=65 years" would render as a heading or a
   * blockquote. Proven by parsing content[] with a CommonMark parser: the reader
   * must see every value exactly, inside plain paragraphs.
   */
  describe('topValues render inertly in content[]', () => {
    /** Values that would otherwise open a block or inline construct. */
    const structural = [
      '# fallopian tubes',
      '###### six hashes',
      '+ 33',
      '- dash item',
      '* star item',
      '>=65 years',
      '> quoted',
      '1. Publication',
      '1) Paren',
      '===',
      '---',
      '***',
      '~~~ tilde fence',
      '``` backtick fence',
      '<div>block html</div>',
      'nanogram*hour per milliliter (ng*hr/mL)',
      '*opens here',
      'closes here*',
      '_opens here',
      'closes here_',
      'one `tick',
      'another tick` here',
      '[label](https://example.org)',
      'AT&amp;T',
      'trailing backslash\\',
    ];
    /** Values that render as written — nothing in them is escaped. */
    const plain = [
      '#no-space',
      '<=18 years',
      '< 65 years',
      'cdrh_docs',
      'SMPH\\MEDICINE\\HEM-ONC',
      '5 * 3',
      'Johnson & Johnson',
      '1.5 mg',
      '[18F]FDG',
      'CT-case | nodule',
    ];
    /** Values a single line cannot carry exactly: line breaks, leading whitespace. */
    const blockValues = [
      'first line\n# second line',
      'heading\r\n===',
      'setext\r---',
      '  leading spaces',
      'fence inside\n````',
    ];
    // Each block value is followed by a line that would open a list or heading
    // where a fresh paragraph starts — which it does, right after a fence.
    const ordered = [
      blockValues[0]!,
      '2. after a fence',
      blockValues[1]!,
      '- after a fence',
      blockValues[2]!,
      '3) after a fence',
      blockValues[3]!,
      '## after a fence',
      blockValues[4]!,
      ...structural,
      ...plain,
    ];
    const topValues = ordered.map((value, i) => ({ value, studiesCount: i + 1 }));
    const countOf = (value: string) => ordered.indexOf(value) + 1;
    const stat = {
      field: 'protocolSection.someModule.Keyword',
      piece: 'Keyword',
      type: 'STRING',
      uniqueValuesCount: topValues.length,
      topValues,
    };

    it('renders every topValues entry inside plain paragraphs, with no markup of its own', async () => {
      const { text } = await present([stat]);
      const { blocks, markup } = read(text);
      expect(blocks).toEqual(['fence', 'paragraph_open']);
      expect(markup).toEqual([]);
    });

    it.each([
      ...structural,
      ...plain,
      '2. after a fence',
      '- after a fence',
      '3) after a fence',
      '## after a fence',
    ])('shows %j to the reader exactly, once', async (value) => {
      const { text } = await present([stat]);
      const line = `${value}: ${countOf(value)} studies`;
      expect(read(text).lines.filter((l) => l === line)).toHaveLength(1);
    });

    it.each(blockValues)('shows %j exactly in its own fenced block', async (value) => {
      const { text } = await present([stat]);
      const { lines, fences } = read(text);
      // CommonMark reads CR, LF, and CRLF alike as line endings.
      expect(fences).toContain(`${value.replace(/\r\n?/g, '\n')}\n`);
      expect(lines).toContain(`value (${countOf(value)} studies):`);
    });

    it.each(plain)('writes %j with no escape characters', async (value) => {
      const { text } = await present([stat]);
      expect(text.split('\n')).toContain(`  ${value}: ${countOf(value)} studies`);
    });

    it('keeps every value verbatim in structuredContent', async () => {
      const { result } = await present([stat]);
      expect(result.fieldStats[0]!.topValues).toEqual(topValues);
    });
  });

  /**
   * The provider reports uniqueValuesCount: 0 for free-text fields it does not
   * count distinct values on — DetailedDescription is filled in ~400k studies.
   * A recorded longest value proves values exist, so the 0 is flagged
   * uniqueValuesCounted: false and passed through; a field with no values at
   * all reports no longest and gets no flag (#165).
   */
  describe('uncounted distinct values (#165)', () => {
    it('flags a free-text field as uncounted on both surfaces, keeping the provider 0', async () => {
      const { result, text } = await present([
        withLongest('DetailedDescription', 'Some description.', 'NCT06708767', {
          missingStudiesCount: 200_268,
        }),
      ]);
      const stat = result.fieldStats[0]!;

      expect(stat.uniqueValuesCount).toBe(0);
      expect(stat.uniqueValuesCounted).toBe(false);
      expect(text).toContain(
        '**DetailedDescription** — protocolSection.someModule.DetailedDescription (STRING, distinct values not counted):',
      );
      expect(text).not.toContain('0 unique values');
    });

    it('renders the uncounted header from the flag', () => {
      const text = (
        getFieldValues.format!({
          fieldStats: [
            {
              field: 'protocolSection.descriptionModule.detailedDescription',
              piece: 'DetailedDescription',
              type: 'STRING',
              missingStudiesCount: 200_268,
              uniqueValuesCount: 0,
              uniqueValuesCounted: false,
              longest: { value: 'Some description.', length: 17, nctId: 'NCT06708767' },
            },
          ],
        })[0] as { text: string }
      ).text;

      expect(text).toContain('(STRING, distinct values not counted):');
      expect(text).not.toContain('0 unique values');
    });

    it('keeps a true zero — no values recorded anywhere — as 0 unique values', async () => {
      const { result, text } = await present([
        {
          field: 'derivedSection.conditionBrowseModule.leaves.name',
          piece: 'ConditionBrowseLeafName',
          type: 'STRING',
          missingStudiesCount: 608_228,
          uniqueValuesCount: 0,
        },
      ]);

      expect(result.fieldStats[0]!.uniqueValuesCount).toBe(0);
      expect('uniqueValuesCounted' in result.fieldStats[0]!).toBe(false);
      expect(text).toContain('(STRING, 0 unique values):');
      expect(text).toContain('No recorded values for this field.');
    });

    it('keeps a counted STRING field with a longest value as counted', async () => {
      const { result, text } = await present([
        withLongest('ViolationEventDescription', 'Late report.', 'NCT00000004', {
          uniqueValuesCount: 5,
          topValues: [{ value: 'Late report.', studiesCount: 2 }],
        }),
      ]);

      expect(result.fieldStats[0]!.uniqueValuesCount).toBe(5);
      expect('uniqueValuesCounted' in result.fieldStats[0]!).toBe(false);
      expect(text).toContain('(STRING, 5 unique values):');
    });
  });
});
