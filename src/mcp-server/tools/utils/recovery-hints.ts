/**
 * @fileoverview Shared recovery hint strings for error contracts surfaced
 * across multiple tools and resources. Centralizing keeps wire-payload
 * guidance consistent when the same failure reason fires from different
 * surfaces — the service throws only `data.reason`, and the framework fills
 * `data.recovery` from whichever tool or resource contract declares it.
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
    'Call clinicaltrials_get_field_definitions to browse the field tree; use PascalCase piece names like OverallStatus, Phase, or StudyType. AREA expressions and clinicaltrials_get_field_values take leaf pieces only: LeadSponsorName, not the group LeadSponsor.',
  enum_invalid:
    'Call clinicaltrials_get_field_values with fields=["OverallStatus"] or fields=["Phase"] to see the valid enum values the filter accepts.',
  query_parse_error:
    'Field-scoped search uses AREA[FieldName]value, which works in the free-text fields (query, conditionQuery, etc.) as well as in advancedFilter — call clinicaltrials_get_field_definitions to look up the right FieldName. A `[` or `]` outside an AREA[…] / RANGE[…] expression fails; `( )` group sub-expressions and are safe when matched; `,` acts as AND. Free-text fields otherwise take plain words plus AND, OR, NOT.',
  geo_invalid:
    'Build geoFilter as distance(lat,lon,radius) with a `mi` or `km` suffix on the radius, e.g. distance(47.6062,-122.3321,50mi) — a bare radius is rejected, since upstream would read it as meters. Keep latitude within [-90, 90], longitude within [-180, 180], and the radius above 0. Look up the city coordinates first.',
  sort_invalid:
    'Set sort to FieldName:asc or FieldName:desc on a date or numeric field, e.g. LastUpdatePostDate:desc or EnrollmentCount:desc, or to @relevance — at most 2 fields, comma-separated. Call clinicaltrials_get_field_definitions to confirm the PascalCase field name and its type.',
  page_token_invalid:
    'Re-run the same search criteria without pageToken to restart from the first page, then pass each nextPageToken back unchanged. Tokens expire when ClinicalTrials.gov refreshes its data, so continue a walk promptly rather than storing a token for later.',
  path_not_found:
    'Call clinicaltrials_get_field_definitions with mode="search" and query="phase" (or "enrollment") to find a path by concept, or mode="overview" for the top-level sections.',
  mode_mismatch:
    'Each mode reads its own arguments: "search" takes query (and limit), "drill" takes path (and includeIndexedOnly), "overview" takes none. Drop the argument the selected mode does not read, or re-issue the call under the mode that reads it.',
  mode_requires:
    'mode="search" needs `query` (a keyword such as "enrollment"); mode="drill" needs `path` (a dot-notation path such as "protocolSection.designModule"). Pass the argument the selected mode reads, or use mode="overview" to list the top-level sections first.',
  request_too_long:
    'Shorten the longest inputs — a free-text query, advancedFilter, or a long fields or conditions list — or split a long list across several calls with fewer entries each, so the request URL fits within the length ClinicalTrials.gov accepts.',
  rate_limited:
    'ClinicalTrials.gov rate-limited the request after several retries; wait about a minute before trying again.',
  retry_deadline_exceeded:
    'Retry after a minute or two. If the call asked for a lot at once — a large pageSize, many fields, or many nctIds — ask for less per call, or split the request across several calls.',
  upstream_timeout:
    'Retry after a few minutes. If it fails again, narrow the request — a more specific query or filter, a smaller pageSize, or fewer fields or nctIds — so ClinicalTrials.gov has less to compute and return.',
} as const;
