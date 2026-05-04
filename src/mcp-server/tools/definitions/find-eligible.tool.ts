/**
 * @fileoverview Match patient demographics to eligible recruiting clinical trials.
 * @module mcp-server/tools/definitions/find-eligible.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape, StudyLocation } from '@/services/clinical-trials/types.js';
import { formatRemainingStudyFields } from '../utils/format-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

interface UserLocation {
  city?: string | undefined;
  country: string;
  state?: string | undefined;
}

/**
 * Score a study location against the user's stated location. Higher = better
 * match. City equality dominates, then state, then country; recruiting status
 * breaks ties between geographically-equivalent sites.
 */
function locationMatchScore(loc: StudyLocation, user: UserLocation): number {
  const eq = (a?: string, b?: string) =>
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
  let score = 0;
  if (eq(loc.city, user.city)) score += 4;
  if (eq(loc.state, user.state)) score += 2;
  if (eq(loc.country, user.country)) score += 1;
  if (loc.status === 'RECRUITING') score += 0.5;
  return score;
}

/** Dot-notation prefixes already rendered by the eligible formatter. */
const ELIGIBLE_RENDERED = new Set([
  'protocolSection.identificationModule',
  'protocolSection.statusModule.overallStatus',
  'protocolSection.designModule',
  'protocolSection.sponsorCollaboratorsModule.leadSponsor',
  'protocolSection.conditionsModule',
  'protocolSection.armsInterventionsModule',
  'protocolSection.descriptionModule.briefSummary',
  'protocolSection.eligibilityModule',
  'protocolSection.contactsLocationsModule',
]);

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
  'CentralContactName',
  'CentralContactPhone',
  'CentralContactEMail',
];

