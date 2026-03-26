/**
 * @fileoverview Types for the ClinicalTrials.gov API responses and service parameters.
 * @module services/clinical-trials/types
 */

/** Parameters for the ClinicalTrials.gov study search. */
export interface SearchParams {
  queryTerm?: string | undefined;
  queryCond?: string | undefined;
  queryIntr?: string | undefined;
  queryLocn?: string | undefined;
  querySpons?: string | undefined;
  queryTitles?: string | undefined;
  queryOutc?: string | undefined;
  filterOverallStatus?: string[] | undefined;
  filterGeo?: string | undefined;
  filterIds?: string[] | undefined;
  filterAdvanced?: string | undefined;
  fields?: string[] | undefined;
  sort?: string | undefined;
  countTotal?: boolean | undefined;
  pageSize?: number | undefined;
  pageToken?: string | undefined;
}

/** A study record from the API. Shape depends on fields selection. */
export type Study = Record<string, unknown>;

/** Paginated studies response from GET /studies. */
export interface PagedStudiesResponse {
  studies: Study[];
  totalCount?: number;
  nextPageToken?: string;
}

/** Field value statistics from GET /stats/field/values. */
export interface FieldValueStats {
  type: string;
  piece: string;
  field: string;
  missingStudiesCount: number;
  uniqueValuesCount: number;
  topValues: Array<{ value: string; studiesCount: number }>;
}
