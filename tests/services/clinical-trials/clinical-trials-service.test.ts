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
      // Body that names no parameter — exercises the presence-based fallback.
      mockFetch.mockResolvedValue(textResponse('filter.ids has incorrect format for value XYZ'));

      const ctx = createMockContext();
      await expect(service.searchStudies({ filterIds: ['XYZ'] }, ctx)).rejects.toThrow(
        /not found or rejected by API: XYZ/,
      );
    });

    it('wraps bad AREA[] field name with field_invalid reason + recovery hint', async () => {
      mockFetch.mockResolvedValue(
        textResponse('Error parsing query in advanced filter: Unknown area name: `NotARealField`'),
      );
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
        await service.searchStudies({ filterAdvanced: 'AREA[NotARealField]value' }, ctx);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        const msg = (err as McpError).message;
        expect(msg).toContain("'NotARealField'");
        expect(msg).toContain('clinicaltrials_get_field_definitions');
        const data = (err as McpError).data as Record<string, unknown>;
        expect(data?.reason).toBe('field_invalid');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toContain(
          'clinicaltrials_get_field_definitions',
        );
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

    it('wraps Essie free-text parser error with query_parse_error reason + recovery hint', async () => {
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
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toContain('reserved');
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

    it('translates Essie enum error for phaseFilter to param-named message with valid values (#71)', async () => {
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
        expect(msg).toContain('phaseFilter');
        expect(msg).toContain('EARLY_PHASE1');
        expect(msg).toContain('PHASE4');
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('enum_invalid');
        expect(data?.param).toBe('phaseFilter');
        expect(Array.isArray(data?.validValues)).toBe(true);
        expect(data?.validValues).toContain('NA');
      }
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
        // sort was the one validation error arriving with no Recovery: line (#93).
        const data = (err as McpError).data as Record<string, unknown> | undefined;
        expect(data?.reason).toBe('sort_invalid');
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toContain('FieldName:asc');
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
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toContain('FieldName:asc');
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
        expect((data?.recovery as { hint?: string } | undefined)?.hint).toContain('distance(');
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
      await validatingService.searchStudies({ sort: 'Bogus:desc' }, ctx);
      const second = mockFetch.mock.calls
        .map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()))
        .find((u) => !u.includes('/studies/metadata'));
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

    // Metadata fixture carrying both an array-typed piece (Phase → Phase[]) and a
    // scalar piece (OverallStatus → Status) for the multi-valued flag (#85).
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
