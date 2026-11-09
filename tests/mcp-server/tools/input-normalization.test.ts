/**
 * @fileoverview End-to-end input normalization for statusFilter, phaseFilter,
 * fields, NCT IDs, AREA[] field names, and parameter-name aliases.
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
import {
  AREA_METADATA,
  INDEXED_METADATA,
  RECORD_METADATA,
  SEARCH_AREAS,
} from '../../helpers/area-metadata.js';
import { readMarkdown } from '../../helpers/commonmark.js';
import { nctIds as ids } from '../../helpers/nct-ids.js';

const { mockGetService } = vi.hoisted(() => ({ mockGetService: vi.fn() }));

vi.mock('@/services/clinical-trials/clinical-trials-service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getClinicalTrialsService: mockGetService,
}));

import { studyResource } from '@/mcp-server/resources/definitions/study.resource.js';
import { findEligible } from '@/mcp-server/tools/definitions/find-eligible.tool.js';
import { getFieldValues } from '@/mcp-server/tools/definitions/get-field-values.tool.js';
import { getStudy } from '@/mcp-server/tools/definitions/get-study.tool.js';
import { getStudyCount } from '@/mcp-server/tools/definitions/get-study-count.tool.js';
import { getStudyResults } from '@/mcp-server/tools/definitions/get-study-results.tool.js';
import { searchStudies } from '@/mcp-server/tools/definitions/search-studies.tool.js';
import { RECOVERY_HINTS } from '@/mcp-server/tools/utils/recovery-hints.js';
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

/** content[] as a CommonMark reader sees it — error and hint text arrive Markdown-encoded. */
const seenText = (result: { content: unknown }) => readMarkdown(text(result));

