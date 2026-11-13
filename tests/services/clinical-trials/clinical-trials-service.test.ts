/**
 * @fileoverview Tests for ClinicalTrialsService API client.
 * @module tests/services/clinical-trials/clinical-trials-service
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type AreaRejection,
  ClinicalTrialsService,
  getClinicalTrialsService,
  parseAreaRejection,
  parseUnsupportedFieldType,
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

// Backoff stays under the service's 1 s gap between request starts, so a
// retry's start is set by that gap alone; the backoff tests set their own, and
// the production defaults are pinned under "constructor options".
// validateFieldsLocally=false skips the lazy /studies/metadata fetch — tests
// that exercise the validation path opt back in explicitly via a fresh service.
const fastOptions = {
  maxRetries: 3,
  baseBackoffMs: 10,
  maxBackoffMs: 50,
  validateFieldsLocally: false,
};

/** Advance the fake clock one timer at a time until `pending` settles, then resolve or reject as it did. */
async function advanceUntilSettled<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  const outcome = pending
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      done = true;
    });
  while (!done) await vi.advanceTimersToNextTimerAsync();
  const settled = await outcome;
  if ('error' in settled) throw settled.error;
  return settled.value;
}

/**
 * Answer the requests in turn with `answers`, the last repeating — fetch rejects
 * with an Error and resolves with anything else — and return the fake-clock
 * instant each request started, filled in as they go out.
 */
