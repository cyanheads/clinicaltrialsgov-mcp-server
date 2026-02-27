/**
 * @fileoverview Provider interface for ClinicalTrials.gov API operations.
 * Defines the contract for fetching and querying clinical trial data.
 *
 * @module src/services/clinical-trials-gov/core/IClinicalTrialsProvider
 */

import type { RequestContext } from '@/utils/index.js';
import type { PagedStudies, Study } from '../types.js';

/**
 * Query parameters for listing clinical trials.
 */
export interface ListStudiesParams {
  /**
   * General search query (maps to `query.term` — full-text search across all fields).
   */
  query?: string;

  /**
   * Condition-specific search query (maps to `query.cond` — searches only condition/synonym fields).
   */
  conditionQuery?: string;

  /**
   * Intervention-specific search query (maps to `query.intr` — searches intervention/treatment fields).
   */
  interventionQuery?: string;

  /**
   * Sponsor-specific search query (maps to `query.spons` — searches sponsor name fields).
   */
  sponsorQuery?: string;

  /**
   * Location-specific search query (maps to `query.locn` — searches location/facility fields).
   */
  locationQuery?: string;

  /**
   * Filter expression for advanced querying (maps to `filter.advanced`).
   */
  filter?: string;

  /**
   * Comma-separated list of overall statuses to filter by (maps to `filter.overallStatus`).
   * Example: 'RECRUITING,NOT_YET_RECRUITING'
   */
  statusFilter?: string;

  /**
   * Comma-separated list of phases to filter by (maps to `filter.phase`).
   * Example: 'PHASE1,PHASE2'
   */
  phaseFilter?: string;

  /**
   * Geographic proximity filter (maps to `filter.geo`).
   * Format: `distance(lat,lon,distance)` where distance is in miles.
   */
  geoFilter?: string;

  /**
   * Maximum number of results to return.
   * @default 10
   */
  pageSize?: number;

  /**
   * Page token for pagination.
   */
  pageToken?: string;

  /**
   * Sort order specification.
   */
  sort?: string;

  /**
   * Specific fields to return (reduces payload size).
   * Example: ['NCTId', 'BriefTitle', 'OverallStatus']
   */
  fields?: string[];
}

/**
 * Provider interface for ClinicalTrials.gov API operations.
 * Implementations handle HTTP requests, caching, and data transformation.
 */
export interface IClinicalTrialsProvider {
  /**
   * Fetches a single study by its NCT identifier.
   *
   * @param nctId - The NCT identifier (e.g., 'NCT12345678')
   * @returns The full study record
   * @throws {McpError} If the study is not found or API request fails
   */
  fetchStudy(nctId: string, context: RequestContext): Promise<Study>;

  /**
   * Lists studies matching the provided query parameters.
   *
   * @param params - Query parameters for filtering and pagination
   * @returns Paginated list of studies with metadata
   * @throws {McpError} If the API request fails
   */
  listStudies(
    params: ListStudiesParams,
    context: RequestContext,
  ): Promise<PagedStudies>;

  /**
   * Fetches valid field values and study counts for a given field name.
   * Wraps the /stats/fieldValues/{fieldName} endpoint.
   *
   * @param fieldName - The API field name (e.g., 'OverallStatus', 'Phase', 'InterventionType')
   * @returns Array of field values with study counts
   * @throws {McpError} If the API request fails or field name is invalid
   */
  getFieldValues(
    fieldName: string,
    context: RequestContext,
  ): Promise<Array<{ value: string; count: number }>>;

  /**
   * Checks connectivity to the ClinicalTrials.gov API.
   *
   * @returns true if the API is reachable and responding
   * @throws {McpError} If the API is unreachable
   */
  healthCheck(context: RequestContext): Promise<boolean>;
}
