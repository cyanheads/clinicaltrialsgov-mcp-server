/**
 * @fileoverview Framework-pipeline contract suite for every tool definition.
 * The per-tool suites elsewhere call `handler` and `format` directly; this file
 * drives each definition through `runToolContract` — input parse, handler,
 * output-schema parse, format, enrichment merge — and asserts the two surfaces
 * that direct calls never reach: structured output validated against the
 * declared `output` schema, and the dual-surface error envelope a thrown
 * `McpError` becomes on the wire (`isError`, `structuredContent.error.code`,
 * `.data.reason`, and the `Recovery:` line mirrored into `content[]`).
 * @module tests/mcp-server/tools/tool-contract
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract, toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStudyFixture } from '../../helpers/format-parity.js';

const { mockGetService } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
}));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';
import { getFieldDefinitions } from '@/mcp-server/tools/definitions/get-field-definitions.tool.js';
import { getFieldValues } from '@/mcp-server/tools/definitions/get-field-values.tool.js';
import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';
import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';

/**
 * Verbatim ClinicalTrials.gov records — a completed study carrying every
 * results module and a recruiting one carrying none. Real payloads keep the
 * success cases from asserting an empty shape past a stub.
 */
const completedStudy = loadStudyFixture('nct03722472');
const recruitingStudy = loadStudyFixture('nct06323538');

const metadata: FieldNode[] = [
  {
    name: 'protocolSection',
    piece: 'ProtocolSection',
    type: 'OBJECT',
    children: [
      {
        name: 'identificationModule',
        piece: 'IdentificationModule',
        type: 'OBJECT',
        children: [
          {
            name: 'nctId',
            piece: 'NCTId',
            type: 'STRING',
            description: 'The NCT identifier for the study.',
          },
        ],
      },
      {
        name: 'designModule',
        piece: 'DesignModule',
        type: 'OBJECT',
        children: [
          {
            name: 'enrollmentInfo',
            piece: 'EnrollmentCount',
            type: 'INTEGER',
            description: 'Number of participants enrolled in the study.',
          },
        ],
      },
    ],
  },
];

const mockService = {
  getFieldValues: vi.fn(),
  getMetadata: vi.fn(),
  getStudiesBatch: vi.fn(),
  getStudy: vi.fn(),
  searchFieldDefinitions: vi.fn(),
  searchStudies: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetService.mockReturnValue(mockService as never);
  mockService.searchStudies.mockResolvedValue({
    studies: [recruitingStudy],
    totalCount: 1,
  });
  mockService.getStudy.mockResolvedValue(completedStudy);
  mockService.getStudiesBatch.mockResolvedValue([completedStudy]);
  mockService.getMetadata.mockResolvedValue(metadata);
  mockService.searchFieldDefinitions.mockResolvedValue({
    entries: [
      {
        piece: 'EnrollmentCount',
        path: 'protocolSection.designModule.enrollmentInfo',
        name: 'enrollmentInfo',
        type: 'INTEGER',
        description: 'Number of participants enrolled in the study.',
      },
    ],
    total: 1,
  });
  mockService.getFieldValues.mockResolvedValue([
    {
      field: 'protocolSection.statusModule.overallStatus',
      piece: 'OverallStatus',
      type: 'ENUM',
      uniqueValuesCount: 2,
      topValues: [
        { value: 'COMPLETED', studiesCount: 200_000 },
        { value: 'RECRUITING', studiesCount: 60_000 },
      ],
    },
  ]);
});

const eligibleInput = {
  age: 55,
  sex: 'ALL' as const,
  conditions: ['Type 2 Diabetes'],
  location: { country: 'United States', state: 'Washington', city: 'Seattle' },
};

