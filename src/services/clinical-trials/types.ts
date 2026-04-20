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
  derivedSection?: {
    conditionBrowseModule?: { meshes?: Array<{ id?: string; term?: string }> };
    interventionBrowseModule?: { meshes?: Array<{ id?: string; term?: string }> };
    miscInfoModule?: { versionHolder?: string };
  };
  hasResults?: boolean;
  protocolSection?: {
    armsInterventionsModule?: {
      armGroups?: Array<{ description?: string; label?: string; type?: string }>;
      interventions?: Array<{ description?: string; name?: string; type?: string }>;
    };
    conditionsModule?: { conditions?: string[]; keywords?: string[] };
    contactsLocationsModule?: {
      centralContacts?: Array<{ email?: string; name?: string; phone?: string; role?: string }>;
      locations?: StudyLocation[];
    };
    descriptionModule?: { briefSummary?: string; detailedDescription?: string };
    designModule?: {
      designInfo?: {
        allocation?: string;
        interventionModel?: string;
        maskingInfo?: { masking?: string };
        primaryPurpose?: string;
      };
      enrollmentInfo?: { count?: number; type?: string };
      phases?: string[];
      studyType?: string;
    };
    eligibilityModule?: {
      eligibilityCriteria?: string;
      healthyVolunteers?: boolean;
      maximumAge?: string;
      minimumAge?: string;
      sex?: string;
      stdAges?: string[];
    };
    identificationModule?: {
      acronym?: string;
      briefTitle?: string;
      nctId?: string;
      officialTitle?: string;
      orgStudyIdInfo?: { id?: string };
      organization?: { fullName?: string };
      secondaryIdInfos?: Array<{ id?: string; type?: string }>;
    };
    ipdSharingStatementModule?: {
      description?: string;
      ipdSharing?: string;
      timeFrame?: string;
    };
    outcomesModule?: {
      otherOutcomes?: Array<{ description?: string; measure?: string; timeFrame?: string }>;
      primaryOutcomes?: Array<{ description?: string; measure?: string; timeFrame?: string }>;
      secondaryOutcomes?: Array<{ description?: string; measure?: string; timeFrame?: string }>;
    };
    oversightModule?: {
      isFdaRegulatedDevice?: boolean;
      isFdaRegulatedDrug?: boolean;
      oversightHasDmc?: boolean;
    };
    referencesModule?: {
      references?: Array<{ citation?: string; pmid?: string; type?: string }>;
      seeAlsoLinks?: Array<{ label?: string; url?: string }>;
    };
    sponsorCollaboratorsModule?: {
      collaborators?: Array<{ class?: string; name?: string }>;
      leadSponsor?: { class?: string; name?: string };
    };
    statusModule?: {
      completionDateStruct?: { date?: string; type?: string };
      lastUpdatePostDateStruct?: { date?: string; type?: string };
      lastUpdateSubmitDate?: string;
      overallStatus?: string;
      primaryCompletionDateStruct?: { date?: string; type?: string };
      startDateStruct?: { date?: string; type?: string };
      statusVerifiedDate?: string;
      studyFirstPostDateStruct?: { date?: string; type?: string };
      studyFirstSubmitDate?: string;
    };
  };
  resultsSection?: Record<string, Record<string, unknown>>;
}

/** Paginated studies response from GET /studies. */
export interface PagedStudiesResponse {
  nextPageToken?: string;
  studies: Study[];
  totalCount?: number;
}

/**
 * Field value statistics from GET /stats/field/values.
 *
 * `topValues` and `uniqueValuesCount` are omitted for BOOLEAN fields, which
 * return `trueCount`/`falseCount` instead.
 */
export interface FieldValueStats {
  falseCount?: number;
  field: string;
  missingStudiesCount: number;
  piece: string;
  topValues?: Array<{ value: string; studiesCount: number }>;
  trueCount?: number;
  type: string;
  uniqueValuesCount?: number;
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
