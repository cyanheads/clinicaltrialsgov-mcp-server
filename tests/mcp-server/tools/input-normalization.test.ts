/**
 * @fileoverview End-to-end input normalization for statusFilter and NCT IDs.
 * Each case runs a definition through its public contract boundary (input
 * parse → handler → output parse → format / error envelope) against the real
 * `ClinicalTrialsService` with `fetch` stubbed, and asserts the request URL the
 * service actually builds — the seam that includes the handler normalization,
 * the schema canonicalization, and the service's query construction and
 * enum_invalid translation together.
 * @module tests/mcp-server/tools/input-normalization
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';

const { mockGetService } = vi.hoisted(() => ({ mockGetService: vi.fn() }));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getClinicalTrialsService: mockGetService,
}));

import { studyResource } from '@/mcp-server/resources/definitions/study.resource.js';
import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';
import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import { ClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const config: ServerConfig = {
  apiBaseUrl: 'https://test.api/v2',
  requestTimeoutMs: 5000,
  maxPageSize: 200,
};

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Headers({ 'content-type': 'application/json' }),
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

/** Verbatim shape of the upstream answer to an unrecognized overallStatus value. */
const enumRejection = (value: string) => ({
  ok: false,
  status: 400,
  statusText: 'HTTP 400',
  headers: new Headers({ 'content-type': 'text/plain' }),
  json: () => Promise.reject(new Error('Not JSON')),
  text: () => Promise.resolve(`Invalid value in parameter \`overallStatus\`: \`${value}\``),
});

const study = (nctId: string) => ({
  protocolSection: { identificationModule: { nctId, briefTitle: `Study ${nctId}` } },
  hasResults: false,
});

/** Every URL the service fetched, in order. */
const fetchedUrls = () => mockFetch.mock.calls.map((c) => new URL(String(c[0])));

const text = (result: { content: unknown }) =>
  (result.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join('\n');

beforeEach(() => {
  mockFetch.mockReset();
  // A fresh instance per test keeps the 1 req/sec throttle from ever waiting:
  // each test issues its first request against a zeroed clock.
  mockGetService.mockReturnValue(
    new ClinicalTrialsService(config, { maxRetries: 0, validateFieldsLocally: false }),
  );
});

describe('statusFilter reaches upstream canonicalized', () => {
  it('search_studies sends a spaced lowercase status as the canonical enum', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
    const result = await runToolContract(searchStudies, { statusFilter: 'active not recruiting' });

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()[0]?.searchParams.get('filter.overallStatus')).toBe(
      'ACTIVE_NOT_RECRUITING',
    );
  });

  it('get_study_count sends every entry of a mixed-case list canonicalized and pipe-joined', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 64958 }));
    const result = await runToolContract(getStudyCount, {
      statusFilter: ['recruiting', 'Not-Yet-Recruiting'],
    });

    expect(result.structuredContent).toMatchObject({ totalCount: 64958 });
    expect(fetchedUrls()[0]?.searchParams.get('filter.overallStatus')).toBe(
      'RECRUITING|NOT_YET_RECRUITING',
    );
  });

  it('search_studies sends a spaced comma-joined list as one upstream-splittable value', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
    const result = await runToolContract(searchStudies, { statusFilter: 'recruiting, completed' });

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()[0]?.searchParams.get('filter.overallStatus')).toBe('RECRUITING,COMPLETED');
  });

  it.each([
    ['search_studies', searchStudies],
    ['get_study_count', getStudyCount],
  ] as const)(
    '%s keeps the enum_invalid contract and recovery hint for a value with no canonical match',
    async (_name, def) => {
      mockFetch.mockResolvedValue(enumRejection('PENDING_REVIEW'));
      const result = await runToolContract(
        def as typeof searchStudies,
        { statusFilter: 'pending review' },
        { context: { errors: def.errors } },
      );

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;
      expect(error.data.reason).toBe('enum_invalid');
      expect(error.data.param).toBe('statusFilter');
      expect(error.data.value).toBe('PENDING_REVIEW');
      expect(text(result)).toContain(
        'Recovery: Call clinicaltrials_get_field_values with fields=["OverallStatus"] to see valid values.',
      );
      expect(fetchedUrls()).toHaveLength(1);
      expect(fetchedUrls()[0]?.searchParams.get('filter.overallStatus')).toBe('PENDING_REVIEW');
    },
  );
});

describe('NCT IDs reach upstream canonicalized on every surface', () => {
  it('search_studies nctIds', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [study('NCT03722472')], totalCount: 1 }));
    const result = await runToolContract(searchStudies, {
      nctIds: ['nct03722472', ' Nct06323538'],
    });

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()[0]?.searchParams.get('filter.ids')).toBe('NCT03722472|NCT06323538');
  });

  it('get_study_record nctId', async () => {
    mockFetch.mockResolvedValue(jsonResponse(study('NCT03722472')));
    const result = await runToolContract(getStudy, { nctId: 'nct03722472' });

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()[0]?.pathname).toBe('/v2/studies/NCT03722472');
    expect(text(result)).toContain('NCT03722472');
  });

  it('get_study_results collapses a mixed-case duplicate pair into one batched lookup', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [study('NCT03722472')], totalCount: 1 }));
    const result = await runToolContract(getStudyResults, {
      nctIds: ['NCT03722472', 'nct03722472'],
    });

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()).toHaveLength(1);
    expect(fetchedUrls()[0]?.searchParams.get('filter.ids')).toBe('NCT03722472');
    const results = (result.structuredContent as { results: Array<{ nctId: string }> }).results;
    expect(results.map((r) => r.nctId)).toEqual(['NCT03722472']);
    expect(result.structuredContent).not.toHaveProperty('fetchErrors');
  });

  it('clinicaltrials://{nctId} resource params', async () => {
    mockFetch.mockResolvedValue(jsonResponse(study('NCT03722472')));
    const params = studyResource.params!.parse({ nctId: 'nct03722472' });
    const read = (await studyResource.handler(
      params,
      createMockContext({ errors: studyResource.errors }),
    )) as { nctId: string };

    expect(fetchedUrls()[0]?.pathname).toBe('/v2/studies/NCT03722472');
    expect(read.nctId).toBe('NCT03722472');
  });

  it('a malformed ID never reaches upstream', async () => {
    const result = await runToolContract(getStudy, { nctId: 'ABC123' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('NCT IDs must match format NCTxxxxxxxx (8 digits).');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
