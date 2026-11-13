/**
 * @fileoverview Fuzz tests for clinicaltrials_search_studies tool.
 * @module tests/mcp-server/tools/definitions/search-studies.fuzz
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({ mockGetService: vi.fn() }));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import { areaIndex } from '../../../helpers/area-metadata.js';

describe('searchStudies fuzz', () => {
  const mockService = {
    classifyProjection: vi.fn(),
    getAreaIndex: vi.fn(),
    searchStudies: vi.fn(),
    maxPageSize: 200,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockService.classifyProjection.mockResolvedValue('other');
    mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
    // A real AREA index, so any generated text naming an AREA[] field runs the rewrite (#170).
    mockService.getAreaIndex.mockResolvedValue(areaIndex());
    mockGetService.mockReturnValue(mockService as never);
  });

  it('survives valid + adversarial inputs without crashes, leaks, or prototype pollution', async () => {
    const report = await fuzzTool(searchStudies, {
      numRuns: 50,
      numAdversarial: 30,
      seed: 42,
      ctx: { errors: searchStudies.errors },
    });
    expect(report.crashes).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.prototypePollution).toBe(false);
    expect(report.totalRuns).toBeGreaterThan(0);
  }, 30_000);
});
