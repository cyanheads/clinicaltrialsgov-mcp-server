/**
 * @fileoverview Study ranking utilities for clinical trial matching.
 * Provides functions to calculate weights and rank studies based on
 * various criteria including phase, enrollment, and location relevance.
 *
 * @module src/mcp-server/tools/utils/studyRanking
 */

/**
 * Interface for a rankable study (must have match score, locations, and details).
 */
export interface RankableStudy {
  matchScore: number;
  locations: Array<{ distance?: number | undefined }>;
  studyDetails: {
    phase?: string[] | undefined;
    enrollmentCount?: number | undefined;
  };
}

/**
 * Calculates a numeric weight for a study phase.
 * Higher phases (more advanced trials) receive higher weights.
 *
 * @param phases - Array of phase strings (e.g., ["Phase 3", "Phase 4"])
 * @returns Numeric weight representing the highest phase (0-4)
 *
 * @example
 * getPhaseWeight(["Phase 3"]) // returns 3
 * getPhaseWeight(["Phase 1", "Phase 2"]) // returns 2 (max)
 * getPhaseWeight(["N/A"]) // returns 0
 * getPhaseWeight(undefined) // returns 0
 */
export function getPhaseWeight(phases?: string[]): number {
  if (!phases || phases.length === 0) return 0;

  const phaseMap: Record<string, number> = {
    'Phase 4': 4,
    'Phase 3': 3,
    'Phase 2': 2,
    'Phase 1': 1,
    'N/A': 0,
    'Not Applicable': 0,
  };

  // Return the maximum phase weight from the array
  return Math.max(...phases.map((p) => phaseMap[p] ?? 0));
}

/**
 * Ranks an array of studies based on multiple criteria.
 * Sorting priority: matchScore → location count → phase → enrollment count.
 *
 * @param studies - Array of studies to rank
 * @returns Sorted array with highest-ranked studies first
 *
 * @example
 * rankStudies([study1, study2, study3])
 * // returns studies sorted by relevance
 */
export function rankStudies<T extends RankableStudy>(studies: T[]): T[] {
  return [...studies].sort((a, b) => {
    // Primary: Match score (higher is better)
    if (a.matchScore !== b.matchScore) {
      return b.matchScore - a.matchScore;
    }

    // Secondary: Number of nearby locations (more is better)
    const aLocationCount = a.locations.length;
    const bLocationCount = b.locations.length;
    if (aLocationCount !== bLocationCount) {
      return bLocationCount - aLocationCount;
    }

    // Tertiary: Study phase (later phase = more established)
    const aPhase = getPhaseWeight(a.studyDetails.phase);
    const bPhase = getPhaseWeight(b.studyDetails.phase);
    if (aPhase !== bPhase) {
      return bPhase - aPhase;
    }

    // Quaternary: Enrollment count (higher = more capacity)
    const aEnrollment = a.studyDetails.enrollmentCount ?? 0;
    const bEnrollment = b.studyDetails.enrollmentCount ?? 0;
    return bEnrollment - aEnrollment;
  });
}

/**
 * Calculates a weighted match score combining condition relevance and demographic eligibility.
 *
 * Condition relevance is the dominant factor (0–60 points). Demographic checks (age, sex,
 * healthy volunteers, location) contribute the remaining 0–40 points, evenly split.
 *
 * @param conditionRelevance - Condition relevance score (0–1)
 * @param demographicChecks - Array of demographic eligibility check results
 * @returns Match score (0–100), rounded to the nearest integer
 *
 * @example
 * calculateMatchScore(0.85, [
 *   { eligible: true },
 *   { eligible: true },
 *   { eligible: true },
 *   { eligible: true },
 * ])
 * // returns 91 (51 condition + 40 demographic)
 */
export function calculateMatchScore(
  conditionRelevance: number,
  demographicChecks: Array<{ eligible: boolean }>,
): number {
  const CONDITION_WEIGHT = 60;
  const DEMOGRAPHIC_WEIGHT = 40;

  const conditionScore = conditionRelevance * CONDITION_WEIGHT;

  const demographicScore =
    demographicChecks.length > 0
      ? (demographicChecks.filter((c) => c.eligible).length /
          demographicChecks.length) *
        DEMOGRAPHIC_WEIGHT
      : 0;

  return Math.round(conditionScore + demographicScore);
}

/**
 * Calculates condition relevance by comparing a study's listed conditions
 * against the patient's input conditions using normalized token overlap.
 *
 * @param studyConditions - Conditions listed on the study (from `conditionsModule.conditions`)
 * @param patientConditions - Conditions the patient reported
 * @returns Relevance score between 0 and 1
 *
 * @example
 * calculateConditionRelevance(
 *   ["Diabetes Mellitus, Type 2", "Hyperglycemia"],
 *   ["Type 2 Diabetes"],
 * )
 * // returns ~0.67 (strong overlap on normalized tokens)
 */
export function calculateConditionRelevance(
  studyConditions: string[],
  patientConditions: string[],
): number {
  if (studyConditions.length === 0 || patientConditions.length === 0) return 0;

  const normalize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);

  const patientTokenSets = patientConditions.map((c) => new Set(normalize(c)));

  // For each patient condition, find the best-matching study condition
  let totalRelevance = 0;
  for (const patientTokens of patientTokenSets) {
    if (patientTokens.size === 0) continue;

    let bestOverlap = 0;
    for (const studyCond of studyConditions) {
      const studyTokens = normalize(studyCond);
      const overlap = studyTokens.filter((t) => patientTokens.has(t)).length;
      // Jaccard-like: overlap relative to patient token count
      const score = overlap / patientTokens.size;
      bestOverlap = Math.max(bestOverlap, score);
    }
    totalRelevance += bestOverlap;
  }

  return totalRelevance / patientTokenSets.length;
}
