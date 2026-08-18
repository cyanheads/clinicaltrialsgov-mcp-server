/**
 * @fileoverview Shared recovery hint strings for error contracts surfaced
 * across multiple tools and resources. Centralizing keeps wire-payload
 * guidance consistent when the same failure reason fires from different
 * surfaces — the service throw site spreads `ctx.recoveryFor(reason)`,
 * which resolves whichever contract is attached to the active context.
 * @module mcp-server/tools/utils/recovery-hints
 */

export const RECOVERY_HINTS = {
  blank_value:
    'Supply a value containing non-whitespace, or for a list parameter at least one non-blank entry. Only when the parameter is optional and you meant to leave it unset, omit it entirely instead — omission and a blank value mean different things here.',
  study_not_found:
    'Verify the NCT ID at clinicaltrials.gov or call clinicaltrials_search_studies to discover a valid identifier.',
  ids_not_found:
    'Verify each NCT ID exists at clinicaltrials.gov, or call clinicaltrials_search_studies first to discover valid identifiers.',
  field_invalid:
    'Call clinicaltrials_get_field_definitions to browse the field tree; use PascalCase piece names like OverallStatus, Phase, or StudyType.',
  enum_invalid:
    'Call clinicaltrials_get_field_values with fields=["OverallStatus"] or fields=["Phase"] to see the valid enum values the filter accepts.',
  query_parse_error:
    'Field-scoped search uses AREA[FieldName]value, which works in the free-text fields (query, conditionQuery, etc.) as well as in advancedFilter — call clinicaltrials_get_field_definitions to look up the right FieldName. A `[` or `]` outside an AREA[…] / RANGE[…] expression fails; `( )` group sub-expressions and are safe when matched; `,` acts as AND. Free-text fields otherwise take plain words plus AND, OR, NOT.',
  geo_invalid:
    'Build geoFilter as distance(lat,lon,radius) with a `mi` or `km` suffix on the radius, e.g. distance(47.6062,-122.3321,50mi) — a bare radius is read as meters. Look up the city coordinates first.',
  sort_invalid:
    'Set sort to FieldName:asc or FieldName:desc, e.g. LastUpdatePostDate:desc — at most 2 fields, comma-separated. Call clinicaltrials_get_field_definitions to confirm the PascalCase field name.',
  path_not_found:
    'Call clinicaltrials_get_field_definitions with mode="search" and query="phase" (or "enrollment") to find a path by concept, or mode="overview" for the top-level sections.',
  rate_limited:
    'ClinicalTrials.gov rate-limited the request after several retries; wait about a minute before trying again.',
} as const;
