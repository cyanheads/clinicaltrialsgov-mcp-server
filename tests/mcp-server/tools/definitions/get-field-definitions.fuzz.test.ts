/**
 * @fileoverview Fuzz tests for clinicaltrials_get_field_definitions tool.
 * @module tests/mcp-server/tools/definitions/get-field-definitions.fuzz
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetService } = vi.hoisted(() => ({ mockGetService: vi.fn() }));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: mockGetService,
}));

import { getFieldDefinitions } from '@/mcp-server/tools/definitions/get-field-definitions.tool.js';

describe('getFieldDefinitions fuzz', () => {
  const mockService = {
    getMetadata: vi.fn(),
    searchFieldDefinitions: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Empty tree + empty index covers all three handler modes (query, path,
    // overview). Path mode raises a declared `path_not_found` ctx.fail when
    // no node matches — that's a graceful contract throw, not a crash.
    mockService.getMetadata.mockResolvedValue([]);
    mockService.searchFieldDefinitions.mockResolvedValue({ entries: [], total: 0 });
    mockGetService.mockReturnValue(mockService as never);
  });

  it('survives valid + adversarial inputs without crashes, leaks, or prototype pollution', async () => {
    const report = await fuzzTool(getFieldDefinitions, {
      numRuns: 50,
      numAdversarial: 30,
      seed: 13,
      ctx: { errors: getFieldDefinitions.errors },
    });
    expect(report.crashes).toEqual([]);
    expect(report.leaks).toEqual([]);
    expect(report.prototypePollution).toBe(false);
    expect(report.totalRuns).toBeGreaterThan(0);
  }, 30_000);
});
