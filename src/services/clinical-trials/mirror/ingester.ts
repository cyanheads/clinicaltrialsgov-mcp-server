/**
 * @fileoverview ClinicalTrials.gov pageToken-based ingester for the local mirror.
 *
 * Implements the `SyncGenerator` contract consumed by `defineMirror`. Pages the
 * `/studies` endpoint at `pageSize=1000` (API maximum) using `pageToken` paging.
 *
 * - **Full init (`mode === 'init'`):** iterates every page from the beginning (or
 *   resumes from a persisted `cursor` after an interrupt). Yields each page with
 *   the `cursor` set to the next `pageToken` so the runner can persist it.
 *   `checkpoint` advances per page as the max `lastUpdatePostDate` observed.
 *
 * - **Incremental refresh (`mode === 'refresh'`):** filters via
 *   `filter.advanced=AREA[LastUpdatePostDate]RANGE[cursor,MAX]` where `cursor`
 *   is the last persisted `checkpoint`. No pageToken paging state to resume.
 *
 * Bootstrap rate is ~1 req/s (the minimum interval enforced by the API rate
 * limit), so full init of ~577K studies (~578 pages) takes ~10 min. Incremental
 * refresh fetches only updated studies since the last checkpoint and completes
 * in seconds to a few minutes depending on daily activity.
 * @module services/clinical-trials/mirror/ingester
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorLogger, MirrorRow, SyncContext, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import type { StudyMetaRow } from './types.js';

/** Fields requested from the API for metadata tier — enough for all mirror columns. */
const MIRROR_FIELDS = [
  'NCTId',
  'BriefTitle',
  'OfficialTitle',
  'OverallStatus',
  'Phase',
  'StudyType',
  'LeadSponsorName',
  'LeadSponsorClass',
  'Condition',
  'InterventionName',
  'EligibilityCriteria',
  'MinimumAge',
  'MaximumAge',
  'Sex',
  'StdAge',
  'HealthyVolunteers',
  'StartDate',
  'PrimaryCompletionDate',
  'LastUpdatePostDate',
  'EnrollmentCount',
  'LocationCity',
  'LocationState',
  'LocationCountry',
  'HasResults',
].join('|');

/**
 * Sentinel value for unknown enrollment count on ClinicalTrials.gov.
 * Studies carrying this value are stored with `null` enrollment_count.
 */
const ENROLLMENT_SENTINEL = 99_999_999;

/** Per-page size — API maximum. */
const PAGE_SIZE = 1000;

/** Minimum delay between requests (ms) — matches API rate limit guidance. */
const REQUEST_DELAY_MS = 1050;

/** Configuration for the ingester. */
export interface IngesterOptions {
  /** ClinicalTrials.gov API v2 base URL. */
  apiBaseUrl: string;
  /** Logger (optional). */
  log?: MirrorLogger;
  /** Per-request timeout in ms. */
  requestTimeoutMs: number;
}

/**
 * Map a raw study record from the API to a `StudyMetaRow` for storage.
 * All fields are extracted from the nested API structure and flattened.
 * Unknown or missing values are mapped to `null`.
 */
