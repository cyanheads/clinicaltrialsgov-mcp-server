/**
 * @fileoverview Single study lookup by NCT ID. Returns the full study record including
 * protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations.
 * @module mcp-server/tools/definitions/get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type {
  BrowseModule,
  DateStruct,
  ProtocolOutcome,
  RawStudyShape,
  StudyContact,
  StudyIdInfo,
} from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../utils/_schemas.js';
import type { LocationWithDistance } from '../utils/geo-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';
import { applyFilters, summarizeResults } from '../utils/study-filters.js';

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

/** Render a `{ date, type }` struct as `date (TYPE)` — the ACTUAL/ESTIMATED qualifier matters. */
function dateWithType(struct: DateStruct | undefined): string | undefined {
  if (!struct?.date) return;
  return struct.type ? `${struct.date} (${struct.type})` : struct.date;
}

/** Render a boolean flag for display. */
function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/**
 * Join `[label, value]` pairs into `Label: value` segments, dropping pairs that
 * carry no value. Booleans render Yes/No — `false` is data, not absence.
 */
function labeledParts(pairs: Array<[string, boolean | string | undefined]>): string[] {
  return pairs
    .filter((pair): pair is [string, boolean | string] => pair[1] != null && pair[1] !== '')
    .map(([label, value]) => `${label}: ${typeof value === 'boolean' ? yesNo(value) : value}`);
}

/**
 * Render an identifier struct (`orgStudyIdInfo`, `secondaryIdInfos[]`) with its
 * registry provenance — `domain` names the issuing registry and `link` resolves
 * the ID there, so both are part of the identifier, not decoration.
 */
function idWithProvenance(info: StudyIdInfo): string {
  const core = [info.type, info.id].filter(Boolean).join(': ');
  const extras = [info.domain, info.link].filter(Boolean);
  return extras.length ? `${core} (${extras.join(' — ')})` : core;
}

/** Render a contact (central, per-site, or overall official) as a single line. */
function contactLine(contact: StudyContact): string {
  const phone = contact.phoneExt ? `${contact.phone} ext. ${contact.phoneExt}` : contact.phone;
  return [contact.name, contact.role, phone, contact.email].filter(Boolean).join(' | ');
}

/**
 * Render a derivedSection browse module. `meshes`, `browseLeaves`, `ancestors`,
 * and `browseBranches` are four distinct upstream views of the same
 * normalization — each gets its own line rather than one standing in for
 * another, so nothing in the structured payload is unreachable from text.
 */
