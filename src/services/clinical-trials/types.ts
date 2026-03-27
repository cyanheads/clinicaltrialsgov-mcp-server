/**
 * @fileoverview Types for the ClinicalTrials.gov API responses and service parameters.
 * @module services/clinical-trials/types
 */

/** Parameters for the ClinicalTrials.gov study search. */
export interface SearchParams {
  countTotal?: boolean | undefined;
  fields?: string[] | undefined;
  filterAdvanced?: string | undefined;
  filterGeo?: string | undefined;
  filterIds?: string[] | undefined;
  filterOverallStatus?: string[] | undefined;
  pageSize?: number | undefined;
  pageToken?: string | undefined;
  queryCond?: string | undefined;
  queryIntr?: string | undefined;
  queryLocn?: string | undefined;
  queryOutc?: string | undefined;
  querySpons?: string | undefined;
  queryTerm?: string | undefined;
  queryTitles?: string | undefined;
  sort?: string | undefined;
}

/** A study record from the API. Shape depends on fields selection. */
export type Study = Record<string, unknown>;

/** Location from a study's contactsLocationsModule. */
export interface StudyLocation {
  city?: string;
  country?: string;
  facility?: string;
  state?: string;
  status?: string;
}

/** Typed subset of the raw study response for accessing common nested fields. */
export interface RawStudyShape {
  hasResults?: boolean;
  protocolSection?: {
    conditionsModule?: { conditions?: string[] };
    contactsLocationsModule?: { locations?: StudyLocation[] };
    descriptionModule?: { briefSummary?: string };
    designModule?: {
      enrollmentInfo?: { count?: number };
      phases?: string[];
    };
    eligibilityModule?: {
      healthyVolunteers?: boolean;
      maximumAge?: string;
      minimumAge?: string;
      sex?: string;
    };
    identificationModule?: { briefTitle?: string; nctId?: string };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    statusModule?: { overallStatus?: string };
  };
  resultsSection?: Record<string, Record<string, unknown>>;
}

/** Paginated studies response from GET /studies. */
export interface PagedStudiesResponse {
  nextPageToken?: string;
  studies: Study[];
  totalCount?: number;
}

/** Field value statistics from GET /stats/field/values. */
export interface FieldValueStats {
  field: string;
  missingStudiesCount: number;
  piece: string;
  topValues: Array<{ value: string; studiesCount: number }>;
  type: string;
  uniqueValuesCount: number;
}

/** Enum value with optional legacy display name from GET /studies/enums. */
export interface EnumValue {
  legacyValue?: string;
  value: string;
}

/** Enum type definition from GET /studies/enums. */
export interface EnumInfo {
  pieces: string[];
  type: string;
  values: EnumValue[];
}

/** Field node from GET /studies/metadata. */
export interface FieldNode {
  children?: FieldNode[];
  description?: string;
  isEnum?: boolean;
  name: string;
  piece?: string;
  sourceType?: string;
  type?: string;
}
