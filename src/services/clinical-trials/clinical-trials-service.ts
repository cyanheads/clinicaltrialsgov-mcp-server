/**
 * @fileoverview ClinicalTrials.gov REST API v2 client with retry, rate limiting, and timeout.
 * @module services/clinical-trials/clinical-trials-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  type FieldIndexEntry,
  flattenMetadata,
  nearestPieces,
  searchFields,
} from './field-search.js';
import type {
  FieldNode,
  FieldValueStats,
  PagedStudiesResponse,
  SearchParams,
  Study,
} from './types.js';

const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MIN_INTERVAL_MS = 1000;
/**
 * ClinicalTrials.gov uses 99999999 as a sentinel for "unknown enrollment
 * count". The filter below excludes studies carrying the sentinel by
 * default — `RANGE[5000, MAX]` and `EnrollmentCount:desc` otherwise surface
 * sentinel-polluted results that look like the largest trials but aren't.
 */
const ENROLLMENT_SENTINEL_FILTER = 'AREA[EnrollmentCount]RANGE[0, 99999998]';

/** Constructor options for overriding retry/backoff/validation behavior (primarily for tests). */
export interface ClinicalTrialsServiceOptions {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  /**
   * Whether to validate `fields` against the cached metadata index before
   * making API calls. Defaults to true; lazy-fetches /studies/metadata on
   * first use, then caches the index in-memory.
   */
  validateFieldsLocally?: boolean;
}

