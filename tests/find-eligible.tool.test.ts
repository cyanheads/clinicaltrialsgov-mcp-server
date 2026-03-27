/**
 * @fileoverview Tests for clinicaltrials_find_eligible tool.
 * @module tests/find-eligible.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/clinical-trials/clinical-trials-service.js', () => ({
  getClinicalTrialsService: vi.fn(),
}));

import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

const baseInput = {
  age: 30,
  sex: 'All' as const,
  conditions: ['Type 2 Diabetes'],
  location: { country: 'United States', state: 'Washington', city: 'Seattle' },
};

describe('findEligible', () => {
  const mockService = { searchStudies: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClinicalTrialsService).mockReturnValue(mockService as never);
  });

  describe('input validation', () => {
    it('requires at least one condition', () => {
      expect(() => findEligible.input.parse({ ...baseInput, conditions: [] })).toThrow();
    });

    it('rejects age outside 0-120', () => {
      expect(() => findEligible.input.parse({ ...baseInput, age: -1 })).toThrow();
      expect(() => findEligible.input.parse({ ...baseInput, age: 121 })).toThrow();
    });

    it('rejects invalid sex', () => {
      expect(() => findEligible.input.parse({ ...baseInput, sex: 'Other' })).toThrow();
    });

    it('applies defaults for recruitingOnly and maxResults', () => {
      const input = findEligible.input.parse(baseInput);
      expect(input.recruitingOnly).toBe(true);
      expect(input.maxResults).toBe(10);
    });
  });

  describe('handler', () => {
    it('returns studies from the API', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.studies).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });

    it('builds condition query with quoting and OR', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input.parse({ ...baseInput, conditions: ['Type 2 Diabetes', 'Hypertension'] }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryCond: '"Type 2 Diabetes" OR Hypertension' }),
        ctx,
      );
    });

    it('builds location query from city, state, country', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ queryLocn: 'Seattle, Washington, United States' }),
        ctx,
      );
    });

    it('builds status filter when recruitingOnly is true', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({
          filterOverallStatus: ['RECRUITING', 'NOT_YET_RECRUITING'],
        }),
        ctx,
      );
    });

    it('omits status filter when recruitingOnly is false', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input.parse({ ...baseInput, recruitingOnly: false }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ filterOverallStatus: undefined }),
        ctx,
      );
    });

    it('includes sex filter in advancedFilter when sex is not All', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input.parse({ ...baseInput, sex: 'Female' }), ctx);

      const call = mockService.searchStudies.mock.calls[0][0];
      expect(call.filterAdvanced).toContain('AREA[Sex]ALL OR AREA[Sex]FEMALE');
    });

    it('includes healthy volunteer filter when set', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input.parse({ ...baseInput, healthyVolunteer: true }),
        ctx,
      );

      const call = mockService.searchStudies.mock.calls[0][0];
      expect(call.filterAdvanced).toContain('AREA[HealthyVolunteers]true');
    });

    it('includes age range filters in advancedFilter', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0][0];
      expect(call.filterAdvanced).toContain('AREA[MinimumAge]RANGE[MIN, 30 years]');
      expect(call.filterAdvanced).toContain('AREA[MaximumAge]RANGE[30 years, MAX]');
    });

    it('uses maxResults as pageSize', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(
        findEligible.input.parse({ ...baseInput, maxResults: 25 }),
        ctx,
      );

      expect(mockService.searchStudies).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 25 }),
        ctx,
      );
    });

    it('requests the eligibility field set', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      const call = mockService.searchStudies.mock.calls[0][0];
      expect(call.fields).toContain('NCTId');
      expect(call.fields).toContain('MinimumAge');
      expect(call.fields).toContain('LocationCity');
      expect(call.fields).toContain('HealthyVolunteers');
    });

    it('echoes search criteria in output', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.searchCriteria).toEqual({
        conditions: ['Type 2 Diabetes'],
        location: 'Seattle, Washington, United States',
        age: 30,
        sex: 'All',
      });
    });

    it('provides noMatchHints when no studies found', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.noMatchHints).toBeDefined();
      expect(result.noMatchHints!.length).toBeGreaterThan(0);
    });

    it('hints about extreme age', async () => {
      mockService.searchStudies.mockResolvedValue({ studies: [], totalCount: 0 });
      const ctx = createMockContext();
      const result = await findEligible.handler(
        findEligible.input.parse({ ...baseInput, age: 120 }),
        ctx,
      );

      expect(result.noMatchHints!.some((h: string) => h.includes('extreme'))).toBe(true);
    });

    it('omits noMatchHints when studies are found', async () => {
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockService.searchStudies.mockResolvedValue({ studies: [study], totalCount: 1 });

      const ctx = createMockContext();
      const result = await findEligible.handler(findEligible.input.parse(baseInput), ctx);

      expect(result.noMatchHints).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders study list', () => {
      const blocks = findEligible.format!({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test Study' },
              statusModule: { overallStatus: 'RECRUITING' },
            },
          },
        ],
        totalCount: 1,
        searchCriteria: { conditions: ['Diabetes'], location: 'US', age: 30, sex: 'All' },
      });
      expect(blocks[0].text).toContain('Found 1 eligible studies');
      expect(blocks[0].text).toContain('NCT12345678');
      expect(blocks[0].text).toContain('RECRUITING');
    });

    it('renders no-match hints', () => {
      const blocks = findEligible.format!({
        studies: [],
        totalCount: 0,
        searchCriteria: { conditions: ['Rare'], location: 'US', age: 30, sex: 'All' },
        noMatchHints: ['No studies found', 'Try broader terms'],
      });
      expect(blocks[0].text).toContain('No eligible studies found');
      expect(blocks[0].text).toContain('No studies found');
      expect(blocks[0].text).toContain('Try broader terms');
    });

    it('shows total when more results exist', () => {
      const blocks = findEligible.format!({
        studies: [
          { protocolSection: { identificationModule: { nctId: 'NCT00000001', briefTitle: 'A' } } },
        ],
        totalCount: 50,
        searchCriteria: { conditions: ['X'], location: 'US', age: 30, sex: 'All' },
      });
      expect(blocks[0].text).toContain('50 eligible studies (showing 1)');
    });
  });
});
