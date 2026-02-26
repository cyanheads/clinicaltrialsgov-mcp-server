/**
 * @fileoverview Unit tests for the ClinicalTrialsGovProvider class.
 * Tests HTTP request construction, response validation, error handling, and backup behavior.
 *
 * @module tests/services/clinical-trials-gov/providers/clinicaltrials-gov.provider.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import of the class under test
// ---------------------------------------------------------------------------

const mockFetchWithTimeout = vi.fn();
vi.mock('@/utils/network/fetchWithTimeout.js', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));

const mockConfig: Record<string, unknown> = {};
vi.mock('@/config/index.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => mockConfig[prop as string],
  }),
}));

const mockWriteFileSync = vi.fn();
vi.mock('node:fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

vi.mock('@/utils/index.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

// Import after mocks are set up
import { ClinicalTrialsGovProvider } from '@/services/clinical-trials-gov/providers/clinicaltrials-gov.provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://clinicaltrials.gov/api/v2';
const FIXED_TIME = new Date('2025-06-15T12:30:45.123Z');

function createMockResponse(
  body: unknown,
  options: { ok?: boolean; status?: number; statusText?: string } = {},
) {
  const { ok = true, status = 200, statusText = 'OK' } = options;
  return {
    ok,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function createMockTextResponse(
  text: string,
  options: { ok?: boolean; status?: number; statusText?: string } = {},
) {
  const { ok = true, status = 200, statusText = 'OK' } = options;
  return {
    ok,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

const validStudy = {
  protocolSection: {
    identificationModule: { nctId: 'NCT12345678', briefTitle: 'Test Study' },
    statusModule: { overallStatus: 'Recruiting' },
  },
};

const validPagedStudies = {
  studies: [validStudy],
  totalCount: 1,
  nextPageToken: 'token123',
};

const mockContext = {
  requestId: 'test-req-id',
  timestamp: Date.now(),
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClinicalTrialsGovProvider', () => {
  let provider: ClinicalTrialsGovProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(FIXED_TIME);
    // Reset config between tests
    for (const key of Object.keys(mockConfig)) {
      delete mockConfig[key];
    }
    provider = new ClinicalTrialsGovProvider();
  });

  // =========================================================================
  // fetchStudy
  // =========================================================================

  describe('fetchStudy', () => {
    it('constructs the correct URL with the NCT ID', async () => {
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        `${BASE_URL}/studies/NCT12345678`,
        15000,
        mockContext,
        { headers: { Accept: 'application/json' } },
      );
    });

    it('returns a validated study on success', async () => {
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      const result = await provider.fetchStudy('NCT12345678', mockContext);

      expect(result).toEqual(validStudy);
    });

    it('throws McpError ValidationError when schema validation fails', async () => {
      // studies array at root level is not a valid Study shape — StudySchema expects
      // an object (optionally with protocolSection). A non-object will fail.
      const invalidStudy = 'not-an-object';
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(invalidStudy));

      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toThrow(McpError);
      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'Invalid study data received from API',
      });
    });

    it('propagates McpError when fetch returns non-OK response', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockTextResponse('Server Error', {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toThrow(McpError);
      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
    });
  });

  // =========================================================================
  // listStudies
  // =========================================================================

  describe('listStudies', () => {
    it('returns validated paged studies on success', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      const result = await provider.listStudies({}, mockContext);

      expect(result).toEqual(validPagedStudies);
    });

    it('constructs URL with all params set', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        {
          query: 'diabetes',
          filter: 'AREA[Phase]PHASE3',
          pageSize: 20,
          pageToken: 'abc123',
          sort: 'LastUpdateDate:desc',
          fields: ['NCTId', 'BriefTitle', 'OverallStatus'],
        },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);

      expect(url.pathname).toBe('/api/v2/studies');
      expect(url.searchParams.get('query.term')).toBe('diabetes');
      expect(url.searchParams.get('filter.advanced')).toBe('AREA[Phase]PHASE3');
      expect(url.searchParams.get('pageSize')).toBe('20');
      expect(url.searchParams.get('pageToken')).toBe('abc123');
      expect(url.searchParams.get('sort')).toBe('LastUpdateDate:desc');
      expect(url.searchParams.get('fields')).toBe(
        'NCTId,BriefTitle,OverallStatus',
      );
      expect(url.searchParams.get('countTotal')).toBe('true');
    });

    it('always sets countTotal=true', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies({}, mockContext);

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('countTotal')).toBe('true');
    });

    it('omits optional params when not provided', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies({}, mockContext);

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);

      expect(url.searchParams.has('query.term')).toBe(false);
      expect(url.searchParams.has('filter.advanced')).toBe(false);
      expect(url.searchParams.has('pageSize')).toBe(false);
      expect(url.searchParams.has('pageToken')).toBe(false);
      expect(url.searchParams.has('sort')).toBe(false);
      expect(url.searchParams.has('fields')).toBe(false);
    });

    it('joins fields array with commas', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        { fields: ['NCTId', 'BriefTitle'] },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('fields=NCTId%2CBriefTitle');
    });

    it('throws McpError ValidationError on invalid response shape', async () => {
      // PagedStudiesSchema requires studies to be an array
      const invalid = { studies: 'not-an-array' };
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(invalid));

      await expect(provider.listStudies({}, mockContext)).rejects.toThrow(
        McpError,
      );
      await expect(provider.listStudies({}, mockContext)).rejects.toMatchObject(
        {
          code: JsonRpcErrorCode.ValidationError,
          message: 'Invalid studies data received from API',
        },
      );
    });

    it('propagates McpError from fetchAndBackup on API error', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockTextResponse('Bad Request', {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
        }),
      );

      await expect(provider.listStudies({}, mockContext)).rejects.toThrow(
        McpError,
      );
      await expect(provider.listStudies({}, mockContext)).rejects.toMatchObject(
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
        },
      );
    });
  });

  // =========================================================================
  // getStudyMetadata
  // =========================================================================

  describe('getStudyMetadata', () => {
    const fullStudyResponse = {
      protocolSection: {
        identificationModule: {
          nctId: 'NCT12345678',
          briefTitle: 'Test Study Title',
          officialTitle: 'Official Study Title',
        },
        statusModule: {
          overallStatus: 'Recruiting',
          startDateStruct: { date: '2025-01-01' },
          completionDateStruct: { date: '2026-06-01' },
          lastUpdatePostDateStruct: { date: '2025-05-15' },
        },
      },
    };

    it('extracts metadata from the study response', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(fullStudyResponse),
      );

      const result = await provider.getStudyMetadata(
        'NCT12345678',
        mockContext,
      );

      expect(result).toEqual({
        nctId: 'NCT12345678',
        title: 'Test Study Title',
        status: 'Recruiting',
        startDate: '2025-01-01',
        completionDate: '2026-06-01',
        lastUpdateDate: '2025-05-15',
      });
    });

    it('constructs the correct URL with fields parameter', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(fullStudyResponse),
      );

      await provider.getStudyMetadata('NCT12345678', mockContext);

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      expect(calledUrl).toContain(`${BASE_URL}/studies/NCT12345678?fields=`);
      expect(calledUrl).toContain('NCTId');
      expect(calledUrl).toContain('BriefTitle');
      expect(calledUrl).toContain('OverallStatus');
    });

    it('falls back nctId to input param when not in response', async () => {
      const responseWithoutNctId = {
        protocolSection: {
          identificationModule: {
            briefTitle: 'Some Title',
          },
        },
      };
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(responseWithoutNctId),
      );

      const result = await provider.getStudyMetadata(
        'NCT99999999',
        mockContext,
      );

      expect(result.nctId).toBe('NCT99999999');
    });

    it('handles missing optional fields gracefully', async () => {
      const minimalResponse = {};
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(minimalResponse),
      );

      const result = await provider.getStudyMetadata(
        'NCT12345678',
        mockContext,
      );

      expect(result).toEqual({
        nctId: 'NCT12345678',
        title: undefined,
        status: undefined,
        startDate: undefined,
        completionDate: undefined,
        lastUpdateDate: undefined,
      });
    });

    it('prefers briefTitle over officialTitle', async () => {
      const responseWithBothTitles = {
        protocolSection: {
          identificationModule: {
            briefTitle: 'Brief Title',
            officialTitle: 'Official Title',
          },
        },
      };
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(responseWithBothTitles),
      );

      const result = await provider.getStudyMetadata(
        'NCT12345678',
        mockContext,
      );

      expect(result.title).toBe('Brief Title');
    });

    it('falls back to officialTitle when briefTitle is missing', async () => {
      const responseWithOfficialOnly = {
        protocolSection: {
          identificationModule: {
            officialTitle: 'Official Title Only',
          },
        },
      };
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(responseWithOfficialOnly),
      );

      const result = await provider.getStudyMetadata(
        'NCT12345678',
        mockContext,
      );

      expect(result.title).toBe('Official Title Only');
    });
  });

  // =========================================================================
  // getApiStats
  // =========================================================================

  describe('getApiStats', () => {
    it('returns stats with totalStudies from response', async () => {
      const statsResponse = { totalStudies: 500000 };
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(statsResponse));

      const result = await provider.getApiStats(mockContext);

      expect(result.totalStudies).toBe(500000);
    });

    it('falls back totalStudies to 0 when not in response', async () => {
      const statsResponse = { averageSizeBytes: 12345 };
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(statsResponse));

      const result = await provider.getApiStats(mockContext);

      expect(result.totalStudies).toBe(0);
    });

    it('returns current timestamp for lastUpdated', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse({ totalStudies: 1 }),
      );

      const result = await provider.getApiStats(mockContext);

      expect(result.lastUpdated).toBe(FIXED_TIME.toISOString());
    });

    it('returns "v2" for version', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse({ totalStudies: 1 }),
      );

      const result = await provider.getApiStats(mockContext);

      expect(result.version).toBe('v2');
    });

    it('fetches from the correct stats/size URL', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse({ totalStudies: 1 }),
      );

      await provider.getApiStats(mockContext);

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      expect(calledUrl).toBe(`${BASE_URL}/stats/size`);
    });
  });

  // =========================================================================
  // fetchAndBackup (tested indirectly through public methods)
  // =========================================================================

  describe('fetchAndBackup (indirect)', () => {
    it('passes 15000ms timeout and Accept header to fetchWithTimeout', async () => {
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        expect.any(String),
        15000,
        mockContext,
        { headers: { Accept: 'application/json' } },
      );
    });

    it('handles 404 with "Resource not found" message', async () => {
      const errorBody = 'Study NCT00000000 not found';
      mockFetchWithTimeout.mockResolvedValue(
        createMockTextResponse(errorBody, {
          ok: false,
          status: 404,
          statusText: 'Not Found',
        }),
      );

      try {
        await provider.fetchStudy('NCT00000000', mockContext);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(mcpErr.message).toBe(`Resource not found: ${errorBody}`);
        expect(mcpErr.data).toEqual({
          url: `${BASE_URL}/studies/NCT00000000`,
          status: 404,
          body: errorBody,
        });
      }
    });

    it('handles non-404 error with status and statusText message', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockTextResponse('rate limited', {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
        }),
      );

      try {
        await provider.fetchStudy('NCT12345678', mockContext);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(mcpErr.message).toBe(
          'API request failed with status 429: Too Many Requests',
        );
        expect(mcpErr.data).toEqual({
          url: `${BASE_URL}/studies/NCT12345678`,
          status: 429,
          body: 'rate limited',
        });
      }
    });

    it('includes url, status, and body in McpError data for error responses', async () => {
      const body = '{"error": "bad request"}';
      mockFetchWithTimeout.mockResolvedValue(
        createMockTextResponse(body, {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
        }),
      );

      try {
        await provider.fetchStudy('NCT12345678', mockContext);
        expect.fail('Should have thrown');
      } catch (err) {
        const mcpErr = err as McpError;
        expect(mcpErr.data).toEqual({
          url: `${BASE_URL}/studies/NCT12345678`,
          status: 400,
          body,
        });
      }
    });

    it('writes backup file when clinicalTrialsDataPath is set', async () => {
      mockConfig.clinicalTrialsDataPath = '/tmp/backup';
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content] = mockWriteFileSync.mock.calls[0]!;
      // The timestamp in the filename uses the faked time
      const expectedTimestamp = FIXED_TIME.toISOString().replace(/[:.]/g, '-');
      expect(filePath).toBe(
        `/tmp/backup/study_NCT12345678_${expectedTimestamp}.json`,
      );
      expect(JSON.parse(content as string)).toEqual(validStudy);
    });

    it('does not attempt backup when clinicalTrialsDataPath is not set', async () => {
      delete mockConfig.clinicalTrialsDataPath;
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('logs error but does not throw when backup write fails', async () => {
      mockConfig.clinicalTrialsDataPath = '/tmp/backup';
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      // Should not throw — backup failure is caught internally
      const result = await provider.fetchStudy('NCT12345678', mockContext);

      expect(result).toEqual(validStudy);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

      // Verify logger.error was called for the backup failure
      const { logger } = await import('@/utils/index.js');
      expect(logger.error).toHaveBeenCalledWith(
        '[Backup] Failed to write file',
        expect.objectContaining({ error: expect.any(Error) }),
      );
    });

    it('throws when response body is not valid JSON', async () => {
      const invalidJsonResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue('this is not json{{{'),
      } as unknown as Response;
      mockFetchWithTimeout.mockResolvedValue(invalidJsonResponse);

      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toThrow();
    });

    it('propagates errors from fetchWithTimeout itself (e.g., network failure)', async () => {
      mockFetchWithTimeout.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('generates unique backup filenames using timestamp', async () => {
      mockConfig.clinicalTrialsDataPath = '/data';
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      const filePath = mockWriteFileSync.mock.calls[0]![0] as string;
      // Should contain the formatted timestamp (colons and dots replaced with dashes)
      expect(filePath).toMatch(
        /study_NCT12345678_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/,
      );
    });

    it('generates correct backup filename for listStudies', async () => {
      mockConfig.clinicalTrialsDataPath = '/data';
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies({}, mockContext);

      const filePath = mockWriteFileSync.mock.calls[0]![0] as string;
      const expectedTimestamp = FIXED_TIME.toISOString().replace(/[:.]/g, '-');
      expect(filePath).toBe(`/data/studies_${expectedTimestamp}.json`);
    });

    it('generates correct backup filename for getApiStats', async () => {
      mockConfig.clinicalTrialsDataPath = '/data';
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse({ totalStudies: 1 }),
      );

      await provider.getApiStats(mockContext);

      const filePath = mockWriteFileSync.mock.calls[0]![0] as string;
      const expectedTimestamp = FIXED_TIME.toISOString().replace(/[:.]/g, '-');
      expect(filePath).toBe(`/data/stats_${expectedTimestamp}.json`);
    });

    it('generates correct backup filename for getStudyMetadata', async () => {
      mockConfig.clinicalTrialsDataPath = '/data';
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse({ protocolSection: {} }),
      );

      await provider.getStudyMetadata('NCT12345678', mockContext);

      const filePath = mockWriteFileSync.mock.calls[0]![0] as string;
      const expectedTimestamp = FIXED_TIME.toISOString().replace(/[:.]/g, '-');
      expect(filePath).toBe(
        `/data/metadata_NCT12345678_${expectedTimestamp}.json`,
      );
    });
  });
});
