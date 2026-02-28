/**
 * @fileoverview Study ranking utilities for clinical trial matching.
 * Provides condition relevance scoring used as a false-positive gate:
 * studies with zero token overlap against the patient's conditions are excluded
 * even if the ClinicalTrials.gov full-text index returned them.
 *
 * @module src/mcp-server/tools/utils/studyRanking
 */

/**
 * Calculates condition relevance by comparing a study's listed conditions
 * against the patient's input conditions using normalized token overlap.
 *
 * Used as a hard gate: a score of 0 means the study matched only via
 * incidental keyword hits in the API's full-text index, not the condition index.
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
 * // returns ~1.0 (strong token overlap on normalized form)
 *
 * calculateConditionRelevance(
 *   ["Cardiovascular Disease"],
 *   ["Type 2 Diabetes"],
 * )
 * // returns 0 (no overlap — study will be excluded)
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
      // Asymmetric: overlap relative to patient token count
      const score = overlap / patientTokens.size;
      bestOverlap = Math.max(bestOverlap, score);
    }
    totalRelevance += bestOverlap;
  }

  return totalRelevance / patientTokenSets.length;
}
