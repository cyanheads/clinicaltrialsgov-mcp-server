/**
 * @fileoverview Single study lookup by NCT ID. Returns the full study record including
 * protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations.
 * @module mcp-server/tools/definitions/get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';
import { nctIdSchema } from '../utils/_schemas.js';

export const getStudy = tool('clinicaltrials_get_study_record', {
  description:
    'Fetch a single clinical study by NCT ID. Returns the full study record including protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    nctId: nctIdSchema.describe('NCT identifier (e.g., NCT03722472).'),
  }),

  output: z.object({
    study: z.record(z.string(), z.unknown()).describe('Full study record.'),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const study = await service.getStudy(input.nctId, ctx);
    ctx.log.info('Study fetched', { nctId: input.nctId });
    return { study };
  },

  format: (result) => {
    const s = result.study as RawStudyShape;
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

    // Outcomes
    const renderOutcomeList = (
      heading: string,
      list: Array<{ description?: string; measure?: string; timeFrame?: string }>,
      limit?: number,
    ) => {
      lines.push('');
      lines.push(`## ${heading}`);
      const shown = limit != null ? list.slice(0, limit) : list;
      for (const o of shown) {
        lines.push(`- ${o.measure}${o.timeFrame ? ` [${o.timeFrame}]` : ''}`);
      }
      if (limit != null && list.length > limit) {
        lines.push(`... and ${list.length - limit} more`);
      }
    };
    if (outcomes.primaryOutcomes?.length)
      renderOutcomeList('Primary Outcomes', outcomes.primaryOutcomes);
    if (outcomes.secondaryOutcomes?.length)
      renderOutcomeList('Secondary Outcomes', outcomes.secondaryOutcomes, 5);
    if (outcomes.otherOutcomes?.length)
      renderOutcomeList('Other Outcomes', outcomes.otherOutcomes, 5);

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

    // Locations
    if (contacts.locations?.length) {
      const locs = contacts.locations;
      lines.push('');
      lines.push(`## Locations (${locs.length} total)`);
      const recruiting = locs.filter((l) => l.status === 'RECRUITING');
      const toShow = (recruiting.length > 0 ? recruiting : locs).slice(0, 10);
      for (const loc of toShow) {
        const parts = [loc.facility, loc.city, loc.state, loc.country].filter(Boolean);
        const statusNote = loc.status ? ` [${loc.status}]` : '';
        lines.push(`- ${parts.join(', ')}${statusNote}`);
      }
      if (locs.length > 10) lines.push(`... and ${locs.length - 10} more`);
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

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
