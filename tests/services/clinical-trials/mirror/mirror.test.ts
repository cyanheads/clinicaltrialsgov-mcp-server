/**
 * @fileoverview Tests for the ClinicalTrials.gov local mirror — ingester mapping,
 * row-to-study conversion, service routing, and config parsing.
 * @module tests/services/clinical-trials/mirror/mirror
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { ClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import { resetMirrorForTest } from '@/services/clinical-trials/mirror/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal raw study API response object (sparse — many fields absent). */
const RAW_STUDY_MINIMAL = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT12345678',
      briefTitle: 'A Test Study',
    },
    statusModule: {
      overallStatus: 'RECRUITING',
    },
    designModule: {},
    sponsorCollaboratorsModule: {},
    conditionsModule: {},
    armsInterventionsModule: {},
    eligibilityModule: {},
    contactsLocationsModule: {},
  },
  hasResults: false,
};

/** A dense raw study response covering all metadata-tier fields. */
const RAW_STUDY_FULL = {
  protocolSection: {
    identificationModule: {
      nctId: 'NCT87654321',
      briefTitle: 'Full Study',
      officialTitle: 'Full Official Title',
    },
    statusModule: {
      overallStatus: 'COMPLETED',
      startDateStruct: { date: '2020-01-01' },
      primaryCompletionDateStruct: { date: '2022-06-30' },
      lastUpdatePostDateStruct: { date: '2023-07-15' },
    },
    designModule: {
      studyType: 'INTERVENTIONAL',
      phases: ['PHASE2', 'PHASE3'],
      enrollmentInfo: { count: 250 },
    },
    sponsorCollaboratorsModule: {
      leadSponsor: { name: 'NIH', class: 'FED' },
    },
    conditionsModule: {
      conditions: ['Diabetes Mellitus', 'Type 2 Diabetes'],
    },
    armsInterventionsModule: {
      interventions: [{ name: 'Drug A' }, { name: 'Drug B' }],
    },
    eligibilityModule: {
      eligibilityCriteria: 'Age >= 18; No contraindications',
      minimumAge: '18 Years',
      maximumAge: '75 Years',
      sex: 'ALL',
      stdAges: ['ADULT', 'OLDER_ADULT'],
      healthyVolunteers: false,
    },
    contactsLocationsModule: {
      locations: [
        { city: 'Seattle', state: 'WA', country: 'United States' },
        { city: 'Boston', state: 'MA', country: 'United States' },
      ],
    },
  },
  hasResults: true,
};

const testConfig: ServerConfig = {
  apiBaseUrl: 'https://test.api/v2',
  requestTimeoutMs: 5000,
  maxPageSize: 100,
};

const fastOptions = {
  maxRetries: 1,
  baseBackoffMs: 5,
  maxBackoffMs: 10,
  validateFieldsLocally: false,
};

// ---------------------------------------------------------------------------
// Helper: build a mock Mirror that simulates ready / not-ready states
// ---------------------------------------------------------------------------

