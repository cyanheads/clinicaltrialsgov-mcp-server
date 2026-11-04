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
  parseAreaRejection,
} from '@/services/clinical-trials/clinical-trials-service.js';
import { normalizeAreaNames } from '@/services/clinical-trials/field-search.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';
import {
  AREA_METADATA,
  INDEXED_METADATA,
  RECORD_METADATA,
  SEARCH_AREAS,
  STRUCT_PIECES,
} from '../../helpers/area-metadata.js';
import { expectLinearGrowth, LINE_BREAK_SHAPES } from '../../helpers/cpu-timing.js';
import { nctIds as ids } from '../../helpers/nct-ids.js';

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
// defaults (3 retries, 30s cap) are verified via the singleton accessor block.
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
      // Sentinel filter is appended unless the caller opts in.
      expect(calledUrl.searchParams.get('filter.advanced')).toBe(
        '(AREA[StudyType]INTERVENTIONAL) AND (NOT AREA[EnrollmentCount]RANGE[99999999, MAX])',
      );
      expect(calledUrl.searchParams.get('fields')).toBe('NCTId|BriefTitle');
      expect(calledUrl.searchParams.get('sort')).toBe('LastUpdatePostDate:desc');
      expect(calledUrl.searchParams.get('countTotal')).toBe('true');
      expect(calledUrl.searchParams.get('pageSize')).toBe('20');
      expect(calledUrl.searchParams.get('pageToken')).toBe('tok123');
    });

    it('appends the EnrollmentCount sentinel filter by default', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({ queryCond: 'diabetes' }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('filter.advanced')).toBe(
        'NOT AREA[EnrollmentCount]RANGE[99999999, MAX]',
      );
    });

    it('negates the sentinel range instead of bounding it, so a study with no EnrollmentCount survives (#106)', async () => {
      // A closed AREA[EnrollmentCount]RANGE[…] predicate matches only studies
      // that publish the field, so it excluded two disjoint sets: the handful of
      // rows at or above the unknown-enrollment boundary it was written for, and
      // every study carrying no EnrollmentCount at all — the whole of expanded
      // access among them. The negated single-sided range expresses the
      // documented intent directly and needs no MISSING arm.
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({ queryCond: 'diabetes' }, ctx);

      const advanced = new URL(mockFetch.mock.calls[0]![0] as string).searchParams.get(
        'filter.advanced',
      );
      expect(advanced).toBe('NOT AREA[EnrollmentCount]RANGE[99999999, MAX]');
      // The old bounded form is what dropped the missing-enrollment studies.
      expect(advanced).not.toContain('RANGE[0, 99999998]');
    });

    it('parenthesizes the negated sentinel clause alongside a caller-supplied filter (#106)', async () => {
      // NOT must stay bound to its own clause under the service's join pattern —
      // a leak across the AND boundary would negate the caller's filter too.
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({ filterAdvanced: 'AREA[OverallStatus]AVAILABLE' }, ctx);

      expect(
        new URL(mockFetch.mock.calls[0]![0] as string).searchParams.get('filter.advanced'),
      ).toBe('(AREA[OverallStatus]AVAILABLE) AND (NOT AREA[EnrollmentCount]RANGE[99999999, MAX])');
    });

    it('skips the sentinel filter when includeUnknownEnrollment=true', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({ queryCond: 'diabetes', includeUnknownEnrollment: true }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.has('filter.advanced')).toBe(false);
    });

    it('preserves a user-supplied filter.advanced when includeUnknownEnrollment=true', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies(
        {
          filterAdvanced: 'AREA[StudyType]INTERVENTIONAL',
          includeUnknownEnrollment: true,
        },
        ctx,
      );

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('filter.advanced')).toBe('AREA[StudyType]INTERVENTIONAL');
    });

    it('exposes the configured page cap without applying it to the request (#153)', async () => {
      // The cap belongs to a caller's own page request, which the search tool
      // applies; an internal fetch sized by its own input (the eligibility
      // candidate fetch) sends its pageSize unchanged.
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await service.searchStudies({ pageSize: 999 }, ctx);

      expect(service.maxPageSize).toBe(100);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('pageSize')).toBe('999');
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

  describe('countStudies (#160)', () => {
    // Upstream treats pageSize=0 as its default page — ten full studies — so a
    // count asks for one study projected to its ID: the total rides the same
    // response either way.
    it('requests one NCTId-only study with countTotal and returns the total', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ totalCount: 12_014, studies: [{ protocolSection: {} }] }),
      );
      const ctx = createMockContext();

      const total = await service.countStudies({ queryCond: 'Type 2 Diabetes' }, ctx);

      expect(total).toBe(12_014);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe('/v2/studies');
      expect(calledUrl.searchParams.get('countTotal')).toBe('true');
      expect(calledUrl.searchParams.get('pageSize')).toBe('1');
      expect(calledUrl.searchParams.get('fields')).toBe('NCTId');
      expect(calledUrl.searchParams.get('query.cond')).toBe('Type 2 Diabetes');
    });

    it("forwards the caller's query, filters, and the default unknown-enrollment exclusion", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ totalCount: 7, studies: [] }));
      const ctx = createMockContext();

      await service.countStudies(
        {
          queryTerm: 'general',
          queryLocn: 'SEARCH[Location](Seattle AND "United States")',
          filterOverallStatus: ['RECRUITING'],
          filterAdvanced: 'AREA[Phase]PHASE3',
        },
        ctx,
      );

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('query.term')).toBe('general');
      expect(calledUrl.searchParams.get('query.locn')).toBe(
        'SEARCH[Location](Seattle AND "United States")',
      );
      expect(calledUrl.searchParams.get('filter.overallStatus')).toBe('RECRUITING');
      expect(calledUrl.searchParams.get('filter.advanced')).toBe(
        '(AREA[Phase]PHASE3) AND (NOT AREA[EnrollmentCount]RANGE[99999999, MAX])',
      );
    });

    it('drops the unknown-enrollment exclusion when includeUnknownEnrollment is set', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ totalCount: 99, studies: [] }));
      const ctx = createMockContext();

      await service.countStudies({ queryCond: 'asthma', includeUnknownEnrollment: true }, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.has('filter.advanced')).toBe(false);
    });

    it('returns 0 for a zero-match query', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ totalCount: 0, studies: [] }));
      const ctx = createMockContext();

      await expect(service.countStudies({ queryCond: 'zzqxnomatch' }, ctx)).resolves.toBe(0);
    });

    it('defaults to 0 when upstream omits totalCount', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await expect(service.countStudies({}, ctx)).resolves.toBe(0);
    });

    it('makes exactly one upstream request on a fresh field-validating service', async () => {
      // The fixed NCTId projection never goes through local field validation,
      // which would otherwise fetch /studies/metadata on the server's first count.
      const fresh = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
      mockFetch.mockResolvedValue(jsonResponse({ totalCount: 3, studies: [] }));
      const ctx = createMockContext();

      await fresh.countStudies({ queryCond: 'asthma' }, ctx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(new URL(mockFetch.mock.calls[0]![0] as string).pathname).toBe('/v2/studies');
    });

    it('surfaces an upstream parse error with the same reason as a search', async () => {
      mockFetch.mockResolvedValue(
        textResponse("Error parsing query in query.term: extraneous input ']' expecting <EOF>"),
      );
      const ctx = createMockContext();

      const err = await service.countStudies({ queryTerm: 'foo ]' }, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data?.reason).toBe('query_parse_error');
    });

    it('surfaces exhausted 429 retries as rate_limited', async () => {
      // Zero retries: the retry loop itself is covered under error handling.
      const noRetry = new ClinicalTrialsService(testConfig, { ...fastOptions, maxRetries: 0 });
      mockFetch.mockResolvedValue(jsonResponse(null, 429));
      const ctx = createMockContext();

      const err = await noRetry.countStudies({ queryCond: 'asthma' }, ctx).catch((e) => e);
      expect((err as McpError).data?.reason).toBe('rate_limited');
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

    it('sizes the batch page to the ID count even past the page cap (#153)', async () => {
      // A page clamped below the ID count dropped every study past the cap, and
      // the results tool reported the missing ones as "Study not found".
      const smallCap = new ClinicalTrialsService({ ...testConfig, maxPageSize: 1 }, fastOptions);
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await smallCap.getStudiesBatch(['NCT12345678', 'NCT87654321'], ctx);

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
      // Without it a record fetched under a previous (alias) ID comes back keyed
      // only by its canonical ID, with nothing tying it to the request (#127).
      expect(fields).toContain('NCTIdAlias');
    });

    it('sends a full 20-ID results batch in a 393-byte request target, nowhere near the limit (#163)', async () => {
      // `/v2/studies` (11) + `?format=json` (12) + `&filter.ids=` (12) + 20 IDs
      // at 11 bytes with 19 `%7C` separators (277) + `&fields=` and five
      // pieces joined by `%7C` (69) + `&pageSize=20` (12) = 393 of 8,177.
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();
      const batch = ids(20);

      await service.getStudiesBatch(batch, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname.length + calledUrl.search.length).toBe(393);
      expect(calledUrl.searchParams.get('filter.ids')?.split('|')).toEqual(batch);
    });
  });

  /**
   * ClinicalTrials.gov answers a request target (path plus query string) past
   * 8,177 bytes with HTTP 414, whichever parameter carries the bytes. An ID
   * list is fitted to what is left; every other over-long request maps to the
   * typed request_too_long reason.
   */
  describe('request length (#163)', () => {
    const sentUrl = (call = 0) => new URL(mockFetch.mock.calls[call]![0] as string);
    const sentIds = (call = 0) => sentUrl(call).searchParams.get('filter.ids')?.split('|');
    /** The request target as the upstream front end counts it. */
    const targetBytes = (url: URL) => url.pathname.length + url.search.length;

    /**
     * `/v2/studies` (11) + `?format=json` (12) + `&query.term=` (12) + the pad
     * + `&filter.ids=` (12) + 11 bytes per ID and 3 (`%7C`) between IDs comes
     * to 44 + pad + 14 × IDs, and 256 of the 8,177 bytes stay reserved for the
     * paging parameters. So n IDs fit while pad + 14n ≤ 7877.
     */
    const fitted = (pad: number, count: number) => ({
      queryTerm: 'a'.repeat(pad),
      filterIds: ids(count),
      includeUnknownEnrollment: true,
    });
    /** A second instance, so a test's second request never waits out the first one's throttle slot. */
    const another = () => new ClinicalTrialsService(testConfig, fastOptions);

    it('sends the leading IDs that fit to the byte and returns the rest in order', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
      const result = await service.searchStudies(fitted(7737, 15), createMockContext());

      expect(sentIds()).toEqual(ids(10));
      expect(result.deferredIds).toEqual(ids(5, 10));
    });

    it('fits one ID fewer once the other parameters grow by a byte', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
      const result = await service.searchStudies(fitted(7738, 15), createMockContext());

      expect(sentIds()).toEqual(ids(9));
      expect(result.deferredIds).toEqual(ids(6, 9));
    });

    it('fits 563 of 1,000 IDs when nothing else is set, and defers nothing for 500', async () => {
      // 32 + 14n + 256 ≤ 8177 → n ≤ 563.
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
      const thousand = await service.searchStudies(
        { filterIds: ids(1000), includeUnknownEnrollment: true },
        createMockContext(),
      );
      const fiveHundred = await another().searchStudies(
        { filterIds: ids(500), includeUnknownEnrollment: true },
        createMockContext(),
      );

      expect(sentIds(0)).toEqual(ids(563));
      expect(thousand.deferredIds).toEqual(ids(437, 563));
      expect(sentIds(1)).toEqual(ids(500));
      expect(fiveHundred).not.toHaveProperty('deferredIds');
    });

    it('fits the same IDs on every page of a walk, whatever the paging parameters carry', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
      const ctx = createMockContext();
      await service.searchStudies({ ...fitted(7737, 15), pageSize: 10, countTotal: true }, ctx);
      // The widest paging parameters the reserve covers: a 214-character token
      // beside pageSize=1000 and countTotal=false lands exactly on 8,177.
      const last = await another().searchStudies(
        { ...fitted(7737, 15), pageSize: 1000, countTotal: false, pageToken: 't'.repeat(214) },
        ctx,
      );

      expect(sentIds(1)).toEqual(sentIds(0));
      expect(last.deferredIds).toEqual(ids(5, 10));
      expect(targetBytes(sentUrl(1))).toBe(8177);
    });

    it('fits on the fields as given, so field normalization never moves the fit between pages', async () => {
      /**
       * Normalization strips 17 bytes from these fields — ten leading spaces
       * (each encoded `+`) and two legacy labels renamed to the shorter
       * OverallStatus — room for an eleventh ID were the fit measured after it.
       * A page whose metadata lookup succeeds sends the normalized names, one
       * whose lookup fails sends them as given, and both must query the same
       * IDs: with the fields as given, pad + 14n ≤ 7815 fits 10.
       */
      const metadata: FieldNode[] = [
        {
          name: 'protocolSection',
          children: [
            {
              name: 'identificationModule',
              children: [{ name: 'nctId', piece: 'NCTId', type: 'STRING' }],
            },
            {
              name: 'statusModule',
              children: [{ name: 'overallStatus', piece: 'OverallStatus', type: 'ENUM' }],
            },
          ],
        },
      ];
      mockFetch.mockImplementation((url: URL) =>
        Promise.resolve(
          String(url).includes('/studies/metadata')
            ? jsonResponse(metadata)
            : jsonResponse({ studies: [] }),
        ),
      );
      const params = {
        ...fitted(7675, 15),
        fields: ['          NCTId', 'recruitmentstatus', 'recruitingstatus'],
      };

      // The metadata fetch takes the normalizing instance's first throttle
      // slot; fake timers stand in for the one-second wait before the search.
      vi.useFakeTimers();
      try {
        const normalizing = new ClinicalTrialsService(testConfig, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        const pending = normalizing.searchStudies(params, createMockContext());
        await vi.advanceTimersByTimeAsync(1000);
        await pending;
      } finally {
        vi.useRealTimers();
      }
      await service.searchStudies(params, createMockContext());

      const searches = mockFetch.mock.calls
        .map((c) => new URL(String(c[0])))
        .filter((u) => !u.pathname.endsWith('/metadata'));
      expect(searches.map((u) => u.searchParams.get('fields'))).toEqual([
        'NCTId|OverallStatus|OverallStatus',
        '          NCTId|recruitmentstatus|recruitingstatus',
      ]);
      expect(searches[0]?.searchParams.get('filter.ids')?.split('|')).toEqual(ids(10));
      expect(searches[1]?.searchParams.get('filter.ids')?.split('|')).toEqual(ids(10));
    });

    it('sends the first ID alone when the criteria leave no room for the paging reserve but the request fits', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));

      // One byte past the reserve's room for an ID, far inside the limit itself.
      const result = await service.searchStudies(fitted(7864, 3), createMockContext());

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentIds()).toEqual(ids(1));
      expect(targetBytes(sentUrl())).toBe(7922);
      expect(result.deferredIds).toEqual(ids(2, 1));
    });

    it('keeps that one-ID fit on every page and fails request_too_long when a token runs the page past the limit', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
      const ctx = createMockContext();

      // 8,058 bytes with one ID: a 100-character token still fits, a 200-character one does not.
      const short = await service.searchStudies(
        { ...fitted(8000, 3), pageToken: 't'.repeat(100) },
        ctx,
      );
      expect(sentIds()).toEqual(ids(1));
      expect(short.deferredIds).toEqual(ids(2, 1));

      const err = await another()
        .searchStudies({ ...fitted(8000, 3), pageToken: 't'.repeat(200) }, ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({
        reason: 'request_too_long',
        requestBytes: 8269,
        maxRequestBytes: 8177,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('fails request_too_long before any request when not even one ID fits the whole request', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
      const ctx = createMockContext();

      const err = await service.searchStudies(fitted(8120, 3), ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      expect((err as McpError).data).toMatchObject({
        reason: 'request_too_long',
        requestBytes: 8178,
        maxRequestBytes: 8177,
      });
      expect((err as McpError).message).toContain('None of the 3 NCT IDs');
      expect(mockFetch).not.toHaveBeenCalled();

      // A byte shorter, the first ID fits and the request goes out.
      const result = await another().searchStudies(fitted(8119, 3), ctx);
      expect(sentIds()).toEqual(ids(1));
      expect(targetBytes(sentUrl())).toBe(8177);
      expect(result.deferredIds).toEqual(ids(2, 1));
    });

    const NGINX_414 =
      '<html>\r\n<head><title>414 Request-URI Too Large</title></head>\r\n<body>\r\n<center><h1>414 Request-URI Too Large</h1></center>\r\n<hr><center>nginx/1.26.2</center>\r\n</body>\r\n</html>\r\n';

    it('maps an upstream 414 to request_too_long carrying the request size, never the upstream body', async () => {
      mockFetch.mockResolvedValue(textResponse(NGINX_414, 414));
      const ctx = createMockContext();

      const err = await service
        .searchStudies({ queryTerm: 'a'.repeat(9000), includeUnknownEnrollment: true }, ctx)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      // `/v2/studies` (11) + `?format=json` (12) + `&query.term=` (12) + 9,000.
      expect((err as McpError).data).toEqual({
        reason: 'request_too_long',
        requestBytes: 9035,
        maxRequestBytes: 8177,
      });
      expect((err as McpError).message).toContain('9035 bytes');
      expect((err as McpError).message).not.toContain('nginx');
      // A 414 is final: the same URL would fail the same way.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'countStudies',
        (s: ClinicalTrialsService) => s.countStudies({ queryTerm: 'a' }, createMockContext()),
      ],
      [
        'getFieldValues',
        (s: ClinicalTrialsService) => s.getFieldValues(['Phase'], createMockContext()),
      ],
    ] as const)('%s surfaces an upstream 414 as request_too_long', async (_name, call) => {
      mockFetch.mockResolvedValue(textResponse(NGINX_414, 414));
      const err = await call(service).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect(((err as McpError).data as Record<string, unknown>).reason).toBe('request_too_long');
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
      // Body that names no parameter — exercises the presence-based fallback.
      mockFetch.mockResolvedValue(textResponse('filter.ids has incorrect format for value XYZ'));

      const ctx = createMockContext();
      await expect(service.searchStudies({ filterIds: ['XYZ'] }, ctx)).rejects.toThrow(
        /not found or rejected by API: XYZ/,
      );
    });

    it('wraps bad AREA[] field name with the field_invalid reason', async () => {
      mockFetch.mockResolvedValue(
        textResponse('Error parsing query in advanced filter: Unknown area name: `NotARealField`'),
      );
      const ctx = createMockContext();
      try {
        await service.searchStudies({ filterAdvanced: 'AREA[NotARealField]value' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("'NotARealField'");
        expect(msg).toContain('clinicaltrials_get_field_definitions');
        const data = (err as McpError).data as Record<string, unknown>;
        expect(data?.reason).toBe('field_invalid');
        expect(data?.recovery).toBeUndefined();
      }
    });

    const queryParseErrorCtx = () =>
      createMockContext({
        errors: [
          {
            reason: 'query_parse_error',
            code: JsonRpcErrorCode.ValidationError,
            when: 'Free-text query rejected by upstream parser.',
            recovery:
              'Free-text fields take plain words plus AND/OR/NOT; reserved chars are [ ] ( ) ,',
          },
        ],
      });

    it('wraps Essie free-text parser error with the query_parse_error reason', async () => {
      // Combined shape (both a `no viable alternative` line and a `mismatched input`
      // line). `mismatched input` extraction takes precedence per the documented
      // order, so the offender is the reserved `[`; the grammar dump is stripped.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Other terms: no viable alternative at input 'rosuvastatin BCRP OATP1B1 ['\nmismatched input '[' expecting {<EOF>, '(', ','}",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryTerm: 'foo [diag:0]' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        // Offender extracted, grammar dump dropped.
        expect(msg).toContain("near '['");
        expect(msg).not.toContain('expecting {');
        expect(msg).not.toContain('StringLiteral');
        const data = (err as McpError).data as Record<string, unknown>;
        expect(data?.reason).toBe('query_parse_error');
        expect(data?.recovery).toBeUndefined();
      }
    });

    it('wraps the standalone `no viable alternative` shape without the grammar dump (#83)', async () => {
      // Standalone `no viable alternative` line — exercises that regex branch
      // directly (no `mismatched input` line to take precedence).
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Other terms: no viable alternative at input 'foo bar ['",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryTerm: 'foo bar [' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("near 'foo bar ['");
        expect(msg).not.toContain('expecting');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it('wraps the `mismatched input` bracket shape without the grammar dump (#83)', async () => {
      // Exact live-API string for a `[` in query.term — a 22-token grammar list.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Other terms: mismatched input '[' expecting {<EOF>, '(', ',', 'NOT', 'AND', 'OR', 'SEARCH', 'AREA', 'RANGE', 'DISTANCE', Coverage, Expansion, 'TILT', 'ALL', 'MISSING', 'MIN', 'MAX', EscapedKeyword, BooleanLiteral, DecimalLiteral, DateLiteral, TimeLiteral, RadiusLiteral, StringLiteral, Term}",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryTerm: 'diabetes [bracket]' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("near '['");
        // The bracket rule states where brackets ARE valid, and that the
        // free-text params accept AREA[]/RANGE[] too (#94-C).
        expect(msg).toContain('AREA[FieldName]value');
        expect(msg).toContain('as well as advancedFilter');
        expect(msg).not.toContain('reserved for advancedFilter AREA[]');
        expect(msg).not.toContain('expecting {');
        expect(msg).not.toContain('StringLiteral');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it("reports the unclosed delimiter, not the expected token, for `missing 'X' at` (#94-A)", async () => {
      // Live-API string for an unbalanced `(` in query.term. ANTLR quotes the
      // token it WANTED, so `)` is absent from the input — naming it as the
      // offender points at a character the caller never typed.
      mockFetch.mockResolvedValue(
        textResponse("Error parsing query in Other terms: missing ')' at '<EOF>'"),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryTerm: 'diabetes (unmatched' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("missing a closing ')'");
        expect(msg).not.toContain("near ')'");
        expect(msg).not.toContain('expecting');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it("names the offending token for `extraneous input 'X'` (#94-B)", async () => {
      // Live-API string for a trailing stray `)` in query.cond — a shape none of
      // the #83 regexes matched, so it fell to the token-less generic message.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Conditions or disease: extraneous input ')' expecting <EOF>",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: 'diabetes)' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("near ')'");
        expect(msg).not.toContain('the upstream parser rejected the query');
        // A paren offender gets the paren rule, not the bracket rule.
        expect(msg).toContain('Parentheses only group sub-expressions');
        expect(msg).not.toContain('AREA[FieldName]value');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it("names the opening bracket for the two-line `extraneous input '['` shape (#94-B)", async () => {
      // Live-API body for `[diabetes]` — upstream emits one line per stray
      // bracket. The opening `[` is the informative one, so it must win.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Conditions or disease: extraneous input '[' expecting {<EOF>, '(', ',', 'NOT', 'SEARCH', 'AREA', 'RANGE', 'DISTANCE', Coverage, Expansion, 'TILT', 'ALL', 'MISSING', 'MIN', 'MAX', EscapedKeyword, BooleanLiteral, DecimalLiteral, DateLiteral, TimeLiteral, RadiusLiteral, StringLiteral, Term}\nextraneous input ']' expecting <EOF>",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: '[diabetes]' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain("near '['");
        expect(msg).not.toContain("near ']'");
        expect(msg).not.toContain('expecting {');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it("treats `mismatched input '<EOF>' expecting 'X'` as an unclosed delimiter (#94-A)", async () => {
      // Live-API string for an unclosed AREA[ — `<EOF>` is a position, not a
      // token, so it never makes a usable offender.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Conditions or disease: mismatched input '<EOF>' expecting ']'",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: 'AREA[Phase' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain("ends before its closing ']'");
        expect(msg).not.toContain("near '<EOF>'");
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it("treats a grammar-dump `mismatched input '<EOF>'` as an unclosed delimiter (#94-A)", async () => {
      // Live-API string for `(a OR (b` — same unclosed condition, but upstream
      // lists a token set instead of naming one expected delimiter.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Conditions or disease: mismatched input '<EOF>' expecting {'(', ')', ',', 'NOT', 'AND', 'OR', 'SEARCH', 'AREA', StringLiteral, Term}",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: '(a OR (b' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain('ends mid-expression');
        expect(msg).not.toContain("near '<EOF>'");
        expect(msg).not.toContain('StringLiteral');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it('names the unparseable literal for a token-recognition error', async () => {
      // Live-API string for an unterminated quote in query.cond — a fourth shape
      // that also fell to the generic message.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Conditions or disease: token recognition error at: '\"unterminated'",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: '"unterminated' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as McpError).message).toContain("near '\"unterminated'");
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it('preserves an unrecognized upstream explanation instead of replacing it', async () => {
      // Live-API string for `RANGE[1, 2]` in query.cond. It matches no ANTLR
      // shape but says something specific — discarding it for a generic sentence
      // loses the only actionable detail in the response.
      mockFetch.mockResolvedValue(
        textResponse(
          'Error parsing query in Conditions or disease: RANGE is not supported for multiple (7) fields',
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: 'RANGE[1, 2]' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain('RANGE is not supported for multiple (7) fields');
        expect(msg).not.toContain('Error parsing query in');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it('applies the same parse-error shaping to an alternate free-text param (conditionQuery parity, #83)', async () => {
      // The catch-all is shared by every free-text param; conditionQuery routes
      // through the identical 400 path with a different `where` prefix.
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Conditions or disease: mismatched input '[' expecting {<EOF>, '(', ',', 'NOT', 'AND', 'OR'}",
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: 'diabetes [bracket]' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("near '['");
        expect(msg).not.toContain('expecting {');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
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

    // ClinicalTrials.gov answers a rejected cursor with one of two 400 bodies,
    // captured verbatim: a token it never issued (invented, truncated, edited)
    // and one issued before a data refresh.
    describe('rejected pageToken (#148)', () => {
      const MALFORMED_BODY = 'Incorrect pageToken format';
      const EXPIRED_BODY =
        'The data have probably changed while you were paginating. Please, start over from the first page.';

      it('classifies the malformed-token body as page_token_invalid', async () => {
        mockFetch.mockResolvedValue(textResponse(MALFORMED_BODY));
        const ctx = createMockContext();

        const err = await service
          .searchStudies({ queryCond: 'ALS', pageToken: 'invalidtoken' }, ctx)
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        expect((err as McpError).data).toMatchObject({ reason: 'page_token_invalid' });
        expect((err as McpError).message).toMatch(/malformed/i);
        expect((err as McpError).message).not.toMatch(/expired/i);
        // A 400 is terminal — the same token never succeeds on retry.
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('classifies the data-changed body as page_token_invalid naming both causes', async () => {
        mockFetch.mockResolvedValue(textResponse(EXPIRED_BODY));
        const ctx = createMockContext();

        const err = await service
          .searchStudies(
            {
              filterIds: ['NCT03722472'],
              pageSize: 5,
              pageToken: 'ZVt07cGHkvI2wRk2CJf6_LLqwNCYItMod7KrgP4Znj6avPo1IQ',
            },
            ctx,
          )
          .catch((e: unknown) => e);

        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        expect((err as McpError).data).toMatchObject({ reason: 'page_token_invalid' });
        // Upstream sends this body for a token issued before a data refresh and
        // also for a fresh token altered by one character, so the message names
        // both causes rather than asserting expiry.
        expect((err as McpError).message).toBe(
          'ClinicalTrials.gov cannot resume pagination from this pageToken: it was issued before a data refresh, or it was altered after it was issued.',
        );
        expect((err as McpError).message).not.toMatch(/expired|malformed/i);
      });

      it.each([
        ['malformed', MALFORMED_BODY],
        ['expired', EXPIRED_BODY],
      ])('leaves the %s body unclassified when no pageToken was sent', async (_, body) => {
        mockFetch.mockResolvedValue(textResponse(body));
        const ctx = createMockContext();

        const err = await service.searchStudies({ queryCond: 'ALS' }, ctx).catch((e: unknown) => e);

        // Unclassified: the generic validation error relaying the upstream body,
        // with no reason for any contract to key a recovery hint on.
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        expect((err as McpError).message).toBe(body);
        expect(
          ((err as McpError).data as Record<string, unknown> | undefined)?.reason,
        ).toBeUndefined();
      });

      it('keeps sort_invalid classification when the request also carried a pageToken', async () => {
        mockFetch.mockResolvedValue(
          textResponse('Item 1 in parameter `sort` has incorrect format'),
        );
        const ctx = createMockContext();

        await expect(
          service.searchStudies({ queryCond: 'ALS', sort: 'Bogus', pageToken: 'tok_page2' }, ctx),
        ).rejects.toMatchObject({ data: { reason: 'sort_invalid', value: 'Bogus' } });
      });
    });

    it('throws RequestCancelled on request cancellation', async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx = createMockContext({ signal: controller.signal });

      await expect(service.getStudy('NCT12345678', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });
      expect(mockFetch).not.toHaveBeenCalled();
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

    it('does not retry an AbortError raised by the caller going away', async () => {
      const controller = new AbortController();
      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      mockFetch.mockImplementation(async () => {
        controller.abort();
        throw abortError;
      });

      const ctx = createMockContext({ signal: controller.signal });
      await expect(service.getStudy('NCT12345678', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

  describe('request throttling (#92)', () => {
    // MIN_INTERVAL_MS in the service. Held as a local literal rather than
    // exported — the spacing between outbound requests is what callers observe,
    // and asserting it here keeps the constant private.
    const MIN_INTERVAL_MS = 1000;
    // setTimeout resolution can land a hair under the requested delay; the
    // defect this guards produced ~0ms gaps, so a few ms of slack costs nothing.
    const TOLERANCE_MS = 10;

    function recordFireTimes(): number[] {
      const fired: number[] = [];
      mockFetch.mockImplementation(() => {
        fired.push(Date.now());
        return Promise.resolve(jsonResponse({ studies: [] }));
      });
      return fired;
    }

    it('spaces three concurrent callers at least MIN_INTERVAL_MS apart', async () => {
      const fired = recordFireTimes();
      const ctx = createMockContext();

      await Promise.all([
        service.searchStudies({ queryCond: 'a' }, ctx),
        service.searchStudies({ queryCond: 'b' }, ctx),
        service.searchStudies({ queryCond: 'c' }, ctx),
      ]);

      expect(fired).toHaveLength(3);
      // Each caller used to read the same lastRequestAt, compute the same wait,
      // sleep in parallel, and fire simultaneously — the gaps were ~0ms.
      const gaps = fired.slice(1).map((t, i) => t - fired[i]!);
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - TOLERANCE_MS);
      }
    }, 15_000);

    it('queues a caller that arrives while another is already waiting', async () => {
      const fired = recordFireTimes();
      const ctx = createMockContext();

      // First call fires immediately (no prior request), second waits out the
      // interval. The third is issued mid-wait and must land behind it rather
      // than sharing the second's slot.
      const first = service.searchStudies({ queryCond: 'a' }, ctx);
      const second = service.searchStudies({ queryCond: 'b' }, ctx);
      await first;
      const third = service.searchStudies({ queryCond: 'c' }, ctx);
      await Promise.all([second, third]);

      expect(fired).toHaveLength(3);
      expect(fired[2]! - fired[1]!).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - TOLERANCE_MS);
    }, 15_000);

    it('does not wedge the queue when a request fails', async () => {
      mockFetch
        .mockResolvedValueOnce(textResponse('Bad request body'))
        .mockResolvedValue(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      await expect(service.getStudy('NCT12345678', ctx)).rejects.toThrow(McpError);
      // A rejected request must still release its slot so later callers proceed.
      await expect(service.searchStudies({ queryCond: 'a' }, ctx)).resolves.toMatchObject({
        studies: [],
      });
    }, 15_000);
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
    // The service sets `data.reason` and leaves `data.recovery` to the framework,
    // which fills it from the tool or resource contract declaring that reason.
    // These tests attach a synthetic contract covering every reason the service
    // throws and assert the service itself still attaches no hint — a direct
    // service call never reaches the fill. The hint on the wire is asserted
    // through `runToolContract` in tool-contract.test.ts.
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
        reason: 'enum_invalid' as const,
        code: JsonRpcErrorCode.ValidationError,
        when: 'statusFilter or phaseFilter value not accepted.',
        recovery:
          'Call clinicaltrials_get_field_values with fields=["OverallStatus"] to see valid values.',
      },
      {
        reason: 'geo_invalid' as const,
        code: JsonRpcErrorCode.ValidationError,
        when: 'geoFilter is not a well-formed distance() expression.',
        recovery:
          'Build geoFilter as distance(lat,lon,radius) with a mi or km suffix on the radius.',
      },
      {
        reason: 'sort_invalid' as const,
        code: JsonRpcErrorCode.ValidationError,
        when: 'sort is not FieldName:asc or FieldName:desc.',
        recovery:
          'Set sort to FieldName:asc or FieldName:desc, at most two fields comma-separated.',
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

    it('attaches reason=study_not_found, leaving recovery to the contract, on 404 /studies/', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.getStudy('NCT12345678', ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('study_not_found');
        expect(data?.recovery).toBeUndefined();
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
        expect(data?.recovery).toBeUndefined();
      }
    });

    it('attaches reason=ids_not_found for filter.ids rejection', async () => {
      // Verbatim live-API body, which names the parameter in backticks.
      mockFetch.mockResolvedValue(
        textResponse('Item 1 in parameter `filter.ids` has incorrect format'),
      );
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ filterIds: ['XYZ'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('ids_not_found');
        expect(data?.recovery).toBeUndefined();
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
        expect(data?.recovery).toBeUndefined();
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
        expect(data?.recovery).toBeUndefined();
      }
    });

    it('attaches reason=enum_invalid + param/value/recovery on a 400 invalid status value (#57)', async () => {
      mockFetch.mockResolvedValue(
        textResponse('Invalid value in parameter `overallStatus`: `BADSTATUS`'),
      );
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ filterOverallStatus: ['BADSTATUS'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('enum_invalid');
        expect(data?.param).toBe('statusFilter');
        expect(data?.value).toBe('BADSTATUS');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toContain('OverallStatus');
      }
    });

    // phaseFilter entries are validated in the tool handlers before any request
    // (#144), so this upstream rejection can only come from the caller's own
    // AREA[Phase] expression in advancedFilter or a query parameter — naming
    // phaseFilter would send the caller to a parameter they never set.
    it('translates the Essie phase enum error to a message naming the AREA[Phase] expression (#71, #144)', async () => {
      mockFetch.mockResolvedValue(
        textResponse(
          'Error parsing query in advanced filter: Allowed values for enum field `protocolSection.designModule.phases` are `NA`, `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`',
        ),
      );
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ filterAdvanced: 'AREA[Phase]PHASE5' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        const msg = (err as McpError).message;
        expect(msg).toBe(
          'Invalid value in an `AREA[Phase]` expression. Valid values: NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4.',
        );
        expect(msg).not.toContain('phaseFilter');
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('enum_invalid');
        expect(data).not.toHaveProperty('param');
        expect(data?.validValues).toEqual([
          'NA',
          'EARLY_PHASE1',
          'PHASE1',
          'PHASE2',
          'PHASE3',
          'PHASE4',
        ]);
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toBe(
          'Use one of the valid values inside AREA[Phase]: NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4.',
        );
      }
    });

    it('names an enum field it has no AREA[] spelling for by its upstream path, with no param', async () => {
      mockFetch.mockResolvedValue(
        textResponse(
          'Error parsing query in advanced filter: Allowed values for enum field `protocolSection.designModule.studyType` are `EXPANDED_ACCESS`, `INTERVENTIONAL`, `OBSERVATIONAL`',
        ),
      );
      const ctx = createMockContext({ errors: allReasons });
      const err = await service
        .searchStudies({ filterAdvanced: 'AREA[StudyType]FOO' }, ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toBe(
        'Invalid value in an AREA[] expression for enum field `protocolSection.designModule.studyType`. Valid values: EXPANDED_ACCESS, INTERVENTIONAL, OBSERVATIONAL.',
      );
      const data = (err as McpError).data as Record<string, unknown>;
      expect(data.reason).toBe('enum_invalid');
      expect(data).not.toHaveProperty('param');
    });

    it('translates sort "incorrect format" error to param-named message with format hint (#71)', async () => {
      mockFetch.mockResolvedValue(textResponse('Item 1 in parameter `sort` has incorrect format'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ sort: 'EnrollmentCount:descending' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain('sort');
        expect(msg).toContain('EnrollmentCount:descending');
        expect(msg).toContain('FieldName:asc');
        expect(msg).toContain('FieldName:desc');
        // sort was the one validation error arriving with no Recovery: line (#93);
        // the typed reason is what lets the contract's hint reach it.
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('sort_invalid');
        expect(data?.recovery).toBeUndefined();
      }
    });

    it('translates the "Unknown sort field" rejection to the sort_invalid contract (#107)', async () => {
      // Upstream answers a bad sort field name with a bare body that names no
      // parameter, so it matched none of the 400 branches and reached the caller
      // as untyped text — no reason, no recovery, no statement of the shape.
      mockFetch.mockResolvedValue(textResponse('Unknown sort field'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ sort: 'Bogus:desc' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        const msg = (err as McpError).message;
        expect(msg).toContain('sort');
        expect(msg).toContain("'Bogus:desc'");
        expect(msg).toContain('FieldName:asc');
        expect(msg).toContain('FieldName:desc');
        expect(msg).toContain('clinicaltrials_get_field_definitions');
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('sort_invalid');
        expect(data?.value).toBe('Bogus:desc');
        expect(data?.recovery).toBeUndefined();
      }
    });

    it('translates a directionless "Unknown sort field" rejection the same way (#107)', async () => {
      // `EnrollmentCount descending` (no colon) reaches upstream as one opaque
      // field name and draws the same body.
      mockFetch.mockResolvedValue(textResponse('Unknown sort field'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ sort: 'EnrollmentCount descending' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('sort_invalid');
        expect((err as McpError).message).toContain("'EnrollmentCount descending'");
      }
    });

    it('translates the 2-item cap rejection and states the cap (#107)', async () => {
      // Upstream names `sort` in backticks here, but through a phrase the
      // `incorrect format` branch never sees.
      mockFetch.mockResolvedValue(
        textResponse('Parameter `sort` must contain no more than 2 items'),
      );
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ sort: 'A:desc,B:desc,C:desc' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain("'A:desc,B:desc,C:desc'");
        expect(msg).toContain('3');
        expect(msg).toContain('2');
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('sort_invalid');
      }
    });

    it('translates the "Unsupported sort field type" rejection for a real but unsortable field (#107)', async () => {
      // BriefTitle is a valid piece name that upstream refuses to sort on, so
      // no field-name index can catch it ahead of the call.
      mockFetch.mockResolvedValue(textResponse('Unsupported sort field type: text'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ sort: 'BriefTitle:desc' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain("'BriefTitle:desc'");
        expect(msg).toContain('text');
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('sort_invalid');
      }
    });

    it('leaves an unrelated 400 body on the generic tail rather than blaming sort (#107)', async () => {
      // The sort branch keys on sort-specific bodies, not merely on a sort being
      // present — an unrelated rejection must not be relabelled sort_invalid.
      mockFetch.mockResolvedValue(textResponse('Something else went wrong'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ sort: 'LastUpdatePostDate:desc' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBeUndefined();
        expect((err as McpError).message).toContain('Something else went wrong');
      }
    });

    it('names geoFilter and its shape on a filter.geo "incorrect format" rejection (#93)', async () => {
      // Live-API body for every malformed geoFilter value.
      mockFetch.mockResolvedValue(textResponse('Parameter `filter.geo` has incorrect format'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({ filterGeo: 'near Seattle' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
        const msg = (err as McpError).message;
        expect(msg).toContain('geoFilter');
        expect(msg).toContain("'near Seattle'");
        expect(msg).toContain('distance(lat,lon,radius)');
        // A bare radius is accepted upstream but read as meters, so the suffix is
        // stated as required rather than optional.
        expect(msg).toContain('meters');
        // The raw upstream body no longer passes through verbatim.
        expect(msg).not.toContain('Invalid request format');
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('geo_invalid');
        expect(data?.recovery).toBeUndefined();
      }
    });

    it('blames the parameter upstream names when a bad geoFilter rides with a valid sort (#93)', async () => {
      // Upstream answers this pair by naming filter.geo only. Inferring the
      // offender from which params were sent would report a sort error for a
      // perfectly good sort value.
      mockFetch.mockResolvedValue(textResponse('Parameter `filter.geo` has incorrect format'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies(
          { filterGeo: 'near Seattle', sort: 'LastUpdatePostDate:desc' },
          ctx,
        );
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('geo_invalid');
        expect((err as McpError).message).not.toContain('LastUpdatePostDate');
      }
    });

    it('blames sort when upstream names sort and a geoFilter is also present (#93)', async () => {
      mockFetch.mockResolvedValue(textResponse('Item 1 in parameter `sort` has incorrect format'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies(
          { filterGeo: 'distance(47.6062,-122.3321,50mi)', sort: 'EnrollmentCount:descending' },
          ctx,
        );
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('sort_invalid');
      }
    });

    it('dead code: "Invalid value in parameter `phase`" never fires (phase always routes through filter.advanced)', async () => {
      // Verify the upstreamParamInfo no longer has a `phase` entry — the API
      // only uses filter.advanced (AREA[Phase]) so this error shape never
      // appears in practice. The test confirms the removed mapping doesn't
      // silently restore itself.
      mockFetch.mockResolvedValue(textResponse('Invalid value in parameter `phase`: `PHASE5`'));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await service.searchStudies({}, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        // Should still surface as enum_invalid but WITHOUT a `param` entry
        // since the `phase` upstream key is no longer in upstreamParamInfo.
        expect(data?.reason).toBe('enum_invalid');
        expect(data?.param).toBeUndefined();
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
        expect(data?.recovery).toBeUndefined();
      }
    }, 30_000);

    it('omits recovery.hint when no contract is attached (service stays contract-agnostic)', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));
      const ctx = createMockContext();
      try {
        await service.getStudy('NCT12345678', ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('study_not_found');
        expect(data?.recovery).toBeUndefined();
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

    /**
     * Answer each endpoint by its path: both metadata reads with `metadata`, the
     * search-areas read with SEARCH_AREAS, the search and the field-values read
     * with `primary`; anything else is an unmocked request.
     */
    function mockByRoute(routes: { metadata?: unknown; primary?: unknown } = {}) {
      mockFetch.mockImplementation((url: string | URL) => {
        const { pathname } = new URL(String(url));
        if (pathname === '/v2/studies/metadata') {
          return Promise.resolve(routes.metadata ?? jsonResponse(sampleMetadata));
        }
        if (pathname === '/v2/studies/search-areas') {
          return Promise.resolve(jsonResponse(SEARCH_AREAS));
        }
        if (pathname === '/v2/studies' || pathname === '/v2/stats/field/values') {
          return Promise.resolve(routes.primary ?? jsonResponse({ studies: [] }));
        }
        return Promise.reject(new Error('unmocked fetch'));
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

    it('case-folds a sort field name before the request, the way fields are (#107)', async () => {
      // `fields` has had this since #44; `sort` reached upstream raw and drew an
      // `Unknown sort field` rejection for a pure casing mistake.
      mockByRoute();
      const ctx = createMockContext();
      await validatingService.searchStudies({ sort: 'enrollmentCount:desc' }, ctx);

      const studiesCall = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => !u.includes('/studies/metadata'));
      expect(new URL(studiesCall!).searchParams.get('sort')).toBe('EnrollmentCount:desc');
    });

    it('trims the whitespace upstream rejects around a sort item (#107)', async () => {
      // ClinicalTrials.gov answers `A:desc, B:asc` with "Item 2 in parameter
      // `sort` has incorrect format" — the space is the whole defect.
      mockByRoute();
      const ctx = createMockContext();
      await validatingService.searchStudies({ sort: ' NCTId:asc, briefTitle:desc' }, ctx);

      const studiesCall = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => !u.includes('/studies/metadata'));
      expect(new URL(studiesCall!).searchParams.get('sort')).toBe('NCTId:asc,BriefTitle:desc');
    });

    it('lowercases an ASC/DESC direction suffix (#107)', async () => {
      // Upstream accepts only lowercase; `EnrollmentCount:DESC` is rejected.
      mockByRoute();
      const ctx = createMockContext();
      await validatingService.searchStudies({ sort: 'EnrollmentCount:DESC' }, ctx);

      const studiesCall = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => !u.includes('/studies/metadata'));
      expect(new URL(studiesCall!).searchParams.get('sort')).toBe('EnrollmentCount:desc');
    });

    it('leaves @relevance and an unrecognized sort field untouched (#107)', async () => {
      // The index knows which pieces exist, not which upstream will sort on, so
      // normalization never rejects — it only applies exact, ambiguity-free
      // fixes and lets upstream judge the rest. `@relevance` names no field.
      mockByRoute();
      const ctx = createMockContext();
      await validatingService.searchStudies({ sort: '@relevance' }, ctx);
      const first = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => !u.includes('/studies/metadata'));
      expect(new URL(first!).searchParams.get('sort')).toBe('@relevance');

      mockFetch.mockClear();
      mockByRoute();
      // An unrecognized name also reads the index-only and search-area sources
      // first (#179); fake timers stand in for the throttle's gaps between them.
      const next = createMockContext();
      vi.useFakeTimers();
      try {
        const sent = validatingService.searchStudies({ sort: 'Bogus:desc' }, next);
        await vi.advanceTimersByTimeAsync(10_000);
        await sent;
      } finally {
        vi.useRealTimers();
      }
      const paths = mockFetch.mock.calls.map(([u]) => {
        const url = new URL(String(u));
        return `${url.pathname}${url.searchParams.has('includeIndexedOnly') ? '?indexed' : ''}`;
      });
      // The field index is cached from the first call; the second tier is read,
      // and loads, before the search goes out with the name as written.
      expect(paths).toEqual([
        '/v2/studies/metadata?indexed',
        '/v2/studies/search-areas',
        '/v2/studies',
      ]);
      expect(
        (next.log as unknown as { calls: Array<{ level: string }> }).calls.filter(
          (c) => c.level === 'warning',
        ),
      ).toEqual([]);
      const second = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => new URL(u).pathname === '/v2/studies');
      expect(new URL(second!).searchParams.get('sort')).toBe('Bogus:desc');
    });

    it('offers did-you-mean suggestions on an unknown sort field name (#107)', async () => {
      // The same nearestPieces machinery an invalid `fields` entry gets.
      mockByRoute({ primary: textResponse('Unknown sort field') });
      const ctx = createMockContext();
      try {
        await validatingService.searchStudies({ sort: 'Enrolment:desc' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain('did you mean');
        expect(msg).toContain("'EnrollmentCount'");
        expect((err as McpError).data).toMatchObject({ reason: 'sort_invalid' });
      }
    });

    it('omits the did-you-mean clause when nothing is close to the bad field (#112)', async () => {
      // 'Bogus' shares no token and no meaningful edit distance with any piece.
      // Naming three unrelated fields sent the caller after a name the scorer
      // had no reason to propose; the bare header plus the recovery hint is the
      // honest answer.
      mockByRoute();
      const ctx = createMockContext();
      try {
        await validatingService.searchStudies({ fields: ['Bogus'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const error = err as McpError;
        expect(error.message).toBe("Invalid field name: 'Bogus'.");
        expect(error.message).not.toContain('did you mean');
        const data = error.data as Record<string, unknown>;
        expect(data.reason).toBe('field_invalid');
        expect(data.invalid).toEqual(['Bogus']);
        expect(data.suggestions).toBeUndefined();
      }
    });

    it('omits the blame clause on an unknown sort field with no close piece (#112)', async () => {
      // #107 gave nearestPieces a second consumer. Not every piece is sortable,
      // so an unrelated suggestion here costs a caller two failures: the field
      // name, then `Unsupported sort field type`.
      mockByRoute({ primary: textResponse('Unknown sort field') });
      const ctx = createMockContext();
      try {
        await validatingService.searchStudies({ sort: 'Bogus:desc' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).not.toContain('did you mean');
        expect(msg).toContain('does not recognize the sort field name.');
        expect(msg).toContain('clinicaltrials_get_field_definitions');
        expect((err as McpError).data).toMatchObject({ reason: 'sort_invalid' });
      }
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

    it('silently normalizes case-only field-name mismatches before validation', async () => {
      mockByRoute();
      const ctx = createMockContext();
      // `nctid` and `BRIEFTITLE` both have unambiguous case-folded canonicals
      // in the sample metadata. Should pass through without throwing.
      const result = await validatingService.searchStudies(
        { fields: ['nctid', 'BRIEFTITLE'] },
        ctx,
      );
      expect(result.studies).toEqual([]);
      // Confirm the upstream call used the canonical names.
      const studiesCall = mockFetch.mock.calls.find((c) => {
        const u = typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
        return u.includes('/studies') && !u.includes('/metadata');
      });
      expect(studiesCall).toBeDefined();
      const url = new URL(studiesCall![0] as string);
      expect(url.searchParams.get('fields')).toBe('NCTId|BriefTitle');
    });

    it('silently strips leading/trailing whitespace before validation', async () => {
      mockByRoute();
      const ctx = createMockContext();
      const result = await validatingService.searchStudies(
        { fields: [' NCTId ', 'BriefTitle\t'] },
        ctx,
      );
      expect(result.studies).toEqual([]);
      const studiesCall = mockFetch.mock.calls.find((c) => {
        const u = typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
        return u.includes('/studies') && !u.includes('/metadata');
      });
      const url = new URL(studiesCall![0] as string);
      expect(url.searchParams.get('fields')).toBe('NCTId|BriefTitle');
    });

    it('still throws on truly invalid names that are not case- or whitespace-correctable', async () => {
      mockByRoute();
      const ctx = createMockContext();
      await expect(
        validatingService.searchStudies({ fields: ['BriefSubtitle'] }, ctx),
      ).rejects.toThrow(/Invalid field name: 'BriefSubtitle'/);
    });

    it('auto-corrects a colloquial alias to its canonical piece (#60)', async () => {
      // "RecruitmentStatus" is the CT.gov UI label for the OverallStatus enum but
      // is not a v2 piece name. The rename map rewrites it before validation, like
      // the case/whitespace fixes, so the call succeeds instead of erroring.
      const metadata: FieldNode[] = [
        {
          name: 'protocolSection',
          children: [
            {
              name: 'statusModule',
              children: [{ name: 'overallStatus', piece: 'OverallStatus', type: 'STRING' }],
            },
          ],
        },
      ];
      mockByRoute({ metadata: jsonResponse(metadata), primary: jsonResponse([]) });
      const ctx = createMockContext();

      await validatingService.getFieldValues(['RecruitmentStatus'], ctx);

      const valuesCall = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => u.includes('/stats/field/values'));
      expect(valuesCall).toBeDefined();
      expect(new URL(valuesCall!).searchParams.get('fields')).toBe('OverallStatus');
    });

    // Metadata fixture covering every cardinality shape the flag must read:
    // an array-typed piece (Phase → Phase[], #85), a scalar piece with no
    // repeated ancestor (OverallStatus → Status), a scalar piece one array
    // ancestor deep (LocationCountry under Location[], #121), and one two
    // array ancestors deep (LocationContactName under Contact[] under
    // Location[]). Mirrors the live tree's shapes.
    const cardinalityMetadata: FieldNode[] = [
      {
        name: 'protocolSection',
        children: [
          {
            name: 'statusModule',
            children: [{ name: 'overallStatus', piece: 'OverallStatus', type: 'Status' }],
          },
          {
            name: 'designModule',
            children: [{ name: 'phases', piece: 'Phase', type: 'Phase[]', isEnum: true }],
          },
          {
            name: 'contactsLocationsModule',
            children: [
              {
                name: 'locations',
                piece: 'Location',
                type: 'Location[]',
                children: [
                  { name: 'country', piece: 'LocationCountry', type: 'text' },
                  {
                    name: 'contacts',
                    piece: 'LocationContact',
                    type: 'Contact[]',
                    children: [{ name: 'name', piece: 'LocationContactName', type: 'text' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    it('flags array-typed fields as multiValued, leaving scalar fields unflagged (#85)', async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          return Promise.resolve(jsonResponse(cardinalityMetadata));
        }
        // /stats/field/values response — type here is the value domain, not the
        // array marker, so multiValued must come from the metadata node type.
        return Promise.resolve(
          jsonResponse([
            { field: 'Phase', piece: 'Phase', type: 'ENUM', missingStudiesCount: 139770 },
            {
              field: 'OverallStatus',
              piece: 'OverallStatus',
              type: 'ENUM',
              missingStudiesCount: 0,
            },
          ]),
        );
      });
      const ctx = createMockContext();

      const result = await validatingService.getFieldValues(['Phase', 'OverallStatus'], ctx);

      const phase = result.find((s) => s.piece === 'Phase');
      const status = result.find((s) => s.piece === 'OverallStatus');
      expect(phase?.multiValued).toBe(true);
      // Scalar field: flag is absent (not set to false).
      expect(status?.multiValued).toBeUndefined();
    });

    // A scalar leaf under a repeated object occurs once per repetition, so its
    // value buckets sum above the study total exactly as an array leaf's do —
    // the leaf's own type is not the cardinality signal (#121).
    it('flags a scalar field nested under an array-typed ancestor as multiValued (#121)', async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          return Promise.resolve(jsonResponse(cardinalityMetadata));
        }
        return Promise.resolve(
          jsonResponse([
            {
              field: 'protocolSection.contactsLocationsModule.locations.country',
              piece: 'LocationCountry',
              type: 'STRING',
              missingStudiesCount: 60566,
              uniqueValuesCount: 226,
              topValues: [{ value: 'United States', studiesCount: 300000 }],
            },
          ]),
        );
      });
      const ctx = createMockContext();

      const result = await validatingService.getFieldValues(['LocationCountry'], ctx);
      expect(result[0]?.multiValued).toBe(true);
    });

    it('flags a field two array-typed ancestors deep (#121)', async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          return Promise.resolve(jsonResponse(cardinalityMetadata));
        }
        return Promise.resolve(
          jsonResponse([
            {
              field: 'protocolSection.contactsLocationsModule.locations.contacts.name',
              piece: 'LocationContactName',
              type: 'STRING',
              missingStudiesCount: 1,
            },
          ]),
        );
      });
      const ctx = createMockContext();

      const result = await validatingService.getFieldValues(['LocationContactName'], ctx);
      expect(result[0]?.multiValued).toBe(true);
    });

    it('leaves the provider counts byte-for-byte unchanged when flagging (#121)', async () => {
      const upstream = {
        field: 'protocolSection.contactsLocationsModule.locations.country',
        piece: 'LocationCountry',
        type: 'STRING',
        missingStudiesCount: 60566,
        uniqueValuesCount: 226,
        topValues: [
          { value: 'United States', studiesCount: 300000 },
          { value: 'France', studiesCount: 40000 },
        ],
      };
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          return Promise.resolve(jsonResponse(cardinalityMetadata));
        }
        return Promise.resolve(jsonResponse([structuredClone(upstream)]));
      });
      const ctx = createMockContext();

      const result = await validatingService.getFieldValues(['LocationCountry'], ctx);
      // Only multiValued is added; every provider-supplied number survives.
      expect(result[0]).toEqual({ ...upstream, multiValued: true });
    });

    it('keeps a field with no array-typed ancestor at any depth unflagged (#121)', async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          return Promise.resolve(jsonResponse(cardinalityMetadata));
        }
        return Promise.resolve(
          jsonResponse([
            {
              field: 'protocolSection.statusModule.overallStatus',
              piece: 'OverallStatus',
              type: 'ENUM',
              missingStudiesCount: 0,
            },
          ]),
        );
      });
      const ctx = createMockContext();

      const result = await validatingService.getFieldValues(['OverallStatus'], ctx);
      expect(result[0]?.multiValued).toBeUndefined();
    });

    it('does not flag multiValued when the metadata index is unreachable (#85 fail-open)', async () => {
      mockFetch.mockImplementation((url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/studies/metadata')) {
          return Promise.resolve(jsonResponse(null, 404));
        }
        return Promise.resolve(
          jsonResponse([{ field: 'Phase', piece: 'Phase', type: 'ENUM', missingStudiesCount: 0 }]),
        );
      });
      const ctx = createMockContext();

      const result = await validatingService.getFieldValues(['Phase'], ctx);
      expect(result[0]?.multiValued).toBeUndefined();
    });

    it('attaches reason=field_invalid on validation failure, leaving recovery to the contract', async () => {
      mockByRoute();
      const ctx = createMockContext();
      try {
        await validatingService.searchStudies({ fields: ['Bogus'] }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown>;
        expect(data?.reason).toBe('field_invalid');
        expect(Array.isArray(data?.invalid)).toBe(true);
        expect(data?.recovery).toBeUndefined();
      }
    });
  });

  describe('AREA[] field names (#170)', () => {
    const parseError = (detail: string, where = 'advanced filter') =>
      textResponse(`Error parsing query in ${where}: ${detail}`);

    /** Answer /studies/metadata with `metadata` and every other request with `primary`. */
    const route = (primary: unknown, metadata: unknown = jsonResponse(AREA_METADATA)) =>
      mockFetch.mockImplementation((url: string | URL) =>
        Promise.resolve(String(url).includes('/studies/metadata') ? metadata : primary),
      );
    const metadataRequests = () =>
      mockFetch.mock.calls.filter((c) => String(c[0]).includes('/studies/metadata')).length;

    /** The error `call` rejects with. */
    const rejection = async (call: () => Promise<unknown>): Promise<McpError> => {
      try {
        await call();
      } catch (err) {
        return err as McpError;
      }
      throw new Error('expected a rejection');
    };

    /** Run `call` with fake timers standing in for the throttle's one-second gaps. */
    async function throttled<T>(call: () => Promise<T>): Promise<T> {
      vi.useFakeTimers();
      try {
        const outcome = call().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        const settled = await outcome;
        if ('error' in settled) throw settled.error;
        return settled.value;
      } finally {
        vi.useRealTimers();
      }
    }

    let validating: ClinicalTrialsService;
    beforeEach(() => {
      validating = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
    });

    describe('rejections upstream returns', () => {
      it('suggests the nearest searchable pieces for an unknown name', async () => {
        route(parseError('Unknown area name: `SponsorName`'));
        const err = await throttled(() =>
          rejection(() =>
            validating.countStudies(
              { filterAdvanced: 'AREA[SponsorName]Pfizer' },
              createMockContext(),
            ),
          ),
        );

        expect(err.message).toBe(
          "Error parsing query in advanced filter: Unknown area name: `SponsorName` 'SponsorName' is not a recognized AREA[]-compatible field. 'SponsorName' — did you mean 'LeadSponsorName', 'CollaboratorName', 'InterventionName'? Call clinicaltrials_get_field_definitions to look up valid PascalCase piece names.",
        );
        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['SponsorName'],
          suggestions: { SponsorName: ['LeadSponsorName', 'CollaboratorName', 'InterventionName'] },
        });
      });

      it('answers a STRUCT piece refusal as field_invalid with its leaves, not as a syntax error', async () => {
        route(parseError('This type of query is not allowed for LeadSponsor'));
        const err = await throttled(() =>
          rejection(() =>
            validating.searchStudies(
              { filterAdvanced: 'AREA[LeadSponsor]Pfizer' },
              createMockContext(),
            ),
          ),
        );

        expect(err.message).toBe(
          "Error parsing query in advanced filter: This type of query is not allowed for LeadSponsor. 'LeadSponsor' cannot be searched by value with AREA[]. 'LeadSponsor' — did you mean 'LeadSponsorName', 'LeadSponsorClass', 'AgreementPISponsorEmployee'? Call clinicaltrials_get_field_definitions to look up valid PascalCase piece names.",
        );
        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['LeadSponsor'],
          suggestions: {
            LeadSponsor: ['LeadSponsorName', 'LeadSponsorClass', 'AgreementPISponsorEmployee'],
          },
        });
      });

      it('keeps the parameter upstream names for a rejection in a query parameter', async () => {
        route(parseError('Unknown area name: `Status`', 'Conditions or disease'));
        const err = await throttled(() =>
          rejection(() =>
            validating.countStudies({ queryCond: 'AREA[Status]RECRUITING' }, createMockContext()),
          ),
        );

        expect(err.message).toContain('Error parsing query in Conditions or disease:');
        expect(err.message).toContain("'Status' — did you mean 'OverallStatus', 'LocationStatus'?");
        expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: ['Status'] });
      });

      it('keeps today’s message for a name no searchable piece resembles', async () => {
        route(parseError('Unknown area name: `NotARealField`'));
        const err = await throttled(() =>
          rejection(() =>
            validating.countStudies(
              { filterAdvanced: 'AREA[NotARealField]x' },
              createMockContext(),
            ),
          ),
        );

        expect(err.message).toBe(
          "Error parsing query in advanced filter: Unknown area name: `NotARealField` 'NotARealField' is not a recognized AREA[]-compatible field. Call clinicaltrials_get_field_definitions to look up valid PascalCase piece names.",
        );
        expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['NotARealField'] });
      });

      it('never suggests a STRUCT piece upstream would refuse in turn', async () => {
        const names = ['LeadSponsor', 'Collaborator', 'Intervention', 'SponsorCollaboratorsModule'];
        route(parseError('placeholder'));
        const suggested = await throttled(async () => {
          const out: string[] = [];
          for (const name of names) {
            for (const detail of [
              `Unknown area name: \`${name}\``,
              `This type of query is not allowed for ${name}`,
            ]) {
              route(parseError(detail));
              const err = await rejection(() =>
                validating.countStudies({ filterAdvanced: `AREA[${name}]x` }, createMockContext()),
              );
              expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: [name] });
              const { suggestions } = err.data as { suggestions?: Record<string, string[]> };
              out.push(...(suggestions?.[name] ?? []));
            }
          }
          return out;
        });

        expect(suggested.length).toBeGreaterThan(0);
        expect(suggested.filter((piece) => STRUCT_PIECES.has(piece))).toEqual([]);
      });

      it('suggests nothing, and fetches no metadata, with local validation disabled', async () => {
        route(parseError('This type of query is not allowed for LeadSponsor'));
        const err = await rejection(() =>
          service.countStudies({ filterAdvanced: 'AREA[LeadSponsor]Pfizer' }, createMockContext()),
        );

        expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['LeadSponsor'] });
        expect(err.message).not.toContain('did you mean');
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('still answers field_invalid when the metadata lookup fails on the error path', async () => {
        route(parseError('Unknown area name: `SponsorName`'), jsonResponse(null, 404));
        const ctx = createMockContext();
        const err = await throttled(() =>
          rejection(() => validating.countStudies({ filterAdvanced: 'AREA[SponsorName]x' }, ctx)),
        );

        expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['SponsorName'] });
        expect(metadataRequests()).toBe(1);
        expect(
          (ctx.log as unknown as { calls: Array<{ level: string; msg: string }> }).calls,
        ).toContainEqual(
          expect.objectContaining({
            level: 'warning',
            msg: 'AREA[] field-name lookup skipped — metadata unavailable',
          }),
        );
      });

      it('lets the caller’s cancellation through rather than reporting a field_invalid', async () => {
        const controller = new AbortController();
        mockFetch.mockImplementation(() => {
          controller.abort();
          return Promise.resolve(parseError('Unknown area name: `SponsorName`'));
        });
        const err = await rejection(() =>
          validating.countStudies(
            { filterAdvanced: 'AREA[SponsorName]x' },
            createMockContext({ signal: controller.signal }),
          ),
        );

        expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('getAreaIndex', () => {
      it('resolves the AREA index, sharing one metadata request with field validation', async () => {
        route(jsonResponse({ studies: [] }));
        const ctx = createMockContext();
        const index = await throttled(async () => {
          const area = await validating.getAreaIndex(ctx);
          await validating.searchStudies({ fields: ['NCTId'] }, ctx);
          return area;
        });

        expect(index?.names.has('OVERALL-STATUS')).toBe(true);
        expect(index?.fold.get('overallstatus')).toBe('OverallStatus');
        expect(metadataRequests()).toBe(1);
      });

      it('is undefined, with no request, when local validation is disabled', async () => {
        await expect(service.getAreaIndex(createMockContext())).resolves.toBeUndefined();
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('is undefined when metadata cannot be fetched, and retries on the next call', async () => {
        route(jsonResponse({ studies: [] }), jsonResponse(null, 404));
        await expect(validating.getAreaIndex(createMockContext())).resolves.toBeUndefined();

        route(jsonResponse({ studies: [] }));
        const index = await throttled(() => validating.getAreaIndex(createMockContext()));
        expect(index?.names.has('LeadSponsorName')).toBe(true);
        expect(metadataRequests()).toBe(2);
      });

      it('rethrows the caller’s cancellation instead of passing it off as no index', async () => {
        route(jsonResponse({ studies: [] }));
        const controller = new AbortController();
        controller.abort();
        const err = await rejection(() =>
          validating.getAreaIndex(createMockContext({ signal: controller.signal })),
        );

        expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe('parseAreaRejection', () => {
      it.each([
        [
          'Error parsing query in advanced filter: Unknown area name: `Sponsor`',
          'unknown',
          'Sponsor',
        ],
        [
          'Error parsing query in Other terms: Unknown area name: `overall-status`',
          'unknown',
          'overall-status',
        ],
        [
          'Error parsing query in advanced filter: This type of query is not allowed for DesignInfo',
          'unsearchable',
          'DesignInfo',
        ],
      ] as const)('reads %j', (text, kind, name) => {
        expect(parseAreaRejection(text)).toEqual({ kind, name });
      });

      it.each([
        'Error parsing query in advanced filter: RANGE is not supported for text field protocolSection.identificationModule.briefTitle',
        'Error parsing query in advanced filter: Allowed values for enum field `protocolSection.designModule.phases` are `NA`, `PHASE1`',
        "Error parsing query in Other terms: mismatched input '[' expecting {<EOF>, '('}",
        'Error parsing query in advanced filter: Unknown area name: ``',
        '',
      ])('reads no AREA[] name in %j', (text) => {
        expect(parseAreaRejection(text)).toBeUndefined();
      });

      describe('stays linear on caller-sized text', () => {
        it.each([
          ...LINE_BREAK_SHAPES.map(([name, shape]) => [name, shape, undefined] as const),
          [
            'an opening backtick never closed',
            (n: number) => `Unknown area name: \`${'x'.repeat(n)}`,
            undefined,
          ],
          [
            'a whitespace run after the colon',
            (n: number) => `Unknown area name:${' '.repeat(n)}x`,
            undefined,
          ],
          [
            'repeated prefixes with no name',
            (n: number) => 'Unknown area name: '.repeat(n / 19),
            undefined,
          ],
          // Each refusal's `for ` runs into the next one's `This`.
          [
            'overlapping refusal prefixes',
            (n: number) => 'This type of query is not allowed for '.repeat(n / 38),
            'This',
          ],
        ] as const)('%s', (_name, shape, name) => {
          expectLinearGrowth((input) => {
            if (parseAreaRejection(input)?.name !== name) throw new Error('unexpected name');
          }, shape);
        });

        it('a name as long as the request allows', () => {
          expectLinearGrowth(
            (input) => {
              if (parseAreaRejection(input)?.name.length !== input.length - 38) {
                throw new Error('name cut short');
              }
            },
            (n) => `This type of query is not allowed for ${'X'.repeat(n)}`,
          );
        });
      });
    });
  });

  // Names AREA[] and `sort` resolve beyond the record pieces: the index-only
  // pieces `/studies/metadata?includeIndexedOnly=true` flags, and the areas
  // `/studies/search-areas` lists. Read only on a record-tier miss, one attempt
  // each, and any failure leaves the call as it was without them (#179).
  describe('index-only pieces and search areas (#179)', () => {
    const STUDIES = '/v2/studies';
    /** A response, or a function of the request's init that builds one. */
    type Answer = unknown;
    interface Routes {
      indexed?: Answer;
      metadata?: Answer;
      searchAreas?: Answer;
      studies?: Answer;
    }

    /** Answer each endpoint by its path; anything else is an unmocked request. */
    const routes = ({
      metadata = jsonResponse(RECORD_METADATA),
      indexed = jsonResponse(INDEXED_METADATA),
      searchAreas = jsonResponse(SEARCH_AREAS),
      studies = jsonResponse({ studies: [], totalCount: 7 }),
    }: Routes = {}) =>
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const { pathname, searchParams } = new URL(String(url));
        const answer =
          pathname === `${STUDIES}/metadata`
            ? searchParams.get('includeIndexedOnly') === 'true'
              ? indexed
              : metadata
            : pathname === `${STUDIES}/search-areas`
              ? searchAreas
              : pathname === STUDIES
                ? studies
                : undefined;
        if (answer === undefined) return Promise.reject(new Error('unmocked fetch'));
        return Promise.resolve(typeof answer === 'function' ? answer(init) : answer);
      });

    /** A request that never answers: it fails only when its own signal aborts. */
    const hang = (init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    /** Requests sent to each endpoint. */
    const requestCounts = () => {
      const counts = { metadata: 0, indexed: 0, searchAreas: 0, studies: 0 };
      for (const [url] of mockFetch.mock.calls) {
        const { pathname, searchParams } = new URL(String(url));
        if (pathname === `${STUDIES}/metadata`) {
          counts[searchParams.has('includeIndexedOnly') ? 'indexed' : 'metadata']++;
        } else if (pathname === `${STUDIES}/search-areas`) counts.searchAreas++;
        else if (pathname === STUDIES) counts.studies++;
      }
      return counts;
    };
    const studyRequests = () =>
      mockFetch.mock.calls
        .map(([url]) => new URL(String(url)))
        .filter((u) => u.pathname === STUDIES);

    const logCalls = (ctx: ReturnType<typeof createMockContext>) =>
      (ctx.log as unknown as { calls: Array<{ level: string; msg: string; data?: unknown }> })
        .calls;

    /**
     * Settle `call` under fake timers one throttle gap at a time. A real
     * macrotask runs between gaps, so a read's own timeout — a real timer — can
     * fire while the throttle's fake one-second gaps elapse instantly.
     */
    async function settle<T>(call: () => Promise<T>): Promise<T> {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        let done = false;
        const outcome = call()
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            done = true;
          });
        for (let gap = 0; !done && gap < 1000; gap++) {
          await vi.advanceTimersByTimeAsync(1000);
          await new Promise((resolve) => setImmediate(resolve));
        }
        const settled = await outcome;
        if ('error' in settled) throw settled.error;
        return settled.value;
      } finally {
        vi.useRealTimers();
      }
    }

    /** The error `call` rejects with. */
    const rejection = async (call: () => Promise<unknown>): Promise<McpError> => {
      try {
        await call();
      } catch (err) {
        return err as McpError;
      }
      throw new Error('expected a rejection');
    };

    let validating: ClinicalTrialsService;
    beforeEach(() => {
      validating = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
        extendedReadTimeoutMs: 1,
      });
    });

    /** The AREA[] correction a tool handler runs, against this service. */
    const correct = (
      expressions: Record<string, string | undefined>,
      ctx: ReturnType<typeof createMockContext>,
    ) => normalizeAreaNames(expressions, () => validating.getAreaIndex(ctx), ctx.log);

    describe('AREA[] correction', () => {
      it('corrects a mis-cased index-only piece, its alt name, and a search area, reading each source once', async () => {
        routes();
        const ctx = createMockContext();
        const next = createMockContext();
        const [first, second] = await settle(async () => [
          await correct(
            {
              advancedFilter: 'AREA[numlocations]RANGE[100,MAX]',
              query: 'AREA[conditionsearch]diabetes',
              conditionQuery: 'AREA[number-of-locations]RANGE[100,MAX]',
              titleQuery:
                'AREA[NumLocations]x AND AREA[ConditionSearch]y AND AREA[NUMBER-OF-LOCATIONS]z',
            },
            ctx,
          ),
          await correct({ advancedFilter: 'AREA[numconditions]RANGE[3,MAX]' }, next),
        ]);

        expect(first).toEqual({
          advancedFilter: 'AREA[NumLocations]RANGE[100,MAX]',
          query: 'AREA[ConditionSearch]diabetes',
          conditionQuery: 'AREA[NumLocations]RANGE[100,MAX]',
          titleQuery:
            'AREA[NumLocations]x AND AREA[ConditionSearch]y AND AREA[NUMBER-OF-LOCATIONS]z',
        });
        expect(second).toEqual({ advancedFilter: 'AREA[NumConditions]RANGE[3,MAX]' });
        expect(logCalls(ctx)).toContainEqual({
          level: 'notice',
          msg: 'AREA[] field names auto-corrected',
          data: {
            rewrites: [
              { param: 'advancedFilter', from: 'numlocations', to: 'NumLocations' },
              { param: 'query', from: 'conditionsearch', to: 'ConditionSearch' },
              { param: 'conditionQuery', from: 'number-of-locations', to: 'NumLocations' },
            ],
          },
        });
        // A success is kept: the second call reads neither source again.
        expect(requestCounts()).toEqual({ metadata: 1, indexed: 1, searchAreas: 1, studies: 0 });
      });

      it('requests neither new endpoint while every name resolves in the record tier', async () => {
        routes();
        const ctx = createMockContext();
        const out = await settle(() =>
          correct(
            {
              advancedFilter:
                'AREA[OverallStatus]RECRUITING AND AREA[overallstatus]COMPLETED AND AREA[Sponsor]x AND AREA[LeadSponsor]y',
            },
            ctx,
          ),
        );

        expect(out.advancedFilter).toBe(
          'AREA[OverallStatus]RECRUITING AND AREA[OverallStatus]COMPLETED AND AREA[LeadSponsorName]x AND AREA[LeadSponsor]y',
        );
        expect(requestCounts()).toEqual({ metadata: 1, indexed: 0, searchAreas: 0, studies: 0 });
      });

      it.each([
        ['NumLocation', ['NumLocations', 'LocationStatus', 'LocationCity']],
        ['NumberOfLocations', ['NumLocations', 'LocationStatus', 'LocationCity']],
        ['ConditionSearches', ['ConditionSearch', 'Condition']],
      ])(
        'leads the suggestions for %s with the extended name it nearly matches',
        async (name, near) => {
          routes({
            studies: textResponse(
              `Error parsing query in advanced filter: Unknown area name: \`${name}\``,
            ),
          });
          const err = await settle(() =>
            rejection(() =>
              validating.countStudies({ filterAdvanced: `AREA[${name}]x` }, createMockContext()),
            ),
          );

          expect(err.data).toEqual({
            reason: 'field_invalid',
            invalid: [name],
            suggestions: { [name]: near },
          });
          expect(err.message).toContain(
            `'${name}' — did you mean ${near.map((p) => `'${p}'`).join(', ')}?`,
          );
        },
      );
    });

    describe('sort', () => {
      it('sorts on a mis-cased index-only piece or alt name as its canonical spelling', async () => {
        routes();
        const ctx = createMockContext();
        await settle(async () => {
          await validating.searchStudies({ sort: 'numlocations:desc' }, ctx);
          await validating.searchStudies({ sort: 'number-of-locations:DESC,NCTId:asc' }, ctx);
        });

        expect(studyRequests().map((u) => u.searchParams.get('sort'))).toEqual([
          'NumLocations:desc',
          'NumLocations:desc,NCTId:asc',
        ]);
        expect(logCalls(ctx)).toContainEqual({
          level: 'notice',
          msg: 'Sort field auto-corrected',
          data: { corrections: [{ from: 'numlocations:desc', to: 'NumLocations:desc' }] },
        });
      });

      it('sends an index-only piece, its alt name, and any search area exactly as written', async () => {
        routes();
        await settle(async () => {
          for (const sort of [
            'NumLocations:desc',
            'NUMBER-OF-LOCATIONS:desc',
            'ConditionSearch:asc',
            'conditionsearch:asc',
          ]) {
            await validating.searchStudies({ sort }, createMockContext());
          }
        });

        expect(studyRequests().map((u) => u.searchParams.get('sort'))).toEqual([
          'NumLocations:desc',
          'NUMBER-OF-LOCATIONS:desc',
          'ConditionSearch:asc',
          'conditionsearch:asc',
        ]);
      });

      it('sends record fields and @relevance as before, reading neither new endpoint', async () => {
        routes();
        await settle(async () => {
          for (const sort of ['BriefTitle:asc', 'LastUpdatePostDate:desc', '@relevance']) {
            await validating.searchStudies({ sort }, createMockContext());
          }
        });

        expect(studyRequests().map((u) => u.searchParams.get('sort'))).toEqual([
          'BriefTitle:asc',
          'LastUpdatePostDate:desc',
          '@relevance',
        ]);
        expect(requestCounts()).toEqual({ metadata: 1, indexed: 0, searchAreas: 0, studies: 3 });
      });

      it('suggests an index-only near miss first, and never a search area', async () => {
        routes({ studies: textResponse('Unknown sort field') });
        const [indexOnly, area] = await settle(async () => [
          await rejection(() =>
            validating.searchStudies({ sort: 'NumLocation:desc' }, createMockContext()),
          ),
          await rejection(() =>
            validating.searchStudies({ sort: 'ConditionSearches:asc' }, createMockContext()),
          ),
        ]);

        expect(indexOnly.data).toMatchObject({ reason: 'sort_invalid' });
        expect(indexOnly.message).toContain(
          "'NumLocation' — did you mean 'NumLocations', 'Location', 'LocationStatus'?",
        );
        expect(area.message).toContain(
          "'ConditionSearches' — did you mean 'Condition', 'ConditionsModule'?",
        );
      });
    });

    describe('when a read fails', () => {
      const failures = [
        ['404', () => jsonResponse(null, 404)],
        ['403', () => textResponse('Forbidden', 403)],
        ['500', () => jsonResponse(null, 500)],
        ['a hang past the read timeout', () => hang],
      ] as const;
      const sources = ['indexed', 'searchAreas'] as const;

      it.each(
        sources.flatMap((source) =>
          failures.map(([label, answer]) => [source, label, answer] as const),
        ),
      )(
        'answers as without them when the %s read fails with %s, once per call',
        async (source, _label, answer) => {
          routes({
            [source]: answer(),
            studies: textResponse(
              'Error parsing query in advanced filter: Unknown area name: `numlocations`',
            ),
          });
          const ctx = createMockContext();
          const next = createMockContext();
          const { corrected, err, retried } = await settle(async () => {
            const corrected = await correct(
              {
                advancedFilter:
                  'AREA[numlocations]RANGE[100,MAX] AND AREA[overallstatus]RECRUITING',
              },
              ctx,
            );
            const err = await rejection(() =>
              validating.countStudies({ filterAdvanced: corrected.advancedFilter }, ctx),
            );
            const before = requestCounts()[source];
            await correct({ advancedFilter: 'AREA[numlocations]x' }, next);
            return { corrected, err, retried: requestCounts()[source] - before };
          });

          // The record tier still corrects; the index-only name goes out as written.
          expect(corrected.advancedFilter).toBe(
            'AREA[numlocations]RANGE[100,MAX] AND AREA[OverallStatus]RECRUITING',
          );
          // The rejection is the one 2.11.0 gave: nothing from the failed tier.
          expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['numlocations'] });
          expect(logCalls(ctx)).toContainEqual(
            expect.objectContaining({
              level: 'warning',
              msg: 'Index-only piece and search-area lookup skipped — read failed',
            }),
          );
          // One attempt for the whole call, error path included; the next call reads afresh.
          expect(requestCounts()[source] - retried).toBe(1);
          expect(retried).toBe(1);
        },
      );

      it('still answers a search area and a record fix, and never reports a study, when search areas 404', async () => {
        routes({
          searchAreas: jsonResponse(null, 404),
          studies: textResponse(
            'Error parsing query in advanced filter: Unknown area name: `conditionsearch`',
          ),
        });
        const ctx = createMockContext();
        const { err, sent } = await settle(async () => {
          const sent = await correct(
            {
              advancedFilter: 'AREA[conditionsearch]diabetes',
              query: 'AREA[ConditionSearch]diabetes',
              conditionQuery: 'AREA[overallstatus]RECRUITING',
            },
            ctx,
          );
          return {
            sent,
            err: await rejection(() =>
              validating.countStudies({ filterAdvanced: sent.advancedFilter }, ctx),
            ),
          };
        });

        expect(sent).toEqual({
          advancedFilter: 'AREA[conditionsearch]diabetes',
          query: 'AREA[ConditionSearch]diabetes',
          conditionQuery: 'AREA[OverallStatus]RECRUITING',
        });
        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['conditionsearch'],
          suggestions: { conditionsearch: ['Condition'] },
        });
        const warning = logCalls(ctx).find((c) => c.level === 'warning');
        expect(JSON.stringify(warning?.data)).not.toMatch(/study/i);
      });

      it('still answers an index-only name and validates fields locally when the index-only read hangs', async () => {
        routes({ indexed: hang });
        const ctx = createMockContext();
        const { count, err } = await settle(async () => {
          const { advancedFilter } = await correct(
            { advancedFilter: 'AREA[NumLocations]RANGE[100,MAX]' },
            ctx,
          );
          const count = await validating.countStudies({ filterAdvanced: advancedFilter }, ctx);
          const err = await rejection(() =>
            validating.searchStudies({ fields: ['Sponsor'] }, createMockContext()),
          );
          return { count, err };
        });

        expect(count).toBe(7);
        expect(studyRequests()[0]?.searchParams.get('filter.advanced')).toBe(
          '(AREA[NumLocations]RANGE[100,MAX]) AND (NOT AREA[EnrollmentCount]RANGE[99999999, MAX])',
        );
        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['Sponsor'],
          suggestions: {
            Sponsor: ['SponsorCollaboratorsModule', 'LeadSponsor', 'LeadSponsorName'],
          },
        });
        expect(studyRequests()).toHaveLength(1);
      });
    });

    describe('cancellation', () => {
      it('rejects as cancelled when the caller aborts mid-load, and keeps the read for the next caller', async () => {
        const controller = new AbortController();
        routes({
          indexed: () => {
            controller.abort();
            return jsonResponse(INDEXED_METADATA);
          },
        });
        const ctx = createMockContext({ signal: controller.signal });
        const { err, next } = await settle(async () => ({
          err: await rejection(() => correct({ advancedFilter: 'AREA[numlocations]x' }, ctx)),
          next: await correct({ advancedFilter: 'AREA[numlocations]x' }, createMockContext()),
        }));

        expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(err.message).toContain('cancelled by caller');
        expect(logCalls(ctx).filter((c) => c.level === 'warning')).toEqual([]);
        expect(next).toEqual({ advancedFilter: 'AREA[NumLocations]x' });
        expect(requestCounts()).toMatchObject({ indexed: 1, searchAreas: 1 });
      });

      it('lets a concurrent caller finish the load another caller abandoned', async () => {
        const controller = new AbortController();
        routes({
          searchAreas: () => {
            controller.abort();
            return jsonResponse(SEARCH_AREAS);
          },
        });
        const leaving = createMockContext({ signal: controller.signal });
        const staying = createMockContext();
        const [left, stayed] = await settle(() =>
          Promise.allSettled([
            correct({ advancedFilter: 'AREA[conditionsearch]x' }, leaving),
            correct({ advancedFilter: 'AREA[conditionsearch]x' }, staying),
          ]),
        );

        expect(left.status).toBe('rejected');
        expect((left as PromiseRejectedResult).reason).toMatchObject({
          code: JsonRpcErrorCode.RequestCancelled,
        });
        expect(stayed).toEqual({
          status: 'fulfilled',
          value: { advancedFilter: 'AREA[ConditionSearch]x' },
        });
        expect(requestCounts()).toEqual({ metadata: 1, indexed: 1, searchAreas: 1, studies: 0 });
      });
    });

    // An index-only piece holds no record value, so `fields` cannot return it and
    // field search must not offer it — whether or not this call read the tier.
    describe('fields and field search', () => {
      /** The index-only pieces INDEXED_METADATA flags. */
      const INDEX_ONLY = [
        'LastUpdatePostYear',
        'LocationCountryCode',
        'NumLocations',
        'NumConditions',
      ];

      it('keeps index-only pieces out of fields validation and field search after the second tier loads', async () => {
        routes();
        const ctx = createMockContext();
        const { corrected, exact, folded, found } = await settle(async () => {
          // A record-tier miss reads the second tier for this call first.
          const corrected = await correct({ advancedFilter: 'AREA[numlocations]x' }, ctx);
          const exact = await rejection(() =>
            validating.searchStudies({ fields: ['NumLocations'] }, ctx),
          );
          const folded = await rejection(() =>
            validating.searchStudies({ fields: ['numlocations'] }, ctx),
          );
          const found = await validating.searchFieldDefinitions('LastUpdatePost', 50, ctx);
          return { corrected, exact, folded, found };
        });

        expect(corrected).toEqual({ advancedFilter: 'AREA[NumLocations]x' });
        expect(requestCounts()).toEqual({ metadata: 1, indexed: 1, searchAreas: 1, studies: 0 });
        expect(exact.data).toMatchObject({ reason: 'field_invalid', invalid: ['NumLocations'] });
        // Not folded to the index-only piece, the way AREA[] and sort fold it.
        expect(folded.data).toMatchObject({ reason: 'field_invalid', invalid: ['numlocations'] });
        for (const err of [exact, folded]) {
          const suggested = Object.values(
            (err.data as { suggestions?: Record<string, string[]> }).suggestions ?? {},
          ).flat();
          expect(suggested.filter((piece) => INDEX_ONLY.includes(piece))).toEqual([]);
        }
        // The record piece the query names is found; its index-only sibling is not.
        const pieces = found.entries.map((e) => e.piece);
        expect(pieces).toContain('LastUpdatePostDate');
        expect(pieces.filter((piece) => INDEX_ONLY.includes(piece))).toEqual([]);
      });
    });

    describe('404s outside the single-study route', () => {
      it('reports a metadata 404 as a missing endpoint, never study_not_found', async () => {
        mockFetch.mockResolvedValue(textResponse('No such endpoint', 404));
        const err = await rejection(() => service.getMetadata(false, createMockContext()));

        expect(err.code).toBe(JsonRpcErrorCode.NotFound);
        expect(err.message).toBe('No such endpoint');
        expect((err.data as Record<string, unknown> | undefined)?.reason).toBeUndefined();
      });

      it('still reports a 404 for an NCT ID as study_not_found', async () => {
        mockFetch.mockResolvedValue(jsonResponse(null, 404));
        const err = await rejection(() => service.getStudy('NCT12345678', createMockContext()));

        expect(err.message).toBe('Study NCT12345678 not found');
        expect(err.data).toEqual({ reason: 'study_not_found' });
      });
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
      const { entries: results } = await validatingService.searchFieldDefinitions(
        'enrollment',
        5,
        ctx,
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.piece).toBe('EnrollmentCount');
    });

    it('finds multiple matches sorted by relevance', async () => {
      const ctx = createMockContext();
      const { entries: results } = await validatingService.searchFieldDefinitions(
        'sponsor',
        5,
        ctx,
      );
      const pieces = results.map((r) => r.piece);
      expect(pieces).toContain('LeadSponsorName');
      expect(pieces).toContain('CollaboratorName');
    });

    it('respects the limit and reports the pre-cap total (#77)', async () => {
      const ctx = createMockContext();
      const { entries: results, total } = await validatingService.searchFieldDefinitions(
        'sponsor',
        1,
        ctx,
      );
      expect(results).toHaveLength(1);
      expect(total).toBe(2);
    });

    it('returns empty entries and zero total when nothing matches', async () => {
      const ctx = createMockContext();
      const { entries: results, total } = await validatingService.searchFieldDefinitions(
        'zzznomatchzzz',
        5,
        ctx,
      );
      expect(results).toEqual([]);
      expect(total).toBe(0);
    });
  });

  describe('singleton accessor', () => {
    it('throws when service not initialized', () => {
      expect(() => getClinicalTrialsService()).toThrow(/not initialized/);
    });
  });

  describe('constructor options', () => {
    it('defaults to 3 retries when options omitted', async () => {
      const defaultService = new ClinicalTrialsService(testConfig, {
        baseBackoffMs: 1,
        maxBackoffMs: 2,
      });
      mockFetch.mockResolvedValue(jsonResponse(null, 503));
      const ctx = createMockContext();
      await expect(defaultService.searchStudies({}, ctx)).rejects.toThrow(
        /unavailable after retries/,
      );
      // 1 initial + 3 retries = 4 calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
    }, 30_000);
  });
});
