/**
 * @fileoverview Match patient demographics to candidate recruiting clinical trials.
 * Candidates are matched on demographics, location, recruitment status, and a
 * fuzzy condition search; inclusion/exclusion criteria are never checked.
 * @module mcp-server/tools/definitions/find-eligible.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { RawStudyShape, StudyLocation } from '@/services/clinical-trials/types.js';
import {
  contactLine,
  formatEchoValue,
  formatRemainingStudyFields,
  oneLine,
} from '../utils/format-helpers.js';
import {
  haversineMi,
  type LocationWithDistance,
  type NearPoint,
  nearGeoFilter,
  plainDecimal,
  roundMi,
  sitesByDistance,
} from '../utils/geo-helpers.js';
import { foldedWords, registryCountry, registryState } from '../utils/place-names.js';
import {
  blankValueMessage,
  firstBlankListParam,
  firstBlankParam,
  queryTermContent,
  quoteLocationLiteral,
  quoteLocationPart,
  quoteQueryTerm,
} from '../utils/query-helpers.js';
import { RECOVERY_HINTS } from '../utils/recovery-hints.js';

/**
 * The results-path caveat, set once per response (#147). The tool never reads
 * inclusion/exclusion criteria, so a returned study is a candidate to review,
 * not an eligibility determination.
 */
const CANDIDATE_NOTICE =
  'Candidates are matched on age, sex, location, recruitment status, and a fuzzy condition search only. Inclusion/exclusion criteria were not checked, and a candidate can exclude the requested condition. Review each with clinicaltrials_get_study_record (nctId) before treating it as a match.';

/**
 * Appended to the shared blank_value message: this tool's query builder strips
 * `"` (#145), and invisible format characters carry no content.
 */
const QUOTES_ARE_NOT_CONTENT =
  'Double-quote (") characters are stripped before the query is built and do not count as content, nor do invisible format characters such as zero-width spaces, so a value of only these and whitespace is blank too.';

/**
 * Most candidates one call fetches and returns. Every candidate's site list is
 * scored and bounded and every one renders in full, so the cap holds the
 * response down; `maxResults` above it is served at the cap and disclosed, with
 * the searchCriteria replay reaching the rest (#153).
 */
const MAX_RESULTS_PER_CALL = 50;

/**
 * Units `age` can be given in. Each is sent upstream as written (`7 months`):
 * ClinicalTrials.gov converts across units when it compares an age to a
 * registered bound (`6 Months`), so nothing is converted here.
 */
const AGE_UNITS = ['years', 'months', 'weeks', 'days'] as const;
type AgeUnit = (typeof AGE_UNITS)[number];

/** Days in each age unit, for judging an age in years. */
const DAYS_PER_AGE_UNIT: Record<AgeUnit, number> = {
  years: 365.25,
  months: 365.25 / 12,
  weeks: 7,
  days: 1,
};

/**
 * Reads an `ageUnit` the way a caller writes it: case-insensitive, singular or
 * plural, surrounding whitespace ignored. A blank is an omitted unit. Anything
 * that is not a string passes through for the enum to reject.
 */
function normalizeAgeUnit(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const unit = value.trim().toLowerCase();
  if (unit === '') return undefined;
  return unit.endsWith('s') ? unit : `${unit}s`;
}

/**
 * An optional location part, or undefined when it carries no content once `"`,
 * format characters, and whitespace go.
 */
function optionalLocationPart(part: string | undefined): string | undefined {
  return part !== undefined && queryTermContent(part) ? part : undefined;
}

interface UserLocation {
  city?: string | undefined;
  country: string;
  state?: string | undefined;
}

/** The tests one study's sites are scored against. */
interface SiteMatchLocation {
  /** Whether city and state credit goes only to sites that pass `inCountry`. */
  gated: boolean;
  /** Whether a site is in the requested country; see `countryGate`. */
  inCountry: (site: StudyLocation) => boolean;
  /** Whether a site's city is the requested one; see `samePlaceAs`. */
  sameCity: (name: string | undefined) => boolean;
  /** Whether a site's state is the requested one; see `samePlaceAs`. */
  sameState: (name: string | undefined) => boolean;
}

/** The distinct folded words of a place name; see `foldedWords`. */
export function placeWords(name: string): Set<string> {
  return new Set(foldedWords(name));
}

/**
 * A test for whether a place name is the requested one: the same folded words
 * in the same order (`foldedWords`), so `Washington DC` matches the registry's
 * `Washington D.C.`. A sequence rather than a set, so `Baden-Baden` is not
 * `Baden`. A name that folds to no words never matches, so a requested `-`
 * cannot match a blank site field, and an absent request or site name never
 * matches. Memoized per distinct site spelling, since the sort scores every
 * site of every candidate repeatedly.
 */
function samePlaceAs(requested: string | undefined): (name: string | undefined) => boolean {
  const wanted = requested === undefined ? '' : foldedWords(requested).join(' ');
  if (wanted === '') return () => false;
  const seen = new Map<string, boolean>();
  return (name) => {
    if (name === undefined) return false;
    let hit = seen.get(name);
    if (hit === undefined) {
      hit = foldedWords(name).join(' ') === wanted;
      seen.set(name, hit);
    }
    return hit;
  };
}

/**
 * A test for whether a site's country carries every word of the requested
 * country, folded (`placeWords`) — `Korea` matches the registry's `South
 * Korea`, `México` its `Mexico`. Word containment rather than equality: the
 * registry's spelling of a country rarely matches what a patient types. The
 * handler passes a synonym's registry spelling (`registryCountry`), so `USA`
 * passes on `United States` (#172). A site that publishes no country fails.
 * Memoized per distinct site spelling, since one request scores every site of
 * every candidate — thousands — across a few countries.
 */
function countryGate(requested: string): (site: StudyLocation) => boolean {
  const wanted = placeWords(requested);
  const seen = new Map<string, boolean>();
  return ({ country }) => {
    if (country === undefined) return false;
    let hit = seen.get(country);
    if (hit === undefined) {
      const words = placeWords(country);
      hit = wanted.size <= words.size && [...wanted].every((w) => words.has(w));
      seen.set(country, hit);
    }
    return hit;
  };
}

/**
 * How closely a site's geography matches the user's stated location. City
 * dominates, then state, then country, so the score doubles as a match tier:
 * every site sharing the study's best score matched at the same level. The
 * country point goes to every site passing `user.inCountry`, so `Korea` earns
 * it on `South Korea` (#166).
 *
 * When `user.gated`, city and state points go only to sites that pass
 * `user.inCountry`. A study qualifies on its whole site list, so the city it
 * matched on can be a foreign namesake (London, UK for a London, Canada
 * request); scored on the name alone, that site would outrank every in-country
 * site and become the tier (#159).
 */
