/**
 * @fileoverview ClinicalTrials.gov API provider implementation.
 * Handles HTTP requests, response validation, and optional filesystem backups.
 *
 * @module src/services/clinical-trials-gov/providers/clinicaltrials-gov.provider
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../../config/index.js';
import { JsonRpcErrorCode, McpError } from '../../../types-global/errors.js';
import { logger, type RequestContext } from '../../../utils/index.js';
import { fetchWithTimeout } from '../../../utils/network/fetchWithTimeout.js';
import type {
  IClinicalTrialsProvider,
  ListStudiesParams,
} from '../core/IClinicalTrialsProvider.js';
import {
  PagedStudiesSchema,
  StudySchema,
  type PagedStudies,
  type Study,
} from '../types.js';

const BASE_URL = 'https://clinicaltrials.gov/api/v2';

/**
 * Implementation of IClinicalTrialsProvider for the ClinicalTrials.gov API.
 * Provides methods to fetch clinical trial data with optional filesystem backups.
 */
export class ClinicalTrialsGovProvider implements IClinicalTrialsProvider {
  /**
   * @inheritdoc
   */
  async fetchStudy(nctId: string, context: RequestContext): Promise<Study> {
    const url = `${BASE_URL}/studies/${nctId}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `study_${nctId}_${timestamp}.json`;

    const data = await this.fetchAndBackup<unknown>(url, fileName, context);

    // Validate response with Zod
    const result = StudySchema.safeParse(data);
    if (!result.success) {
      logger.error('[API] Study validation failed', {
        ...context,
        nctId,
        errors: result.error.issues,
      });
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Invalid study data received from API',
        { nctId, validationErrors: result.error.issues },
      );
    }

    return result.data;
  }

  /**
   * @inheritdoc
   */
  async listStudies(
    params: ListStudiesParams,
    context: RequestContext,
  ): Promise<PagedStudies> {
    const queryParams = new URLSearchParams();

    if (params.query) {
      queryParams.set('query.term', params.query);
    }
    if (params.conditionQuery) {
      queryParams.set('query.cond', params.conditionQuery);
    }
    if (params.interventionQuery) {
      queryParams.set('query.intr', params.interventionQuery);
    }
    if (params.sponsorQuery) {
      queryParams.set('query.spons', params.sponsorQuery);
    }
    if (params.locationQuery) {
      queryParams.set('query.locn', params.locationQuery);
    }

    // Build filter.advanced — merge user-supplied AREA[] expression with phase filter
    const advancedParts: string[] = [];
    if (params.filter) {
      advancedParts.push(params.filter);
    }
    if (params.phaseFilter) {
      const phases = params.phaseFilter.split(',');
      const phaseExpr =
        phases.length === 1
          ? `AREA[Phase]${phases[0]}`
          : `AREA[Phase](${phases.join(' OR ')})`;
      advancedParts.push(phaseExpr);
    }
    if (advancedParts.length > 0) {
      queryParams.set('filter.advanced', advancedParts.join(' AND '));
    }

    if (params.statusFilter) {
      queryParams.set('filter.overallStatus', params.statusFilter);
    }
    if (params.geoFilter) {
      queryParams.set('filter.geo', params.geoFilter);
    }

    if (params.pageSize) {
      queryParams.set('pageSize', String(params.pageSize));
    }
    if (params.pageToken) {
      queryParams.set('pageToken', params.pageToken);
    }
    if (params.sort) {
      queryParams.set('sort', params.sort);
    }

    // Field selection for payload optimization
    if (params.fields && params.fields.length > 0) {
      queryParams.set('fields', params.fields.join(','));
    }

    // Always count total for better pagination
    queryParams.set('countTotal', 'true');

    const url = `${BASE_URL}/studies?${queryParams.toString()}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `studies_${timestamp}.json`;

    const data = await this.fetchAndBackup<unknown>(url, fileName, context);

    // Validate response with Zod
    const result = PagedStudiesSchema.safeParse(data);
    if (!result.success) {
      logger.error('[API] Studies list validation failed', {
        ...context,
        errors: result.error.issues,
      });
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Invalid studies data received from API',
        { validationErrors: result.error.issues },
      );
    }

    return result.data;
  }

  /**
   * @inheritdoc
   */
  async getFieldValues(
    fieldName: string,
    context: RequestContext,
  ): Promise<Array<{ value: string; count: number }>> {
    const url = `${BASE_URL}/stats/fieldValues/${encodeURIComponent(fieldName)}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Sanitize fieldName for filesystem safety — strip anything that isn't alphanumeric
    const safeFieldName = fieldName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `fieldValues_${safeFieldName}_${timestamp}.json`;

    const data = await this.fetchAndBackup<{
      topValues?: Array<{ value?: string; studiesCount?: number }>;
    }>(url, fileName, context);

    // API returns { topValues: [{ value, studiesCount }], type, piece, field, ... }
    const topValues = data?.topValues;
    if (!Array.isArray(topValues)) {
      return [];
    }

    return topValues.map((item) => ({
      value: item.value ?? '',
      count: item.studiesCount ?? 0,
    }));
  }

  /**
   * @inheritdoc
   */
  async healthCheck(context: RequestContext): Promise<boolean> {
    const response = await fetchWithTimeout(
      `${BASE_URL}/version`,
      10_000,
      context,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    return response.ok;
  }

  /**
   * Generic fetch method that handles HTTP requests and optional filesystem backups.
   *
   * @param url - The full URL to fetch
   * @param fileName - The filename for backup storage
   * @returns The parsed JSON response
   * @throws {McpError} If the request fails, returns non-OK status, or response is not valid JSON
   */
  private async fetchAndBackup<T>(
    url: string,
    fileName: string,
    context: RequestContext,
  ): Promise<T> {
    logger.debug(`[API] Fetching from ${url}`, context);

    const response = await fetchWithTimeout(
      url,
      30_000, // 30-second timeout per API recommendations
      context,
      {
        headers: { Accept: 'application/json' },
        retryOn429: true,
      },
    );

    const responseBody = await response.text();
    logger.debug('[API] Response received', {
      ...context,
      bodyLength: responseBody.length,
    });

    let data: T;
    try {
      data = JSON.parse(responseBody) as T;
    } catch {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        'Malformed JSON response from API',
        { url, bodySnippet: responseBody.slice(0, 200) },
      );
    }

    // Optional filesystem backup (async — does not block the response)
    if (config.clinicalTrialsDataPath) {
      const filePath = path.join(config.clinicalTrialsDataPath, fileName);
      writeFile(filePath, JSON.stringify(data, null, 2)).catch((error) => {
        logger.error('[Backup] Failed to write file', {
          ...context,
          filePath,
          error,
        });
      });
    }

    return data;
  }
}