/** Run with fake timers standing in for the pacer's one-second gaps between request starts. */
async function throttled<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.advanceTimersByTimeAsync(10_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  mockFetch.mockReset();
  // A fresh instance per test keeps its 1 req/sec pacer from ever waiting:
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
      expect(seenText(result)).toContain(
        'Recovery: Call clinicaltrials_get_field_values with fields=["OverallStatus"] to see valid values.',
      );
      // The argument to send next arrives as a code span, never as `fields=\["OverallStatus"\]`.
      expect(text(result)).toContain('with `fields=["OverallStatus"]` to see valid values.');
      expect(text(result)).not.toContain('fields=\\[');
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
    expect(seenText(result)).toContain('phaseFilter: [PHASE2, NA]');
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
      // The values and the list form to send back arrive as code spans, not escaped text.
      expect(text(result)).toContain('a list such as `["PHASE2","PHASE3"]` to match');
      expect(text(result)).toContain('one of `NA`, `EARLY_PHASE1`, `PHASE1`, `PHASE2`');
      expect(text(result)).not.toContain('\\["PHASE2"');
      expect(seenText(result)).toContain('a list such as ["PHASE2","PHASE3"] to match');
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  /** The Phase node of the live metadata tree (2026-11-09), where the enum rejection's path leads. */
  const PHASE_METADATA: FieldNode[] = [
    {
      name: 'protocolSection',
      piece: 'ProtocolSection',
      sourceType: 'STRUCT',
      type: 'ProtocolSection',
      children: [
        {
          name: 'designModule',
          piece: 'DesignModule',
          sourceType: 'STRUCT',
          type: 'DesignModule',
          children: [
            { name: 'phases', piece: 'Phase', sourceType: 'TEXT', type: 'Phase[]', isEnum: true },
          ],
        },
      ],
    },
  ];

  it.each([
    ['search_studies', searchStudies],
    ['get_study_count', getStudyCount],
  ] as const)(
    '%s names an invalid AREA[Phase] value by the expression, not phaseFilter, with the values as code spans',
    async (_name, def) => {
      mockGetService.mockReturnValue(new ClinicalTrialsService(config, { maxRetries: 0 }));
      mockFetch.mockImplementation((url: URL | string) =>
        Promise.resolve(
          new URL(String(url)).pathname === '/v2/studies/metadata'
            ? jsonResponse(PHASE_METADATA)
            : {
                ok: false,
                status: 400,
                statusText: 'HTTP 400',
                headers: new Headers({ 'content-type': 'text/plain' }),
                json: () => Promise.reject(new Error('Not JSON')),
                text: () =>
                  Promise.resolve(
                    'Error parsing query in advanced filter: Allowed values for enum field `protocolSection.designModule.phases` are `NA`, `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`',
                  ),
              },
        ),
      );
      const result = await throttled(() =>
        runToolContract(
          def as typeof searchStudies,
          { advancedFilter: 'AREA[Phase]PHASE5' },
          { context: { errors: def.errors } },
        ),
      );

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;
      expect(error.data.reason).toBe('enum_invalid');
      expect(error.data).not.toHaveProperty('param');
      expect(seenText(result)).toContain(
        'Invalid value in an AREA[Phase] expression. Valid values: NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4.',
      );
      expect(seenText(result)).not.toContain('phaseFilter');
      expect(text(result)).toContain(
        'Use one of the valid values inside `AREA[Phase]`: `NA`, `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`.',
      );
      expect(text(result)).not.toContain('AREA\\[');
    },
  );
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

  // A repeated name only lengthens the URL: a 1,000-piece string runs past the
  // request length upstream accepts and fails as request_too_long.
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

/**
 * The REST parameter each field is sent as (`query.cond`, and `query_cond` for
 * callers that avoid dots) and the generic names callers reach for
 * (`condition`, `limit`) are declared `inputAliases` (#190). Driven through
 * the production argument path, since `input.parse()` skips the alias stage,
 * and read back from the request the service builds: the upstream parameter
 * carrying the value is the proof it reached its target.
 */
describe('REST and generic parameter names reach their targets as inputAliases (#190)', () => {
  /** [alias, value sent, upstream parameter, value it carries upstream]. */
  type Row = readonly [string, unknown, string, string];
  const rest = (dotted: string, value: unknown, param: string, sent: string): Row[] => [
    [dotted, value, param, sent],
    [dotted.replace('.', '_'), value, param, sent],
  ];
  const COMMON: Row[] = [
    ...rest('query.term', 'covid', 'query.term', 'covid'),
    ...rest('query.cond', 'migraine', 'query.cond', 'migraine'),
    ['condition', 'migraine', 'query.cond', 'migraine'],
    ...rest('query.intr', 'erenumab', 'query.intr', 'erenumab'),
    ['intervention', 'erenumab', 'query.intr', 'erenumab'],
    ...rest('query.locn', 'Seattle', 'query.locn', 'Seattle'),
    ...rest('query.spons', 'Pfizer', 'query.spons', 'Pfizer'),
    ['sponsor', 'Pfizer', 'query.spons', 'Pfizer'],
    ...rest('query.titles', 'headache', 'query.titles', 'headache'),
    ...rest('query.outc', 'pain', 'query.outc', 'pain'),
    // Canonicalized on the way, as statusFilter and phaseFilter values are.
    ...rest(
      'filter.overallStatus',
      'recruiting|completed',
      'filter.overallStatus',
      'RECRUITING|COMPLETED',
    ),
    ...rest('filter.advanced', 'heart failure', 'filter.advanced', 'heart failure'),
    ['phase', 'Phase 3', 'filter.advanced', 'AREA[Phase]PHASE3'],
  ];
  const geo = 'distance(47.6062,-122.3321,50mi)';
  const SEARCH_ONLY: Row[] = [
    ...rest('filter.geo', geo, 'filter.geo', geo),
    ['limit', 5, 'pageSize', '5'],
    ['max_results', 5, 'pageSize', '5'],
  ];
  const patient = {
    age: 40,
    sex: 'ALL' as const,
    conditions: ['sickle cell'],
    location: { country: 'United States', state: 'Washington', city: 'Seattle' },
  };
  type ErrorWire = { error: { code: number } };

  it.each([
    ...[...COMMON, ...SEARCH_ONLY].map((row) => ['search_studies', ...row, searchStudies] as const),
    ...COMMON.map((row) => ['get_study_count', ...row, getStudyCount] as const),
  ])('%s: %s reaches upstream', async (_name, alias, value, param, sent, definition) => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [], totalCount: 0 }));
    // The sentinel exclusion stays off, so filter.advanced carries the value alone.
    const result = await runToolContract(
      definition as typeof searchStudies,
      {
        [alias]: value,
        includeUnknownEnrollment: true,
      } as never,
    );

    expect(result.isError).toBeFalsy();
    expect(fetchedUrls()).toHaveLength(1);
    expect(fetchedUrls()[0]?.searchParams.get(param)).toBe(sent);
  });

  it('answers the call in REST and generic names with the canonical call’s request and page', async () => {
    const page = {
      studies: [study('NCT04592952'), study('NCT06150781')],
      totalCount: 66,
      nextPageToken: 'tok_page2',
    };
    mockFetch.mockResolvedValue(jsonResponse(page));
    const aliased = await runToolContract(searchStudies, {
      condition: 'migraine',
      intervention: 'erenumab',
      limit: 2,
    } as never);
    // A fresh service, so the second request never waits on the first one's pacer.
    mockGetService.mockReturnValue(
      new ClinicalTrialsService(config, { maxRetries: 0, validateFieldsLocally: false }),
    );
    const canonical = await runToolContract(searchStudies, {
      conditionQuery: 'migraine',
      interventionQuery: 'erenumab',
      pageSize: 2,
    });

    expect(aliased.isError).toBeFalsy();
    const [sentAliased, sentCanonical] = fetchedUrls();
    expect(sentAliased?.searchParams.get('query.cond')).toBe('migraine');
    expect(sentAliased?.href).toBe(sentCanonical?.href);
    expect(aliased.structuredContent).toEqual(canonical.structuredContent);
    expect(aliased.content).toEqual(canonical.content);
  });

  it('find_eligible reads limit as maxResults beside locationLimit', async () => {
    const site = (facility: string) => ({
      facility,
      city: 'Seattle',
      state: 'Washington',
      country: 'United States',
      status: 'RECRUITING',
    });
    mockFetch.mockResolvedValue(
      jsonResponse({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: 'NCT03722472' },
              contactsLocationsModule: { locations: [site('A'), site('B'), site('C')] },
            },
          },
        ],
        totalCount: 1,
      }),
    );
    const result = await throttled(() =>
      runToolContract(findEligible, { ...patient, limit: 5, locationLimit: 2 } as never),
    );

    expect(result.isError).toBeFalsy();
    // The main search goes first; the default maxResults would send 10.
    expect(fetchedUrls()[0]?.searchParams.get('pageSize')).toBe('5');
    const [candidate] = (
      result.structuredContent as {
        studies: Array<{ protocolSection: { contactsLocationsModule: { locations: unknown[] } } }>;
      }
    ).studies;
    expect(candidate?.protocolSection.contactsLocationsModule.locations).toHaveLength(2);
  });

  it.each([
    [
      'search_studies',
      'limit beside pageSize',
      { limit: 2, pageSize: 3 },
      'limit is an alias of pageSize; send one of them, not both.',
      searchStudies,
    ],
    [
      'search_studies',
      'limit beside max_results',
      { limit: 2, max_results: 3 },
      'limit and max_results are aliases of pageSize; send one of them, not both.',
      searchStudies,
    ],
    [
      'get_study_count',
      'query.cond beside conditionQuery',
      { 'query.cond': 'migraine', conditionQuery: 'asthma' },
      'query.cond is an alias of conditionQuery; send one of them, not both.',
      getStudyCount,
    ],
    [
      'find_eligible',
      'limit beside maxResults',
      { ...patient, limit: 5, maxResults: 3 },
      'limit is an alias of maxResults; send one of them, not both.',
      findEligible,
    ],
  ] as const)('%s rejects %s before any request', async (_name, _label, args, hint, definition) => {
    const result = await runToolContract(definition as typeof searchStudies, args as never);

    expect(result.isError).toBe(true);
    // -32602 Invalid params: a strict-input rejection, raised before the handler.
    expect((result.structuredContent as ErrorWire).error.code).toBe(-32602);
    expect(seenText(result)).toContain(hint);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['get_study_count', 'limit, which has no page size there', 'limit', 2, getStudyCount],
    ['search_studies', 'a case variant of an alias', 'Query.Term', 'covid', searchStudies],
  ] as const)('%s keeps rejecting %s as an unknown key', async (_name, _label, key, value, def) => {
    const result = await runToolContract(
      def as typeof searchStudies,
      {
        conditionQuery: 'migraine',
        [key]: value,
      } as never,
    );

    expect(result.isError).toBe(true);
    expect((result.structuredContent as ErrorWire).error.code).toBe(-32602);
    expect(seenText(result)).toContain(`Unrecognized key: "${key}"`);
    expect(seenText(result)).not.toContain('is an alias of');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['search_studies', searchStudies],
    ['get_study_count', getStudyCount],
    ['find_eligible', findEligible],
  ] as const)('%s advertises only its declared keys, none of its aliases', (_name, definition) => {
    const advertised = (
      definition.input['~standard'] as unknown as {
        jsonSchema: {
          input(o: { target: 'draft-2020-12' }): {
            additionalProperties?: boolean;
            properties: Record<string, unknown>;
          };
        };
      }
    ).jsonSchema.input({ target: 'draft-2020-12' });
    const keys = Object.keys(advertised.properties);

    expect(keys).toEqual(Object.keys(definition.input.shape));
    expect(advertised.additionalProperties).toBe(false);
    for (const alias of Object.keys(definition.inputAliases ?? {})) {
      expect(keys).not.toContain(alias);
    }
  });
});