function locationGeoScore(loc: StudyLocation, user: SiteMatchLocation): number {
  const inCountry = user.inCountry(loc);
  let score = inCountry ? 1 : 0;
  if (inCountry || !user.gated) {
    if (user.sameCity(loc.city)) score += 4;
    if (user.sameState(loc.state)) score += 2;
  }
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
function locationMatchScore(loc: StudyLocation, user: SiteMatchLocation): number {
  return locationGeoScore(loc, user) + (isRecruiting(loc) ? 0.5 : 0);
}

/** A site whose published coordinates can be measured from. */
type GeoLocated = StudyLocation & { geoPoint: { lat: number; lon: number } };

function hasGeoPoint(loc: StudyLocation): loc is GeoLocated {
  return loc.geoPoint != null;
}

/**
 * Pick the one recruiting site to admit when none of a candidate's shown sites
 * recruits (#114), or undefined when the study registers no recruiting site.
 *
 * Recruiting sites in the requested country (`inCountry`, the gate's word test,
 * so `Korea` keeps them in South Korea) are the candidates when there are any:
 * distance alone would send a patient who named their country across a border
 * (Seattle → Vancouver, BC) while a site at home recruits. Of those, the nearest
 * by great-circle distance to the closest of `origins`: the sites of the whole
 * matched tier, measured before the locationLimit cap, since the cap bounds
 * payload, not which sites the patient is near — or, under location.near, the
 * patient's point (#205). Ties keep match order. Candidates that publish no
 * coordinates cannot be measured and sit out, as in the other geo-aware tools.
 * With no origin or no measurable candidate, the first candidate in match order
 * is admitted and carries no distanceMi, so nothing downstream presents it as
 * the nearest.
 */
function admitRecruitingSite(
  sites: StudyLocation[],
  inCountry: (site: StudyLocation) => boolean,
  origins: { lat: number; lon: number }[],
): LocationWithDistance | undefined {
  const open = sites.filter(isRecruiting);
  const home = open.filter(inCountry);
  const candidates = home.length > 0 ? home : open;
  let nearest: { distanceMi: number; loc: GeoLocated } | undefined;
  if (origins.length > 0) {
    for (const loc of candidates.filter(hasGeoPoint)) {
      const distanceMi = Math.min(...origins.map((o) => haversineMi(o, loc.geoPoint)));
      if (!nearest || distanceMi < nearest.distanceMi) nearest = { distanceMi, loc };
    }
  }
  if (!nearest) return candidates[0];
  return { ...nearest.loc, distanceMi: roundMi(nearest.distanceMi) };
}

/** What a candidate's site list was bounded to, and how to retrieve the rest. */
interface LocationSummary {
  /** True when the list leaves out sites that matched the requested location, cut by the locationLimit cap. */
  locationsTruncated: boolean;
  /** Sites matching the requested location, before the cap. */
  matchedLocations: number;
  /**
   * Present when no site the cap kept is recruiting and one recruiting site was
   * added — the nearest by distance when coordinates allow (it then carries
   * distanceMi), otherwise the first in match order.
   */
  nearestRecruitingSiteAdded?: true;
  /** Tool that returns the study's complete site list. */
  retrieveFullStudyWith: 'clinicaltrials_get_study_record';
  /** Every site the study registers upstream. */
  totalLocations: number;
}

/** A candidate's bounded site list, and its summary when the bound dropped sites. */
interface BoundSites {
  locations: LocationWithDistance[];
  summary?: LocationSummary;
}

/**
 * The capped sites plus any admitted recruiting site, with a summary only when
 * the result is genuinely smaller than the upstream list — reporting a bound
 * that dropped nothing would imply a filter ran where none did. `matchedShown`
 * counts the matched sites the list carries, the admitted one included when it
 * is one of them.
 */
function boundResult(
  total: number,
  matchedLocations: number,
  matchedShown: number,
  capped: LocationWithDistance[],
  admitted: LocationWithDistance | undefined,
): BoundSites {
  const locations = admitted ? [...capped, admitted] : capped;
  if (locations.length === total) return { locations };
  return {
    locations,
    summary: {
      totalLocations: total,
      matchedLocations,
      locationsTruncated: matchedLocations > matchedShown,
      ...(admitted ? { nearestRecruitingSiteAdded: true } : {}),
      retrieveFullStudyWith: 'clinicaltrials_get_study_record',
    },
  };
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
 * whose every shown site can enroll no one (#114). When that happens, admit one
 * recruiting site alongside the tier, the nearest one by distance when the sites
 * publish coordinates (#138), in the requested country when one recruits there.
 * Admitting one site keeps the local answer local;
 * widening to that site's whole tier would trade a city-precise answer for a
 * statewide dump and reinflate the payload this bound exists to hold down.
 */
function boundLocations(
  sortedLocations: StudyLocation[],
  user: SiteMatchLocation,
  limit: number,
): BoundSites {
  let best = 0;
  for (const loc of sortedLocations) best = Math.max(best, locationGeoScore(loc, user));
  // best === 0 keeps every site: a study can qualify upstream on a facility or
  // ZIP match with no city/state/country hit, and dropping all of its sites
  // would answer with a candidate that appears to have nowhere to enroll.
  const matched = sortedLocations.filter((loc) => locationGeoScore(loc, user) === best);
  const capped = matched.slice(0, limit);
  // The recruiting tie-break sorts any open matched site to the front of the
  // tier, so a cap showing no open site means the tier holds none: every
  // candidate sits below it. Nothing is admitted when best === 0 (the tier is
  // every site) or when the study registers no recruiting site at all — both
  // leave the tier answer exactly as it was.
  const admitted = capped.some(isRecruiting)
    ? undefined
    : admitRecruitingSite(
        sortedLocations,
        user.inCountry,
        matched.filter(hasGeoPoint).map((site) => site.geoPoint),
      );
  // An admitted site is never a matched one: no matched site recruits.
  return boundResult(sortedLocations.length, matched.length, capped.length, capped, admitted);
}

/**
 * `boundLocations` for location.near (#205): the sites that answer the
 * caller's question are those within the radius of the patient's point,
 * nearest first (`sitesByDistance`, the pass clinicaltrials_get_study_record's
 * nearLocation runs), capped at the limit. Upstream's filter.geo can admit a
 * study on a site this measurement puts just past the radius, so when none
 * measures inside, the nearest measured site stands in and the list is never
 * empty; a study whose sites publish no coordinates keeps them all, capped, as
 * an unmatched study does in `boundLocations`. Sites are in distance order, not
 * recruiting order, so a recruiting site within the radius can sit past the
 * cap; the admission rule is the same, measured from the point, and the site it
 * admits can be that one, shown again.
 */
function boundNearLocations(
  sites: StudyLocation[],
  near: NearPoint,
  inCountry: (site: StudyLocation) => boolean,
  limit: number,
): BoundSites {
  const { measured, withinRadius } = sitesByDistance(sites, near);
  const kept: LocationWithDistance[] =
    measured.length > 0 ? measured.slice(0, Math.max(withinRadius, 1)) : sites;
  const capped = kept.slice(0, limit);
  const admitted = capped.some(isRecruiting)
    ? undefined
    : admitRecruitingSite(sites, inCountry, [near]);
  // The radius test sitesByDistance applies, on the exact distance.
  const admittedInRange =
    admitted?.geoPoint != null && haversineMi(near, admitted.geoPoint) <= near.radiusMi;
  const inRangeShown = Math.min(capped.length, withinRadius) + (admittedInRange ? 1 : 0);
  return boundResult(sites.length, withinRadius, inRangeShown, capped, admitted);
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
    // The text the condition query carries (quotes stripped), so a quoted
    // condition ranks the studies it finds exactly as its bare form does.
    text: queryTermContent(c).toLowerCase(),
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

/**
 * One returned site as `content[]` text: its place, its own status (which can
 * differ from the study's, so a NOT_YET_RECRUITING site never reads as open,
 * #91), and the distance it was measured at — an added recruiting site's from
 * the nearest matched site (#138), or every site's from the patient under
 * location.near (#205). `distanceFrom` names that origin.
 */
function siteLine(loc: LocationWithDistance, distanceFrom: string): string {
  const place = [loc.facility, loc.city, loc.state, loc.country].filter(Boolean).join(', ');
  const status = loc.status ? ` [${loc.status}]` : '';
  const distance = loc.distanceMi != null ? ` (${loc.distanceMi} mi from ${distanceFrom})` : '';
  return `${place}${status}${distance}`;
}

/**
 * The `Sites:` line's clause on the added recruiting site, always the last of
 * the `listed` sites. Without location.near the matched tier sorts its
 * recruiting sites first, so a cap that shows none open leaves none of the
 * matched sites recruiting. Under location.near the cap keeps sites in distance
 * order, so a site in range past it can recruit and be the one added: the
 * clause names the sites listed before it, never the sites in range (#205). The
 * added site is the nearest recruiting one in the requested country, which a
 * nearer one across a border can beat on distance, so "nearest" carries its
 * country rule (admitRecruitingSite), and is claimed only when `measured`, the
 * added site carrying distanceMi (#138).
 */
function addedSiteClause(underNear: boolean, measured: boolean, listedBefore: number): string {
  if (!underNear) {
    return measured
      ? '; none of them is recruiting, so the nearest recruiting site in the requested country is included, or the nearest anywhere when none recruits there'
      : '; none of them is recruiting, so one recruiting site from a wider area is included (picked by match order — coordinates to measure distance are missing)';
  }
  const before =
    listedBefore === 1
      ? 'the first site listed is not recruiting'
      : `none of the first ${listedBefore} sites listed is recruiting`;
  return measured
    ? `; ${before}, so the recruiting site in the requested country nearest the patient is added last, or the nearest anywhere when none recruits there`
    : `; ${before}, so one recruiting site is added last (picked by match order — coordinates to measure distance are missing)`;
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

/**
 * Fields requested for eligibility evaluation; sent as `fixedFields`, unchecked
 * against the metadata. Contacts are requested as their two groups, never leaf
 * by leaf: each group returns every key a contact registers (name, role, phone,
 * phoneExt, email), and a long conditions list puts the request beside
 * ClinicalTrials.gov's 8,177-byte limit, which the leaf names of a site's
 * contacts (141 bytes) would push past, failing as `request_too_long` (#202).
 */
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
  'LocationGeoPoint',
  'LocationContact',
  'CentralContact',
];

export const findEligible = tool('clinicaltrials_find_eligible', {
  description:
    "Find candidate clinical trials for a patient profile. Provide age, sex, conditions, and location to get studies with their demographic limits, contact information, and recruiting locations. Candidates are matched on age, sex, location, recruitment status, and ClinicalTrials.gov's fuzzy condition search only — inclusion/exclusion criteria are not checked, and a candidate can exclude the requested condition, so review each one's criteria with clinicaltrials_get_study_record before treating it as a match. Results are re-ranked so studies whose own condition matches a requested condition surface above tangential matches from ClinicalTrials.gov's fuzzy condition search. Each candidate returns only the sites matching the requested location (capped by locationLimit), not the study's full registered site list — a large trial can register hundreds of sites worldwide. Give location.near (the patient's lat, lon, and a radiusMi) in place of city and state to match by travel distance: candidates then return their sites within the radius, nearest first, each with distanceMi from the patient. When none of a candidate's matched sites is recruiting, one recruiting site is added so an enrollable site is never hidden behind a closer closed one: the one nearest the matched sites (under location.near, the patient) by their published coordinates, in the requested country whenever a site there recruits, carrying distanceMi, or the first in match order when coordinates are missing. Fetch a study's complete record with clinicaltrials_get_study_record.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'blank_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A conditions entry or location.country was supplied blank — empty, whitespace-only, or made only of `"` characters, invisible format characters such as zero-width spaces, and whitespace, since `"` is stripped before the query is built — or conditions was an empty list.',
      recovery: RECOVERY_HINTS.blank_value,
    },
    {
      reason: 'location_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'location.near was given together with a location.city or location.state that has content.',
      recovery:
        'Drop location.city and location.state and keep location.near with location.country to match sites by distance from the patient, or drop location.near to match by city and state.',
    },
    {
      reason: 'field_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A conditions entry carries an AREA[] expression naming a field ClinicalTrials.gov does not recognize or cannot search by value, or putting a valid field where upstream refuses it: a study-level field or a DISTANCE[] term (at times a RANGE[] term) inside SEARCH[Location](…), RANGE[] on a field that is not a date, number, or age, or DISTANCE[] on any field but LocationGeoPoint.',
      recovery: RECOVERY_HINTS.field_invalid,
      thrownBy: 'service',
    },
    {
      reason: 'enum_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A conditions entry carries an AREA[] expression with a value ClinicalTrials.gov does not accept for that enum field, such as AREA[Phase]PHASE9.',
      recovery: RECOVERY_HINTS.enum_invalid,
      thrownBy: 'service',
    },
    {
      reason: 'query_parse_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A conditions entry uses syntax the upstream Essie parser rejects — typically an unmatched `(` or `)`, or a `[` or `]` outside an AREA[…] expression — or carries a DISTANCE[] operand it cannot read: a latitude or longitude that is not a number or is out of range, a radius under 1 or with no mi or km unit, or no radius at all.',
      recovery: RECOVERY_HINTS.query_parse_error,
      thrownBy: 'service',
    },
    {
      reason: 'request_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The conditions list or location makes the request URL longer than ClinicalTrials.gov accepts — several hundred conditions in one call.',
      recovery: RECOVERY_HINTS.request_too_long,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov answered HTTP 429 on every attempt, or the call’s time budget ran out after a 429.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'ClinicalTrials.gov did not answer within the call’s time budget, which covers every request, retry, and wait the call makes — the search and both funnel counts share it.',
      recovery: RECOVERY_HINTS.retry_deadline_exceeded,
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'ClinicalTrials.gov answered HTTP 504 (gateway timeout) or 408 (request timeout), or sent no answer within the per-attempt timeout, on every attempt.',
      recovery: RECOVERY_HINTS.upstream_timeout,
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every attempt failed on ClinicalTrials.gov’s side — HTTP 500, 502, or 503, a dropped connection or one the network gave up opening, or a 200 body that is not the JSON the route serves (an HTML page, unparseable text, the wrong shape) — or it answered with another 5xx, such as 505, or the connection was refused or its host name did not resolve, none of which is retried.',
      recovery: RECOVERY_HINTS.upstream_unavailable,
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'ClinicalTrials.gov refused the request with a status its API does not use for a bad query — HTTP 501, a 3xx, or a 4xx such as 401, 403, or 410 — or answered with an HTML error page in place of its own 404.',
      recovery: RECOVERY_HINTS.upstream_rejected,
      retryable: false,
      thrownBy: 'service',
    },
  ],

  // The result count's generic name, as on clinicaltrials_search_studies; max_results already folds onto maxResults.
  inputAliases: { limit: 'maxResults' },

  input: z.object({
    age: z
      .number()
      .int()
      .min(0)
      .max(120)
      .describe('Patient age as a whole number in ageUnit (years unless ageUnit says otherwise).'),
    ageUnit: z
      .preprocess(normalizeAgeUnit, z.enum(AGE_UNITS).optional())
      .describe(
        'Unit age is given in: years (default), months, weeks, or days; case and singular forms are accepted. Use a smaller unit for an infant or young child whose eligibility window is narrower than a year — age 7 with ageUnit "months" matches a study registered for 6 Months to 8 Months, which no whole number of years reaches. ClinicalTrials.gov compares ages across units, so the unit only sets how precisely age is stated.',
      ),
    sex: z
      .enum(['FEMALE', 'MALE', 'ALL'])
      .describe(
        "Patient's biological sex. Use 'ALL' to include studies regardless of sex restrictions.",
      ),
    conditions: z
      .array(z.string())
      .describe(
        'Medical conditions or diagnoses, e.g. ["Type 2 Diabetes", "Hypertension"]. Each entry is matched as a condition: an entry containing whitespace is quoted and matches as a phrase, and any other entry is sent as written, punctuation included (double quotes are stripped from every entry); multiple entries are combined with OR, so studies for any listed condition qualify. Returned studies are re-ranked so those whose own condition list names a requested condition rank above tangential matches the upstream fuzzy search pulls in via the MeSH umbrella.',
      ),
    location: z
      .object({
        country: z
          .string()
          .describe(
            'Country name, e.g. "United States". Common synonyms rank sites as the registry spelling does: USA and US as United States, UK and England as United Kingdom, Czech Republic as Czechia, Republic of Korea as South Korea, and PR, GU, VI, AS, and MP as the US territories, which the registry files as countries.',
          ),
        state: z
          .string()
          .optional()
          .describe(
            'State or province, compared with the state the site files. A US state or DC abbreviation (WA, DC) is compared as its full name when the country is the United States or a synonym for it. With city also given, a site that files no state still matches; without city, only sites filing this state match.',
          ),
        city: z.string().optional().describe('City name.'),
        near: z
          .object({
            lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
            lon: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
            radiusMi: z
              .number()
              .min(1)
              .default(50)
              .describe(
                'Radius in miles around the point, at least 1; decimals are allowed. Default 50; there is no maximum.',
              ),
          })
          .strict()
          .optional()
          .describe(
            "The patient's coordinates and how far they can travel, as `{ lat, lon, radiusMi }`. A study qualifies when one of its sites lies within radiusMi of the point (sent upstream as filter.geo), and each candidate returns its sites within the radius, nearest first, each carrying distanceMi from the point. Replaces city and state: giving either with near fails as location_conflict. Country stays required and is still sent, but ClinicalTrials.gov matches it on any one of the study's sites, separately from the radius, so a candidate's sites within the radius can all lie in another country; each site carries its own country. Nothing here geocodes, so look the coordinates up first. Distances use the registry's site coordinates, typically a city centroid, and a site that publishes none is never within the radius.",
          ),
      })
      .strict()
      .describe(
        "Patient location as `{ country (required), state?, city?, near? }`. Country is required; state and city narrow the match, or near replaces them with a radius around the patient. Every part given but near must hold for the same study site: country and state are compared with the site's filed country and state, while city is matched against the site's whole location text, so a site filed under a borough or neighbouring town that names the city still counts. near's radius is matched on its own, so a study can qualify on a site in the country and a different site within the radius.",
      ),
    healthyVolunteer: z
      .boolean()
      .default(false)
      .describe(
        'Whether the patient is a healthy volunteer. When true, only studies accepting healthy volunteers are queried.',
      ),
    recruitingOnly: z.boolean().default(true).describe('Only include actively recruiting studies.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        `Maximum candidates to return. Default 10; a larger value returns at most ${MAX_RESULTS_PER_CALL} and says so in truncated/shown/cap when more studies match, and the searchCriteria replay through clinicaltrials_search_studies pages the rest.`,
      ),
    locationLimit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        "Cap on the sites returned per candidate. Each candidate keeps only the sites matching the requested location at the narrowest level that matched (city, else state, else country), capped at this many; the rest of the study's registered sites are omitted. Under location.near the matched sites are those within radiusMi in any country, nearest first, or the nearest measured site when none measures inside. The cap governs those matched sites — when none of them is recruiting, one recruiting site is added on top of it (the nearest to any matched site, measured before this cap, when coordinates allow — under location.near, the nearest to the point — in the requested country whenever a site there recruits), so a candidate can carry one site more than this. Raise it to see more nearby sites — there is no upper bound, and a limit past the matched sites returns all of them — or fetch the complete site list with clinicaltrials_get_study_record. Each candidate reports totalLocations / matchedLocations / locationsTruncated / nearestRecruitingSiteAdded in locationSummary only when the bound actually dropped sites.",
      ),
  }),

  output: z.object({
    studies: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        "Candidate studies with their demographic limits (age, sex, healthy volunteers), contacts, and location fields — matched on age, sex, location, recruitment status, and the fuzzy condition search; inclusion/exclusion criteria are not checked and are not in these records, so review each candidate with clinicaltrials_get_study_record. Each candidate's protocolSection.contactsLocationsModule.locations is BOUNDED to the sites matching the requested location (capped at locationLimit) plus, when none of those is recruiting, one added recruiting site — not the study's full registered site list. Each returned site keeps every contact it registers in contacts[] (name, role, phone, phoneExt, email — the keys the registry has); a site with no contacts has no contacts key. The added site is the one nearest any matched site by published coordinates, taken from the requested country whenever a site there recruits, and carries distanceMi (miles to that nearest matched site); when the matched or recruiting sites publish no coordinates it is the first in match order and carries no distanceMi. Under location.near, the returned sites are those within radiusMi of the point in any country (location.country is matched on some site of the study, not necessarily these), nearest first, each carrying distanceMi, miles from the point; when none measures inside the radius the nearest measured site stands alone, past it, and when no site publishes coordinates the sites are kept, capped, with no distanceMi. The added recruiting site is then the one nearest the point, taken from the requested country whenever a site there recruits, its distanceMi from the point, so it can lie past the radius, and locationSummary.matchedLocations counts the sites within the radius, in any country, so it can be 0. A candidate whose sites were bounded also carries a top-level locationSummary object — { totalLocations, matchedLocations, locationsTruncated, nearestRecruitingSiteAdded?, retrieveFullStudyWith } — absent when nothing was dropped; nearestRecruitingSiteAdded is present only when that extra site was added (the key keeps its name in the match-order fallback). Fetch a study's complete record and site list with clinicaltrials_get_study_record.",
      ),
    totalCount: z.number().optional().describe('Total matching studies from the API.'),
    near: z
      .object({
        lat: z.number().describe('Latitude in decimal degrees.'),
        lon: z.number().describe('Longitude in decimal degrees.'),
        radiusMi: z.number().describe('Radius in miles.'),
      })
      .optional()
      .describe(
        "Echo of location.near, present only when it was given: each candidate's sites were bounded to radiusMi of this point, apart from the fallbacks and the added recruiting site studies describes, and every site's distanceMi is miles from it.",
      ),
  }),

  // Agent-facing context — search echo, funnel diagnostics, and no-match guidance.
  enrichment: {
    searchCriteria: z
      .object({
        conditions: z.array(z.string()).describe('Conditions searched.'),
        location: z
          .string()
          .describe(
            'The exact queryLocn string sent upstream: the parts AND-joined inside SEARCH[Location](…) so every part must match the same site. The city is a search term, quoted unless it is a single run of letters and digits (Toronto stays bare; "Winston-Salem" and "L\'Aquila" are quoted); the state is AREA[LocationState]"…", ORed with AREA[LocationState]MISSING when a city is given; the country is AREA[LocationCountry]"…", ORed with the same spelling without diacritics when it carries any (México also tries Mexico). Any embedded double quote is stripped and any backslash in a quoted value doubled. Pass as locationQuery to clinicaltrials_search_studies to reproduce the location filter beyond the maxResults cap.',
          ),
        age: z.number().describe('Patient age, in ageUnit when present, else in years.'),
        ageUnit: z
          .enum(AGE_UNITS)
          .optional()
          .describe(
            'The unit age was given in. Present only for months, weeks, or days; absent means years.',
          ),
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
        geoFilter: z
          .string()
          .optional()
          .describe(
            'The exact filter.geo value sent upstream for location.near, distance(lat,lon,radiusMi) with an mi suffix, numbers in plain decimal. Pass as geoFilter to clinicaltrials_search_studies, beside locationQuery, to reproduce the radius. Absent without location.near.',
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
          .describe(
            'Studies matching condition + location, the location.near radius included — diagnoses geographic narrowing.',
          ),
        demographicsMatched: z
          .number()
          .describe(
            'Studies matching the full filter set (condition + location, radius included, + age/sex + status). Equal to totalCount.',
          ),
      })
      .describe(
        'Match counts at each filter stage. Shows where the funnel collapsed — e.g., conditionMatched=298 but demographicsMatched=2 means age/sex/status are the constraint.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        "When no studies matched, recovery guidance that identifies which filter stage collapsed and suggests how to broaden. When studies are returned, one caveat for the whole response: candidates were matched on demographics, location, recruitment status, and a fuzzy condition search, not on inclusion/exclusion criteria. When maxResults was above the tool's per-call cap and more studies match, a sentence follows stating the requested, served, and total counts and pointing at the searchCriteria replay.",
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when maxResults was above the tool's per-call cap and more studies match than were returned. Absent otherwise.",
      ),
    shown: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Candidates returned when truncated is true.'),
    cap: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The tool's per-call cap, served in place of the requested maxResults when truncated is true.",
      ),
  },

  enrichmentTrailer: {
    searchCriteria: {
      render: (sc) => {
        const lines = [
          `**Search:** conditions=${formatEchoValue(sc.conditions)} | location=${formatEchoValue(sc.location)} | age=${sc.age}${sc.ageUnit ? ` ${formatEchoValue(sc.ageUnit)}` : ''} | sex=${formatEchoValue(sc.sex)}`,
        ];
        // Echo the exact upstream query strings so a content[]-only caller can
        // reproduce the full match set (find_eligible returns only maxResults) by
        // replaying them through clinicaltrials_search_studies. Every sub-field's
        // VALUE must render here or it reaches structuredContent but not content[],
        // and each renders through formatEchoValue so it reads back as sent (#177).
        const repro: string[] = [];
        if (sc.conditionQuery) repro.push(`conditionQuery=${formatEchoValue(sc.conditionQuery)}`);
        // location IS an applied upstream filter (queryLocn) — without it in the
        // repro set a caller replays a broader, all-locations query (#91-C).
        if (sc.location) repro.push(`locationQuery=${formatEchoValue(sc.location)}`);
        if (sc.statusFilter?.length) repro.push(`statusFilter=${formatEchoValue(sc.statusFilter)}`);
        if (sc.advancedFilter) repro.push(`advancedFilter=${formatEchoValue(sc.advancedFilter)}`);
        // The location.near radius, an applied upstream filter like location (#205).
        if (sc.geoFilter) repro.push(`geoFilter=${formatEchoValue(sc.geoFilter)}`);
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
    // A notice renders as authored Markdown, and the no-match notice quotes the
    // caller's conditions, so the whole notice is escaped here and quoted line
    // by line. Escaping in the handler would put the escapes in
    // structuredContent too (#177).
    notice: {
      render: (notice: string) =>
        escapeMarkdownInline(notice)
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
    },
  },

  async handler(input, ctx) {
    // A blank condition or country is dropped before the upstream query is
    // built, so the call would answer with trials unrelated to anything the
    // caller asked for. Reject in the handler — a schema-only rejection
    // surfaces as a bare -32602 with no reason and no recovery hint. Blankness
    // is judged on what quoteQueryTerm and quoteLocationPart emit: a value of
    // only `"` and whitespace reaches upstream as no operand or a bare `" "`
    // phrase (#145).
    const blankParam =
      firstBlankListParam({ conditions: input.conditions.map(queryTermContent) }) ??
      firstBlankParam({ 'location.country': queryTermContent(input.location.country) });
    if (blankParam) {
      throw ctx.fail('blank_value', `${blankValueMessage(blankParam)} ${QUOTES_ARE_NOT_CONTENT}`, {
        param: blankParam,
      });
    }

    // An optional city or state with no content is unset, as an empty string
    // already was — never forwarded as `" "` or an empty AND operand (#145).
    const location: UserLocation = {
      country: input.location.country,
      city: optionalLocationPart(input.location.city),
      state: optionalLocationPart(input.location.state),
    };
    // Upstream matches filter.geo and SEARCH[Location] independently, so a
    // radius beside a city or state either narrows back to that place or
    // qualifies a study on two different sites — one in the city, another near
    // the point (#159). The radius replaces them. Judged after the #145 unset
    // above, so a city or state with no content does not conflict.
    const near = input.location.near;
    if (near && (location.city || location.state)) {
      const given = [location.city && 'location.city', location.state && 'location.state']
        .filter(Boolean)
        .join(' and ');
      throw ctx.fail(
        'location_conflict',
        `location.near cannot be combined with ${given}: ClinicalTrials.gov matches the radius and the place name independently, so together they can qualify a study on two different sites. Drop ${given} to search by distance, or drop location.near.`,
      );
    }
    // Sites are scored, bounded, and admitted against the text the query
    // carries, not the raw value: a quoted part finds a study through its bare
    // form, so it must match that study's sites the same way (#155). A country
    // or US state synonym upstream resolves (USA, UK, WA) is compared as the
    // registry spelling it resolves to, so its sites rank as that spelling's
    // do; the query and its echo keep the caller's spelling (#172).
    const comparedCountry = registryCountry(queryTermContent(location.country));
    const inRequestedCountry = countryGate(comparedCountry);
    const gatedMatch: SiteMatchLocation = {
      sameCity: samePlaceAs(location.city && queryTermContent(location.city)),
      sameState: samePlaceAs(
        location.state && registryState(queryTermContent(location.state), comparedCountry),
      ),
      inCountry: inRequestedCountry,
      gated: true,
    };
    // Upstream also resolves country spellings neither the synonym table nor
    // the gate's word test carries (CZ for Czechia), so a study can qualify on
    // sites the gate rejects. When none of a study's sites passes the gate, the
    // gate would score every site 0 and keep the whole list, so that study's
    // city and state points go ungated.
    const ungatedMatch: SiteMatchLocation = { ...gatedMatch, gated: false };

    const service = getClinicalTrialsService();

    const conditionQuery = input.conditions.map(quoteQueryTerm).join(' OR ');

    // Each component is preserved as a literal phrase and joined with an
    // explicit AND. A comma-joined multiword location reached upstream as loose
    // tokens and scored zero against studies that list exactly that site, so
    // the tool reported no trials in a location that has them — and told the
    // patient to drop the location. Quoting alone is not enough: the comma
    // separator fails outright once components are quoted.
    //
    // SEARCH[Location](…) binds every part to the same site. A bare AND matches
    // the parts across a study's whole site list, so London + Canada admitted a
    // study whose London site is in the UK and whose Canadian site is in
    // Toronto (#159).
    //
    // State and country are bound to their own fields (#164). As search terms
    // they matched any field of a site: a state named like a city or facility
    // (Washington D.C., Washington University in St. Louis) admitted studies with
    // no site there, Mexico matched New Mexico, and Czech Republic, UK, and USA
    // missed most of their country, whose synonyms resolve only through AREA[].
    // Both operands are always quoted — a bare one-word state such as Missing
    // reads as the MISSING operator. When a city is given, a site that files no
    // state passes: the city locates it, and a blank state cannot contradict the
    // requested one. Without a city the state is the only locator below the
    // country, so it stays strict. The state field folds diacritics (São Paulo,
    // Sao Paulo); the country field resolves synonyms (UK, Türkiye) but folds
    // none — México matches no study while Mexico matches every Mexican site —
    // so a country carrying diacritics is also tried without them, on the same
    // site field.
    //
    // The city stays a search term: AREA[LocationCity] drops genuine sites whose
    // city field holds a borough (Harrow, state London; The Bronx) or a
    // neighbouring town whose facility carries the city's name (Burien, for
    // Seattle). quoteLocationPart quotes it unless it is a single run of letters
    // and digits: inside the wrapper a bare hyphenated part (Winston-Salem)
    // under-matches, and a bare `(`, `)`, `[`, or `]` would close the wrapper
    // early. One string feeds the main search, the location-stage funnel count,
    // and the searchCriteria echo, so they cannot diverge; query.locn accepts
    // it, so the echo replays as locationQuery.
    const locationParts: string[] = [];
    if (location.city) locationParts.push(quoteLocationPart(location.city));
    if (location.state) {
      const state = `AREA[LocationState]${quoteLocationLiteral(location.state)}`;
      locationParts.push(location.city ? `(${state} OR AREA[LocationState]MISSING)` : state);
    }
    const countryArea = (country: string) =>
      `AREA[LocationCountry]${quoteLocationLiteral(country)}`;
    const plainCountry = location.country.normalize('NFD').replace(/\p{M}/gu, '');
    locationParts.push(
      plainCountry === location.country
        ? countryArea(location.country)
        : `(${countryArea(location.country)} OR ${countryArea(plainCountry)})`,
    );
    const locationQuery = `SEARCH[Location](${locationParts.join(' AND ')})`;
    // The location.near radius rides beside the country on the same two
    // requests the location does, and on the echo, so the funnel's location
    // stage counts it and the replay reproduces it (#205). Numbers go in plain
    // decimal: upstream rejects exponent notation (1e-7).
    const geoFilter = near ? nearGeoFilter(near) : undefined;

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
    const ageUnit = input.ageUnit ?? 'years';
    const ageTerm = `${input.age} ${ageUnit}`;
    const advancedParts: string[] = [
      `(AREA[MinimumAge]RANGE[MIN, ${ageTerm}] OR AREA[MinimumAge]MISSING)`,
      `(AREA[MaximumAge]RANGE[${ageTerm}, MAX] OR AREA[MaximumAge]MISSING)`,
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
      ...(geoFilter ? { geoFilter } : {}),
      age: input.age,
      ageUnit,
      sex: input.sex,
    });

    // The main search, then the two funnel-stage counts, in sequence. The
    // service paces outbound requests at least ~1s apart, so issuing them
    // together gains nothing, and a failure would leave the others queued to
    // reach ClinicalTrials.gov after the error returned, delaying the next
    // call's requests (#176). In sequence a failure sends nothing further and
    // the caller gets that request's own error. The funnel costs a real ~2s on
    // every call, paid deliberately: the counts turn "2 matches" into "298 match
    // the condition, 4 of those are in this location", which is what tells a
    // caller which constraint to relax, and getting it any other way costs two
    // more round-trips.
    const result = await service.searchStudies(
      {
        queryCond: conditionQuery,
        queryLocn: locationQuery,
        ...(geoFilter ? { filterGeo: geoFilter } : {}),
        filterOverallStatus: statusFilter,
        filterAdvanced: advancedFilter,
        fields: ELIGIBLE_FIELDS,
        // A fixed list: checking it against the field metadata buys nothing.
        fixedFields: true,
        pageSize: Math.min(input.maxResults, MAX_RESULTS_PER_CALL),
        countTotal: true,
        // Eligibility matches are about who can enroll, not about enrollment
        // count quality. Don't drop matches just because the sponsor didn't
        // publish a count.
        includeUnknownEnrollment: true,
      },
      ctx,
    );
    const conditionMatched = await service.countStudies(
      { queryCond: conditionQuery, includeUnknownEnrollment: true },
      ctx,
    );
    const locationMatched = await service.countStudies(
      {
        queryCond: conditionQuery,
        queryLocn: locationQuery,
        ...(geoFilter ? { filterGeo: geoFilter } : {}),
        includeUnknownEnrollment: true,
      },
      ctx,
    );

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
    // upstream order for sites with equal match scores. Under location.near the
    // radius decides instead, nearest first, and candidate order is untouched
    // (#205). Site coordinates are requested only to measure distances — the
    // admitted site's (#138), and every site's under location.near — and are
    // dropped here, so neither channel carries a leaf the other never renders.
    const studies: Record<string, unknown>[] = result.studies.map((study) => {
      const raw = study as RawStudyShape;
      const locationsModule = raw.protocolSection?.contactsLocationsModule;
      const upstream = locationsModule?.locations;
      if (!upstream?.length) return study;
      let bound: BoundSites;
      if (near) {
        bound = boundNearLocations(upstream, near, inRequestedCountry, input.locationLimit);
      } else {
        const siteMatchLocation = upstream.some(inRequestedCountry) ? gatedMatch : ungatedMatch;
        const sorted = [...upstream].sort(
          (a, b) =>
            locationMatchScore(b, siteMatchLocation) - locationMatchScore(a, siteMatchLocation),
        );
        bound = boundLocations(sorted, siteMatchLocation, input.locationLimit);
      }
      const { locations, summary } = bound;
      return {
        ...study,
        protocolSection: {
          ...raw.protocolSection,
          contactsLocationsModule: {
            ...locationsModule,
            locations: locations.map(({ geoPoint: _measuredOnly, ...loc }) => loc),
          },
        },
        ...(summary ? { locationSummary: summary } : {}),
      };
    });

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
        // Echoed only off the default, so a years call reads exactly as before.
        ...(ageUnit !== 'years' ? { ageUnit } : {}),
        sex: input.sex,
        conditionQuery,
        ...(statusFilter ? { statusFilter } : {}),
        advancedFilter,
        ...(geoFilter ? { geoFilter } : {}),
      },
      funnel: { conditionMatched, locationMatched, demographicsMatched },
    });

    if (result.studies.length === 0) {
      // The notice follows the funnel stage that collapsed and names only steps
      // that widen that stage: a later stage's filter cannot help, and a step
      // the request already takes sends the caller round in a circle.
      const noticeParts: string[] = [
        `No studies found for "${input.conditions.join(', ')}" matching the specified criteria.`,
      ];

      if (conditionMatched === 0) {
        // The condition-only count applies no other filter.
        noticeParts.push(
          'No study matches the condition alone, before any location, age, sex, healthy-volunteer, or status filter, so relaxing those cannot help. Add a synonym, a broader term, or a MeSH term as another conditions entry (entries are ORed), or use fewer words: an entry with spaces matches as a phrase.',
        );
      } else if (locationMatched === 0) {
        noticeParts.push(
          `${conditionMatched} studies match the condition, but none are in the specified location.`,
        );
        if (near) {
          noticeParts.push(
            `Widen location.near.radiusMi past ${plainDecimal(near.radiusMi)} to reach sites farther from the patient.`,
          );
        } else if (location.city || location.state) {
          // A radius around the patient reaches the neighbouring towns a city
          // misses and across the state line a state stops at (#205).
          noticeParts.push(
            "Remove city/state to search the whole country, or replace them with location.near — the patient's coordinates and a radiusMi, default 50 — to match sites by distance.",
          );
        } else {
          // The country is this tool's widest location, and location.near still
          // sends it, so only a radius replayed without it reaches past it and
          // across its borders. Nothing here geocodes, so the caller does.
          noticeParts.push(
            "To widen the search past the country, geocode the patient's location and replay searchCriteria through clinicaltrials_search_studies with geoFilter=distance(lat,lon,radius), the radius carrying a mi or km suffix (distance(47.6,-122.3,50mi)), in place of locationQuery and with includeUnknownEnrollment=true.",
          );
        }
      } else {
        noticeParts.push(
          `${locationMatched} studies match condition + location, but none pass the age/sex/status filters.`,
        );
        // Judged in years whatever unit the age came in; a years age keeps its
        // bare number in the note.
        const ageYears = (input.age * DAYS_PER_AGE_UNIT[ageUnit]) / DAYS_PER_AGE_UNIT.years;
        if (ageYears <= 1 || ageYears >= 100)
          noticeParts.push(
            `Age ${ageUnit === 'years' ? input.age : ageTerm} is at the extreme of typical trial ranges. Few trials enroll this age group.`,
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
      }
      ctx.enrich.notice(noticeParts.join(' '));
    } else {
      // Once per response, never per study: the caveat applies to every
      // candidate equally and would otherwise scale with the result count (#147).
      // The cap withheld candidates only when the caller asked past it and more
      // studies match; its sentence follows the caveat in the one notice. An
      // empty result lost nothing to the cap, so the no-match notice never
      // carries it.
      const shown = result.studies.length;
      if (input.maxResults > MAX_RESULTS_PER_CALL && demographicsMatched > shown) {
        ctx.enrich.truncated({
          shown,
          cap: MAX_RESULTS_PER_CALL,
          guidance: `${CANDIDATE_NOTICE} Requested maxResults ${input.maxResults} is above this tool's per-call cap of ${MAX_RESULTS_PER_CALL}, so this response holds ${shown} of ${demographicsMatched} candidates. Replay searchCriteria through clinicaltrials_search_studies with includeUnknownEnrollment=true to page through the rest.`,
        });
      } else {
        ctx.enrich.notice(CANDIDATE_NOTICE);
      }
    }

    return {
      studies,
      totalCount: result.totalCount,
      // The echo format() reads to say where each distance is measured from.
      ...(near ? { near } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const count = result.studies.length;

    if (count === 0) {
      lines.push('No candidate studies found.');
    } else {
      lines.push(
        result.totalCount !== undefined && result.totalCount > count
          ? `Found ${result.totalCount} candidate studies (showing ${count})`
          : `Found ${count} candidate studies`,
      );
    }
    // Under location.near every distance is from the patient's point, which
    // the site lines name; without it only an added site carries one, measured
    // from the nearest matched site (#138, #205). Upstream matches the country
    // and filter.geo on separate sites, so a candidate's sites in range can all
    // be across a border while its in-country site is far away; the header says
    // so once, and each site line names its country.
    const { near } = result;
    if (near) {
      lines.push(
        `Sites within ${plainDecimal(near.radiusMi)} mi of the patient at ${plainDecimal(near.lat)},${plainDecimal(near.lon)} (location.near), nearest first, in any country: ClinicalTrials.gov matches location.country on any one site of a study, separately from the radius, so a candidate's sites in range can all lie in another country.`,
      );
    }
    const distanceFrom = near ? 'the patient' : 'the nearest matched site';

    if (count > 0) {
      lines.push('');
      for (const study of result.studies) {
        const s = study as RawStudyShape;
        const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
        const title = s.protocolSection?.identificationModule?.briefTitle ?? 'Untitled';
        const status = s.protocolSection?.statusModule?.overallStatus ?? '';
        const elig = s.protocolSection?.eligibilityModule ?? {};
        const locs = s.protocolSection?.contactsLocationsModule?.locations ?? [];

        // Every single-line slot is folded with oneLine, so a line break in
        // registry text cannot end the line and forge a heading or a candidate.
        // The summary, a prose field under its own label, keeps its breaks (#180).
        lines.push(oneLine(`**${nctId}**: ${title} [${status}]`));

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
        if (studyMeta.length) lines.push(`  ${oneLine(studyMeta.join(' | '))}`);
        if (interventions?.length) {
          // Render every intervention name — content[] must match the full list
          // carried in structuredContent, not a first-3 preview (#91).
          const names = interventions.map((i) => i.name).filter(Boolean);
          if (names.length) lines.push(oneLine(`  Interventions: ${names.join(', ')}`));
        }
        const summary = s.protocolSection?.descriptionModule?.briefSummary;
        // Render the full summary — structuredContent carries it complete, so a
        // 200-char content[] clip left content-only clients with a partial value (#91).
        if (summary) lines.push(`  Summary: ${summary}`);

        // Demographic limits only — the free-text inclusion/exclusion criteria
        // are never requested, so the label must not read as an eligibility check.
        const eligParts: string[] = [];
        if (elig.minimumAge && elig.maximumAge)
          eligParts.push(`Age: ${elig.minimumAge}–${elig.maximumAge}`);
        else if (elig.minimumAge) eligParts.push(`Age: ≥${elig.minimumAge}`);
        else if (elig.maximumAge) eligParts.push(`Age: ≤${elig.maximumAge}`);
        if (elig.sex) eligParts.push(`Sex: ${elig.sex}`);
        if (elig.healthyVolunteers != null)
          eligParts.push(`Healthy Volunteers: ${elig.healthyVolunteers ? 'Yes' : 'No'}`);
        if (eligParts.length)
          lines.push(oneLine(`  Demographic criteria: ${eligParts.join(' | ')}`));

        // Disclose the bound the handler applied, so a content[]-only reader knows
        // the site list is the near-the-patient subset rather than the full one,
        // and knows how to reach the rest. Every locationSummary value renders
        // here — absent from the record means nothing was dropped (#80).
        const locationSummary = (study as { locationSummary?: LocationSummary }).locationSummary;
        if (locationSummary) {
          const truncated = locationSummary.locationsTruncated ? ', list truncated' : '';
          // "Nearest" is claimed only when the admitted site, always the last,
          // was measured — it then carries distanceMi, rendered on the site
          // itself below (#138). Under location.near the other sites carry one
          // too, so only the admitted site's own counts (#205).
          const measured = (locs.at(-1) as LocationWithDistance | undefined)?.distanceMi != null;
          const admitted = locationSummary.nearestRecruitingSiteAdded
            ? addedSiteClause(near !== undefined, measured, locs.length - 1)
            : '';
          // Under location.near the matched sites are the ones in range, in any
          // country, so the count names the radius, never the requested
          // location; with none in range it says what stands in (#205).
          const matchedCount = locationSummary.matchedLocations;
          const firstMeasured = (locs[0] as LocationWithDistance | undefined)?.distanceMi != null;
          const standIn = firstMeasured
            ? ', so the nearest measured site is shown'
            : ': no site publishes coordinates, so the sites are shown unmeasured';
          const matched = !near
            ? `${matchedCount} match the requested location`
            : `${matchedCount} within ${plainDecimal(near.radiusMi)} mi of the patient${matchedCount > 0 ? '' : standIn}`;
          lines.push(
            oneLine(
              `  Sites: showing ${locs.length} of ${locationSummary.totalLocations} registered (${matched}${truncated}${admitted}). Full site list: ${locationSummary.retrieveFullStudyWith} with ${nctId}.`,
            ),
          );
        }

        // Locations are sorted by match-score and bounded in the handler, so the
        // most relevant sites (typically the user's city/state) lead. Render
        // every site the record carries — a first-3 preview with a "(+N more)"
        // tail left content-only clients unable to see the rest (#91), and the
        // bound itself belongs at the handler boundary where both channels see
        // it, never in one channel's formatter (#46). Each site takes its own
        // line, followed by every contact it registers, one line apiece (#202):
        // no per-site bound, as in clinicaltrials_get_study_record, since
        // maxResults and locationLimit already size the response.
        if (locs.length > 0) {
          lines.push('  Locations:');
          for (const loc of locs as LocationWithDistance[]) {
            lines.push(oneLine(`    - ${siteLine(loc, distanceFrom)}`));
            for (const contact of loc.contacts ?? []) {
              const line = contactLine(contact);
              if (line) lines.push(oneLine(`      Contact: ${line}`));
            }
          }
        }

        // Central contacts — render all; the full set rides in structuredContent (#91).
        const centralContacts = s.protocolSection?.contactsLocationsModule?.centralContacts ?? [];
        if (centralContacts.length > 0) {
          const contactStr = centralContacts.map((c) => contactLine(c, ', ')).join(' | ');
          lines.push(oneLine(`  Contact: ${contactStr}`));
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
