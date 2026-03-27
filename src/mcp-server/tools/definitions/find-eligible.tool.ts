/**
 * @fileoverview Match patient demographics to eligible recruiting clinical trials.
 * @module mcp-server/tools/definitions/find-eligible.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
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

/** Parse an age string like "18 Years" or "6 Months" to years. */
function parseAgeYears(ageStr: string | undefined): number | undefined {
  if (!ageStr) return;
  const match = ageStr.match(/^(\d+)\s*(year|month|week|day)/i);
  if (!match?.[1] || !match[2]) return;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('year')) return value;
  if (unit.startsWith('month')) return value / 12;
  if (unit.startsWith('week')) return value / 52;
  if (unit.startsWith('day')) return value / 365;
  return;
}

/** Score a study's location proximity to the patient. Higher = better match. */
function locationScore(
  study: RawStudyShape,
  location: {
    country: string;
    state: string | undefined;
    city: string | undefined;
  },
): number {
  const locations = study.protocolSection?.contactsLocationsModule?.locations ?? [];
  let best = 0;
  for (const loc of locations) {
    if (loc.country?.toLowerCase() !== location.country.toLowerCase()) continue;
    let score = 1;
    if (location.state && loc.state?.toLowerCase() === location.state.toLowerCase()) {
      score = 2;
      if (location.city && loc.city?.toLowerCase() === location.city.toLowerCase()) {
        score = 3;
      }
    }
    best = Math.max(best, score);
  }
  return best;
}

/** Check if a study's eligibility matches the patient profile. */
function passesPostFilter(
  study: RawStudyShape,
  age: number,
  sex: string,
  country: string,
  healthyVolunteer: boolean,
): boolean {
  const elig = study.protocolSection?.eligibilityModule;
  if (!elig) return true;

  const minAge = parseAgeYears(elig.minimumAge);
  if (minAge !== undefined && age < minAge) return false;

  const maxAge = parseAgeYears(elig.maximumAge);
  if (maxAge !== undefined && age > maxAge) return false;

  if (elig.sex && elig.sex !== 'ALL' && sex !== 'All') {
    if (elig.sex !== sex.toUpperCase()) return false;
  }

  if (healthyVolunteer && elig.healthyVolunteers === false) return false;

  const locations = study.protocolSection?.contactsLocationsModule?.locations ?? [];
  if (locations.length > 0) {
    const hasCountry = locations.some((l) => l.country?.toLowerCase() === country.toLowerCase());
    if (!hasCountry) return false;
  }

  return true;
}

/** Extract a structured eligible study record from raw API data. */
function formatEligibleStudy(
  study: RawStudyShape,
  matchReasons: string[],
  patientLocation: {
    country: string;
    state: string | undefined;
    city: string | undefined;
  },
) {
  const proto = study.protocolSection;
  const ident = proto?.identificationModule;
  const status = proto?.statusModule;
  const design = proto?.designModule;
  const sponsor = proto?.sponsorCollaboratorsModule?.leadSponsor;
  const elig = proto?.eligibilityModule;
  const allLocations = proto?.contactsLocationsModule?.locations ?? [];

  const countryLocations = allLocations.filter(
    (l) => l.country?.toLowerCase() === patientLocation.country.toLowerCase(),
  );

  return {
    nctId: ident?.nctId ?? '',
    title: ident?.briefTitle ?? '',
    briefSummary: proto?.descriptionModule?.briefSummary,
    matchReasons,
    eligibility: {
      ageRange: [elig?.minimumAge ?? 'N/A', elig?.maximumAge ?? 'N/A'].join(' to '),
      sex: elig?.sex ?? 'ALL',
      healthyVolunteers: elig?.healthyVolunteers,
    },
    locations: countryLocations.slice(0, 5).map((l) => ({
      facility: l.facility,
      city: l.city,
      state: l.state,
      country: l.country,
      status: l.status,
    })),
    studyDetails: {
      phase: design?.phases?.join(', '),
      status: status?.overallStatus ?? '',
      enrollment: design?.enrollmentInfo?.count,
      sponsor: sponsor?.name,
    },
  };
}

