/**
 * @fileoverview Match patient demographics to eligible recruiting clinical trials.
 * @module mcp-server/tools/definitions/find-eligible.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape, StudyLocation } from '@/services/clinical-trials/types.js';
import { formatRemainingStudyFields } from '../utils/format-helpers.js';
import { blankValueMessage, firstBlankListParam, firstBlankParam } from '../utils/query-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

interface UserLocation {
  city?: string | undefined;
  country: string;
  state?: string | undefined;
}

/**
 * How closely a site's geography matches the user's stated location. City
 * equality dominates, then state, then country, so the score doubles as a match
 * tier: every site sharing the study's best score matched at the same level.
 */
function locationGeoScore(loc: StudyLocation, user: UserLocation): number {
  const eq = (a?: string, b?: string) =>
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
  let score = 0;
  if (eq(loc.city, user.city)) score += 4;
  if (eq(loc.state, user.state)) score += 2;
  if (eq(loc.country, user.country)) score += 1;
  return score;
}

/**
 * Whether a site can enroll a patient who is searching for a trial. Only
 * `RECRUITING` qualifies: `ENROLLING_BY_INVITATION` admits invited participants
 * only, `NOT_YET_RECRUITING` has not opened, and the remaining statuses
 * (`ACTIVE_NOT_RECRUITING`, `SUSPENDED`, `WITHDRAWN`, `TERMINATED`,
 * `COMPLETED`) are closed. Same definition the study-level `recruitingOnly`
 * filter applies upstream.
 */
function isRecruiting(loc: StudyLocation): boolean {
  return loc.status === 'RECRUITING';
}

/**
 * Score a study location against the user's stated location. Higher = better
 * match. Geography dominates; recruiting status breaks ties between
 * geographically-equivalent sites.
 */
function locationMatchScore(loc: StudyLocation, user: UserLocation): number {
  return locationGeoScore(loc, user) + (isRecruiting(loc) ? 0.5 : 0);
}

/** What a candidate's site list was bounded to, and how to retrieve the rest. */
interface LocationSummary {
  /** True when the locationLimit cap cut sites that matched the requested location. */
  locationsTruncated: boolean;
  /** Sites matching the requested location, before the cap. */
  matchedLocations: number;
  /** Present when no matched site is recruiting and the nearest recruiting site was added. */
  nearestRecruitingSiteAdded?: true;
  /** Tool that returns the study's complete site list. */
  retrieveFullStudyWith: 'clinicaltrials_get_study_record';
  /** Every site the study registers upstream. */
  totalLocations: number;
}

/**
 * Bound a candidate's site list to the sites that answer the caller's question.
 *
 * A location-constrained eligibility query qualifies a *study*, but the study
 * still carries every site it has ever registered — hundreds of them, dominating
 * both the payload and the answer with sites nowhere near the patient. Keep the
 * sites that matched at the narrowest level the caller's location reached (city,
 * else state, else country), then cap what survives.
 *
 * Geography alone decides the tier, so a tier can hold nothing but closed sites
 * while the study's one open site sits further out — a patient-matching answer
 * whose every shown site can enroll no one (#114). When that happens, admit the
 * nearest recruiting site alongside the tier. Admitting one site keeps the
 * local answer local; widening to that site's whole tier would trade a
 * city-precise answer for a statewide dump and reinflate the payload this bound
 * exists to hold down.
 *
 * The summary is returned only when the returned set is genuinely smaller than
 * the upstream one — reporting a bound that dropped nothing would imply a filter
 * ran where none did.
 */
