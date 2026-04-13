/**
 * @fileoverview Single study lookup by NCT ID. Returns the full study record including
 * protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations.
 * @module mcp-server/tools/definitions/get-study.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';

export const getStudy = tool('clinicaltrials_get_study_record', {
  description:
    'Fetch a single clinical study by NCT ID. Returns the full study record including protocol details, eligibility criteria, outcomes, arms, interventions, contacts, and locations.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    nctId: z
      .string()
      .regex(/^NCT\d{8}$/)
      .describe('NCT identifier (e.g., NCT03722472).'),
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

    const lines: string[] = [];

    // Header
    const nctId = id.nctId ?? 'Unknown';
    const title = id.briefTitle ?? id.officialTitle ?? 'Untitled';
    lines.push(`# ${nctId}: ${title}`);
    if (id.acronym) lines.push(`**Acronym:** ${id.acronym}`);

    // Status / Design
    const statusParts: string[] = [
      status.overallStatus,
      design.studyType,
      ...(design.phases ?? []),
      design.enrollmentInfo?.count != null ? `N=${design.enrollmentInfo.count}` : undefined,
    ].filter((v): v is string => v != null);
    if (statusParts.length) lines.push(`**Status:** ${statusParts.join(' | ')}`);

    // Dates
    const startDate = status.startDateStruct?.date;
    const primaryCompletion = status.primaryCompletionDateStruct?.date;
    const completion = status.completionDateStruct?.date;
    const dateParts: string[] = [];
    if (startDate) dateParts.push(`Start: ${startDate}`);
    if (primaryCompletion) dateParts.push(`Primary Completion: ${primaryCompletion}`);
    if (completion) dateParts.push(`Completion: ${completion}`);
    if (dateParts.length) lines.push(`**Dates:** ${dateParts.join(' | ')}`);

    // Sponsor
    if (sponsor.leadSponsor?.name) {
      const cls = sponsor.leadSponsor.class ? ` (${sponsor.leadSponsor.class})` : '';
      lines.push(`**Sponsor:** ${sponsor.leadSponsor.name}${cls}`);
    }

    // Conditions
    if (cond.conditions?.length) lines.push(`**Conditions:** ${cond.conditions.join(', ')}`);

    // Brief summary
    if (desc.briefSummary) {
      lines.push('');
      lines.push('## Summary');
      lines.push(desc.briefSummary.trim());
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

    // Primary outcomes
    if (outcomes.primaryOutcomes?.length) {
      lines.push('');
      lines.push('## Primary Outcomes');
      for (const o of outcomes.primaryOutcomes) {
        lines.push(`- ${o.measure}${o.timeFrame ? ` [${o.timeFrame}]` : ''}`);
      }
    }
    if (outcomes.secondaryOutcomes?.length) {
      lines.push('');
      lines.push('## Secondary Outcomes');
      const shown = outcomes.secondaryOutcomes.slice(0, 5);
      for (const o of shown) {
        lines.push(`- ${o.measure}${o.timeFrame ? ` [${o.timeFrame}]` : ''}`);
      }
      if (outcomes.secondaryOutcomes.length > 5)
        lines.push(`... and ${outcomes.secondaryOutcomes.length - 5} more`);
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

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
