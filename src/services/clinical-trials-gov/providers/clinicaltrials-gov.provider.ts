/**
 * @fileoverview ClinicalTrials.gov API provider implementation.
 * Handles HTTP requests, response validation, and optional filesystem backups.
 *
 * @module src/services/clinical-trials-gov/providers/clinicaltrials-gov.provider
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inject, injectable } from 'tsyringe';

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
  type StudyMetadata,
} from '../types.js';

const BASE_URL = 'https://clinicaltrials.gov/api/v2';

/**
 * Implementation of IClinicalTrialsProvider for the ClinicalTrials.gov API.
 * Provides methods to fetch clinical trial data with optional filesystem backups.
 */
@injectable()
export class ClinicalTrialsGovProvider implements IClinicalTrialsProvider {
  constructor(
    @inject('RequestContext') private readonly context: RequestContext,
  ) {}

  /**
   * @inheritdoc
   */
  async fetchStudy(nctId: string): Promise<Study> {
    const url = `${BASE_URL}/studies/${nctId}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `study_${nctId}_${timestamp}.json`;

    const data = await this.fetchAndBackup<unknown>(url, fileName);

    // Validate response with Zod
    const result = StudySchema.safeParse(data);
    if (!result.success) {
      logger.error('[API] Study validation failed', {
        ...this.context,
        nctId,
        errors: result.error.errors,
      });
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Invalid study data received from API',
        { nctId, validationErrors: result.error.errors },
      );
    }

    return result.data;
  }

  /**
   * @inheritdoc
   */
  async listStudies(params: ListStudiesParams): Promise<PagedStudies> {
    const queryParams = new URLSearchParams();

    if (params.query) {
      queryParams.set('query.term', params.query);
    }
    if (params.filter) {
      queryParams.set('filter.advanced', params.filter);
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

    // Always count total for better pagination
    queryParams.set('countTotal', 'true');

    const url = `${BASE_URL}/studies?${queryParams.toString()}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `studies_${timestamp}.json`;

    const data = await this.fetchAndBackup<unknown>(url, fileName);

    // Validate response with Zod
    const result = PagedStudiesSchema.safeParse(data);
    if (!result.success) {
      logger.error('[API] Studies list validation failed', {
        ...this.context,
        errors: result.error.errors,
      });
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Invalid studies data received from API',
        { validationErrors: result.error.errors },
      );
    }

    return result.data;
  }

  /**
   * @inheritdoc
   */
  async getStudyMetadata(nctId: string): Promise<StudyMetadata> {
    const url = `${BASE_URL}/studies/${nctId}?fields=NCTId,BriefTitle,OverallStatus,StartDate,CompletionDate,LastUpdatePostDate`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `metadata_${nctId}_${timestamp}.json`;

    const data = await this.fetchAndBackup<Study>(url, fileName);

    // Extract metadata from full study
    const metadata: StudyMetadata = {
      nctId: data.protocolSection?.identificationModule?.nctId ?? nctId,
      title:
        data.protocolSection?.identificationModule?.briefTitle ??
        data.protocolSection?.identificationModule?.officialTitle,
      status: data.protocolSection?.statusModule?.overallStatus,
      startDate: data.protocolSection?.statusModule?.startDateStruct?.date,
      completionDate:
        data.protocolSection?.statusModule?.completionDateStruct?.date,
      lastUpdateDate: data.protocolSection?.statusModule?.lastKnownStatus,
    };

    return metadata;
  }

  /**
   * @inheritdoc
   */
  async getApiStats(): Promise<{
    totalStudies: number;
    lastUpdated: string;
    version: string;
  }> {
    const url = `${BASE_URL}/stats/size`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `stats_${timestamp}.json`;

    const data = await this.fetchAndBackup<{
      totalCount?: number;
      lastIndexed?: string;
      apiVersion?: string;
    }>(url, fileName);

    return {
      totalStudies: data.totalCount ?? 0,
      lastUpdated: data.lastIndexed ?? new Date().toISOString(),
      version: data.apiVersion ?? 'v2',
    };
  }

  /**
   * Generic fetch method that handles HTTP requests and optional filesystem backups.
   *
   * @param url - The full URL to fetch
   * @param fileName - The filename for backup storage
   * @returns The parsed JSON response
   * @throws {McpError} If the request fails or returns non-OK status
   */
  private async fetchAndBackup<T>(url: string, fileName: string): Promise<T> {
    logger.debug(`[API] Fetching from ${url}`, this.context);

    const response = await fetchWithTimeout(
      url,
      15000, // 15-second timeout for complex queries
      this.context,
      {
        headers: { Accept: 'application/json' },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(`[API] Error response: ${errorBody}`, this.context);

      const message =
        response.status === 404
          ? `Resource not found: ${errorBody}`
          : `API request failed with status ${response.status}: ${response.statusText}`;

      throw new McpError(JsonRpcErrorCode.ServiceUnavailable, message, {
        url,
        status: response.status,
        body: errorBody,
      });
    }

    const responseBody = await response.text();
    logger.debug('[API] Response received', {
      ...this.context,
      bodyLength: responseBody.length,
    });

    const data = JSON.parse(responseBody) as T;

    // Optional filesystem backup
    if (config.clinicalTrialsDataPath) {
      const filePath = path.join(config.clinicalTrialsDataPath, fileName);
      try {
        writeFileSync(filePath, JSON.stringify(data, null, 2));
        logger.debug(`[Backup] Wrote to ${filePath}`, this.context);
      } catch (error) {
        logger.error('[Backup] Failed to write file', {
          ...this.context,
          filePath,
          error,
        });
      }
    }

    return data;
  }
}
