/**
 * @fileoverview Security tests for tool inputs: injection, oversized inputs,
 * no-secret-leaks, and path traversal prevention.
 * @module tests/mcp-server/tools/security
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock service — hoisted so vi.mock can close over it
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Assert that no string in `output` contains a known secret pattern.
 * The test server has no real secrets — asserts env-var names aren't leaked.
 */
function assertNoSecretLeak(output: unknown) {
  const text = JSON.stringify(output);
  // No env var names that could carry credentials should appear in output
  expect(text).not.toMatch(/CT_API_BASE_URL|CT_REQUEST_TIMEOUT_MS|CT_MAX_PAGE_SIZE/);
  // No process.env patterns
  expect(text).not.toContain('process.env');
}

// ---------------------------------------------------------------------------
// Injection payloads
// ---------------------------------------------------------------------------

const INJECTION_PAYLOADS = [
  // SQL/query injection
  "'; DROP TABLE studies; --",
  "1' OR '1'='1",
  "' UNION SELECT * FROM studies --",
  // URL/path traversal
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  // Prototype pollution
  '__proto__',
  'constructor.prototype',
  '[object Object]',
  // Script injection
  '<script>alert(1)</script>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional injection payload test
  '${7*7}',
  '{{7*7}}',
  // Null bytes
  'normal\x00injection',
  // Unicode normalization attack
  '‮anormaltext',
];

const OVERSIZED_INPUTS = {
  string1k: 'A'.repeat(1_000),
  string10k: 'B'.repeat(10_000),
  string100k: 'C'.repeat(100_000),
};

// ---------------------------------------------------------------------------
// searchStudies — input validation security
// ---------------------------------------------------------------------------

describe('searchStudies — injection and oversized inputs', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
  });

  it.each(
    INJECTION_PAYLOADS,
  )('query field passes injection payload %s to the service (Zod does not sanitize strings)', async (payload) => {
    // Zod does not strip or reject arbitrary strings in free-text fields.
    // The important invariant is no crash and no prototype pollution.
    const ctx = createMockContext();
    const input = searchStudies.input!.parse({ query: payload });
    await expect(searchStudies.handler(input, ctx)).resolves.toBeDefined();
  });

  it('rejects NCT ID injection that does not match NCTxxxxxxxx format', () => {
    expect(() => searchStudies.input!.parse({ nctIds: "'; DROP TABLE --" })).toThrow();
  });

  it('rejects NCT ID array containing injection payload', () => {
    expect(() => searchStudies.input!.parse({ nctIds: ['NCT12345678', "' OR 1=1 --"] })).toThrow();
  });

  it('oversized query string — handler does not crash', async () => {
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    const ctx = createMockContext();
    const input = searchStudies.input!.parse({ query: OVERSIZED_INPUTS.string1k });
    await expect(searchStudies.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    mockService.searchStudies.mockResolvedValue({
      studies: [{ nctId: 'NCT12345678' }],
      totalCount: 1,
    });
    const ctx = createMockContext();
    const result = await searchStudies.handler(searchStudies.input!.parse({}), ctx);
    assertNoSecretLeak(result);
  });
});

// ---------------------------------------------------------------------------
// getStudy — NCT ID injection and output safety
// ---------------------------------------------------------------------------

describe('getStudy — injection and output safety', () => {
  const mockService = { getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
  });

  it.each([
    "'; DROP TABLE studies; --",
    '../../../etc/passwd',
    '%2e%2e%2fNCT12345678',
    'NCT1234567A', // invalid — too short + non-numeric
  ])('rejects invalid NCT ID pattern: %s', (payload) => {
    expect(() => getStudy.input!.parse({ nctId: payload })).toThrow();
  });

  it('format output does not leak env var names', async () => {
    mockService.getStudy.mockResolvedValue({
      protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test' } },
    });
    const ctx = createMockContext();
    const result = await getStudy.handler(getStudy.input!.parse({ nctId: 'NCT12345678' }), ctx);
    assertNoSecretLeak(result);
    const formatted = getStudy.format!(result);
    assertNoSecretLeak(formatted);
  });
});