/**
 * ClinicalTrials.gov answers a request target past 8,177 bytes with HTTP 414
 * (#163). Driven through each tool's contract boundary against the real
 * service: an ID list is served up to what fits, and every other over-long
 * request fails typed, with the declaring tool's hint and no upstream body.
 */
describe('over-long requests (#163)', () => {
  /** A fresh instance per call, so a walk's next request never waits on the previous one's pacer. */
  const freshService = () =>
    mockGetService.mockReturnValue(
      new ClinicalTrialsService(config, { maxRetries: 0, validateFieldsLocally: false }),
    );
  const sentIds = (call: number) => fetchedUrls()[call]?.searchParams.get('filter.ids')?.split('|');
  /** A pageToken as long as the longest measured (100 characters, two-key date sort). */
  const longToken =
    'ZVJ76sWHmqU2wRk2CJf6_LLvwtOWKd8od7KrgP4enT2Tu_0-KXvIFvHRzo5F2CyTasQDTLISRQHVdLwLYomsxf2DUA-SJ6pLPyK4';
  const uriTooLong = () => ({
    ok: false,
    status: 414,
    statusText: 'URI Too Long',
    headers: new Headers({ 'content-type': 'text/html' }),
    json: () => Promise.reject(new Error('Not JSON')),
    text: () =>
      Promise.resolve(
        '<html>\r\n<head><title>414 Request-URI Too Large</title></head>\r\n<body>\r\n<center><h1>414 Request-URI Too Large</h1></center>\r\n<hr><center>nginx/1.26.2</center>\r\n</body>\r\n</html>\r\n',
      ),
  });
  type Wire = {
    deferredNctIds?: string[];
    nextPageToken?: string;
    searchCriteria?: { nctIds?: string[] };
    studies: unknown[];
  };

  it('search_studies queries the leading 563 of 1,000 IDs and names the other 437 on both surfaces', async () => {
    // `/v2/studies` (11) + `?format=json` (12) + `&filter.ids=` (12) + 14n − 3,
    // with 256 of the 8,177 bytes held for the paging parameters: n ≤ 563.
    mockFetch.mockResolvedValue(jsonResponse({ studies: [study('NCT00000000')], totalCount: 563 }));
    const requested = ids(1000);
    const result = await runToolContract(searchStudies, { nctIds: requested });
    const sc = result.structuredContent as Wire;

    expect(result.isError).toBeFalsy();
    expect(sentIds(0)).toEqual(ids(563));
    expect(sc.deferredNctIds).toEqual(ids(437, 563));
    expect([...(sentIds(0) ?? []), ...(sc.deferredNctIds ?? [])]).toEqual(requested);
    expect(sc.searchCriteria?.nctIds).toEqual(ids(563));
    expect(seenText(result)).toContain(
      `Pass them as nctIds in a follow-up call with the same criteria: ${ids(437, 563).join(', ')}`,
    );
  });

  it('search_studies queries the same IDs on the next page of a deferring walk', async () => {
    freshService();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ studies: [study('NCT00000000')], totalCount: 563, nextPageToken: longToken }),
    );
    const first = await runToolContract(searchStudies, { nctIds: ids(1000), pageSize: 1 });
    freshService();
    mockFetch.mockResolvedValueOnce(jsonResponse({ studies: [study('NCT00000001')] }));
    const next = await runToolContract(searchStudies, {
      nctIds: ids(1000),
      pageSize: 1,
      pageToken: (first.structuredContent as Wire).nextPageToken,
    });

    expect(fetchedUrls()[1]?.searchParams.get('pageToken')).toBe(longToken);
    expect(sentIds(1)).toEqual(sentIds(0));
    expect((next.structuredContent as Wire).deferredNctIds).toHaveLength(437);
    expect((next.structuredContent as Wire).deferredNctIds).toEqual(
      (first.structuredContent as Wire).deferredNctIds,
    );
  });

  it('search_studies walks 500 IDs at pageSize 500 as 200, 200, 100 with every ID on every page', async () => {
    const pages = [
      { studies: ids(200).map(study), totalCount: 500, nextPageToken: longToken },
      { studies: ids(200, 200).map(study), nextPageToken: `${longToken.slice(0, -1)}X` },
      { studies: ids(100, 400).map(study) },
    ];
    const served: string[] = [];
    let pageToken: string | undefined;
    for (const page of pages) {
      freshService();
      mockFetch.mockResolvedValueOnce(jsonResponse(page));
      const result = await runToolContract(searchStudies, {
        nctIds: ids(500),
        fields: ['NCTId'],
        pageSize: 500,
        ...(pageToken ? { pageToken } : {}),
      });
      const sc = result.structuredContent as Wire;
      expect(sc).not.toHaveProperty('deferredNctIds');
      served.push(
        ...sc.studies.map(
          (s) =>
            (s as { protocolSection: { identificationModule: { nctId: string } } }).protocolSection
              .identificationModule.nctId,
        ),
      );
      pageToken = sc.nextPageToken;
    }

    expect(fetchedUrls().map((u) => u.searchParams.get('pageSize'))).toEqual(['200', '200', '200']);
    expect([0, 1, 2].map(sentIds)).toEqual([ids(500), ids(500), ids(500)]);
    expect(served).toEqual(ids(500));
    expect(pageToken).toBeUndefined();
  });

  it('search_studies serves the first ID when the other parameters fill the paging reserve but the request fits', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [study(ids(1)[0]!)], totalCount: 1 }));
    const result = await runToolContract(
      searchStudies,
      { query: 'a'.repeat(7900), nctIds: ids(3) },
      { context: { errors: searchStudies.errors } },
    );
    const sc = result.structuredContent as { deferredNctIds?: string[] };

    expect(result.isError).toBeFalsy();
    expect(sentIds(0)).toEqual(ids(1));
    expect(sc.deferredNctIds).toEqual(ids(2, 1));
    expect(seenText(result)).toContain(ids(2, 1).join(', '));
  });

  it('search_studies fails request_too_long before any request when the other parameters leave no room for an ID', async () => {
    const result = await runToolContract(
      searchStudies,
      { query: 'a'.repeat(8150), nctIds: ids(3) },
      { context: { errors: searchStudies.errors } },
    );
    const error = (result.structuredContent as { error: { data: Record<string, unknown> } }).error;

    expect(result.isError).toBe(true);
    expect(error.data.reason).toBe('request_too_long');
    expect(seenText(result)).toContain('None of the 3 NCT IDs fits');
    expect(seenText(result)).toContain('Recovery: Shorten query, the other free-text queries');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['search_studies', () => runToolContract(searchStudies, { query: 'a'.repeat(9099) })],
    ['get_study_count', () => runToolContract(getStudyCount, { query: 'a'.repeat(9099) })],
    [
      'get_field_values',
      () =>
        runToolContract(getFieldValues, {
          fields: Array.from({ length: 700 }, (_, i) => `Piece${i}`),
        }),
    ],
  ] as const)(
    '%s fails an upstream 414 as request_too_long, with no upstream body',
    async (_name, run) => {
      mockFetch.mockResolvedValue(uriTooLong());
      const result = await run();
      const error = (result.structuredContent as { error: { data: Record<string, unknown> } })
        .error;

      expect(result.isError).toBe(true);
      expect(error.data.reason).toBe('request_too_long');
      expect(error.data).not.toHaveProperty('body');
      expect(error.data).not.toHaveProperty('responseBody');
      expect(JSON.stringify(result)).not.toContain('nginx');
      expect(seenText(result)).toContain(`Recovery: ${RECOVERY_HINTS.request_too_long}`);
      expect(fetchedUrls()).toHaveLength(1);
    },
  );
});

