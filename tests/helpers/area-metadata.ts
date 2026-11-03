/**
 * @fileoverview A slice of the live `/studies/metadata` tree (captured
 * 2026-11-02) for AREA[] field-name tests: STRUCT groups beside their leaf
 * pieces, and the legacy `altPieceNames` upstream also resolves — including the
 * two lowered forms (`collaborator`, `intervention`) that name a STRUCT piece and
 * a leaf's alt name at once.
 * @module tests/helpers/area-metadata
 */

import { buildAreaIndex, flattenMetadata } from '@/services/clinical-trials/field-search.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';

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