// ---------------------------------------------------------------------------
// getStudyCount — injection and output safety
// ---------------------------------------------------------------------------

describe('getStudyCount — injection and output safety', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 42 });
  });

  it.each(
    INJECTION_PAYLOADS,
  )('accepts free-text payload %s without crashing (no validation on plain strings)', async (payload) => {
    const ctx = createMockContext();
    const input = getStudyCount.input!.parse({ conditionQuery: payload });
    await expect(getStudyCount.handler(input, ctx)).resolves.toBeDefined();
  });

  it('oversized conditionQuery does not crash', async () => {
    const ctx = createMockContext();
    const input = getStudyCount.input!.parse({ conditionQuery: OVERSIZED_INPUTS.string1k });
    await expect(getStudyCount.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    const ctx = createMockContext();
    const result = await getStudyCount.handler(getStudyCount.input!.parse({}), ctx);
    assertNoSecretLeak(result);
  });
});

// ---------------------------------------------------------------------------
// getStudyResults — injection and output safety
// ---------------------------------------------------------------------------

describe('getStudyResults — injection and output safety', () => {
  const mockService = { getStudiesBatch: vi.fn(), getStudy: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getStudiesBatch.mockResolvedValue([]);
  });

  it.each([
    "'; DROP TABLE --",
    '../../../etc/passwd',
    '__proto__',
  ])('rejects injection payload %s as NCT ID', (payload) => {
    expect(() => getStudyResults.input!.parse({ nctIds: payload })).toThrow();
  });

  it('format output does not leak env var names', () => {
    const formatted = getStudyResults.format!({
      results: [{ nctId: 'NCT12345678', title: 'Test', hasResults: false }],
    });
    assertNoSecretLeak(formatted);
  });

  it('rejects array exceeding 20 NCT IDs', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `NCT${String(i).padStart(8, '0')}`);
    expect(() => getStudyResults.input!.parse({ nctIds: ids })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getFieldValues — injection and output safety
// ---------------------------------------------------------------------------

describe('getFieldValues — injection and output safety', () => {
  const mockService = { getFieldValues: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getFieldValues.mockResolvedValue([]);
  });

  it.each(
    INJECTION_PAYLOADS,
  )('passes injection payload %s as field name string to service (no crash)', async (payload) => {
    const ctx = createMockContext();
    // Zod accepts any string for field names — the API rejects invalid ones
    const input = getFieldValues.input!.parse({ fields: payload });
    await expect(getFieldValues.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    mockService.getFieldValues.mockResolvedValue([
      { field: 'OverallStatus', piece: 'OverallStatus', type: 'ENUM', topValues: [] },
    ]);
    const ctx = createMockContext();
    const result = await getFieldValues.handler(
      getFieldValues.input!.parse({ fields: 'OverallStatus' }),
      ctx,
    );
    assertNoSecretLeak(result);
  });
});

// ---------------------------------------------------------------------------
// getFieldDefinitions — path traversal and injection
// ---------------------------------------------------------------------------

describe('getFieldDefinitions — path traversal and injection', () => {
  const mockService = { getMetadata: vi.fn(), searchFieldDefinitions: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.getMetadata.mockResolvedValue([]);
    mockService.searchFieldDefinitions.mockResolvedValue([]);
  });

  it.each([
    '../../../etc/passwd',
    '..\\windows\\system32',
    '%2e%2e%2f',
  ])('drill mode with path traversal payload "%s" throws (path not found) and does not crash', async (payload) => {
    const ctx = createMockContext({ errors: getFieldDefinitions.errors });
    const input = getFieldDefinitions.input!.parse({ mode: 'drill', path: payload });
    // Handler should throw "path not found" since no such node exists — not a crash
    await expect(getFieldDefinitions.handler(input, ctx)).rejects.toThrow();
  });

  it.each(
    INJECTION_PAYLOADS,
  )('search mode passes injection payload %s to searchFieldDefinitions without crash', async (payload) => {
    const ctx = createMockContext({ errors: getFieldDefinitions.errors });
    const input = getFieldDefinitions.input!.parse({ mode: 'search', query: payload });
    await expect(getFieldDefinitions.handler(input, ctx)).resolves.toBeDefined();
  });

  it('format output does not leak env var names', async () => {
    const ctx = createMockContext();
    const result = await getFieldDefinitions.handler(
      getFieldDefinitions.input!.parse({ mode: 'overview' }),
      ctx,
    );
    assertNoSecretLeak(result);
    const formatted = getFieldDefinitions.format!(result);
    assertNoSecretLeak(formatted);
  });
});

// ---------------------------------------------------------------------------
// findEligible — injection and output safety
// ---------------------------------------------------------------------------

describe('findEligible — injection and output safety', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetService.mockReturnValue(mockService as never);
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
  });

  const baseInput = {
    age: 30,
    sex: 'ALL' as const,
    conditions: ['Diabetes'],
    location: { country: 'United States' },
  };

  it.each(INJECTION_PAYLOADS)('condition payload %s passes without crash', async (payload) => {
    const ctx = createMockContext();
    const input = findEligible.input!.parse({
      ...baseInput,
      conditions: [payload],
    });
    await expect(findEligible.handler(input, ctx)).resolves.toBeDefined();
  });

  it('rejects empty conditions array', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, conditions: [] })).toThrow();
  });

  it('rejects age below 0', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, age: -1 })).toThrow();
  });

  it('rejects age above 120', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, age: 999 })).toThrow();
  });

  it('rejects invalid sex values', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, sex: 'UNKNOWN' as never })).toThrow();
  });

  it('rejects maxResults above 50', () => {
    expect(() => findEligible.input!.parse({ ...baseInput, maxResults: 51 })).toThrow();
  });

  it('location city injection payload does not crash handler', async () => {
    const ctx = createMockContext();
    const input = findEligible.input!.parse({
      ...baseInput,
      location: { country: 'United States', city: "'; DROP TABLE --" },
    });
    await expect(findEligible.handler(input, ctx)).resolves.toBeDefined();
  });

  it('output does not contain env var names', async () => {
    const ctx = createMockContext();
    const result = await findEligible.handler(findEligible.input!.parse(baseInput), ctx);
    assertNoSecretLeak(result);
  });

  it('format output does not contain env var names', () => {
    const formatted = findEligible.format!({ studies: [], totalCount: 0 });
    assertNoSecretLeak(formatted);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: format() output never leaks env vars
// ---------------------------------------------------------------------------

describe('format() outputs — no environment variable leaks', () => {
  it('searchStudies.format never leaks env var names', () => {
    const output = searchStudies.format!({ studies: [] });
    assertNoSecretLeak(output);
  });

  it('getStudyCount.format never leaks env var names', () => {
    const output = getStudyCount.format!({ totalCount: 0 });
    assertNoSecretLeak(output);
  });

  it('getStudyResults.format never leaks env var names', () => {
    const output = getStudyResults.format!({ results: [] });
    assertNoSecretLeak(output);
  });

  it('getFieldValues.format never leaks env var names', () => {
    const output = getFieldValues.format!({ fieldStats: [] });
    assertNoSecretLeak(output);
  });

  it('getFieldDefinitions.format never leaks env var names', () => {
    const output = getFieldDefinitions.format!({ fields: [], totalFields: 0 });
    assertNoSecretLeak(output);
  });

  it('findEligible.format never leaks env var names', () => {
    const output = findEligible.format!({ studies: [], totalCount: 0 });
    assertNoSecretLeak(output);
  });
});