describe('AREA[] field names reach upstream in the spelling it accepts (#170)', () => {
  const TOOLS = [
    ['search_studies', searchStudies],
    ['get_study_count', getStudyCount],
  ] as const;
  type Criteria = { searchCriteria?: Record<string, unknown> };
  type ErrorWire = { error: { data: Record<string, unknown> } };

  /**
   * A field-validating service: the default /studies/metadata read answers with
   * the AREA fixture, the second tier's two reads (#179) with theirs, and the
   * /studies search with `primary`.
   */
  const validating = (
    primary: () => unknown = () => jsonResponse({ studies: [], totalCount: 7 }),
  ) => {
    mockGetService.mockReturnValue(new ClinicalTrialsService(config, { maxRetries: 0 }));
    mockFetch.mockImplementation((url: URL | string) => {
      const { pathname, searchParams } = new URL(String(url));
      if (pathname === '/v2/studies/metadata') {
        const indexedOnly = searchParams.get('includeIndexedOnly') === 'true';
        return Promise.resolve(jsonResponse(indexedOnly ? INDEXED_METADATA : AREA_METADATA));
      }
      if (pathname === '/v2/studies/search-areas') {
        return Promise.resolve(jsonResponse(SEARCH_AREAS));
      }
      if (pathname === '/v2/studies') return Promise.resolve(primary());
      return Promise.reject(new Error('unmocked fetch'));
    });
  };
  const searches = () => fetchedUrls().filter((u) => u.pathname === '/v2/studies');
  /** Every request but the search: the metadata read, and the second tier's two when a name misses. */
  const metadataRequests = () => fetchedUrls().length - searches().length;
  const rejection400 = (body: string) => ({
    ok: false,
    status: 400,
    statusText: 'HTTP 400',
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: () => Promise.reject(new Error('Not JSON')),
    text: () => Promise.resolve(body),
  });

  it.each(TOOLS)(
    '%s sends and echoes the canonical spelling in advancedFilter and a query parameter',
    async (_name, definition) => {
      validating();
      const result = await throttled(() =>
        runToolContract(definition, {
          advancedFilter: 'AREA[overallstatus]RECRUITING',
          query: 'AREA[StudyFirstSubmitQcDate]RANGE[2024-01-01,MAX]',
          conditionQuery: 'SEARCH[Location](AREA[locationcity]Seattle)',
        }),
      );
      const [sent] = searches();

      expect(result.isError).toBeFalsy();
      expect(sent?.searchParams.get('filter.advanced')).toBe(
        '(AREA[OverallStatus]RECRUITING) AND (NOT AREA[EnrollmentCount]RANGE[99999999, MAX])',
      );
      expect(sent?.searchParams.get('query.term')).toBe(
        'AREA[StudyFirstSubmitQCDate]RANGE[2024-01-01,MAX]',
      );
      expect(sent?.searchParams.get('query.cond')).toBe(
        'SEARCH[Location](AREA[LocationCity]Seattle)',
      );
      expect((result.structuredContent as Criteria).searchCriteria).toMatchObject({
        advancedFilter: 'AREA[OverallStatus]RECRUITING',
        query: 'AREA[StudyFirstSubmitQCDate]RANGE[2024-01-01,MAX]',
        conditionQuery: 'SEARCH[Location](AREA[LocationCity]Seattle)',
      });
      expect(seenText(result)).toContain('advancedFilter: AREA[OverallStatus]RECRUITING');
      expect(seenText(result)).toContain(
        'query: AREA[StudyFirstSubmitQCDate]RANGE[2024-01-01,MAX]',
      );
      expect(metadataRequests()).toBe(1);
    },
  );

  it.each(TOOLS)(
    '%s sends names upstream accepts, and quoted literals, byte-identical',
    async (_name, definition) => {
      validating();
      const advancedFilter =
        'AREA[COLLABORATOR]Pfizer AND AREA[OVERALL-STATUS]RECRUITING AND AREA[NumLocations]RANGE[100,MAX] AND AREA[ConditionSearch]diabetes AND AREA[numlocations]RANGE[1,MAX]';
      // `numlocations` misses the index-only piece NumLocations only by case, which #179 corrects.
      const sentFilter =
        'AREA[COLLABORATOR]Pfizer AND AREA[OVERALL-STATUS]RECRUITING AND AREA[NumLocations]RANGE[100,MAX] AND AREA[ConditionSearch]diabetes AND AREA[NumLocations]RANGE[1,MAX]';
      const query = '"AREA[overallstatus]RECRUITING"';
      const result = await throttled(() =>
        runToolContract(definition, { advancedFilter, query, includeUnknownEnrollment: true }),
      );
      const [sent] = searches();

      expect(sent?.searchParams.get('filter.advanced')).toBe(sentFilter);
      expect(sent?.searchParams.get('query.term')).toBe(query);
      expect((result.structuredContent as Criteria).searchCriteria).toMatchObject({
        advancedFilter: sentFilter,
        query,
      });
    },
  );

  it.each(TOOLS)(
    '%s sends a legacy alt name in another case as the piece it names',
    async (_name, definition) => {
      validating();
      await throttled(() =>
        runToolContract(definition, {
          advancedFilter: 'AREA[Sponsor]Pfizer OR AREA[Collaborator]Pfizer',
          includeUnknownEnrollment: true,
        }),
      );

      expect(searches()[0]?.searchParams.get('filter.advanced')).toBe(
        'AREA[LeadSponsorName]Pfizer OR AREA[CollaboratorName]Pfizer',
      );
    },
  );

  it.each(TOOLS)(
    '%s requests no metadata for a call naming no AREA[] field of its own',
    async (_name, definition) => {
      validating();
      const result = await runToolContract(definition, {
        conditionQuery: 'asthma',
        phaseFilter: 'phase 3',
      });

      expect(result.isError).toBeFalsy();
      expect(fetchedUrls()).toHaveLength(1);
      expect(searches()[0]?.searchParams.get('filter.advanced')).toContain('AREA[Phase]PHASE3');
    },
  );

  it.each(TOOLS)(
    '%s answers a STRUCT piece with field_invalid naming its leaves on both surfaces',
    async (_name, definition) => {
      validating(() =>
        rejection400(
          'Error parsing query in advanced filter: This type of query is not allowed for LeadSponsor',
        ),
      );
      const result = await throttled(() =>
        runToolContract(
          definition,
          { advancedFilter: 'AREA[LeadSponsor]Pfizer' },
          { context: { errors: definition.errors } },
        ),
      );
      const { data } = (result.structuredContent as ErrorWire).error;

      expect(result.isError).toBe(true);
      expect(data).toMatchObject({
        reason: 'field_invalid',
        invalid: ['LeadSponsor'],
        suggestions: {
          LeadSponsor: ['LeadSponsorName', 'LeadSponsorClass', 'AgreementPISponsorEmployee'],
        },
      });
      expect(seenText(result)).toContain(
        "'LeadSponsor' — did you mean 'LeadSponsorName', 'LeadSponsorClass', 'AgreementPISponsorEmployee'?",
      );
      expect(seenText(result)).toContain(`Recovery: ${RECOVERY_HINTS.field_invalid}`);
      expect(seenText(result)).not.toContain('Query syntax error');
      expect(metadataRequests()).toBe(1);
    },
  );

  it.each(TOOLS)(
    '%s keeps today’s message and hint for an unknown name nothing resembles',
    async (_name, definition) => {
      validating(() =>
        rejection400('Error parsing query in advanced filter: Unknown area name: `NotARealField`'),
      );
      const result = await throttled(() =>
        runToolContract(
          definition,
          { advancedFilter: 'AREA[NotARealField]x' },
          { context: { errors: definition.errors } },
        ),
      );

      expect((result.structuredContent as ErrorWire).error.data).toMatchObject({
        reason: 'field_invalid',
        invalid: ['NotARealField'],
      });
      expect((result.structuredContent as ErrorWire).error.data).not.toHaveProperty('suggestions');
      expect(seenText(result)).toContain(
        "Unknown area name: `NotARealField` 'NotARealField' is not a recognized AREA[]-compatible field. Call clinicaltrials_get_field_definitions to look up valid PascalCase piece names.",
      );
      expect(seenText(result)).toContain(`Recovery: ${RECOVERY_HINTS.field_invalid}`);
    },
  );

  it('search_studies fits nctIds on the corrected text, which a fold to a longer piece lengthens', async () => {
    /**
     * `/v2/studies?format=json` (23) + `&query.term=` (12) + 6,428 + `&filter.ids=`
     * (12) + 14n − 3 + `&filter.advanced=` (17) + `AREA%5BLeadSponsorName%5Dx` (26),
     * within the 7,921 bytes left after the paging reserve: n ≤ 100. Measured on
     * `AREA%5Bsponsor%5Dx` (18), the fit would have taken 101.
     */
    validating();
    const nctIds = ids(200);
    const run = (advancedFilter: string) =>
      runToolContract(searchStudies, { query: 'a'.repeat(6428), nctIds, advancedFilter });
    const [corrected, canonical] = await throttled(async () => [
      await run('AREA[sponsor]x'),
      await run('AREA[LeadSponsorName]x'),
    ]);
    const [first, second] = searches();

    expect(first?.searchParams.get('filter.advanced')).toBe('AREA[LeadSponsorName]x');
    expect(first?.searchParams.get('filter.ids')?.split('|')).toEqual(nctIds.slice(0, 100));
    expect(second?.searchParams.get('filter.ids')).toBe(first?.searchParams.get('filter.ids'));
    expect((corrected.structuredContent as { deferredNctIds?: string[] }).deferredNctIds).toEqual(
      nctIds.slice(100),
    );
    expect((canonical.structuredContent as { deferredNctIds?: string[] }).deferredNctIds).toEqual(
      nctIds.slice(100),
    );
  });
});