export const findEligible = tool('clinicaltrials_find_eligible', {
  description:
    'Match patient demographics and conditions to eligible recruiting clinical trials. Provide age, sex, conditions, and location to find studies with matching eligibility criteria, contact information, and recruiting locations.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
    },
  ],

  input: z.object({
    age: z.number().int().min(0).max(120).describe('Patient age in years.'),
    sex: z
      .enum(['FEMALE', 'MALE', 'ALL'])
      .describe(
        "Patient's biological sex. Use 'ALL' to include studies regardless of sex restrictions.",
      ),
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
    funnel: z
      .object({
        conditionMatched: z
          .number()
          .describe('Studies matching the condition query alone (broadest stage).'),
        locationMatched: z
          .number()
          .describe('Studies matching condition + location — diagnoses geographic narrowing.'),
        demographicsMatched: z
          .number()
          .describe(
            'Studies matching the full filter set (condition + location + age/sex + status). Equal to totalCount.',
          ),
      })
      .describe(
        'Match counts at each filter stage. Diagnoses where the funnel collapsed on sparse results — e.g., conditionMatched=298 but demographicsMatched=2 means age/sex/status are the constraint.',
      ),
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

    const locationParts = [
      input.location.city,
      input.location.state,
      input.location.country,
    ].filter(Boolean);
    const locationQuery = locationParts.join(', ');

    const statusFilter = input.recruitingOnly ? ['RECRUITING', 'NOT_YET_RECRUITING'] : undefined;

    const advancedParts: string[] = [
      `AREA[MinimumAge]RANGE[MIN, ${input.age} years]`,
      `AREA[MaximumAge]RANGE[${input.age} years, MAX]`,
    ];
    if (input.sex !== 'ALL') {
      advancedParts.push(`(AREA[Sex]ALL OR AREA[Sex]${input.sex})`);
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

    // Run the main search and the two funnel-stage counts together. The
    // service throttles outbound requests at ~1 req/sec, so the calls
    // serialize at the network layer regardless — Promise.all keeps the code
    // straight rather than chaining awaits. The extra ~2s is the price of
    // diagnosing sparse results without a follow-up call.
    const [result, conditionStage, locationStage] = await Promise.all([
      service.searchStudies(
        {
          queryCond: conditionQuery,
          queryLocn: locationQuery,
          filterOverallStatus: statusFilter,
          filterAdvanced: advancedParts.join(' AND '),
          fields: ELIGIBLE_FIELDS,
          pageSize: input.maxResults,
          countTotal: true,
          // Eligibility matches are about who can enroll, not about enrollment
          // count quality. Don't drop matches just because the sponsor didn't
          // publish a count.
          includeUnknownEnrollment: true,
        },
        ctx,
      ),
      service.searchStudies(
        {
          queryCond: conditionQuery,
          pageSize: 0,
          countTotal: true,
          includeUnknownEnrollment: true,
        },
        ctx,
      ),
      service.searchStudies(
        {
          queryCond: conditionQuery,
          queryLocn: locationQuery,
          pageSize: 0,
          countTotal: true,
          includeUnknownEnrollment: true,
        },
        ctx,
      ),
    ]);

    ctx.log.info('Eligibility search complete', {
      returned: result.studies.length,
      totalCount: result.totalCount,
    });

    // Sort each study's locations by match to the user's input so the most
    // relevant sites surface first in both the structured payload and the
    // truncated format() rendering. Stable sort preserves upstream order for
    // sites with equal match scores.
    for (const study of result.studies) {
      const locs = (study as RawStudyShape).protocolSection?.contactsLocationsModule?.locations;
      if (locs && locs.length > 1) {
        locs.sort(
          (a, b) => locationMatchScore(b, input.location) - locationMatchScore(a, input.location),
        );
      }
    }

    let noMatchHints: string[] | undefined;
    if (result.studies.length === 0) {
      noMatchHints = [
        `No studies found for "${input.conditions.join(', ')}" matching the specified criteria.`,
      ];
      if (input.age <= 1 || input.age >= 100)
        noMatchHints.push(
          `Age ${input.age} is at the extreme of typical trial ranges. Few trials enroll this age group.`,
        );
      if (input.sex !== 'ALL')
        noMatchHints.push('Try sex="ALL" to include studies not restricted by sex.');
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
      funnel: {
        conditionMatched: conditionStage.totalCount ?? 0,
        locationMatched: locationStage.totalCount ?? 0,
        demographicsMatched: result.totalCount ?? 0,
      },
      ...(noMatchHints ? { noMatchHints } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const count = result.studies.length;
    const sc = result.searchCriteria;

    if (count === 0) {
      lines.push('No eligible studies found.');
    } else {
      lines.push(
        result.totalCount !== undefined && result.totalCount > count
          ? `Found ${result.totalCount} eligible studies (showing ${count})`
          : `Found ${count} eligible studies`,
      );
    }

    lines.push(
      `Search: conditions=[${sc.conditions.join(', ')}] | location=${sc.location} | age=${sc.age} | sex=${sc.sex}`,
    );
    const f = result.funnel;
    lines.push(
      `Funnel: ${f.conditionMatched} condition → ${f.locationMatched} + location → ${f.demographicsMatched} + demographics`,
    );
    if (result.noMatchHints?.length) {
      for (const hint of result.noMatchHints) lines.push(`- ${hint}`);
    }

    if (count > 0) {
      lines.push('');
      for (const study of result.studies) {
        const s = study as RawStudyShape;
        const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
        const title = s.protocolSection?.identificationModule?.briefTitle ?? 'Untitled';
        const status = s.protocolSection?.statusModule?.overallStatus ?? '';
        const elig = s.protocolSection?.eligibilityModule ?? {};
        const locs = s.protocolSection?.contactsLocationsModule?.locations ?? [];

        lines.push(`**${nctId}**: ${title} [${status}]`);

        // Study metadata
        const phases = s.protocolSection?.designModule?.phases;
        const enrollment = s.protocolSection?.designModule?.enrollmentInfo?.count;
        const sponsor = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name;
        const conditions = s.protocolSection?.conditionsModule?.conditions;
        const interventions = s.protocolSection?.armsInterventionsModule?.interventions;
        const studyMeta: string[] = [];
        if (phases?.length) studyMeta.push(phases.join('/'));
        if (enrollment != null) studyMeta.push(`N=${enrollment}`);
        if (sponsor) studyMeta.push(sponsor);
        if (conditions?.length) studyMeta.push(conditions.join(', '));
        if (studyMeta.length) lines.push(`  ${studyMeta.join(' | ')}`);
        if (interventions?.length) {
          const names = interventions
            .map((i) => i.name)
            .filter(Boolean)
            .slice(0, 3);
          if (names.length) lines.push(`  Interventions: ${names.join(', ')}`);
        }
        const summary = s.protocolSection?.descriptionModule?.briefSummary;
        if (summary) {
          lines.push(
            `  Summary: ${summary.length > 200 ? `${summary.slice(0, 200)}...` : summary}`,
          );
        }

        // Eligibility criteria summary
        const eligParts: string[] = [];
        if (elig.minimumAge && elig.maximumAge)
          eligParts.push(`Age: ${elig.minimumAge}–${elig.maximumAge}`);
        else if (elig.minimumAge) eligParts.push(`Age: ≥${elig.minimumAge}`);
        else if (elig.maximumAge) eligParts.push(`Age: ≤${elig.maximumAge}`);
        if (elig.sex) eligParts.push(`Sex: ${elig.sex}`);
        if (elig.healthyVolunteers != null)
          eligParts.push(`Healthy Volunteers: ${elig.healthyVolunteers ? 'Yes' : 'No'}`);
        if (eligParts.length) lines.push(`  Eligibility: ${eligParts.join(' | ')}`);

        // Locations are pre-sorted by match-score in the handler, so the top
        // 3 are the most relevant sites — typically the user's city/state.
        if (locs.length > 0) {
          const toShow = locs.slice(0, 3);
          const locStr = toShow
            .map((l) => [l.facility, l.city, l.state, l.country].filter(Boolean).join(', '))
            .join(' | ');
          const remaining = locs.length - toShow.length;
          lines.push(`  Locations: ${locStr}${remaining > 0 ? ` (+${remaining} more)` : ''}`);
        }

        // Central contacts
        const centralContacts = s.protocolSection?.contactsLocationsModule?.centralContacts ?? [];
        if (centralContacts.length > 0) {
          const contactStr = centralContacts
            .slice(0, 2)
            .map((c) => [c.name, c.phone, c.email].filter(Boolean).join(', '))
            .join(' | ');
          lines.push(`  Contact: ${contactStr}`);
        }
        lines.push(
          ...formatRemainingStudyFields(study as Record<string, unknown>, ELIGIBLE_RENDERED),
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