function boundLocations(
  sortedLocations: StudyLocation[],
  user: UserLocation,
  limit: number,
): { locations: StudyLocation[]; summary?: LocationSummary } {
  const total = sortedLocations.length;
  let best = 0;
  for (const loc of sortedLocations) best = Math.max(best, locationGeoScore(loc, user));
  // best === 0 keeps every site: a study can qualify upstream on a facility or
  // ZIP match with no city/state/country hit, and dropping all of its sites
  // would answer with a candidate that appears to have nowhere to enroll.
  const matched = sortedLocations.filter((loc) => locationGeoScore(loc, user) === best);
  const capped = matched.slice(0, limit);
  // sortedLocations runs best-match first, so the first recruiting site below
  // the tier is the nearest one. Nothing is found when best === 0 (no site
  // scores below it) or when the study registers no recruiting site at all —
  // both leave the tier answer exactly as it was.
  const admitted = capped.some(isRecruiting)
    ? undefined
    : sortedLocations.find((loc) => isRecruiting(loc) && locationGeoScore(loc, user) < best);
  const locations = admitted ? [...capped, admitted] : capped;
  if (locations.length === total) return { locations };
  return {
    locations,
    summary: {
      totalLocations: total,
      matchedLocations: matched.length,
      locationsTruncated: matched.length > capped.length,
      ...(admitted ? { nearestRecruitingSiteAdded: true } : {}),
      retrieveFullStudyWith: 'clinicaltrials_get_study_record',
    },
  };
}

/**
 * Generic condition tokens that carry no disease-specificity. Excluded from
 * token-overlap scoring so "Cardiovascular Disease" doesn't spuriously match
 * "Von Willebrand Diseases" on the shared word "disease".
 */
const GENERIC_CONDITION_TOKENS = new Set([
  'disease',
  'diseases',
  'disorder',
  'disorders',
  'syndrome',
  'syndromes',
  'condition',
  'conditions',
]);

/** Significant (non-generic) lowercased word tokens of a condition string. */
function significantTokens(condition: string): Set<string> {
  return new Set(
    condition
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !GENERIC_CONDITION_TOKENS.has(t)),
  );
}

/**
 * Score how directly a study's own listed conditions match the patient's
 * requested conditions. ClinicalTrials.gov's `query.cond` is a fuzzy relevance
 * search that pulls in tangential trials via the MeSH umbrella (e.g. a Von
 * Willebrand bleeding-disorder trial matches "Cardiovascular Disease" through a
 * distant MeSH ancestor). This score re-ranks those tangential matches below
 * trials whose own condition list actually names a requested condition — a
 * transparent, deterministic rule, not a relevance estimate. Recall is
 * unchanged: every upstream match is still returned, only reordered.
 *
 * Tiers (best across the study's conditions × requested conditions):
 *   3 — exact match (study condition equals a requested condition)
 *   2 — every significant token of a multi-word requested condition is present
 *       in a study condition, so the study names the same concept or a more
 *       specific subtype — independent of word order ("Type 2 Diabetes" matches
 *       both "Type 2 Diabetes Mellitus" and "Diabetes Mellitus, Type 2";
 *       "Cardiovascular Disease" matches "Atherosclerotic Cardiovascular
 *       Disease"). Gated to multi-word requests so a single word like
 *       "Hypertension" does not credit the distinct disease "Pulmonary Arterial
 *       Hypertension" as a subtype — it falls to tier 1, below a genuine
 *       "Hypertension" exact match at tier 3.
 *   1 — a shared significant token ("Type 2 Diabetes" ↔ "Diabetes Mellitus")
 *   0 — no direct overlap (matched only through upstream fuzziness)
 */