function renderBrowseModule(
  noun: string,
  plural: string,
  mod: BrowseModule | undefined,
  lines: string[],
): void {
  if (!mod) return;
  const meshes = (mod.meshes ?? [])
    .map((m) => [m.term, m.id ? `(${m.id})` : ''].filter(Boolean).join(' '))
    .filter(Boolean);
  if (meshes.length) lines.push(`**MeSH ${plural}:** ${meshes.join(', ')}`);

  const leaves = (mod.browseLeaves ?? [])
    .map((l) => {
      const notes = [l.id, l.relevance, l.asFound ? `as found: ${l.asFound}` : ''].filter(Boolean);
      return [l.name, notes.length ? `(${notes.join(', ')})` : ''].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  if (leaves.length) lines.push(`**${noun} Browse Terms:** ${leaves.join(', ')}`);

  const ancestors = (mod.ancestors ?? [])
    .map((a) => [a.term, a.id ? `(${a.id})` : ''].filter(Boolean).join(' '))
    .filter(Boolean);
  if (ancestors.length) lines.push(`**${noun} MeSH Ancestors:** ${ancestors.join(', ')}`);

  const branches = (mod.browseBranches ?? [])
    .map((b) => [b.name, b.abbrev ? `(${b.abbrev})` : ''].filter(Boolean).join(' '))
    .filter(Boolean);
  if (branches.length) lines.push(`**${noun} Browse Branches:** ${branches.join(', ')}`);
}

export const getStudy = tool('clinicaltrials_get_study_record', {
  description:
    'Fetch a single clinical trial study by NCT ID from ClinicalTrials.gov. Returns the full study record including protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations. Optional locationLimit / outcomeLimit / referenceLimit / nearLocation parameters trim locations, outcomes, and references — original totals are preserved in `filtersApplied` only when a cap actually trims the set.',
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
        'Optional cap on the number of locations returned. Omit for no cap (full upstream list). Pairs naturally with nearLocation for narrowing a large multi-site trial. Original total preserved in filtersApplied.totalLocations only when the cap trims the list.',
      ),
    outcomeLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Optional cap on the number of secondary and other outcomes returned. Omit for no cap (full upstream lists). Primary outcomes are never capped. Original totals preserved in filtersApplied.totalSecondaryOutcomes / totalOtherOutcomes only when the cap trims a list.',
      ),
    referenceLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Optional cap on the number of references returned. Omit for no cap (full upstream list). Original total preserved in filtersApplied.totalReferences only when the cap trims the list. seeAlsoLinks are never capped.',
      ),
    nearLocation: z
      .object({
        lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
        lon: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
        radiusMi: z.number().min(1).max(500).default(50).describe('Radius in miles. Default 50.'),
      })
      .strict()
      .optional()
      .describe(
        'Filter returned locations to those within radius of (lat, lon) and sort by distance. Adds distanceMi to each location. Locations without published coordinates are dropped — most US sites carry them; international sites less reliably so. Distances reflect ClinicalTrials.gov geocoding granularity — typically city-centroid, not facility-level — so multiple sites in the same city resolve to near-identical distances. For broader geographic filtering across studies, use clinicaltrials_search_studies with geoFilter.',
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
        totalReferences: z
          .number()
          .int()
          .optional()
          .describe('Upstream reference count before referenceLimit was applied.'),
        locationLimit: z
          .number()
          .int()
          .optional()
          .describe(
            'Echo of the locationLimit input — present only when the cap trimmed the list.',
          ),
        outcomeLimit: z
          .number()
          .int()
          .optional()
          .describe('Echo of the outcomeLimit input — present only when the cap trimmed a list.'),
        referenceLimit: z
          .number()
          .int()
          .optional()
          .describe(
            'Echo of the referenceLimit input — present only when the cap trimmed the list.',
          ),
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
      filtersApplied: meta,
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
    if (id.nctIdAliases?.length) lines.push(`**Previous NCT IDs:** ${id.nctIdAliases.join(', ')}`);
    const orgStudyId = id.orgStudyIdInfo ? idWithProvenance(id.orgStudyIdInfo) : '';
    if (orgStudyId) lines.push(`**Org Study ID:** ${orgStudyId}`);
    if (id.organization?.fullName) {
      const orgClass = id.organization.class ? ` (${id.organization.class})` : '';
      lines.push(`**Organization:** ${id.organization.fullName}${orgClass}`);
    }
    if (id.secondaryIdInfos?.length) {
      const parts = id.secondaryIdInfos.map(idWithProvenance).filter(Boolean);
      if (parts.length) lines.push(`**Secondary IDs:** ${parts.join('; ')}`);
    }

    // Status / Design
    const enrollment = design.enrollmentInfo;
    const statusParts: string[] = [
      status.overallStatus,
      design.studyType,
      ...(design.phases ?? []),
      enrollment?.count != null
        ? `N=${enrollment.count}${enrollment.type ? ` (${enrollment.type})` : ''}`
        : undefined,
    ].filter((v): v is string => v != null);
    if (statusParts.length) lines.push(`**Status:** ${statusParts.join(' | ')}`);
    if (status.lastKnownStatus) lines.push(`**Last Known Status:** ${status.lastKnownStatus}`);
    if (status.whyStopped) lines.push(`**Why Stopped:** ${status.whyStopped}`);

    // Design details — interventional and observational sub-fields are disjoint,
    // so both sets render; an observational record would otherwise show nothing.
    const di = design.designInfo;
    if (di) {
      const maskingInfo = di.maskingInfo;
      const masking = maskingInfo?.masking
        ? `Masking: ${maskingInfo.masking}${
            maskingInfo.whoMasked?.length ? ` (${maskingInfo.whoMasked.join(', ')})` : ''
          }`
        : '';
      const designParts = [
        di.allocation && `Allocation: ${di.allocation}`,
        di.interventionModel && `Model: ${di.interventionModel}`,
        di.primaryPurpose && `Purpose: ${di.primaryPurpose}`,
        di.observationalModel && `Observational Model: ${di.observationalModel}`,
        di.timePerspective && `Time Perspective: ${di.timePerspective}`,
        masking,
      ].filter(Boolean);
      if (designParts.length) lines.push(`**Design:** ${designParts.join(' | ')}`);
      if (di.interventionModelDescription)
        lines.push(`**Model Description:** ${di.interventionModelDescription}`);
      if (maskingInfo?.maskingDescription)
        lines.push(`**Masking Description:** ${maskingInfo.maskingDescription}`);
    }
    if (design.targetDuration) lines.push(`**Target Duration:** ${design.targetDuration}`);
    if (design.patientRegistry != null)
      lines.push(`**Patient Registry:** ${yesNo(design.patientRegistry)}`);
    if (design.bioSpec) {
      const bioParts = [design.bioSpec.retention, design.bioSpec.description].filter(Boolean);
      if (bioParts.length) lines.push(`**Biospecimens:** ${bioParts.join(' — ')}`);
    }

    // Dates
    const dateParts = labeledParts([
      ['Start', dateWithType(status.startDateStruct)],
      ['Primary Completion', dateWithType(status.primaryCompletionDateStruct)],
      ['Completion', dateWithType(status.completionDateStruct)],
    ]);
    if (dateParts.length) lines.push(`**Dates:** ${dateParts.join(' | ')}`);

    // Submission / update dates
    const submissionParts = labeledParts([
      ['First Submit', status.studyFirstSubmitDate],
      ['First Submit QC', status.studyFirstSubmitQcDate],
      ['First Post', dateWithType(status.studyFirstPostDateStruct)],
      ['Results First Submit', status.resultsFirstSubmitDate],
      ['Results First Submit QC', status.resultsFirstSubmitQcDate],
      ['Results First Post', dateWithType(status.resultsFirstPostDateStruct)],
      ['Disposition First Submit', status.dispFirstSubmitDate],
      ['Disposition First Submit QC', status.dispFirstSubmitQcDate],
      ['Disposition First Post', dateWithType(status.dispFirstPostDateStruct)],
      ['Last Update Submit', status.lastUpdateSubmitDate],
      ['Last Update Post', dateWithType(status.lastUpdatePostDateStruct)],
      ['Verified', status.statusVerifiedDate],
    ]);
    if (submissionParts.length) lines.push(`**Submission:** ${submissionParts.join(' | ')}`);

    // Results availability — chaining signal for clinicaltrials_get_study_results
    if (s.hasResults != null) {
      lines.push(
        `**Has Results:** ${s.hasResults ? 'yes — fetch via clinicaltrials_get_study_results' : 'no'}`,
      );
    }

    // Expanded access — an EAP record is a separate NCT ID worth surfacing.
    const expandedAccess = status.expandedAccessInfo;
    if (expandedAccess) {
      const eaParts = labeledParts([
        ['Available', expandedAccess.hasExpandedAccess],
        ['Record', expandedAccess.nctId],
        ['Status', expandedAccess.statusForNctId],
      ]);
      if (eaParts.length) lines.push(`**Expanded Access:** ${eaParts.join(' | ')}`);
    }
    if (design.nPtrsToThisExpAccNctId != null)
      lines.push(`**Studies Referencing This Expanded Access:** ${design.nPtrsToThisExpAccNctId}`);

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
    const responsibleParty = sponsor.responsibleParty;
    if (responsibleParty) {
      const parts = [
        responsibleParty.type,
        responsibleParty.investigatorFullName,
        responsibleParty.investigatorTitle,
        responsibleParty.investigatorAffiliation,
        responsibleParty.oldNameTitle,
        responsibleParty.oldOrganization,
      ].filter(Boolean);
      if (parts.length) lines.push(`**Responsible Party:** ${parts.join(' | ')}`);
    }

    // Conditions + keywords
    if (cond.conditions?.length) lines.push(`**Conditions:** ${cond.conditions.join(', ')}`);
    if (cond.keywords?.length) lines.push(`**Keywords:** ${cond.keywords.join(', ')}`);

    // MeSH-normalized terms from derivedSection.
    renderBrowseModule('Condition', 'Conditions', s.derivedSection?.conditionBrowseModule, lines);
    renderBrowseModule(
      'Intervention',
      'Interventions',
      s.derivedSection?.interventionBrowseModule,
      lines,
    );

    // Oversight
    const oversightParts = labeledParts([
      ['DMC', oversight.oversightHasDmc],
      ['FDA-Regulated Drug', oversight.isFdaRegulatedDrug],
      ['FDA-Regulated Device', oversight.isFdaRegulatedDevice],
      ['Unapproved Device', oversight.isUnapprovedDevice],
      ['US Export', oversight.isUsExport],
      ['Pediatric Postmarket Surveillance', oversight.isPpsd],
    ]);
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
    if (elig.genderBased != null) lines.push(`**Gender Based:** ${yesNo(elig.genderBased)}`);
    if (elig.genderDescription) lines.push(`**Gender Description:** ${elig.genderDescription}`);
    if (elig.healthyVolunteers != null)
      lines.push(`**Healthy Volunteers:** ${yesNo(elig.healthyVolunteers)}`);
    if (elig.stdAges?.length) lines.push(`**Std Ages:** ${elig.stdAges.join(', ')}`);
    // Observational studies define their cohort here, separately from
    // eligibilityCriteria — for those records this is the eligibility surface.
    if (elig.samplingMethod) lines.push(`**Sampling Method:** ${elig.samplingMethod}`);
    if (elig.studyPopulation) {
      lines.push('');
      lines.push('**Study Population:**');
      lines.push(elig.studyPopulation.trim());
    }
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
        if (interv.otherNames?.length) lines.push(`  Other names: ${interv.otherNames.join(', ')}`);
        if (interv.armGroupLabels?.length)
          lines.push(`  Arms: ${interv.armGroupLabels.join(', ')}`);
      }
    }

    // Arms
    if (armsInterv.armGroups?.length) {
      lines.push('');
      lines.push('## Arms');
      for (const arm of armsInterv.armGroups) {
        const desc2 = arm.description ? `: ${arm.description}` : '';
        lines.push(`- **${arm.label}** (${arm.type ?? 'unknown'})${desc2}`);
        if (arm.interventionNames?.length)
          lines.push(`  Interventions: ${arm.interventionNames.join(', ')}`);
      }
    }

    // Outcomes — render every item present in the (already filtered) study.
    const renderOutcomeList = (heading: string, list: ProtocolOutcome[], total?: number) => {
      lines.push('');
      const suffix = total != null && total > list.length ? ` (${list.length} of ${total})` : '';
      lines.push(`## ${heading}${suffix}`);
      for (const o of list) {
        lines.push(`- ${o.measure}${o.timeFrame ? ` [${o.timeFrame}]` : ''}`);
        if (o.description) lines.push(`  ${o.description.trim()}`);
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
        lines.push(`- ${contactLine(c)}`);
      }
    }

    // Overall officials — study leadership, distinct from the central contacts.
    if (contacts.overallOfficials?.length) {
      lines.push('');
      lines.push('## Overall Officials');
      for (const official of contacts.overallOfficials) {
        const parts = [official.name, official.role, official.affiliation].filter(Boolean);
        if (parts.length) lines.push(`- ${parts.join(' | ')}`);
      }
    }

    // Locations — render every site present in the (already filtered) study.
    // A nearLocation filter that matched nothing still renders the header and the
    // reason: omitting the section makes "sites exist, none within the radius"
    // indistinguishable from "this study publishes no sites at all", which is the
    // opposite conclusion (#96). A study with no upstream sites leaves meta.nearLocation
    // unset (applyFilters never runs the filter), so it still renders nothing.
    const locs = (contacts.locations ?? []) as LocationWithDistance[];
    if (locs.length || meta.nearLocation) {
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
      if (locs.length === 0) {
        // All-sites-dropped-for-missing-coordinates and all-sites-too-far are
        // different situations and get different recovery guidance.
        const noun = total === 1 ? 'site' : 'sites';
        lines.push(
          meta.locationsWithoutGeo === total
            ? `No sites could be matched by distance — all ${total} published ${noun} lack coordinates. Omit nearLocation to see the full list.`
            : `No sites within the requested radius. Widen radiusMi, or omit nearLocation to see all ${total} ${noun}.`,
        );
      }
      for (const loc of locs) {
        const parts = [loc.facility, loc.city, loc.state, loc.zip, loc.country].filter(Boolean);
        const statusNote = loc.status ? ` [${loc.status}]` : '';
        const geoNote = loc.geoPoint ? ` (${loc.geoPoint.lat}, ${loc.geoPoint.lon})` : '';
        const distNote = loc.distanceMi != null ? ` (${loc.distanceMi.toFixed(1)} mi)` : '';
        lines.push(`- ${parts.join(', ')}${statusNote}${geoNote}${distNote}`);
        for (const c of loc.contacts ?? []) {
          const line = contactLine(c);
          if (line) lines.push(`  Contact: ${line}`);
        }
      }
    }

    // IPD sharing
    if (
      ipd.ipdSharing ||
      ipd.description ||
      ipd.timeFrame ||
      ipd.infoTypes?.length ||
      ipd.accessCriteria ||
      ipd.url
    ) {
      lines.push('');
      lines.push('## IPD Sharing');
      if (ipd.ipdSharing) lines.push(`**Plan:** ${ipd.ipdSharing}`);
      if (ipd.infoTypes?.length) lines.push(`**Info Types:** ${ipd.infoTypes.join(', ')}`);
      if (ipd.timeFrame) lines.push(`**Time Frame:** ${ipd.timeFrame}`);
      if (ipd.accessCriteria) lines.push(`**Access Criteria:** ${ipd.accessCriteria}`);
      if (ipd.url) lines.push(`**URL:** ${ipd.url}`);
      if (ipd.description) lines.push(ipd.description.trim());
    }

    // Documents (protocol, consent, SAP, etc.)
    const docModule = s.documentSection?.largeDocumentModule;
    const docs = docModule?.largeDocs;
    if (docModule?.noSap != null)
      lines.push(`**No Statistical Analysis Plan:** ${yesNo(docModule.noSap)}`);
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
        const detail = [
          d.typeAbbrev && d.typeAbbrev !== label ? `type: ${d.typeAbbrev}` : '',
          d.date ? `document date: ${d.date}` : '',
          d.filename && d.filename !== label ? `file: ${d.filename}` : '',
          d.size != null ? `${d.size} bytes` : '',
        ].filter(Boolean);
        if (detail.length) lines.push(`  ${detail.join(' | ')}`);
      }
    }
    // References
    if (
      references.references?.length ||
      references.seeAlsoLinks?.length ||
      references.availIpds?.length
    ) {
      lines.push('');
      const refCount = references.references?.length ?? 0;
      const refSuffix =
        meta.totalReferences != null && meta.totalReferences > refCount
          ? ` (${refCount} of ${meta.totalReferences})`
          : '';
      lines.push(`## References${refSuffix}`);
      for (const r of references.references ?? []) {
        const pmid = r.pmid ? ` (PMID: ${r.pmid})` : '';
        const type = r.type ? ` [${r.type}]` : '';
        lines.push(`- ${r.citation ?? 'Citation unavailable'}${pmid}${type}`);
        for (const retraction of r.retractions ?? []) {
          const parts = [
            retraction.source,
            retraction.pmid ? `PMID: ${retraction.pmid}` : '',
          ].filter(Boolean);
          lines.push(`  Retracted — ${parts.join(', ')}`);
        }
      }
      for (const link of references.seeAlsoLinks ?? []) {
        lines.push(`- See also: ${link.label ?? link.url}${link.url ? ` — ${link.url}` : ''}`);
      }
      for (const availIpd of references.availIpds ?? []) {
        const parts = [availIpd.type, availIpd.id, availIpd.url, availIpd.comment].filter(Boolean);
        if (parts.length) lines.push(`- Available IPD: ${parts.join(' — ')}`);
      }
    }

    // Annotations — unposted-results and FDAAA violation notices. Rare, but the
    // reason a completed study has no results is exactly what a caller asking
    // about results needs to see.
    const annotation = s.annotationSection?.annotationModule;
    const unposted = annotation?.unpostedAnnotation;
    const violation = annotation?.violationAnnotation;
    if (unposted || violation) {
      lines.push('');
      lines.push('## Annotations');
      if (unposted?.unpostedResponsibleParty)
        lines.push(`**Unposted Responsible Party:** ${unposted.unpostedResponsibleParty}`);
      for (const event of unposted?.unpostedEvents ?? []) {
        const parts = [event.type, event.date, event.dateUnknown ? 'date unknown' : ''].filter(
          Boolean,
        );
        if (parts.length) lines.push(`- Unposted: ${parts.join(' | ')}`);
      }
      for (const event of violation?.violationEvents ?? []) {
        const parts = [
          event.type,
          event.creationDate ? `created ${event.creationDate}` : '',
          event.issuedDate ? `issued ${event.issuedDate}` : '',
          event.releaseDate ? `released ${event.releaseDate}` : '',
          event.postedDate ? `posted ${event.postedDate}` : '',
          event.resetDate ? `reset ${event.resetDate}` : '',
          event.dateUnknown ? 'date unknown' : '',
        ].filter(Boolean);
        lines.push(`- Violation: ${parts.join(' | ')}`);
        if (event.description) lines.push(`  ${event.description.trim()}`);
      }
    }

    // Registry submission tracking from derivedSection.
    const misc = s.derivedSection?.miscInfoModule;
    if (misc?.removedCountries?.length)
      lines.push(`**Removed Countries:** ${misc.removedCountries.join(', ')}`);
    const tracking = misc?.submissionTracking;
    if (tracking) {
      const trackingParts = labeledParts([
        ['Estimated Results First Submit', tracking.estimatedResultsFirstSubmitDate],
        ['First MCP Post', dateWithType(tracking.firstMcpInfo?.postDateStruct)],
      ]);
      if (trackingParts.length) lines.push(`**Submission Tracking:** ${trackingParts.join(' | ')}`);
      for (const info of tracking.submissionInfos ?? []) {
        const parts = [
          info.mcpReleaseN != null ? `MCP release ${info.mcpReleaseN}` : '',
          info.releaseDate ? `released ${info.releaseDate}` : '',
          info.unreleaseDate ? `unreleased ${info.unreleaseDate}` : '',
          info.unreleaseDateUnknown ? 'unrelease date unknown' : '',
          info.resetDate ? `reset ${info.resetDate}` : '',
        ].filter(Boolean);
        if (parts.length) lines.push(`- Submission: ${parts.join(' | ')}`);
      }
    }

    // Filters Applied footer — guarantees every filtersApplied field appears
    // in content[] too (format-parity), independent of which sections rendered.
    const filterParts: string[] = [];
    if (meta.locationLimit != null) filterParts.push(`locationLimit=${meta.locationLimit}`);
    if (meta.outcomeLimit != null) filterParts.push(`outcomeLimit=${meta.outcomeLimit}`);
    if (meta.referenceLimit != null) filterParts.push(`referenceLimit=${meta.referenceLimit}`);
    if (meta.totalLocations != null) filterParts.push(`totalLocations=${meta.totalLocations}`);
    if (meta.locationsWithoutGeo != null)
      filterParts.push(`locationsWithoutGeo=${meta.locationsWithoutGeo}`);
    if (meta.totalSecondaryOutcomes != null)
      filterParts.push(`totalSecondaryOutcomes=${meta.totalSecondaryOutcomes}`);
    if (meta.totalOtherOutcomes != null)
      filterParts.push(`totalOtherOutcomes=${meta.totalOtherOutcomes}`);
    if (meta.totalReferences != null) filterParts.push(`totalReferences=${meta.totalReferences}`);
    if (meta.nearLocation) {
      filterParts.push(
        `nearLocation=(lat=${meta.nearLocation.lat}, lon=${meta.nearLocation.lon}, radiusMi=${meta.nearLocation.radiusMi})`,
      );
    }
    if (filterParts.length) {
      lines.push('');
      lines.push(`*Filters applied: ${filterParts.join(', ')}*`);
    }

    const versionHolder = misc?.versionHolder;
    if (versionHolder) {
      lines.push('');
      lines.push(`*Data version: ${versionHolder}*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
