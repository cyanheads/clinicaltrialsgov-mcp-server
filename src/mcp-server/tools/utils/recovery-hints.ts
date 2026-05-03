/**
 * @fileoverview Shared recovery hint strings for error contracts surfaced
 * across multiple tools and resources. Centralizing keeps wire-payload
 * guidance consistent when the same failure reason fires from different
 * surfaces — the service throw site spreads `ctx.recoveryFor(reason)`,
 * which resolves whichever contract is attached to the active context.
 * @module mcp-server/tools/utils/recovery-hints
 */

export const RECOVERY_HINTS = {
  study_not_found:
    'Verify the NCT ID at clinicaltrials.gov or call clinicaltrials_search_studies to discover a valid identifier.',
  ids_not_found:
    'Verify each NCT ID exists at clinicaltrials.gov, or call clinicaltrials_search_studies first to discover valid identifiers.',
  field_invalid:
    'Call clinicaltrials_get_field_definitions to browse the field tree; use PascalCase piece names like OverallStatus, Phase, or StudyType.',
  path_not_found:
    'Call clinicaltrials_get_field_definitions with no path to see top-level sections.',
  rate_limited:
    'ClinicalTrials.gov rate-limited the request after several retries; wait about a minute before trying again.',
} as const;