toolContractSuite(searchStudies, {
  success: [
    {
      name: 'returns a bounded study index for a condition query',
      input: { conditionQuery: 'diabetes', pageSize: 5 },
      expected: { totalCount: 1 },
    },
    {
      name: 'echoes the caller field selection when fields are named',
      input: { conditionQuery: 'diabetes', fields: ['NCTId', 'BriefTitle'] },
      expected: { requestedFields: ['NCTId', 'BriefTitle'] },
    },
  ],
  errors: [
    {
      name: 'rejects a whitespace-only query',
      input: { conditionQuery: '   ' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'blank_value',
    },
    {
      name: 'rejects a fields list carrying a blank entry',
      input: { conditionQuery: 'diabetes', fields: ['NCTId', ' '] },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'blank_value',
    },
  ],
});

toolContractSuite(getStudy, {
  success: [
    {
      name: 'returns a single study record by NCT ID',
      input: { nctId: 'NCT03722472' },
      async assert(result) {
        const structured = result.structuredContent as { study: Record<string, unknown> };
        expect(structured.study).toBeDefined();
        expect(JSON.stringify(result.content)).toContain('NCT03722472');
      },
    },
  ],
});

toolContractSuite(getStudyResults, {
  success: [
    {
      name: 'returns outcome and adverse-event sections for a completed study',
      input: { nctIds: 'NCT03722472' },
      async assert(result) {
        const structured = result.structuredContent as {
          results: { hasResults: boolean; nctId: string }[];
        };
        expect(structured.results).toHaveLength(1);
        expect(structured.results[0]?.nctId).toBe('NCT03722472');
        expect(structured.results[0]?.hasResults).toBe(true);
      },
    },
  ],
  errors: [
    {
      name: 'rejects an empty nctIds list',
      input: { nctIds: [] },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'blank_value',
    },
  ],
});

toolContractSuite(getFieldValues, {
  success: [
    {
      name: 'returns enum value statistics for a single field',
      input: { fields: 'OverallStatus' },
      async assert(result) {
        const structured = result.structuredContent as {
          fieldStats: { piece: string; topValues?: { value: string }[] }[];
        };
        expect(structured.fieldStats[0]?.piece).toBe('OverallStatus');
        expect(JSON.stringify(result.content)).toContain('COMPLETED');
      },
    },
  ],
  errors: [
    {
      name: 'rejects an empty fields list',
      input: { fields: [] },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'blank_value',
    },
  ],
});

toolContractSuite(getFieldDefinitions, {
  success: [
    {
      name: 'lists the top-level sections in overview mode',
      input: { mode: 'overview' as const },
      async assert(result) {
        const structured = result.structuredContent as { totalFields: number };
        expect(structured.totalFields).toBeGreaterThan(0);
      },
    },
    {
      name: 'ranks keyword matches in search mode',
      input: { mode: 'search' as const, query: 'enrollment', limit: 5 },
      async assert(result) {
        expect(JSON.stringify(result.content)).toContain('EnrollmentCount');
      },
    },
  ],
  errors: [
    {
      name: 'reports an unresolvable drill path',
      input: { mode: 'drill' as const, path: 'protocolSection.noSuchModule' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'path_not_found',
    },
  ],
});

toolContractSuite(getStudyCount, {
  success: [
    {
      name: 'returns the match count without fetching studies',
      input: { conditionQuery: 'diabetes' },
      expected: { totalCount: 1 },
    },
  ],
  errors: [
    {
      name: 'rejects a whitespace-only advanced filter',
      input: { advancedFilter: ' ' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'blank_value',
    },
  ],
});

toolContractSuite(findEligible, {
  success: [
    {
      name: 'matches a patient profile to recruiting trials',
      input: eligibleInput,
      async assert(result) {
        const structured = result.structuredContent as { studies: unknown[] };
        expect(Array.isArray(structured.studies)).toBe(true);
      },
    },
  ],
  errors: [
    {
      name: 'rejects an empty conditions list',
      input: { ...eligibleInput, conditions: [] },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'blank_value',
    },
    {
      name: 'rejects a blank location country',
      input: { ...eligibleInput, location: { country: '  ' } },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'blank_value',
    },
  ],
});

/**
 * The recovery hint is mirrored into `content[]` as a `Recovery:` line, so it is
 * the guidance a `content[]`-only client actually reads. #113: every parameter
 * below is required, and following an "omit it" lead would return the bare
 * -32602 the typed contract exists to replace.
 */
describe('blank_value recovery on the wire (#113)', () => {
  /** Each case invokes its own definition, so the input stays typed against it. */
  const cases = [
    { name: 'fields', run: () => runToolContract(getFieldValues, { fields: [] }) },
    { name: 'nctIds', run: () => runToolContract(getStudyResults, { nctIds: [] }) },
    {
      name: 'conditions',
      run: () => runToolContract(findEligible, { ...eligibleInput, conditions: [] }),
    },
    {
      name: 'location.country',
      run: () => runToolContract(findEligible, { ...eligibleInput, location: { country: '  ' } }),
    },
  ];

  it.each(cases)(
    'leads the $name recovery with supplying a value, not omitting it',
    async ({ name, run }) => {
      const result = await run();
      const text = (result.content as { text: string }[])[0]!.text;

      expect(result.isError).toBe(true);
      expect(text).toContain(`Parameter '${name}' was supplied with a blank value`);
      expect(text).toContain('Recovery: Supply a value containing non-whitespace');
      expect(text.indexOf('Recovery: Supply')).toBeLessThan(text.indexOf('omit it entirely'));

      const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;
      expect(error.data.reason).toBe('blank_value');
      expect(error.data.param).toBe(name);
    },
  );
});

/**
 * Root-level tool inputs are strict: `tool()` stores `input` with `.strict()`
 * and advertises `additionalProperties: false`, so an undeclared argument key
 * is rejected by name rather than silently stripped. Stripping turned a
 * caller's typo into a wrong answer they could not detect — the misspelled
 * value vanished before the handler ran and the call failed downstream
 * pointing at the wrong parameter.
 */
describe('strict tool inputs', () => {
  const cases = [
    { name: 'searchStudies', schema: searchStudies.input, valid: { conditionQuery: 'diabetes' } },
    { name: 'getStudy', schema: getStudy.input, valid: { nctId: 'NCT03722472' } },
    { name: 'getStudyResults', schema: getStudyResults.input, valid: { nctIds: 'NCT03722472' } },
    { name: 'getFieldValues', schema: getFieldValues.input, valid: { fields: 'OverallStatus' } },
    { name: 'getFieldDefinitions', schema: getFieldDefinitions.input, valid: { mode: 'overview' } },
    { name: 'getStudyCount', schema: getStudyCount.input, valid: { conditionQuery: 'diabetes' } },
    { name: 'findEligible', schema: findEligible.input, valid: eligibleInput },
  ];

  it.each(cases)('$name rejects an undeclared root key by name', ({ schema, valid }) => {
    const result = schema.safeParse({ ...valid, querry: 'typo' });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['querry'] }),
    );
  });

  it.each(cases)('$name accepts the same input without the stray key', ({ schema, valid }) => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  /**
   * Strictness is root-level only, so the nested option bags are marked
   * `.strict()` in their own right. Both carry a plausible near-miss key whose
   * silent removal would produce a confidently wrong result: a `zipCode` on a
   * patient location widens the match set to the whole country, and a
   * `radiusKm` on `nearLocation` falls back to the 50-mile default.
   */
  it('findEligible rejects an undeclared key inside location', () => {
    const result = findEligible.input.safeParse({
      ...eligibleInput,
      location: { country: 'United States', zipCode: '98101' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['zipCode'],
        path: ['location'],
      }),
    );
  });

  it('getStudy rejects an undeclared key inside nearLocation', () => {
    const result = getStudy.input.safeParse({
      nctId: 'NCT03722472',
      nearLocation: { lat: 47.6, lon: -122.3, radiusKm: 80 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['radiusKm'],
        path: ['nearLocation'],
      }),
    );
  });
});
