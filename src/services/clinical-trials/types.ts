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
  /**
   * Include studies whose `EnrollmentCount` is the upstream "unknown" sentinel
   * (`99999999`). Default behavior excludes them — the sentinel pollutes
   * `RANGE[N, MAX]` queries and `EnrollmentCount:desc` sorts. Set true to opt
   * out of the filter (e.g. when matching by eligibility, not enrollment).
   */
  includeUnknownEnrollment?: boolean | undefined;
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

/** A `{ date, type }` pair, where `type` is the ACTUAL/ESTIMATED qualifier. */
export interface DateStruct {
  date?: string;
  type?: string;
}

/** An identifier with its issuing-registry provenance — `orgStudyIdInfo`, `secondaryIdInfos[]`. */
export interface StudyIdInfo {
  domain?: string;
  id?: string;
  link?: string;
  type?: string;
}

/** A study contact — central, per-site, or results point of contact. */
export interface StudyContact {
  email?: string;
  name?: string;
  phone?: string;
  phoneExt?: string;
  role?: string;
}

/** Location from a study's contactsLocationsModule. */
export interface StudyLocation {
  city?: string;
  contacts?: StudyContact[];
  country?: string;
  facility?: string;
  geoPoint?: { lat: number; lon: number };
  state?: string;
  status?: string;
  zip?: string;
}

/** MeSH-normalized browse module from derivedSection. */
export interface BrowseModule {
  ancestors?: Array<{ id?: string; term?: string }>;
  browseBranches?: Array<{ abbrev?: string; name?: string }>;
  browseLeaves?: Array<{ asFound?: string; id?: string; name?: string; relevance?: string }>;
  meshes?: Array<{ id?: string; term?: string }>;
}

/** A study outcome measure declared in the protocol (not the posted results). */
export interface ProtocolOutcome {
  description?: string;
  measure?: string;
  timeFrame?: string;
}