function rawToRow(study: Record<string, unknown>): StudyMetaRow {
  const ps = (study.protocolSection ?? {}) as Record<string, unknown>;
  const idMod = (ps.identificationModule ?? {}) as Record<string, unknown>;
  const statusMod = (ps.statusModule ?? {}) as Record<string, unknown>;
  const designMod = (ps.designModule ?? {}) as Record<string, unknown>;
  const sponsorMod = (ps.sponsorCollaboratorsModule ?? {}) as Record<string, unknown>;
  const condMod = (ps.conditionsModule ?? {}) as Record<string, unknown>;
  const armsMod = (ps.armsInterventionsModule ?? {}) as Record<string, unknown>;
  const eligMod = (ps.eligibilityModule ?? {}) as Record<string, unknown>;
  const contactsMod = (ps.contactsLocationsModule ?? {}) as Record<string, unknown>;

  // NCT ID
  const nct_id = String(idMod.nctId ?? '');

  // Titles
  const brief_title = str(idMod.briefTitle);
  const official_title = str(idMod.officialTitle);

  // Status
  const overall_status = str(statusMod.overallStatus);

  // Dates from lastUpdatePostDateStruct (contains .date, .type)
  const lastUpdateStruct = statusMod.lastUpdatePostDateStruct as
    | Record<string, unknown>
    | undefined;
  const last_update_post_date = str(lastUpdateStruct?.date);
  const startStruct = statusMod.startDateStruct as Record<string, unknown> | undefined;
  const start_date = str(startStruct?.date);
  const primaryComplStruct = statusMod.primaryCompletionDateStruct as
    | Record<string, unknown>
    | undefined;
  const primary_completion_date = str(primaryComplStruct?.date);

  // Design
  const phases = pipeArray(designMod.phases as string[] | undefined);
  const study_type = str(designMod.studyType);
  const enrollmentInfo = designMod.enrollmentInfo as Record<string, unknown> | undefined;
  const rawCount = enrollmentInfo?.count;
  const enrollment_count =
    typeof rawCount === 'number' && rawCount !== ENROLLMENT_SENTINEL ? rawCount : null;

  // Sponsor
  const leadSponsor = sponsorMod.leadSponsor as Record<string, unknown> | undefined;
  const lead_sponsor_name = str(leadSponsor?.name);
  const lead_sponsor_class = str(leadSponsor?.class);

  // Conditions
  const conditions = pipeArray(condMod.conditions as string[] | undefined);

  // Interventions — names only from armsInterventionsModule
  const intervList = armsMod.interventions as Array<Record<string, unknown>> | undefined;
  const interventions = pipeArray(intervList?.map((i) => String(i.name ?? '')).filter(Boolean));

  // Eligibility
  const eligibility_criteria = str(eligMod.eligibilityCriteria);
  const minimum_age = str(eligMod.minimumAge);
  const maximum_age = str(eligMod.maximumAge);
  const sex = str(eligMod.sex);
  const std_ages = pipeArray(eligMod.stdAges as string[] | undefined);
  const hvRaw = eligMod.healthyVolunteers;
  const healthy_volunteers = hvRaw === true ? 1 : hvRaw === false ? 0 : null;

  // Locations — city, state, country summary
  const locationList = contactsMod.locations as Array<Record<string, unknown>> | undefined;
  const locations = pipeArray(
    locationList
      ?.map((loc) => {
        const parts = [loc.city, loc.state, loc.country].filter(Boolean).join(', ');
        return parts || null;
      })
      .filter((p): p is string => p !== null),
  );

  // Has results
  const has_results = study.hasResults === true ? 1 : study.hasResults === false ? 0 : null;

  return {
    nct_id,
    brief_title,
    official_title,
    overall_status,
    phases,
    study_type,
    lead_sponsor_name,
    lead_sponsor_class,
    conditions,
    interventions,
    eligibility_criteria,
    minimum_age,
    maximum_age,
    sex,
    std_ages,
    healthy_volunteers,
    start_date,
    primary_completion_date,
    last_update_post_date,
    enrollment_count,
    locations,
    has_results,
  };
}

/** Safely coerce to TEXT or null. */
function str(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v);
}

/** Join an array with `|` delimiter, or return null if empty/absent. */
function pipeArray(arr: string[] | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  return arr.join('|');
}

/** Maximum `lastUpdatePostDate` across a page's rows (ISO-comparable strings). */
function maxCheckpoint(rows: StudyMetaRow[]): string | undefined {
  const dates = rows.map((r) => r.last_update_post_date).filter((d): d is string => d != null);
  if (dates.length === 0) return;
  dates.sort();
  return dates[dates.length - 1];
}

/**
 * Fetch one page from the ClinicalTrials.gov `/studies` endpoint.
 * Returns the parsed body or throws on failure.
 */
async function fetchPage(
  url: URL,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ studies: unknown[]; nextPageToken?: string }> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: combined,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw serviceUnavailable(
      'ClinicalTrials.gov API unreachable during mirror sync',
      { url: url.toString() },
      { cause: err },
    );
  }
  if (!res.ok) {
    throw serviceUnavailable(
      `ClinicalTrials.gov API returned HTTP ${res.status} during mirror sync`,
      { url: url.toString(), status: res.status },
    );
  }
  return res.json() as Promise<{ studies: unknown[]; nextPageToken?: string }>;
}