export const findEligible = tool('clinicaltrials_find_eligible', {
  description: `Match patient demographics and conditions to eligible recruiting clinical trials. Takes a patient profile (age, sex, conditions, location) and returns studies the patient may qualify for, with match explanations. Internally builds optimized queries with demographic filters.`,
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
        'Whether the patient is a healthy volunteer (no relevant medical conditions). Studies that do not accept healthy volunteers will be excluded.',
      ),
    recruitingOnly: z.boolean().default(true).describe('Only include actively recruiting studies.'),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum results to return.'),
  }),

  output: z.object({
    eligibleStudies: z
      .array(
        z.object({
          nctId: z.string().describe('NCT identifier.'),
          title: z.string().describe('Brief study title.'),
          briefSummary: z.string().optional().describe('Study summary.'),
          matchReasons: z.array(z.string()).describe('Why the patient may qualify.'),
          eligibility: z
            .object({
              ageRange: z.string().describe('Age range, e.g., "18 Years to 65 Years".'),
              sex: z.string().describe('Sex eligibility.'),
              healthyVolunteers: z.boolean().optional().describe('Accepts healthy volunteers.'),
            })
            .describe('Eligibility criteria summary.'),
          locations: z
            .array(
              z.object({
                facility: z.string().optional().describe('Facility name.'),
                city: z.string().optional().describe('City.'),
                state: z.string().optional().describe('State/province.'),
                country: z.string().optional().describe('Country.'),
                status: z.string().optional().describe('Recruitment status.'),
              }),
            )
            .describe('Study locations in patient region.'),
          studyDetails: z
            .object({
              phase: z.string().optional().describe('Trial phase.'),
              status: z.string().describe('Overall status.'),
              enrollment: z.number().optional().describe('Target enrollment.'),
              sponsor: z.string().optional().describe('Lead sponsor.'),
            })
            .describe('Study details.'),
        }),
      )
      .describe('Matching eligible studies ranked by location proximity.'),
    totalMatches: z.number().describe('Total eligible studies found before maxResults cap.'),
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
      .describe('Hints about why no studies matched, with suggestions to broaden the search.'),
  }),

  async handler(input, ctx) {
    const config = getServerConfig();
    const service = getClinicalTrialsService();

    // Build condition query — quote multi-word terms, join with OR
    const conditionQuery = input.conditions
      .map((c) => (c.includes(' ') ? `"${c}"` : c))
      .join(' OR ');

    // Build location query
    const locationParts = [
      input.location.city,
      input.location.state,
      input.location.country,
    ].filter(Boolean);
    const locationQuery = locationParts.join(', ');

    // Build status filter
    const statusFilter = input.recruitingOnly ? ['RECRUITING', 'NOT_YET_RECRUITING'] : undefined;

    // Build advanced filter for age and sex
    const advancedParts: string[] = [
      `AREA[MinimumAge]RANGE[MIN, ${input.age} years]`,
      `AREA[MaximumAge]RANGE[${input.age} years, MAX]`,
    ];
    if (input.sex !== 'All') {
      advancedParts.push(`(AREA[Sex]ALL OR AREA[Sex]${input.sex.toUpperCase()})`);
    }
    const advancedFilter = advancedParts.join(' AND ');

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
        filterAdvanced: advancedFilter,
        fields: ELIGIBLE_FIELDS,
        pageSize: config.maxEligibleCandidates,
        countTotal: true,
      },
      ctx,
    );

    // Normalize location (bridge optional → required for exactOptionalPropertyTypes)
    const patientLoc: {
      country: string;
      state: string | undefined;
      city: string | undefined;
    } = {
      country: input.location.country,
      state: input.location.state,
      city: input.location.city,
    };

    // Post-filter and score
    const scored: Array<{
      study: RawStudyShape;
      score: number;
      reasons: string[];
    }> = [];

    for (const raw of result.studies) {
      const study = raw as RawStudyShape;
      if (
        !passesPostFilter(study, input.age, input.sex, patientLoc.country, input.healthyVolunteer)
      )
        continue;

      const score = locationScore(study, patientLoc);
      const reasons: string[] = [];

      const conditions = study.protocolSection?.conditionsModule?.conditions ?? [];
      if (conditions.length > 0) reasons.push(`Conditions: ${conditions.join(', ')}`);

      const elig = study.protocolSection?.eligibilityModule ?? {};
      reasons.push(
        `Age ${input.age} within range (${elig.minimumAge ?? 'any'} to ${elig.maximumAge ?? 'any'})`,
      );
      if (input.sex !== 'All') reasons.push(`Sex: ${input.sex} eligible`);
      if (input.healthyVolunteer) reasons.push('Accepts healthy volunteers');

      if (score >= 3) reasons.push(`Location: study site in ${patientLoc.city}`);
      else if (score >= 2) reasons.push(`Location: study site in ${patientLoc.state}`);
      else if (score >= 1) reasons.push(`Location: study site in ${patientLoc.country}`);

      scored.push({ study, score, reasons });
    }

    // Sort by location proximity descending
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, input.maxResults);

    const eligibleStudies = top.map(({ study, reasons }) =>
      formatEligibleStudy(study, reasons, patientLoc),
    );

    ctx.log.info('Eligibility matching complete', {
      evaluated: result.studies.length,
      passed: scored.length,
      returned: eligibleStudies.length,
    });

    // Build hints when no studies matched to help the caller broaden their search
    let noMatchHints: string[] | undefined;
    if (scored.length === 0) {
      noMatchHints = [];
      const apiTotal = result.totalCount ?? result.studies.length;
      if (apiTotal === 0) {
        noMatchHints.push(
          `No studies found for "${input.conditions.join(', ')}" in ${locationQuery}. Try broader condition terms or a wider location (e.g., country only).`,
        );
      } else {
        noMatchHints.push(
          `${apiTotal} candidate studies found but none passed eligibility filters.`,
        );
        if (input.age <= 1 || input.age >= 100)
          noMatchHints.push(
            `Age ${input.age} is at the extreme of typical trial ranges. Few trials enroll this age group.`,
          );
        if (input.sex !== 'All')
          noMatchHints.push(`Try sex="All" to include studies not restricted by sex.`);
        if (input.healthyVolunteer)
          noMatchHints.push(
            'Many studies do not accept healthy volunteers. Set healthyVolunteer=false if the patient has a relevant condition.',
          );
      }
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
      eligibleStudies,
      totalMatches: scored.length,
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
    lines.push(
      `Found ${result.totalMatches} eligible studies (showing ${result.eligibleStudies.length})`,
    );
    if (result.noMatchHints?.length) {
      lines.push('');
      for (const hint of result.noMatchHints) lines.push(`- ${hint}`);
    }
    for (const [i, s] of result.eligibleStudies.entries()) {
      lines.push(`\n${i + 1}. **${s.nctId}**: ${s.title}`);
      lines.push(
        `   Status: ${s.studyDetails.status} | Phase: ${s.studyDetails.phase ?? 'N/A'} | Sponsor: ${s.studyDetails.sponsor ?? 'N/A'}`,
      );
      lines.push(`   Eligibility: ${s.eligibility.ageRange}, ${s.eligibility.sex}`);
      lines.push(`   Match: ${s.matchReasons.join('; ')}`);
      const loc = s.locations[0];
      if (loc) {
        lines.push(
          `   Location: ${[loc.facility, loc.city, loc.state, loc.country].filter(Boolean).join(', ')}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