/** Typed subset of the raw study response for accessing common nested fields. */
export interface RawStudyShape {
  annotationSection?: {
    annotationModule?: {
      unpostedAnnotation?: {
        unpostedEvents?: Array<{ date?: string; dateUnknown?: boolean; type?: string }>;
        unpostedResponsibleParty?: string;
      };
      violationAnnotation?: {
        violationEvents?: Array<{
          creationDate?: string;
          dateUnknown?: boolean;
          description?: string;
          issuedDate?: string;
          postedDate?: string;
          releaseDate?: string;
          resetDate?: string;
          type?: string;
        }>;
      };
    };
  };
  derivedSection?: {
    conditionBrowseModule?: BrowseModule;
    interventionBrowseModule?: BrowseModule;
    miscInfoModule?: {
      removedCountries?: string[];
      submissionTracking?: {
        estimatedResultsFirstSubmitDate?: string;
        firstMcpInfo?: { postDateStruct?: DateStruct };
        submissionInfos?: Array<{
          mcpReleaseN?: number;
          releaseDate?: string;
          resetDate?: string;
          unreleaseDate?: string;
          unreleaseDateUnknown?: boolean;
        }>;
      };
      versionHolder?: string;
    };
  };
  documentSection?: {
    largeDocumentModule?: {
      largeDocs?: Array<{
        date?: string;
        filename?: string;
        hasIcf?: boolean;
        hasProtocol?: boolean;
        hasSap?: boolean;
        label?: string;
        size?: number;
        typeAbbrev?: string;
        uploadDate?: string;
      }>;
      noSap?: boolean;
    };
  };
  hasResults?: boolean;
  protocolSection?: {
    armsInterventionsModule?: {
      armGroups?: Array<{
        description?: string;
        interventionNames?: string[];
        label?: string;
        type?: string;
      }>;
      interventions?: Array<{
        armGroupLabels?: string[];
        description?: string;
        name?: string;
        otherNames?: string[];
        type?: string;
      }>;
    };
    conditionsModule?: { conditions?: string[]; keywords?: string[] };
    contactsLocationsModule?: {
      centralContacts?: StudyContact[];
      locations?: StudyLocation[];
      overallOfficials?: Array<{ affiliation?: string; name?: string; role?: string }>;
    };
    descriptionModule?: { briefSummary?: string; detailedDescription?: string };
    designModule?: {
      bioSpec?: { description?: string; retention?: string };
      designInfo?: {
        allocation?: string;
        interventionModel?: string;
        interventionModelDescription?: string;
        maskingInfo?: { maskingDescription?: string; masking?: string; whoMasked?: string[] };
        observationalModel?: string;
        primaryPurpose?: string;
        timePerspective?: string;
      };
      enrollmentInfo?: { count?: number; type?: string };
      nPtrsToThisExpAccNctId?: number;
      patientRegistry?: boolean;
      phases?: string[];
      studyType?: string;
      targetDuration?: string;
    };
    eligibilityModule?: {
      eligibilityCriteria?: string;
      genderBased?: boolean;
      genderDescription?: string;
      healthyVolunteers?: boolean;
      maximumAge?: string;
      minimumAge?: string;
      samplingMethod?: string;
      sex?: string;
      stdAges?: string[];
      studyPopulation?: string;
    };
    identificationModule?: {
      acronym?: string;
      briefTitle?: string;
      nctId?: string;
      nctIdAliases?: string[];
      officialTitle?: string;
      orgStudyIdInfo?: StudyIdInfo;
      organization?: { class?: string; fullName?: string };
      secondaryIdInfos?: StudyIdInfo[];
    };
    ipdSharingStatementModule?: {
      accessCriteria?: string;
      description?: string;
      infoTypes?: string[];
      ipdSharing?: string;
      timeFrame?: string;
      url?: string;
    };
    outcomesModule?: {
      otherOutcomes?: ProtocolOutcome[];
      primaryOutcomes?: ProtocolOutcome[];
      secondaryOutcomes?: ProtocolOutcome[];
    };
    oversightModule?: {
      isFdaRegulatedDevice?: boolean;
      isFdaRegulatedDrug?: boolean;
      isPpsd?: boolean;
      isUnapprovedDevice?: boolean;
      isUsExport?: boolean;
      oversightHasDmc?: boolean;
    };
    referencesModule?: {
      availIpds?: Array<{ comment?: string; id?: string; type?: string; url?: string }>;
      references?: Array<{
        citation?: string;
        pmid?: string;
        retractions?: Array<{ pmid?: string; source?: string }>;
        type?: string;
      }>;
      seeAlsoLinks?: Array<{ label?: string; url?: string }>;
    };
    sponsorCollaboratorsModule?: {
      collaborators?: Array<{ class?: string; name?: string }>;
      leadSponsor?: { class?: string; name?: string };
      responsibleParty?: {
        investigatorAffiliation?: string;
        investigatorFullName?: string;
        investigatorTitle?: string;
        oldNameTitle?: string;
        oldOrganization?: string;
        type?: string;
      };
    };
    statusModule?: {
      completionDateStruct?: DateStruct;
      dispFirstPostDateStruct?: DateStruct;
      dispFirstSubmitDate?: string;
      dispFirstSubmitQcDate?: string;
      expandedAccessInfo?: {
        hasExpandedAccess?: boolean;
        nctId?: string;
        statusForNctId?: string;
      };
      lastKnownStatus?: string;
      lastUpdatePostDateStruct?: DateStruct;
      lastUpdateSubmitDate?: string;
      overallStatus?: string;
      primaryCompletionDateStruct?: DateStruct;
      resultsFirstPostDateStruct?: DateStruct;
      resultsFirstSubmitDate?: string;
      resultsFirstSubmitQcDate?: string;
      startDateStruct?: DateStruct;
      statusVerifiedDate?: string;
      studyFirstPostDateStruct?: DateStruct;
      studyFirstSubmitDate?: string;
      studyFirstSubmitQcDate?: string;
      whyStopped?: string;
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
  /**
   * Whether the field is multi-valued (array type in the data model, e.g. `Phase`,
   * `Condition`). A single study can carry several values, so per-value
   * `studiesCount` buckets sum above the study total. Derived from the metadata
   * node `type` ending in `[]`; absent when local validation is disabled.
   */
  multiValued?: boolean;
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
