/**
 * @fileoverview Fuzz tests for clinicaltrials_find_eligible tool.
 * @module tests/mcp-server/tools/definitions/find-eligible.fuzz
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({ mockGetService: vi.fn() }));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';

describe('findEligible fuzz', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    // Handler issues three concurrent searchStudies calls (main + two funnel
    // stages). Empty result is valid for all three — exercises the
    // no-match-hints branch without further mock divergence.
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    mockGetService.mockReturnValue(mockService as never);
  });

  it('survives valid + adversarial inputs without crashes, leaks, or prototype pollution', async () => {
    const report = await fuzzTool(findEligible, {
      numRuns: 50,
      numAdversarial: 30,
      seed: 7,
      ctx: { errors: findEligible.errors },
    });
    const programmerCrashes = report.crashes.filter((c) => !(c.error instanceof McpError));
    expect(programmerCrashes).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.prototypePollution).toBe(false);
    expect(report.totalRuns).toBeGreaterThan(0);
  }, 30_000);
});