export class ClinicalTrialsService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPageSize: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly validateFieldsLocally: boolean;
  private lastRequestAt = 0;
  private fieldIndexPromise:
    | Promise<{ entries: FieldIndexEntry[]; pieceSet: Set<string> }>
    | undefined;

  constructor(config: ServerConfig, options: ClinicalTrialsServiceOptions = {}) {
    this.baseUrl = config.apiBaseUrl;
    this.timeoutMs = config.requestTimeoutMs;
    this.maxPageSize = config.maxPageSize;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.validateFieldsLocally = options.validateFieldsLocally ?? true;
  }

  /** Search studies with query, filters, pagination, and field selection. */
  async searchStudies(params: SearchParams, ctx: Context): Promise<PagedStudiesResponse> {
    if (this.validateFieldsLocally && params.fields?.length) {
      await this.validateFields(params.fields, ctx);
    }
    const q = this.buildSearchQuery(params);
    ctx.log.debug('searchStudies', { paramKeys: Object.keys(q) });
    return this.fetchJson<PagedStudiesResponse>('/studies', q, ctx);
  }

  /** Fetch a single study by NCT ID. */
  getStudy(nctId: string, ctx: Context): Promise<Study> {
    ctx.log.debug('getStudy', { nctId });
    return this.fetchJson<Study>(`/studies/${encodeURIComponent(nctId)}`, {}, ctx);
  }

  /** Fetch multiple studies by NCT IDs in a single request. Returns identification and results section data. */
  async getStudiesBatch(nctIds: string[], ctx: Context): Promise<Study[]> {
    ctx.log.debug('getStudiesBatch', { count: nctIds.length });
    const response = await this.searchStudies(
      {
        filterIds: nctIds,
        fields: ['NCTId', 'BriefTitle', 'HasResults', 'ResultsSection'],
        pageSize: nctIds.length,
        // ID-targeted lookups must never filter the caller's selection.
        includeUnknownEnrollment: true,
      },
      ctx,
    );
    return response.studies;
  }

  /** Get field definitions (metadata tree) from the data model. */
  getMetadata(includeIndexedOnly: boolean, ctx: Context): Promise<FieldNode[]> {
    ctx.log.debug('getMetadata', { includeIndexedOnly });
    const params: Record<string, string> = {};
    if (includeIndexedOnly) params.includeIndexedOnly = 'true';
    return this.fetchJson<FieldNode[]>('/studies/metadata', params, ctx, { jsonFormat: false });
  }

  /** Get field value statistics for the specified fields. */
  async getFieldValues(fields: string[], ctx: Context): Promise<FieldValueStats[]> {
    ctx.log.debug('getFieldValues', { fields });
    if (this.validateFieldsLocally) {
      await this.validateFields(fields, ctx);
    }
    try {
      return await this.fetchJson<FieldValueStats[]>(
        '/stats/field/values',
        { fields: fields.join('|') },
        ctx,
        { jsonFormat: false },
      );
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        // Upstream reports only the first bad name ("Unknown piece name of field
        // path: X"); extract X so we blame only that field. When multi-field
        // requests fail, other inputs may also be bad — upstream doesn't say,
        // so we note that in the error text.
        const match = err.message.match(/Unknown piece name of field path:\s*(\S+)/i);
        const badName = match?.[1];
        const message = badName
          ? fields.length > 1 && !fields.every((f) => f === badName)
            ? `Invalid field name: '${badName}'. Other submitted fields (${fields
                .filter((f) => f !== badName)
                .join(
                  ', ',
                )}) may also be invalid — upstream reports only the first offender. Re-run without '${badName}' to verify the rest.`
            : `Invalid field name: '${badName}'.`
          : `Invalid field name(s): ${fields.join(', ')}.`;
        throw validationError(
          `${message} Use PascalCase piece names like OverallStatus, Phase, StudyType, InterventionType, LeadSponsorClass, Sex, StdAge. Call clinicaltrials_get_field_definitions to browse the full field tree.`,
          { reason: 'field_invalid', ...ctx.recoveryFor('field_invalid') },
        );
      }
      throw err;
    }
  }

  /** Search the field model by keyword, returning ranked matches with paths and types. */
  async searchFieldDefinitions(
    query: string,
    limit: number,
    ctx: Context,
  ): Promise<FieldIndexEntry[]> {
    ctx.log.debug('searchFieldDefinitions', { query, limit });
    const { entries } = await this.getFieldIndex(ctx);
    return searchFields(query, entries, limit);
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  /** Lazy-load and memoize the flattened field index from /studies/metadata. */
  private getFieldIndex(
    ctx: Context,
  ): Promise<{ entries: FieldIndexEntry[]; pieceSet: Set<string> }> {
    if (!this.fieldIndexPromise) {
      this.fieldIndexPromise = (async () => {
        const tree = await this.getMetadata(false, ctx);
        const entries = flattenMetadata(tree);
        const pieceSet = new Set(entries.map((e) => e.piece));
        ctx.log.debug('Field index built', { entryCount: entries.length });
        return { entries, pieceSet };
      })().catch((err) => {
        // Reset on failure so the next call can retry the metadata fetch
        this.fieldIndexPromise = undefined;
        throw err;
      });
    }
    return this.fieldIndexPromise;
  }

  /** Reject invalid field names locally with did-you-mean suggestions. */
  private async validateFields(fields: string[], ctx: Context): Promise<void> {
    let entries: FieldIndexEntry[];
    let pieceSet: Set<string>;
    try {
      ({ entries, pieceSet } = await this.getFieldIndex(ctx));
    } catch (err) {
      // Fail open — if the metadata index can't be built, fall through to the
      // upstream API and let its error handling surface any problem. Worst case,
      // the agent gets the same error it would have without pre-validation.
      ctx.log.warning('Field validation skipped — metadata unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const invalid = fields.filter((f) => !pieceSet.has(f));
    if (invalid.length === 0) return;

    const suggestions: Record<string, string[]> = {};
    for (const f of invalid) {
      const near = nearestPieces(f, entries, 3);
      if (near.length > 0) suggestions[f] = near;
    }

    const header =
      invalid.length === 1
        ? `Invalid field name: '${invalid[0]}'.`
        : `Invalid field names: ${invalid.map((f) => `'${f}'`).join(', ')}.`;
    const hintParts = Object.entries(suggestions).map(
      ([f, near]) => `'${f}' — did you mean ${near.map((p) => `'${p}'`).join(', ')}?`,
    );
    const message = hintParts.length > 0 ? `${header} ${hintParts.join(' ')}` : header;

    throw validationError(message, {
      reason: 'field_invalid',
      invalid,
      ...(Object.keys(suggestions).length > 0 ? { suggestions } : {}),
      ...ctx.recoveryFor('field_invalid'),
    });
  }

  private buildSearchQuery(params: SearchParams): Record<string, string> {
    const q: Record<string, string> = {};
    if (params.queryTerm) q['query.term'] = params.queryTerm;
    if (params.queryCond) q['query.cond'] = params.queryCond;
    if (params.queryIntr) q['query.intr'] = params.queryIntr;
    if (params.queryLocn) q['query.locn'] = params.queryLocn;
    if (params.querySpons) q['query.spons'] = params.querySpons;
    if (params.queryTitles) q['query.titles'] = params.queryTitles;
    if (params.queryOutc) q['query.outc'] = params.queryOutc;
    if (params.filterOverallStatus?.length)
      q['filter.overallStatus'] = params.filterOverallStatus.join('|');
    if (params.filterGeo) q['filter.geo'] = params.filterGeo;
    if (params.filterIds?.length) q['filter.ids'] = params.filterIds.join('|');
    const advancedParts: string[] = [];
    if (params.filterAdvanced) advancedParts.push(params.filterAdvanced);
    if (!params.includeUnknownEnrollment) advancedParts.push(ENROLLMENT_SENTINEL_FILTER);
    if (advancedParts.length > 0) {
      q['filter.advanced'] =
        advancedParts.length === 1
          ? advancedParts.join('')
          : advancedParts.map((p) => `(${p})`).join(' AND ');
    }
    if (params.fields?.length) q.fields = params.fields.join('|');
    if (params.sort) q.sort = params.sort;
    if (params.countTotal !== undefined) q.countTotal = String(params.countTotal);
    if (params.pageSize !== undefined)
      q.pageSize = String(Math.min(params.pageSize, this.maxPageSize));
    if (params.pageToken) q.pageToken = params.pageToken;
    return q;
  }

  private async throttle(): Promise<void> {
    const wait = MIN_INTERVAL_MS - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async fetchJson<T>(
    path: string,
    params: Record<string, string>,
    ctx: Context,
    { jsonFormat = true }: { jsonFormat?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (jsonFormat) url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }

    let lastError: unknown;
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (ctx.signal.aborted) throw new Error('Request cancelled');

      if (attempt > 0) {
        const base = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
        const delay = base * (0.75 + 0.5 * Math.random());
        ctx.log.debug('Retrying', {
          attempt,
          delay: Math.round(delay),
          path,
          lastStatus,
        });
        await new Promise((r) => setTimeout(r, delay));
      }

      await this.throttle();

      try {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
        const res = await fetch(url, {
          signal,
          headers: { Accept: 'application/json' },
        });

        if (res.ok) {
          const ct = res.headers.get('content-type') ?? '';
          if (!ct.includes('json')) {
            const text = await res.text();
            if (text.includes('<html') || text.includes('<!DOCTYPE')) {
              lastError = new Error('API returned HTML instead of JSON');
              continue;
            }
            return JSON.parse(text) as T;
          }
          return (await res.json()) as T;
        }

        if (res.status === 404) {
          if (path.startsWith('/studies/')) {
            const id = path.split('/').pop() ?? path;
            throw notFound(`Study ${id} not found`, {
              reason: 'study_not_found',
              ...ctx.recoveryFor('study_not_found'),
            });
          }
          // Non-/studies/ endpoints (e.g. /stats/field/values) — surface the
          // upstream body so callers can extract specific offenders instead of
          // getting a generic "not found" that loses which input was bad.
          const text = (await res.text()).trim();
          throw notFound(text || `Not found: ${path}`);
        }
        if (res.status === 400) {
          const text = await res.text();
          if (text.includes('contains invalid field name')) {
            const match = text.match(/invalid field name: ['"]([^'"]+)['"]/);
            const offender = match
              ? ` '${match[1]}' is likely a module name — use one of its piece names instead (e.g., DesignPrimaryPurpose, DesignInterventionModel, LeadSponsorName).`
              : ' Use PascalCase piece names (e.g., DesignPrimaryPurpose, DesignInterventionModel, LeadSponsorName), not module names.';
            throw validationError(
              `${text.trim()}${offender} Call clinicaltrials_get_field_definitions to browse valid piece names.`,
              { reason: 'field_invalid', ...ctx.recoveryFor('field_invalid') },
            );
          }
          if (text.includes('incorrect format')) {
            if (path.startsWith('/studies/')) {
              const id = path.split('/').pop() ?? path;
              throw notFound(
                `Study ${id} not found. Verify the NCT ID exists on ClinicalTrials.gov.`,
                { reason: 'study_not_found', ...ctx.recoveryFor('study_not_found') },
              );
            }
            // filter.ids rejection — the API may reject IDs that match the
            // regex but don't exist (e.g. NCT00000000). Surface the actual
            // IDs so the caller knows which ones failed.
            const ids = params['filter.ids'];
            if (ids) {
              const idList = ids.split('|').join(', ');
              throw notFound(
                `Study ID(s) not found or rejected by API: ${idList}. Verify the NCT IDs exist on ClinicalTrials.gov.`,
                { reason: 'ids_not_found', ...ctx.recoveryFor('ids_not_found') },
              );
            }
            throw validationError(`Invalid request format. API response: ${text}`);
          }
          throw validationError(text || `Bad request: ${path}`);
        }

        if (RETRYABLE_STATUS.has(res.status)) {
          lastError = new Error(`HTTP ${res.status}`);
          lastStatus = res.status;
          continue;
        }

        throw await httpErrorFromResponse(res, { service: 'ClinicalTrials.gov' });
      } catch (err) {
        if (err instanceof McpError) throw err;
        const name = (err as Error).name ?? '';
        const code = (err as NodeJS.ErrnoException).code;
        if (
          name === 'AbortError' ||
          name === 'TimeoutError' ||
          code === 'ECONNRESET' ||
          code === 'ETIMEDOUT'
        ) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    if (lastStatus === 429) {
      throw rateLimited(`Rate limited by ClinicalTrials.gov after ${this.maxRetries} retries`, {
        path,
        lastError: String(lastError),
        reason: 'rate_limited',
        ...ctx.recoveryFor('rate_limited'),
      });
    }
    throw serviceUnavailable('ClinicalTrials.gov API unavailable after retries', {
      path,
      lastError: String(lastError),
      ...(lastStatus != null ? { lastStatus } : {}),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Init / Accessor                                                    */
/* ------------------------------------------------------------------ */

let _service: ClinicalTrialsService | undefined;

/** Initialize the ClinicalTrials service. Call from createApp setup(). */
export function initClinicalTrialsService(): void {
  _service = new ClinicalTrialsService(getServerConfig());
}

/** Get the initialized ClinicalTrials service instance. */
export function getClinicalTrialsService(): ClinicalTrialsService {
  if (!_service)
    throw new Error(
      'ClinicalTrialsService not initialized — call initClinicalTrialsService() in setup()',
    );
  return _service;
}