export function conditionMatchScore(studyConditions: string[], requested: string[]): number {
  if (studyConditions.length === 0) return 0;
  const reqNorm = requested.map((c) => ({
    text: c.toLowerCase().trim(),
    tokens: significantTokens(c),
    // Raw word count, before generic-token stripping: "Cardiovascular Disease"
    // is multi-word even though "disease" drops out, while "Hypertension" is a
    // single word. Only multi-word requests earn tier-2 subtype credit.
    multiWord:
      c
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0).length > 1,
  }));
  let best = 0;
  for (const sc of studyConditions) {
    const text = sc.toLowerCase().trim();
    const tokens = significantTokens(sc);
    for (const req of reqNorm) {
      if (text === req.text) return 3;
      // Tier 2 — every significant token of a multi-word requested condition is
      // present in this study condition, so the study is the same concept or a
      // more specific subtype (word order independent). The multi-word gate
      // stops a single shared word from crediting a distinct disease as a
      // subtype ("Hypertension" vs "Pulmonary Arterial Hypertension").
      if (req.multiWord && req.tokens.size > 0 && [...req.tokens].every((t) => tokens.has(t))) {
        best = Math.max(best, 2);
      } else if ([...tokens].some((t) => req.tokens.has(t))) {
        best = Math.max(best, 1);
      }
    }
  }
  return best;
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
  // Rendered by the Sites line, not the field dump — otherwise it reads as a
  // stray upstream field rather than the bound the handler applied.
  'locationSummary',
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
    "Match patient demographics and conditions to eligible recruiting clinical trials. Provide age, sex, conditions, and location to find studies with matching eligibility criteria, contact information, and recruiting locations. Results are re-ranked so studies whose own condition matches a requested condition surface above tangential matches from ClinicalTrials.gov's fuzzy condition search. Each candidate returns only the sites matching the requested location (capped by locationLimit), not the study's full registered site list — a large trial can register hundreds of sites worldwide. When none of a candidate's matched sites is recruiting, its nearest recruiting site is added, so an enrollable site is never hidden behind a closer closed one. Fetch a study's complete record with clinicaltrials_get_study_record.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'blank_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parameter was supplied with a blank, whitespace-only, or empty-list value.',
      recovery: RECOVERY_HINTS.blank_value,
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
    age: z.number().int().min(0).max(120).describe('Patient age in years.'),
    sex: z
      .enum(['FEMALE', 'MALE', 'ALL'])
      .describe(
        "Patient's biological sex. Use 'ALL' to include studies regardless of sex restrictions.",
      ),
    conditions: z
      .array(z.string())
      .describe(
        'Medical conditions or diagnoses, e.g. ["Type 2 Diabetes", "Hypertension"]. Each entry is matched as a condition (multi-word entries match as a phrase); multiple entries are combined with OR, so studies for any listed condition qualify. Returned studies are re-ranked so those whose own condition list names a requested condition rank above tangential matches the upstream fuzzy search pulls in via the MeSH umbrella.',
      ),
    location: z
      .object({
        country: z.string().describe('Country name. E.g., "United States".'),
        state: z.string().optional().describe('State or province.'),
        city: z.string().optional().describe('City name.'),
      })
      .strict()
      .describe(
        'Patient location as `{ country (required), state?, city? }`. Country is required; state/city narrow the match. For radius-based geographic search, use clinicaltrials_search_studies with geoFilter.',
      ),
    healthyVolunteer: z
      .boolean()
      .default(false)
      .describe(
        'Whether the patient is a healthy volunteer. When true, only studies accepting healthy volunteers are queried.',
      ),
    recruitingOnly: z.boolean().default(true).describe('Only include actively recruiting studies.'),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum results to return.'),
    locationLimit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(10)
      .describe(
        "Cap on the sites returned per candidate. Each candidate keeps only the sites matching the requested location at the narrowest level that matched (city, else state, else country), capped at this many; the rest of the study's registered sites are omitted. The cap governs those matched sites — when none of them is recruiting, the candidate's nearest recruiting site is added on top of it, so a candidate can carry one site more than this. Raise it to see more nearby sites, or fetch the complete site list with clinicaltrials_get_study_record. Each candidate reports totalLocations / matchedLocations / locationsTruncated / nearestRecruitingSiteAdded in locationSummary only when the bound actually dropped sites.",
      ),
  }),

  output: z.object({
    studies: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        "Matching studies with eligibility and location fields. Each candidate's protocolSection.contactsLocationsModule.locations is BOUNDED to the sites matching the requested location (capped at locationLimit) plus, when none of those is recruiting, the candidate's nearest recruiting site — not the study's full registered site list. A candidate whose sites were bounded also carries a top-level locationSummary object — { totalLocations, matchedLocations, locationsTruncated, nearestRecruitingSiteAdded?, retrieveFullStudyWith } — absent when nothing was dropped; nearestRecruitingSiteAdded is present only when that extra site was added. Fetch a study's complete record and site list with clinicaltrials_get_study_record.",
      ),
    totalCount: z.number().optional().describe('Total matching studies from the API.'),
  }),

  // Agent-facing context — search echo, funnel diagnostics, and no-match guidance.
  enrichment: {
    searchCriteria: z
      .object({
        conditions: z.array(z.string()).describe('Conditions searched.'),
        location: z
          .string()
          .describe(
            'The exact queryLocn string sent upstream (city/state/country joined). Pass as locationQuery to clinicaltrials_search_studies to reproduce the location filter beyond the maxResults cap.',
          ),
        age: z.number().describe('Patient age.'),
        sex: z.string().describe('Patient sex.'),
        conditionQuery: z
          .string()
          .optional()
          .describe(
            'The exact queryCond string sent upstream (multi-word terms quoted, OR-joined). Pass as conditionQuery to clinicaltrials_search_studies to reproduce the full match set beyond the maxResults cap.',
          ),
        statusFilter: z
          .array(z.string())
          .optional()
          .describe(
            'The status filter applied (["RECRUITING"] when recruitingOnly). Pass as statusFilter to clinicaltrials_search_studies. Absent when recruitingOnly is false.',
          ),
        advancedFilter: z
          .string()
          .optional()
          .describe(
            'The exact AREA[] advancedFilter (age range, plus sex/healthy-volunteer when constrained) sent upstream. Pass as advancedFilter to clinicaltrials_search_studies to reproduce the demographic constraints.',
          ),
      })
      .describe(
        'Normalized search criteria applied to this eligibility query, including the exact upstream query strings needed to reproduce the full match set via clinicaltrials_search_studies (replay with includeUnknownEnrollment=true, which find_eligible always sets).',
      ),
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
        'Match counts at each filter stage. Shows where the funnel collapsed — e.g., conditionMatched=298 but demographicsMatched=2 means age/sex/status are the constraint.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no studies matched — identifies which filter stage collapsed and suggests how to broaden. Absent when results are returned.',
      ),
  },

  enrichmentTrailer: {
    searchCriteria: {
      render: (sc) => {
        const lines = [
          `**Search:** conditions=[${sc.conditions.join(', ')}] | location=${sc.location} | age=${sc.age} | sex=${sc.sex}`,
        ];
        // Echo the exact upstream query strings so a content[]-only caller can
        // reproduce the full match set (find_eligible returns only maxResults) by
        // replaying them through clinicaltrials_search_studies. Every sub-field's
        // VALUE must render here or it reaches structuredContent but not content[].
        const repro: string[] = [];
        if (sc.conditionQuery) repro.push(`conditionQuery=${sc.conditionQuery}`);
        // location IS an applied upstream filter (queryLocn) — without it in the
        // repro set a caller replays a broader, all-locations query (#91-C).
        if (sc.location) repro.push(`locationQuery=${sc.location}`);
        if (sc.statusFilter?.length) repro.push(`statusFilter=[${sc.statusFilter.join(', ')}]`);
        if (sc.advancedFilter) repro.push(`advancedFilter=${sc.advancedFilter}`);
        if (repro.length) {
          // find_eligible always queries with includeUnknownEnrollment=true (eligibility
          // ignores enrollment-count quality); search_studies defaults it false and drops
          // the unknown-enrollment sentinel, so a faithful replay must set it too (#91-C).
          repro.push('includeUnknownEnrollment=true');
          lines.push(`**Reproduce via clinicaltrials_search_studies:** ${repro.join(' | ')}`);
        }
        return lines.join('\n');
      },
    },
    funnel: {
      render: (f) =>
        `**Funnel:** ${f.conditionMatched} condition → ${f.locationMatched} + location → ${f.demographicsMatched} + demographics`,
    },
  },

  async handler(input, ctx) {
    // A blank condition or country is dropped before the upstream query is
    // built, so the call would answer with trials unrelated to anything the
    // caller asked for. Reject in the handler — a schema-only rejection
    // surfaces as a bare -32602 with no reason and no recovery hint.
    const blankParam =
      firstBlankListParam({ conditions: input.conditions }) ??
      firstBlankParam({ 'location.country': input.location.country });
    if (blankParam) {
      throw ctx.fail('blank_value', blankValueMessage(blankParam), {
        param: blankParam,
        ...ctx.recoveryFor('blank_value'),
      });
    }

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

    const statusFilter = input.recruitingOnly ? ['RECRUITING'] : undefined;

    /**
     * Each age bound is ORed with its MISSING counterpart. An
     * `AREA[Field]RANGE[…]` predicate matches only studies that publish that
     * field, so a closed range alone drops every study registered as "18 Years
     * and older" — it carries a minimumAge and no maximumAge, the most
     * permissive eligibility shape in the registry and the majority of
     * recruiting trials. An absent bound is unbounded, not disqualifying.
     *
     * The widening cannot over-admit: `MISSING` and `RANGE[…]` are mutually
     * exclusive on the same field (a study either publishes it or it doesn't),
     * so a study admitted through the MISSING arm never had a declared bound to
     * violate.
     *
     * Neither the Sex nor the HealthyVolunteers arm takes this treatment. An
     * unrestricted study registers a literal `Sex: ALL` rather than omitting
     * the field, and an unstated healthy-volunteer policy is not an
     * affirmative yes.
     */
    const advancedParts: string[] = [
      `(AREA[MinimumAge]RANGE[MIN, ${input.age} years] OR AREA[MinimumAge]MISSING)`,
      `(AREA[MaximumAge]RANGE[${input.age} years, MAX] OR AREA[MaximumAge]MISSING)`,
    ];
    if (input.sex !== 'ALL') {
      advancedParts.push(`(AREA[Sex]ALL OR AREA[Sex]${input.sex})`);
    }
    if (input.healthyVolunteer) {
      advancedParts.push('AREA[HealthyVolunteers]true');
    }
    // Name the joined filter so both the upstream call and the searchCriteria echo
    // reuse the identical string — the echo is the reproducible query (#91-C).
    const advancedFilter = advancedParts.join(' AND ');

    ctx.log.info('Finding eligible studies', {
      conditions: input.conditions,
      location: locationQuery,
      age: input.age,
      sex: input.sex,
    });

    // Run the main search and the two funnel-stage counts together. The service
    // queues outbound requests one per ~1s, so these three leave ~1s apart
    // whether written as Promise.all or chained awaits — Promise.all just keeps
    // the code straight. That makes the funnel cost a real ~2s on every call,
    // paid deliberately: the counts turn "2 matches" into "298 match the
    // condition, 4 of those are in this location", which is what tells a caller
    // which constraint to relax, and getting it any other way costs two more
    // round-trips.
    const [result, conditionStage, locationStage] = await Promise.all([
      service.searchStudies(
        {
          queryCond: conditionQuery,
          queryLocn: locationQuery,
          filterOverallStatus: statusFilter,
          filterAdvanced: advancedFilter,
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

    // Re-rank studies so those whose own condition list names a requested
    // condition surface above tangential upstream matches. query.cond is a
    // fuzzy relevance search that pulls in trials matching only through a
    // distant MeSH ancestor (a bleeding-disorder trial under the
    // "Cardiovascular Disease" umbrella); without this, such a trial can land
    // at rank #1. Stable sort preserves upstream relevance order within a tier,
    // and recall is unchanged — nothing is dropped, only reordered.
    result.studies.sort((a, b) => {
      const aConds = (a as RawStudyShape).protocolSection?.conditionsModule?.conditions ?? [];
      const bConds = (b as RawStudyShape).protocolSection?.conditionsModule?.conditions ?? [];
      return (
        conditionMatchScore(bConds, input.conditions) -
        conditionMatchScore(aConds, input.conditions)
      );
    });

    // Sort each study's locations by match to the user's input, then bound the
    // list to the sites that answer the question. A location-constrained query
    // qualifies a study, but the study carries every site it ever registered —
    // one candidate can publish 963 sites against 6 near the patient, which
    // buries the answer and dominates the payload. The bound is applied here,
    // once, before either output channel sees the record, so structuredContent
    // and format() render the same sites (#46, #91). Stable sort preserves
    // upstream order for sites with equal match scores.
    const studies: Record<string, unknown>[] = result.studies.map((study) => {
      const raw = study as RawStudyShape;
      const locationsModule = raw.protocolSection?.contactsLocationsModule;
      const upstream = locationsModule?.locations;
      if (!upstream?.length) return study;
      const sorted = [...upstream].sort(
        (a, b) => locationMatchScore(b, input.location) - locationMatchScore(a, input.location),
      );
      const { locations, summary } = boundLocations(sorted, input.location, input.locationLimit);
      return {
        ...study,
        protocolSection: {
          ...raw.protocolSection,
          contactsLocationsModule: { ...locationsModule, locations },
        },
        ...(summary ? { locationSummary: summary } : {}),
      };
    });

    const conditionMatched = conditionStage.totalCount ?? 0;
    const locationMatched = locationStage.totalCount ?? 0;
    const demographicsMatched = result.totalCount ?? 0;

    // Always enrich with search echo and funnel diagnostics. The searchCriteria
    // echo carries the exact upstream query strings (conditionQuery/statusFilter/
    // advancedFilter) so callers can reproduce the full match set via
    // clinicaltrials_search_studies past find_eligible's maxResults cap (#91-C).
    ctx.enrich({
      searchCriteria: {
        conditions: input.conditions,
        location: locationQuery,
        age: input.age,
        sex: input.sex,
        conditionQuery,
        ...(statusFilter ? { statusFilter } : {}),
        advancedFilter,
      },
      funnel: { conditionMatched, locationMatched, demographicsMatched },
    });

    if (result.studies.length === 0) {
      const noticeParts: string[] = [
        `No studies found for "${input.conditions.join(', ')}" matching the specified criteria.`,
      ];

      if (conditionMatched > 0 && locationMatched === 0) {
        noticeParts.push(
          `${conditionMatched} studies match the condition, but none are in the specified location. Try broadening the location: search with just the country, or use clinicaltrials_search_studies with geoFilter for radius-based matching.`,
        );
        if (input.location.city || input.location.state)
          noticeParts.push('Remove city/state to widen the location search to the full country.');
      } else if (locationMatched > 0 && demographicsMatched === 0) {
        noticeParts.push(
          `${locationMatched} studies match condition + location, but none pass the age/sex/status filters.`,
        );
        if (input.age <= 1 || input.age >= 100)
          noticeParts.push(
            `Age ${input.age} is at the extreme of typical trial ranges. Few trials enroll this age group.`,
          );
        if (input.sex !== 'ALL')
          noticeParts.push('Try sex="ALL" to include studies not restricted by sex.');
        if (input.recruitingOnly)
          noticeParts.push(
            'Set recruitingOnly=false to include completed, active, and not-yet-recruiting studies.',
          );
        if (input.healthyVolunteer)
          noticeParts.push(
            'Many studies do not accept healthy volunteers. Set healthyVolunteer=false if the patient has a relevant condition.',
          );
      } else {
        if (input.age <= 1 || input.age >= 100)
          noticeParts.push(
            `Age ${input.age} is at the extreme of typical trial ranges. Few trials enroll this age group.`,
          );
        if (input.sex !== 'ALL')
          noticeParts.push('Try sex="ALL" to include studies not restricted by sex.');
        if (input.healthyVolunteer)
          noticeParts.push(
            'Many studies do not accept healthy volunteers. Set healthyVolunteer=false if the patient has a relevant condition.',
          );
        if (input.recruitingOnly)
          noticeParts.push(
            'Set recruitingOnly=false to include completed, active, and not-yet-recruiting studies.',
          );
        if (input.location.city || input.location.state)
          noticeParts.push(
            'Try searching with just the country to find studies in other cities/states.',
          );
      }
      ctx.enrich.notice(noticeParts.join(' '));
    }

    return {
      studies,
      totalCount: result.totalCount,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const count = result.studies.length;

    if (count === 0) {
      lines.push('No eligible studies found.');
    } else {
      lines.push(
        result.totalCount !== undefined && result.totalCount > count
          ? `Found ${result.totalCount} eligible studies (showing ${count})`
          : `Found ${count} eligible studies`,
      );
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
          // Render every intervention name — content[] must match the full list
          // carried in structuredContent, not a first-3 preview (#91).
          const names = interventions.map((i) => i.name).filter(Boolean);
          if (names.length) lines.push(`  Interventions: ${names.join(', ')}`);
        }
        const summary = s.protocolSection?.descriptionModule?.briefSummary;
        // Render the full summary — structuredContent carries it complete, so a
        // 200-char content[] clip left content-only clients with a partial value (#91).
        if (summary) lines.push(`  Summary: ${summary}`);

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

        // Disclose the bound the handler applied, so a content[]-only reader knows
        // the site list is the near-the-patient subset rather than the full one,
        // and knows how to reach the rest. Every locationSummary value renders
        // here — absent from the record means nothing was dropped (#80).
        const locationSummary = (study as { locationSummary?: LocationSummary }).locationSummary;
        if (locationSummary) {
          const truncated = locationSummary.locationsTruncated ? ', list truncated' : '';
          const admitted = locationSummary.nearestRecruitingSiteAdded
            ? '; none of them is recruiting, so the nearest recruiting site is included'
            : '';
          lines.push(
            `  Sites: showing ${locs.length} of ${locationSummary.totalLocations} registered (${locationSummary.matchedLocations} match the requested location${truncated}${admitted}). Full site list: ${locationSummary.retrieveFullStudyWith} with ${nctId}.`,
          );
        }

        // Locations are sorted by match-score and bounded in the handler, so the
        // most relevant sites (typically the user's city/state) lead. Render
        // every site the record carries — a first-3 preview with a "(+N more)"
        // tail left content-only clients unable to see the rest (#91), and the
        // bound itself belongs at the handler boundary where both channels see
        // it, never in one channel's formatter (#46). Each site's own status
        // rides along: the tool requests LocationStatus and returns it in
        // structuredContent, and a site-level status can differ from the study's
        // overall status, so omitting it made a NOT_YET_RECRUITING site read as
        // currently open (#91).
        if (locs.length > 0) {
          const locStr = locs
            .map((l) => {
              const site = [l.facility, l.city, l.state, l.country].filter(Boolean).join(', ');
              return l.status ? `${site} [${l.status}]` : site;
            })
            .join(' | ');
          lines.push(`  Locations: ${locStr}`);
        }

        // Central contacts — render all; the full set rides in structuredContent (#91).
        const centralContacts = s.protocolSection?.contactsLocationsModule?.centralContacts ?? [];
        if (centralContacts.length > 0) {
          const contactStr = centralContacts
            .map((c) => [c.name, c.phone, c.email].filter(Boolean).join(', '))
            .join(' | ');
          lines.push(`  Contact: ${contactStr}`);
        }
        // Lift both caps on the field-dump fallback so any remaining requested leaf
        // reaches content[] at full length, matching structuredContent (#91, mirrors #89).
        lines.push(
          ...formatRemainingStudyFields(study as Record<string, unknown>, ELIGIBLE_RENDERED, {
            maxLines: Number.POSITIVE_INFINITY,
            maxValueLen: Number.POSITIVE_INFINITY,
          }),
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
