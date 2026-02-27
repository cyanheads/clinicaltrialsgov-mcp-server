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

const mockWriteFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
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

function createMockResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
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
    for (const key of Object.keys(mockConfig)) {
      delete mockConfig[key];
    }
    mockWriteFile.mockResolvedValue(undefined);
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
        30000,
        mockContext,
        { headers: { Accept: 'application/json' }, retryOn429: true },
      );
    });

    it('returns a validated study on success', async () => {
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      const result = await provider.fetchStudy('NCT12345678', mockContext);

      expect(result).toEqual(validStudy);
    });

    it('throws McpError ValidationError when schema validation fails', async () => {
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

    it('propagates McpError from fetchWithTimeout', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Fetch failed. Status: 500',
        ),
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

    it('maps conditionQuery to query.cond', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        { conditionQuery: 'lung cancer' },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('query.cond')).toBe('lung cancer');
    });

    it('maps interventionQuery to query.intr', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        { interventionQuery: 'pembrolizumab' },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('query.intr')).toBe('pembrolizumab');
    });

    it('maps sponsorQuery to query.spons', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies({ sponsorQuery: 'Pfizer' }, mockContext);

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('query.spons')).toBe('Pfizer');
    });

    it('maps locationQuery to query.locn', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        { locationQuery: 'New York, United States' },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('query.locn')).toBe(
        'New York, United States',
      );
    });

    it('maps statusFilter to filter.overallStatus', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        { statusFilter: 'RECRUITING,ACTIVE_NOT_RECRUITING' },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('filter.overallStatus')).toBe(
        'RECRUITING,ACTIVE_NOT_RECRUITING',
      );
    });

    it('maps single phaseFilter to AREA[Phase] in filter.advanced', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies({ phaseFilter: 'PHASE3' }, mockContext);

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('filter.advanced')).toBe('AREA[Phase]PHASE3');
    });

    it('maps multi-phase phaseFilter to AREA[Phase](... OR ...) in filter.advanced', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies({ phaseFilter: 'PHASE2,PHASE3' }, mockContext);

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('filter.advanced')).toBe(
        'AREA[Phase](PHASE2 OR PHASE3)',
      );
    });

    it('merges user filter with phaseFilter via AND', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        { filter: 'AREA[StudyType]INTERVENTIONAL', phaseFilter: 'PHASE3' },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('filter.advanced')).toBe(
        'AREA[StudyType]INTERVENTIONAL AND AREA[Phase]PHASE3',
      );
    });

    it('maps geoFilter to filter.geo', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(validPagedStudies),
      );

      await provider.listStudies(
        { geoFilter: 'distance(39.0035,-77.1013,50)' },
        mockContext,
      );

      const calledUrl = mockFetchWithTimeout.mock.calls[0]![0] as string;
      const url = new URL(calledUrl);
      expect(url.searchParams.get('filter.geo')).toBe(
        'distance(39.0035,-77.1013,50)',
      );
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
      expect(url.searchParams.has('filter.overallStatus')).toBe(false);
      expect(url.searchParams.has('filter.geo')).toBe(false);
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

    it('propagates McpError from fetchWithTimeout on API error', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Fetch failed. Status: 400',
        ),
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
  // getFieldValues
  // =========================================================================

  describe('getFieldValues', () => {
    const fieldValuesResponse = {
      type: 'ENUM',
      piece: 'Phase',
      field: 'protocolSection.designModule.phases',
      topValues: [
        { value: 'NA', studiesCount: 221098 },
        { value: 'PHASE2', studiesCount: 87121 },
        { value: 'PHASE1', studiesCount: 63452 },
      ],
    };

    it('constructs the correct URL with encoded field name', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(fieldValuesResponse),
      );

      await provider.getFieldValues('Phase', mockContext);

      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        `${BASE_URL}/stats/fieldValues/Phase`,
        30000,
        mockContext,
        { headers: { Accept: 'application/json' }, retryOn429: true },
      );
    });

    it('maps topValues with studiesCount to value/count pairs', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(fieldValuesResponse),
      );

      const result = await provider.getFieldValues('Phase', mockContext);

      expect(result).toEqual([
        { value: 'NA', count: 221098 },
        { value: 'PHASE2', count: 87121 },
        { value: 'PHASE1', count: 63452 },
      ]);
    });

    it('returns empty array when topValues is missing', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse({ type: 'UNKNOWN' }),
      );

      const result = await provider.getFieldValues('BadField', mockContext);

      expect(result).toEqual([]);
    });

    it('defaults missing value to empty string and missing count to 0', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse({ topValues: [{}] }),
      );

      const result = await provider.getFieldValues('Field', mockContext);

      expect(result).toEqual([{ value: '', count: 0 }]);
    });

    it('sanitizes fieldName in backup filename', async () => {
      mockConfig.clinicalTrialsDataPath = '/data';
      mockFetchWithTimeout.mockResolvedValue(
        createMockResponse(fieldValuesResponse),
      );

      await provider.getFieldValues('../etc/passwd', mockContext);

      const filePath = mockWriteFile.mock.calls[0]![0] as string;
      expect(filePath).not.toContain('..');
      // ../etc/passwd → ___etc_passwd, prefixed with fieldValues_ → fieldValues____etc_passwd
      expect(filePath).toContain('fieldValues____etc_passwd_');
    });
  });

  // =========================================================================
  // healthCheck
  // =========================================================================

  describe('healthCheck', () => {
    it('fetches the /version endpoint with a 10s timeout', async () => {
      mockFetchWithTimeout.mockResolvedValue({
        ok: true,
      } as unknown as Response);

      await provider.healthCheck(mockContext);

      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        `${BASE_URL}/version`,
        10000,
        mockContext,
        { method: 'GET', headers: { Accept: 'application/json' } },
      );
    });

    it('returns true when API responds ok', async () => {
      mockFetchWithTimeout.mockResolvedValue({
        ok: true,
      } as unknown as Response);

      const result = await provider.healthCheck(mockContext);

      expect(result).toBe(true);
    });

    it('propagates errors from fetchWithTimeout', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Fetch failed. Status: 503',
        ),
      );

      await expect(provider.healthCheck(mockContext)).rejects.toThrow(McpError);
    });
  });

  // =========================================================================
  // fetchAndBackup (tested indirectly through public methods)
  // =========================================================================

  describe('fetchAndBackup (indirect)', () => {
    it('passes 30s timeout, Accept header, and retryOn429 to fetchWithTimeout', async () => {
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        expect.any(String),
        30000,
        mockContext,
        { headers: { Accept: 'application/json' }, retryOn429: true },
      );
    });

    it('throws McpError InternalError when response is not valid JSON', async () => {
      const invalidJsonResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue('this is not json{{{'),
      } as unknown as Response;
      mockFetchWithTimeout.mockResolvedValue(invalidJsonResponse);

      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InternalError,
        message: 'Malformed JSON response from API',
      });
    });

    it('includes URL and body snippet in JSON parse error data', async () => {
      const longGarbage = 'x'.repeat(500);
      const invalidJsonResponse = {
        ok: true,
        text: vi.fn().mockResolvedValue(longGarbage),
      } as unknown as Response;
      mockFetchWithTimeout.mockResolvedValue(invalidJsonResponse);

      try {
        await provider.fetchStudy('NCT12345678', mockContext);
        expect.fail('Should have thrown');
      } catch (err) {
        const mcpErr = err as McpError;
        expect(mcpErr.data).toMatchObject({
          url: `${BASE_URL}/studies/NCT12345678`,
          bodySnippet: 'x'.repeat(200),
        });
      }
    });

    it('writes backup file when clinicalTrialsDataPath is set', async () => {
      mockConfig.clinicalTrialsDataPath = '/tmp/backup';
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const call = mockWriteFile.mock.calls[0] as [string, string];
      const [filePath, content] = call;
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

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('logs error but does not throw when backup write fails', async () => {
      mockConfig.clinicalTrialsDataPath = '/tmp/backup';
      mockWriteFile.mockRejectedValue(new Error('EACCES: permission denied'));
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      const result = await provider.fetchStudy('NCT12345678', mockContext);

      expect(result).toEqual(validStudy);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);

      // Flush microtask queue so the .catch() handler runs
      await new Promise((resolve) => setTimeout(resolve, 0));

      const { logger } = await import('@/utils/index.js');
      expect(logger.error).toHaveBeenCalledWith(
        '[Backup] Failed to write file',
        expect.objectContaining({ error: expect.any(Error) }),
      );
    });

    it('propagates errors from fetchWithTimeout itself', async () => {
      mockFetchWithTimeout.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        provider.fetchStudy('NCT12345678', mockContext),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('generates unique backup filenames using timestamp', async () => {
      mockConfig.clinicalTrialsDataPath = '/data';
      mockFetchWithTimeout.mockResolvedValue(createMockResponse(validStudy));

      await provider.fetchStudy('NCT12345678', mockContext);

      const filePath = mockWriteFile.mock.calls[0]![0] as string;
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

      const filePath = mockWriteFile.mock.calls[0]![0] as string;
      const expectedTimestamp = FIXED_TIME.toISOString().replace(/[:.]/g, '-');
      expect(filePath).toBe(`/data/studies_${expectedTimestamp}.json`);
    });
  });
});