/** Delay `ms` milliseconds, respecting the abort signal. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Build the base `/studies` URL with common parameters for the metadata tier.
 * The caller adds pagination parameters on top.
 */
function buildStudiesUrl(apiBaseUrl: string, filterAdvanced?: string): URL {
  const url = new URL(`${apiBaseUrl}/studies`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('fields', MIRROR_FIELDS);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  if (filterAdvanced) url.searchParams.set('filter.advanced', filterAdvanced);
  return url;
}

/**
 * Async generator that pages through the ClinicalTrials.gov `/studies` endpoint
 * and yields `SyncPage` objects for the mirror runner.
 *
 * Implements the `SyncGenerator` interface from `@cyanheads/mcp-ts-core/mirror`.
 */
export async function* clinicalTrialsIngester(
  ctx: SyncContext,
  options: IngesterOptions,
): AsyncGenerator<SyncPage> {
  const { mode, cursor, checkpoint, signal } = ctx;
  const { apiBaseUrl, requestTimeoutMs, log } = options;

  let pageCount = 0;
  let totalRecords = 0;

  if (mode === 'init') {
    // Full bootstrap: page from the beginning (or resume via cursor = pageToken).
    const baseUrl = buildStudiesUrl(apiBaseUrl);
    let pageToken: string | undefined = cursor;

    while (true) {
      if (signal.aborted) return;

      const url = new URL(baseUrl.toString());
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const body = await fetchPage(url, requestTimeoutMs, signal);
      const raw = (body.studies ?? []) as Record<string, unknown>[];
      const rows = raw.map(rawToRow);
      const nextToken = body.nextPageToken;
      pageCount += 1;
      totalRecords += rows.length;

      // checkpoint: max lastUpdatePostDate seen so far (monotonic across pages).
      const pageCheckpoint = maxCheckpoint(rows);

      if (pageCount % 50 === 0) {
        log?.info?.('Mirror init progress', {
          pages: pageCount,
          records: totalRecords,
          checkpoint: pageCheckpoint,
        });
      }

      yield {
        records: rows as unknown as MirrorRow[],
        cursor: nextToken,
        checkpoint: pageCheckpoint,
      };

      if (!nextToken) break;
      pageToken = nextToken;

      // Rate-limit delay between pages.
      if (!signal.aborted) await sleep(REQUEST_DELAY_MS, signal).catch(() => undefined);
    }

    log?.info?.('Mirror init complete', { pages: pageCount, records: totalRecords });
  } else {
    // Incremental refresh: fetch only studies updated since the last checkpoint.
    // Use RANGE[checkpoint,MAX] filter on LastUpdatePostDate.
    const since = checkpoint ?? '2000-01-01';
    const filterAdvanced = `AREA[LastUpdatePostDate]RANGE[${since},MAX]`;
    const baseUrl = buildStudiesUrl(apiBaseUrl, filterAdvanced);
    let pageToken: string | undefined;

    while (true) {
      if (signal.aborted) return;

      const url = new URL(baseUrl.toString());
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const body = await fetchPage(url, requestTimeoutMs, signal);
      const raw = (body.studies ?? []) as Record<string, unknown>[];
      const rows = raw.map(rawToRow);
      const nextToken = body.nextPageToken;
      pageCount += 1;
      totalRecords += rows.length;

      const pageCheckpoint = maxCheckpoint(rows);

      yield {
        records: rows as unknown as MirrorRow[],
        checkpoint: pageCheckpoint,
        // No cursor for refresh — it's not resumed on interrupt.
      };

      if (!nextToken) break;
      pageToken = nextToken;

      if (!signal.aborted) await sleep(REQUEST_DELAY_MS, signal).catch(() => undefined);
    }

    log?.info?.('Mirror refresh complete', {
      pages: pageCount,
      records: totalRecords,
      since,
    });
  }
}
