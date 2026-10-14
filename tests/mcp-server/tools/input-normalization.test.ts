/**
 * @fileoverview End-to-end input normalization for statusFilter, phaseFilter,
 * fields, and NCT IDs.
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
import { getFieldValues } from '@/mcp-server/tools/definitions/get-field-values.tool.js';
import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';
import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import { ClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';

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

describe('phaseFilter reaches upstream as canonical AREA[Phase] values (#144)', () => {
  it('get_study_count sends a spaced lowercase phase as the canonical value', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 99 }));
    const result = await runToolContract(getStudyCount, {
      conditionQuery: 'ALS',
      phaseFilter: 'phase 3',
      includeUnknownEnrollment: true,
    });

    expect(result.structuredContent).toMatchObject({ totalCount: 99 });
    expect(fetchedUrls()[0]?.searchParams.get('filter.advanced')).toBe('AREA[Phase]PHASE3');
  });

  it('search_studies sends a pipe-joined scalar as the grouped OR a list sends', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
    const result = await runToolContract(searchStudies, {
      phaseFilter: 'PHASE2|Not Applicable',
      advancedFilter: 'AREA[StudyType]INTERVENTIONAL',
      includeUnknownEnrollment: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()[0]?.searchParams.get('filter.advanced')).toBe(
      '(AREA[Phase]PHASE2 OR AREA[Phase]NA) AND (AREA[StudyType]INTERVENTIONAL)',
    );
    expect(text(result)).toContain('- **phaseFilter:** [PHASE2, NA]');
  });

  it.each([
    ['search_studies', searchStudies],
    ['get_study_count', getStudyCount],
  ] as const)(
    '%s refuses an expression in phaseFilter with enum_invalid and sends nothing',
    async (_name, def) => {
      const result = await runToolContract(
        def as typeof searchStudies,
        { conditionQuery: 'ALS', phaseFilter: 'PHASE3 OR AREA[StudyType]OBSERVATIONAL' },
        { context: { errors: def.errors } },
      );

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;
      expect(error.data).toMatchObject({
        reason: 'enum_invalid',
        param: 'phaseFilter',
        value: 'PHASE3 OR AREA[StudyType]OBSERVATIONAL',
        validValues: ['NA', 'EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4'],
      });
      expect(text(result)).toContain('Put every other criterion');
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it('an invalid AREA[Phase] value in advancedFilter names the expression, not phaseFilter', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'HTTP 400',
      headers: new Headers({ 'content-type': 'text/plain' }),
      json: () => Promise.reject(new Error('Not JSON')),
      text: () =>
        Promise.resolve(
          'Error parsing query in advanced filter: Allowed values for enum field `protocolSection.designModule.phases` are `NA`, `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`',
        ),
    });
    const result = await runToolContract(
      getStudyCount,
      { advancedFilter: 'AREA[Phase]PHASE5' },
      { context: { errors: getStudyCount.errors } },
    );

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { data: Record<string, unknown> } }).error;
    expect(error.data.reason).toBe('enum_invalid');
    expect(error.data).not.toHaveProperty('param');
    expect(text(result)).toContain('Invalid value in an `AREA[Phase]` expression.');
    expect(text(result)).not.toContain('phaseFilter');
  });
});

/**
 * `fields` entries split on `,`/`|` reach the real service, where the case and
 * legacy-alias auto-correction and the did-you-mean validation run per piece
 * against a stubbed /studies/metadata tree (#152).
 */
