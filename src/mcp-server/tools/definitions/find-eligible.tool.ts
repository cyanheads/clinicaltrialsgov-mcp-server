/**
 * @fileoverview Match patient demographics to eligible recruiting clinical trials.
 * @module mcp-server/tools/definitions/find-eligible.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape } from '@/services/clinical-trials/types.js';

/** Fields requested for eligibility evaluation. */
const ELIGIBLE_FIELDS = [
  'NCTId',
  'BriefTitle',
  'BriefSummary',
  'OverallStatus',
  'Phase',
  'LeadSponsorName',
  'EnrollmentCount',
  'Condition',
  'InterventionName',
  'MinimumAge',
  'MaximumAge',
  'Sex',
  'HealthyVolunteers',
  'LocationFacility',
  'LocationCity',
  'LocationState',
  'LocationCountry',
  'LocationStatus',
];

export const findEligible = tool('clinicaltrials_find_eligible', {
  description:
    'Match patient demographics and conditions to eligible recruiting clinical trials. Builds an optimized ClinicalTrials.gov query from a patient profile (age, sex, conditions, location) and returns studies with eligibility and location fields for the caller to evaluate.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    age: z.number().int().min(0).max(120).describe('Patient age in years.'),
    sex: z.enum(['Female', 'Male', 'All']).describe('Biological sex.'),
    conditions: z
      .array(z.string())
      .min(1)
      .describe('Medical conditions or diagnoses. E.g., ["Type 2 Diabetes", "Hypertension"].'),
    location: z
      .object({
        country: z.string().describe('Country name. E.g., "United States".'),
        state: z.string().optional().describe('State or province.'),
        city: z.string().optional().describe('City name.'),
      })
      .describe('Patient location.'),
    healthyVolunteer: z
      .boolean()
      .default(false)
      .describe(
        'Whether the patient is a healthy volunteer. When true, only studies accepting healthy volunteers are queried.',
      ),
    recruitingOnly: z.boolean().default(true).describe('Only include actively recruiting studies.'),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum results to return.'),
  }),

  output: z.object({
    studies: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Matching studies with eligibility and location fields.'),
    totalCount: z.number().optional().describe('Total matching studies from the API.'),
    searchCriteria: z
      .object({
        conditions: z.array(z.string()).describe('Conditions searched.'),
        location: z.string().describe('Location searched.'),
        age: z.number().describe('Patient age.'),
        sex: z.string().describe('Patient sex.'),
      })
      .describe('Search criteria used.'),
    noMatchHints: z
      .array(z.string())
      .optional()
      .describe('Hints when no studies match, with suggestions to broaden the search.'),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();

    const conditionQuery = input.conditions
      .map((c) => (c.includes(' ') ? `"${c}"` : c))
      .join(' OR ');

    const locationParts = [input.location.city, input.location.state, input.location.country].filter(
      Boolean,
    );
    const locationQuery = locationParts.join(', ');

    const statusFilter = input.recruitingOnly ? ['RECRUITING', 'NOT_YET_RECRUITING'] : undefined;

    const advancedParts: string[] = [
      `AREA[MinimumAge]RANGE[MIN, ${input.age} years]`,
      `AREA[MaximumAge]RANGE[${input.age} years, MAX]`,
    ];
    if (input.sex !== 'All') {
      advancedParts.push(`(AREA[Sex]ALL OR AREA[Sex]${input.sex.toUpperCase()})`);
    }
    if (input.healthyVolunteer) {
      advancedParts.push('AREA[HealthyVolunteers]true');
    }

    ctx.log.info('Finding eligible studies', {
      conditions: input.conditions,
      location: locationQuery,
      age: input.age,
      sex: input.sex,
    });

    const result = await service.searchStudies(
      {
        queryCond: conditionQuery,
        queryLocn: locationQuery,
        filterOverallStatus: statusFilter,
        filterAdvanced: advancedParts.join(' AND '),
        fields: ELIGIBLE_FIELDS,
        pageSize: input.maxResults,
        countTotal: true,
      },
      ctx,
    );

    ctx.log.info('Eligibility search complete', {
      returned: result.studies.length,
      totalCount: result.totalCount,
    });

    let noMatchHints: string[] | undefined;
    if (result.studies.length === 0) {
      noMatchHints = [
        `No studies found for "${input.conditions.join(', ')}" matching the specified criteria.`,
      ];
      if (input.age <= 1 || input.age >= 100)
        noMatchHints.push(
          `Age ${input.age} is at the extreme of typical trial ranges. Few trials enroll this age group.`,
        );
      if (input.sex !== 'All')
        noMatchHints.push('Try sex="All" to include studies not restricted by sex.');
      if (input.healthyVolunteer)
        noMatchHints.push(
          'Many studies do not accept healthy volunteers. Set healthyVolunteer=false if the patient has a relevant condition.',
        );
      if (input.recruitingOnly)
        noMatchHints.push(
          'Set recruitingOnly=false to include completed, active, and not-yet-recruiting studies.',
        );
      if (input.location.city || input.location.state)
        noMatchHints.push(
          'Try searching with just the country to find studies in other cities/states.',
        );
    }

    return {
      studies: result.studies,
      totalCount: result.totalCount,
      searchCriteria: {
        conditions: input.conditions,
        location: locationQuery,
        age: input.age,
        sex: input.sex,
      },
      ...(noMatchHints ? { noMatchHints } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const count = result.studies.length;

    if (count === 0) {
      lines.push('No eligible studies found.');
      if (result.noMatchHints?.length) {
        for (const hint of result.noMatchHints) lines.push(`- ${hint}`);
      }
    } else {
      lines.push(
        result.totalCount !== undefined && result.totalCount > count
          ? `Found ${result.totalCount} eligible studies (showing ${count})`
          : `Found ${count} eligible studies`,
      );
      for (const study of result.studies.slice(0, 5)) {
        const s = study as RawStudyShape;
        const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
        const title = s.protocolSection?.identificationModule?.briefTitle ?? 'Untitled';
        const status = s.protocolSection?.statusModule?.overallStatus ?? '';
        lines.push(`- ${nctId}: ${title}${status ? ` [${status}]` : ''}`);
      }
      if (count > 5) lines.push(`... and ${count - 5} more`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
