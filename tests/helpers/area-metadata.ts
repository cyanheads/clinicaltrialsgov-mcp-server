/**
 * @fileoverview A slice of the live `/studies/metadata` tree (captured
 * 2026-11-02) for AREA[] field-name tests: STRUCT groups beside their leaf
 * pieces, and the legacy `altPieceNames` upstream also resolves — including the
 * two lowered forms (`collaborator`, `intervention`) that name a STRUCT piece and
 * a leaf's alt name at once.
 * @module tests/helpers/area-metadata
 */

import { buildAreaIndex, flattenMetadata } from '@/services/clinical-trials/field-search.js';
import type { FieldNode, SearchAreaGroup } from '@/services/clinical-trials/types.js';

/** Node fields kept verbatim from upstream: name, piece, sourceType, type, altPieceNames. */
export const AREA_METADATA: FieldNode[] = [
  {
    name: 'protocolSection',
    piece: 'ProtocolSection',
    sourceType: 'STRUCT',
    type: 'ProtocolSection',
    children: [
      {
        name: 'identificationModule',
        piece: 'IdentificationModule',
        sourceType: 'STRUCT',
        type: 'IdentificationModule',
        children: [{ name: 'nctId', piece: 'NCTId', sourceType: 'TEXT', type: 'nct' }],
      },
      {
        name: 'statusModule',
        piece: 'StatusModule',
        sourceType: 'STRUCT',
        type: 'StatusModule',
        children: [
          {
            name: 'overallStatus',
            piece: 'OverallStatus',
            sourceType: 'TEXT',
            type: 'Status',
            altPieceNames: ['OVERALL-STATUS'],
          },
          {
            name: 'studyFirstSubmitQcDate',
            piece: 'StudyFirstSubmitQCDate',
            sourceType: 'DATE',
            type: 'NormalizedDate',
            altPieceNames: ['STUDY-FIRST-SUBMITTED-QC'],
          },
        ],
      },
      {
        name: 'sponsorCollaboratorsModule',
        piece: 'SponsorCollaboratorsModule',
        sourceType: 'STRUCT',
        type: 'SponsorCollaboratorsModule',
        children: [
          {
            name: 'leadSponsor',
            piece: 'LeadSponsor',
            sourceType: 'STRUCT',
            type: 'Sponsor',
            children: [
              {
                name: 'name',
                piece: 'LeadSponsorName',
                sourceType: 'TEXT',
                type: 'text',
                altPieceNames: ['SPONSOR', 'LEAD-SPONSOR'],
              },
              {
                name: 'class',
                piece: 'LeadSponsorClass',
                sourceType: 'TEXT',
                type: 'AgencyClass',
                altPieceNames: ['LEAD-SPONSOR-CLASS'],
              },
            ],
          },
          {
            name: 'collaborators',
            piece: 'Collaborator',
            sourceType: 'STRUCT',
            type: 'Sponsor[]',
            children: [
              {
                name: 'name',
                piece: 'CollaboratorName',
                sourceType: 'TEXT',
                type: 'text',
                altPieceNames: ['COLLABORATOR'],
              },
              {
                name: 'class',
                piece: 'CollaboratorClass',
                sourceType: 'TEXT',
                type: 'AgencyClass',
                altPieceNames: ['COLLABORATOR-CLASS'],
              },
            ],
          },
        ],
      },
      {
        name: 'armsInterventionsModule',
        piece: 'ArmsInterventionsModule',
        sourceType: 'STRUCT',
        type: 'ArmsInterventionsModule',
        children: [
          {
            name: 'interventions',
            piece: 'Intervention',
            sourceType: 'STRUCT',
            type: 'Intervention[]',
            children: [
              {
                name: 'type',
                piece: 'InterventionType',
                sourceType: 'TEXT',
                type: 'InterventionType',
                altPieceNames: ['INTERVENTION-TYPE', 'INTERVENTION-TYPES'],
              },
              {
                name: 'name',
                piece: 'InterventionName',
                sourceType: 'TEXT',
                type: 'text',
                altPieceNames: ['INTERVENTION', 'INTERVENTIONS', 'INTERVENTION-NAME'],
              },
            ],
          },
        ],
      },
      {
        name: 'contactsLocationsModule',
        piece: 'ContactsLocationsModule',
        sourceType: 'STRUCT',
        type: 'ContactsLocationsModule',
        children: [
          {
            name: 'locations',
            piece: 'Location',
            sourceType: 'STRUCT',
            type: 'Location[]',
            children: [
              {
                name: 'status',
                piece: 'LocationStatus',
                sourceType: 'TEXT',
                type: 'RecruitmentStatus',
                altPieceNames: ['LOCATION-STATUS'],
              },
              {
                name: 'city',
                piece: 'LocationCity',
                sourceType: 'TEXT',
                type: 'GeoName',
                altPieceNames: ['LOCATION-CITY', 'CITY'],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'resultsSection',
    piece: 'ResultsSection',
    sourceType: 'STRUCT',
    type: 'ResultsSection',
    children: [
      {
        name: 'moreInfoModule',
        piece: 'MoreInfoModule',
        sourceType: 'STRUCT',
        type: 'MoreInfoModule',
        children: [
          {
            name: 'certainAgreement',
            piece: 'CertainAgreement',
            sourceType: 'STRUCT',
            type: 'CertainAgreement',
            children: [
              {
                name: 'piSponsorEmployee',
                piece: 'AgreementPISponsorEmployee',
                sourceType: 'BOOLEAN',
                type: 'boolean',
              },
            ],
          },
        ],
      },
    ],
  },
];

/** The `STRUCT` pieces of AREA_METADATA: names AREA[] refuses, so no rewrite or suggestion may land on one. */
export const STRUCT_PIECES = new Set(
  flattenMetadata(AREA_METADATA)
    .filter((e) => e.sourceType === 'STRUCT')
    .map((e) => e.piece),
);

/** The AREA index the service builds from AREA_METADATA. */
export const areaIndex = () => buildAreaIndex(flattenMetadata(AREA_METADATA));

/**
 * Insert each `additions[path]` among the children of the node at that dot path
 * (node names from the root), leaving `tree` untouched.
 */
function graft(
  tree: FieldNode[],
  additions: Record<string, FieldNode[]>,
  parent = '',
): FieldNode[] {
  return tree.map((node) => {
    const path = parent ? `${parent}.${node.name}` : node.name;
    const children = [...graft(node.children ?? [], additions, path), ...(additions[path] ?? [])];
    return children.length > 0 ? { ...node, children } : node;
  });
}

/**
 * The default `/studies/metadata` read for the index-only and search-area tests:
 * AREA_METADATA plus the record pieces those tests name — BriefTitle,
 * LastUpdatePostDate, Condition — with node fields verbatim from the live tree
 * (captured 2026-11-03).
 */
export const RECORD_METADATA = graft(AREA_METADATA, {
  protocolSection: [
    {
      name: 'conditionsModule',
      piece: 'ConditionsModule',
      sourceType: 'STRUCT',
      type: 'ConditionsModule',
      children: [
        {
          name: 'conditions',
          piece: 'Condition',
          sourceType: 'TEXT',
          type: 'text[]',
          altPieceNames: ['CONDITIONS'],
        },
      ],
    },
  ],
  'protocolSection.identificationModule': [
    {
      name: 'briefTitle',
      piece: 'BriefTitle',
      sourceType: 'TEXT',
      type: 'text',
      altPieceNames: ['BRIEF-TITLE'],
    },
  ],
  'protocolSection.statusModule': [
    {
      name: 'lastUpdatePostDateStruct',
      piece: 'LastUpdatePostDateStruct',
      sourceType: 'STRUCT',
      type: 'DateStruct',
      children: [
        {
          name: 'date',
          piece: 'LastUpdatePostDate',
          sourceType: 'DATE',
          type: 'NormalizedDate',
          altPieceNames: ['LAST-UPDATE-POSTED'],
        },
      ],
    },
  ],
});

/**
 * The `includeIndexedOnly=true` read of the same tree: RECORD_METADATA plus
 * index-only nodes (`indexedOnly: true`) nested two and three levels below a
 * section, beside the record fields they count — where upstream puts them.
 */
export const INDEXED_METADATA = graft(RECORD_METADATA, {
  'protocolSection.conditionsModule': [
    {
      name: 'numConditions',
      piece: 'NumConditions',
      indexedOnly: true,
      sourceType: 'FUNC NOccrs(Condition)',
      type: 'short',
      altPieceNames: ['NUMBER-OF-CONDITIONS'],
    },
  ],
  'protocolSection.statusModule.lastUpdatePostDateStruct': [
    {
      name: 'lastUpdatePostYear',
      piece: 'LastUpdatePostYear',
      indexedOnly: true,
      sourceType: 'FUNC MinYear(LastUpdatePostDate)',
      type: 'short',
    },
  ],
  'protocolSection.contactsLocationsModule': [
    {
      name: 'numLocations',
      piece: 'NumLocations',
      indexedOnly: true,
      sourceType: 'FUNC NOccrs(Location)',
      type: 'short',
      altPieceNames: ['NUMBER-OF-LOCATIONS'],
    },
  ],
  'protocolSection.contactsLocationsModule.locations': [
    {
      name: 'countryCode',
      piece: 'LocationCountryCode',
      indexedOnly: true,
      sourceType: 'FUNC CountryCode(LocationCountry)',
      type: 'keyword',
    },
  ],
});

/** A trimmed `/studies/search-areas` response: three of the 19 areas, each cut to its name. */
export const SEARCH_AREAS: SearchAreaGroup[] = [
  {
    name: 'Study',
    areas: [{ name: 'BasicSearch' }, { name: 'ConditionSearch' }, { name: 'LocationSearch' }],
  },
];

/**
 * Live pools (captured 2026-11-03) for the suggestion regression table. The
 * record pieces are the AREA index entries that score for any input that table
 * names; as entries whose path is the piece itself, nearestPieces ranks each of
 * those inputs exactly as it does over all 342 live AREA entries.
 */
export const LIVE_RECORD_PIECES =
  'OrgFullName StartDate CompletionDate StudyFirstSubmitDate StudyFirstSubmitQCDate StudyFirstPostDate StudyFirstPostDateType ResultsFirstSubmitDate ResultsFirstSubmitQCDate ResultsFirstPostDate ResultsFirstPostDateType DispFirstSubmitDate DispFirstSubmitQCDate DispFirstPostDate DispFirstPostDateType LastUpdatePostDate LastUpdatePostDateType ResponsiblePartyInvestigatorFullName ResponsiblePartyOldNameTitle LeadSponsorName LeadSponsorClass CollaboratorName Condition Phase DesignInterventionModel DesignInterventionModelDescription ArmGroupInterventionName InterventionType InterventionName InterventionDescription InterventionArmGroupLabel InterventionOtherName CentralContactName OverallOfficialName LocationFacility LocationStatus LocationCity LocationState LocationZip LocationCountry LocationContactName LocationContactRole LocationContactPhone LocationContactPhoneExt LocationContactEMail LocationGeoPoint FlowAchievementNumSubjects FlowAchievementNumUnits FlowReasonNumSubjects OutcomeMeasureAnticipatedPostingDate OutcomeAnalysisCINumSides EventGroupDeathsNumAffected EventGroupDeathsNumAtRisk EventGroupSeriousNumAffected EventGroupSeriousNumAtRisk EventGroupOtherNumAffected EventGroupOtherNumAtRisk SeriousEventStatsNumEvents SeriousEventStatsNumAffected SeriousEventStatsNumAtRisk OtherEventStatsNumEvents OtherEventStatsNumAffected OtherEventStatsNumAtRisk AgreementPISponsorEmployee UnpostedEventDate UnpostedEventDateUnknown ViolationEventPostedDate EstimatedResultsFirstSubmitDate FirstMCPPostDate FirstMCPPostDateType ConditionMeshId ConditionMeshTerm ConditionAncestorId ConditionAncestorTerm ConditionBrowseLeafId ConditionBrowseLeafName ConditionBrowseLeafAsFound ConditionBrowseLeafRelevance ConditionBrowseBranchAbbrev ConditionBrowseBranchName InterventionMeshId InterventionMeshTerm InterventionAncestorId InterventionAncestorTerm InterventionBrowseLeafId InterventionBrowseLeafName InterventionBrowseLeafAsFound InterventionBrowseLeafRelevance InterventionBrowseBranchAbbrev InterventionBrowseBranchName'.split(
    ' ',
  );

/**
 * All 77 index-only pieces `/studies/metadata?includeIndexedOnly=true` flags,
 * each as its piece and then its altPieceNames.
 */
export const LIVE_INDEX_ONLY =
  'NumNCTAliases NumSecondaryIds|NUMBER-OF-SECONDARY_IDS StudyFirstSubmitYear StudyFirstPostYear ResultsFirstSubmitYear ResultsFirstPostYear DispFirstSubmitYear DispFirstPostYear LastUpdateSubmitYear LastUpdatePostYear NumCollaborators NumCollaboratorsPlusLead NumConditions|NUMBER-OF-CONDITIONS NumKeywords|NUMBER-OF-KEYWORDS NumPhases NumDesignWhoMaskeds NumArmGroupInterventionNames NumArmGroups|NUMBER-OF-ARM-GROUPS NumInterventionArmGroupLabels NumInterventionOtherNames NumInterventions|NUMBER-OF-INTERVENTIONS NumPrimaryOutcomes|NUMBER-OF-PRIMARY-OMS NumSecondaryOutcomes|NUMBER-OF-SECONDARY-OMS NumOtherOutcomes NumOutcomes NumStdAges NumCentralContacts NumOverallOfficials NumLocationContacts LocationCountryCode NumLocations|NUMBER-OF-LOCATIONS NumUniqueLocationCountries|NUMBER-OF-COUNTRIES NumRetractionsForRef NumReferences|NUMBER-OF-CITATIONS NumRetractionsAllRefs NumSeeAlsoLinks NumAvailIPDs NumIPDSharingInfoTypes NumFlowGroups NumFlowAchievements NumFlowMilestones NumFlowReasons NumFlowDropWithdraws NumFlowPeriods NumBaselineGroups NumBaselineDenoms NumBaselineMeasureDenoms NumBaselineMeasurements NumBaselineCategories NumBaselineClasses NumBaselineMeasures NumOutcomeGroups NumOutcomeDenoms NumOutcomeMeasurements NumOutcomeCategories NumOutcomeClasses NumOutcomeAnalysisGroupIds NumOutcomeAnalyses NumOutcomeMeasures NumEventGroups NumSeriousEventStatss NumSeriousEvents NumOtherEventStatss NumOtherEvents NumEvents NumUnpostedEvents NumViolationEvents NumLargeDocs NumRemovedCountries NumConditionMeshes NumConditionAncestors NumConditionBrowseLeafs NumConditionBrowseBranches NumInterventionMeshes NumInterventionAncestors NumInterventionBrowseLeafs NumInterventionBrowseBranches'
    .split(' ')
    .map((entry) => entry.split('|'));

/** All 19 areas `/studies/search-areas` lists. */
export const LIVE_SEARCH_AREAS =
  'BasicSearch ConditionSearch InterventionSearch InterventionNameSearch ObsoleteConditionSearch ExternalIdsSearch ExternalIdTypesSearch EligibilitySearch OutcomeSearch OutcomeNameSearch TitleSearch LocationSearch ContactSearch NCTIdSearch IdSearch SponsorSearch FunderTypeSearch ResponsiblePartySearch PatientSearch'.split(
    ' ',
  );