describe('comma- or pipe-joined fields reach upstream as separate names (#152)', () => {
  const metadata: FieldNode[] = [
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
          name: 'statusModule',
          children: [{ name: 'overallStatus', piece: 'OverallStatus', type: 'ENUM' }],
        },
        {
          name: 'designModule',
          children: [
            { name: 'studyType', piece: 'StudyType', type: 'ENUM' },
            { name: 'phases', piece: 'Phase', type: 'ENUM', isEnum: true },
          ],
        },
      ],
    },
  ];

  /** Route the metadata fetch to the stub tree and everything else to `primary`. */
  const route = (primary: unknown) =>
    mockFetch.mockImplementation((url: string | URL) =>
      Promise.resolve(
        String(url).includes('/studies/metadata') ? jsonResponse(metadata) : jsonResponse(primary),
      ),
    );
  const primaryUrls = () => fetchedUrls().filter((u) => !u.pathname.endsWith('/metadata'));

  beforeEach(() => {
    mockGetService.mockReturnValue(new ClinicalTrialsService(config, { maxRetries: 0 }));
  });

  it.each([
    [['NCTId,BriefTitle']],
    [['NCTId|BriefTitle']],
    [['NCTId, BriefTitle']],
    ['NCTId,BriefTitle'],
  ])('search_studies sends %j as NCTId|BriefTitle', async (fields) => {
    route({ studies: [study('NCT03722472')], totalCount: 1 });
    const result = await runToolContract(searchStudies, { query: 'baxdrostat', fields });

    expect(result.isError).toBeFalsy();
    expect(primaryUrls()[0]?.searchParams.get('fields')).toBe('NCTId|BriefTitle');
    expect(result.structuredContent).toMatchObject({ requestedFields: ['NCTId', 'BriefTitle'] });
  });

  // A repeated name only lengthens the URL: a 1,000-piece string earns an
  // unclassified HTTP 414 upstream.
  it('search_studies sends a name repeated 1,000 times once', async () => {
    route({ studies: [study('NCT03722472')], totalCount: 1 });
    const result = await runToolContract(searchStudies, {
      fields: ['NCTId,BriefTitle,'.repeat(1000)],
    });

    expect(result.isError).toBeFalsy();
    expect(primaryUrls()[0]?.searchParams.get('fields')).toBe('NCTId|BriefTitle');
    expect(result.structuredContent).toMatchObject({ requestedFields: ['NCTId', 'BriefTitle'] });
  });

  it('auto-corrects the case and legacy alias of each split piece', async () => {
    route({ studies: [study('NCT03722472')], totalCount: 1 });
    const result = await runToolContract(searchStudies, {
      fields: ['nctid, recruitment status|BRIEFTITLE'],
    });

    expect(result.isError).toBeFalsy();
    expect(primaryUrls()[0]?.searchParams.get('fields')).toBe('NCTId|OverallStatus|BriefTitle');
  });

  it('names only the misspelled piece of a joined entry', async () => {
    route({ studies: [] });
    const result = await runToolContract(
      searchStudies,
      { fields: ['NCTId,Bogus'] },
      { context: { errors: searchStudies.errors } },
    );

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { data: Record<string, unknown> } }).error;
    expect(error.data.reason).toBe('field_invalid');
    expect(error.data.invalid).toEqual(['Bogus']);
    expect(text(result)).toContain("Invalid field name: 'Bogus'.");
    expect(primaryUrls()).toHaveLength(0);
  });

  it.each([['Phase,StudyType'], [['Phase|StudyType']]])(
    'get_field_values requests stats for both fields of %j',
    async (fields) => {
      route([
        { field: 'protocolSection.designModule.phases', piece: 'Phase', type: 'ENUM' },
        { field: 'protocolSection.designModule.studyType', piece: 'StudyType', type: 'ENUM' },
      ]);
      const result = await runToolContract(getFieldValues, { fields });

      expect(result.isError).toBeFalsy();
      expect(primaryUrls()[0]?.searchParams.get('fields')).toBe('Phase|StudyType');
      expect(
        (result.structuredContent as { fieldStats: Array<{ piece: string }> }).fieldStats.map(
          (s) => s.piece,
        ),
      ).toEqual(['Phase', 'StudyType']);
    },
  );

  it.each([
    ['search_studies', searchStudies],
    ['get_field_values', getFieldValues],
  ] as const)('%s answers [","] with blank_value and sends nothing', async (_name, def) => {
    const result = await runToolContract(
      def as typeof searchStudies,
      { fields: [','] },
      { context: { errors: def.errors } },
    );

    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data: Record<string, unknown> } }).error.data,
    ).toMatchObject({ reason: 'blank_value', param: 'fields' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

/**
 * Every `nctIds` form get_study_results accepts, driven through the production
 * argument path — alias resolution, parse, and the representation repair that
 * decodes a JSON-stringified list — and read back from the batch request the
 * handler sends upstream (#154). `input.parse()` skips the alias stage, so the
 * `nctId` alias (#151) is only reachable here.
 */
describe('get_study_results nctIds forms reach upstream canonicalized (#154, #151)', () => {
  const forms = [
    ['a single ID', 'NCT03722472', 'NCT03722472'],
    ['a padded lowercase ID', ' nct03722472 ', 'NCT03722472'],
    ['a one-item list', ['NCT03722472'], 'NCT03722472'],
    ['a mixed-case padded list', ['nct03722472', ' Nct06323538'], 'NCT03722472|NCT06323538'],
    ['a JSON-stringified list', '["NCT03722472","nct06323538"]', 'NCT03722472|NCT06323538'],
  ] as const;

  it.each(
    (['nctIds', 'nctId'] as const).flatMap((key) =>
      forms.map(([label, value, sent]) => [key, label, value, sent] as const),
    ),
  )('%s: %s', async (key, _label, value, sent) => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [study('NCT03722472')], totalCount: 1 }));
    const result = await runToolContract(getStudyResults, {
      [key]: value,
    } as never);

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()).toHaveLength(1);
    expect(fetchedUrls()[0]?.searchParams.get('filter.ids')).toBe(sent);
  });

  it.each([
    ['equal', 'NCT03722472'],
    ['different', 'NCT06323538'],
  ])('rejects nctId sent beside nctIds with %s values', async (_label, nctIds) => {
    const result = await runToolContract(getStudyResults, {
      nctId: 'NCT03722472',
      nctIds,
    } as never);

    expect(result.isError).toBe(true);
    // -32602 Invalid params: a strict-input rejection, raised before the handler.
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(-32602);
    expect(text(result)).toContain('nctId is an alias of nctIds; send one of them, not both.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports a malformed ID under the alias as an nctIds format error', async () => {
    const result = await runToolContract(getStudyResults, {
      nctId: 'NCT123',
    } as never);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('nctIds: NCT IDs must match format NCTxxxxxxxx (8 digits).');
    expect(text(result)).not.toContain('Unrecognized key');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
