/**
 * @fileoverview Fuzz tests for clinicaltrials_search_studies tool.
 * @module tests/mcp-server/tools/definitions/search-studies.fuzz
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({ mockGetService: vi.fn() }));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';

describe('searchStudies fuzz', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    mockGetService.mockReturnValue(mockService as never);
  });

  it('survives valid + adversarial inputs without crashes, leaks, or prototype pollution', async () => {
    const report = await fuzzTool(searchStudies, {
      numRuns: 50,
      numAdversarial: 30,
      seed: 42,
      ctx: { errors: searchStudies.errors },
    });
    // McpError instances are intentional contract throws (validationError,
    // notFound, etc.). Only programmer errors qualify as real crashes.
    const programmerCrashes = report.crashes.filter((c) => !(c.error instanceof McpError));
    expect(programmerCrashes).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.prototypePollution).toBe(false);
    expect(report.totalRuns).toBeGreaterThan(0);
  }, 30_000);
});