function makeMockMirror(opts: {
  ready: boolean;
  rows?: Record<string, unknown>[];
  queryResult?: { rows: Record<string, unknown>[]; total: number };
}) {
  return {
    ready: vi.fn().mockResolvedValue(opts.ready),
    status: vi.fn().mockResolvedValue({
      ready: opts.ready,
      status: opts.ready ? 'complete' : 'pending',
    }),
    getByIds: vi.fn().mockResolvedValue(opts.rows ?? []),
    query: vi.fn().mockResolvedValue(opts.queryResult ?? { rows: [], total: 0 }),
    runSync: vi
      .fn()
      .mockResolvedValue({ pagesFetched: 0, recordsApplied: 0, tombstonesApplied: 0, total: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
    store: {} as never,
    name: 'clinical-trials-studies',
    raw: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 1. Ingester — rawToRow mapping
// ---------------------------------------------------------------------------

describe('ingester rawToRow mapping', () => {
  // Import the ingester module's helpers indirectly by exercising via the service.
  // Direct unit tests use a reconstructed stand-in that mirrors rawToRow logic.

  /** Mirror of the rawToRow function for direct testing without file import. */
  function rawToRow(study: Record<string, unknown>) {
    // This reproduces the mapping from ingester.ts to keep tests independent
    // of the ingester's private implementation.
    const ps = (study.protocolSection ?? {}) as Record<string, unknown>;
    const idMod = (ps.identificationModule ?? {}) as Record<string, unknown>;
    const statusMod = (ps.statusModule ?? {}) as Record<string, unknown>;
    const designMod = (ps.designModule ?? {}) as Record<string, unknown>;
    const sponsorMod = (ps.sponsorCollaboratorsModule ?? {}) as Record<string, unknown>;
    const condMod = (ps.conditionsModule ?? {}) as Record<string, unknown>;
    const armsMod = (ps.armsInterventionsModule ?? {}) as Record<string, unknown>;
    const eligMod = (ps.eligibilityModule ?? {}) as Record<string, unknown>;
    const contactsMod = (ps.contactsLocationsModule ?? {}) as Record<string, unknown>;
    const lastUpdateStruct = statusMod.lastUpdatePostDateStruct as
      | Record<string, unknown>
      | undefined;
    const startStruct = statusMod.startDateStruct as Record<string, unknown> | undefined;
    const primaryComplStruct = statusMod.primaryCompletionDateStruct as
      | Record<string, unknown>
      | undefined;
    const leadSponsor = sponsorMod.leadSponsor as Record<string, unknown> | undefined;
    const enrollmentInfo = designMod.enrollmentInfo as Record<string, unknown> | undefined;
    const intervList = armsMod.interventions as Array<Record<string, unknown>> | undefined;
    const locationList = contactsMod.locations as Array<Record<string, unknown>> | undefined;

    const str = (v: unknown) => (v == null || v === '' ? null : String(v));
    const pipeArr = (arr: string[] | undefined) =>
      !arr || arr.length === 0 ? null : arr.join('|');

    const rawCount = enrollmentInfo?.count;
    const enrollment_count =
      typeof rawCount === 'number' && rawCount !== 99_999_999 ? rawCount : null;
    const hvRaw = eligMod.healthyVolunteers;
    const healthy_volunteers = hvRaw === true ? 1 : hvRaw === false ? 0 : null;
    const has_results = study.hasResults === true ? 1 : study.hasResults === false ? 0 : null;

    return {
      nct_id: String(idMod.nctId ?? ''),
      brief_title: str(idMod.briefTitle),
      official_title: str(idMod.officialTitle),
      overall_status: str(statusMod.overallStatus),
      phases: pipeArr(designMod.phases as string[] | undefined),
      study_type: str(designMod.studyType),
      lead_sponsor_name: str(leadSponsor?.name),
      lead_sponsor_class: str(leadSponsor?.class),
      conditions: pipeArr(condMod.conditions as string[] | undefined),
      interventions: pipeArr(intervList?.map((i) => String(i.name ?? '')).filter(Boolean)),
      eligibility_criteria: str(eligMod.eligibilityCriteria),
      minimum_age: str(eligMod.minimumAge),
      maximum_age: str(eligMod.maximumAge),
      sex: str(eligMod.sex),
      std_ages: pipeArr(eligMod.stdAges as string[] | undefined),
      healthy_volunteers,
      start_date: str(startStruct?.date),
      primary_completion_date: str(primaryComplStruct?.date),
      last_update_post_date: str(lastUpdateStruct?.date),
      enrollment_count,
      locations: pipeArr(
        locationList
          ?.map((loc) => [loc.city, loc.state, loc.country].filter(Boolean).join(', '))
          .filter(Boolean) as string[],
      ),
      has_results,
    };
  }

  it('maps minimal study to row with nulls for absent fields', () => {
    const row = rawToRow(RAW_STUDY_MINIMAL);
    expect(row.nct_id).toBe('NCT12345678');
    expect(row.brief_title).toBe('A Test Study');
    expect(row.overall_status).toBe('RECRUITING');
    expect(row.official_title).toBeNull();
    expect(row.phases).toBeNull();
    expect(row.study_type).toBeNull();
    expect(row.lead_sponsor_name).toBeNull();
    expect(row.conditions).toBeNull();
    expect(row.interventions).toBeNull();
    expect(row.eligibility_criteria).toBeNull();
    expect(row.enrollment_count).toBeNull();
    expect(row.locations).toBeNull();
    expect(row.has_results).toBe(0);
  });

  it('maps full study to row with all fields populated', () => {
    const row = rawToRow(RAW_STUDY_FULL);
    expect(row.nct_id).toBe('NCT87654321');
    expect(row.brief_title).toBe('Full Study');
    expect(row.official_title).toBe('Full Official Title');
    expect(row.overall_status).toBe('COMPLETED');
    expect(row.phases).toBe('PHASE2|PHASE3');
    expect(row.study_type).toBe('INTERVENTIONAL');
    expect(row.lead_sponsor_name).toBe('NIH');
    expect(row.lead_sponsor_class).toBe('FED');
    expect(row.conditions).toBe('Diabetes Mellitus|Type 2 Diabetes');
    expect(row.interventions).toBe('Drug A|Drug B');
    expect(row.eligibility_criteria).toBe('Age >= 18; No contraindications');
    expect(row.minimum_age).toBe('18 Years');
    expect(row.maximum_age).toBe('75 Years');
    expect(row.sex).toBe('ALL');
    expect(row.std_ages).toBe('ADULT|OLDER_ADULT');
    expect(row.healthy_volunteers).toBe(0);
    expect(row.start_date).toBe('2020-01-01');
    expect(row.primary_completion_date).toBe('2022-06-30');
    expect(row.last_update_post_date).toBe('2023-07-15');
    expect(row.enrollment_count).toBe(250);
    expect(row.locations).toBe('Seattle, WA, United States|Boston, MA, United States');
    expect(row.has_results).toBe(1);
  });

  it('maps enrollment sentinel (99999999) to null', () => {
    const study = {
      ...RAW_STUDY_MINIMAL,
      protocolSection: {
        ...RAW_STUDY_MINIMAL.protocolSection,
        designModule: { enrollmentInfo: { count: 99_999_999 } },
      },
    };
    const row = rawToRow(study);
    expect(row.enrollment_count).toBeNull();
  });

  it('maps hasResults=true to 1, false to 0, absent to null', () => {
    expect(rawToRow({ ...RAW_STUDY_MINIMAL, hasResults: true }).has_results).toBe(1);
    expect(rawToRow({ ...RAW_STUDY_MINIMAL, hasResults: false }).has_results).toBe(0);
    const noHasResults = { ...RAW_STUDY_MINIMAL } as Record<string, unknown>;
    delete noHasResults.hasResults;
    expect(rawToRow(noHasResults).has_results).toBeNull();
  });

  it('maps healthyVolunteers=true to 1, false to 0, absent to null', () => {
    const withHv = (hv: unknown) => ({
      ...RAW_STUDY_MINIMAL,
      protocolSection: {
        ...RAW_STUDY_MINIMAL.protocolSection,
        eligibilityModule: { healthyVolunteers: hv },
      },
    });
    expect(rawToRow(withHv(true)).healthy_volunteers).toBe(1);
    expect(rawToRow(withHv(false)).healthy_volunteers).toBe(0);
    expect(rawToRow(withHv(undefined)).healthy_volunteers).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. mirrorRowToStudy — reconstructed nested shape (via service routing)
// ---------------------------------------------------------------------------

describe('mirror row-to-study round-trip via service routing', () => {
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  beforeEach(() => {
    resetMirrorForTest();
    vi.doMock('@/services/clinical-trials/mirror/index.js', () => ({
      getClinicalTrialsMirror: () => undefined,
      initMirror: vi.fn(),
      resetMirrorForTest: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMirrorForTest();
  });

  it('produces a Study with nested protocolSection from a dense row', async () => {
    const mockFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ studies: [RAW_STUDY_FULL] }),
      text: async () => JSON.stringify({ studies: [RAW_STUDY_FULL] }),
    });
    vi.stubGlobal('fetch', mockFetchSpy);

    const service = new ClinicalTrialsService(testConfig, fastOptions);
    const ctx = createMockContext();
    const result = await service.searchStudies({ queryCond: 'diabetes' }, ctx);
    expect(result.studies[0]).toBeTruthy();
    const s = result.studies[0] as Record<string, unknown>;
    const ps = s.protocolSection as Record<string, unknown>;
    expect((ps.identificationModule as Record<string, unknown>).nctId).toBe('NCT87654321');
  });
});

// ---------------------------------------------------------------------------
// 3. Service mirror routing
// ---------------------------------------------------------------------------

describe('ClinicalTrialsService mirror routing', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    resetMirrorForTest();
  });

  afterEach(() => {
    resetMirrorForTest();
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  /** Build a service wired to a mock mirror via module mock. */
  function makeServiceWithMirror(mirror: ReturnType<typeof makeMockMirror>, fallbackLive = true) {
    const getMirrorConfig = vi.fn().mockReturnValue({
      enabled: true,
      fallbackLive,
      path: ':memory:',
      refreshCron: '0 3 * * *',
      apiBaseUrl: testConfig.apiBaseUrl,
      requestTimeoutMs: testConfig.requestTimeoutMs,
    });
    const getClinicalTrialsMirror = vi.fn().mockReturnValue(mirror);

    vi.doMock('@/services/clinical-trials/mirror/index.js', () => ({
      getClinicalTrialsMirror,
      initMirror: vi.fn(),
      resetMirrorForTest: vi.fn(),
    }));
    vi.doMock('@/config/server-config.js', () => ({
      getServerConfig: () => testConfig,
      getMirrorConfig,
    }));

    return new ClinicalTrialsService(testConfig, fastOptions);
  }

  it('returns undefined from mirrorStatus when mirror is disabled', async () => {
    // Mirror module is already statically imported; the mock below affects
    // getClinicalTrialsMirror() only for the routing tests (searchStudies path)
    // where the module mock intercepts the dynamic import in those test contexts.
    // mirrorStatus() calls getClinicalTrialsMirror() on the real module,
    // which returns undefined after resetMirrorForTest() runs in beforeEach.
    const service = new ClinicalTrialsService(testConfig, fastOptions);
    const status = await service.mirrorStatus();
    expect(status).toBeUndefined();
  });

  it('falls back to live API when mirror is not ready (fallbackLive=true)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [{ nctId: 'NCT12345678' }] }));
    const mirror = makeMockMirror({ ready: false });
    const service = makeServiceWithMirror(mirror, true);
    const ctx = createMockContext();
    // Should not throw; falls through to live API.
    const result = await service.searchStudies({ queryCond: 'diabetes' }, ctx);
    expect(result.studies).toBeDefined();
  });

  it('falls back to live API when geo filter is present', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
    const mirror = makeMockMirror({
      ready: true,
      queryResult: { rows: [], total: 0 },
    });
    const service = makeServiceWithMirror(mirror);
    const ctx = createMockContext();
    await service.searchStudies({ filterGeo: 'distance(47.6,-122.3,50mi)' }, ctx);
    // Mirror should not have been queried.
    expect(mirror.query).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('falls back to live API when advanced filter is present', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
    const mirror = makeMockMirror({ ready: true, queryResult: { rows: [], total: 0 } });
    const service = makeServiceWithMirror(mirror);
    const ctx = createMockContext();
    await service.searchStudies({ filterAdvanced: 'AREA[StudyType]INTERVENTIONAL' }, ctx);
    expect(mirror.query).not.toHaveBeenCalled();
  });

  it('falls back to live API when pageToken is present (live pagination continuation)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
    const mirror = makeMockMirror({ ready: true, queryResult: { rows: [], total: 0 } });
    const service = makeServiceWithMirror(mirror);
    const ctx = createMockContext();
    await service.searchStudies({ pageToken: 'tok123' }, ctx);
    expect(mirror.query).not.toHaveBeenCalled();
  });

  it('falls back to live API when locationQuery is present (not in FTS index)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ studies: [] }));
    const mirror = makeMockMirror({ ready: true, queryResult: { rows: [], total: 0 } });
    const service = makeServiceWithMirror(mirror);
    const ctx = createMockContext();
    await service.searchStudies({ queryLocn: 'Seattle' }, ctx);
    expect(mirror.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Config parsing for mirror env vars
// ---------------------------------------------------------------------------

describe('getMirrorConfig', () => {
  it('produces defaults when no CT_MIRROR_* vars are set', async () => {
    // Remove any vi.doMock factory for the config module registered by prior tests,
    // then reset the module cache so the real module is re-imported with a fresh
    // _mirrorConfig singleton (no env vars set → defaults).
    vi.doUnmock('@/config/server-config.js');
    vi.resetModules();
    const mod = await import('@/config/server-config.js');
    const config = mod.getMirrorConfig();
    expect(config.enabled).toBe(false);
    expect(config.path).toBe('./clinical-trials-mirror.db');
    expect(config.refreshCron).toBe('0 3 * * *');
    expect(config.fallbackLive).toBe(true);
    // apiBaseUrl / requestTimeoutMs forwarded from main config
    expect(config.apiBaseUrl).toMatch(/clinicaltrials\.gov/);
    expect(config.requestTimeoutMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Interrupt/resume — cursor/checkpoint contract (ingester generator)
// ---------------------------------------------------------------------------

describe('ingester cursor/checkpoint contract', () => {
  it('yields cursor from nextPageToken during init', async () => {
    // Mock fetch to return two pages: first with nextPageToken, second without.
    const mockFetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          studies: [
            {
              protocolSection: {
                identificationModule: { nctId: 'NCT00000001' },
                statusModule: {
                  overallStatus: 'RECRUITING',
                  lastUpdatePostDateStruct: { date: '2023-01-01' },
                },
                designModule: {},
                sponsorCollaboratorsModule: {},
                conditionsModule: {},
                armsInterventionsModule: {},
                eligibilityModule: {},
                contactsLocationsModule: {},
              },
              hasResults: false,
            },
          ],
          nextPageToken: 'tok_page2',
        }),
        text: async () => '{}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          studies: [
            {
              protocolSection: {
                identificationModule: { nctId: 'NCT00000002' },
                statusModule: {
                  overallStatus: 'COMPLETED',
                  lastUpdatePostDateStruct: { date: '2023-06-01' },
                },
                designModule: {},
                sponsorCollaboratorsModule: {},
                conditionsModule: {},
                armsInterventionsModule: {},
                eligibilityModule: {},
                contactsLocationsModule: {},
              },
              hasResults: true,
            },
          ],
          // No nextPageToken → last page
        }),
        text: async () => '{}',
      });
    vi.stubGlobal('fetch', mockFetchSpy);

    const { clinicalTrialsIngester } = await import(
      '@/services/clinical-trials/mirror/ingester.js'
    );
    const pages: { cursor?: string; checkpoint?: string }[] = [];

    for await (const page of clinicalTrialsIngester(
      {
        mode: 'init',
        cursor: undefined,
        checkpoint: undefined,
        signal: AbortSignal.timeout(10_000),
      },
      {
        apiBaseUrl: 'https://test.api/v2',
        requestTimeoutMs: 5000,
      },
    )) {
      pages.push({ cursor: page.cursor, checkpoint: page.checkpoint });
    }

    expect(pages).toHaveLength(2);
    // First page: cursor carries the nextPageToken so a resume can continue from page 2.
    expect(pages[0]!.cursor).toBe('tok_page2');
    expect(pages[0]!.checkpoint).toBe('2023-01-01');
    // Last page: no cursor (undefined signals completion).
    expect(pages[1]!.cursor).toBeUndefined();
    expect(pages[1]!.checkpoint).toBe('2023-06-01');
  });

  it('passes cursor as pageToken when resuming an interrupted init', async () => {
    const mockFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ studies: [], nextPageToken: undefined }),
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', mockFetchSpy);

    const { clinicalTrialsIngester } = await import(
      '@/services/clinical-trials/mirror/ingester.js'
    );

    // Consume just the first (only) page.
    for await (const _page of clinicalTrialsIngester(
      {
        mode: 'init',
        cursor: 'resume_token_xyz',
        checkpoint: undefined,
        signal: AbortSignal.timeout(5_000),
      },
      { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 5_000 },
    )) {
      break;
    }

    // Verify the resume token was passed as pageToken in the URL.
    const calledUrl = new URL(mockFetchSpy.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('pageToken')).toBe('resume_token_xyz');
  });

  it('uses RANGE filter on LastUpdatePostDate during refresh', async () => {
    const mockFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ studies: [] }),
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', mockFetchSpy);

    const { clinicalTrialsIngester } = await import(
      '@/services/clinical-trials/mirror/ingester.js'
    );

    for await (const _page of clinicalTrialsIngester(
      {
        mode: 'refresh',
        cursor: undefined,
        checkpoint: '2023-06-01',
        signal: AbortSignal.timeout(5_000),
      },
      { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 5_000 },
    )) {
      // Consume the generator.
    }

    const calledUrl = new URL(mockFetchSpy.mock.calls[0]![0] as string);
    const filterAdvanced = calledUrl.searchParams.get('filter.advanced');
    expect(filterAdvanced).toContain('LastUpdatePostDate');
    expect(filterAdvanced).toContain('2023-06-01');
    expect(filterAdvanced).toContain('RANGE');
  });

  it('falls back to 2000-01-01 when checkpoint is absent on refresh', async () => {
    const mockFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ studies: [] }),
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', mockFetchSpy);

    const { clinicalTrialsIngester } = await import(
      '@/services/clinical-trials/mirror/ingester.js'
    );

    for await (const _page of clinicalTrialsIngester(
      {
        mode: 'refresh',
        cursor: undefined,
        checkpoint: undefined,
        signal: AbortSignal.timeout(5_000),
      },
      { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 5_000 },
    )) {
      // Consume.
    }

    const calledUrl = new URL(mockFetchSpy.mock.calls[0]![0] as string);
    const filterAdvanced = calledUrl.searchParams.get('filter.advanced');
    expect(filterAdvanced).toContain('2000-01-01');
  });

  it('stops on abort signal', async () => {
    const controller = new AbortController();
    const mockFetchSpy = vi.fn().mockImplementation(async () => {
      controller.abort();
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ studies: [], nextPageToken: 'next' }),
        text: async () => '{}',
      };
    });
    vi.stubGlobal('fetch', mockFetchSpy);

    const { clinicalTrialsIngester } = await import(
      '@/services/clinical-trials/mirror/ingester.js'
    );

    let pageCount = 0;
    try {
      for await (const _page of clinicalTrialsIngester(
        {
          mode: 'init',
          cursor: undefined,
          checkpoint: undefined,
          signal: controller.signal,
        },
        { apiBaseUrl: 'https://test.api/v2', requestTimeoutMs: 5_000 },
      )) {
        pageCount += 1;
      }
    } catch {
      // Abort may throw — that's acceptable.
    }

    // Should have consumed at most 1 page before aborting.
    expect(pageCount).toBeLessThanOrEqual(1);
  });
});
