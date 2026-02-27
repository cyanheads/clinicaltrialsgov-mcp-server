/**
 * @fileoverview Defines the TypeScript types for the ClinicalTrials.gov API.
 * These types are based on the API's OpenAPI specification and are used
 * throughout the server for type safety and data consistency.
 * @module src/services/clinical-trials-gov/types
 */

import { z } from 'zod';

/**
 * Zod schema for a single clinical study, mirroring the ClinicalTrials.gov API structure.
 * This provides runtime validation and serves as the single source of truth for the Study type.
 */
export const StudySchema = z
  .object({
    protocolSection: z
      .object({
        identificationModule: z
          .object({
            nctId: z.string(),
            orgStudyIdInfo: z
              .object({ id: z.string().optional() })
              .passthrough()
              .optional(),
            organization: z
              .object({
                fullName: z.string().optional(),
                class: z.string().optional(),
              })
              .passthrough()
              .optional(),
            briefTitle: z.string().optional(),
            officialTitle: z.string().optional(),
            acronym: z.string().optional(),
          })
          .passthrough()
          .optional(),
        statusModule: z
          .object({
            overallStatus: z.string().optional(),
            lastKnownStatus: z.string().optional(),
            studyFirstSubmitDate: z.string().optional(),
            studyFirstPostDateStruct: z
              .object({
                date: z.string().optional(),
                type: z.string().optional(),
              })
              .passthrough()
              .optional(),
            resultsFirstPostDateStruct: z
              .object({
                date: z.string().optional(),
                type: z.string().optional(),
              })
              .passthrough()
              .optional(),
            startDateStruct: z
              .object({
                date: z.string().optional(),
                type: z.string().optional(),
              })
              .passthrough()
              .optional(),
            primaryCompletionDateStruct: z
              .object({
                date: z.string().optional(),
                type: z.string().optional(),
              })
              .passthrough()
              .optional(),
            completionDateStruct: z
              .object({
                date: z.string().optional(),
                type: z.string().optional(),
              })
              .passthrough()
              .optional(),
            lastUpdatePostDateStruct: z
              .object({
                date: z.string().optional(),
                type: z.string().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        sponsorCollaboratorsModule: z
          .object({
            responsibleParty: z
              .object({ type: z.string().optional() })
              .passthrough()
              .optional(),
            leadSponsor: z
              .object({
                name: z.string().optional(),
                class: z.string().optional(),
              })
              .passthrough()
              .optional(),
            collaborators: z
              .array(
                z
                  .object({
                    name: z.string().optional(),
                    class: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        descriptionModule: z
          .object({
            briefSummary: z.string().optional(),
            detailedDescription: z.string().optional(),
          })
          .passthrough()
          .optional(),
        conditionsModule: z
          .object({
            conditions: z.array(z.string()).optional(),
            keywords: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
        armsInterventionsModule: z
          .object({
            arms: z
              .array(
                z
                  .object({
                    name: z.string().optional(),
                    type: z.string().optional(),
                    description: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            interventions: z
              .array(
                z
                  .object({
                    type: z.string().optional(),
                    name: z.string().optional(),
                    description: z.string().optional(),
                    armNames: z.array(z.string()).optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        designModule: z
          .object({
            studyType: z.string().optional(),
            phases: z.array(z.string()).optional(),
            enrollmentInfo: z
              .object({
                count: z.number().optional(),
                type: z.string().optional(),
              })
              .passthrough()
              .optional(),
            designInfo: z
              .object({
                allocation: z.string().optional(),
                interventionModel: z.string().optional(),
                primaryPurpose: z.string().optional(),
                maskingInfo: z
                  .object({ masking: z.string().optional() })
                  .passthrough()
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        eligibilityModule: z
          .object({
            eligibilityCriteria: z.string().optional(),
            healthyVolunteers: z.boolean().optional(),
            sex: z.string().optional(),
            minimumAge: z.string().optional(),
            maximumAge: z.string().optional(),
            stdAges: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
        contactsLocationsModule: z
          .object({
            centralContacts: z
              .array(
                z
                  .object({
                    name: z.string().optional(),
                    role: z.string().optional(),
                    phone: z.string().optional(),
                    email: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            overallOfficials: z
              .array(
                z
                  .object({
                    name: z.string().optional(),
                    affiliation: z.string().optional(),
                    role: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            locations: z
              .array(
                z
                  .object({
                    facility: z.string().optional(),
                    city: z.string().optional(),
                    state: z.string().optional(),
                    zip: z.string().optional(),
                    country: z.string().optional(),
                    geoPoint: z
                      .object({
                        lat: z.number().optional(),
                        lon: z.number().optional(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        oversightModule: z
          .object({
            oversightHasDmc: z.boolean().optional(),
            isFdaRegulatedDrug: z.boolean().optional(),
            isFdaRegulatedDevice: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        outcomesModule: z
          .object({
            primaryOutcomes: z
              .array(
                z
                  .object({
                    measure: z.string().optional(),
                    description: z.string().optional(),
                    timeFrame: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            secondaryOutcomes: z
              .array(
                z
                  .object({
                    measure: z.string().optional(),
                    description: z.string().optional(),
                    timeFrame: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            otherOutcomes: z
              .array(
                z
                  .object({
                    measure: z.string().optional(),
                    description: z.string().optional(),
                    timeFrame: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        referencesModule: z
          .object({
            references: z
              .array(
                z
                  .object({
                    pmid: z.string().optional(),
                    type: z.string().optional(),
                    citation: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        ipdSharingStatementModule: z
          .object({
            ipdSharing: z.string().optional(),
            description: z.string().optional(),
            url: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    derivedSection: z
      .object({
        miscInfoModule: z
          .object({
            versionHolder: z.string().optional(),
          })
          .passthrough()
          .optional(),
        conditionBrowseModule: z
          .object({
            meshes: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    term: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            ancestors: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    term: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            browseLeaves: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    name: z.string().optional(),
                    asFound: z.string().optional(),
                    relevance: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            browseBranches: z
              .array(
                z
                  .object({
                    abbrev: z.string().optional(),
                    name: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        interventionBrowseModule: z
          .object({
            meshes: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    term: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            ancestors: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    term: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            browseLeaves: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    name: z.string().optional(),
                    relevance: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            browseBranches: z
              .array(
                z
                  .object({
                    abbrev: z.string().optional(),
                    name: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    resultsSection: z
      .object({
        participantFlowModule: z
          .object({
            groups: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    title: z.string().optional(),
                    description: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            periods: z
              .array(
                z
                  .object({
                    title: z.string().optional(),
                    milestones: z
                      .array(
                        z
                          .object({
                            type: z.string().optional(),
                            achievements: z
                              .array(
                                z
                                  .object({
                                    groupId: z.string().optional(),
                                    numSubjects: z.string().optional(),
                                  })
                                  .passthrough(),
                              )
                              .optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        baselineCharacteristicsModule: z
          .object({
            groups: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    title: z.string().optional(),
                    description: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            measures: z
              .array(
                z
                  .object({
                    title: z.string().optional(),
                    paramType: z.string().optional(),
                    unitOfMeasure: z.string().optional(),
                    classes: z
                      .array(
                        z
                          .object({
                            categories: z
                              .array(
                                z
                                  .object({
                                    title: z.string().optional(),
                                    measurements: z
                                      .array(
                                        z
                                          .object({
                                            groupId: z.string().optional(),
                                            value: z.string().optional(),
                                            spread: z.string().optional(),
                                            lowerLimit: z.string().optional(),
                                            upperLimit: z.string().optional(),
                                          })
                                          .passthrough(),
                                      )
                                      .optional(),
                                  })
                                  .passthrough(),
                              )
                              .optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        outcomeMeasuresModule: z
          .object({
            outcomeMeasures: z
              .array(
                z
                  .object({
                    type: z.string().optional(),
                    title: z.string().optional(),
                    description: z.string().optional(),
                    populationDescription: z.string().optional(),
                    reportingStatus: z.string().optional(),
                    paramType: z.string().optional(),
                    unitOfMeasure: z.string().optional(),
                    timeFrame: z.string().optional(),
                    groups: z
                      .array(
                        z
                          .object({
                            id: z.string().optional(),
                            title: z.string().optional(),
                            description: z.string().optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                    classes: z
                      .array(
                        z
                          .object({
                            title: z.string().optional(),
                            categories: z
                              .array(
                                z
                                  .object({
                                    title: z.string().optional(),
                                    measurements: z
                                      .array(
                                        z
                                          .object({
                                            groupId: z.string().optional(),
                                            value: z.string().optional(),
                                            spread: z.string().optional(),
                                            lowerLimit: z.string().optional(),
                                            upperLimit: z.string().optional(),
                                          })
                                          .passthrough(),
                                      )
                                      .optional(),
                                  })
                                  .passthrough(),
                              )
                              .optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                    analyses: z
                      .array(
                        z
                          .object({
                            groupIds: z.array(z.string()).optional(),
                            pValue: z.string().optional(),
                            statisticalMethod: z.string().optional(),
                            paramType: z.string().optional(),
                            paramValue: z.string().optional(),
                            ciPctValue: z.string().optional(),
                            ciNumSides: z.string().optional(),
                            ciLowerLimit: z.string().optional(),
                            ciUpperLimit: z.string().optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        adverseEventsModule: z
          .object({
            frequencyThreshold: z.string().optional(),
            timeFrame: z.string().optional(),
            description: z.string().optional(),
            eventGroups: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    title: z.string().optional(),
                    description: z.string().optional(),
                    deathsNumAffected: z.number().optional(),
                    deathsNumAtRisk: z.number().optional(),
                    seriousNumAffected: z.number().optional(),
                    seriousNumAtRisk: z.number().optional(),
                    otherNumAffected: z.number().optional(),
                    otherNumAtRisk: z.number().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            seriousEvents: z
              .array(
                z
                  .object({
                    term: z.string().optional(),
                    organSystem: z.string().optional(),
                    assessmentType: z.string().optional(),
                    stats: z
                      .array(
                        z
                          .object({
                            groupId: z.string().optional(),
                            numEvents: z.number().optional(),
                            numAffected: z.number().optional(),
                            numAtRisk: z.number().optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            otherEvents: z
              .array(
                z
                  .object({
                    term: z.string().optional(),
                    organSystem: z.string().optional(),
                    assessmentType: z.string().optional(),
                    stats: z
                      .array(
                        z
                          .object({
                            groupId: z.string().optional(),
                            numEvents: z.number().optional(),
                            numAffected: z.number().optional(),
                            numAtRisk: z.number().optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    hasResults: z.boolean().optional(),
  })
  .passthrough();

/**
 * Represents a single clinical study, based on the ClinicalTrials.gov API structure.
 * This type is inferred from the StudySchema to ensure consistency.
 */
export type Study = z.infer<typeof StudySchema>;

/**
 * Represents a paged list of studies.
 */
export type PagedStudies = {
  studies: Study[];
  nextPageToken?: string | undefined;
  totalCount?: number | undefined;
  [key: string]: unknown;
};

/**
 * Zod schema for a paged list of studies.
 * Note: Uses explicit type annotation to prevent TypeScript inference issues with deeply nested schemas.
 */
export const PagedStudiesSchema: z.ZodType<PagedStudies> = z
  .object({
    studies: z.array(StudySchema),
    nextPageToken: z.string().optional(),
    totalCount: z.number().optional(),
  })
  .passthrough();

/**

 * Represents the possible status values for a study.
 */
export enum Status {
  ActiveNotRecruiting = 'ACTIVE_NOT_RECRUITING',
  Completed = 'COMPLETED',
  EnrollingByInvitation = 'ENROLLING_BY_INVITATION',
  NotYetRecruiting = 'NOT_YET_RECRUITING',
  Recruiting = 'RECRUITING',
  Suspended = 'SUSPENDED',
  Terminated = 'TERMINATED',
  Withdrawn = 'WITHDRAWN',
  Available = 'AVAILABLE',
  NoLongerAvailable = 'NO_LONGER_AVAILABLE',
  TemporarilyNotAvailable = 'TEMPORARILY_NOT_AVAILABLE',
  ApprovedForMarketing = 'APPROVED_FOR_MARKETING',
  Withheld = 'WITHHELD',
  Unknown = 'UNKNOWN',
}

/**
 * Represents the possible phase values for a clinical trial.
 */
export enum Phase {
  EarlyPhase1 = 'EARLY_PHASE1',
  Phase1 = 'PHASE1',
  Phase2 = 'PHASE2',
  Phase3 = 'PHASE3',
  Phase4 = 'PHASE4',
  NotApplicable = 'NA',
}

/**
 * Represents the possible study type values.
 */
export enum StudyType {
  Interventional = 'INTERVENTIONAL',
  Observational = 'OBSERVATIONAL',
  ExpandedAccess = 'EXPANDED_ACCESS',
}

/**
 * Represents the possible intervention type values.
 */
export enum InterventionType {
  Drug = 'DRUG',
  Device = 'DEVICE',
  Biological = 'BIOLOGICAL',
  Procedure = 'PROCEDURE',
  Radiation = 'RADIATION',
  Behavioral = 'BEHAVIORAL',
  Genetic = 'GENETIC',
  DietarySupplement = 'DIETARY_SUPPLEMENT',
  CombinationProduct = 'COMBINATION_PRODUCT',
  DiagnosticTest = 'DIAGNOSTIC_TEST',
  Other = 'OTHER',
}

/**
 * Represents the standard age group values.
 */
export enum StdAge {
  Child = 'CHILD',
  Adult = 'ADULT',
  OlderAdult = 'OLDER_ADULT',
}
