/**
 * @fileoverview Single study lookup by NCT ID. Returns the full study record including
 * protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations.
 * @module mcp-server/tools/definitions/get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape, StudyLocation } from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../utils/_schemas.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

const EARTH_RADIUS_MI = 3958.7613;

/** Great-circle distance in miles between two lat/lon points (Haversine). */
function haversineMi(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

type LocationWithDistance = StudyLocation & { distanceMi?: number };

interface FilterInputs {
  locationLimit?: number | undefined;
  nearLocation?: { lat: number; lon: number; radiusMi: number } | undefined;
  outcomeLimit?: number | undefined;
}

interface FilterMeta {
  locationsWithoutGeo?: number;
  totalLocations?: number;
  totalOtherOutcomes?: number;
  totalSecondaryOutcomes?: number;
}

/**
 * Apply caller-requested filters to the study so structuredContent and format()
 * see the same data. Totals from before filtering are preserved in `meta` and
 * returned alongside the filtered study.
 */
function applyFilters(
  study: RawStudyShape,
  input: FilterInputs,
): { study: RawStudyShape; meta: FilterMeta } {
  const ps = study.protocolSection;
  if (!ps) return { study, meta: {} };

  const meta: FilterMeta = {};
  let nextPs = ps;

  const origLocations = ps.contactsLocationsModule?.locations;
  const hasLocationFilter = input.nearLocation != null || input.locationLimit != null;
  if (origLocations?.length && hasLocationFilter) {
    meta.totalLocations = origLocations.length;
    let locations: LocationWithDistance[] = origLocations;

    if (input.nearLocation) {
      const { lat, lon, radiusMi } = input.nearLocation;
      const withGeo = origLocations.filter(
        (l): l is StudyLocation & { geoPoint: { lat: number; lon: number } } => l.geoPoint != null,
      );
      meta.locationsWithoutGeo = origLocations.length - withGeo.length;
      locations = withGeo
        .map((l) => ({ ...l, distanceMi: haversineMi({ lat, lon }, l.geoPoint) }))
        .filter((l) => l.distanceMi <= radiusMi)
        .sort((a, b) => a.distanceMi - b.distanceMi);
    }

    if (input.locationLimit != null) {
      locations = locations.slice(0, input.locationLimit);
    }

    nextPs = {
      ...nextPs,
      contactsLocationsModule: {
        ...nextPs.contactsLocationsModule,
        locations,
      },
    };
  }

  const outcomes = ps.outcomesModule;
  if (outcomes && input.outcomeLimit != null) {
    const limit = input.outcomeLimit;
    const nextOutcomes = { ...outcomes };
    if (outcomes.secondaryOutcomes?.length) {
      meta.totalSecondaryOutcomes = outcomes.secondaryOutcomes.length;
      nextOutcomes.secondaryOutcomes = outcomes.secondaryOutcomes.slice(0, limit);
    }
    if (outcomes.otherOutcomes?.length) {
      meta.totalOtherOutcomes = outcomes.otherOutcomes.length;
      nextOutcomes.otherOutcomes = outcomes.otherOutcomes.slice(0, limit);
    }
    nextPs = { ...nextPs, outcomesModule: nextOutcomes };
  }

  return { study: { ...study, protocolSection: nextPs }, meta };
}

interface ResultsSummary {
  baselineMeasures?: number;
  otherAdverseEvents?: number;
  outcomeMeasures?: number;
  participantFlowPeriods?: number;
  seriousAdverseEvents?: number;
}

/**
 * Compact counts of a study's posted results, computed before the heavy
 * resultsSection is dropped from this record-level tool's payload. Returns
 * undefined when the study has no posted results.
 */
function summarizeResults(study: RawStudyShape): ResultsSummary | undefined {
  if (!study.hasResults || !study.resultsSection) return;
  const rs = study.resultsSection;
  const om = rs.outcomeMeasuresModule as { outcomeMeasures?: unknown[] } | undefined;
  const ae = rs.adverseEventsModule as
    | { otherEvents?: unknown[]; seriousEvents?: unknown[] }
    | undefined;
  const pf = rs.participantFlowModule as { periods?: unknown[] } | undefined;
  const bl = rs.baselineCharacteristicsModule as { measures?: unknown[] } | undefined;
  const summary: ResultsSummary = {};
  if (om?.outcomeMeasures?.length) summary.outcomeMeasures = om.outcomeMeasures.length;
  if (ae?.seriousEvents?.length) summary.seriousAdverseEvents = ae.seriousEvents.length;
  if (ae?.otherEvents?.length) summary.otherAdverseEvents = ae.otherEvents.length;
  if (pf?.periods?.length) summary.participantFlowPeriods = pf.periods.length;
  if (bl?.measures?.length) summary.baselineMeasures = bl.measures.length;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export const getStudy = tool('clinicaltrials_get_study_record', {
  description:
    'Fetch a single clinical trial study by NCT ID from ClinicalTrials.gov. Returns the full study record including protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations. Optional locationLimit / outcomeLimit / nearLocation parameters trim locations and outcomes — original totals are preserved in `filtersApplied` whenever a cap is applied.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'study_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The provided NCT ID does not match any study at ClinicalTrials.gov.',
      recovery: RECOVERY_HINTS.study_not_found,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
    },
  ],

  input: z.object({
    nctId: nctIdSchema.describe(
      'NCT identifier — format `NCT` followed by 8 digits (e.g., `NCT03722472`).',
    ),
    locationLimit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Optional cap on the number of locations returned. Omit for no cap (full upstream list). Pairs naturally with nearLocation for narrowing a large multi-site trial. Original total preserved in filtersApplied.totalLocations whenever a cap is applied.',
      ),
    outcomeLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Optional cap on the number of secondary and other outcomes returned. Omit for no cap (full upstream lists). Primary outcomes are never capped. Original totals preserved in filtersApplied.totalSecondaryOutcomes / totalOtherOutcomes whenever a cap is applied.',
      ),
    nearLocation: z
      .object({
        lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
        lon: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
        radiusMi: z.number().min(1).max(500).default(50).describe('Radius in miles. Default 50.'),
      })
      .optional()
      .describe(
        'Filter returned locations to those within radius of (lat, lon) and sort by distance. Adds distanceMi to each location. Locations without published coordinates are dropped — most US sites carry them; international sites less reliably so. For broader geographic filtering across studies, use clinicaltrials_search_studies with geoFilter.',
      ),
  }),

  output: z.object({
    study: z
      .record(z.string(), z.unknown())
      .describe(
        'Full study record with caller-requested filters already applied to locations and outcomes. Top-level keys: protocolSection (identification, status, sponsor, conditions, design, arms/interventions, outcomes, eligibility, contacts/locations), derivedSection (MeSH-normalized terms), hasResults, documentSection. The heavy resultsSection is omitted — see resultsSummary for counts and clinicaltrials_get_study_results for full results data. Use clinicaltrials_get_field_definitions to explore the schema.',
      ),
    filtersApplied: z
      .object({
        totalLocations: z
          .number()
          .int()
          .optional()
          .describe('Upstream location count before any filter was applied.'),
        locationsWithoutGeo: z
          .number()
          .int()
          .optional()
          .describe(
            'Number of upstream locations dropped because they lacked geoPoint when nearLocation was provided.',
          ),
        totalSecondaryOutcomes: z
          .number()
          .int()
          .optional()
          .describe('Upstream secondary outcomes count before outcomeLimit was applied.'),
        totalOtherOutcomes: z
          .number()
          .int()
          .optional()
          .describe('Upstream other outcomes count before outcomeLimit was applied.'),
        locationLimit: z.number().int().optional().describe('Echo of the locationLimit input.'),
        outcomeLimit: z.number().int().optional().describe('Echo of the outcomeLimit input.'),
        nearLocation: z
          .object({
            lat: z.number().describe('Latitude in decimal degrees.'),
            lon: z.number().describe('Longitude in decimal degrees.'),
            radiusMi: z.number().describe('Radius in miles.'),
          })
          .optional()
          .describe('Echo of the nearLocation input.'),
      })
      .describe('Metadata about the filtering applied to `study`.'),
    resultsSummary: z
      .object({
        outcomeMeasures: z.number().int().optional().describe('Posted outcome measures.'),
        seriousAdverseEvents: z
          .number()
          .int()
          .optional()
          .describe('Distinct serious adverse-event terms.'),
        otherAdverseEvents: z
          .number()
          .int()
          .optional()
          .describe('Distinct other (non-serious) adverse-event terms.'),
        participantFlowPeriods: z.number().int().optional().describe('Participant-flow periods.'),
        baselineMeasures: z.number().int().optional().describe('Baseline characteristic measures.'),
      })
      .optional()
      .describe(
        'Compact counts of posted results, present when hasResults is true. The full resultsSection is intentionally omitted from this record-level tool — fetch it via clinicaltrials_get_study_results or the clinicaltrials://{nctId} resource.',
      ),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const raw = await service.getStudy(input.nctId, ctx);
    const { study, meta } = applyFilters(raw as RawStudyShape, input);

    // Drop the heavy resultsSection (can exceed ~450KB) from this record-level
    // tool — carry only compact counts so structuredContent and format() stay
    // in parity. Full results live in clinicaltrials_get_study_results and the
    // clinicaltrials://{nctId} resource.
    const resultsSummary = summarizeResults(study);
    const studyOut: Record<string, unknown> = { ...study };
    delete studyOut.resultsSection;

    ctx.log.info('Study fetched', {
      nctId: input.nctId,
      locationLimit: input.locationLimit,
      outcomeLimit: input.outcomeLimit,
      nearLocation: input.nearLocation != null,
    });
    return {
      study: studyOut,
      ...(resultsSummary ? { resultsSummary } : {}),
      filtersApplied: {
        ...meta,
        ...(input.locationLimit != null ? { locationLimit: input.locationLimit } : {}),
        ...(input.outcomeLimit != null ? { outcomeLimit: input.outcomeLimit } : {}),
        ...(input.nearLocation ? { nearLocation: input.nearLocation } : {}),
      },
    };
  },

  format: (result) => {
    const s = result.study as RawStudyShape;
    const meta = result.filtersApplied ?? {};
    const ps = s.protocolSection ?? {};
    const id = ps.identificationModule ?? {};
    const status = ps.statusModule ?? {};
    const sponsor = ps.sponsorCollaboratorsModule ?? {};
    const desc = ps.descriptionModule ?? {};
    const cond = ps.conditionsModule ?? {};
    const design = ps.designModule ?? {};
    const armsInterv = ps.armsInterventionsModule ?? {};
    const outcomes = ps.outcomesModule ?? {};
    const elig = ps.eligibilityModule ?? {};
    const contacts = ps.contactsLocationsModule ?? {};
    const oversight = ps.oversightModule ?? {};
    const ipd = ps.ipdSharingStatementModule ?? {};
    const references = ps.referencesModule ?? {};

    const lines: string[] = [];

    // Header
    const nctId = id.nctId ?? 'Unknown';
    const title = id.briefTitle ?? id.officialTitle ?? 'Untitled';
    lines.push(`# Study ${nctId}: ${title}`);
    if (id.acronym) lines.push(`**Acronym:** ${id.acronym}`);
    // Only surface officialTitle when briefTitle is the primary — otherwise
    // the header already shows officialTitle and duplicating would be noise.
    if (id.briefTitle && id.officialTitle && id.officialTitle !== id.briefTitle)
      lines.push(`**Official Title:** ${id.officialTitle}`);
    if (id.orgStudyIdInfo?.id) lines.push(`**Org Study ID:** ${id.orgStudyIdInfo.id}`);
    if (id.organization?.fullName) lines.push(`**Organization:** ${id.organization.fullName}`);
    if (id.secondaryIdInfos?.length) {
      const parts = id.secondaryIdInfos
        .map((s2) => (s2.type ? `${s2.type}: ${s2.id}` : s2.id))
        .filter(Boolean);
      if (parts.length) lines.push(`**Secondary IDs:** ${parts.join(', ')}`);
    }

    // Status / Design
    const statusParts: string[] = [
      status.overallStatus,
      design.studyType,
      ...(design.phases ?? []),
      design.enrollmentInfo?.count != null ? `N=${design.enrollmentInfo.count}` : undefined,
    ].filter((v): v is string => v != null);
    if (statusParts.length) lines.push(`**Status:** ${statusParts.join(' | ')}`);

    // Design details
    const di = design.designInfo;
    if (di) {
      const designParts = [
        di.allocation && `Allocation: ${di.allocation}`,
        di.interventionModel && `Model: ${di.interventionModel}`,
        di.primaryPurpose && `Purpose: ${di.primaryPurpose}`,
        di.maskingInfo?.masking && `Masking: ${di.maskingInfo.masking}`,
      ].filter(Boolean);
      if (designParts.length) lines.push(`**Design:** ${designParts.join(' | ')}`);
    }

    // Dates
    const dateParts: string[] = [];
    if (status.startDateStruct?.date) dateParts.push(`Start: ${status.startDateStruct.date}`);
    if (status.primaryCompletionDateStruct?.date)
      dateParts.push(`Primary Completion: ${status.primaryCompletionDateStruct.date}`);
    if (status.completionDateStruct?.date)
      dateParts.push(`Completion: ${status.completionDateStruct.date}`);
    if (dateParts.length) lines.push(`**Dates:** ${dateParts.join(' | ')}`);

    // Submission / update dates
    const submissionParts: string[] = [];
    if (status.studyFirstSubmitDate)
      submissionParts.push(`First Submit: ${status.studyFirstSubmitDate}`);
    if (status.studyFirstPostDateStruct?.date)
      submissionParts.push(`First Post: ${status.studyFirstPostDateStruct.date}`);
    if (status.lastUpdateSubmitDate)
      submissionParts.push(`Last Update Submit: ${status.lastUpdateSubmitDate}`);
    if (status.lastUpdatePostDateStruct?.date)
      submissionParts.push(`Last Update Post: ${status.lastUpdatePostDateStruct.date}`);
    if (status.statusVerifiedDate) submissionParts.push(`Verified: ${status.statusVerifiedDate}`);
    if (submissionParts.length) lines.push(`**Submission:** ${submissionParts.join(' | ')}`);

    // Results availability — chaining signal for clinicaltrials_get_study_results
    if (s.hasResults != null) {
      lines.push(
        `**Has Results:** ${s.hasResults ? 'yes — fetch via clinicaltrials_get_study_results' : 'no'}`,
      );
    }

    // Sponsor + collaborators
    if (sponsor.leadSponsor?.name) {
      const cls = sponsor.leadSponsor.class ? ` (${sponsor.leadSponsor.class})` : '';
      lines.push(`**Sponsor:** ${sponsor.leadSponsor.name}${cls}`);
    }
    if (sponsor.collaborators?.length) {
      const parts = sponsor.collaborators
        .map((c) => (c.class ? `${c.name} (${c.class})` : c.name))
        .filter(Boolean);
      if (parts.length) lines.push(`**Collaborators:** ${parts.join(', ')}`);
    }

    // Conditions + keywords
    if (cond.conditions?.length) lines.push(`**Conditions:** ${cond.conditions.join(', ')}`);
    if (cond.keywords?.length) lines.push(`**Keywords:** ${cond.keywords.join(', ')}`);

    // MeSH-normalized terms from derivedSection — prefer browseLeaves (richer
    // display-ready view) when present, fall back to meshes (raw MeSH terms).
    const condMod = s.derivedSection?.conditionBrowseModule;
    const condTerms =
      condMod?.browseLeaves?.map((l) => l.name).filter((n): n is string => Boolean(n)) ??
      condMod?.meshes?.map((m) => m.term).filter((n): n is string => Boolean(n));
    if (condTerms?.length) lines.push(`**MeSH Conditions:** ${condTerms.join(', ')}`);

    const intrMod = s.derivedSection?.interventionBrowseModule;
    const intrTerms =
      intrMod?.browseLeaves?.map((l) => l.name).filter((n): n is string => Boolean(n)) ??
      intrMod?.meshes?.map((m) => m.term).filter((n): n is string => Boolean(n));
    if (intrTerms?.length) lines.push(`**MeSH Interventions:** ${intrTerms.join(', ')}`);

    // Oversight
    const oversightParts: string[] = [];
    if (oversight.oversightHasDmc != null)
      oversightParts.push(`DMC: ${oversight.oversightHasDmc ? 'Yes' : 'No'}`);
    if (oversight.isFdaRegulatedDrug != null)
      oversightParts.push(`FDA-Regulated Drug: ${oversight.isFdaRegulatedDrug ? 'Yes' : 'No'}`);
    if (oversight.isFdaRegulatedDevice != null)
      oversightParts.push(`FDA-Regulated Device: ${oversight.isFdaRegulatedDevice ? 'Yes' : 'No'}`);
    if (oversightParts.length) lines.push(`**Oversight:** ${oversightParts.join(' | ')}`);

    // Brief summary
    if (desc.briefSummary) {
      lines.push('');
      lines.push('## Summary');
      lines.push(desc.briefSummary.trim());
    }

    // Detailed description
    if (desc.detailedDescription) {
      lines.push('');
      lines.push('## Detailed Description');
      lines.push(desc.detailedDescription.trim());
    }

    // Eligibility
    lines.push('');
    lines.push('## Eligibility');
    const minAge = elig.minimumAge;
    const maxAge = elig.maximumAge;
    if (minAge && maxAge) lines.push(`**Age:** ${minAge} – ${maxAge}`);
    else if (minAge) lines.push(`**Age:** ≥ ${minAge}`);
    else if (maxAge) lines.push(`**Age:** ≤ ${maxAge}`);
    if (elig.sex) lines.push(`**Sex:** ${elig.sex}`);
    if (elig.healthyVolunteers != null)
      lines.push(`**Healthy Volunteers:** ${elig.healthyVolunteers ? 'Yes' : 'No'}`);
    if (elig.stdAges?.length) lines.push(`**Std Ages:** ${elig.stdAges.join(', ')}`);
    if (elig.eligibilityCriteria) {
      lines.push('');
      lines.push(elig.eligibilityCriteria.trim());
    }

    // Interventions
    if (armsInterv.interventions?.length) {
      lines.push('');
      lines.push('## Interventions');
      for (const interv of armsInterv.interventions) {
        const desc2 = interv.description ? ` — ${interv.description}` : '';
        lines.push(`- **${interv.type ?? 'Intervention'}:** ${interv.name}${desc2}`);
      }
    }

    // Arms
    if (armsInterv.armGroups?.length) {
      lines.push('');
      lines.push('## Arms');
      for (const arm of armsInterv.armGroups) {
        const desc2 = arm.description ? `: ${arm.description}` : '';
        lines.push(`- **${arm.label}** (${arm.type ?? 'unknown'})${desc2}`);
      }
    }

    // Outcomes — render every item present in the (already filtered) study.
    const renderOutcomeList = (
      heading: string,
      list: Array<{ description?: string; measure?: string; timeFrame?: string }>,
      total?: number,
    ) => {
      lines.push('');
      const suffix = total != null && total > list.length ? ` (${list.length} of ${total})` : '';
      lines.push(`## ${heading}${suffix}`);
      for (const o of list) {
        lines.push(`- ${o.measure}${o.timeFrame ? ` [${o.timeFrame}]` : ''}`);
      }
    };
    if (outcomes.primaryOutcomes?.length)
      renderOutcomeList('Primary Outcomes', outcomes.primaryOutcomes);
    if (outcomes.secondaryOutcomes?.length)
      renderOutcomeList(
        'Secondary Outcomes',
        outcomes.secondaryOutcomes,
        meta.totalSecondaryOutcomes,
      );
    if (outcomes.otherOutcomes?.length)
      renderOutcomeList('Other Outcomes', outcomes.otherOutcomes, meta.totalOtherOutcomes);

    // Results summary — compact counts mirrored from the resultsSummary output
    // field (the heavy resultsSection is omitted from this tool). Renders every
    // resultsSummary field so content[] and structuredContent stay in parity.
    const rsum = result.resultsSummary;
    if (rsum) {
      const parts = [
        rsum.outcomeMeasures != null ? `${rsum.outcomeMeasures} outcome measures` : '',
        rsum.seriousAdverseEvents != null
          ? `${rsum.seriousAdverseEvents} serious adverse events`
          : '',
        rsum.otherAdverseEvents != null ? `${rsum.otherAdverseEvents} other adverse events` : '',
        rsum.participantFlowPeriods != null
          ? `${rsum.participantFlowPeriods} participant flow periods`
          : '',
        rsum.baselineMeasures != null ? `${rsum.baselineMeasures} baseline measures` : '',
      ].filter(Boolean);
      if (parts.length) {
        lines.push('');
        lines.push('## Results Summary');
        lines.push(parts.join(' | '));
        lines.push('Use clinicaltrials_get_study_results for full data.');
      }
    }

    // Central contacts
    if (contacts.centralContacts?.length) {
      lines.push('');
      lines.push('## Contacts');
      for (const c of contacts.centralContacts) {
        const parts = [c.name, c.role, c.phone, c.email].filter(Boolean);
        lines.push(`- ${parts.join(' | ')}`);
      }
    }

    // Locations — render every site present in the (already filtered) study.
    if (contacts.locations?.length) {
      const locs = contacts.locations as LocationWithDistance[];
      const total = meta.totalLocations ?? locs.length;
      lines.push('');
      let header = `## Locations (${locs.length}`;
      if (meta.nearLocation) {
        header += ` within ${meta.nearLocation.radiusMi} mi of ${meta.nearLocation.lat.toFixed(3)},${meta.nearLocation.lon.toFixed(3)} of ${total} total`;
        if (meta.locationsWithoutGeo) {
          header += `, ${meta.locationsWithoutGeo} without coordinates skipped`;
        }
        header += ')';
      } else if (total > locs.length) {
        header += ` of ${total} total)`;
      } else {
        header += ` total)`;
      }
      lines.push(header);
      for (const loc of locs) {
        const parts = [loc.facility, loc.city, loc.state, loc.country].filter(Boolean);
        const statusNote = loc.status ? ` [${loc.status}]` : '';
        const distNote = loc.distanceMi != null ? ` (${loc.distanceMi.toFixed(1)} mi)` : '';
        lines.push(`- ${parts.join(', ')}${statusNote}${distNote}`);
      }
    }

    // IPD sharing
    if (ipd.ipdSharing || ipd.description || ipd.timeFrame) {
      lines.push('');
      lines.push('## IPD Sharing');
      if (ipd.ipdSharing) lines.push(`**Plan:** ${ipd.ipdSharing}`);
      if (ipd.timeFrame) lines.push(`**Time Frame:** ${ipd.timeFrame}`);
      if (ipd.description) lines.push(ipd.description.trim());
    }

    // Documents (protocol, consent, SAP, etc.)
    const docs = s.documentSection?.largeDocumentModule?.largeDocs;
    if (docs?.length) {
      lines.push('');
      lines.push(`## Documents (${docs.length})`);
      for (const d of docs) {
        const kinds = [
          d.hasProtocol ? 'Protocol' : '',
          d.hasSap ? 'SAP' : '',
          d.hasIcf ? 'ICF' : '',
        ].filter(Boolean);
        const label = d.label ?? d.typeAbbrev ?? d.filename ?? 'Document';
        const kindStr = kinds.length ? ` (${kinds.join('+')})` : '';
        const date = d.uploadDate ? ` [${d.uploadDate}]` : '';
        lines.push(`- ${label}${kindStr}${date}`);
      }
    }

    // References
    if (references.references?.length || references.seeAlsoLinks?.length) {
      lines.push('');
      lines.push('## References');
      for (const r of references.references ?? []) {
        const pmid = r.pmid ? ` (PMID: ${r.pmid})` : '';
        const type = r.type ? ` [${r.type}]` : '';
        lines.push(`- ${r.citation ?? 'Citation unavailable'}${pmid}${type}`);
      }
      for (const link of references.seeAlsoLinks ?? []) {
        lines.push(`- See also: ${link.label ?? link.url}${link.url ? ` — ${link.url}` : ''}`);
      }
    }

    // Filters Applied footer — guarantees every filtersApplied field appears
    // in content[] too (format-parity), independent of which sections rendered.
    const filterParts: string[] = [];
    if (meta.locationLimit != null) filterParts.push(`locationLimit=${meta.locationLimit}`);
    if (meta.outcomeLimit != null) filterParts.push(`outcomeLimit=${meta.outcomeLimit}`);
    if (meta.totalLocations != null) filterParts.push(`totalLocations=${meta.totalLocations}`);
    if (meta.locationsWithoutGeo != null)
      filterParts.push(`locationsWithoutGeo=${meta.locationsWithoutGeo}`);
    if (meta.totalSecondaryOutcomes != null)
      filterParts.push(`totalSecondaryOutcomes=${meta.totalSecondaryOutcomes}`);
    if (meta.totalOtherOutcomes != null)
      filterParts.push(`totalOtherOutcomes=${meta.totalOtherOutcomes}`);
    if (meta.nearLocation) {
      filterParts.push(
        `nearLocation=(lat=${meta.nearLocation.lat}, lon=${meta.nearLocation.lon}, radiusMi=${meta.nearLocation.radiusMi})`,
      );
    }
    if (filterParts.length) {
      lines.push('');
      lines.push(`*Filters applied: ${filterParts.join(', ')}*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
