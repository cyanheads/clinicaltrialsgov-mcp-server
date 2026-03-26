/**
 * @fileoverview ClinicalTrials.gov REST API v2 client with retry, rate limiting, and timeout.
 * @module services/clinical-trials/clinical-trials-service
 */

import { type Context } from "@cyanheads/mcp-ts-core";
import {
  McpError,
  notFound,
  validationError,
  serviceUnavailable,
} from "@cyanheads/mcp-ts-core/errors";
import { getServerConfig, type ServerConfig } from "@/config/server-config.js";
import type {
  SearchParams,
  PagedStudiesResponse,
  Study,
  FieldValueStats,
} from "./types.js";

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MIN_INTERVAL_MS = 1000;

export class ClinicalTrialsService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPageSize: number;
  private lastRequestAt = 0;

  constructor(config: ServerConfig) {
    this.baseUrl = config.apiBaseUrl;
    this.timeoutMs = config.requestTimeoutMs;
    this.maxPageSize = config.maxPageSize;
  }

  /** Search studies with query, filters, pagination, and field selection. */
  async searchStudies(
    params: SearchParams,
    ctx: Context,
  ): Promise<PagedStudiesResponse> {
    const q = this.buildSearchQuery(params);
    ctx.log.debug("searchStudies", { paramKeys: Object.keys(q) });
    return this.fetchJson<PagedStudiesResponse>("/studies", q, ctx);
  }

  /** Fetch a single study by NCT ID. */
  async getStudy(nctId: string, ctx: Context): Promise<Study> {
    ctx.log.debug("getStudy", { nctId });
    return this.fetchJson<Study>(
      `/studies/${encodeURIComponent(nctId)}`,
      {},
      ctx,
    );
  }

  /** Get field value statistics for the specified fields. */
  async getFieldValues(
    fields: string[],
    ctx: Context,
  ): Promise<FieldValueStats[]> {
    ctx.log.debug("getFieldValues", { fields });
    return this.fetchJson<FieldValueStats[]>(
      "/stats/field/values",
      { fields: fields.join("|") },
      ctx,
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  private buildSearchQuery(params: SearchParams): Record<string, string> {
    const q: Record<string, string> = {};
    if (params.queryTerm) q["query.term"] = params.queryTerm;
    if (params.queryCond) q["query.cond"] = params.queryCond;
    if (params.queryIntr) q["query.intr"] = params.queryIntr;
    if (params.queryLocn) q["query.locn"] = params.queryLocn;
    if (params.querySpons) q["query.spons"] = params.querySpons;
    if (params.queryTitles) q["query.titles"] = params.queryTitles;
    if (params.queryOutc) q["query.outc"] = params.queryOutc;
    if (params.filterOverallStatus?.length)
      q["filter.overallStatus"] = params.filterOverallStatus.join("|");
    if (params.filterGeo) q["filter.geo"] = params.filterGeo;
    if (params.filterIds?.length) q["filter.ids"] = params.filterIds.join("|");
    if (params.filterAdvanced) q["filter.advanced"] = params.filterAdvanced;
    if (params.fields?.length) q.fields = params.fields.join("|");
    if (params.sort) q.sort = params.sort;
    if (params.countTotal !== undefined)
      q.countTotal = String(params.countTotal);
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
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (ctx.signal.aborted) throw new Error("Request cancelled");

      if (attempt > 0) {
        const delay =
          Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 500;
        ctx.log.debug("Retrying", { attempt, delay: Math.round(delay), path });
        await new Promise((r) => setTimeout(r, delay));
      }

      await this.throttle();

      try {
        const signal = AbortSignal.any([
          ctx.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]);
        const res = await fetch(url, {
          signal,
          headers: { Accept: "application/json" },
        });

        if (res.ok) {
          const ct = res.headers.get("content-type") ?? "";
          if (!ct.includes("json")) {
            const text = await res.text();
            if (text.includes("<html") || text.includes("<!DOCTYPE")) {
              lastError = new Error("API returned HTML instead of JSON");
              continue;
            }
            return JSON.parse(text) as T;
          }
          return (await res.json()) as T;
        }

        if (res.status === 404) throw notFound(`Not found: ${path}`);
        if (res.status === 400) {
          const text = await res.text();
          throw validationError(text || `Bad request: ${path}`);
        }

        if (RETRYABLE_STATUS.has(res.status)) {
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }

        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      } catch (err) {
        if (err instanceof McpError) throw err;
        const name = (err as Error).name ?? "";
        const code = (err as NodeJS.ErrnoException).code;
        if (
          name === "AbortError" ||
          name === "TimeoutError" ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT"
        ) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw serviceUnavailable(
      "ClinicalTrials.gov API unavailable after retries",
      {
        path,
        lastError: String(lastError),
      },
    );
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
      "ClinicalTrialsService not initialized — call initClinicalTrialsService() in setup()",
    );
  return _service;
}