function answerInTurn(...answers: unknown[]): number[] {
  const starts: number[] = [];
  mockFetch.mockImplementation(() => {
    starts.push(Date.now());
    const answer = answers[Math.min(starts.length, answers.length) - 1];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  return starts;
}

/** Milliseconds between consecutive request starts. */
const gaps = (starts: number[]) => starts.slice(1).map((at, i) => at - starts[i]!);

describe('ClinicalTrialsService', () => {
  let service: ClinicalTrialsService;

  // Every test runs on the fake clock: the service's gap between request starts
  // and its retry backoff elapse only when a test advances it, so a call that
  // crosses one without advanceUntilSettled hangs instead of sleeping.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    service = new ClinicalTrialsService(testConfig, fastOptions);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('retries a count answered without totalCount, then ends upstream_unavailable — never a false 0 (#196)', async () => {
      // A count page always carries the total; one without it is a fault, not
      // zero matches. A search page may omit it, so only the count requires it.
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));

      const err = await advanceUntilSettled(service.countStudies({}, createMockContext())).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', path: '/studies' },
      });
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it.each([
      ['a string', { totalCount: '7495', studies: [] }],
      ['no studies array', { totalCount: 12 }],
    ])('refuses a count whose totalCount comes with %s (#196)', async (_label, body) => {
      mockFetch.mockResolvedValue(jsonResponse(body));

      const err = await advanceUntilSettled(service.countStudies({}, createMockContext())).catch(
        (e: unknown) => e,
      );

      expect((err as McpError).data?.reason).toBe('upstream_unavailable');
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
      const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
      mockFetch.mockResolvedValue(jsonResponse(study));

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);

      expect(result).toEqual(study);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe('/v2/studies/NCT12345678');
    });

    it('throws McpError with NotFound on 404', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));

      const err = await service
        .getStudy('NCT12345678', createMockContext())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
      expect((err as McpError).message).toContain('not found');
    });

    it('URL-encodes the NCT ID', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ protocolSection: {} }));
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

    it('sends its fixed projection unchecked, reading no /studies/metadata (#192)', async () => {
      // The five names never change, so checking them against the field index
      // costs a fresh server a metadata read before every first batch, and a
      // hung one the whole call.
      const validating = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
      mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));

      await advanceUntilSettled(validating.getStudiesBatch(['NCT12345678'], createMockContext()));

      expect(mockFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        '/v2/studies',
      ]);
      expect(new URL(String(mockFetch.mock.calls[0]![0])).searchParams.get('fields')).toBe(
        'NCTId|NCTIdAlias|BriefTitle|HasResults|ResultsSection',
      );
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
    /** A second instance, so a test's second request never waits out the first one's pacer slot. */
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

      // The metadata fetch takes the normalizing instance's first request slot,
      // so its search waits out one gap on the fake clock.
      const normalizing = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
      await advanceUntilSettled(normalizing.searchStudies(params, createMockContext()));
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
      mockFetch.mockResolvedValue(jsonResponse(RECORD_METADATA));
      const ctx = createMockContext();

      await service.getMetadata(true, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.get('includeIndexedOnly')).toBe('true');
    });

    it('omits includeIndexedOnly when false', async () => {
      mockFetch.mockResolvedValue(jsonResponse(RECORD_METADATA));
      const ctx = createMockContext();

      await service.getMetadata(false, ctx);

      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.searchParams.has('includeIndexedOnly')).toBe(false);
    });

    it('does not set format=json for metadata', async () => {
      mockFetch.mockResolvedValue(jsonResponse(RECORD_METADATA));
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

      expect(result.stats).toEqual(stats);
      // Local validation is off here, so no field index says whether it repeats.
      expect(result.multiValuedUndetermined).toEqual(['OverallStatus']);
      const calledUrl = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(calledUrl.pathname).toBe('/v2/stats/field/values');
      expect(calledUrl.searchParams.get('fields')).toBe('OverallStatus');
      expect(calledUrl.searchParams.has('format')).toBe(false);
    });

    it('joins multiple fields with pipe', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse([{ field: 'OverallStatus', piece: 'OverallStatus', type: 'ENUM' }]),
      );
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

    it('ends a 403 as the untranslated-status error', async () => {
      // 403 is neither retried nor a 404: it ends as the status it was
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

    // multiValued is read off the field index; without an entry for a piece the
    // answer cannot say whether it repeats, and says so instead of leaving an
    // absent flag to read as single-valued (#192).
    describe('pieces whose multi-valued status went undetermined (#192)', () => {
      const conditionStat = {
        field: 'protocolSection.conditionsModule.conditions',
        piece: 'Condition',
        type: 'STRING',
      };
      const statusStat = {
        field: 'protocolSection.statusModule.overallStatus',
        piece: 'OverallStatus',
        type: 'ENUM',
      };
      /** `/studies/metadata` answers `metadata`; the statistics answer `stats`. */
      const routes = (metadata: unknown, stats: unknown[]) =>
        mockFetch.mockImplementation((url: string | URL) =>
          Promise.resolve(
            new URL(String(url)).pathname === '/v2/studies/metadata'
              ? metadata
              : jsonResponse(structuredClone(stats)),
          ),
        );
      const validating = () =>
        new ClinicalTrialsService(testConfig, { ...fastOptions, validateFieldsLocally: true });

      it('names every piece when the field index is unavailable, flagging none', async () => {
        routes(jsonResponse(null, 503), [conditionStat, statusStat]);

        const result = await advanceUntilSettled(
          validating().getFieldValues(['Condition', 'OverallStatus'], createMockContext()),
        );

        expect(result.stats.map((s) => s.multiValued)).toEqual([undefined, undefined]);
        expect(result.multiValuedUndetermined).toEqual(['Condition', 'OverallStatus']);
      });

      it('names none when the field index checked every piece', async () => {
        routes(jsonResponse(RECORD_METADATA), [conditionStat, statusStat]);

        const result = await advanceUntilSettled(
          validating().getFieldValues(['Condition', 'OverallStatus'], createMockContext()),
        );

        expect(result.stats.map((s) => s.multiValued)).toEqual([true, undefined]);
        expect(result.multiValuedUndetermined).toBeUndefined();
      });

      it('names only a piece upstream answered that the field index does not hold', async () => {
        routes(jsonResponse(RECORD_METADATA), [
          statusStat,
          { field: 'unlisted', piece: 'Unlisted', type: 'ENUM' },
        ]);

        const result = await advanceUntilSettled(
          validating().getFieldValues(['OverallStatus'], createMockContext()),
        );

        expect(result.multiValuedUndetermined).toEqual(['Unlisted']);
      });
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
      // Live-API string for `SEARCH[Foo](…)` in query.cond. It matches no ANTLR
      // shape but says something specific — discarding it for a generic sentence
      // loses the only actionable detail in the response.
      mockFetch.mockResolvedValue(
        textResponse(
          'Error parsing query in Conditions or disease: Search scope must be `Study` or `Location`',
        ),
      );
      const ctx = queryParseErrorCtx();
      try {
        await service.searchStudies({ queryCond: 'SEARCH[Foo](AREA[LocationCity]Seattle)' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        const msg = (err as McpError).message;
        expect(msg).toContain('Search scope must be `Study` or `Location`');
        expect(msg).not.toContain('Error parsing query in');
        expect((err as McpError).data).toMatchObject({ reason: 'query_parse_error' });
      }
    });

    it('declares the expression forms its message and the declared hint quote as literals', async () => {
      mockFetch.mockResolvedValue(
        textResponse(
          "Error parsing query in Conditions or disease: mismatched input '[' expecting {<EOF>, '(', ',', 'NOT', 'AND', 'OR'}",
        ),
      );
      const err = (await service
        .searchStudies({ queryCond: 'diabetes [bracket]' }, queryParseErrorCtx())
        .catch((e: unknown) => e)) as McpError;

      expect(err.message).toContain('AREA[FieldName]value or RANGE[min, max] expression');
      expect(err.literals).toEqual([
        'AREA[FieldName]value',
        'RANGE[min, max]',
        'AREA[…]',
        'RANGE[…]',
      ]);
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

    /**
     * A status fetchJson does not translate itself is sent once and answered as
     * ServiceUnavailable: the API is public and keyless, so Unauthorized,
     * Forbidden, Conflict, or InvalidRequest would put the fault on credentials
     * or a request the caller cannot change. The reason tells an outage from a
     * refusal, and the upstream body stays out of the message (#196).
     */
    describe('statuses fetchJson does not translate (#196)', () => {
      const PAGE = '<!DOCTYPE html><html><body>Request blocked by policy</body></html>';
      const answer = (status: number) => ({
        ...textResponse(PAGE, status),
        statusText: `Status ${status}`,
      });

      it.each([
        [304, 'upstream_rejected', false],
        [401, 'upstream_rejected', false],
        [403, 'upstream_rejected', false],
        [409, 'upstream_rejected', false],
        [410, 'upstream_rejected', false],
        [425, 'upstream_rejected', false],
        [501, 'upstream_rejected', false],
        [505, 'upstream_unavailable', undefined],
        [520, 'upstream_unavailable', undefined],
      ])('answers HTTP %i once as ServiceUnavailable %s', async (status, reason, retryable) => {
        mockFetch.mockResolvedValue(answer(status));

        const err = (await advanceUntilSettled(
          service.searchStudies({}, createMockContext()),
        ).catch((e: unknown) => e)) as McpError;

        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.message).toBe(`ClinicalTrials.gov returned HTTP ${status} Status ${status}.`);
        expect(err.data).toMatchObject({ reason, status, path: '/studies' });
        expect(err.data?.retryable).toBe(retryable);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    /**
     * A 404 that is a front-end error page names no study and no field: the
     * route was refused before the API answered. The API's own 404s are plain
     * text (verbatim bodies below) and keep their translation (#196).
     */
    describe('a 404 page from the front end, not the API (#196)', () => {
      const PAGE =
        '<!DOCTYPE html><html lang=en><meta charset=utf-8><title>Error 404 (Not Found)!!1</title><p><b>404.</b> <ins>That’s an error.</ins><p>The requested URL was not found on this server.';
      const page404 = () => ({
        ...htmlResponse(PAGE),
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      const calls = [
        ['a search', () => service.searchStudies({}, createMockContext()), '/studies'],
        [
          'a study',
          () => service.getStudy('NCT12345678', createMockContext()),
          '/studies/NCT12345678',
        ],
        [
          'value statistics',
          () => service.getFieldValues(['OverallStatus'], createMockContext()),
          '/stats/field/values',
        ],
      ] as const;

      it.each(calls)(
        'ends %s upstream_rejected, sent once, quoting none of the page',
        async (_label, call, path) => {
          mockFetch.mockResolvedValue(page404());

          // Advanced, so a retry shows as a second request rather than a hang on the pacer gap.
          const err = (await advanceUntilSettled<unknown>(call()).catch(
            (e: unknown) => e,
          )) as McpError;

          expect(err).toBeInstanceOf(McpError);
          expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
          expect(err.message).toBe('ClinicalTrials.gov returned HTTP 404 Not Found.');
          expect(err.data).toMatchObject({ reason: 'upstream_rejected', status: 404, path });
          expect(mockFetch).toHaveBeenCalledTimes(1);
        },
      );

      it('keeps the API’s own plain-text study 404 as study_not_found', async () => {
        mockFetch.mockResolvedValue(textResponse('NCT number NCT09999998 not found', 404));

        await expect(service.getStudy('NCT09999998', createMockContext())).rejects.toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'study_not_found' },
        });
      });

      it('keeps the API’s own plain-text statistics 404 as field_invalid naming the field', async () => {
        mockFetch.mockResolvedValue(
          textResponse('Unknown piece name of field path: BogusPieceXyz', 404),
        );

        await expect(
          service.getFieldValues(['BogusPieceXyz'], createMockContext()),
        ).rejects.toMatchObject({
          message: expect.stringContaining("Invalid field name: 'BogusPieceXyz'."),
          data: { reason: 'field_invalid' },
        });
      });
    });

    /**
     * Field validation reads /studies/metadata only to check and correct names:
     * a read that fails any way — the new reasons included — leaves the search
     * to go out as written, and a refused body is never kept as the index (#196).
     */
    describe('field validation fails open on a metadata read that fails (#196)', () => {
      const validating = () =>
        new ClinicalTrialsService(testConfig, { ...fastOptions, validateFieldsLocally: true });
      /** Answer /studies/metadata with `metadata()`, and every search with an empty page. */
      const serve = (metadata: () => unknown) =>
        mockFetch.mockImplementation((url: string) =>
          Promise.resolve(
            new URL(url).pathname === '/v2/studies/metadata'
              ? metadata()
              : jsonResponse({ studies: [] }),
          ),
        );
      const searches = () =>
        mockFetch.mock.calls
          .map(([url]) => new URL(String(url)))
          .filter((url) => url.pathname === '/v2/studies');

      it.each([
        ['an empty array', () => jsonResponse([])],
        ['an HTML page', () => htmlResponse('<html><body>Maintenance</body></html>')],
        [
          'a body that is not JSON',
          () => ({ ...jsonResponse(null), text: () => Promise.resolve('not json') }),
        ],
        ['HTTP 403', () => jsonResponse(null, 403)],
      ])(
        'sends the search with its fields as written when the metadata read answers %s',
        async (_label, metadata) => {
          serve(metadata);

          const page = await advanceUntilSettled(
            validating().searchStudies({ fields: ['NCTId', 'BriefTitle'] }, createMockContext()),
          );

          expect(page.studies).toEqual([]);
          expect(searches().map((url) => url.searchParams.get('fields'))).toEqual([
            'NCTId|BriefTitle',
          ]);
        },
      );

      it('keeps no empty metadata array as the index: the next call validates against a healthy one', async () => {
        const svc = validating();
        let metadata = jsonResponse([]);
        serve(() => metadata);
        await advanceUntilSettled(svc.searchStudies({ fields: ['NCTId'] }, createMockContext()));
        metadata = jsonResponse(RECORD_METADATA);
        mockFetch.mockClear();

        const err = await advanceUntilSettled(
          svc.searchStudies({ fields: ['NotAField'] }, createMockContext()),
        ).catch((e: unknown) => e);

        expect(err).toMatchObject({ data: { reason: 'field_invalid' } });
        expect(searches()).toEqual([]);
      });
    });
  });

  // Observed through the public methods only — the requests fetch sees and when
  // each one starts on the fake clock — so these hold whatever implements the
  // retry loop and the gap between starts.
  describe('retry logic', () => {
    const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };

    it.each([408, 429, 500, 502, 503, 504])(
      'retries HTTP %i one gap later and returns the next answer',
      async (status) => {
        const starts = answerInTurn(jsonResponse(null, status), jsonResponse({ studies: [] }));

        const result = await advanceUntilSettled(service.searchStudies({}, createMockContext()));

        expect(result.studies).toEqual([]);
        expect(gaps(starts)).toEqual([1000]);
      },
    );

    it.each([
      [400, textResponse('Bad request body')],
      [401, jsonResponse(null, 401)],
      [403, jsonResponse(null, 403)],
      [404, textResponse('No such endpoint', 404)],
      [414, textResponse('Request-URI Too Large', 414)],
      [501, jsonResponse(null, 501)],
    ])('does not retry HTTP %i', async (_status, response) => {
      mockFetch.mockResolvedValue(response);

      await expect(
        advanceUntilSettled(service.searchStudies({}, createMockContext())),
      ).rejects.toBeInstanceOf(McpError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['ECONNRESET', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })],
      ['ETIMEDOUT', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })],
      ['a TimeoutError', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
      ['an AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
      ["Bun's connection reset (code on the TypeError)", bunFetchError('ECONNRESET')],
      ["Node's connection reset (code on its cause)", nodeFetchError('ECONNRESET')],
      ["Node's ETIMEDOUT (code on its cause)", nodeFetchError('ETIMEDOUT')],
      ["Node's socket the other side closed (code on its cause)", nodeFetchError('UND_ERR_SOCKET')],
      ["Node's connect timeout (code on its cause)", nodeFetchError('UND_ERR_CONNECT_TIMEOUT')],
    ])('retries a fetch that fails with %s', async (_label, error) => {
      const starts = answerInTurn(error, jsonResponse(study));

      const result = await advanceUntilSettled(
        service.getStudy('NCT12345678', createMockContext()),
      );

      expect(result).toEqual(study);
      expect(gaps(starts)).toEqual([1000]);
    });

    // The last failure decides (#181, #196): a 429 a rate limit; a 408 or 504 an
    // upstream timeout; a 5xx, a dropped connection, or a body no consumer can
    // read an outage, named for its route and carrying a fixed lastError or the
    // transport code — never upstream or parser text.
    const outage = (what: string) => `ClinicalTrials.gov API unavailable after retries: ${what}.`;
    it.each([
      [
        'HTTP 500',
        jsonResponse(null, 500),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('/studies returned HTTP 500'),
        {
          path: '/studies',
          lastError: 'Error: HTTP 500',
          lastStatus: 500,
          reason: 'upstream_unavailable',
        },
      ],
      [
        'HTTP 502',
        jsonResponse(null, 502),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('/studies returned HTTP 502'),
        {
          path: '/studies',
          lastError: 'Error: HTTP 502',
          lastStatus: 502,
          reason: 'upstream_unavailable',
        },
      ],
      [
        'HTTP 503',
        jsonResponse(null, 503),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('/studies returned HTTP 503'),
        {
          path: '/studies',
          lastError: 'Error: HTTP 503',
          lastStatus: 503,
          reason: 'upstream_unavailable',
        },
      ],
      [
        'HTTP 429',
        jsonResponse(null, 429),
        JsonRpcErrorCode.RateLimited,
        'Rate limited by ClinicalTrials.gov after 3 retries',
        { path: '/studies', lastError: 'Error: HTTP 429', reason: 'rate_limited' },
      ],
      [
        'an HTML page',
        htmlResponse('<html><body>Error</body></html>'),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('/studies returned HTML instead of JSON'),
        {
          path: '/studies',
          lastError: 'Error: API returned HTML instead of JSON',
          reason: 'upstream_unavailable',
        },
      ],
      [
        'a body that is not JSON',
        { ...jsonResponse(null), text: () => Promise.resolve('not json') },
        JsonRpcErrorCode.ServiceUnavailable,
        outage('/studies returned a body that is not JSON'),
        {
          path: '/studies',
          lastError: 'Error: API returned a body that is not JSON',
          reason: 'upstream_unavailable',
        },
      ],
      [
        'JSON of the wrong shape',
        jsonResponse({}),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('/studies returned JSON of an unexpected shape'),
        {
          path: '/studies',
          lastError: 'Error: API returned JSON of an unexpected shape',
          reason: 'upstream_unavailable',
        },
      ],
      [
        'ECONNRESET',
        Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('the connection for /studies failed (ECONNRESET)'),
        { path: '/studies', lastError: 'ECONNRESET', reason: 'upstream_unavailable' },
      ],
      [
        "Bun's connection reset",
        bunFetchError('ECONNRESET'),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('the connection for /studies failed (ECONNRESET)'),
        { path: '/studies', lastError: 'ECONNRESET', reason: 'upstream_unavailable' },
      ],
      [
        "Node's connection reset",
        nodeFetchError('ECONNRESET'),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('the connection for /studies failed (ECONNRESET)'),
        { path: '/studies', lastError: 'ECONNRESET', reason: 'upstream_unavailable' },
      ],
      [
        "Node's socket the other side closed",
        nodeFetchError('UND_ERR_SOCKET'),
        JsonRpcErrorCode.ServiceUnavailable,
        outage('the connection for /studies failed (UND_ERR_SOCKET)'),
        { path: '/studies', lastError: 'UND_ERR_SOCKET', reason: 'upstream_unavailable' },
      ],
      // A gateway or request timeout that outlasts the ladder is an upstream timeout, not an outage.
      [
        'HTTP 504',
        jsonResponse(null, 504),
        JsonRpcErrorCode.Timeout,
        'ClinicalTrials.gov timed out (HTTP 504) on every attempt',
        {
          path: '/studies',
          lastError: 'Error: HTTP 504',
          lastStatus: 504,
          reason: 'upstream_timeout',
        },
      ],
      [
        'HTTP 408',
        jsonResponse(null, 408),
        JsonRpcErrorCode.Timeout,
        'ClinicalTrials.gov timed out (HTTP 408) on every attempt',
        {
          path: '/studies',
          lastError: 'Error: HTTP 408',
          lastStatus: 408,
          reason: 'upstream_timeout',
        },
      ],
    ])(
      'gives up after 1 + maxRetries attempts, one gap apart, on %s',
      async (_label, answer, code, message, data) => {
        const starts = answerInTurn(answer);

        const err = await advanceUntilSettled(service.searchStudies({}, createMockContext())).catch(
          (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(code);
        expect((err as McpError).message).toBe(message);
        expect((err as McpError).data).toEqual(data);
        expect(gaps(starts)).toEqual([1000, 1000, 1000]);
      },
    );

    // Backoff above the 1 s gap between starts, so each retry starts exactly
    // its backoff after the attempt before it. Math.random() = 1 stands for the
    // top of its range, which it approaches but never returns.
    it.each([
      [0, [1500, 3000, 3750]],
      [0.5, [2000, 4000, 5000]],
      [1, [2500, 5000, 6250]],
    ])(
      'backs off base × 2^(n−1), capped at maxBackoffMs, with ±25% jitter: Math.random() = %s',
      async (random, expected) => {
        const backingOff = new ClinicalTrialsService(testConfig, {
          ...fastOptions,
          baseBackoffMs: 2000,
          maxBackoffMs: 5000,
        });
        const starts = answerInTurn(jsonResponse(null, 503));
        const jitter = vi.spyOn(Math, 'random').mockReturnValue(random);
        try {
          await expect(
            advanceUntilSettled(backingOff.searchStudies({}, createMockContext())),
          ).rejects.toThrow(McpError);
        } finally {
          jitter.mockRestore();
        }

        expect(gaps(starts)).toEqual(expected);
      },
    );

    it('exhausts four attempts that each ran out CT_REQUEST_TIMEOUT_MS as upstream_timeout (#196)', async () => {
      const shortAttempts = new ClinicalTrialsService(
        { ...testConfig, requestTimeoutMs: 2000 },
        fastOptions,
      );
      // Never answers; fails only when the attempt's signal aborts.
      mockFetch.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

      const err = (await advanceUntilSettled(
        shortAttempts.getStudy('NCT12345678', createMockContext()),
      ).catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toBe(
        'ClinicalTrials.gov sent no answer to /studies/NCT12345678 within 2000 ms on every attempt',
      );
      expect(err.data).toEqual({
        path: '/studies/NCT12345678',
        lastError: 'TimeoutError',
        timeoutMs: 2000,
        reason: 'upstream_timeout',
      });
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('keeps one 50 s budget across retries of a body it cannot read (#196)', async () => {
      const manyRetries = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        maxRetries: 100,
      });
      mockFetch.mockResolvedValue(jsonResponse(null));
      const t0 = Date.now();

      const err = (await advanceUntilSettled(
        manyRetries.searchStudies({}, createMockContext()),
      ).catch((e: unknown) => e)) as McpError;

      expect(Date.now() - t0).toBe(50_000);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toEqual({
        reason: 'retry_deadline_exceeded',
        deadlineMs: 50_000,
        path: '/studies',
      });
      // One attempt per 1 s request slot, until the budget runs out.
      expect(mockFetch).toHaveBeenCalledTimes(50);
    });

    it('does not retry an AbortError raised by the caller going away', async () => {
      const controller = new AbortController();
      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      mockFetch.mockImplementation(async () => {
        controller.abort();
        throw abortError;
      });

      const ctx = createMockContext({ signal: controller.signal });
      await expect(advanceUntilSettled(service.getStudy('NCT12345678', ctx))).rejects.toMatchObject(
        { code: JsonRpcErrorCode.RequestCancelled },
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry McpError (non-retryable)', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 404));

      await expect(
        advanceUntilSettled(service.getStudy('NCT12345678', createMockContext())),
      ).rejects.toThrow(McpError);
      // 404 → notFound McpError is thrown immediately, no retries
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('rethrows a TypeError it does not recognize untouched and unretried', async () => {
      const error = new TypeError('Invalid URL');
      mockFetch.mockRejectedValue(error);

      await expect(
        advanceUntilSettled(service.getStudy('NCT12345678', createMockContext())),
      ).rejects.toBe(error);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    /**
     * A refused connection or a host name that does not resolve fails the same
     * way on every attempt, so it is sent once — and still ends as an outage
     * with its transport code, never Bun's message (which names the URL).
     */
    it.each([
      ["Bun's refused connection", bunFetchError('ECONNREFUSED'), 'ECONNREFUSED'],
      ["Node's refused connection", nodeFetchError('ECONNREFUSED'), 'ECONNREFUSED'],
      ["Bun's unresolved host name", bunFetchError('ENOTFOUND'), 'ENOTFOUND'],
      ["Node's unresolved host name", nodeFetchError('ENOTFOUND'), 'ENOTFOUND'],
    ])('ends %s as upstream_unavailable, sent once (#196)', async (_label, error, code) => {
      mockFetch.mockRejectedValue(error);

      const err = (await advanceUntilSettled(
        service.getStudy('NCT12345678', createMockContext()),
      ).catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(
        `ClinicalTrials.gov API unavailable: the connection for /studies/NCT12345678 failed (${code}).`,
      );
      expect(err.data).toEqual({
        path: '/studies/NCT12345678',
        lastError: code,
        reason: 'upstream_unavailable',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('checks cancellation before each attempt', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(async () => {
        controller.abort();
        return jsonResponse(null, 503);
      });

      const ctx = createMockContext({ signal: controller.signal });
      await expect(advanceUntilSettled(service.searchStudies({}, ctx))).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        message: 'Request cancelled by caller',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('request throttling (#92)', () => {
    // MIN_INTERVAL_MS in the service. Held as a local literal rather than
    // exported — the spacing between outbound requests is what callers observe,
    // and asserting it here keeps the constant private.
    const MIN_INTERVAL_MS = 1000;

    /** The `query.cond` of each request, in the order the requests went out. */
    const conditions = () =>
      mockFetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('query.cond'));

    it('starts three concurrent callers MIN_INTERVAL_MS apart, in call order', async () => {
      const starts = answerInTurn(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      const all = Promise.all(
        ['a', 'b', 'c'].map((queryCond) => service.searchStudies({ queryCond }, ctx)),
      );
      // Concurrent callers queue for request slots in arrival order; none may
      // start beside another, so the gaps are MIN_INTERVAL_MS, never ~0ms.
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toHaveLength(2);
      await advanceUntilSettled(all);

      expect(gaps(starts)).toEqual([MIN_INTERVAL_MS, MIN_INTERVAL_MS]);
      expect(conditions()).toEqual(['a', 'b', 'c']);
    });

    it('starts a caller arriving mid-wait after the one already waiting', async () => {
      const starts = answerInTurn(jsonResponse({ studies: [] }));
      const ctx = createMockContext();

      // The first starts at once and the second waits out the interval. The
      // third arrives halfway through that wait and must land behind it rather
      // than share the second's slot.
      const first = service.searchStudies({ queryCond: 'a' }, ctx);
      const second = service.searchStudies({ queryCond: 'b' }, ctx);
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS / 2);
      const third = service.searchStudies({ queryCond: 'c' }, ctx);
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS / 2);
      expect(starts).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
      expect(starts).toHaveLength(2);
      await advanceUntilSettled(Promise.all([first, second, third]));

      expect(gaps(starts)).toEqual([MIN_INTERVAL_MS, MIN_INTERVAL_MS]);
      expect(conditions()).toEqual(['a', 'b', 'c']);
    });

    it.each([
      ['an upstream rejection', textResponse('Bad request body'), McpError],
      ['a fetch that throws', new TypeError('fetch failed'), TypeError],
    ])(
      'releases the slot of a request that fails with %s, one gap before the next start',
      async (_label, failure, thrown) => {
        const starts = answerInTurn(failure, jsonResponse({ studies: [] }));
        const ctx = createMockContext();

        await expect(service.getStudy('NCT12345678', ctx)).rejects.toBeInstanceOf(thrown);
        const next = service.searchStudies({ queryCond: 'a' }, ctx);
        await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
        expect(starts).toHaveLength(1);
        await expect(advanceUntilSettled(next)).resolves.toMatchObject({ studies: [] });

        expect(gaps(starts)).toEqual([MIN_INTERVAL_MS]);
      },
    );
  });

  describe('HTML response handling', () => {
    it('retries when API returns HTML instead of JSON', async () => {
      mockFetch
        .mockResolvedValueOnce(htmlResponse('<html><body>Error</body></html>'))
        .mockResolvedValueOnce(jsonResponse({ studies: [] }));

      const ctx = createMockContext();
      const result = await advanceUntilSettled(service.searchStudies({}, ctx));

      expect(result.studies).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678' } } };
    /** A 200 carrying `text` verbatim under `contentType`, read as a real Response reads it. */
    const bodyResponse = (text: string, contentType = 'application/json') => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': contentType }),
      json: () => Promise.resolve(text).then((t) => JSON.parse(t) as unknown),
      text: () => Promise.resolve(text),
    });

    it('retries on DOCTYPE HTML response', async () => {
      mockFetch
        .mockResolvedValueOnce(htmlResponse('<!DOCTYPE html><html>...'))
        .mockResolvedValueOnce(jsonResponse(study));

      const ctx = createMockContext();
      const result = await advanceUntilSettled(service.getStudy('NCT12345678', ctx));

      expect(result).toEqual(study);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('parses non-HTML text as JSON when content-type is not json', async () => {
      mockFetch.mockResolvedValue({
        ...bodyResponse(JSON.stringify(study), 'text/plain'),
        json: () => Promise.reject(new Error('nope')),
      });

      const ctx = createMockContext();
      const result = await service.getStudy('NCT12345678', ctx);
      expect(result).toEqual(study);
    });

    it.each([
      ['an HTML page labelled JSON', bodyResponse('<!DOCTYPE html><html><body>Down</body></html>')],
      ['a lowercase doctype', bodyResponse('<!doctype html>\n<title>Down</title>', 'text/html')],
      ['truncated JSON', bodyResponse('{"protocolSection":{"identificationModule":')],
      ['an empty body', bodyResponse('')],
    ])('retries %s one gap later and returns the next answer (#196)', async (_label, first) => {
      const starts = answerInTurn(first, jsonResponse(study));

      const result = await advanceUntilSettled(
        service.getStudy('NCT12345678', createMockContext()),
      );

      expect(result).toEqual(study);
      expect(gaps(starts)).toEqual([1000]);
    });

    /**
     * Each route's 200 body passes an envelope check before anything reads it:
     * the top level only, never each record. One that fails to parse or fails
     * the check is retried as a 503 is, then ends `upstream_unavailable` naming
     * the route — never quoting the body or the parser (#196).
     */
    describe('a 200 body its route cannot read (#196)', () => {
      const html = 'HTML instead of JSON';
      const notJson = 'a body that is not JSON';
      const shape = 'JSON of an unexpected shape';
      const anyRoute: Array<[string, string, string]> = [
        ['not json', 'text/plain', notJson],
        ['{"totalCount":7495,"studies":[{"protocolSection":', 'application/json', notJson],
        ['', 'application/json', notJson],
        ['<!DOCTYPE html><html><body>Down for maintenance</body></html>', 'application/json', html],
        ['<html><body>Down for maintenance</body></html>', 'text/html', html],
        ['null', 'application/json', shape],
        ['42', 'application/json', shape],
        ['"ok"', 'application/json', shape],
      ];
      const objectRoute: Array<[string, string, string]> = [
        ['[]', 'application/json', shape],
        ['{}', 'application/json', shape],
      ];
      const listRoute: Array<[string, string, string]> = [
        ['[]', 'application/json', shape],
        ['{}', 'application/json', shape],
        ['{"x":[]}', 'application/json', shape],
      ];
      const routes = [
        {
          route: 'a search',
          path: '/studies',
          call: () => service.searchStudies({}, createMockContext()),
          bodies: [
            ...objectRoute,
            ['{"totalCount":5}', 'application/json', shape],
            ['{"studies":"x"}', 'application/json', shape],
          ] as Array<[string, string, string]>,
        },
        {
          route: 'a count',
          path: '/studies',
          call: () => service.countStudies({}, createMockContext()),
          bodies: [...objectRoute, ['{"studies":[]}', 'application/json', shape]] as Array<
            [string, string, string]
          >,
        },
        {
          route: 'a study',
          path: '/studies/NCT12345678',
          call: () => service.getStudy('NCT12345678', createMockContext()),
          bodies: [
            ...objectRoute,
            ['{"ok":true}', 'application/json', shape],
            ['{"protocolSection":null}', 'application/json', shape],
            ['{"protocolSection":[]}', 'application/json', shape],
          ] as Array<[string, string, string]>,
        },
        {
          route: 'the field tree',
          path: '/studies/metadata',
          call: () => service.getMetadata(false, createMockContext()),
          bodies: listRoute,
        },
        {
          route: 'the field tree with index-only pieces',
          path: '/studies/metadata',
          call: () => service.getMetadata(true, createMockContext()),
          bodies: listRoute,
        },
        {
          route: 'value statistics',
          path: '/stats/field/values',
          call: () => service.getFieldValues(['OverallStatus'], createMockContext()),
          bodies: listRoute,
        },
      ];
      const cases = routes.flatMap(({ bodies, ...route }) =>
        [...anyRoute, ...bodies].map(([text, contentType, fault]) => ({
          ...route,
          text,
          contentType,
          fault,
        })),
      );

      it.each(cases)(
        'ends $route answered $text ($contentType) upstream_unavailable after retries',
        async ({ call, path, contentType, fault, text }) => {
          mockFetch.mockResolvedValue(bodyResponse(text, contentType));

          const err = (await advanceUntilSettled<unknown>(call()).catch(
            (e: unknown) => e,
          )) as McpError;

          expect(err).toBeInstanceOf(McpError);
          expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
          expect(err.message).toBe(
            `ClinicalTrials.gov API unavailable after retries: ${path} returned ${fault}.`,
          );
          expect(err.data).toEqual({
            path,
            lastError: `Error: API returned ${fault}`,
            reason: 'upstream_unavailable',
          });
          // Neither runtime's parser text (Bun `JSON Parse error: Unexpected identifier`,
          // Node `Unexpected token`) nor any of the body reaches the message.
          expect(err.message).not.toMatch(
            /Unexpected (token|identifier|EOF)|Parse error|maintenance/,
          );
          expect(mockFetch).toHaveBeenCalledTimes(4);
        },
      );

      /** A field-validating service whose /studies/search-areas read answers `areas()`. */
      function servingSearchAreas(areas: () => unknown) {
        mockFetch.mockImplementation((url: string) => {
          const { pathname, searchParams } = new URL(url);
          if (pathname === '/v2/studies/search-areas') return Promise.resolve(areas());
          if (pathname === '/v2/studies/metadata') {
            return Promise.resolve(
              jsonResponse(
                searchParams.has('includeIndexedOnly') ? INDEXED_METADATA : RECORD_METADATA,
              ),
            );
          }
          return Promise.resolve(jsonResponse({ studies: [] }));
        });
        return new ClinicalTrialsService(testConfig, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
      }

      it.each([
        ['an empty array', '[]'],
        ['an object', '{}'],
        ['unparseable text', 'not json'],
      ])(
        'treats a search-areas read answering %s as failed and keeps nothing of it',
        async (_label, text) => {
          let areas: unknown = bodyResponse(text);
          const svc = servingSearchAreas(() => areas);

          const lookup = await advanceUntilSettled(svc.getAreaIndex(createMockContext()));
          await expect(advanceUntilSettled(lookup!.extended!())).resolves.toBeUndefined();

          // The next call reads it afresh, and keeps it once it reads.
          areas = jsonResponse(SEARCH_AREAS);
          const next = await advanceUntilSettled(svc.getAreaIndex(createMockContext()));
          await expect(advanceUntilSettled(next!.extended!())).resolves.toBeDefined();
        },
      );
    });

    /**
     * The envelope check reads only the top level, so it refuses no 200 the
     * registry serves. Bodies verbatim from ClinicalTrials.gov (2026-11-13);
     * the study records and metadata slices are the suite's own live captures.
     */
    describe('no live 200 is refused (#196)', () => {
      const COUNT_PAGE =
        '{"totalCount":7495,"studies":[\n{"protocolSection":{"identificationModule":{"nctId":"NCT06233123"}}}\n],"nextPageToken":"ZVNj7o2Elu8o3lpyWN2mp7LumpOQJJxuZvCk0A"}';
      const ZERO_COUNT = '{"totalCount":0,"studies":[\n\n]}';
      const SEARCH_PAGE =
        '{"studies":[\n{"protocolSection":{"identificationModule":{"nctId":"NCT06233123","briefTitle":"Efficacy of a Phone Application on Treatment Adherence in Asthmatic Patients in Upper Egypt"}}},\n{"protocolSection":{"identificationModule":{"nctId":"NCT07457762","briefTitle":"AIRDROP: Can we Improve Adherence to Inhaled Treatment for Pulmonary Arterial Hypertension?"}}}\n],"nextPageToken":"ZVNj7o2Elu8o3lpyWN2mp7LumpOQJJxuYPah0A"}';
      const ZERO_SEARCH = '{"studies":[\n\n]}';
      // Page 2 of a walk sent countTotal=true: upstream sends no totalCount past page 1.
      const CONTINUATION_PAGE =
        '{"studies":[\n{"protocolSection":{"identificationModule":{"nctId":"NCT07457762"}}}\n],"nextPageToken":"ZVNj7o2Elu8o3lpyWN2mp7LumpOQJJxuYPah0A"}';
      const OVERALL_STATUS =
        '{"type":"ENUM","piece":"OverallStatus","field":"protocolSection.statusModule.overallStatus","missingStudiesCount":0,"uniqueValuesCount":14,"topValues":[{"value":"COMPLETED","studiesCount":334851},{"value":"UNKNOWN","studiesCount":98754},{"value":"RECRUITING","studiesCount":64888},{"value":"TERMINATED","studiesCount":34718},{"value":"NOT_YET_RECRUITING","studiesCount":30109},{"value":"ACTIVE_NOT_RECRUITING","studiesCount":22148},{"value":"WITHDRAWN","studiesCount":16992},{"value":"ENROLLING_BY_INVITATION","studiesCount":5268},{"value":"SUSPENDED","studiesCount":1757},{"value":"WITHHELD","studiesCount":991},{"value":"NO_LONGER_AVAILABLE","studiesCount":545},{"value":"AVAILABLE","studiesCount":249},{"value":"APPROVED_FOR_MARKETING","studiesCount":245},{"value":"TEMPORARILY_NOT_AVAILABLE","studiesCount":37}]}';
      const PHASE =
        '{"type":"ENUM","piece":"Phase","field":"protocolSection.designModule.phases","missingStudiesCount":145000,"uniqueValuesCount":6,"topValues":[{"value":"NA","studiesCount":241248},{"value":"PHASE2","studiesCount":91006},{"value":"PHASE1","studiesCount":66284},{"value":"PHASE3","studiesCount":50227},{"value":"PHASE4","studiesCount":36106},{"value":"EARLY_PHASE1","studiesCount":6543}]}';

      it.each([
        ['a first count page', COUNT_PAGE, 7495],
        ['a zero-match count', ZERO_COUNT, 0],
      ])('counts %s', async (_label, text, total) => {
        mockFetch.mockResolvedValue(bodyResponse(text));

        await expect(service.countStudies({}, createMockContext())).resolves.toBe(total);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['a search page without totalCount', SEARCH_PAGE, {}],
        ['a zero-match search', ZERO_SEARCH, {}],
        [
          'a continuation page sent countTotal=true',
          CONTINUATION_PAGE,
          { countTotal: true, pageToken: 'ZVNj7o2Elu8o3lpyWN2mp7LumpOQJJxuZvCk0A' },
        ],
        ['a first count page read as a search', COUNT_PAGE, { countTotal: true }],
      ])('returns %s', async (_label, text, params) => {
        mockFetch.mockResolvedValue(bodyResponse(text));

        await expect(service.searchStudies(params, createMockContext())).resolves.toEqual(
          JSON.parse(text),
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['with resultsSection', 'nct03722472'],
        ['without resultsSection', 'nct06323538'],
      ])('returns a study %s', async (_label, fixture) => {
        const { loadStudyFixture } = await import('../../helpers/format-parity.js');
        const record = loadStudyFixture(fixture);
        mockFetch.mockResolvedValue(bodyResponse(JSON.stringify(record)));

        await expect(service.getStudy('NCT03722472', createMockContext())).resolves.toEqual(record);
      });

      it.each([
        ['the field tree', false, RECORD_METADATA],
        ['the field tree with index-only pieces', true, INDEXED_METADATA],
      ])('returns %s', async (_label, includeIndexedOnly, tree) => {
        mockFetch.mockResolvedValue(bodyResponse(JSON.stringify(tree)));

        await expect(service.getMetadata(includeIndexedOnly, createMockContext())).resolves.toEqual(
          tree,
        );
      });

      it.each([
        ['one field', ['OverallStatus'], `[${OVERALL_STATUS}]`],
        ['two fields', ['OverallStatus', 'Phase'], `[${OVERALL_STATUS},${PHASE}]`],
      ])('returns value statistics for %s', async (_label, fields, text) => {
        mockFetch.mockResolvedValue(bodyResponse(text));

        // No field index here, so every piece goes undetermined (#192).
        await expect(service.getFieldValues(fields, createMockContext())).resolves.toEqual({
          stats: JSON.parse(text),
          multiValuedUndetermined: fields,
        });
      });

      it('reads the search areas', async () => {
        mockFetch.mockImplementation((url: string) => {
          const { pathname, searchParams } = new URL(url);
          if (pathname === '/v2/studies/search-areas') {
            return Promise.resolve(bodyResponse(JSON.stringify(SEARCH_AREAS)));
          }
          return Promise.resolve(
            jsonResponse(
              searchParams.has('includeIndexedOnly') ? INDEXED_METADATA : RECORD_METADATA,
            ),
          );
        });
        const svc = new ClinicalTrialsService(testConfig, {
          ...fastOptions,
          validateFieldsLocally: true,
        });

        const lookup = await advanceUntilSettled(svc.getAreaIndex(createMockContext()));

        await expect(advanceUntilSettled(lookup!.extended!())).resolves.toBeDefined();
      });
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
        // The argument the caller sends next, rendered as a code span in content[].
        expect((err as McpError).literals).toEqual(['fields=["OverallStatus"]']);
      }
    });

    // phaseFilter entries are validated in the tool handlers before any request
    // (#144), so this upstream rejection can only come from the caller's own
    // AREA[Phase] expression in advancedFilter or a query parameter — naming
    // phaseFilter would send the caller to a parameter they never set. The
    // AREA[Phase] spelling comes from the field index; this service runs
    // without one, which names the path (see "an enum value an AREA[]
    // expression carries" for the indexed message).
    it('translates the Essie phase enum error without naming phaseFilter (#71, #144)', async () => {
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
          'Invalid value in an AREA[] expression for enum field `protocolSection.designModule.phases`. Valid values: NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4.',
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
          'Use one of the valid values: NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4.',
        );
      }
    });

    it('names an enum field by its upstream path, with no param, when local validation is off', async () => {
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

    // The parameter name is upstream's, read out of the body; a name an object
    // literal's prototype carries must read as no known parameter, not as one.
    it.each(['constructor', '__proto__'])(
      'reads an upstream parameter named %s as no parameter the caller set',
      async (upstreamParam) => {
        mockFetch.mockResolvedValue(
          textResponse(`Invalid value in parameter \`${upstreamParam}\`: \`BADSTATUS\``),
        );
        const err = await advanceUntilSettled(
          service.searchStudies({ filterOverallStatus: ['BADSTATUS'] }, createMockContext()),
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).message).toBe(
          'Invalid value for the filter parameter. \'BADSTATUS\' is not a valid value. Call clinicaltrials_get_field_values with fields=["OverallStatus"] to discover valid enum values.',
        );
        expect((err as McpError).data).toEqual({
          reason: 'enum_invalid',
          recovery: {
            hint: 'Call clinicaltrials_get_field_values with fields=["OverallStatus"] to see valid values.',
          },
          value: 'BADSTATUS',
        });
      },
    );

    it('attaches reason=rate_limited after 429 retries exhaust', async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, 429));
      const ctx = createMockContext({ errors: allReasons });
      try {
        await advanceUntilSettled(service.searchStudies({}, ctx));
        expect.fail('should have thrown');
      } catch (err) {
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('rate_limited');
        expect(data?.recovery).toBeUndefined();
      }
    });

    // The two upstream-failure reasons (#196) ride data.reason alone, as every
    // service reason does: the declaring contract supplies the hint.
    it.each([
      ['a 503 on every attempt', jsonResponse(null, 503), 'upstream_unavailable'],
      ['a body that is not the route’s JSON', jsonResponse({}), 'upstream_unavailable'],
      ['HTTP 403', jsonResponse(null, 403), 'upstream_rejected'],
    ])('attaches its reason and no recovery for %s', async (_label, answer, reason) => {
      mockFetch.mockResolvedValue(answer);
      const ctx = createMockContext({ errors: allReasons });

      const err = (await advanceUntilSettled(service.searchStudies({}, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).toBe(reason);
      expect(err.data?.recovery).toBeUndefined();
    });

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
                // The live tree's type: `sort` suggestions come only from date
                // and numeric types (#184), and upstream lists no `INTEGER`.
                type: 'integer',
                description: 'Number of participants enrolled in the study.',
              },
            ],
          },
        ],
      },
    ];
    /** The includeIndexedOnly form: the same tree plus one index-only piece. */
    const sampleIndexed: FieldNode[] = [
      ...sampleMetadata,
      { name: 'numLocations', piece: 'NumLocations', type: 'short', indexedOnly: true },
    ];

    /**
     * Answer each endpoint by its path: both metadata reads with `metadata`
     * (by default the sample tree, with its index-only piece on the
     * includeIndexedOnly read), the search-areas read with SEARCH_AREAS, the
     * search and the field-values read with `primary`; anything else is an
     * unmocked request.
     */
    function mockByRoute(routes: { metadata?: unknown; primary?: unknown } = {}) {
      mockFetch.mockImplementation((url: string | URL) => {
        const { pathname, searchParams } = new URL(String(url));
        if (pathname === '/v2/studies/metadata') {
          return Promise.resolve(
            routes.metadata ??
              jsonResponse(searchParams.has('includeIndexedOnly') ? sampleIndexed : sampleMetadata),
          );
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
      await advanceUntilSettled(
        validatingService.searchStudies({ sort: 'enrollmentCount:desc' }, ctx),
      );

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
      await advanceUntilSettled(
        validatingService.searchStudies({ sort: ' NCTId:asc, briefTitle:desc' }, ctx),
      );

      const studiesCall = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => !u.includes('/studies/metadata'));
      expect(new URL(studiesCall!).searchParams.get('sort')).toBe('NCTId:asc,BriefTitle:desc');
    });

    it('lowercases an ASC/DESC direction suffix (#107)', async () => {
      // Upstream accepts only lowercase; `EnrollmentCount:DESC` is rejected.
      mockByRoute();
      const ctx = createMockContext();
      await advanceUntilSettled(
        validatingService.searchStudies({ sort: 'EnrollmentCount:DESC' }, ctx),
      );

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
      await advanceUntilSettled(validatingService.searchStudies({ sort: '@relevance' }, ctx));
      const first = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => !u.includes('/studies/metadata'));
      expect(new URL(first!).searchParams.get('sort')).toBe('@relevance');

      mockFetch.mockClear();
      mockByRoute();
      // An unrecognized name also reads the index-only and search-area sources
      // first (#179), one gap apart on the fake clock.
      const next = createMockContext();
      await advanceUntilSettled(validatingService.searchStudies({ sort: 'Bogus:desc' }, next));
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
        await advanceUntilSettled(validatingService.searchStudies({ sort: 'Enrolment:desc' }, ctx));
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
        await advanceUntilSettled(validatingService.searchStudies({ sort: 'Bogus:desc' }, ctx));
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
      const result = await advanceUntilSettled(
        validatingService.searchStudies({ fields: ['NCTId', 'BriefTitle'] }, ctx),
      );
      expect(result.studies).toEqual([]);
    });

    it('rejects getFieldValues with an invalid field name', async () => {
      mockByRoute();
      const ctx = createMockContext();
      // A record-tier miss reads the index-only pieces first, a pacer gap later (#194).
      await expect(
        advanceUntilSettled(validatingService.getFieldValues(['NotAField'], ctx)),
      ).rejects.toThrow(/Invalid field name: 'NotAField'/);
      const sent = mockFetch.mock.calls.map(([u]) => new URL(String(u)).pathname);
      expect(sent).not.toContain('/v2/stats/field/values');
    });

    it('fails open when metadata is unreachable so the request still proceeds', async () => {
      mockByRoute({
        metadata: jsonResponse(null, 404),
        primary: jsonResponse({ studies: [] }),
      });
      const ctx = createMockContext();
      const result = await advanceUntilSettled(
        validatingService.searchStudies({ fields: ['BadName'] }, ctx),
      );
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
      await advanceUntilSettled(validatingService.searchStudies({ fields: ['NCTId'] }, ctx));
      await advanceUntilSettled(validatingService.searchStudies({ fields: ['BriefTitle'] }, ctx));
      expect(metadataCalls).toBe(1);
    });

    it('silently normalizes case-only field-name mismatches before validation', async () => {
      mockByRoute();
      const ctx = createMockContext();
      // `nctid` and `BRIEFTITLE` both have unambiguous case-folded canonicals
      // in the sample metadata. Should pass through without throwing.
      const result = await advanceUntilSettled(
        validatingService.searchStudies({ fields: ['nctid', 'BRIEFTITLE'] }, ctx),
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
      const result = await advanceUntilSettled(
        validatingService.searchStudies({ fields: [' NCTId ', 'BriefTitle\t'] }, ctx),
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
      mockByRoute({
        metadata: jsonResponse(metadata),
        primary: jsonResponse([
          {
            field: 'protocolSection.statusModule.overallStatus',
            piece: 'OverallStatus',
            type: 'ENUM',
            missingStudiesCount: 0,
            uniqueValuesCount: 14,
            topValues: [{ value: 'COMPLETED', studiesCount: 334_851 }],
          },
        ]),
      });
      const ctx = createMockContext();

      await advanceUntilSettled(validatingService.getFieldValues(['RecruitmentStatus'], ctx));

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

      const result = await advanceUntilSettled(
        validatingService.getFieldValues(['Phase', 'OverallStatus'], ctx),
      );

      const phase = result.stats.find((s) => s.piece === 'Phase');
      const status = result.stats.find((s) => s.piece === 'OverallStatus');
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

      const result = await advanceUntilSettled(
        validatingService.getFieldValues(['LocationCountry'], ctx),
      );
      expect(result.stats[0]?.multiValued).toBe(true);
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

      const result = await advanceUntilSettled(
        validatingService.getFieldValues(['LocationContactName'], ctx),
      );
      expect(result.stats[0]?.multiValued).toBe(true);
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

      const result = await advanceUntilSettled(
        validatingService.getFieldValues(['LocationCountry'], ctx),
      );
      // Only multiValued is added; every provider-supplied number survives.
      expect(result.stats[0]).toEqual({ ...upstream, multiValued: true });
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

      const result = await advanceUntilSettled(
        validatingService.getFieldValues(['OverallStatus'], ctx),
      );
      expect(result.stats[0]?.multiValued).toBeUndefined();
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

      const result = await advanceUntilSettled(validatingService.getFieldValues(['Phase'], ctx));
      expect(result.stats[0]?.multiValued).toBeUndefined();
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

  // What a name's metadata type decides: which pieces a `sort` suggestion may
  // name (#184), which paths `fields` maps to a piece (#189), and which pieces
  // clinicaltrials_get_field_values refuses as groups of fields (#191).
  describe('field and sort names against the live data model (#184, #189, #191)', () => {
    type Ctx = ReturnType<typeof createMockContext>;
    /** A live node: name, piece, sourceType, type, and altPieceNames verbatim (captured 2026-11-09). */
    const leaf = (
      name: string,
      piece: string,
      sourceType: string,
      type: string,
      altPieceNames?: string[],
    ): FieldNode => ({
      name,
      piece,
      sourceType,
      type,
      ...(altPieceNames ? { altPieceNames } : {}),
    });
    /** A live `STRUCT` node, a group of fields. */
    const group = (
      name: string,
      piece: string,
      type: string,
      children: FieldNode[],
    ): FieldNode => ({
      name,
      piece,
      sourceType: 'STRUCT',
      type,
      children,
    });

    /**
     * A slice of `/studies/metadata`: the pieces the three issues name, beside
     * the near misses a suggestion must never land on — groups, text, enums,
     * `DateType`. `indexed` is the `includeIndexedOnly=true` read, which adds
     * three index-only nodes where upstream puts them.
     */
    const model = (indexed: boolean): FieldNode[] => {
      const io = (node: FieldNode) => (indexed ? [{ ...node, indexedOnly: true }] : []);
      return [
        group('protocolSection', 'ProtocolSection', 'ProtocolSection', [
          group('identificationModule', 'IdentificationModule', 'IdentificationModule', [
            leaf('nctId', 'NCTId', 'TEXT', 'nct', ['NCT-ID']),
            leaf('briefTitle', 'BriefTitle', 'TEXT', 'text', ['BRIEF-TITLE']),
            leaf('officialTitle', 'OfficialTitle', 'TEXT', 'text', ['OFFICIAL-TITLE']),
          ]),
          group('statusModule', 'StatusModule', 'StatusModule', [
            leaf('statusVerifiedDate', 'StatusVerifiedDate', 'DATE', 'PartialDate', [
              'VERIFICATION-DATE',
            ]),
            leaf('overallStatus', 'OverallStatus', 'TEXT', 'Status', ['OVERALL-STATUS']),
            group('startDateStruct', 'StartDateStruct', 'PartialDateStruct', [
              leaf('date', 'StartDate', 'DATE', 'PartialDate', ['START-DATE']),
              leaf('type', 'StartDateType', 'TEXT', 'DateType'),
            ]),
            group('completionDateStruct', 'CompletionDateStruct', 'PartialDateStruct', [
              leaf('date', 'CompletionDate', 'DATE', 'PartialDate', ['COMPLETION-DATE']),
              leaf('type', 'CompletionDateType', 'TEXT', 'DateType'),
            ]),
            group('studyFirstPostDateStruct', 'StudyFirstPostDateStruct', 'DateStruct', [
              leaf('date', 'StudyFirstPostDate', 'DATE', 'NormalizedDate', ['STUDY-FIRST-POSTED']),
            ]),
            leaf('lastUpdateSubmitDate', 'LastUpdateSubmitDate', 'DATE', 'NormalizedDate', [
              'LAST-UPDATE-SUBMITTED',
              'LAST-RELEASE-DATE',
            ]),
            group('lastUpdatePostDateStruct', 'LastUpdatePostDateStruct', 'DateStruct', [
              leaf('date', 'LastUpdatePostDate', 'DATE', 'NormalizedDate', ['LAST-UPDATE-POSTED']),
              leaf('type', 'LastUpdatePostDateType', 'TEXT', 'DateType'),
              ...io(
                leaf(
                  'lastUpdatePostYear',
                  'LastUpdatePostYear',
                  'FUNC MinYear(LastUpdatePostDate)',
                  'short',
                ),
              ),
            ]),
          ]),
          group(
            'sponsorCollaboratorsModule',
            'SponsorCollaboratorsModule',
            'SponsorCollaboratorsModule',
            [
              group('leadSponsor', 'LeadSponsor', 'Sponsor', [
                leaf('name', 'LeadSponsorName', 'TEXT', 'text', ['SPONSOR', 'LEAD-SPONSOR']),
                leaf('class', 'LeadSponsorClass', 'TEXT', 'AgencyClass', ['LEAD-SPONSOR-CLASS']),
              ]),
            ],
          ),
          group('conditionsModule', 'ConditionsModule', 'ConditionsModule', [
            leaf('conditions', 'Condition', 'TEXT', 'text[]', ['CONDITIONS']),
          ]),
          group('designModule', 'DesignModule', 'DesignModule', [
            leaf('phases', 'Phase', 'TEXT', 'Phase[]', ['PHASE']),
            group('enrollmentInfo', 'EnrollmentInfo', 'EnrollmentInfo', [
              leaf('count', 'EnrollmentCount', 'NUMERIC', 'integer', ['ENROLLMENT']),
              leaf('type', 'EnrollmentType', 'TEXT', 'EnrollmentType'),
            ]),
          ]),
          group('armsInterventionsModule', 'ArmsInterventionsModule', 'ArmsInterventionsModule', [
            group('armGroups', 'ArmGroup', 'ArmGroup[]', [
              leaf('label', 'ArmGroupLabel', 'TEXT', 'text', ['ARM-GROUP-LABEL']),
              leaf('type', 'ArmGroupType', 'TEXT', 'ArmGroupType', [
                'ARM-GROUP-TYPE',
                'ARM-GROUP-TYPES',
              ]),
            ]),
          ]),
          group('contactsLocationsModule', 'ContactsLocationsModule', 'ContactsLocationsModule', [
            group('locations', 'Location', 'Location[]', [
              leaf('facility', 'LocationFacility', 'TEXT', 'text', ['LOCATION-NAME', 'FACILITY']),
              leaf('status', 'LocationStatus', 'TEXT', 'RecruitmentStatus', ['LOCATION-STATUS']),
              leaf(
                'geoPoint',
                'LocationGeoPoint',
                'FUNC GeoPoint(LocationCity, LocationState, LocationCountry)',
                'GeoPoint',
              ),
              ...io(
                leaf(
                  'countryCode',
                  'LocationCountryCode',
                  'FUNC CountryCode(LocationCountry)',
                  'keyword',
                ),
              ),
            ]),
            ...io(
              leaf('numLocations', 'NumLocations', 'FUNC NOccrs(Location)', 'short', [
                'NUMBER-OF-LOCATIONS',
              ]),
            ),
          ]),
        ]),
        group('derivedSection', 'DerivedSection', 'DerivedSection', [
          group('conditionBrowseModule', 'ConditionBrowseModule', 'BrowseModule', [
            group('meshes', 'ConditionMesh', 'Mesh[]', [
              leaf('id', 'ConditionMeshId', 'TEXT', 'text'),
              leaf('term', 'ConditionMeshTerm', 'TEXT', 'text'),
            ]),
            group('browseLeaves', 'ConditionBrowseLeaf', 'BrowseLeaf[]', [
              leaf('relevance', 'ConditionBrowseLeafRelevance', 'TEXT', 'BrowseLeafRelevance'),
            ]),
          ]),
          group('interventionBrowseModule', 'InterventionBrowseModule', 'BrowseModule', [
            group('browseLeaves', 'InterventionBrowseLeaf', 'BrowseLeaf[]', [
              leaf('relevance', 'InterventionBrowseLeafRelevance', 'TEXT', 'BrowseLeafRelevance'),
            ]),
          ]),
        ]),
      ];
    };

    /** Each piece's node in the indexed read, walked here rather than by the code under test. */
    const nodeOf = new Map<string, FieldNode>();
    const walk = (nodes: FieldNode[]): void => {
      for (const node of nodes) {
        if (node.piece) nodeOf.set(node.piece, node);
        walk(node.children ?? []);
      }
    };
    walk(model(true));
    /** The types upstream sorts on, `[]` stripped (#184's upstream table, 2026-11-09). */
    const SORTABLE = new Set([
      'NormalizedDate',
      'PartialDate',
      'DateTimeMinutes',
      'integer',
      'long',
      'short',
    ]);
    const sorts = (piece: string) =>
      SORTABLE.has(nodeOf.get(piece)?.type?.replace(/\[\]$/, '') ?? '');

    /** Answer each endpoint by its path; a search and a field-values read get `primary`. */
    const routes = ({
      metadata = jsonResponse(model(false)),
      primary = jsonResponse({ studies: [] }),
    }: {
      metadata?: unknown;
      primary?: unknown;
    } = {}) =>
      mockFetch.mockImplementation((url: string | URL) => {
        const { pathname, searchParams } = new URL(String(url));
        if (pathname === '/v2/studies/metadata') {
          return Promise.resolve(
            searchParams.get('includeIndexedOnly') === 'true'
              ? jsonResponse(model(true))
              : metadata,
          );
        }
        if (pathname === '/v2/studies/search-areas') {
          return Promise.resolve(jsonResponse(SEARCH_AREAS));
        }
        if (pathname === '/v2/studies' || pathname === '/v2/stats/field/values') {
          return Promise.resolve(primary);
        }
        return Promise.reject(new Error('unmocked fetch'));
      });

    /** Every request sent, as URLs. */
    const requests = () => mockFetch.mock.calls.map(([url]) => new URL(String(url)));
    /** The searches and field-values reads sent — every request but a reference read. */
    const primaryRequests = () =>
      requests().filter(
        ({ pathname }) => pathname === '/v2/studies' || pathname === '/v2/stats/field/values',
      );
    /** Whether either second-tier source was read. */
    const readSecondTier = () =>
      requests().some(
        (u) =>
          u.pathname === '/v2/studies/search-areas' || u.searchParams.has('includeIndexedOnly'),
      );

    /** Settle `pending` on the fake clock and return the error it rejects with. */
    const rejection = (pending: Promise<unknown>): Promise<McpError> =>
      advanceUntilSettled(pending).then(
        () => {
          throw new Error('expected a rejection');
        },
        (err: unknown) => err as McpError,
      );

    /** The names each `'X' — did you mean …?` clause in `message` offers, keyed by X. */
    const didYouMean = (message: string) =>
      Object.fromEntries(
        [...message.matchAll(/'([^']+)' — did you mean ((?:'[^']+'(?:, )?)+)\?/g)].map(
          ([, name, list]) => [name, [...list!.matchAll(/'([^']+)'/g)].map(([, p]) => p)],
        ),
      );

    const SORTABLE_GUIDANCE =
      'Sort on a date or numeric field (e.g. LastUpdatePostDate, EnrollmentCount), or use "@relevance".';

    let validating: ClinicalTrialsService;
    beforeEach(() => {
      validating = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
    });

    describe('sort suggestions name only fields upstream sorts on (#184)', () => {
      // Each list is what this slice answers. The full live tree leads each with
      // the same pieces and may add more this slice omits (StudyFirstPostDate
      // for StartDateStruct ranks on its description, which the slice leaves
      // out). Before the fix, the pool was every record piece: `Enrolment` drew
      // EnrollmentInfo (STRUCT) and EnrollmentType (enum) too.
      it.each([
        ['conditionsearch', 'Unknown sort field', {}],
        ['title:asc', 'Unknown sort field', {}],
        ['Bogus:desc', 'Unknown sort field', {}],
        ['Enrolment:desc', 'Unknown sort field', { Enrolment: ['EnrollmentCount'] }],
        ['NumLocation:desc', 'Unknown sort field', { NumLocation: ['NumLocations'] }],
        ['NumberOfLocations:desc', 'Unknown sort field', { NumberOfLocations: ['NumLocations'] }],
        [
          'lastupdate:desc',
          'Unknown sort field',
          { lastupdate: ['LastUpdatePostDate', 'LastUpdateSubmitDate'] },
        ],
        ['startdat:desc', 'Unknown sort field', { startdat: ['StartDate'] }],
        ['Status:desc', 'Unknown sort field', { Status: ['StatusVerifiedDate'] }],
        [
          'StartDateStruct:desc',
          'Unsupported sort field type: PartialDateStruct',
          { StartDateStruct: ['StartDate', 'CompletionDate'] },
        ],
        [
          'OverallStatus:asc',
          'Unsupported sort field type: Status',
          { OverallStatus: ['StatusVerifiedDate'] },
        ],
        ['LeadSponsor:asc', 'Unsupported sort field type: Sponsor', {}],
        ['LocationCountryCode:asc', 'Unsupported sort field type: keyword', {}],
        ['BriefTitle:asc', 'Unsupported sort field type: text', {}],
      ] as const)('%s (%s)', async (sort, body, offered) => {
        routes({ primary: textResponse(body) });
        const err = await rejection(validating.searchStudies({ sort }, createMockContext()));

        expect(err.data).toEqual({ reason: 'sort_invalid', value: sort });
        expect(didYouMean(err.message)).toEqual(offered);
        for (const piece of Object.values(offered).flat()) {
          expect(sorts(piece), `${piece} sorts`).toBe(true);
        }
        // Both branches say what sorts, the unknown-name one included.
        expect(err.message).toContain(SORTABLE_GUIDANCE);
      });

      it('keeps today’s message, with no suggestion, for an unsortable piece no sortable one resembles', async () => {
        routes({ primary: textResponse('Unsupported sort field type: text') });
        const err = await rejection(
          validating.searchStudies({ sort: 'Condition:asc' }, createMockContext()),
        );

        expect(err.message).toBe(
          `Invalid value for \`sort\`: 'Condition:asc'. ClinicalTrials.gov does not sort on text fields. ${SORTABLE_GUIDANCE} Format must be FieldName:asc or FieldName:desc (e.g. "LastUpdatePostDate:desc", "EnrollmentCount:asc"). Max 2 fields comma-separated.`,
        );
      });
    });

    describe('a relevance sort goes out as @relevance (#184)', () => {
      const rewrites = [
        ['relevance', '@relevance'],
        ['Relevance:desc', '@relevance:desc'],
        ['RELEVANCE:ASC', '@relevance:asc'],
        ['@Relevance', '@relevance'],
      ] as const;

      it.each([
        [
          'with local validation disabled',
          () => service,
          () => mockFetch.mockResolvedValue(jsonResponse({ studies: [] })),
        ],
        ['with the field index loaded', () => validating, () => routes()],
        [
          'with the metadata unavailable',
          () => validating,
          () => routes({ metadata: jsonResponse(null, 404) }),
        ],
      ] as const)('%s', async (_name, subject, mock) => {
        mock();
        const logs: Array<ReturnType<typeof logCallsOf>> = [];
        for (const sort of [...rewrites.map(([from]) => from), '@relevance']) {
          const ctx = createMockContext();
          await advanceUntilSettled(subject().searchStudies({ sort }, ctx));
          logs.push(logCallsOf(ctx).filter((c) => c.msg === 'Sort field auto-corrected'));
        }

        expect(primaryRequests().map((u) => u.searchParams.get('sort'))).toEqual([
          ...rewrites.map(([, to]) => to),
          '@relevance',
        ]);
        expect(logs).toEqual([
          ...rewrites.map(([from, to]) => [
            {
              level: 'notice',
              msg: 'Sort field auto-corrected',
              data: { corrections: [{ from, to }] },
            },
          ]),
          [],
        ]);
        // `@relevance` names no field, so it never reads the second tier.
        expect(readSecondTier()).toBe(false);
      });

      it('logs one notice carrying the relevance rewrite beside the field-name fold', async () => {
        routes();
        const ctx = createMockContext();
        await advanceUntilSettled(
          validating.searchStudies({ sort: 'relevance,enrollmentCount:desc' }, ctx),
        );

        expect(primaryRequests().map((u) => u.searchParams.get('sort'))).toEqual([
          '@relevance,EnrollmentCount:desc',
        ]);
        expect(logCallsOf(ctx).filter((c) => c.msg === 'Sort field auto-corrected')).toEqual([
          {
            level: 'notice',
            msg: 'Sort field auto-corrected',
            data: {
              corrections: [
                { from: 'relevance', to: '@relevance' },
                { from: 'enrollmentCount:desc', to: 'EnrollmentCount:desc' },
              ],
            },
          },
        ]);
      });

      it('fits filter IDs to the rewritten sort, which is three bytes longer (#163)', async () => {
        /**
         * The #163 arithmetic: n IDs fit while pad + sort + 14n ≤ 7877, where
         * `&sort=%40relevance` takes 18 bytes and `&sort=relevance` 15. With a
         * 7707-byte pad, 10 IDs fit the sort that goes out; measured on the sort
         * as written, 11 would, leaving the paging reserve 3 bytes short.
         */
        mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
        const result = await service.searchStudies(
          {
            queryTerm: 'a'.repeat(7707),
            filterIds: ids(15),
            includeUnknownEnrollment: true,
            sort: 'relevance',
          },
          createMockContext(),
        );

        const [sent] = primaryRequests();
        expect(sent?.searchParams.get('filter.ids')?.split('|')).toEqual(ids(10));
        expect(result.deferredIds).toEqual(ids(5, 10));
        expect(sent?.searchParams.get('sort')).toBe('@relevance');
      });
    });

    describe('a metadata path in fields goes out as its piece (#189)', () => {
      it('sends the reproduction’s two paths as NCTId|OverallStatus, naming both in one notice', async () => {
        routes();
        const ctx = createMockContext();
        const fields = [
          'protocolSection.identificationModule.nctId',
          'protocolSection.statusModule.overallStatus',
        ];
        await advanceUntilSettled(validating.searchStudies({ fields }, ctx));

        expect(primaryRequests().map((u) => u.searchParams.get('fields'))).toEqual([
          'NCTId|OverallStatus',
        ]);
        expect(logCallsOf(ctx)).toContainEqual({
          level: 'notice',
          msg: 'Field names auto-corrected',
          data: {
            corrections: [
              { from: fields[0], to: 'NCTId' },
              { from: fields[1], to: 'OverallStatus' },
            ],
          },
        });
      });

      it.each([
        // A module or section path names its own piece, which a search returns whole.
        ['protocolSection.statusModule', 'StatusModule'],
        ['protocolSection.StatusModule.OverallStatus', 'OverallStatus'],
        ['PROTOCOLSECTION.STATUSMODULE.OVERALLSTATUS', 'OverallStatus'],
        [' protocolSection.statusModule.overallStatus\t', 'OverallStatus'],
        ['protocolSection.sponsorCollaboratorsModule.leadSponsor.name', 'LeadSponsorName'],
        ['derivedSection.conditionBrowseModule.meshes.term', 'ConditionMeshTerm'],
      ])('sends %j as %s', async (path, piece) => {
        routes();
        await advanceUntilSettled(
          validating.searchStudies({ fields: [path] }, createMockContext()),
        );

        expect(primaryRequests().map((u) => u.searchParams.get('fields'))).toEqual([piece]);
      });

      it('reads value statistics for a leaf path as its piece', async () => {
        const stats = [{ field: 'OverallStatus', piece: 'OverallStatus', type: 'ENUM' }];
        routes({ primary: jsonResponse(stats) });
        const result = await advanceUntilSettled(
          validating.getFieldValues(
            ['protocolSection.statusModule.overallStatus'],
            createMockContext(),
          ),
        );

        expect(result).toEqual({ stats });
        expect(primaryRequests().map((u) => u.searchParams.get('fields'))).toEqual([
          'OverallStatus',
        ]);
      });

      it('refuses a module path on value statistics as the group it names', async () => {
        routes({ primary: jsonResponse([]) });
        const err = await rejection(
          validating.getFieldValues(['protocolSection.statusModule'], createMockContext()),
        );

        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['StatusModule'],
          suggestions: {
            StatusModule: ['StatusVerifiedDate', 'OverallStatus', 'LastUpdateSubmitDate'],
          },
        });
        expect(primaryRequests()).toEqual([]);
      });

      it('ranks a dotted name no path matches on its last segment, never on a module or section', async () => {
        routes();
        const phase = await rejection(
          validating.searchStudies(
            { fields: ['protocolSection.designModule.phase'] },
            createMockContext(),
          ),
        );
        const nope = await rejection(
          validating.searchStudies(
            { fields: ['protocolSection.statusModule.nope'] },
            createMockContext(),
          ),
        );

        expect(phase.message).toBe(
          "Invalid field name: 'protocolSection.designModule.phase'. 'protocolSection.designModule.phase' — did you mean 'Phase'?",
        );
        expect(phase.data).toEqual({
          reason: 'field_invalid',
          invalid: ['protocolSection.designModule.phase'],
          suggestions: { 'protocolSection.designModule.phase': ['Phase'] },
        });
        expect(nope.message).toBe("Invalid field name: 'protocolSection.statusModule.nope'.");
        expect(nope.data).toEqual({
          reason: 'field_invalid',
          invalid: ['protocolSection.statusModule.nope'],
        });
        expect(primaryRequests()).toEqual([]);
      });

      it('sends a path unchanged when the metadata is unavailable', async () => {
        const path = 'protocolSection.statusModule.overallStatus';
        const unavailable = jsonResponse(null, 503);
        routes({ metadata: unavailable });
        await advanceUntilSettled(
          validating.searchStudies({ fields: [path] }, createMockContext()),
        );
        routes({
          metadata: unavailable,
          primary: jsonResponse([{ field: path, piece: 'OverallStatus', type: 'ENUM' }]),
        });
        await advanceUntilSettled(validating.getFieldValues([path], createMockContext()));

        expect(primaryRequests().map((u) => u.searchParams.get('fields'))).toEqual([path, path]);
      });
    });

    describe('value statistics refuse a group of fields (#191)', () => {
      it('names a group with its leaf pieces before any request', async () => {
        routes({ primary: jsonResponse([]) });
        const err = await rejection(
          validating.getFieldValues(['ConditionMesh'], createMockContext()),
        );

        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.message).toBe(
          "'ConditionMesh' is a group of fields; ClinicalTrials.gov counts values in its leaf pieces only: 'ConditionMeshId', 'ConditionMeshTerm'.",
        );
        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['ConditionMesh'],
          suggestions: { ConditionMesh: ['ConditionMeshId', 'ConditionMeshTerm'] },
        });
        expect(primaryRequests()).toEqual([]);
      });

      it('names every group in the call, and only the groups, beside a valid leaf', async () => {
        routes({ primary: jsonResponse([]) });
        const err = await rejection(
          validating.getFieldValues(['Phase', 'LeadSponsor', 'ArmGroup'], createMockContext()),
        );

        expect(err.message).toBe(
          "'LeadSponsor' is a group of fields; ClinicalTrials.gov counts values in its leaf pieces only: 'LeadSponsorName', 'LeadSponsorClass'. 'ArmGroup' is a group of fields; ClinicalTrials.gov counts values in its leaf pieces only: 'ArmGroupLabel', 'ArmGroupType'.",
        );
        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['LeadSponsor', 'ArmGroup'],
          suggestions: {
            LeadSponsor: ['LeadSponsorName', 'LeadSponsorClass'],
            ArmGroup: ['ArmGroupLabel', 'ArmGroupType'],
          },
        });
        expect(primaryRequests()).toEqual([]);
      });

      it('points a group holding only groups at its drill path, listing no leaves', async () => {
        routes({ primary: jsonResponse([]) });
        const err = await rejection(
          validating.getFieldValues(['ProtocolSection'], createMockContext()),
        );

        expect(err.message).toBe(
          `'ProtocolSection' holds only groups of fields; call clinicaltrials_get_field_definitions with mode="drill" and path="protocolSection" to find its leaf pieces.`,
        );
        expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['ProtocolSection'] });
        expect(primaryRequests()).toEqual([]);
      });

      it('reports an unknown name and a group in one refusal, in input order', async () => {
        routes({ primary: jsonResponse([]) });
        const err = await rejection(
          validating.getFieldValues(['ConditionMesh', 'Bogus', 'Phase'], createMockContext()),
        );

        expect(err.message).toBe(
          "Invalid field name: 'Bogus'. 'ConditionMesh' is a group of fields; ClinicalTrials.gov counts values in its leaf pieces only: 'ConditionMeshId', 'ConditionMeshTerm'.",
        );
        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['ConditionMesh', 'Bogus'],
          suggestions: { ConditionMesh: ['ConditionMeshId', 'ConditionMeshTerm'] },
        });
      });

      it('never suggests a group for an unknown name there, though a search still does', async () => {
        routes({ primary: jsonResponse([]) });
        const values = await rejection(validating.getFieldValues(['Status'], createMockContext()));
        const search = await rejection(
          validating.searchStudies({ fields: ['Status'] }, createMockContext()),
        );

        const offered = (err: McpError) =>
          (err.data as { suggestions: { Status: string[] } }).suggestions.Status;
        expect(offered(values)).toEqual(['StatusVerifiedDate', 'OverallStatus', 'LocationStatus']);
        for (const piece of offered(values)) {
          expect(nodeOf.get(piece)?.sourceType, piece).not.toBe('STRUCT');
        }
        expect(offered(search)).toContain('StatusModule');
      });

      it('still sends a group in a search’s fields, which returns it whole', async () => {
        routes();
        await advanceUntilSettled(
          validating.searchStudies(
            { fields: ['ConditionMesh', 'StatusModule'] },
            createMockContext(),
          ),
        );

        expect(primaryRequests().map((u) => u.searchParams.get('fields'))).toEqual([
          'ConditionMesh|StatusModule',
        ]);
      });

      describe('the upstream refusal, `Unsupported field type`', () => {
        const NOTE =
          'It counts values in leaf pieces of other types: a group of fields such as LeadSponsor or ConditionMesh is refused the same way, and its leaf pieces (LeadSponsorName, ConditionMeshTerm) are counted.';

        it.each([[['LocationGeoPoint']], [['Phase', 'LocationGeoPoint']]])(
          'names the leaf whose type it reports among %j',
          async (fields) => {
            routes({ primary: textResponse('Unsupported field type: GeoPoint') });
            const err = await rejection(validating.getFieldValues(fields, createMockContext()));

            expect(err.message).toBe(
              `Invalid field for value statistics: 'LocationGeoPoint' has type GeoPoint, which ClinicalTrials.gov does not count. ${NOTE}`,
            );
            expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['LocationGeoPoint'] });
            expect(primaryRequests()).toHaveLength(1);
          },
        );

        it('names the one field sent when the metadata is unavailable', async () => {
          routes({
            metadata: jsonResponse(null, 404),
            primary: textResponse('Unsupported field type: Mesh'),
          });
          const err = await rejection(
            validating.getFieldValues(['ConditionMesh'], createMockContext()),
          );

          expect(err.message).toBe(
            `Invalid field for value statistics: 'ConditionMesh' has type Mesh, which ClinicalTrials.gov does not count. ${NOTE}`,
          );
          expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['ConditionMesh'] });
        });

        it('names none of several fields sent without local validation, since upstream does not say', async () => {
          mockFetch.mockResolvedValue(textResponse('Unsupported field type: Sponsor'));
          const err = await rejection(
            service.getFieldValues(['Phase', 'LeadSponsor'], createMockContext()),
          );

          expect(err.message).toBe(
            `Invalid field for value statistics: ClinicalTrials.gov does not count fields of type Sponsor, and does not say which of 'Phase', 'LeadSponsor' has it. ${NOTE}`,
          );
          expect(err.data).toEqual({ reason: 'field_invalid' });
        });
      });
    });

    it.each([
      ['a search', (fields: string[], ctx: Ctx) => validating.searchStudies({ fields }, ctx)],
      ['value statistics', (fields: string[], ctx: Ctx) => validating.getFieldValues(fields, ctx)],
    ] as const)('refuses `constructor` on %s as unknown, never a rename', async (_, call) => {
      // The rename table was an object literal, so `constructor` read Object's
      // prototype and went on as a function.
      routes({ primary: jsonResponse([]) });
      for (const name of ['constructor', 'Constructor']) {
        const err = await rejection(call([name], createMockContext()));
        expect(err.message).toBe(`Invalid field name: '${name}'.`);
        expect(err.data).toEqual({ reason: 'field_invalid', invalid: [name] });
      }
      expect(primaryRequests()).toEqual([]);
    });

    describe("the caller's cancellation during the field-index load", () => {
      it.each([
        ['value statistics', (ctx: Ctx) => validating.getFieldValues(['Phase'], ctx)],
        [
          'a search with fields',
          (ctx: Ctx) => validating.searchStudies({ fields: ['NCTId'] }, ctx),
        ],
        // No warning was logged here before either: upstream would have been
        // spared only by the cancellation check ahead of each request.
        [
          'a search with a sort',
          (ctx: Ctx) => validating.searchStudies({ sort: 'enrollmentCount:desc' }, ctx),
        ],
      ] as const)('ends %s as RequestCancelled, never as metadata unavailable', async (_, call) => {
        const controller = new AbortController();
        mockFetch.mockImplementation((_url: string | URL, init?: RequestInit) => {
          const pending = new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
          controller.abort();
          return pending;
        });
        const ctx = createMockContext({ signal: controller.signal });
        const err = await rejection(call(ctx));

        expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(logCallsOf(ctx).filter((c) => c.level === 'warning')).toEqual([]);
        expect(primaryRequests()).toEqual([]);
      });
    });

    describe('parseUnsupportedFieldType', () => {
      it.each([
        ['Unsupported field type: Mesh', 'Mesh'],
        ['Unsupported field type: GeoPoint', 'GeoPoint'],
        ['Unsupported field type:IdentificationModule', 'IdentificationModule'],
        ['Unsupported field type: ArmGroup', 'ArmGroup'],
      ])('reads %j', (text, type) => {
        expect(parseUnsupportedFieldType(text)).toBe(type);
      });

      it.each([
        'Unsupported sort field type: text',
        'Unknown piece name of field path: Bogus',
        'Unsupported field type: ',
        '',
      ])('reads no type in %j', (text) => {
        expect(parseUnsupportedFieldType(text)).toBeUndefined();
      });

      describe('stays linear on caller-sized text', { timeout: 0 }, () => {
        it.each([
          ...LINE_BREAK_SHAPES.map(([name, shape]) => [name, shape, undefined] as const),
          [
            'a whitespace run after the colon',
            (n: number) => `Unsupported field type:${' '.repeat(n)}`,
            undefined,
          ],
          [
            'a whitespace run after the colon, then a type',
            (n: number) => `Unsupported field type:${'\n \t'.repeat(n / 3)}GeoPoint`,
            'GeoPoint',
          ],
          // Each prefix's type is the next prefix's first word.
          [
            'repeated prefixes',
            (n: number) => 'Unsupported field type: '.repeat(n / 24),
            'Unsupported',
          ],
          [
            'repeated prefixes with no space or type',
            (n: number) => 'Unsupported field type:'.repeat(n / 23).replaceAll(':', ':.'),
            undefined,
          ],
        ] as const)('%s', (_name, shape, type) => {
          expectLinearGrowth((input) => {
            if (parseUnsupportedFieldType(input) !== type) throw new Error('unexpected type');
          }, shape);
        });

        it('a type as long as the request allows', () => {
          expectLinearGrowth(
            (input) => {
              if (parseUnsupportedFieldType(input)?.length !== input.length - 24) {
                throw new Error('type cut short');
              }
            },
            (n) => `Unsupported field type: ${'X'.repeat(n)}`,
          );
        });
      });
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
        const err = await advanceUntilSettled(
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
        const err = await advanceUntilSettled(
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
        const err = await advanceUntilSettled(
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
        const err = await advanceUntilSettled(
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
        const suggested: string[] = [];
        for (const name of names) {
          for (const detail of [
            `Unknown area name: \`${name}\``,
            `This type of query is not allowed for ${name}`,
          ]) {
            route(parseError(detail));
            const err = await advanceUntilSettled(
              rejection(() =>
                validating.countStudies({ filterAdvanced: `AREA[${name}]x` }, createMockContext()),
              ),
            );
            expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: [name] });
            const { suggestions } = err.data as { suggestions?: Record<string, string[]> };
            suggested.push(...(suggestions?.[name] ?? []));
          }
        }

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
        const err = await advanceUntilSettled(
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

    // A valid field named where upstream refuses it: inside SEARCH[Location](…)
    // when no site holds it (#183), or under RANGE[] when its type takes no
    // range (#187). Each is field_invalid with a hint of its own, since the
    // declared one (look the name up) misdirects for a name already right.
    describe('a valid field upstream refuses where it stands (#183, #187)', () => {
      /** RECORD_METADATA plus the enum and boolean nodes these bodies name, verbatim from the live tree (2026-11-09). */
      const REFUSAL_METADATA: FieldNode[] = [
        ...RECORD_METADATA.map((node) =>
          node.name === 'protocolSection'
            ? {
                ...node,
                children: [
                  ...(node.children ?? []),
                  {
                    name: 'designModule',
                    piece: 'DesignModule',
                    sourceType: 'STRUCT',
                    type: 'DesignModule',
                    children: [
                      {
                        name: 'studyType',
                        piece: 'StudyType',
                        sourceType: 'TEXT',
                        type: 'StudyType',
                        isEnum: true,
                      },
                      {
                        name: 'phases',
                        piece: 'Phase',
                        sourceType: 'TEXT',
                        type: 'Phase[]',
                        isEnum: true,
                      },
                    ],
                  },
                ],
              }
            : node,
        ),
        {
          name: 'hasResults',
          piece: 'HasResults',
          sourceType: 'FUNC Present(ResultsFirstSubmitDate)',
          type: 'boolean',
        },
      ];
      /** Answer both metadata reads and the search-area list, and every search with `primary`. */
      const refusing = (primary: unknown, metadata: unknown = jsonResponse(REFUSAL_METADATA)) =>
        mockFetch.mockImplementation((url: string | URL) => {
          const { pathname, searchParams } = new URL(String(url));
          if (pathname === '/v2/studies/metadata') {
            return Promise.resolve(
              searchParams.get('includeIndexedOnly') === 'true'
                ? jsonResponse(INDEXED_METADATA)
                : metadata,
            );
          }
          if (pathname === '/v2/studies/search-areas') {
            return Promise.resolve(jsonResponse(SEARCH_AREAS));
          }
          return Promise.resolve(primary);
        });
      const reads = () =>
        mockFetch.mock.calls.filter((c) => !String(c[0]).includes('/v2/studies?'));
      const hint = (err: McpError) => (err.data as { recovery?: { hint?: string } }).recovery?.hint;

      describe('a field inside SEARCH[Location](…) that no site holds (#183)', () => {
        it('names the field, the site fields, and the form beside the wrapper, with no index read', async () => {
          refusing(parseError('`OverallStatus` is outside Location scope'));
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'SEARCH[Location](AREA[OverallStatus]RECRUITING)' },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toBe(
            "Error parsing query in advanced filter: `OverallStatus` is outside Location scope. SEARCH[Location](…) holds only the fields of one site — LocationFacility, LocationCity, LocationState, LocationZip, LocationCountry, LocationStatus, and the LocationContact… fields — so 'OverallStatus', a field of the study, goes beside it, joined with AND: AREA[OverallStatus]RECRUITING AND SEARCH[Location](AREA[LocationCity]Seattle).",
          );
          expect(err.data).toEqual({
            reason: 'field_invalid',
            invalid: ['OverallStatus'],
            recovery: {
              hint: "Move AREA[OverallStatus] out of SEARCH[Location](…) and join it beside the wrapper with AND, as in AREA[OverallStatus]RECRUITING AND SEARCH[Location](AREA[LocationCity]Seattle). For one site's own recruiting status, use AREA[LocationStatus] inside the wrapper.",
            },
          });
          expect(err.literals).toEqual([
            'AREA[OverallStatus]',
            'SEARCH[Location](…)',
            'AREA[OverallStatus]RECRUITING AND SEARCH[Location](AREA[LocationCity]Seattle)',
            'AREA[LocationStatus]',
          ]);
          expect(reads()).toEqual([]);
        });

        it.each([
          ['Location terms', { queryLocn: 'SEARCH[Location](AREA[Phase]PHASE2)' }, 'Phase'],
          ['Other terms', { queryTerm: 'SEARCH[Location](AREA[Condition]asthma)' }, 'Condition'],
          // Upstream names the first of several offenders, and so does the message.
          [
            'advanced filter',
            {
              filterAdvanced:
                'SEARCH[Location](AREA[LocationCity]Seattle AND AREA[Phase]PHASE2 AND AREA[OverallStatus]RECRUITING)',
            },
            'Phase',
          ],
        ] as const)('reads the same refusal in %s', async (where, params, name) => {
          refusing(parseError(`\`${name}\` is outside Location scope`, where));
          const err = await advanceUntilSettled(
            rejection(() => validating.searchStudies(params, createMockContext())),
          );

          expect(err.message).toMatch(new RegExp(`^Error parsing query in ${where}: `));
          expect(err.message).toContain(`so '${name}', a field of the study, goes beside it`);
          expect(err.message).not.toContain('Free-text');
          expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: [name] });
          expect(hint(err)).toContain(`Move AREA[${name}] out of SEARCH[Location](…)`);
        });

        it('tells a search area named inside the wrapper to go outside it, with no did-you-mean', async () => {
          refusing(parseError('Unknown area name: `LocationSearch`'));
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'SEARCH[Location](AREA[LocationSearch]Seattle)' },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toBe(
            "Error parsing query in advanced filter: Unknown area name: `LocationSearch`. 'LocationSearch' is a search area, and search areas go outside SEARCH[Location](…), which holds only the fields of one site: LocationFacility, LocationCity, LocationState, LocationZip, LocationCountry, LocationStatus, and the LocationContact… fields.",
          );
          expect(err.data).toEqual({
            reason: 'field_invalid',
            invalid: ['LocationSearch'],
            recovery: {
              hint: 'Move AREA[LocationSearch] out of SEARCH[Location](…) and join it beside the wrapper with AND, or name a site field such as AREA[LocationCity] inside the wrapper.',
            },
          });
          expect(err.literals).toEqual([
            'AREA[LocationSearch]',
            'SEARCH[Location](…)',
            'AREA[LocationCity]',
          ]);
        });

        it('keeps an unknown name inside the wrapper the unknown-name field_invalid, with the declared hint', async () => {
          refusing(parseError('Unknown area name: `Bogus`'));
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'SEARCH[Location](AREA[Bogus]x)' },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toBe(
            "Error parsing query in advanced filter: Unknown area name: `Bogus` 'Bogus' is not a recognized AREA[]-compatible field. Call clinicaltrials_get_field_definitions to look up valid PascalCase piece names.",
          );
          expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['Bogus'] });
          // The name missed the record tier, so the second tier was read to rule out a search area.
          expect(reads().map((c) => new URL(String(c[0])).pathname)).toEqual([
            '/v2/studies/metadata',
            '/v2/studies/metadata',
            '/v2/studies/search-areas',
          ]);
        });

        it('keeps an unknown search scope the parse error it is, with the upstream sentence', async () => {
          refusing(parseError('Search scope must be `Study` or `Location`'));
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'SEARCH[Foo](AREA[LocationCity]Seattle)' },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toBe(
            'Query syntax error: Search scope must be `Study` or `Location`. Free-text fields take plain words plus AND, OR, NOT.',
          );
          expect(err.data).toEqual({ reason: 'query_parse_error' });
        });
      });

      describe('RANGE[] on a field whose type takes no range (#187)', () => {
        it('names NCTId from the path, and the StudyFirstPostDate window an ID range stands for', async () => {
          refusing(
            parseError(
              'RANGE is not supported for nct field protocolSection.identificationModule.nctId',
            ),
          );
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                {
                  queryCond: 'tuberculosis',
                  filterAdvanced: 'AREA[NCTId]RANGE[NCT03000000, NCT04000000]',
                },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toBe(
            "Error parsing query in advanced filter: RANGE is not supported for nct field protocolSection.identificationModule.nctId. 'NCTId' takes no RANGE[]: RANGE[] takes date, numeric, and age fields (StartDate, EnrollmentCount, MinimumAge). Any other field takes a value, and an enum several values OR-joined: AREA[Phase]PHASE2 OR AREA[Phase]PHASE3. NCT IDs follow first-posting order, so bound StudyFirstPostDate instead: AREA[StudyFirstPostDate]RANGE[2017-01-01, 2018-12-31].",
          );
          expect(err.data).toEqual({
            reason: 'field_invalid',
            invalid: ['NCTId'],
            recovery: {
              hint: 'Bound the first posting date instead of the NCT ID, since NCT IDs are assigned in first-posting order: AREA[StudyFirstPostDate]RANGE[2017-01-01, 2018-12-31].',
            },
          });
          expect(err.literals).toEqual([
            'RANGE[]',
            'AREA[]',
            'AREA[Phase]PHASE2 OR AREA[Phase]PHASE3',
            'AREA[StudyFirstPostDate]RANGE[2017-01-01, 2018-12-31]',
          ]);
        });

        it.each([
          ['text', 'protocolSection.identificationModule.briefTitle', 'BriefTitle'],
          ['Phase', 'protocolSection.designModule.phases', 'Phase'],
          ['boolean', 'hasResults', 'HasResults'],
        ] as const)(
          'names the piece at a %s field path and says to match it by value',
          async (type, path, piece) => {
            refusing(parseError(`RANGE is not supported for ${type} field ${path}`));
            const err = await advanceUntilSettled(
              rejection(() =>
                validating.countStudies(
                  { filterAdvanced: `AREA[${piece}]RANGE[a, z]` },
                  createMockContext(),
                ),
              ),
            );

            expect(err.message).toContain(
              `'${piece}' takes no RANGE[]: RANGE[] takes date, numeric, and age fields (StartDate, EnrollmentCount, MinimumAge). Any other field takes a value, and an enum several values OR-joined: AREA[Phase]PHASE2 OR AREA[Phase]PHASE3.`,
            );
            expect(err.message).not.toContain('StudyFirstPostDate');
            expect(err.message).not.toContain('Free-text');
            expect(err.data).toEqual({
              reason: 'field_invalid',
              invalid: [piece],
              recovery: {
                hint: `Match '${piece}' by value instead of by range, OR-joining several values of an enum as in AREA[Phase]PHASE2 OR AREA[Phase]PHASE3; keep RANGE[] for date, numeric, and age fields (StartDate, EnrollmentCount, MinimumAge).`,
              },
            });
          },
        );

        it('names a group by its STRUCT piece and points at its leaf pieces, not at a value', async () => {
          // Upstream answers RANGE on LeadSponsor before its group refusal.
          refusing(
            parseError(
              'RANGE is not supported for Sponsor field protocolSection.sponsorCollaboratorsModule.leadSponsor',
            ),
          );
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'AREA[LeadSponsor]RANGE[a, z]' },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toContain(
            "'LeadSponsor' takes no RANGE[]: RANGE[] takes date, numeric, and age fields (StartDate, EnrollmentCount, MinimumAge). 'LeadSponsor' is a group of fields, which AREA[] refuses whatever follows it.",
          );
          expect(err.data).toEqual({
            reason: 'field_invalid',
            invalid: ['LeadSponsor'],
            recovery: {
              hint: 'Name one of the leaf pieces of \'LeadSponsor\' instead; clinicaltrials_get_field_definitions with mode="drill" and path="protocolSection.sponsorCollaboratorsModule.leadSponsor" lists them.',
            },
          });
        });

        it('names a path the field index does not hold by the path itself', async () => {
          refusing(
            parseError(
              'RANGE is not supported for keyword field protocolSection.contactsLocationsModule.locations.countryCode',
            ),
          );
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'AREA[LocationCountryCode]RANGE[A, Z]' },
                createMockContext(),
              ),
            ),
          );

          expect(err.data).toMatchObject({
            reason: 'field_invalid',
            invalid: ['protocolSection.contactsLocationsModule.locations.countryCode'],
          });
          expect(hint(err)).toContain(
            "Match 'protocolSection.contactsLocationsModule.locations.countryCode' by value",
          );
        });

        it('names the path, and reads no metadata, with local validation disabled', async () => {
          mockFetch.mockResolvedValue(
            parseError(
              'RANGE is not supported for nct field protocolSection.identificationModule.nctId',
            ),
          );
          const err = await rejection(() =>
            service.countStudies(
              { filterAdvanced: 'AREA[NCTId]RANGE[NCT03000000, NCT04000000]' },
              createMockContext(),
            ),
          );

          expect(err.data).toMatchObject({
            reason: 'field_invalid',
            invalid: ['protocolSection.identificationModule.nctId'],
          });
          expect(err.message).toContain('bound StudyFirstPostDate instead');
          expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('still answers field_invalid, naming the path, when the metadata lookup fails on the error path', async () => {
          refusing(
            parseError(
              'RANGE is not supported for text field protocolSection.identificationModule.briefTitle',
            ),
            jsonResponse(null, 404),
          );
          const ctx = createMockContext();
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies({ filterAdvanced: 'AREA[BriefTitle]RANGE[a, z]' }, ctx),
            ),
          );

          expect(err.data).toMatchObject({
            reason: 'field_invalid',
            invalid: ['protocolSection.identificationModule.briefTitle'],
          });
          expect(
            (ctx.log as unknown as { calls: Array<{ level: string; msg: string }> }).calls,
          ).toContainEqual(
            expect.objectContaining({
              level: 'warning',
              msg: 'AREA[] field-name lookup skipped — metadata unavailable',
            }),
          );
        });

        it('lets the caller’s cancellation through the path lookup', async () => {
          const controller = new AbortController();
          mockFetch.mockImplementation(() => {
            controller.abort();
            return Promise.resolve(
              parseError(
                'RANGE is not supported for nct field protocolSection.identificationModule.nctId',
              ),
            );
          });
          const err = await rejection(() =>
            validating.countStudies(
              { filterAdvanced: 'AREA[NCTId]RANGE[NCT03000000, NCT04000000]' },
              createMockContext({ signal: controller.signal }),
            ),
          );

          expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
          expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it.each([
          ['advanced filter', { filterAdvanced: 'AREA[ConditionSearch]RANGE[1, 2]' }],
          ['Conditions or disease', { queryCond: 'RANGE[1, 2]' }],
        ] as const)(
          'asks for AREA[Field] naming one field, blaming none, in %s',
          async (where, params) => {
            refusing(parseError('RANGE is not supported for multiple (7) fields', where));
            const err = await advanceUntilSettled(
              rejection(() => validating.countStudies(params, createMockContext())),
            );

            expect(err.message).toBe(
              `Error parsing query in ${where}: RANGE is not supported for multiple (7) fields. A bare RANGE[], or one after a search area, spans several fields; RANGE[] needs AREA[Field] naming one of the date, numeric, and age fields (StartDate, EnrollmentCount, MinimumAge).`,
            );
            expect(err.data).toEqual({
              reason: 'field_invalid',
              recovery: {
                hint: 'Name one field before the range with AREA[Field], as in AREA[StartDate]RANGE[2020-01-01, MAX]; RANGE[] takes date, numeric, and age fields (StartDate, EnrollmentCount, MinimumAge).',
              },
            });
            expect(err.literals).toEqual([
              'RANGE[]',
              'AREA[Field]',
              'AREA[StartDate]RANGE[2020-01-01, MAX]',
            ]);
            expect(reads()).toEqual([]);
          },
        );

        it('keeps a bad RANGE bound the parse error it is, with the upstream sentence', async () => {
          refusing(
            parseError(
              'Cannot parse number for `protocolSection.designModule.enrollmentInfo.count` field',
            ),
          );
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'AREA[EnrollmentCount]RANGE[a, z]' },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toBe(
            'Query syntax error: Cannot parse number for `protocolSection.designModule.enrollmentInfo.count` field. Free-text fields take plain words plus AND, OR, NOT.',
          );
          expect(err.data).toEqual({ reason: 'query_parse_error' });
        });
      });

      describe('an enum value an AREA[] expression carries (fold-in)', () => {
        const enumBody = (path: string, values: string[]) =>
          parseError(
            `Allowed values for enum field \`${path}\` are ${values.map((v) => `\`${v}\``).join(', ')}`,
          );

        it.each([
          [
            'protocolSection.designModule.phases',
            'Phase',
            ['NA', 'EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4'],
          ],
          [
            'protocolSection.designModule.studyType',
            'StudyType',
            ['EXPANDED_ACCESS', 'INTERVENTIONAL', 'OBSERVATIONAL'],
          ],
          [
            'protocolSection.statusModule.overallStatus',
            'OverallStatus',
            ['ACTIVE_NOT_RECRUITING', 'COMPLETED', 'NOT_YET_RECRUITING', 'RECRUITING'],
          ],
        ] as const)(
          'names the expression by the piece at %s, the values as literals',
          async (path, piece, values) => {
            refusing(enumBody(path, [...values]));
            const err = await advanceUntilSettled(
              rejection(() =>
                validating.countStudies(
                  { filterAdvanced: `AREA[${piece}]FOO` },
                  createMockContext(),
                ),
              ),
            );
            const list = values.join(', ');

            expect(err.message).toBe(
              `Invalid value in an AREA[${piece}] expression. Valid values: ${list}.`,
            );
            expect(err.data).toEqual({
              reason: 'enum_invalid',
              recovery: { hint: `Use one of the valid values inside AREA[${piece}]: ${list}.` },
              validValues: values,
            });
            expect(err.literals).toEqual([`AREA[${piece}]`, ...values]);
          },
        );

        it('keeps the path wording when the field index holds no such path', async () => {
          refusing(enumBody('protocolSection.designModule.allocation', ['RANDOMIZED', 'NA']));
          const err = await advanceUntilSettled(
            rejection(() =>
              validating.countStudies(
                { filterAdvanced: 'AREA[DesignAllocation]FOO' },
                createMockContext(),
              ),
            ),
          );

          expect(err.message).toBe(
            'Invalid value in an AREA[] expression for enum field `protocolSection.designModule.allocation`. Valid values: RANDOMIZED, NA.',
          );
          expect(err.literals).toEqual(['RANDOMIZED', 'NA']);
        });
      });
    });

    describe('getAreaIndex', () => {
      it('resolves the AREA index, sharing one metadata request with field validation', async () => {
        route(jsonResponse({ studies: [] }));
        const ctx = createMockContext();
        const index = await validating.getAreaIndex(ctx);
        await advanceUntilSettled(validating.searchStudies({ fields: ['NCTId'] }, ctx));

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
        const index = await advanceUntilSettled(validating.getAreaIndex(createMockContext()));
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

      // Live bodies (2026-11-09): the sentence is the same in every parameter,
      // only the `<where>` label differs (#183, #187).
      it.each([
        [
          'Error parsing query in advanced filter: `OverallStatus` is outside Location scope',
          { kind: 'location-scope', name: 'OverallStatus' },
        ],
        [
          'Error parsing query in Location terms: `Phase` is outside Location scope',
          { kind: 'location-scope', name: 'Phase' },
        ],
        [
          'Error parsing query in Other terms: `Condition` is outside Location scope',
          { kind: 'location-scope', name: 'Condition' },
        ],
        [
          'Error parsing query in advanced filter: RANGE is not supported for text field protocolSection.identificationModule.briefTitle',
          { kind: 'range-type', path: 'protocolSection.identificationModule.briefTitle' },
        ],
        [
          'Error parsing query in Other terms: RANGE is not supported for nct field protocolSection.identificationModule.nctId',
          { kind: 'range-type', path: 'protocolSection.identificationModule.nctId' },
        ],
        [
          'Error parsing query in advanced filter: RANGE is not supported for Phase field protocolSection.designModule.phases',
          { kind: 'range-type', path: 'protocolSection.designModule.phases' },
        ],
        [
          'Error parsing query in advanced filter: RANGE is not supported for boolean field hasResults',
          { kind: 'range-type', path: 'hasResults' },
        ],
        [
          'Error parsing query in advanced filter: RANGE is not supported for Sponsor field protocolSection.sponsorCollaboratorsModule.leadSponsor',
          { kind: 'range-type', path: 'protocolSection.sponsorCollaboratorsModule.leadSponsor' },
        ],
        [
          'Error parsing query in Conditions or disease: RANGE is not supported for multiple (7) fields',
          { kind: 'range-fields' },
        ],
        [
          'Error parsing query in advanced filter: RANGE is not supported for multiple (26) fields',
          { kind: 'range-fields' },
        ],
      ] as const)('reads %j', (text, rejection) => {
        expect(parseAreaRejection(text)).toEqual(rejection);
      });

      it.each([
        'Error parsing query in advanced filter: Allowed values for enum field `protocolSection.designModule.phases` are `NA`, `PHASE1`',
        "Error parsing query in Other terms: mismatched input '[' expecting {<EOF>, '('}",
        'Error parsing query in advanced filter: Unknown area name: ``',
        'Error parsing query in advanced filter: Search scope must be `Study` or `Location`',
        'Error parsing query in advanced filter: Cannot parse number for `protocolSection.designModule.enrollmentInfo.count` field',
        'Error parsing query in advanced filter: `` is outside Location scope',
        '',
      ])('reads no refused field in %j', (text) => {
        expect(parseAreaRejection(text)).toBeUndefined();
      });

      describe('stays linear on caller-sized text', { timeout: 0 }, () => {
        /** A rejection as one string to compare: its kind, then the name or path it carries. */
        const summary = (rejection: AreaRejection | undefined) =>
          rejection &&
          [
            rejection.kind,
            'name' in rejection ? rejection.name : '',
            'path' in rejection ? rejection.path : '',
          ]
            .filter(Boolean)
            .join(':');

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
            'unsearchable:This',
          ],
          [
            'a scope name whose backtick never closes',
            (n: number) => `\`${'x'.repeat(n)} is outside Location scope`,
            undefined,
          ],
          [
            'repeated scope sentences naming no scope',
            (n: number) => '`x` is outside '.repeat(n / 15),
            undefined,
          ],
          // Every closing backtick is also the next name's opening one.
          [
            'backticked names edge to edge',
            (n: number) => `${'`x`'.repeat(n / 3)} is outside Location scope`,
            'location-scope:x',
          ],
          [
            'repeated RANGE prefixes',
            (n: number) => 'RANGE is not supported for '.repeat(n / 27),
            undefined,
          ],
          [
            'a type that runs on with no field',
            (n: number) => `RANGE is not supported for ${'x'.repeat(n)}`,
            undefined,
          ],
          [
            'a field count never closed',
            (n: number) => `RANGE is not supported for multiple (${'1'.repeat(n)}`,
            undefined,
          ],
          // Each sentence's path is the next one's `RANGE`.
          [
            'overlapping RANGE sentences',
            (n: number) => 'RANGE is not supported for x field '.repeat(n / 35),
            'range-type:RANGE',
          ],
        ] as const)('%s', (_name, shape, expected) => {
          expectLinearGrowth((input) => {
            if (summary(parseAreaRejection(input)) !== expected) {
              throw new Error('unexpected rejection');
            }
          }, shape);
        });

        it.each([
          [
            'a name as long as the request allows',
            (n: number) => `This type of query is not allowed for ${'X'.repeat(n)}`,
            38,
          ],
          [
            'a scope name as long as the request allows',
            (n: number) => `\`${'X'.repeat(n)}\` is outside Location scope`,
            '`` is outside Location scope'.length,
          ],
          [
            'a RANGE path as long as the request allows',
            (n: number) => `RANGE is not supported for text field ${'p'.repeat(n)}`,
            'RANGE is not supported for text field '.length,
          ],
        ] as const)('%s', (_name, shape, around) => {
          expectLinearGrowth((input) => {
            const rejection = parseAreaRejection(input);
            const carried =
              rejection &&
              ('name' in rejection ? rejection.name : 'path' in rejection ? rejection.path : '');
            if (carried?.length !== input.length - around) throw new Error('cut short');
          }, shape);
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
      /** `/stats/field/values`, answered from the request's URL; unmocked unless given. */
      stats?: (url: URL) => unknown;
      studies?: Answer;
    }

    /** Answer each endpoint by its path; anything else is an unmocked request. */
    const routes = ({
      metadata = jsonResponse(RECORD_METADATA),
      indexed = jsonResponse(INDEXED_METADATA),
      searchAreas = jsonResponse(SEARCH_AREAS),
      stats,
      studies = jsonResponse({ studies: [], totalCount: 7 }),
    }: Routes = {}) =>
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const { pathname, searchParams } = new URL(String(url));
        if (pathname === '/v2/stats/field/values' && stats) {
          return Promise.resolve(stats(new URL(String(url))));
        }
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
        const [first, second] = await advanceUntilSettled(
          (async () => [
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
          ])(),
        );

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
        const out = await advanceUntilSettled(
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
          const err = await advanceUntilSettled(
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
        await advanceUntilSettled(
          (async () => {
            await validating.searchStudies({ sort: 'numlocations:desc' }, ctx);
            await validating.searchStudies({ sort: 'number-of-locations:DESC,NCTId:asc' }, ctx);
          })(),
        );

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
        await advanceUntilSettled(
          (async () => {
            for (const sort of [
              'NumLocations:desc',
              'NUMBER-OF-LOCATIONS:desc',
              'ConditionSearch:asc',
              'conditionsearch:asc',
            ]) {
              await validating.searchStudies({ sort }, createMockContext());
            }
          })(),
        );

        expect(studyRequests().map((u) => u.searchParams.get('sort'))).toEqual([
          'NumLocations:desc',
          'NUMBER-OF-LOCATIONS:desc',
          'ConditionSearch:asc',
          'conditionsearch:asc',
        ]);
      });

      it('sends record fields and @relevance as before, reading neither new endpoint', async () => {
        routes();
        await advanceUntilSettled(
          (async () => {
            for (const sort of ['BriefTitle:asc', 'LastUpdatePostDate:desc', '@relevance']) {
              await validating.searchStudies({ sort }, createMockContext());
            }
          })(),
        );

        expect(studyRequests().map((u) => u.searchParams.get('sort'))).toEqual([
          'BriefTitle:asc',
          'LastUpdatePostDate:desc',
          '@relevance',
        ]);
        expect(requestCounts()).toEqual({ metadata: 1, indexed: 0, searchAreas: 0, studies: 3 });
      });

      it('suggests an index-only near miss first, and never a search area', async () => {
        routes({ studies: textResponse('Unknown sort field') });
        const [indexOnly, area] = await advanceUntilSettled(
          (async () => [
            await rejection(() =>
              validating.searchStudies({ sort: 'NumLocation:desc' }, createMockContext()),
            ),
            await rejection(() =>
              validating.searchStudies({ sort: 'ConditionSearches:asc' }, createMockContext()),
            ),
          ])(),
        );

        expect(indexOnly.data).toMatchObject({ reason: 'sort_invalid' });
        // Only pieces upstream sorts on are offered (#184): the STRUCT Location
        // and the text LocationStatus no longer follow, nor Condition (text[])
        // and ConditionsModule (STRUCT) for the search-area near miss.
        expect(indexOnly.message).toContain(
          "does not recognize the sort field name. 'NumLocation' — did you mean 'NumLocations'? Sort on a date",
        );
        expect(area.message).toContain(
          'does not recognize the sort field name. Sort on a date or numeric field',
        );
        expect(area.message).not.toContain('did you mean');
      });

      it('never suggests an index-only piece upstream refuses to sort on (#184)', async () => {
        // LocationCountryCode is index-only and `keyword`, which upstream answers
        // `Unsupported sort field type: keyword`, so a near miss of it is offered
        // nothing rather than a piece that fails in turn.
        routes({ studies: textResponse('Unknown sort field') });
        const err = await advanceUntilSettled(
          rejection(() =>
            validating.searchStudies({ sort: 'LocationCountryCod:asc' }, createMockContext()),
          ),
        );

        expect(err.data).toMatchObject({ reason: 'sort_invalid' });
        expect(requestCounts().indexed).toBe(1);
        expect(err.message).not.toContain('LocationCountryCode');
        expect(err.message).toContain(
          'does not recognize the sort field name. Sort on a date or numeric field',
        );
      });
    });

    describe('when a read fails', () => {
      const failures = [
        ['404', () => jsonResponse(null, 404)],
        ['403', () => textResponse('Forbidden', 403)],
        ['500', () => jsonResponse(null, 500)],
        ['a hang past the read timeout', () => hang],
        // The search route's parse-error shape, read as a plain 400 here: taken
        // for an AREA[] rejection, its suggestions would wait on this very read.
        [
          'a 400 in the search route’s parse-error shape',
          () => textResponse('Error parsing query in advanced filter: Unknown area name: `x`'),
        ],
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
          const { corrected, err, retried } = await advanceUntilSettled(
            (async () => {
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
            })(),
          );

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
        const { err, sent } = await advanceUntilSettled(
          (async () => {
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
          })(),
        );

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
        const { count, err } = await advanceUntilSettled(
          (async () => {
            const { advancedFilter } = await correct(
              { advancedFilter: 'AREA[NumLocations]RANGE[100,MAX]' },
              ctx,
            );
            const count = await validating.countStudies({ filterAdvanced: advancedFilter }, ctx);
            const err = await rejection(() =>
              validating.searchStudies({ fields: ['Sponsor'] }, createMockContext()),
            );
            return { count, err };
          })(),
        );

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

      it('ends a hung read with its one attempt at the 5 s read timeout, not the request timeout', async () => {
        // The default read timeout, beside a request timeout and a call budget
        // that both lie past it, so only the read's own bound can end it at 5 s.
        const defaults = new ClinicalTrialsService(
          { ...testConfig, requestTimeoutMs: 120_000 },
          { ...fastOptions, validateFieldsLocally: true },
        );
        let read: { abortedAt?: number; startedAt: number } | undefined;
        routes({
          indexed: (init?: RequestInit) => {
            const started = { startedAt: Date.now() } as NonNullable<typeof read>;
            read = started;
            init?.signal?.addEventListener('abort', () => {
              started.abortedAt = Date.now();
            });
            return hang(init);
          },
        });
        const ctx = createMockContext();

        const area = await advanceUntilSettled(defaults.getAreaIndex(ctx));
        const extended = await advanceUntilSettled(area!.extended!());

        expect(extended).toBeUndefined();
        expect(read!.abortedAt! - read!.startedAt).toBe(5000);
        expect(requestCounts().indexed).toBe(1);
      });
    });

    describe('cancellation', () => {
      /**
       * Abort the caller's controller as `response`'s request is sent, then
       * answer as fetch would: rejecting when that request's own signal aborted
       * with it, so a read bound to the caller's signal fails here as it would
       * upstream.
       */
      const abortAs = (controller: AbortController, response: unknown) => (init?: RequestInit) => {
        controller.abort();
        return init?.signal?.aborted ? Promise.reject(init.signal.reason) : response;
      };

      it('rejects as cancelled when the caller aborts mid-load, and keeps the read for the next caller', async () => {
        const controller = new AbortController();
        routes({ indexed: abortAs(controller, jsonResponse(INDEXED_METADATA)) });
        const ctx = createMockContext({ signal: controller.signal });
        const { err, next } = await advanceUntilSettled(
          (async () => ({
            err: await rejection(() => correct({ advancedFilter: 'AREA[numlocations]x' }, ctx)),
            next: await correct({ advancedFilter: 'AREA[numlocations]x' }, createMockContext()),
          }))(),
        );

        expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(err.message).toContain('cancelled by caller');
        expect(logCalls(ctx).filter((c) => c.level === 'warning')).toEqual([]);
        expect(next).toEqual({ advancedFilter: 'AREA[NumLocations]x' });
        expect(requestCounts()).toMatchObject({ indexed: 1, searchAreas: 1 });
      });

      it('lets a concurrent caller finish the load another caller abandoned', async () => {
        const controller = new AbortController();
        routes({ searchAreas: abortAs(controller, jsonResponse(SEARCH_AREAS)) });
        const leaving = createMockContext({ signal: controller.signal });
        const staying = createMockContext();
        const [left, stayed] = await advanceUntilSettled(
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
        const { corrected, exact, folded, found } = await advanceUntilSettled(
          (async () => {
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
          })(),
        );

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

    // `/stats/field/values` counts every index-only piece and every alt name as
    // written, and refuses a mis-cased name and a search area (`Unknown piece
    // name`, live 2026-11-13). So value statistics look a record-tier miss up
    // among the index-only pieces before refusing it, and never read or suggest
    // a search area.
    describe('value statistics (#194)', () => {
      /** `tree` with `nodes` appended to the children of the node at dot path `path`. */
      const addAt = (tree: FieldNode[], path: string, nodes: FieldNode[]): FieldNode[] => {
        const [head, ...rest] = path.split('.');
        return tree.map((node) =>
          node.name !== head
            ? node
            : {
                ...node,
                children:
                  rest.length > 0
                    ? addAt(node.children ?? [], rest.join('.'), nodes)
                    : [...(node.children ?? []), ...nodes],
              },
        );
      };
      /** Live nodes (2026-11-13): Phase repeats itself; StudyFirstPostYear is index-only under no repeated node. */
      const designModule: FieldNode = {
        name: 'designModule',
        piece: 'DesignModule',
        sourceType: 'STRUCT',
        type: 'DesignModule',
        children: [
          {
            name: 'phases',
            piece: 'Phase',
            sourceType: 'TEXT',
            type: 'Phase[]',
            altPieceNames: ['PHASE'],
          },
        ],
      };
      const studyFirstPost = (indexed: boolean): FieldNode => ({
        name: 'studyFirstPostDateStruct',
        piece: 'StudyFirstPostDateStruct',
        sourceType: 'STRUCT',
        type: 'DateStruct',
        children: [
          {
            name: 'date',
            piece: 'StudyFirstPostDate',
            sourceType: 'DATE',
            type: 'NormalizedDate',
            altPieceNames: ['STUDY-FIRST-POSTED'],
          },
          ...(indexed
            ? [
                {
                  name: 'studyFirstPostYear',
                  piece: 'StudyFirstPostYear',
                  indexedOnly: true,
                  sourceType: 'FUNC MinYear(StudyFirstPostDate)',
                  type: 'short',
                },
              ]
            : []),
        ],
      });
      const withStatsPieces = (tree: FieldNode[], indexed: boolean) =>
        addAt(addAt(tree, 'protocolSection', [designModule]), 'protocolSection.statusModule', [
          studyFirstPost(indexed),
        ]);
      const STATS_RECORD = withStatsPieces(RECORD_METADATA, false);
      const STATS_INDEXED = withStatsPieces(INDEXED_METADATA, true);

      /** Live statistics (2026-11-13, top values cut), keyed by the piece upstream echoes. */
      const LIVE_STATS = new Map<string, Record<string, unknown>>([
        [
          'Phase',
          {
            type: 'ENUM',
            piece: 'Phase',
            field: 'protocolSection.designModule.phases',
            missingStudiesCount: 145000,
            uniqueValuesCount: 6,
            topValues: [{ value: 'NA', studiesCount: 241248 }],
          },
        ],
        [
          'NumLocations',
          {
            type: 'INTEGER',
            piece: 'NumLocations',
            field: 'protocolSection.contactsLocationsModule.numLocations',
            missingStudiesCount: 18653,
            min: 0,
            max: 3510,
            avg: 6.008053659788436,
          },
        ],
        [
          'StudyFirstPostYear',
          {
            type: 'INTEGER',
            piece: 'StudyFirstPostYear',
            field: 'protocolSection.statusModule.studyFirstPostDateStruct.studyFirstPostYear',
            missingStudiesCount: 0,
            min: 1999,
            max: 2026,
            avg: 2017.7153880547705,
          },
        ],
        [
          'LocationCountryCode',
          {
            type: 'STRING',
            piece: 'LocationCountryCode',
            field: 'protocolSection.contactsLocationsModule.locations.countryCode',
            missingStudiesCount: 61219,
            uniqueValuesCount: 226,
            topValues: [{ value: 'US', studiesCount: 197011 }],
            longest: { value: 'US', length: 2, nctId: 'NCT00587535' },
          },
        ],
        [
          'OverallStatus',
          {
            type: 'ENUM',
            piece: 'OverallStatus',
            field: 'protocolSection.statusModule.overallStatus',
            missingStudiesCount: 0,
            uniqueValuesCount: 14,
            topValues: [{ value: 'COMPLETED', studiesCount: 334851 }],
          },
        ],
        [
          'CollaboratorName',
          {
            type: 'STRING',
            piece: 'CollaboratorName',
            field: 'protocolSection.sponsorCollaboratorsModule.collaborators.name',
            missingStudiesCount: 418974,
            uniqueValuesCount: 64367,
            topValues: [{ value: 'National Cancer Institute (NCI)', studiesCount: 10890 }],
          },
        ],
      ]);
      /** Alt names upstream resolves as written, each to the piece it echoes (live 2026-11-13). */
      const ALT_PIECE = new Map([
        ['NUMBER-OF-LOCATIONS', 'NumLocations'],
        ['OVERALL-STATUS', 'OverallStatus'],
        ['COLLABORATOR', 'CollaboratorName'],
      ]);
      /** `/stats/field/values` as upstream answers: each name resolved as written, or a 404 naming the first that is not. */
      const upstream = (url: URL) => {
        const names = url.searchParams.get('fields')?.split('|') ?? [];
        const unknown = names.find((name) => !LIVE_STATS.has(ALT_PIECE.get(name) ?? name));
        return unknown === undefined
          ? jsonResponse(
              names.map((name) => structuredClone(LIVE_STATS.get(ALT_PIECE.get(name) ?? name))),
            )
          : textResponse(`Unknown piece name of field path: ${unknown}`, 404);
      };
      /** The live statistic for `piece`, flagged multiValued when `multiValued`. */
      const liveStat = (piece: string, multiValued?: true) => ({
        ...LIVE_STATS.get(piece),
        ...(multiValued ? { multiValued } : {}),
      });
      const statsRoutes = (overrides: Routes = {}) =>
        routes({
          metadata: jsonResponse(STATS_RECORD),
          indexed: jsonResponse(STATS_INDEXED),
          stats: upstream,
          ...overrides,
        });
      /** The `fields` each statistics request sent. */
      const sentFields = () =>
        mockFetch.mock.calls
          .map(([url]) => new URL(String(url)))
          .filter((u) => u.pathname === '/v2/stats/field/values')
          .map((u) => u.searchParams.get('fields'));
      const suggestionsOf = (err: McpError) =>
        (err.data as { suggestions?: Record<string, string[]> }).suggestions ?? {};
      const SEARCH_AREA_NAMES = SEARCH_AREAS.flatMap(({ areas }) => areas.map((a) => a.name));
      const values = (
        fields: string[],
        ctx = createMockContext(),
        service: ClinicalTrialsService = validating,
      ) => advanceUntilSettled(service.getFieldValues(fields, ctx));

      it.each<[string[], Record<string, unknown>[]]>([
        [['NumLocations'], [liveStat('NumLocations')]],
        [
          ['StudyFirstPostYear', 'LocationCountryCode'],
          [liveStat('StudyFirstPostYear'), liveStat('LocationCountryCode', true)],
        ],
        [
          ['Phase', 'NumLocations'],
          [liveStat('Phase', true), liveStat('NumLocations')],
        ],
      ])(
        'answers %j with upstream’s statistics, every piece’s multiValued settled',
        async (fields, stats) => {
          statsRoutes();

          const result = await values(fields);

          expect(sentFields()).toEqual([fields.join('|')]);
          expect(result).toEqual({ stats });
          expect(requestCounts()).toMatchObject({ indexed: 1, searchAreas: 0 });
        },
      );

      it.each([
        ['numlocations', 'NumLocations'],
        ['number-of-locations', 'NumLocations'],
        ['NUMBER-OF-LOCATIONS', 'NUMBER-OF-LOCATIONS'],
        [' NumLocations\t', 'NumLocations'],
      ])('sends %j as %j, and upstream answers it', async (name, sent) => {
        statsRoutes();
        const ctx = createMockContext();

        const result = await values([name], ctx);

        expect(sentFields()).toEqual([sent]);
        expect(result).toEqual({ stats: [liveStat('NumLocations')] });
        expect(
          logCalls(ctx)
            .filter((c) => c.msg === 'Field names auto-corrected')
            .map((c) => c.data),
        ).toEqual(sent === name ? [] : [{ corrections: [{ from: name, to: sent }] }]);
      });

      it('settles multiValued whether upstream echoes the piece or the alt name sent', async () => {
        statsRoutes({
          stats: (url) =>
            jsonResponse(
              (url.searchParams.get('fields') ?? '')
                .split('|')
                .map((name) => ({ field: 'echoed', piece: name, type: 'STRING' })),
            ),
        });

        const result = await values(['CONDITIONS', 'NUMBER-OF-LOCATIONS']);

        expect(result).toEqual({
          stats: [
            { field: 'echoed', piece: 'CONDITIONS', type: 'STRING', multiValued: true },
            { field: 'echoed', piece: 'NUMBER-OF-LOCATIONS', type: 'STRING' },
          ],
        });
      });

      it('flags an index-only piece whose own type repeats, as it flags a record piece', async () => {
        statsRoutes({
          indexed: jsonResponse(
            addAt(STATS_INDEXED, 'protocolSection.conditionsModule', [
              {
                name: 'conditionCodes',
                piece: 'ConditionCode',
                indexedOnly: true,
                type: 'keyword[]',
              },
            ]),
          ),
          stats: (url) =>
            jsonResponse(
              (url.searchParams.get('fields') ?? '')
                .split('|')
                .map((name) => ({ field: 'counted', piece: name, type: 'STRING' })),
            ),
        });

        const result = await values(['ConditionCode', 'NumLocations']);

        expect(result).toEqual({
          stats: [
            { field: 'counted', piece: 'ConditionCode', type: 'STRING', multiValued: true },
            { field: 'counted', piece: 'NumLocations', type: 'STRING' },
          ],
        });
      });

      it('refuses a near miss of an index-only piece, suggesting the piece first, before any request', async () => {
        statsRoutes();

        const err = await rejection(() => values(['NumLocation']));

        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: ['NumLocation'] });
        expect(suggestionsOf(err).NumLocation?.[0]).toBe('NumLocations');
        expect(err.message).toContain("'NumLocation' — did you mean 'NumLocations'");
        expect(sentFields()).toEqual([]);
      });

      it.each([['ConditionSearch'], ['conditionsearch'], ['ConditionSearches']])(
        'refuses the search-area name %j, never reading or suggesting a search area',
        async (name) => {
          statsRoutes();

          const err = await rejection(() => values([name]));

          expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: [name] });
          const suggested = Object.values(suggestionsOf(err)).flat();
          expect(suggested.filter((piece) => SEARCH_AREA_NAMES.includes(piece))).toEqual([]);
          expect(requestCounts().searchAreas).toBe(0);
          expect(sentFields()).toEqual([]);
        },
      );

      it.each([['OverallStatus'], ['overallstatus']])(
        'reads no index-only piece for %j, which the record pieces resolve',
        async (name) => {
          statsRoutes();

          await values([name]);

          expect(sentFields()).toEqual(['OverallStatus']);
          expect(requestCounts()).toMatchObject({ metadata: 1, indexed: 0, searchAreas: 0 });
        },
      );

      // Fold-in: upstream counts a record alt name as written, too.
      it.each<[string, string, Record<string, unknown>]>([
        ['OVERALL-STATUS', 'OVERALL-STATUS', liveStat('OverallStatus')],
        ['overall-status', 'OverallStatus', liveStat('OverallStatus')],
        // Its lowered form names the group Collaborator; as written it is CollaboratorName's.
        ['COLLABORATOR', 'COLLABORATOR', liveStat('CollaboratorName', true)],
      ])(
        'sends the record alt name %j as %j, read from the record pieces alone',
        async (name, sent, stat) => {
          statsRoutes();

          const result = await values([name]);

          expect(sentFields()).toEqual([sent]);
          expect(result).toEqual({ stats: [stat] });
          expect(requestCounts().indexed).toBe(0);
        },
      );

      it('still refuses a lowered name that folds to a group, as that group (#191)', async () => {
        statsRoutes();

        const err = await rejection(() => values(['collaborator']));

        expect(err.data).toEqual({
          reason: 'field_invalid',
          invalid: ['Collaborator'],
          suggestions: { Collaborator: ['CollaboratorName', 'CollaboratorClass'] },
        });
        expect(sentFields()).toEqual([]);
      });

      describe('when the index-only read fails', () => {
        /** The production 5 s bound, beside a request timeout past it, so only that bound ends a hang. */
        const production = () =>
          new ClinicalTrialsService(
            { ...testConfig, requestTimeoutMs: 120_000 },
            { ...fastOptions, validateFieldsLocally: true },
          );
        // The metadata read starts at 0 and the index-only read a pacer gap later;
        // the statistics go out a gap after it fails, or as its 5 s bound ends it.
        const failures = [
          ['404', () => jsonResponse(null, 404), 2000],
          ['503', () => jsonResponse(null, 503), 2000],
          ['a hang', () => hang, 6000],
        ] as const;

        it.each(failures)(
          'sends NumLocations as written when the read answers %s, its multiValued undetermined',
          async (_label, answer, at) => {
            const sentAt: number[] = [];
            statsRoutes({
              indexed: answer(),
              stats: (url) => {
                sentAt.push(Date.now());
                return upstream(url);
              },
            });
            const ctx = createMockContext();
            const startedAt = Date.now();

            const result = await values(['NumLocations'], ctx, production());

            expect(sentAt.map((t) => t - startedAt)).toEqual([at]);
            expect(result).toEqual({
              stats: [liveStat('NumLocations')],
              multiValuedUndetermined: ['NumLocations'],
            });
            expect(requestCounts()).toMatchObject({ indexed: 1, searchAreas: 0 });
            expect(logCalls(ctx)).toContainEqual(
              expect.objectContaining({
                level: 'warning',
                msg: 'Index-only piece lookup skipped — read failed',
              }),
            );
          },
        );

        it.each(failures)(
          'sends Bogus when the read answers %s, and upstream’s 404 refuses it field_invalid',
          async (_label, answer) => {
            statsRoutes({ indexed: answer() });

            const err = await rejection(() => values(['Bogus'], createMockContext(), production()));

            expect(sentFields()).toEqual(['Bogus']);
            expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
            expect(err.message).toMatch(
              /^Invalid field name: 'Bogus'\. Use PascalCase piece names/,
            );
            expect(err.data).toEqual({ reason: 'field_invalid' });
          },
        );

        it('still refuses a group locally beside a name it could not check', async () => {
          statsRoutes({ indexed: jsonResponse(null, 503) });

          const err = await rejection(() => values(['LeadSponsor', 'NumLocations']));

          expect(err.data).toEqual({
            reason: 'field_invalid',
            invalid: ['LeadSponsor'],
            suggestions: { LeadSponsor: ['LeadSponsorName', 'LeadSponsorClass'] },
          });
          expect(sentFields()).toEqual([]);
        });

        it('reads it once per call, for every name the call checks, and afresh on the next call', async () => {
          statsRoutes({ indexed: jsonResponse(null, 503) });
          const result = await values(['numlocations', 'NumLocations']).catch((e: unknown) => e);
          const once = requestCounts().indexed;
          statsRoutes();
          const next = await values(['NumLocations']);

          // Unchecked, the mis-cased name went out as written and upstream refused it.
          expect(result).toMatchObject({ data: { reason: 'field_invalid' } });
          expect(sentFields()).toEqual(['numlocations|NumLocations', 'NumLocations']);
          expect(once).toBe(1);
          expect(requestCounts().indexed).toBe(2);
          expect(next).toEqual({ stats: [liveStat('NumLocations')] });
        });

        it('treats a tree that flags no index-only piece as a failed read, kept for no later call', async () => {
          // The default tree in place of the includeIndexedOnly one: a non-empty array, so it parses.
          statsRoutes({ indexed: () => jsonResponse(STATS_RECORD) });
          const first = await values(['NumLocations']);
          const second = await values(['NumLocations']);

          expect(first).toEqual({
            stats: [liveStat('NumLocations')],
            multiValuedUndetermined: ['NumLocations'],
          });
          expect(second).toEqual(first);
          expect(sentFields()).toEqual(['NumLocations', 'NumLocations']);
          expect(requestCounts().indexed).toBe(2);
        });

        it('ends as RequestCancelled when the caller aborts during the read, logging no warning', async () => {
          const controller = new AbortController();
          statsRoutes({
            indexed: (init?: RequestInit) => {
              controller.abort();
              return hang(init);
            },
          });
          const ctx = createMockContext({ signal: controller.signal });

          const err = await rejection(() => values(['NumLocations'], ctx));

          expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
          expect(logCalls(ctx).filter((c) => c.level === 'warning')).toEqual([]);
          expect(sentFields()).toEqual([]);
        });
      });
    });

    describe('rejections outside the single-study route', () => {
      it('reports a metadata 404 as a missing endpoint, never study_not_found', async () => {
        mockFetch.mockResolvedValue(textResponse('No such endpoint', 404));
        const err = await rejection(() => service.getMetadata(false, createMockContext()));

        expect(err.code).toBe(JsonRpcErrorCode.NotFound);
        expect(err.message).toBe('No such endpoint');
        expect((err.data as Record<string, unknown> | undefined)?.reason).toBeUndefined();
      });

      it('reports a metadata 400 "incorrect format" as the upstream body, never study_not_found', async () => {
        const body = 'Parameter `includeIndexedOnly` has incorrect format';
        mockFetch.mockResolvedValue(textResponse(body, 400));
        const err = await rejection(() => service.getMetadata(true, createMockContext()));

        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.message).toContain(body);
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

    it('reads the index on the full retry ladder once the bounded read fails, and keeps it (#192)', async () => {
      // The bounded read takes one 503; the search's own ladder takes two more
      // and the index. Its answer is the index, so it never ends on one attempt.
      const starts = answerInTurn(
        jsonResponse(null, 503),
        jsonResponse(null, 503),
        jsonResponse(null, 503),
        jsonResponse(sampleMetadata),
      );

      const found = await advanceUntilSettled(
        validatingService.searchFieldDefinitions('enrollment', 5, createMockContext()),
      );
      expect(found.entries[0]!.piece).toBe('EnrollmentCount');
      expect(starts).toHaveLength(4);

      await advanceUntilSettled(
        validatingService.searchFieldDefinitions('sponsor', 5, createMockContext()),
      );
      expect(starts).toHaveLength(4);
    });

    it.each([
      ['an empty list', []],
      ['a tree with no field pieces', [{ name: 'protocolSection', children: [] }]],
    ])(
      'refuses metadata holding %s as upstream_unavailable, never an empty answer (#196)',
      async (_label, tree) => {
        mockFetch.mockResolvedValue(jsonResponse(tree));

        const err = await advanceUntilSettled(
          validatingService.searchFieldDefinitions('status', 5, createMockContext()),
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(McpError);
        expect(err).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_unavailable', path: '/studies/metadata' },
        });
      },
    );
  });

  // A fields list that reaches into posted results caps the search page at 10
  // studies (#198); the tool reads the cap from this classification.
  describe('results projection (#198)', () => {
    /** A slice of the live field tree (2026-11-13), node fields verbatim. */
    const RESULTS_METADATA: FieldNode[] = [
      {
        name: 'protocolSection',
        piece: 'ProtocolSection',
        sourceType: 'STRUCT',
        type: 'ProtocolSection',
        children: [
          {
            name: 'identificationModule',
            piece: 'IdentificationModule',
            sourceType: 'STRUCT',
            type: 'IdentificationModule',
            children: [{ name: 'nctId', piece: 'NCTId', sourceType: 'TEXT', type: 'nct' }],
          },
          {
            name: 'statusModule',
            piece: 'StatusModule',
            sourceType: 'STRUCT',
            type: 'StatusModule',
            children: [
              { name: 'overallStatus', piece: 'OverallStatus', sourceType: 'TEXT', type: 'Status' },
            ],
          },
        ],
      },
      {
        name: 'resultsSection',
        piece: 'ResultsSection',
        sourceType: 'STRUCT',
        type: 'ResultsSection',
        children: [
          {
            name: 'outcomeMeasuresModule',
            piece: 'OutcomeMeasuresModule',
            sourceType: 'STRUCT',
            type: 'OutcomeMeasuresModule',
            children: [
              {
                name: 'outcomeMeasures',
                piece: 'OutcomeMeasure',
                sourceType: 'STRUCT',
                type: 'OutcomeMeasure[]',
                children: [
                  { name: 'title', piece: 'OutcomeMeasureTitle', sourceType: 'TEXT', type: 'text' },
                ],
              },
            ],
          },
          {
            name: 'adverseEventsModule',
            piece: 'AdverseEventsModule',
            sourceType: 'STRUCT',
            type: 'AdverseEventsModule',
            children: [
              { name: 'timeFrame', piece: 'EventsTimeFrame', sourceType: 'TEXT', type: 'text' },
            ],
          },
        ],
      },
      {
        name: 'derivedSection',
        piece: 'DerivedSection',
        sourceType: 'STRUCT',
        type: 'DerivedSection',
      },
    ];

    let validating: ClinicalTrialsService;
    beforeEach(() => {
      validating = new ClinicalTrialsService(testConfig, {
        ...fastOptions,
        validateFieldsLocally: true,
      });
    });

    const requestsTo = (pathname: string) =>
      mockFetch.mock.calls.filter(([url]) => new URL(url as string).pathname === pathname).length;

    /** Answer /studies/metadata with `metadata`, and /studies with an empty page. */
    const serving = (metadata: unknown) =>
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          new URL(url).pathname === '/v2/studies/metadata'
            ? metadata
            : jsonResponse({ studies: [], totalCount: 0 }),
        ),
      );

    it.each([
      ['the results section', ['ResultsSection'], 'results'],
      [
        'a module under results, beside a protocol leaf',
        ['NCTId', 'OutcomeMeasuresModule'],
        'results',
      ],
      ['a group inside a results module', ['OutcomeMeasure'], 'results'],
      ['another results module', ['AdverseEventsModule'], 'results'],
      ['the results section off by case', ['resultssection'], 'results'],
      // A module's piece and path differ past case, so only the piece fold reaches it.
      ['a results module off by case', ['adverseeventsmodule'], 'results'],
      ['a group inside a results module off by case', ['outcomemeasure'], 'results'],
      ['the results section with surrounding whitespace', ['  ResultsSection '], 'results'],
      [
        'a results module by its metadata path',
        ['resultsSection.outcomeMeasuresModule'],
        'results',
      ],
      [
        'a results module by its path off by case',
        ['RESULTSSECTION.ADVERSEEVENTSMODULE'],
        'results',
      ],
      ['a leaf under results', ['NCTId', 'OutcomeMeasureTitle'], 'other'],
      ['a leaf under results off by case', ['outcomemeasuretitle'], 'other'],
      ['the protocol and derived sections', ['ProtocolSection', 'DerivedSection'], 'other'],
      ['a protocol module', ['StatusModule'], 'other'],
      ['a name the field index does not hold', ['NotAField'], 'other'],
    ])('classifies %s as %s', async (_label, fields, expected) => {
      serving(jsonResponse(RESULTS_METADATA));

      const projection = await advanceUntilSettled(
        validating.classifyProjection(fields, createMockContext()),
      );

      expect(projection).toBe(expected);
      expect(requestsTo('/v2/studies/metadata')).toBe(1);
    });

    it("shares the call's one field-index read with the search that follows", async () => {
      serving(jsonResponse(RESULTS_METADATA));
      const ctx = createMockContext();

      await expect(
        advanceUntilSettled(validating.classifyProjection(['ResultsSection'], ctx)),
      ).resolves.toBe('results');
      await advanceUntilSettled(
        validating.searchStudies({ fields: ['ResultsSection'], pageSize: 10 }, ctx),
      );

      expect(requestsTo('/v2/studies/metadata')).toBe(1);
      expect(requestsTo('/v2/studies')).toBe(1);
      const search = mockFetch.mock.calls.find(
        ([url]) => new URL(url as string).pathname === '/v2/studies',
      );
      expect(new URL(search![0] as string).searchParams.get('pageSize')).toBe('10');
    });

    it('is unclassifiable when the field metadata cannot be read, and the search still goes out unchecked', async () => {
      serving(jsonResponse(null, 503));
      const ctx = createMockContext();

      await expect(
        advanceUntilSettled(validating.classifyProjection(['NCTId', 'ResultsSection'], ctx)),
      ).resolves.toBe('unclassifiable');
      await advanceUntilSettled(
        validating.searchStudies({ fields: ['NCTId', 'ResultsSection'], pageSize: 10 }, ctx),
      );

      expect(requestsTo('/v2/studies/metadata')).toBe(1);
      const search = mockFetch.mock.calls.find(
        ([url]) => new URL(url as string).pathname === '/v2/studies',
      );
      expect(new URL(search![0] as string).searchParams.get('fields')).toBe('NCTId|ResultsSection');
    });

    it('is unclassifiable without reading anything when local validation is off', async () => {
      await expect(
        service.classifyProjection(['ResultsSection'], createMockContext()),
      ).resolves.toBe('unclassifiable');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rethrows the caller's cancellation instead of reading it as unclassifiable", async () => {
      // The metadata read never answers; the caller cancels while it waits.
      mockFetch.mockImplementation(() => new Promise(() => {}));
      const controller = new AbortController();
      const pending = validating
        .classifyProjection(['ResultsSection'], createMockContext({ signal: controller.signal }))
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();

      const err = await pending;
      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });

    it('rethrows a cancellation that arrived before the call', async () => {
      const controller = new AbortController();
      controller.abort();

      const err = await validating
        .classifyProjection(['ResultsSection'], createMockContext({ signal: controller.signal }))
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('singleton accessor', () => {
    it('throws when service not initialized', () => {
      expect(() => getClinicalTrialsService()).toThrow(/not initialized/);
    });
  });

  describe('constructor options', () => {
    it('defaults to 3 retries backing off from 1 s, doubling, when options omitted', async () => {
      const defaultService = new ClinicalTrialsService(testConfig);
      const starts = answerInTurn(jsonResponse(null, 503));
      // Centres the ±25% jitter, so each backoff is its base exactly.
      const jitter = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        await expect(
          advanceUntilSettled(defaultService.searchStudies({}, createMockContext())),
        ).rejects.toThrow(/unavailable after retries/);
      } finally {
        jitter.mockRestore();
      }
      // 1 initial + 3 retries; the 30 s cap lies past the third retry's 4 s.
      expect(gaps(starts)).toEqual([1000, 2000, 4000]);
    });
  });

  // One time budget per tool call or resource read, keyed to its Context: every
  // request, attempt, backoff, and gap the call spends comes out of it (#181).
  // Every bound runs on setTimeout, so the fake clock drives each one. The
  // per-attempt timeout sits well above the budget unless a test is about that
  // timeout, so what each assertion reads is the budget's own signal.
  describe('call budget (#181)', () => {
    const BUDGET_MS = 50_000;
    const slowAttempts: ServerConfig = { ...testConfig, requestTimeoutMs: 120_000 };

    interface Sent {
      abortedAt?: number;
      path: string;
      startedAt: number;
    }

    /**
     * Answer each request with the next of `answers`, the last repeating: `'hang'`
     * never answers and fails only when the request's signal aborts, a function
     * builds the answer from the request's init, an Error rejects, and anything
     * else resolves. Returns the requests as they go out, each one's abort
     * instant filled in when its signal fires.
     */
    function respond(...answers: unknown[]): Sent[] {
      const sent: Sent[] = [];
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        const request: Sent = { path: new URL(String(url)).pathname, startedAt: Date.now() };
        sent.push(request);
        init?.signal?.addEventListener(
          'abort',
          () => {
            request.abortedAt = Date.now();
          },
          { once: true },
        );
        const answer = answers[Math.min(sent.length, answers.length) - 1];
        if (answer === 'hang') {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        if (typeof answer === 'function') return (answer as (i?: RequestInit) => unknown)(init);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      });
      return sent;
    }

    /** An answer that arrives `ms` after the request starts, on the fake clock. */
    const answerAfter = (ms: number, response: unknown) => () =>
      new Promise((resolve) => setTimeout(() => resolve(response), ms));

    /**
     * `call`'s rejection, and how far the fake clock had moved when it settled —
     * read on the call itself, since advanceUntilSettled can fire a later timer
     * before it sees a settle that takes many microtask turns.
     */
    async function failure(call: Promise<unknown>): Promise<{ at: number; err: McpError }> {
      const t0 = Date.now();
      let at = Number.NaN;
      const timed = call.finally(() => {
        at = Date.now() - t0;
      });
      const err = await advanceUntilSettled(timed).then(
        () => {
          throw new Error('expected a rejection');
        },
        (e: unknown) => e as McpError,
      );
      return { err, at };
    }

    const deadline = { reason: 'retry_deadline_exceeded', deadlineMs: BUDGET_MS };

    describe('a hung upstream', () => {
      it('fails retry_deadline_exceeded at 50 s, naming the budget, with no timer left armed', async () => {
        const budgeted = new ClinicalTrialsService(slowAttempts, fastOptions);
        const sent = respond('hang');

        const { err, at } = await failure(budgeted.searchStudies({}, createMockContext()));

        expect(at).toBe(BUDGET_MS);
        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.data).toEqual({ ...deadline, path: '/studies' });
        expect(err.message).toContain(`${BUDGET_MS} ms`);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.abortedAt! - sent[0]!.startedAt).toBe(BUDGET_MS);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('fails at 50 s after two attempts at the default per-attempt timeout and backoff', async () => {
        const defaults = new ClinicalTrialsService({ ...testConfig, requestTimeoutMs: 30_000 });
        const sent = respond('hang');
        // Centres the ±25% jitter, so the one backoff is its 1 s base exactly.
        const jitter = vi.spyOn(Math, 'random').mockReturnValue(0.5);
        let outcome: Awaited<ReturnType<typeof failure>>;
        try {
          outcome = await failure(defaults.getStudy('NCT12345678', createMockContext()));
        } finally {
          jitter.mockRestore();
        }

        const origin = sent[0]!.startedAt;
        expect(outcome.at).toBe(BUDGET_MS);
        expect(outcome.err.data).toMatchObject(deadline);
        expect(sent.map((r) => [r.startedAt - origin, r.abortedAt! - origin])).toEqual([
          [0, 30_000],
          [31_000, BUDGET_MS],
        ]);
      });

      it('ends each attempt at CT_REQUEST_TIMEOUT_MS and retries inside the same budget', async () => {
        const shortAttempts = new ClinicalTrialsService(
          { ...testConfig, requestTimeoutMs: 2000 },
          { ...fastOptions, maxRetries: 100 },
        );
        const sent = respond('hang');

        const { err, at } = await failure(shortAttempts.searchStudies({}, createMockContext()));

        expect(at).toBe(BUDGET_MS);
        expect(err.data).toMatchObject(deadline);
        // 2 s per attempt plus a backoff of at most 62.5 ms: at least 24 attempts.
        expect(sent.length).toBeGreaterThanOrEqual(24);
        for (const request of sent.slice(0, -1)) {
          expect(request.abortedAt! - request.startedAt).toBe(2000);
        }
        const last = sent.at(-1)!;
        expect(last.abortedAt! - sent[0]!.startedAt).toBe(BUDGET_MS);
        expect(last.abortedAt! - last.startedAt).toBeLessThanOrEqual(2000);
      });

      it('exhausts four per-attempt timeouts as Timeout upstream_timeout naming the timeout', async () => {
        const shortAttempts = new ClinicalTrialsService(
          { ...testConfig, requestTimeoutMs: 2000 },
          fastOptions,
        );
        const sent = respond('hang');

        const { err } = await failure(shortAttempts.getStudy('NCT12345678', createMockContext()));

        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.message).toBe(
          'ClinicalTrials.gov sent no answer to /studies/NCT12345678 within 2000 ms on every attempt',
        );
        expect(err.data).toEqual({
          path: '/studies/NCT12345678',
          lastError: 'TimeoutError',
          timeoutMs: 2000,
          reason: 'upstream_timeout',
        });
        expect(sent.map((r) => r.abortedAt! - r.startedAt)).toEqual([2000, 2000, 2000, 2000]);
      });
    });

    describe('the last attempt that completed decides', () => {
      it('reports rate_limited when the budget runs out after a 429', async () => {
        const budgeted = new ClinicalTrialsService(slowAttempts, fastOptions);
        const sent = respond(jsonResponse(null, 429), 'hang');

        const { err, at } = await failure(budgeted.searchStudies({}, createMockContext()));

        expect(at).toBe(BUDGET_MS);
        expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(err.data).toEqual({
          path: '/studies',
          lastError: 'Error: HTTP 429',
          reason: 'rate_limited',
        });
        expect(err.message).toContain(`${BUDGET_MS} ms`);
        expect(sent).toHaveLength(2);
      });

      it('reports the deadline when a 503 completed after the 429', async () => {
        const budgeted = new ClinicalTrialsService(slowAttempts, fastOptions);
        const sent = respond(jsonResponse(null, 429), jsonResponse(null, 503), 'hang');

        const { err } = await failure(budgeted.searchStudies({}, createMockContext()));

        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.data).toMatchObject(deadline);
        expect(sent).toHaveLength(3);
      });

      it('reports the deadline when an attempt timed out after the 429', async () => {
        const shortAttempts = new ClinicalTrialsService(
          { ...testConfig, requestTimeoutMs: 2000 },
          { ...fastOptions, maxRetries: 100 },
        );
        respond(jsonResponse(null, 429), 'hang');

        const { err, at } = await failure(shortAttempts.searchStudies({}, createMockContext()));

        expect(at).toBe(BUDGET_MS);
        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.data).toMatchObject(deadline);
      });
    });

    describe('one budget per call', () => {
      it('sends nothing, and arms no timer, for a call with nothing left', async () => {
        const budgeted = new ClinicalTrialsService(slowAttempts, fastOptions);
        const sent = respond('hang');
        const ctx = createMockContext();
        await failure(budgeted.getStudy('NCT12345678', ctx));

        const err = await budgeted.countStudies({ queryCond: 'asthma' }, ctx).catch((e) => e);

        expect(err).toMatchObject({ code: JsonRpcErrorCode.Timeout, data: deadline });
        expect(sent).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('spans requests in sequence: the second gets what the first left', async () => {
        const budgeted = new ClinicalTrialsService(slowAttempts, fastOptions);
        respond(answerAfter(30_000, jsonResponse({ studies: [], totalCount: 3 })), 'hang');
        const ctx = createMockContext();

        await expect(
          advanceUntilSettled(budgeted.countStudies({ queryCond: 'a' }, ctx)),
        ).resolves.toBe(3);
        const { err, at } = await failure(budgeted.countStudies({ queryCond: 'b' }, ctx));

        expect(at).toBe(BUDGET_MS - 30_000);
        expect(err.data).toMatchObject(deadline);
      });

      it('gives a call of its own a budget of its own', async () => {
        const budgeted = new ClinicalTrialsService(slowAttempts, fastOptions);
        respond(answerAfter(30_000, jsonResponse({ studies: [], totalCount: 3 })), 'hang');

        await advanceUntilSettled(budgeted.countStudies({ queryCond: 'a' }, createMockContext()));
        const { at } = await failure(
          budgeted.countStudies({ queryCond: 'b' }, createMockContext()),
        );

        expect(at).toBe(BUDGET_MS);
      });

      it('charges the bounded field-index read to the call, whose own request gets the rest (#192)', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        const sent = respond('hang');

        const { err, at } = await failure(
          validating.searchStudies({ queryCond: 'x', fields: ['NCTId'] }, createMockContext()),
        );

        expect(at).toBe(BUDGET_MS);
        expect(err.data).toEqual({ ...deadline, path: '/studies' });
        const origin = sent[0]!.startedAt;
        expect(sent.map((r) => [r.path, r.startedAt - origin, r.abortedAt! - origin])).toEqual([
          ['/v2/studies/metadata', 0, 5000],
          ['/v2/studies', 5000, BUDGET_MS],
        ]);
      });

      it('starts no second-tier read for a call with nothing left, though the field index is loaded', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
          const { pathname, searchParams } = new URL(String(url));
          if (pathname === '/v2/studies/metadata') {
            return Promise.resolve(
              jsonResponse(
                searchParams.has('includeIndexedOnly') ? INDEXED_METADATA : RECORD_METADATA,
              ),
            );
          }
          if (pathname === '/v2/studies/search-areas') {
            return Promise.resolve(jsonResponse(SEARCH_AREAS));
          }
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
        });
        await advanceUntilSettled(
          validating.searchFieldDefinitions('status', 5, createMockContext()),
        );
        const spent = createMockContext();
        await failure(validating.countStudies({ queryCond: 'x' }, spent));

        // A sort the record tier misses would read the second tier, on reads of
        // their own budget — so only the spent call's own check can stop them.
        const { err } = await failure(
          validating.searchStudies({ sort: 'numlocations:desc' }, spent),
        );
        await vi.advanceTimersByTimeAsync(10_000);

        expect(err.data).toMatchObject(deadline);
        expect(
          mockFetch.mock.calls.map(([url]) => {
            const { pathname, searchParams } = new URL(String(url));
            return searchParams.has('includeIndexedOnly') ? `${pathname}?indexed` : pathname;
          }),
        ).toEqual(['/v2/studies/metadata', '/v2/studies']);
      });
    });

    describe('waits on a load another call started', () => {
      it('ends a field-index wait at the waiting call’s own deadline and leaves the read running', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        const sent = respond(
          answerAfter(47_000, jsonResponse({ studies: [], totalCount: 3 })),
          answerAfter(4500, jsonResponse(RECORD_METADATA)),
        );
        const waiter = createMockContext();
        const loader = createMockContext();

        // The waiter's budget starts with its count at 0 s; the loader starts the
        // field-index read at 46 s, which answers at 50.5 s; the waiter joins it
        // at 47 s with 3 s left.
        const counted = validating.countStudies({ queryCond: 'a' }, waiter);
        await vi.advanceTimersByTimeAsync(46_000);
        const loaded = validating.searchFieldDefinitions('status', 5, loader);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(counted).resolves.toBe(3);
        const waited = validating.searchFieldDefinitions('status', 5, waiter).catch((e) => e);
        await vi.advanceTimersByTimeAsync(3000);

        expect(await waited).toMatchObject({ code: JsonRpcErrorCode.Timeout, data: deadline });
        expect(sent[1]?.abortedAt).toBeUndefined();
        const found = await advanceUntilSettled(loaded);
        expect(found.entries.map((e) => e.piece)).toContain('OverallStatus');
        expect(sent).toHaveLength(2);
      });

      it('ends a second-tier wait at the call’s own deadline and leaves the read to its own timeout', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
          extendedReadTimeoutMs: 20_000,
        });
        mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
          const { pathname, searchParams } = new URL(String(url));
          if (pathname === '/v2/studies') {
            return answerAfter(48_000, jsonResponse({ studies: [], totalCount: 3 }))();
          }
          if (pathname === '/v2/studies/metadata' && !searchParams.has('includeIndexedOnly')) {
            return Promise.resolve(jsonResponse(RECORD_METADATA));
          }
          if (pathname === '/v2/studies/search-areas') {
            return Promise.resolve(jsonResponse(SEARCH_AREAS));
          }
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
        });
        const ctx = createMockContext();
        const origin = Date.now();

        await advanceUntilSettled(validating.countStudies({ queryCond: 'a' }, ctx));
        const area = await advanceUntilSettled(validating.getAreaIndex(ctx));
        const extended = await advanceUntilSettled(area!.extended!());

        // The wait ends with the call's budget, 50 s after its count started,
        // while the index-only read runs on toward its own 20 s timeout.
        expect(extended).toBeUndefined();
        expect(Date.now() - origin).toBe(BUDGET_MS);
        const indexed = mockFetch.mock.calls.findIndex(([url]) =>
          new URL(String(url)).searchParams.has('includeIndexedOnly'),
        );
        expect((mockFetch.mock.calls[indexed]![1] as RequestInit).signal?.aborted).toBe(false);
        expect(logCallsOf(ctx)).toContainEqual(
          expect.objectContaining({
            level: 'warning',
            msg: 'Index-only piece and search-area lookup skipped — read failed',
          }),
        );
      });

      it('answers a rejection whose suggestions outlast the budget with the rejection, not the deadline', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
          extendedReadTimeoutMs: 20_000,
        });
        mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
          const { pathname, searchParams } = new URL(String(url));
          if (pathname === '/v2/studies') {
            return answerAfter(
              48_000,
              textResponse(
                'Error parsing query in advanced filter: Unknown area name: `numlocation`',
              ),
            )();
          }
          if (pathname === '/v2/studies/metadata' && !searchParams.has('includeIndexedOnly')) {
            return Promise.resolve(jsonResponse(RECORD_METADATA));
          }
          if (pathname === '/v2/studies/search-areas') {
            return Promise.resolve(jsonResponse(SEARCH_AREAS));
          }
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
        });

        // The 400 lands at 48 s; its did-you-mean waits on an index-only read
        // that hangs past the call's budget, so the rejection is built at 50 s.
        const { err, at } = await failure(
          validating.countStudies({ filterAdvanced: 'AREA[numlocation]x' }, createMockContext()),
        );

        expect(at).toBe(BUDGET_MS);
        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: ['numlocation'] });
      });

      it('leaves the shared read running for the calls still waiting when the call that started it is cancelled (#192)', async () => {
        const validating = new ClinicalTrialsService(testConfig, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        const sent = respond(
          answerAfter(2000, jsonResponse(RECORD_METADATA)),
          jsonResponse({ studies: [], totalCount: 0 }),
        );
        const controller = new AbortController();

        const leaving = validating
          .searchStudies(
            { queryCond: 'a', fields: ['overallstatus'] },
            createMockContext({ signal: controller.signal }),
          )
          .catch((e) => e);
        const staying = validating.searchStudies(
          { queryCond: 'b', fields: ['overallstatus'] },
          createMockContext(),
        );
        await vi.advanceTimersByTimeAsync(100);
        controller.abort();

        expect(await leaving).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        await advanceUntilSettled(staying);
        // One read, never aborted, and the call still waiting folds its field from it.
        expect(sent.map((r) => r.path)).toEqual(['/v2/studies/metadata', '/v2/studies']);
        expect(sent[0]!.abortedAt).toBeUndefined();
        expect(new URL(String(mockFetch.mock.calls[1]![0])).searchParams.get('fields')).toBe(
          'OverallStatus',
        );
      });

      it('keeps the shared read to its own bound when the call that started it runs out of budget (#192)', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        const sent = respond(
          answerAfter(47_000, jsonResponse({ studies: [], totalCount: 3 })),
          answerAfter(4500, jsonResponse(RECORD_METADATA)),
          jsonResponse({ studies: [], totalCount: 0 }),
        );
        const loader = createMockContext();

        // The loader spends 47 s on a count, then starts the field-index read
        // with 3 s left; a fresh search joins it a second later.
        const counted = validating.countStudies({ queryCond: 'a' }, loader);
        await vi.advanceTimersByTimeAsync(47_000);
        await expect(counted).resolves.toBe(3);
        const loaderLookup = validating.searchFieldDefinitions('status', 5, loader).catch((e) => e);
        await vi.advanceTimersByTimeAsync(1000);
        const search = validating.searchStudies(
          { queryCond: 'x', fields: ['overallstatus'] },
          createMockContext(),
        );

        // The loader's wait ends with its budget at 50 s; the read answers at
        // 51.5 s, and the search that joined it folds its field from it.
        expect(await advanceUntilSettled(loaderLookup)).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: deadline,
        });
        await advanceUntilSettled(search);
        expect(sent.map((r) => r.path)).toEqual([
          '/v2/studies',
          '/v2/studies/metadata',
          '/v2/studies',
        ]);
        expect(sent[1]!.abortedAt).toBeUndefined();
        expect(new URL(String(mockFetch.mock.calls[2]![0])).searchParams.get('fields')).toBe(
          'OverallStatus',
        );
      });

      it('starts no second read for a waiter when the shared read hangs past the call that started it (#192)', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        const sent = respond(
          answerAfter(45_000, jsonResponse({ studies: [], totalCount: 3 })),
          'hang',
          jsonResponse({ studies: [], totalCount: 0 }),
        );
        const loader = createMockContext();

        const counted = validating.countStudies({ queryCond: 'a' }, loader);
        await vi.advanceTimersByTimeAsync(45_000);
        await counted;
        const loaderLookup = validating.searchFieldDefinitions('status', 5, loader).catch((e) => e);
        await vi.advanceTimersByTimeAsync(1000);
        const search = validating.searchStudies(
          { queryCond: 'x', fields: ['overallstatus'] },
          createMockContext(),
        );
        await advanceUntilSettled(loaderLookup);
        await advanceUntilSettled(search);

        // The read's 5 s bound ends it at 50 s, with the loader's budget. The
        // search, 46 s still left, sends its field as written rather than
        // reading the metadata again with the time it has.
        expect(sent.map((r) => r.path)).toEqual([
          '/v2/studies',
          '/v2/studies/metadata',
          '/v2/studies',
        ]);
        expect(sent[1]!.abortedAt! - sent[1]!.startedAt).toBe(5000);
        expect(new URL(String(mockFetch.mock.calls[2]![0])).searchParams.get('fields')).toBe(
          'overallstatus',
        );
      });
    });

    describe('a failed field-index load is remembered for the rest of the call', () => {
      /** Metadata answers 503; anything else answers a page or a stats list. */
      const metadataDown = () => {
        mockFetch.mockImplementation((url: string | URL) => {
          const { pathname } = new URL(String(url));
          if (pathname === '/v2/studies/metadata') return Promise.resolve(jsonResponse(null, 503));
          if (pathname === '/v2/stats/field/values') {
            return Promise.resolve(jsonResponse([{ piece: 'OverallStatus', topValues: [] }]));
          }
          return Promise.resolve(jsonResponse({ studies: [], totalCount: 0 }));
        });
      };
      const metadataRequests = () =>
        mockFetch.mock.calls.filter(
          ([url]) => new URL(String(url)).pathname === '/v2/studies/metadata',
        ).length;

      it.each([
        [
          'searchStudies with fields',
          (s: ClinicalTrialsService, ctx: ReturnType<typeof createMockContext>) =>
            s.searchStudies({ queryCond: 'x', fields: ['NCTId'] }, ctx),
        ],
        [
          'getFieldValues',
          (s: ClinicalTrialsService, ctx: ReturnType<typeof createMockContext>) =>
            s.getFieldValues(['OverallStatus'], ctx),
        ],
      ])(
        '%s: one load per call, failing open, and the next call loads afresh',
        async (_label, call) => {
          const validating = new ClinicalTrialsService(testConfig, {
            ...fastOptions,
            maxRetries: 0,
            validateFieldsLocally: true,
          });
          metadataDown();

          await advanceUntilSettled<unknown>(call(validating, createMockContext()));
          expect(metadataRequests()).toBe(1);
          await advanceUntilSettled<unknown>(call(validating, createMockContext()));
          expect(metadataRequests()).toBe(2);
        },
      );
    });

    describe('each way the field-index read fails, on the paths that read it', () => {
      const ENUM_BODY =
        'Error parsing query in advanced filter: Allowed values for enum field `protocolSection.designModule.phases` are `NA`, `PHASE1`, `PHASE2`';
      const failures: Array<[string, () => unknown]> = [
        ['404', () => jsonResponse(null, 404)],
        ['403', () => jsonResponse(null, 403)],
        ['429', () => jsonResponse(null, 429)],
        ['503', () => jsonResponse(null, 503)],
        ['504', () => jsonResponse(null, 504)],
        [
          'an HTML page',
          () => htmlResponse('<!DOCTYPE html><html><body>maintenance</body></html>'),
        ],
      ];

      /** `/studies/metadata` answers `metadata`; stats refuse a Mesh and /studies refuses an enum value. */
      function upstream(metadata: () => unknown) {
        mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
          const { pathname } = new URL(String(url));
          if (pathname === '/v2/studies/metadata') {
            const answer = metadata();
            if (answer === 'hang') {
              return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                  once: true,
                });
              });
            }
            return Promise.resolve(answer);
          }
          if (pathname === '/v2/stats/field/values') {
            return Promise.resolve(textResponse('Unsupported field type: Mesh'));
          }
          return Promise.resolve(textResponse(ENUM_BODY));
        });
      }
      const requestsTo = (path: string) =>
        mockFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === path).length;
      const subject = () =>
        new ClinicalTrialsService(slowAttempts, { ...fastOptions, validateFieldsLocally: true });

      it.each(failures)(
        'metadata %s: a group of fields is still refused field_invalid, from the upstream 400',
        async (_label, metadata) => {
          upstream(metadata);
          const { err } = await failure(
            subject().getFieldValues(['ConditionMesh'], createMockContext()),
          );

          expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['ConditionMesh'] });
          expect(requestsTo('/v2/stats/field/values')).toBe(1);
          // One attempt, whatever the failure: the read is optional here (#192).
          expect(requestsTo('/v2/studies/metadata')).toBe(1);
        },
      );

      it.each(failures)(
        'metadata %s on the error path: an AREA[] enum value is still enum_invalid, in path wording',
        async (_label, metadata) => {
          upstream(metadata);
          const { err } = await failure(
            subject().countStudies({ filterAdvanced: 'AREA[Phase]PHASE9' }, createMockContext()),
          );

          expect(err.data).toMatchObject({
            reason: 'enum_invalid',
            validValues: ['NA', 'PHASE1', 'PHASE2'],
          });
          expect(err.message).toContain('enum field `protocolSection.designModule.phases`');
          expect(requestsTo('/v2/studies/metadata')).toBe(1);
        },
      );

      it('a hung metadata read holds value statistics its 5 s bound, then the upstream 400 refuses the group (#192)', async () => {
        upstream(() => 'hang');
        const { err, at } = await failure(
          subject().getFieldValues(['ConditionMesh'], createMockContext()),
        );

        expect(at).toBe(5000);
        expect(err.data).toEqual({ reason: 'field_invalid', invalid: ['ConditionMesh'] });
        expect(requestsTo('/v2/stats/field/values')).toBe(1);
      });

      it('a hung metadata read on the error path delays the enum refusal by its 5 s bound and a gap, still enum_invalid (#192)', async () => {
        upstream(() => 'hang');
        // The count is refused at 0 s; the lookup for its path wording reads the
        // metadata a gap later, at 1 s, and gives up on it at 6 s.
        const { err, at } = await failure(
          subject().countStudies({ filterAdvanced: 'AREA[Phase]PHASE9' }, createMockContext()),
        );

        expect(at).toBe(6000);
        expect(err.data).toMatchObject({ reason: 'enum_invalid' });
        expect(err.message).toContain('enum field `protocolSection.designModule.phases`');
      });
    });

    describe('a field-index read that fails holds a call only its own bound (#192)', () => {
      type Ctx = ReturnType<typeof createMockContext>;
      /** `/studies/metadata` answers `metadata` — `'hang'` never answers; every other route answers a page. */
      function routes(metadata: unknown): Array<{ at: number; url: URL }> {
        const sent: Array<{ at: number; url: URL }> = [];
        mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
          const request = new URL(String(url));
          sent.push({ at: Date.now(), url: request });
          if (request.pathname !== '/v2/studies/metadata') {
            return Promise.resolve(jsonResponse({ studies: [], totalCount: 0 }));
          }
          if (metadata === 'hang') {
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            });
          }
          return Promise.resolve(metadata);
        });
        return sent;
      }
      const subject = () =>
        new ClinicalTrialsService(slowAttempts, { ...fastOptions, validateFieldsLocally: true });

      /** Each validating call, the parameter its own request carries, and the caller's text there. */
      const calls: Array<
        [string, (s: ClinicalTrialsService, ctx: Ctx) => Promise<unknown>, string, string]
      > = [
        [
          'a search with fields',
          (s, ctx) => s.searchStudies({ queryTerm: 'x', fields: ['overallstatus'] }, ctx),
          'fields',
          'overallstatus',
        ],
        [
          'a search with a mis-cased sort',
          (s, ctx) => s.searchStudies({ sort: 'lastupdatepostdate:desc' }, ctx),
          'sort',
          'lastupdatepostdate:desc',
        ],
        [
          'a count whose AREA[] name misses by case',
          async (s, ctx) => {
            // As clinicaltrials_get_study_count runs it: the name lookup first.
            const { advancedFilter } = await normalizeAreaNames(
              { advancedFilter: 'AREA[overallstatus]RECRUITING' },
              () => s.getAreaIndex(ctx),
              ctx.log,
            );
            return s.countStudies({ filterAdvanced: advancedFilter }, ctx);
          },
          'filter.advanced',
          'AREA[overallstatus]RECRUITING',
        ],
      ];

      it.each(calls)(
        'hung: %s waits the read’s 5 s bound, then sends the caller’s text unchanged',
        async (_label, run, param, text) => {
          const sent = routes('hang');
          const origin = Date.now();

          await advanceUntilSettled(run(subject(), createMockContext()));

          expect(sent.map(({ at, url }) => [url.pathname, at - origin])).toEqual([
            ['/v2/studies/metadata', 0],
            ['/v2/studies', 5000],
          ]);
          expect(sent[1]!.url.searchParams.get(param)).toContain(text);
        },
      );

      it.each(calls)(
        '503: %s sends one metadata request, not four, then the caller’s text unchanged',
        async (_label, run, param, text) => {
          const sent = routes(jsonResponse(null, 503));

          await advanceUntilSettled(run(subject(), createMockContext()));

          expect(sent.map(({ url }) => url.pathname)).toEqual([
            '/v2/studies/metadata',
            '/v2/studies',
          ]);
          expect(sent[1]!.url.searchParams.get(param)).toContain(text);
        },
      );

      it('reads a healthy metadata once for a call that validates, folds, and looks names up', async () => {
        const sent = routes(jsonResponse(RECORD_METADATA));
        const validating = subject();
        const ctx = createMockContext();

        await advanceUntilSettled(
          validating.searchStudies(
            { queryTerm: 'x', fields: ['overallstatus'], sort: 'lastupdatepostdate:desc' },
            ctx,
          ),
        );
        await advanceUntilSettled(validating.getAreaIndex(ctx));

        expect(sent.map(({ url }) => url.pathname)).toEqual([
          '/v2/studies/metadata',
          '/v2/studies',
        ]);
        expect(sent[1]!.url.searchParams.get('fields')).toBe('OverallStatus');
        expect(sent[1]!.url.searchParams.get('sort')).toBe('LastUpdatePostDate:desc');
      });
    });

    describe('a field search reads the index again on the full ladder (#192)', () => {
      it('hung: the bounded read, then two ladder attempts, ending retry_deadline_exceeded at 50 s', async () => {
        const defaults = new ClinicalTrialsService(
          { ...testConfig, requestTimeoutMs: 30_000 },
          { ...fastOptions, validateFieldsLocally: true },
        );
        const sent = respond('hang');

        const { err, at } = await failure(
          defaults.searchFieldDefinitions('status', 5, createMockContext()),
        );

        expect(at).toBe(BUDGET_MS);
        expect(err.data).toEqual({ ...deadline, path: '/studies/metadata' });
        const origin = sent[0]!.startedAt;
        expect(sent).toHaveLength(3);
        expect(sent.slice(0, 2).map((r) => [r.startedAt - origin, r.abortedAt! - origin])).toEqual([
          [0, 5000],
          [5000, 35_000],
        ]);
        expect(sent[2]!.abortedAt! - origin).toBe(BUDGET_MS);
      });

      it('503 three times, then the index: the field search answers from its own ladder', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        const sent = respond(
          jsonResponse(null, 503),
          jsonResponse(null, 503),
          jsonResponse(null, 503),
          jsonResponse(RECORD_METADATA),
        );

        const found = await advanceUntilSettled(
          validating.searchFieldDefinitions('status', 5, createMockContext()),
        );

        expect(found.entries.map((e) => e.piece)).toContain('OverallStatus');
        expect(sent).toHaveLength(4);
      });

      it('falls back on its own when the read it joined fails, never surfacing that read’s 503, and keeps what it built', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        let metadataAnswers = 0;
        mockFetch.mockImplementation((url: string | URL) => {
          if (new URL(String(url)).pathname !== '/v2/studies/metadata') {
            return Promise.resolve(jsonResponse({ studies: [], totalCount: 0 }));
          }
          metadataAnswers += 1;
          return Promise.resolve(
            metadataAnswers <= 2 ? jsonResponse(null, 503) : jsonResponse(RECORD_METADATA),
          );
        });
        const searched = () =>
          mockFetch.mock.calls
            .map(([url]) => new URL(String(url)))
            .filter((u) => u.pathname === '/v2/studies')
            .map((u) => u.searchParams.get('fields'));

        // The validating search starts the read; the field search joins it.
        const search = validating.searchStudies(
          { queryCond: 'x', fields: ['overallstatus'] },
          createMockContext(),
        );
        const lookup = validating.searchFieldDefinitions('status', 5, createMockContext());
        const [, found] = await advanceUntilSettled(Promise.all([search, lookup]));

        // The read's 503 sends the search out unchecked; the field search reads
        // the index again on its own ladder (503, then the index) and answers.
        expect(searched()).toEqual(['overallstatus']);
        expect(found.entries.map((e) => e.piece)).toContain('OverallStatus');
        expect(metadataAnswers).toBe(3);

        // Kept: a later validating call folds its field and reads nothing.
        await advanceUntilSettled(
          validating.searchStudies(
            { queryCond: 'y', fields: ['overallstatus'] },
            createMockContext(),
          ),
        );
        expect(metadataAnswers).toBe(3);
        expect(searched()).toEqual(['overallstatus', 'OverallStatus']);
      });

      it('keeps what it built when a load another call started meanwhile fails after it', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        // In request order: the field search's bounded read, its ladder read, and
        // the load a search starts while that ladder waits for its slot.
        const metadata = [
          jsonResponse(null, 503),
          jsonResponse(RECORD_METADATA),
          jsonResponse(null, 503),
        ];
        let metadataAnswers = 0;
        mockFetch.mockImplementation((url: string | URL) => {
          if (new URL(String(url)).pathname !== '/v2/studies/metadata') {
            return Promise.resolve(jsonResponse({ studies: [], totalCount: 0 }));
          }
          metadataAnswers += 1;
          return Promise.resolve(metadata[metadataAnswers - 1] ?? jsonResponse(RECORD_METADATA));
        });
        const searched = () =>
          mockFetch.mock.calls
            .map(([url]) => new URL(String(url)))
            .filter((u) => u.pathname === '/v2/studies')
            .map((u) => u.searchParams.get('fields'));

        const lookup = validating.searchFieldDefinitions('status', 5, createMockContext());
        await vi.advanceTimersByTimeAsync(0);
        expect(metadataAnswers).toBe(1);
        const search = validating.searchStudies(
          { queryCond: 'x', fields: ['overallstatus'] },
          createMockContext(),
        );
        const [found] = await advanceUntilSettled(Promise.all([lookup, search]));

        expect(found.entries.map((e) => e.piece)).toContain('OverallStatus');
        expect(metadataAnswers).toBe(3);
        expect(searched()).toEqual(['overallstatus']);

        // That load's later failure leaves the built index: the next call folds and reads nothing.
        await advanceUntilSettled(
          validating.searchStudies(
            { queryCond: 'y', fields: ['overallstatus'] },
            createMockContext(),
          ),
        );
        expect(metadataAnswers).toBe(3);
        expect(searched()).toEqual(['overallstatus', 'OverallStatus']);
      });

      it('ends as RequestCancelled when its caller cancels during the ladder', async () => {
        const validating = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          validateFieldsLocally: true,
        });
        respond(jsonResponse(null, 503), 'hang');
        const controller = new AbortController();

        const lookup = validating
          .searchFieldDefinitions('status', 5, createMockContext({ signal: controller.signal }))
          .catch((e) => e);
        await vi.advanceTimersByTimeAsync(2000);
        controller.abort();

        expect(await lookup).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      });
    });

    describe('a metadata body with no fields is a failed read, never kept (#196)', () => {
      it.each([
        ['an empty list', []],
        ['a tree with no field pieces', [{ name: 'protocolSection', children: [] }]],
      ])(
        '%s: the call fails open, and the next call validates against a healthy upstream',
        async (_label, tree) => {
          const validating = new ClinicalTrialsService(slowAttempts, {
            ...fastOptions,
            validateFieldsLocally: true,
          });
          let healthy = false;
          mockFetch.mockImplementation((url: string | URL) =>
            Promise.resolve(
              new URL(String(url)).pathname === '/v2/studies/metadata'
                ? jsonResponse(healthy ? RECORD_METADATA : tree)
                : jsonResponse({ studies: [], totalCount: 0 }),
            ),
          );

          await advanceUntilSettled(
            validating.searchStudies({ queryCond: 'x', fields: ['Bogus'] }, createMockContext()),
          );
          expect(new URL(String(mockFetch.mock.calls.at(-1)![0])).searchParams.get('fields')).toBe(
            'Bogus',
          );

          healthy = true;
          const { err } = await failure(
            validating.searchStudies({ queryCond: 'x', fields: ['Bogus'] }, createMockContext()),
          );
          expect(err.data).toMatchObject({ reason: 'field_invalid', invalid: ['Bogus'] });
        },
      );
    });

    describe('cancellation', () => {
      it('ends a backoff at once, as RequestCancelled', async () => {
        const backingOff = new ClinicalTrialsService(slowAttempts, {
          ...fastOptions,
          baseBackoffMs: 5000,
          maxBackoffMs: 5000,
        });
        respond(jsonResponse(null, 503));
        const controller = new AbortController();
        const t0 = Date.now();

        const call = backingOff
          .searchStudies({}, createMockContext({ signal: controller.signal }))
          .catch((e) => e);
        await vi.advanceTimersByTimeAsync(500);
        controller.abort();

        expect(await call).toMatchObject({
          code: JsonRpcErrorCode.RequestCancelled,
          message: 'Request cancelled by caller',
        });
        expect(Date.now() - t0).toBe(500);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('ends a pacer wait at once, and the request that left spends no gap', async () => {
        const starts = answerInTurn(jsonResponse({ studies: [] }));
        const controller = new AbortController();

        const first = service.searchStudies({ queryCond: 'a' }, createMockContext());
        const leaving = service
          .searchStudies({ queryCond: 'b' }, createMockContext({ signal: controller.signal }))
          .catch((e) => e);
        await vi.advanceTimersByTimeAsync(200);
        controller.abort();

        expect(await leaving).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        const next = service.searchStudies({ queryCond: 'c' }, createMockContext());
        await advanceUntilSettled(Promise.all([first, next]));
        expect(gaps(starts)).toEqual([1000]);
        expect(
          mockFetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('query.cond')),
        ).toEqual(['a', 'c']);
      });

      it('surfaces a cancellation mid-attempt as RequestCancelled, never as the deadline', async () => {
        const budgeted = new ClinicalTrialsService(slowAttempts, fastOptions);
        respond('hang');
        const controller = new AbortController();

        const call = budgeted
          .getStudy('NCT12345678', createMockContext({ signal: controller.signal }))
          .catch((e) => e);
        await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
        controller.abort();

        expect(await call).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });
});

/**
 * A connection failure as Bun's fetch rejects with it: a TypeError carrying the
 * transport code itself. Measured against a loopback socket on Bun 1.4.4.
 */
function bunFetchError(code: string): Error {
  return Object.assign(new TypeError(`${code}: The socket connection was closed unexpectedly.`), {
    code,
  });
}

/**
 * The same failure as Node's fetch rejects with it: `TypeError: fetch failed`,
 * the transport code only on its cause. Measured against a loopback socket on
 * Node 26.
 */
function nodeFetchError(code: string): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`read ${code}`), { code }),
  });
}

/** The log records a mock context captured. */
function logCallsOf(ctx: ReturnType<typeof createMockContext>) {
  return (ctx.log as unknown as { calls: Array<{ level: string; msg: string; data?: unknown }> })
    .calls;
}
