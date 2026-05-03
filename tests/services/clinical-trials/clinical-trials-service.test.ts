/**
 * @fileoverview Tests for ClinicalTrialsService API client.
 * @module tests/services/clinical-trials/clinical-trials-service
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  ClinicalTrialsService,
  getClinicalTrialsService,
} from '@/services/clinical-trials/clinical-trials-service.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const testConfig: ServerConfig = {
  apiBaseUrl: 'https://test.api/v2',
  requestTimeoutMs: 5000,
  maxPageSize: 100,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function textResponse(body: string, status = 400) {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: () => Promise.reject(new Error('Not JSON')),
    text: () => Promise.resolve(body),
  };
}

function htmlResponse(body: string, status = 200) {
  return {
    ok: true,
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/html' }),
    json: () => Promise.reject(new Error('Not JSON')),
    text: () => Promise.resolve(body),
  };
}

// Fast retry/backoff keeps wall-clock time in retry tests to < 1s. Production
// defaults (6 retries, 30s cap) are verified via the singleton accessor block.
// validateFieldsLocally=false skips the lazy /studies/metadata fetch — tests
// that exercise the validation path opt back in explicitly via a fresh service.
const fastOptions = {
  maxRetries: 3,
  baseBackoffMs: 10,
  maxBackoffMs: 50,
  validateFieldsLocally: false,
};

describe('ClinicalTrialsService', () => {
  let service: ClinicalTrialsService;

  beforeEach(() => {
    service = new ClinicalTrialsService(testConfig, fastOptions);
    mockFetch.mockReset();
  });

  describe('searchStudies', () => {
    it('returns paged study results', async () => {
      const body = { studies: [{ nctId: 'NCT12345678' }], totalCount: 1 };
      mockFetch.mockResolvedValue(jsonResponse(body));

      const ctx = createMockContext();
      const result = await service.searchStudies({ queryCond: 'diabetes' }, ctx);

      expect(result.studies).toEqual([{ nctId: 'NCT12345678' }]);
      expect(result.totalCount).toBe(1);
    });

    it('builds query parameters from SearchParams', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies(
        {
          queryTerm: 'general',
          queryCond: 'cancer',
          queryIntr: 'chemo',
          queryLocn: 'Seattle',
          querySpons: 'NIH',
          queryTitles: 'phase 3',
          queryOutc: 'survival',
          filterOverallStatus: ['RECRUITING', 'COMPLETED'],
          filterGeo: 'distance(47.6,-122.3,50mi)',
          filterIds: ['NCT12345678'],
          filterAdvanced: 'AREA[StudyType]INTERVENTIONAL',
          fields: ['NCTId', 'BriefTitle'],
          sort: 'LastUpdatePostDate:desc',
          countTotal: true,
          pageSize: 20,
          pageToken: 'tok123',
        },
        ctx,
      );

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('query.term')).toBe('general');
      expect(calledUrl.searchParams.get('query.cond')).toBe('cancer');
      expect(calledUrl.searchParams.get('query.intr')).toBe('chemo');
      expect(calledUrl.searchParams.get('query.locn')).toBe('Seattle');
      expect(calledUrl.searchParams.get('query.spons')).toBe('NIH');
      expect(calledUrl.searchParams.get('query.titles')).toBe('phase 3');
      expect(calledUrl.searchParams.get('query.outc')).toBe('survival');
      expect(calledUrl.searchParams.get('filter.overallStatus')).toBe('RECRUITING|COMPLETED');
      expect(calledUrl.searchParams.get('filter.geo')).toBe('distance(47.6,-122.3,50mi)');
      expect(calledUrl.searchParams.get('filter.ids')).toBe('NCT12345678');
      expect(calledUrl.searchParams.get('filter.advanced')).toBe('AREA[StudyType]INTERVENTIONAL');
      expect(calledUrl.searchParams.get('fields')).toBe('NCTId|BriefTitle');
      expect(calledUrl.searchParams.get('sort')).toBe('LastUpdatePostDate:desc');
      expect(calledUrl.searchParams.get('countTotal')).toBe('true');
      expect(calledUrl.searchParams.get('pageSize')).toBe('20');
      expect(calledUrl.searchParams.get('pageToken')).toBe('tok123');
    });

    it('caps pageSize at maxPageSize', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({ pageSize: 999 }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('pageSize')).toBe('100');
    });

    it('sets format=json by default', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({}, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('format')).toBe('json');
    });

    it('omits undefined params from URL', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({ queryCond: 'test' }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.has('query.term')).toBe(false);
      expect(calledUrl.searchParams.has('filter.overallStatus')).toBe(false);
    });
  });

  describe('getStudy', () => {
    it('fetches a single study by NCT ID', async () => {
      const study = { nctId: 'NCT12345678' };
      mockFetch.mockResolvedValue(jsonResponse(study));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result).toEqual(study);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe('/v2/studies/NCT12345678');
    });

    it('throws McpError with NotFound on 404', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));

      const ctx = createMockContext();
      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow(McpError);
      try {
        await service.getStudy('NCT12345678', ctx);
      } catch (err) {
        expect((err as McpError).message).toContain('not found');
      }
    });

    it('URL-encodes the NCT ID', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      const ctx = createMockContext();

      await service.getStudy('NCT12345678', ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toContain('NCT12345678');
    });
  });

  describe('getStudiesBatch', () => {
    it('fetches multiple studies via searchStudies', async () => {
      const body = {
        studies: [{ nctId: 'NCT12345678' }, { nctId: 'NCT87654321' }],
      };
      mockFetch.mockResolvedValue(jsonResponse(body));

      const ctx = createMockContext();
      const result = await service.getStudiesBatch(['NCT12345678', 'NCT87654321'], ctx);

      expect(result).toHaveLength(2);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('filter.ids')).toBe('NCT12345678|NCT87654321');
    });

    it('sets pageSize to match nctIds count', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.getStudiesBatch(['NCT12345678', 'NCT87654321'], ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('pageSize')).toBe('2');
    });

    it('requests specific fields for batch', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.getStudiesBatch(['NCT12345678'], ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      const fields = calledUrl.searchParams.get('fields')!;
      expect(fields).toContain('NCTId');
      expect(fields).toContain('HasResults');
      expect(fields).toContain('ResultsSection');
    });
  });

  describe('getMetadata', () => {
    it('fetches metadata tree', async () => {
      const tree = [{ name: 'protocolSection', children: [] }];
      mockFetch.mockResolvedValue(jsonResponse(tree));

      const ctx = createMockContext();
      const result = await service.getMetadata(false, ctx);

      expect(result).toEqual(tree);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe('/v2/studies/metadata');
    });

    it('passes includeIndexedOnly param', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      const ctx = createMockContext();

      await service.getMetadata(true, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('includeIndexedOnly')).toBe('true');
    });

    it('omits includeIndexedOnly when false', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      const ctx = createMockContext();

      await service.getMetadata(false, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.has('includeIndexedOnly')).toBe(false);
    });

    it('does not set format=json for metadata', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      const ctx = createMockContext();

      await service.getMetadata(false, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.has('format')).toBe(false);
    });
  });

  describe('getFieldValues', () => {
    it('returns field value statistics', async () => {
      const stats = [
        {
          field: 'OverallStatus',
          piece: 'OverallStatus',
          type: 'ENUM',
          uniqueValuesCount: 14,
          topValues: [{ value: 'COMPLETED', studiesCount: 200000 }],
        },
      ];
      mockFetch.mockResolvedValue(jsonResponse(stats));

      const ctx = createMockContext();
      const result = await service.getFieldValues(['OverallStatus'], ctx);

      expect(result).toEqual(stats);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe('/v2/stats/field/values');
      expect(calledUrl.searchParams.get('fields')).toBe('OverallStatus');
      expect(calledUrl.searchParams.has('format')).toBe(false);
    });

    it('joins multiple fields with pipe', async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      const ctx = createMockContext();

      await service.getFieldValues(['OverallStatus', 'Phase'], ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('fields')).toBe('OverallStatus|Phase');
    });

    it('rethrows 404 as validation error with helpful message', async () => {
      mockFetch.mockResolvedValue(textResponse('Unknown piece name of field path: BadField', 404));
      const ctx = createMockContext();

      await expect(service.getFieldValues(['BadField'], ctx)).rejects.toThrow(
        /Invalid field name: 'BadField'/,
      );
    });

    it('extracts offending field name on multi-field 404 without flagging valid inputs', async () => {
      mockFetch.mockResolvedValue(
        textResponse('Unknown piece name of field path: BogusPiece', 404),
      );
      const ctx = createMockContext();

      await expect(service.getFieldValues(['Phase', 'BogusPiece'], ctx)).rejects.toThrow(
        /Invalid field name: 'BogusPiece'\. Other submitted fields \(Phase\) may also be invalid/,
      );
    });

    it('falls back to input list when upstream body lacks the offender name', async () => {
      mockFetch.mockResolvedValue(textResponse('', 404));
      const ctx = createMockContext();

      await expect(service.getFieldValues(['Phase', 'Foo'], ctx)).rejects.toThrow(
        /Invalid field name\(s\): Phase, Foo/,
      );
    });

    it('rethrows non-404 errors as-is', async () => {
      // 403 is not retryable and not 404, so it propagates directly
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: () => Promise.resolve('Forbidden'),
        json: () => Promise.reject(new Error('Not JSON')),
      });
      const ctx = createMockContext();

      await expect(service.getFieldValues(['Test'], ctx)).rejects.toThrow(/HTTP 403/);
    });
  });

  describe('error handling', () => {
    it('throws validation error on 400', async () => {
      mockFetch.mockResolvedValue(textResponse('Bad request body'));

      const ctx = createMockContext();
      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow(McpError);
    });

    it('throws notFound with ID list on incorrect format error for filter.ids', async () => {
      mockFetch.mockResolvedValue(textResponse('filter.ids has incorrect format for value XYZ'));

      const ctx = createMockContext();
      await expect(service.searchStudies({ filterIds: ['XYZ'] }, ctx)).rejects.toThrow(
        /not found or rejected by API: XYZ/,
      );
    });

    it('wraps 400 invalid field name with piece-name hint and field definitions pointer', async () => {
      mockFetch.mockResolvedValue(
        textResponse("Parameter 'fields' contains invalid field name: 'StudyDesign'"),
      );

      const ctx = createMockContext();
      try {
        await service.searchStudies({ fields: ['StudyDesign'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("'StudyDesign'");
        expect(msg).toContain('piece name');
        expect(msg).toContain('clinicaltrials_get_field_definitions');
      }
    });

    it('wraps 400 invalid field name without offender parse when body lacks quoted name', async () => {
      mockFetch.mockResolvedValue(
        textResponse('Parameter fields contains invalid field name somewhere'),
      );

      const ctx = createMockContext();
      try {
        await service.searchStudies({ fields: ['BadName'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain('piece names');
        expect(msg).toContain('clinicaltrials_get_field_definitions');
      }
    });

    it('throws notFound for 400 with incorrect format on study path', async () => {
      mockFetch.mockResolvedValue(textResponse('has incorrect format', 400));

      const ctx = createMockContext();
      await expect(service.getStudy('BADID', ctx)).rejects.toThrow(/not found.*Verify/);
    });

    it('throws generic validation error for 400 without incorrect format', async () => {
      mockFetch.mockResolvedValue(textResponse('some other bad request'));

      const ctx = createMockContext();
      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow(McpError);
    });

    it('throws on request cancellation', async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx = createMockContext({ signal: controller.signal });

      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow('Request cancelled');
    });

    it('throws on non-retryable HTTP errors', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 403));

      const ctx = createMockContext();
      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow(/HTTP 403/);
    });
  });

  describe('retry logic', () => {
    it('retries on 429', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(null, 429))
        .mockResolvedValueOnce(jsonResponse({ studies: [] }));

      const ctx = createMockContext();
      const result = await service.searchStudies({}, ctx);

      expect(result.studies).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('retries on 500', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(null, 500))
        .mockResolvedValueOnce(jsonResponse({ nctId: 'NCT12345678' }));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result.nctId).toBe('NCT12345678');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('retries on 503', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(null, 503))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('throws serviceUnavailable after max retries on 503', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 503));

      const ctx = createMockContext();
      await expect(service.searchStudies({}, ctx)).rejects.toThrow(/unavailable after retries/);
      // 1 initial + 3 retries = 4 calls (fastOptions caps maxRetries at 3 for tests)
      expect(mockFetch).toHaveBeenCalledTimes(4);
    }, 30_000);

    it('throws RateLimited McpError after max retries on 429', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 429));

      const ctx = createMockContext();
      try {
        await service.searchStudies({}, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
        expect((err as McpError).message).toMatch(/Rate limited/);
      }
      expect(mockFetch).toHaveBeenCalledTimes(4);
    }, 30_000);

    it('uses proportional ±25% jitter (no zero-jitter floor)', async () => {
      // Regression guard — old impl had a fixed 0–500ms jitter that could
      // produce near-zero delays. New impl multiplies base by 0.75–1.25.
      const originalRandom = Math.random;
      Math.random = () => 0; // forces 0.75x multiplier
      try {
        mockFetch
          .mockResolvedValueOnce(jsonResponse(null, 500))
          .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const ctx = createMockContext();
        const start = Date.now();
        await service.getStudy('NCT12345678', ctx);
        // baseBackoffMs=10 * 0.75 = 7.5ms minimum; plus throttle ~1s between calls.
        // Assert we didn't skip the backoff entirely.
        expect(Date.now() - start).toBeGreaterThanOrEqual(5);
      } finally {
        Math.random = originalRandom;
      }
    });

    it('retries on network errors (ECONNRESET)', async () => {
      const connError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      mockFetch.mockRejectedValueOnce(connError).mockResolvedValueOnce(jsonResponse({ ok: true }));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('retries on timeout errors', async () => {
      const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      mockFetch
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result).toEqual({ ok: true });
    }, 10_000);

    it('retries on AbortError', async () => {
      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      mockFetch.mockRejectedValueOnce(abortError).mockResolvedValueOnce(jsonResponse({ ok: true }));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result).toEqual({ ok: true });
    }, 10_000);

    it('does not retry McpError (non-retryable)', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));

      const ctx = createMockContext();
      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow(McpError);
      // 404 → notFound McpError is thrown immediately, no retries
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry non-retryable fetch errors', async () => {
      mockFetch.mockRejectedValue(new TypeError('Invalid URL'));

      const ctx = createMockContext();
      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow('Invalid URL');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('checks cancellation before each attempt', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(async () => {
        controller.abort();
        return jsonResponse(null, 503);
      });

      const ctx = createMockContext({ signal: controller.signal });
      await expect(service.searchStudies({}, ctx)).rejects.toThrow('Request cancelled');
    }, 10_000);
  });

  describe('HTML response handling', () => {
    it('retries when API returns HTML instead of JSON', async () => {
      mockFetch
        .mockResolvedValueOnce(htmlResponse('<html><body>Error</body></html>'))
        .mockResolvedValueOnce(jsonResponse({ studies: [] }));

      const ctx = createMockContext();
      const result = await service.searchStudies({}, ctx);

      expect(result.studies).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('retries on DOCTYPE HTML response', async () => {
      mockFetch
        .mockResolvedValueOnce(htmlResponse('<!DOCTYPE html><html>...'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result).toEqual({ ok: true });
    }, 10_000);

    it('parses non-HTML text as JSON when content-type is not json', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: () => Promise.resolve('{"data": "value"}'),
        json: () => Promise.reject(new Error('nope')),
      });

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);
      expect(result).toEqual({ data: 'value' });
    });
  });

  describe('error data wire shape', () => {
    // The service spreads `ctx.recoveryFor(reason)` from whatever contract is
    // attached to the active context. These tests attach a synthetic contract
    // covering every reason the service throws, so assertions can verify both
    // `data.reason` (always set by the service) and `data.recovery.hint`
    // (resolved from the contract via the framework's typed-fail wiring).
    const allReasons = [
      {
        reason: 'study_not_found' as const,
        code: JsonRpcErrorCode.NotFound,
        when: 'No study matched.',
        recovery: 'Verify the NCT ID at clinicaltrials.gov or use the search tool to discover one.',
      },
      {
        reason: 'ids_not_found' as const,
        code: JsonRpcErrorCode.NotFound,
        when: 'Some IDs missing.',
        recovery: 'Verify each NCT ID exists, or call the search tool first to discover valid IDs.',
      },
      {
        reason: 'field_invalid' as const,
        code: JsonRpcErrorCode.ValidationError,
        when: 'Field name not valid.',
        recovery: 'Call the field-definitions tool to browse valid PascalCase piece names instead.',
      },
      {
        reason: 'rate_limited' as const,
        code: JsonRpcErrorCode.RateLimited,
        when: 'Rate limited after retries.',
        recovery:
          'Wait about a minute before retrying; the upstream API enforces a tight rate limit.',
        retryable: true,
      },
    ];

    it('attaches reason=study_not_found + recovery on 404 /studies/', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.getStudy('NCT12345678', ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('study_not_found');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toMatch(
          /Verify the NCT ID/,
        );
      }
    });

    it('attaches reason=study_not_found on 400 with "incorrect format" for /studies/', async () => {
      mockFetch.mockResolvedValue(textResponse('has incorrect format', 400));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.getStudy('BADID', ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('study_not_found');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toBeTruthy();
      }
    });

    it('attaches reason=ids_not_found for filter.ids rejection', async () => {
      mockFetch.mockResolvedValue(textResponse('filter.ids has incorrect format for value XYZ'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ filterIds: ['XYZ'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('ids_not_found');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toMatch(
          /Verify each NCT ID/,
        );
      }
    });

    it('attaches reason=field_invalid for "contains invalid field name" 400', async () => {
      mockFetch.mockResolvedValue(
        textResponse("Parameter 'fields' contains invalid field name: 'StudyDesign'"),
      );
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ fields: ['StudyDesign'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('field_invalid');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toMatch(
          /field-definitions/,
        );
      }
    });

    it('attaches reason=field_invalid for getFieldValues 404 unknown piece', async () => {
      mockFetch.mockResolvedValue(textResponse('Unknown piece name of field path: BadField', 404));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.getFieldValues(['BadField'], ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('field_invalid');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toBeTruthy();
      }
    });

    it('attaches reason=rate_limited after 429 retries exhaust', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 429));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({}, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('rate_limited');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toMatch(
          /Wait about a minute/,
        );
      }
    }, 30_000);

    it('omits recovery.hint when no contract is attached (service stays contract-agnostic)', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));
      const ctx = createMockContext(); // no errors → ctx.recoveryFor returns {}
      try {
        await service.getStudy('NCT12345678', ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('study_not_found'); // reason still set
        expect(data?.recovery).toBeUndefined(); // hint only when contract attached
      }
    });
  });

  describe('field validation (validateFieldsLocally=true)', () => {
    const sampleMetadata: FieldNode[] = [
      {
        name: 'protocolSection',
        children: [
          {
            name: 'identificationModule',
            children: [
              { name: 'nctId', piece: 'NCTId', type: 'STRING' },
              { name: 'briefTitle', piece: 'BriefTitle', type: 'STRING' },
            ],
          },
          {
            name: 'conditionsModule',
            children: [{ name: 'conditions', piece: 'Condition', type: 'STRING' }],
          },
          {
            name: 'designModule',
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

    function mockByRoute(routes: { metadata?: unknown; primary?: unknown } = {}) {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          return Promise.resolve(routes.metadata ?? jsonResponse(sampleMetadata));
        }
        return Promise.resolve(routes.primary ?? jsonResponse({ studies: [] }));
      });
    }

    let validatingService: ClinicalTrialsService;
    beforeEach(() => {
      validatingService = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
    });

    it('rejects searchStudies with an invalid field name before hitting the API', async () => {
      mockByRoute();
      const ctx = createMockContext();
      await expect(
        validatingService.searchStudies({ fields: ['ConditionList'] }, ctx),
      ).rejects.toThrow(/Invalid field name: 'ConditionList'/);
      // Only the metadata fetch should have happened — no /studies call.
      const studiesCalls = mockFetch.mock.calls.filter((c) => {
        const u = typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
        return !u.includes('/studies/metadata');
      });
      expect(studiesCalls).toHaveLength(0);
    });

    it('suggests nearest matches for a typo', async () => {
      mockByRoute();
      const ctx = createMockContext();
      try {
        await validatingService.searchStudies({ fields: ['ConditionList'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain('did you mean');
        expect(msg).toContain("'Condition'");
      }
    });

    it('passes through when all fields are valid', async () => {
      mockByRoute();
      const ctx = createMockContext();
      const result = await validatingService.searchStudies(
        { fields: ['NCTId', 'BriefTitle'] },
        ctx,
      );
      expect(result.studies).toEqual([]);
    });

    it('rejects getFieldValues with an invalid field name', async () => {
      mockByRoute();
      const ctx = createMockContext();
      await expect(validatingService.getFieldValues(['NotAField'], ctx)).rejects.toThrow(
        /Invalid field name: 'NotAField'/,
      );
    });

    it('fails open when metadata is unreachable so the request still proceeds', async () => {
      mockByRoute({
        metadata: jsonResponse(null, 404),
        primary: jsonResponse({ studies: [] }),
      });
      const ctx = createMockContext();
      const result = await validatingService.searchStudies({ fields: ['BadName'] }, ctx);
      expect(result.studies).toEqual([]);
    });

    it('caches the field index across multiple calls', async () => {
      let metadataCalls = 0;
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          metadataCalls += 1;
          return Promise.resolve(jsonResponse(sampleMetadata));
        }
        return Promise.resolve(jsonResponse({ studies: [] }));
      });
      const ctx = createMockContext();
      await validatingService.searchStudies({ fields: ['NCTId'] }, ctx);
      await validatingService.searchStudies({ fields: ['BriefTitle'] }, ctx);
      expect(metadataCalls).toBe(1);
    });

    it('attaches reason=field_invalid and recovery hint on validation failure', async () => {
      mockByRoute();
      const ctx = createMockContext({
        errors: [
          {
            reason: 'field_invalid',
            code: JsonRpcErrorCode.ValidationError,
            when: 'A field name is not valid.',
            recovery: 'Call clinicaltrials_get_field_definitions to look up the correct name.',
          },
        ],
      });
      try {
        await validatingService.searchStudies({ fields: ['Bogus'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown>;
        expect(data?.reason).toBe('field_invalid');
        expect(Array.isArray(data?.invalid)).toBe(true);
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toContain(
          'clinicaltrials_get_field_definitions',
        );
      }
    });
  });

  describe('searchFieldDefinitions', () => {
    const sampleMetadata: FieldNode[] = [
      {
        name: 'protocolSection',
        children: [
          {
            name: 'designModule',
            children: [
              {
                name: 'enrollmentInfo',
                piece: 'EnrollmentCount',
                type: 'INTEGER',
                description: 'Number of participants enrolled.',
              },
            ],
          },
          {
            name: 'sponsorCollaboratorsModule',
            children: [
              { name: 'leadSponsor', piece: 'LeadSponsorName', type: 'STRING' },
              { name: 'collaborators', piece: 'CollaboratorName', type: 'STRING' },
            ],
          },
        ],
      },
    ];

    let validatingService: ClinicalTrialsService;
    beforeEach(() => {
      validatingService = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
      mockFetch.mockResolvedValue(jsonResponse(sampleMetadata));
    });

    it('returns ranked matches for a keyword search', async () => {
      const ctx = createMockContext();
      const results = await validatingService.searchFieldDefinitions('enrollment', 5, ctx);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.piece).toBe('EnrollmentCount');
    });

    it('finds multiple matches sorted by relevance', async () => {
      const ctx = createMockContext();
      const results = await validatingService.searchFieldDefinitions('sponsor', 5, ctx);
      const pieces = results.map((r) => r.piece);
      expect(pieces).toContain('LeadSponsorName');
      expect(pieces).toContain('CollaboratorName');
    });

    it('respects the limit', async () => {
      const ctx = createMockContext();
      const results = await validatingService.searchFieldDefinitions('sponsor', 1, ctx);
      expect(results).toHaveLength(1);
    });

    it('returns an empty array when nothing matches', async () => {
      const ctx = createMockContext();
      const results = await validatingService.searchFieldDefinitions('zzznomatchzzz', 5, ctx);
      expect(results).toEqual([]);
    });
  });

  describe('singleton accessor', () => {
    it('throws when service not initialized', () => {
      expect(() => getClinicalTrialsService()).toThrow(/not initialized/);
    });
  });

  describe('constructor options', () => {
    it('defaults to 6 retries when options omitted', async () => {
      const defaultService = new ClinicalTrialsService(testConfig, {
        baseBackoffMs: 1,
        maxBackoffMs: 2,
      });
      mockFetch.mockResolvedValue(jsonResponse(null, 503));
      const ctx = createMockContext();
      await expect(defaultService.searchStudies({}, ctx)).rejects.toThrow(
        /unavailable after retries/,
      );
      // 1 initial + 6 retries = 7 calls
      expect(mockFetch).toHaveBeenCalledTimes(7);
    }, 30_000);
  });
});