/**
 * A valid field named where ClinicalTrials.gov refuses it — inside
 * SEARCH[Location](…) when no site holds it (#183), under RANGE[] when its type
 * takes no range (#187) — reaches the caller as field_invalid with the hint
 * written for that refusal on both surfaces, through each tool's AREA[] name
 * pass and the real service, with `fetch` answering the upstream body verbatim.
 */
describe('a valid field upstream refuses where it stands (#183, #187)', () => {
  const TOOLS = [
    ['search_studies', searchStudies],
    ['get_study_count', getStudyCount],
  ] as const;
  type ErrorWire = { error: { data: Record<string, unknown>; message: string } };

  /** A field-validating service whose /studies search answers HTTP 400 with `body`. */
  const refusing = (body: string) => {
    mockGetService.mockReturnValue(new ClinicalTrialsService(config, { maxRetries: 0 }));
    mockFetch.mockImplementation((url: URL | string) => {
      const { pathname, searchParams } = new URL(String(url));
      if (pathname === '/v2/studies/metadata') {
        const indexedOnly = searchParams.get('includeIndexedOnly') === 'true';
        return Promise.resolve(jsonResponse(indexedOnly ? INDEXED_METADATA : RECORD_METADATA));
      }
      if (pathname === '/v2/studies/search-areas')
        return Promise.resolve(jsonResponse(SEARCH_AREAS));
      if (pathname === '/v2/studies') {
        return Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'HTTP 400',
          headers: new Headers({ 'content-type': 'text/plain' }),
          json: () => Promise.reject(new Error('Not JSON')),
          text: () => Promise.resolve(body),
        });
      }
      return Promise.reject(new Error('unmocked fetch'));
    });
  };
  const call = (definition: (typeof TOOLS)[number][1], input: Record<string, unknown>) =>
    throttled(() =>
      runToolContract(definition as typeof searchStudies, input, {
        context: { errors: definition.errors },
      }),
    );
  const wire = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as ErrorWire).error;

  it.each(TOOLS)(
    '%s answers a study-level field inside SEARCH[Location](…) with the site fields and the form beside it',
    async (_name, definition) => {
      refusing('Error parsing query in advanced filter: `OverallStatus` is outside Location scope');
      const result = await call(definition, {
        advancedFilter: 'SEARCH[Location](AREA[OverallStatus]RECRUITING)',
      });
      const { data, message } = wire(result);
      const hint = (data.recovery as { hint: string }).hint;

      expect(result.isError).toBe(true);
      expect(data).toMatchObject({ reason: 'field_invalid', invalid: ['OverallStatus'] });
      for (const surface of [message, hint]) {
        expect(surface).toContain('LocationStatus');
        expect(surface).toContain(
          'AREA[OverallStatus]RECRUITING AND SEARCH[Location](AREA[LocationCity]Seattle)',
        );
      }
      expect(hint).not.toBe(RECOVERY_HINTS.field_invalid);
      expect(seenText(result)).toContain(`Recovery: ${hint}`);
      expect(seenText(result)).not.toContain('Free-text');
      expect(seenText(result)).not.toContain(RECOVERY_HINTS.query_parse_error);
      // Each expression a caller copies arrives as a code span, never with escaped brackets.
      expect(text(result)).toContain(
        '`AREA[OverallStatus]RECRUITING AND SEARCH[Location](AREA[LocationCity]Seattle)`',
      );
      expect(text(result)).toContain('use `AREA[LocationStatus]` inside the wrapper');
      expect(text(result)).not.toContain('AREA\\[');
    },
  );

  it.each(TOOLS)(
    '%s reads the same refusal in locationQuery, naming the field upstream names',
    async (_name, definition) => {
      refusing('Error parsing query in Location terms: `Phase` is outside Location scope');
      const result = await call(definition, {
        locationQuery: 'SEARCH[Location](AREA[Phase]PHASE2)',
      });

      expect(wire(result).data).toMatchObject({ reason: 'field_invalid', invalid: ['Phase'] });
      expect(seenText(result)).toContain('Error parsing query in Location terms:');
      expect(seenText(result)).toContain('Move AREA[Phase] out of SEARCH[Location](…)');
    },
  );

  it.each(TOOLS)(
    '%s answers a search area inside SEARCH[Location](…) with no did-you-mean',
    async (_name, definition) => {
      refusing('Error parsing query in advanced filter: Unknown area name: `LocationSearch`');
      const result = await call(definition, {
        advancedFilter: 'SEARCH[Location](AREA[LocationSearch]Seattle)',
      });
      const { data } = wire(result);

      expect(data).toMatchObject({ reason: 'field_invalid', invalid: ['LocationSearch'] });
      expect(data).not.toHaveProperty('suggestions');
      expect(seenText(result)).toContain('search areas go outside SEARCH[Location](…)');
      expect(seenText(result)).not.toContain('did you mean');
      expect(text(result)).not.toContain('AREA\\[');
    },
  );

  it.each(TOOLS)(
    '%s answers RANGE[] on NCTId with the StudyFirstPostDate window, not the bracket hint',
    async (_name, definition) => {
      refusing(
        'Error parsing query in advanced filter: RANGE is not supported for nct field protocolSection.identificationModule.nctId',
      );
      const result = await call(definition, {
        conditionQuery: 'tuberculosis',
        advancedFilter: 'AREA[NCTId]RANGE[NCT03000000, NCT04000000]',
      });
      const { data, message } = wire(result);

      expect(data).toMatchObject({ reason: 'field_invalid', invalid: ['NCTId'] });
      expect(message).toContain('bound StudyFirstPostDate instead');
      expect(message).not.toContain('Free-text');
      expect(seenText(result)).not.toContain(RECOVERY_HINTS.query_parse_error);
      expect(seenText(result)).toContain(
        'Recovery: Bound the first posting date instead of the NCT ID, since NCT IDs are assigned in first-posting order: AREA[StudyFirstPostDate]RANGE[2017-01-01, 2018-12-31].',
      );
      expect(text(result)).toContain('`AREA[StudyFirstPostDate]RANGE[2017-01-01, 2018-12-31]`');
      expect(text(result)).not.toContain('RANGE\\[');
    },
  );

  it.each(TOOLS)(
    '%s names BriefTitle from the path of a RANGE[] on it',
    async (_name, definition) => {
      refusing(
        'Error parsing query in advanced filter: RANGE is not supported for text field protocolSection.identificationModule.briefTitle',
      );
      const result = await call(definition, {
        conditionQuery: 'tuberculosis',
        advancedFilter: 'AREA[BriefTitle]RANGE[a, z]',
      });

      expect(wire(result).data).toMatchObject({ reason: 'field_invalid', invalid: ['BriefTitle'] });
      expect(seenText(result)).toContain(
        "Recovery: Match 'BriefTitle' by value instead of by range",
      );
    },
  );

  it.each(TOOLS)(
    '%s names LeadSponsor for a RANGE[] upstream refuses before the group refusal',
    async (_name, definition) => {
      refusing(
        'Error parsing query in advanced filter: RANGE is not supported for Sponsor field protocolSection.sponsorCollaboratorsModule.leadSponsor',
      );
      const result = await call(definition, { advancedFilter: 'AREA[LeadSponsor]RANGE[a, z]' });

      expect(wire(result).data).toMatchObject({
        reason: 'field_invalid',
        invalid: ['LeadSponsor'],
      });
      expect(seenText(result)).toContain("Name one of the leaf pieces of 'LeadSponsor' instead");
    },
  );

  it.each(
    TOOLS.flatMap(([name, definition]) => [
      [
        name,
        'advanced filter',
        definition,
        { advancedFilter: 'AREA[ConditionSearch]RANGE[1, 2]' },
      ] as const,
      [name, 'Conditions or disease', definition, { conditionQuery: 'RANGE[1, 2]' }] as const,
    ]),
  )(
    '%s answers a RANGE[] over several fields in %s with the AREA[Field] guidance and no field blamed',
    async (_name, where, definition, input) => {
      refusing(`Error parsing query in ${where}: RANGE is not supported for multiple (7) fields`);
      const result = await call(definition, input);
      const { data } = wire(result);

      expect(data).toMatchObject({ reason: 'field_invalid' });
      expect(data).not.toHaveProperty('invalid');
      expect(seenText(result)).toContain('RANGE[] needs AREA[Field] naming one of the date');
      expect(seenText(result)).toContain(
        'Recovery: Name one field before the range with AREA[Field], as in AREA[StartDate]RANGE[2020-01-01, MAX];',
      );
      expect(text(result)).toContain('`AREA[StartDate]RANGE[2020-01-01, MAX]`');
      expect(text(result)).not.toContain('RANGE\\[');
    },
  );

  it.each(TOOLS)(
    '%s keeps a bad RANGE bound a query_parse_error, its declared hint’s expressions as code spans',
    async (_name, definition) => {
      refusing(
        'Error parsing query in advanced filter: Cannot parse number for `protocolSection.designModule.enrollmentInfo.count` field',
      );
      const result = await call(definition, { advancedFilter: 'AREA[EnrollmentCount]RANGE[a, z]' });

      expect(wire(result).data).toMatchObject({
        reason: 'query_parse_error',
        recovery: { hint: RECOVERY_HINTS.query_parse_error },
      });
      expect(seenText(result)).toContain(
        'Query syntax error: Cannot parse number for `protocolSection.designModule.enrollmentInfo.count` field.',
      );
      expect(seenText(result)).toContain(`Recovery: ${RECOVERY_HINTS.query_parse_error}`);
      expect(text(result)).toContain(
        'Field-scoped search uses `AREA[FieldName]value`, which works',
      );
      expect(text(result)).toContain('outside an `AREA[…]` / `RANGE[…]` expression');
      expect(text(result)).not.toContain('AREA\\[');
    },
  );

  it.each(TOOLS)(
    '%s keeps an unknown name inside SEARCH[Location](…) today’s message and declared hint',
    async (_name, definition) => {
      refusing('Error parsing query in advanced filter: Unknown area name: `Bogus`');
      const result = await call(definition, { advancedFilter: 'SEARCH[Location](AREA[Bogus]x)' });

      expect(wire(result).data).toMatchObject({ reason: 'field_invalid', invalid: ['Bogus'] });
      expect(seenText(result)).toContain(
        "Unknown area name: `Bogus` 'Bogus' is not a recognized AREA[]-compatible field.",
      );
      expect(seenText(result)).toContain(`Recovery: ${RECOVERY_HINTS.field_invalid}`);
    },
  );

  /**
   * find_eligible runs no AREA[] name pass and takes no advancedFilter, but a
   * conditions entry without whitespace reaches query.cond as written, so it can
   * carry either refusal; the main search is the request upstream refuses. Its
   * fields lie outside the AREA fixture, so its service skips the local field
   * check, as this file's default service does, and neither refusal reads the
   * field index.
   */
  describe('find_eligible, through a conditions entry', () => {
    const patient = {
      age: 40,
      sex: 'ALL' as const,
      location: { country: 'United States', state: 'Washington', city: 'Seattle' },
    };
    /** Upstream answers the main search HTTP 400 with `body`. */
    const refusingSearch = (body: string) => {
      refusing(body);
      mockGetService.mockReturnValue(
        new ClinicalTrialsService(config, { maxRetries: 0, validateFieldsLocally: false }),
      );
    };
    const eligible = (conditions: string[]) =>
      throttled(() =>
        runToolContract(
          findEligible,
          { ...patient, conditions },
          { context: { errors: findEligible.errors } },
        ),
      );
    /** query.cond as the main search, the call's first request, sent it. */
    const sentConditions = () => fetchedUrls()[0]?.searchParams.get('query.cond');

    it('answers a study-level field inside SEARCH[Location](…) with the site fields and the form beside it', async () => {
      refusingSearch(
        'Error parsing query in Conditions or disease: `Phase` is outside Location scope',
      );
      const result = await eligible(['SEARCH[Location](AREA[Phase]PHASE2)']);
      const { data, message } = wire(result);

      expect(sentConditions()).toBe('SEARCH[Location](AREA[Phase]PHASE2)');
      expect(data).toMatchObject({ reason: 'field_invalid', invalid: ['Phase'] });
      expect(message).toContain('Error parsing query in Conditions or disease:');
      expect(message).toContain('LocationStatus');
      expect(seenText(result)).toContain(
        'Recovery: Move AREA[Phase] out of SEARCH[Location](…) and join it beside the wrapper with AND',
      );
      expect(seenText(result)).not.toContain(RECOVERY_HINTS.field_invalid);
      expect(seenText(result)).not.toContain('Free-text');
      expect(text(result)).toContain('Move `AREA[Phase]` out of `SEARCH[Location](…)`');
      expect(text(result)).not.toContain('AREA\\[');
    });

    it('answers a bare RANGE[] with the AREA[Field] guidance and no field blamed', async () => {
      refusingSearch(
        'Error parsing query in Conditions or disease: RANGE is not supported for multiple (7) fields',
      );
      const result = await eligible(['RANGE[1,2]']);
      const { data } = wire(result);

      expect(sentConditions()).toBe('RANGE[1,2]');
      expect(data).toMatchObject({ reason: 'field_invalid' });
      expect(data).not.toHaveProperty('invalid');
      expect(seenText(result)).toContain('RANGE[] needs AREA[Field] naming one of the date');
      expect(seenText(result)).toContain(
        'Recovery: Name one field before the range with AREA[Field], as in AREA[StartDate]RANGE[2020-01-01, MAX];',
      );
      expect(seenText(result)).not.toContain(RECOVERY_HINTS.query_parse_error);
      expect(seenText(result)).not.toContain('Free-text');
      expect(text(result)).toContain('`AREA[StartDate]RANGE[2020-01-01, MAX]`');
      expect(text(result)).not.toContain('RANGE\\[');
    });
  });
});
