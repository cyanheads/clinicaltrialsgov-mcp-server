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

export const getStudy = tool('clinicaltrials_get_study_record', {
  description:
    'Fetch a single clinical trial study by NCT ID from ClinicalTrials.gov. Returns the full study record including protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations.',
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
    nctId: nctIdSchema.describe('NCT identifier (e.g., NCT03722472).'),
    locationLimit: z
      .number()
      .int()
      .min(0)
      .max(500)
      .default(10)
      .describe(
        'Max locations to render in the formatted output. 0 = unlimited. Default 10. Pairs naturally with nearLocation for narrowing a large multi-site trial.',
      ),
    outcomeLimit: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(5)
      .describe(
        'Max secondary and other outcomes to render in the formatted output. 0 = unlimited. Default 5. Primary outcomes always render in full.',
      ),
    nearLocation: z
      .object({
        lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
        lon: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
        radiusMi: z.number().min(1).max(500).default(50).describe('Radius in miles. Default 50.'),
      })
      .optional()
      .describe(
        'Filter rendered locations to those within radius of (lat, lon) and sort by distance. Only locations with upstream coordinates are returned — most US sites carry them; international sites less reliably so. Use clinicaltrials_search_studies with geoFilter for upstream-side geographic filtering.',
      ),
  }),

  output: z.object({
    study: z
      .record(z.string(), z.unknown())
      .describe(
        'Full study record. Top-level keys: protocolSection (identification, status, sponsor, conditions, design, arms/interventions, outcomes, eligibility, contacts/locations), derivedSection (MeSH-normalized terms), hasResults, resultsSection, documentSection. Use clinicaltrials_get_field_definitions to explore the schema.',
      ),
    locationLimit: z
      .number()
      .int()
      .optional()
      .describe('Echo of the locationLimit input; drives format() truncation.'),
    outcomeLimit: z
      .number()
      .int()
      .optional()
      .describe('Echo of the outcomeLimit input; drives format() truncation.'),
    nearLocation: z
      .object({
        lat: z.number().describe('Latitude in decimal degrees.'),
        lon: z.number().describe('Longitude in decimal degrees.'),
        radiusMi: z.number().describe('Radius in miles.'),
      })
      .optional()
      .describe('Echo of the nearLocation input; drives format() geo filter.'),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const study = await service.getStudy(input.nctId, ctx);
    ctx.log.info('Study fetched', { nctId: input.nctId });
    return {
      study,
      locationLimit: input.locationLimit,
      outcomeLimit: input.outcomeLimit,
      ...(input.nearLocation ? { nearLocation: input.nearLocation } : {}),
    };
  },

  format: (result) => {
    const s = result.study as RawStudyShape;
    const locationLimit = result.locationLimit ?? 10;
    const outcomeLimit = result.outcomeLimit ?? 5;
    const nearLocation = result.nearLocation;
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

    // Outcomes — primaries always render in full; secondary/other honor outcomeLimit (0 = unlimited).
    const renderOutcomeList = (
      heading: string,
      list: Array<{ description?: string; measure?: string; timeFrame?: string }>,
      limit?: number,
    ) => {
      lines.push('');
      const cap = limit && limit > 0 ? limit : list.length;
      const headerSuffix =
        limit != null && list.length > cap
          ? ` (showing ${cap} of ${list.length}, outcomeLimit=${limit})`
          : limit != null && limit === 0
            ? ` (${list.length} total, outcomeLimit=0 — unlimited)`
            : '';
      lines.push(`## ${heading}${headerSuffix}`);
      const shown = list.slice(0, cap);
      for (const o of shown) {
        lines.push(`- ${o.measure}${o.timeFrame ? ` [${o.timeFrame}]` : ''}`);
      }
      if (list.length > cap) {
        lines.push(`... and ${list.length - cap} more`);
      }
    };
    if (outcomes.primaryOutcomes?.length)
      renderOutcomeList('Primary Outcomes', outcomes.primaryOutcomes);
    if (outcomes.secondaryOutcomes?.length)
      renderOutcomeList('Secondary Outcomes', outcomes.secondaryOutcomes, outcomeLimit);
    if (outcomes.otherOutcomes?.length)
      renderOutcomeList('Other Outcomes', outcomes.otherOutcomes, outcomeLimit);

    // Results summary stub — counts only; full data via clinicaltrials_get_study_results
    if (s.hasResults && s.resultsSection) {
      const rs = s.resultsSection;
      const om = rs.outcomeMeasuresModule as { outcomeMeasures?: unknown[] } | undefined;
      const ae = rs.adverseEventsModule as
        | { otherEvents?: unknown[]; seriousEvents?: unknown[] }
        | undefined;
      const pf = rs.participantFlowModule as { periods?: unknown[] } | undefined;
      const bl = rs.baselineCharacteristicsModule as { measures?: unknown[] } | undefined;
      const aeCount = ae ? (ae.seriousEvents?.length ?? 0) + (ae.otherEvents?.length ?? 0) : 0;
      const parts = [
        om?.outcomeMeasures?.length ? `${om.outcomeMeasures.length} outcome measures` : '',
        aeCount ? `${aeCount} adverse events` : '',
        pf?.periods?.length ? `${pf.periods.length} participant flow periods` : '',
        bl?.measures?.length ? `${bl.measures.length} baseline measures` : '',
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

    // Locations — optional geo filter, then RECRUITING-first preference, then locationLimit cap.
    if (contacts.locations?.length) {
      const locs = contacts.locations;
      const cap = locationLimit > 0 ? locationLimit : locs.length;
      lines.push('');

      let scoped: Array<StudyLocation & { _distMi?: number }> = locs;
      if (nearLocation) {
        const { lat, lon, radiusMi } = nearLocation;
        const withGeo = locs.filter(
          (l): l is StudyLocation & { geoPoint: { lat: number; lon: number } } =>
            l.geoPoint != null,
        );
        const droppedNoGeo = locs.length - withGeo.length;
        scoped = withGeo
          .map((l) => ({ ...l, _distMi: haversineMi({ lat, lon }, l.geoPoint) }))
          .filter((l) => l._distMi <= radiusMi)
          .sort((a, b) => a._distMi - b._distMi);
        lines.push(
          `## Locations (${scoped.length} within ${radiusMi} mi of ${lat.toFixed(3)},${lon.toFixed(3)} — of ${locs.length} total${droppedNoGeo > 0 ? `, ${droppedNoGeo} without coordinates skipped` : ''})`,
        );
      } else {
        const recruiting = locs.filter((l) => l.status === 'RECRUITING');
        scoped = recruiting.length > 0 ? recruiting : locs;
        const capNote =
          locationLimit === 0
            ? ` — locationLimit=0 (unlimited)`
            : scoped.length > cap
              ? ` — showing ${cap}, locationLimit=${locationLimit}`
              : '';
        lines.push(`## Locations (${locs.length} total${capNote})`);
      }

      const toShow = scoped.slice(0, cap);
      for (const loc of toShow) {
        const parts = [loc.facility, loc.city, loc.state, loc.country].filter(Boolean);
        const statusNote = loc.status ? ` [${loc.status}]` : '';
        const distNote = loc._distMi != null ? ` (${loc._distMi.toFixed(1)} mi)` : '';
        lines.push(`- ${parts.join(', ')}${statusNote}${distNote}`);
      }
      if (scoped.length > cap) lines.push(`... and ${scoped.length - cap} more`);
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
      const refs = references.references ?? [];
      const shown = refs.slice(0, 10);
      for (const r of shown) {
        const pmid = r.pmid ? ` (PMID: ${r.pmid})` : '';
        const type = r.type ? ` [${r.type}]` : '';
        lines.push(`- ${r.citation ?? 'Citation unavailable'}${pmid}${type}`);
      }
      if (refs.length > 10) lines.push(`... and ${refs.length - 10} more`);
      for (const link of references.seeAlsoLinks ?? []) {
        lines.push(`- See also: ${link.label ?? link.url}${link.url ? ` — ${link.url}` : ''}`);
      }
    }

    // Render-settings footer guarantees every output field appears in the
    // text surface (format-parity), even when the conditional location/outcome
    // sections aren't reached for a sparse study record.
    const settingsParts = [`locationLimit=${locationLimit}`, `outcomeLimit=${outcomeLimit}`];
    if (nearLocation) {
      settingsParts.push(
        `nearLocation=(lat=${nearLocation.lat}, lon=${nearLocation.lon}, radiusMi=${nearLocation.radiusMi})`,
      );
    }
    lines.push('');
    lines.push(`*Rendering: ${settingsParts.join(', ')}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
