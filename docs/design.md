# ClinicalTrials.gov MCP Server — Design

## MCP Surface

### Tools

| Name                               | Description                                                                                                                                                       | Key Inputs                                                                                                                                                                               | Annotations                                       |
| :--------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| `clinicaltrials_search_studies`    | Search for clinical trial studies using queries, filters, pagination, and field selection.                                                                        | `query`, `conditionQuery`, `interventionQuery`, `locationQuery`, `sponsorQuery`, `statusFilter`, `phaseFilter`, `advancedFilter`, `geoFilter`, `sort`, `fields`, `pageSize`, `pageToken` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_results` | Extract outcomes, adverse events, participant flow, baseline characteristics, and results metadata for completed studies with results.                            | `nctIds`, `sections`, `summary`, `outcomeLimit`, `adverseEventLimit`, `outcomeOffset`, `seriousEventOffset`, `otherEventOffset`                                                           | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_field_values`  | Discover valid values for any ClinicalTrials.gov field with study counts per value. Use before constructing searches to find valid filter options.                | `fields`                                                                                                                                                                                 | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_count`   | Get total study count matching a query without fetching study data. Use for quick stats and building breakdowns by calling multiple times with different filters. | `query`, `conditionQuery`, `interventionQuery`, `statusFilter`, `phaseFilter`, `advancedFilter`                                                                                          | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_field_definitions` | Get field definitions from the study data model — piece names, types, nesting. For discovering available fields and AREA[] filter targets.                   | `mode`, `query`, `path`, `limit`, `includeIndexedOnly`                                                                                                                                                             | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_record`  | Fetch a single study by NCT ID. The tool equivalent of the `clinicaltrials://{nctId}` resource, for clients that don't read resources.                            | `nctId`, `locationLimit`, `outcomeLimit`, `referenceLimit`, `nearLocation`                                                                                                               | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_find_eligible`     | Match patient demographics to recruiting clinical trials. Builds optimized API queries from a patient profile and returns studies with eligibility/location fields. | `age`, `sex`, `conditions`, `location`, `healthyVolunteer`, `recruitingOnly`, `maxResults`, `locationLimit`                                                                                             | `readOnlyHint`, `idempotentHint`, `openWorldHint` |

### Resources

| URI Template               | Description                                                       | Pagination |
| :------------------------- | :---------------------------------------------------------------- | :--------- |
| `clinicaltrials://{nctId}` | Fetch a single clinical study by NCT ID. Returns a bounded study record. | No         |

### Prompts

| Name                      | Description                                                                                                                                                                                | Args                  |
| :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------- |
| `analyze_trial_landscape` | Guides systematic analysis of a clinical trial landscape using study counts and search. Teaches the multi-call workflow for building breakdowns by phase, status, year, sponsor type, etc. | `topic`, `focusAreas` |

---

## Overview

MCP server wrapping the [ClinicalTrials.gov REST API v2](https://clinicaltrials.gov/data-api/api) — the US National Library of Medicine's registry of ~577K clinical trial studies. Public, read-only, no auth required.

**Target users:** LLM agents helping people research clinical trials — patients seeking eligible studies, researchers analyzing trial landscapes, clinicians comparing treatment options.

**Scope:** Read-only. The API has no write operations.

---

## Requirements

- All operations are read-only — no state mutation
- No API key required (public API)
- Rate limit: ~1 request/second (inferred from `robots.txt Crawl-delay: 1`)
- Pagination via opaque cursor tokens; `countTotal=true` returns total on first page only
- Max page size: 1000 studies
- Response payloads can be large (~70KB per full study); field selection is critical
- API uses Essie search engine with weighted field areas
- Advanced filtering via `AREA[]` syntax (Essie expressions)
- Geographic filtering via `distance(lat,lon,radius)` function

---

## Tool Designs

### 1. `clinicaltrials_search_studies`

The primary tool. Wraps `GET /studies` with the full query/filter surface exposed through ergonomic parameters.

**Description:**

```
Search for clinical trial studies from ClinicalTrials.gov. Supports full-text and
field-specific queries, status/phase/geographic filters, pagination, sorting, and field
selection. Returns a compact per-study index by default; pass the fields parameter to get specific leaves at full fidelity — full study records are ~70KB each.
```

**Input schema:**

| Parameter           | Type                  | Description                                                                                                                                                                                                                                                                                             |
| :------------------ | :-------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `query`             | `string?`             | General full-text search across all fields (conditions, interventions, sponsors, etc.). Maps to `query.term`.                                                                                                                                                                                           |
| `conditionQuery`    | `string?`             | Condition/disease-specific search. More precise than general query — searches only the condition/synonym index. E.g., `"Type 2 Diabetes"`, `"non-small cell lung cancer"`. Maps to `query.cond`.                                                                                                        |
| `interventionQuery` | `string?`             | Intervention/treatment-specific search. E.g., `"pembrolizumab"`, `"cognitive behavioral therapy"`. Maps to `query.intr`.                                                                                                                                                                                |
| `locationQuery`     | `string?`             | Location search — city, state, country, or facility name. E.g., `"Seattle"`, `"United States"`. Maps to `query.locn`.                                                                                                                                                                                   |
| `sponsorQuery`      | `string?`             | Sponsor/collaborator name search. Searches both lead sponsor and collaborators. For lead sponsor only, use `advancedFilter` with `AREA[LeadSponsorName]`. Maps to `query.spons`.                                                                                                                        |
| `titleQuery`        | `string?`             | Search within study titles and acronyms only. Maps to `query.titles`.                                                                                                                                                                                                                                   |
| `outcomeQuery`      | `string?`             | Search within outcome measure fields. Maps to `query.outc`.                                                                                                                                                                                                                                             |
| `statusFilter`      | `string \| string[]?` | Filter by overall study status. Values: `RECRUITING`, `COMPLETED`, `ACTIVE_NOT_RECRUITING`, `NOT_YET_RECRUITING`, `ENROLLING_BY_INVITATION`, `SUSPENDED`, `TERMINATED`, `WITHDRAWN`.                                                                                                                    |
| `phaseFilter`       | `string \| string[]?` | Filter by trial phase. Values: `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`, `NA`.                                                                                                                                                                                                            |
| `advancedFilter`    | `string?`             | Advanced filter using AREA[] Essie syntax. Examples: `AREA[StudyType]INTERVENTIONAL`, `AREA[MinimumAge]RANGE[MIN, 18 years]`, `AREA[EnrollmentCount]RANGE[100, 1000]`. Combine with `AND`/`OR`/`NOT` and parentheses.                                                                                   |
| `geoFilter`         | `string?`             | Geographic proximity filter. Format: `distance(lat,lon,radius)` where radius carries a required `mi` or `km` suffix. Example: `distance(47.6062,-122.3321,50mi)` for studies within 50 miles of Seattle. Validated in the handler before the upstream call — a unit-less radius, a non-positive radius, a latitude outside [-90, 90] or a longitude outside [-180, 180] all fail as `geo_invalid` (upstream reads a bare radius as meters and answers an empty 200, so none of these would otherwise surface as an input error). |
| `nctIds`            | `string \| string[]?` | Filter to specific NCT IDs. Use for batch lookups of known studies.                                                                                                                                                                                                                                     |
| `fields`            | `string[]?`           | Specific fields to return (PascalCase piece names). **Strongly recommended** — without this, results are a compact per-study index; pass `fields` to receive those leaves at full fidelity (a full record is ~70KB). Common fields: `NCTId`, `BriefTitle`, `OverallStatus`, `Phase`, `LeadSponsorName`, `Condition`, `InterventionName`, `BriefSummary`, `EnrollmentCount`, `StartDate`. |
| `sort`              | `string?`             | Sort order. Format: `FieldName:asc` or `FieldName:desc`. E.g., `LastUpdatePostDate:desc`, `EnrollmentCount:desc`. Default: relevance when query params present. Max 2 sort fields comma-separated.                                                                                                      |
| `pageSize`          | `number?`             | Results per page, 1–1000. Default: 10.                                                                                                                                                                                                                                                                  |
| `pageToken`         | `string?`             | Pagination cursor from a previous response's `nextPageToken`.                                                                                                                                                                                                                                           |
| `countTotal`        | `boolean?`            | Include total study count in response. Only computed on the first page. Default: true.                                                                                                                                                                                                                  |

**Output schema:**

| Field           | Type      | Description                                                               |
| :-------------- | :-------- | :------------------------------------------------------------------------ |
| `studies`       | `Study[]` | Matching studies. By default each entry is a **compact index projection** — `nctId`, `briefTitle`, `overallStatus`, `phases`, `enrollmentCount`, `leadSponsor`, `conditions`, and a bounded `{ total, nearest }` locations summary — mirroring the rendered summary, **not** the full ~70KB record. With explicit `fields`, each entry carries exactly the requested leaves at full fidelity (e.g. every location). |
| `totalCount`    | `number?` | Total matching studies (present when `countTotal=true`, first page only). |
| `nextPageToken` | `string?` | Token for the next page. Absent on last page.                             |
| `requestedFields` | `string[]?` | Echo of the explicit `fields` input — present only when `fields` was passed. Signals the full-fidelity (non-index) study shape. |
| `pageExhausted` | `boolean?` | `true` when the call supplied a `pageToken` and the continuation page came back empty: the walk is finished, not unmatched. Absent otherwise, including on an empty first page. Whether the request itself carried a cursor is the only signal available — an exhausted page carries neither `totalCount` nor `nextPageToken` — so no look-ahead request or cross-call state is involved. `format()` renders a matching line and the empty-result `notice` withholds its broaden-the-search guidance, so both channels read the page the same way. |

**Error messages:**

- Invalid filter syntax: `"Invalid advancedFilter expression. AREA[] syntax: AREA[FieldName]value. Combine with AND/OR/NOT. Check field names via get_field_values."`
- No results: returns empty studies array with `totalCount: 0`, not an error. An empty first page carries a `notice` naming the constraints that matched nothing: broadening guidance for queries and filters, and — when `nctIds` was supplied — an ID-aware clause. An ID-only lookup gets the ID clause alone, pointing at `clinicaltrials_get_study_record` (a direct not-found check; upstream 404s a nonexistent NCT ID cleanly) and `clinicaltrials_get_study_results` (which resolves a previous/alias ID to its canonical study). Combined with a query or filter, the ID clause is added alongside the existing guidance and asserts nothing about whether the IDs exist — distinguishing "no such study" from "excluded by the other criteria" would cost an extra upstream request. A partial match is not an empty result and carries no notice. An exhausted continuation page (`pageExhausted`) carries no notice of any kind, `nctIds` or not.

**Format function:** Summary line (`Found N studies (M total matching)`), then **every** study in the page as a compact index row (NCT ID, title, status; a phase/enrollment/sponsor/conditions meta line; and a lead-or-nearest site line with the total site count), pagination note if more pages. With explicit `fields`, each study instead renders every requested leaf, including all locations.

**Output-channel parity (#86):** `structuredContent` is bound to exactly what `format()` renders — the compact index by default, the requested-leaf projection with `fields`. Search is an index: it never carries full ~70KB records in `structuredContent` while summarizing them in `content[]`. This keeps `content[]`-only clients (e.g. Claude Desktop) and `structuredContent` clients (e.g. Claude Code) in parity. Fetch one full record with `clinicaltrials_get_study_record`.

---

### 2. `clinicaltrials_get_study_results`

Extracts and reshapes the deeply nested `resultsSection` from completed studies. This is a workflow tool — the raw results data is complex and deeply nested; the tool flattens it into a structured, LLM-readable format.

**Description:**

```
Fetch trial results data for completed studies — outcome measures with statistics, adverse
events, participant flow, and baseline characteristics. Only available for studies where
hasResults is true. Use search_studies first to find studies with results.
```

**Input schema:**

| Parameter  | Type                  | Description                                                                                                                 |
| :--------- | :-------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `nctIds`   | `string \| string[]`  | One or more NCT IDs (max 20). E.g., `"NCT12345678"` or `["NCT12345678", "NCT87654321"]`. Repeated IDs collapse to one entry, in first-occurrence order. A previous (alias) ID resolves to its canonical study. |
| `sections` | `string \| string[]?` | Filter which sections to return. Values: `outcomes`, `adverseEvents`, `participantFlow`, `baseline`, `moreInfo`. Omit for all sections. |
| `summary`  | `boolean?`            | Return condensed summaries instead of full data, which can exceed 500KB per study. Typically a few KB — it scales with the measure count, not to a fixed ceiling. Default: `false`.                                     |
| `outcomeLimit` | `number?` | Cap on outcome measures returned per study (1–100), in upstream order. Omit for no cap. Full mode only. |
| `adverseEventLimit` | `number?` | Cap on adverse events returned per study (1–500), applied to the serious and other lists separately. Omit for no cap. Full mode only; event groups are never capped. |
| `outcomeOffset` | `number?` | Index of the first outcome measure to return (≥ 0). Pairs with `outcomeLimit` to page a long list. |
| `seriousEventOffset` | `number?` | Index of the first serious adverse event to return (≥ 0). Pages independently of `otherEventOffset`. |
| `otherEventOffset` | `number?` | Index of the first other adverse event to return (≥ 0). Pages independently of `seriousEventOffset`. |

**Bounded continuation:** the caps bound a large record; the offsets resume one. Both are applied once in the handler, ahead of `structuredContent` and `format()` — a `format()`-side bound would leave one channel carrying rows the other never shows. Offsets apply uniformly to every study in the call, so continuation is reported **per study** in its own `filtersApplied`: each study exhausts its lists at a different index. For every list left short, that study's `filtersApplied` names the applied offset and the next one to request (`nextOutcomeOffset`, `nextSeriousEventOffset`, `nextOtherEventOffset`); a list is exhausted when its next offset is absent. Nothing is disclosed for a list a bound did not actually trim, including a window that lands exactly on the end. `seriousEvents` and `otherEvents` page on their own axes — their lengths are uncorrelated (87/328 on NCT02130466, 248/51 on NCT05226598) — and the group rosters (`eventGroups`, and `groups[]` on outcomes and baseline) ride every page unbounded, since every per-item stat joins back to them by id. An offset at or past the end returns an empty list with the upstream total, not an error. There is no default bound: an unbounded call returns everything, as before. `participantFlow`, `baseline`, and `moreInfo` are never bounded.

Every page costs a full upstream fetch — the ClinicalTrials.gov v2 API has no results-level pagination, so the slice is local and each page re-pulls the whole `ResultsSection` under the service's ~1 req/sec limit. Continuation buys context budget, not bandwidth.

An offset the call cannot honor is answered rather than ignored: an offset supplied with `summary: true`, or one targeting a section the `sections` filter excludes, is a typed `offset_not_applicable` rejection. (The two *limits* keep their pre-existing silent no-op in those situations.)

**Summary-mode outcome shape:** each measure keeps its identifying metadata (`type`, `title`, `timeFrame`, `paramType`, `dispersionType`, `unitOfMeasure`, `reportingStatus`, `groupCount`, `classCount`), its per-group `denoms`, one `topAnalysis` lifted from `analyses[0]`, and `topStats` — the per-group cells of a single `classes[0].categories[0]` projection. Each `topStats` entry carries the upstream `value` verbatim (an `NA`/`NR` sentinel included, never re-interpreted), plus `spread`, `lowerLimit`/`upperLimit`, and the record's own `comment` when present — ClinicalTrials.gov publishes no structured field saying why a value is missing, so the comment is the only signal and is passed through rather than read. `topStatsFrom` names the projection: `classTitle` / `categoryTitle` for the cell that survived, `omittedClasses` / `omittedCategories` for the siblings it displaced, and a `note` pointing at `summary: false` when anything was dropped. Upstream titles a class or category only when more than one exists, so the label that disambiguates a retained value is exactly the one a bare projection would discard.

**Output schema:**

| Field                   | Type                | Description                                                                                            |
| :---------------------- | :------------------ | :----------------------------------------------------------------------------------------------------- |
| `results`               | `StudyResults[]`    | Extracted results per study. Each contains `nctId`, `title`, `hasResults`, the requested sections, and — when a bound trimmed one of its lists — `filtersApplied`. |
| `canonicalNctId`        | `string?`           | On a `results[]` entry: the canonical NCT ID of the study that answered, present only when the requested `nctId` is a previous (alias) ID pointing at a different record. |
| `filtersApplied`        | `object?`           | On a `results[]` entry: what the bounds trimmed on that study — `totalOutcomes` / `totalSeriousEvents` / `totalOtherEvents`, the applied `outcomeLimit` / `adverseEventLimit` / `outcomeOffset` / `seriousEventOffset` / `otherEventOffset`, and `nextOutcomeOffset` / `nextSeriousEventOffset` / `nextOtherEventOffset` for each list left short. Absent when nothing was trimmed. |
| `studiesWithoutResults` | `string[]?`         | NCT IDs of studies that don't have results available.                                                  |
| `fetchErrors`           | `{nctId, error}[]?` | NCT IDs that failed to fetch with error details.                                                       |
| `truncated`             | `boolean?`          | True when a bound trimmed a list on at least one study. Absent when nothing was trimmed, matching `filtersApplied` one level down. |

**Partial success semantics:** Studies are fetched in one batch request, falling back to sequential per-ID fetches when the batch is rejected outright (a malformed ID — an ordinary nonexistent but well-formed ID is answered 200 with the record simply absent). Individual failures are reported in `fetchErrors` without failing the request — including when every requested ID fails. A rate limit is the exception: it affects the whole request, so it is thrown as a retryable `rate_limited` error rather than entering the per-ID fallback.

**Previous (alias) NCT IDs:** ClinicalTrials.gov reassigns some records, leaving the old ID as an alias. Both fetch paths resolve it silently — the batch endpoint rewrites the ID, the single-study endpoint 301-redirects — and answer under the canonical ID. `NCTIdAlias` is requested alongside `NCTId` so the returned record can be matched back to the ID the caller asked for; `results[].nctId` echoes that requested ID and `canonicalNctId` names the study that answered. Requesting an alias and its own canonical ID together returns one entry per requested ID, both carrying the same study, even though the batch endpoint deduplicates them to a single record.

**Error messages:**

- No results: `"Study NCT12345678 does not have results data. Only completed studies with hasResults=true have results. Search for studies with results using advancedFilter: AREA[ResultsFirstPostDate]RANGE[MIN,MAX]"`

---

### 3. `clinicaltrials_get_field_values`

Discovery tool for building informed queries. Wraps `GET /stats/field/values`.

**Description:**

```
Discover valid values for ClinicalTrials.gov fields with study counts per value. Use to
explore available filter options before building a search — e.g., valid OverallStatus, Phase,
InterventionType, StudyType, or LeadSponsorClass values.
```

**Input schema:**

| Parameter | Type                 | Description                                                                                                                                                                                                             |
| :-------- | :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fields`  | `string \| string[]` | PascalCase piece name(s) to get values for. Common fields: `OverallStatus`, `Phase`, `StudyType`, `InterventionType`, `LeadSponsorClass`, `Sex`, `StdAge`, `DesignAllocation`, `DesignPrimaryPurpose`, `DesignMasking`. |

**Output schema:**

| Field        | Type          | Description                                                                                                                                          |
| :----------- | :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fieldStats` | `FieldStat[]` | Per-field stats. Always `{ field, piece, type, missingStudiesCount?, multiValued? }`, plus the statistics variant the field's `type` carries (below). |

Upstream keys the statistics shape on `type` and omits the keys a variant does not carry:

| `type`              | Variant fields                                                                                                                |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------- |
| `ENUM`, `STRING`    | `uniqueValuesCount`, `topValues: {value, studiesCount}[]`; `STRING` may add `longest: {value, length, nctId}`                  |
| `BOOLEAN`           | `trueCount`, `falseCount`                                                                                                     |
| `INTEGER`, `NUMBER` | `min`, `max`, `avg` — numbers, each individually optional                                                                      |
| `DATE`              | `min`, `max` — date strings keeping the upstream precision, so `"1900-01"` stays partial — and `formats: string[]`             |

`multiValued` marks a repeated field: array-typed itself (`Phase`) or nested under a repeated object (`LocationCountry`, one per site). Its per-value `studiesCount` buckets sum above the study total, so they are not percentages of the corpus.

**Format function:** One block per field. `type` picks the header and, when a field reports no statistics at all, which absence line is honest for that variant; every statistic renders on presence, since upstream already omits the keys a variant does not carry. ENUM/STRING list every fetched value with its count, the 250-cap disclosure, and the longest value; BOOLEAN lists the true/false counts; INTEGER/NUMBER and DATE render their range. An absent `topValues` on those last two is a different statistics variant, not an empty dataset, so they never render the ENUM/STRING "No recorded values" line.

---

### 4. `clinicaltrials_get_field_definitions`

Discovery tool for the study data model. Wraps `GET /studies/metadata`. Requires an explicit `mode`: `"search"` (keyword search), `"drill"` (subtree browsing by `path`), or `"overview"` (top-level sections).

**Description:**

```
Get field definitions from the ClinicalTrials.gov study data model. Returns the field
tree with piece names (used in the fields parameter and AREA[] filters), data types,
and nesting structure. Use to discover available fields for search results, find piece
names for AREA[] filter expressions, or explore the study data model structure.
```

**Input schema:**

| Parameter          | Type        | Description                                                                                                                                                           |
| :----------------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`             | `enum`      | Required. `"search"` (keyword search, needs `query`), `"drill"` (subtree by `path`), or `"overview"` (top-level sections).                                            |
| `query`            | `string?`   | search mode only. Keyword to match field names against (e.g., `"enrollment"`, `"sponsor"`).                                                                           |
| `path`             | `string?`   | drill mode only. Dot-notation path to navigate into (e.g., `"protocolSection.designModule"`).                                                                         |
| `limit`            | `number?`   | search mode only. Max results to return. Default: 20.                                                                                                                 |
| `includeIndexedOnly` | `boolean?` | drill mode only. Only return indexed (searchable) fields. Default: false.                                                                                            |

**Output schema:**

| Field          | Type            | Description                                                               |
| :------------- | :-------------- | :------------------------------------------------------------------------ |
| `fields`       | `FieldDef[]`    | Field definitions with name, piece, sourceType, type, isEnum, path.       |
| `totalFields`  | `number`        | Total fields returned (including nested).                                 |
| `resolvedPath` | `string?`       | The resolved path (when mode is `"drill"`).                               |

**Behavior:**

- `mode="overview"`: returns top-level overview (2 levels deep) — sections and their direct children. Prevents context bloat.
- `mode="drill"`: navigates to the `path` subtree and flattens all descendants.
- `mode="search"`: returns keyword matches for `query`, ranked by relevance and capped by `limit`.
- The per-parameter mode scope above is enforced, not advisory: an argument belonging to another mode is rejected rather than silently ignored, and so is a whitespace-only value for the selected mode's required argument. `limit` is the one exception — it carries a schema default, so an explicit value is indistinguishable from an omitted one by the time the handler runs, and `overview`/`drill` go on ignoring it.

**Error messages:**

- Invalid path: `"Path 'X' not found. Top-level sections: protocolSection, resultsSection, annotationSection, documentSection, derivedSection, hasResults."`
- Cross-mode argument: `"Parameter 'query' does not apply to mode=\"overview\" and would be ignored."` (reason `mode_mismatch`)
- Blank required argument: the shared `blank_value` message, naming `query` or `path`.
- Omitted required argument: `"mode=\"search\" requires \`query\`. Pass a keyword to search by."` (reason `mode_requires`, `data.param` naming the argument)

**Format function:** Tree-style display.

---

### 5. `clinicaltrials_get_study_record`

Single-study lookup by NCT ID. Wraps `GET /studies/{nctId}`. The tool equivalent of the `clinicaltrials://{nctId}` resource, for clients that don't read resources — the difference is that the caps here are the caller's to set (or omit), while the resource's are fixed server-side.

**Description:**

```
Fetch a single clinical trial study by NCT ID from ClinicalTrials.gov. Returns the full study
record including protocol details, eligibility criteria, outcomes, arms, interventions, contacts,
and locations. Optional locationLimit / outcomeLimit / referenceLimit / nearLocation parameters
trim locations, outcomes, and references — original totals are preserved in filtersApplied only
when a cap actually trims the set.
```

**Input schema:**

| Parameter        | Type      | Description                                                                                                 |
| :--------------- | :-------- | :---------------------------------------------------------------------------------------------------------- |
| `nctId`          | `string`  | Required. `NCT` followed by 8 digits (e.g., `NCT03722472`).                                                 |
| `locationLimit`  | `number?` | Cap on locations returned (1–500). Omit for the full upstream list.                                         |
| `outcomeLimit`   | `number?` | Cap on secondary and other outcomes (1–100). Primary outcomes are never capped.                             |
| `referenceLimit` | `number?` | Cap on references (1–100). `seeAlsoLinks` are never capped.                                                 |
| `nearLocation`   | `object?` | `{ lat, lon, radiusMi }` (radius default 50). Filters locations to the radius, sorts by distance, adds `distanceMi`. Sites without published coordinates are dropped. |

**Output schema:**

| Field            | Type       | Description                                                                                                  |
| :--------------- | :--------- | :------------------------------------------------------------------------------------------------------------ |
| `study`          | `Study`    | The record with the caller's filters already applied. `protocolSection`, `derivedSection`, `documentSection`, `annotationSection`, `hasResults`. The heavy `resultsSection` is omitted. |
| `filtersApplied` | `object`   | Which caps trimmed a list, each with the upstream total. Empty when nothing was trimmed.                     |
| `resultsSummary` | `object?`  | Counts of the omitted posted results, present when the study has results to count.                           |

**Behavior:**

- Filters are applied once, before either output channel sees the record, so `structuredContent` and `format()` render the same data. A cap (and its upstream total) is echoed in `filtersApplied` only when it actually trimmed something — reporting a cap that trimmed nothing would imply a filter ran when none did. `nearLocation` always filters, so it is always echoed.
- The `resultsSection` (up to ~600KB on a large trial, against ~70KB of protocol) is dropped and replaced by `resultsSummary` counts. Fetch the data itself with `clinicaltrials_get_study_results`.
- A `nearLocation` filter that matched nothing still renders the Locations header and the reason. Omitting the section would make "sites exist, none within the radius" indistinguishable from "this study publishes no sites at all".
- **Document download URLs.** Each entry in `documentSection.largeDocumentModule.largeDocs[]` gains a `downloadUrl`. Upstream carries only a bare `filename`, which leaves a caller who can see that a protocol or SAP exists with no way to retrieve it.
  - Construction: `https://cdn.clinicaltrials.gov/large-docs/{XX}/{nctId}/{filename}`, where `{XX}` is the last two digits of the NCT number (zero-padded — `NCT03607500` → `00`) and the filename is URL-encoded as a path segment. `{XX}` is a per-study shard, not a fixed segment: the same filename under another study's prefix 404s.
  - This is an **observed CDN pattern, not a documented API contract** — the official OpenAPI v2 `LargeDoc` schema defines no URL field. Treat it as best-effort.
  - The NCT ID comes from the record's own `identificationModule.nctId`, not the one the caller passed: upstream resolves a previous (alias) ID to its canonical record, and the shard follows the canonical ID.
  - An entry with no `filename` gets no `downloadUrl` rather than a fabricated one.
  - The builder lives in `services/clinical-trials/document-url.ts` — its own module, so tool and resource tests that mock the service module still reach it. It is applied in the shared pre-render pass (`applyFilters`), the one place both this tool and the `clinicaltrials://{nctId}` resource route a whole record through, so the two surfaces cannot disagree about where a document lives.

**Error messages:**

- Unknown NCT ID: `study_not_found` (`NotFound`) — upstream 404s a nonexistent ID cleanly.
- Upstream 429 after the retry budget: `rate_limited` (`RateLimited`, retryable).

**Format function:** A `# Study {nctId}: {title}` header, then the protocol record section by section — status/design, dates, sponsor, conditions and MeSH terms, summary, eligibility, interventions, arms, outcomes, results summary, contacts, locations, IPD sharing, documents (each with its `downloadUrl` rendered verbatim), references, annotations — closing with a `*Filters applied: …*` footer that guarantees every `filtersApplied` field reaches `content[]` regardless of which sections rendered.

---

### 6. `clinicaltrials_get_study_count`

Lightweight count-only tool. Uses `GET /studies?countTotal=true&pageSize=0` to get a total without fetching any study data. Replaces the heavy `analyze_trends` tool — the LLM can call this multiple times with different filters to build breakdowns.

**Description:**

```
Get total study count matching a query without fetching study data. Fast and lightweight.
Use for quick statistics or to build breakdowns by calling multiple times with different filters
(e.g., count by phase, count by status, count recruiting vs completed for a condition).
```

**Input schema:**

| Parameter           | Type                  | Description                        |
| :------------------ | :-------------------- | :--------------------------------- |
| `query`             | `string?`             | General full-text search.          |
| `conditionQuery`    | `string?`             | Condition/disease search.          |
| `interventionQuery` | `string?`             | Intervention/treatment search.     |
| `locationQuery`     | `string?`             | Location search (city/state/country/facility). Maps to `query.locn`. |
| `sponsorQuery`      | `string?`             | Sponsor search.                    |
| `titleQuery`        | `string?`             | Search within study titles/acronyms. Maps to `query.titles`. |
| `outcomeQuery`      | `string?`             | Search within outcome measures. Maps to `query.outc`. |
| `statusFilter`      | `string \| string[]?` | Filter by study status.            |
| `phaseFilter`       | `string \| string[]?` | Filter by phase.                   |
| `advancedFilter`    | `string?`             | Advanced AREA[] filter expression. |

**Output schema:**

| Field        | Type     | Description                               |
| :----------- | :------- | :---------------------------------------- |
| `totalCount` | `number` | Total studies matching the query/filters. |

**Format function:** Single line: `"N studies match the specified criteria."`

---

### 7. `clinicaltrials_find_eligible`

Patient-matching workflow tool. Takes a patient profile and translates it to the right API queries — the LLM doesn't need to know AREA[] syntax for demographic filtering.

**Description:**

```
Match patient demographics and conditions to eligible recruiting clinical trials. Takes a
patient profile (age, sex, conditions, location) and returns studies the patient may qualify
for, with match explanations. Internally builds optimized queries with demographic filters.
```

**Input schema:**

| Parameter        | Type       | Description                                                                   |
| :--------------- | :--------- | :---------------------------------------------------------------------------- |
| `age`            | `number`   | Patient age in years (0–120).                                                 |
| `sex`            | `enum`     | Biological sex: `FEMALE`, `MALE`, `ALL`.                                      |
| `conditions`     | `string[]` | Medical conditions or diagnoses. E.g., `["Type 2 Diabetes", "Hypertension"]`. |
| `location`       | `object`   | Patient location: `{ country: string, state?: string, city?: string }`.       |
| `healthyVolunteer` | `boolean?` | Query only studies accepting healthy volunteers. Default: `false`. |
| `recruitingOnly` | `boolean?` | Only include actively recruiting studies. Default: `true`.                    |
| `maxResults`     | `number?`  | Maximum results to return, 1–50. Default: `10`.                               |
| `locationLimit`  | `number?`  | Cap on the matched sites returned per candidate, 1–500. Default: `10`. A candidate whose matched sites are all closed carries one more — its nearest recruiting site. |

**Output schema:**

| Field        | Type      | Description                                                                                                                                                                                                                                                                              |
| :----------- | :-------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studies`    | `Study[]` | Matching studies, re-ranked and capped at `maxResults`. Each carries the requested eligibility fields: `nctId`, `briefTitle`, `briefSummary`, `overallStatus`, phase/enrollment/sponsor, `conditions`, interventions, `eligibilityModule` (age range, sex, healthy volunteers), a bounded `locations[]` — the sites matching the requested location at the narrowest level that matched (city, else state, else country), sorted by match score and capped at `locationLimit`, plus the candidate's nearest recruiting site when none of the matched ones is recruiting — and central contacts. A candidate whose sites were bounded also carries a top-level `locationSummary` (`totalLocations`, `matchedLocations`, `locationsTruncated`, `nearestRecruitingSiteAdded?`, `retrieveFullStudyWith`); it is absent when nothing was dropped, and `nearestRecruitingSiteAdded` is present only when that extra site was added. |
| `totalCount` | `number?` | Total eligible studies matching the full filter set upstream, before the `maxResults` cap.                                                                                                                                                                                               |

**Enrichment (agent-facing context, rendered as a `content[]` trailer):**

- `searchCriteria` — echo of the normalized query (`conditions`, `age`, `sex`) plus the exact upstream strings needed to reproduce the full match set via `clinicaltrials_search_studies`: `location` (the composed `queryLocn`, replayed as `locationQuery`), `conditionQuery`, `statusFilter`, and `advancedFilter`. `find_eligible` returns only `maxResults`; a caller replays these to page the remaining matches (ranking is not reproduced — the condition/location re-rank runs only over the fetched page).
- `funnel` — match counts at each filter stage (`conditionMatched` → `locationMatched` → `demographicsMatched`), showing where the funnel collapsed.
- `notice` — recovery guidance when no studies matched.

**Handler logic (simplified from old server):**

1. Build condition query from `conditions` (quote multi-word terms, join with `OR`)
2. Build location query from `location` — each present city/state/country part quoted when it carries whitespace (an embedded `"` stripped, since upstream has no working escape for one), joined with an explicit ` AND `. A comma join sent multiword components upstream as loose tokens, so a study listing exactly the requested site could score zero and the tool reported no trials in a location that has them. The same string feeds the main search, the location-stage funnel count, and the `searchCriteria.location` echo
3. Build status filter: `['RECRUITING']` when `recruitingOnly`, otherwise unfiltered
4. Build advanced filter: age range `AREA[MinimumAge]RANGE[MIN, {age} years] AND AREA[MaximumAge]RANGE[{age} years, MAX]`, plus `(AREA[Sex]ALL OR AREA[Sex]{sex})` when sex ≠ `ALL`, plus `AREA[HealthyVolunteers]true` when `healthyVolunteer`
5. Run the main search (`pageSize={maxResults}`, `fields=ELIGIBLE_FIELDS`, `countTotal`) alongside two funnel-stage counts (condition-only, condition+location) in parallel
6. Re-rank studies so those whose own condition list names a requested condition surface above tangential MeSH-umbrella matches (#72/#79), then sort each study's locations by match to the patient location (city > state > country) and bound each list to the best-matching tier, capped at `locationLimit`. The tier is geographic, so a tier holding only closed sites would answer with a candidate nobody can enroll in — when that happens the candidate's nearest recruiting site is admitted alongside it (#114). The bound is applied here, once, so `structuredContent` and `format()` render the same sites (#46, #91)
7. Enrich with `searchCriteria` (including the reproducible `conditionQuery`/`statusFilter`/`advancedFilter` strings) and `funnel` diagnostics
8. Return the re-ranked studies (capped at `maxResults`) with `totalCount`

**Dropped from old server:** Complex multi-signal condition relevance scoring, healthy volunteer matching, detailed criteria snippet extraction. A lightweight condition re-rank was reinstated in #72 — results are stable-sorted so studies whose own condition names a requested condition rank above tangential MeSH-umbrella matches (recall preserved, nothing dropped). The LLM can still evaluate nuanced eligibility from the returned study data.

---

## Resource Designs

### `clinicaltrials://{nctId}`

Single study by NCT ID. Wraps `GET /studies/{nctId}`. Returns a bounded study record as JSON.

**URI examples:**

- `clinicaltrials://NCT03722472`
- `clinicaltrials://NCT04852770`

**Handler:** Fetch study, cap its three unbounded protocol lists (locations, secondary/other outcomes, references — 50 each), drop `resultsSection` in favor of `resultsSummary` counts, and report every omission via `truncated`, `filtersApplied`, and a `retrieval` block naming `clinicaltrials_get_study_record` / `clinicaltrials_get_study_results`. A resource read carries no arguments, so the caps are fixed server-side. Throws `notFound` for 404, `serviceUnavailable` for API errors.

**list():** Not provided — studies are not discoverable by browsing; use `search_studies` to find NCT IDs.

---

## Prompt Designs

### `analyze_trial_landscape`

Replaces the heavy `analyze_trends` tool with a guided multi-step workflow. The LLM uses `get_study_count` and `search_studies` to build the analysis.

**Args:**

| Arg          | Type        | Description                                                                                                          |
| :----------- | :---------- | :------------------------------------------------------------------------------------------------------------------- |
| `topic`      | `string`    | Disease, condition, or research area to analyze.                                                                     |
| `focusAreas` | `string[]?` | Specific aspects to analyze: `status`, `phases`, `sponsors`, `geography`, `timeline`, `interventions`. Default: all. |

**Generated messages:**

```
You are analyzing the clinical trial landscape for: {topic}

Use the ClinicalTrials.gov MCP tools to build a comprehensive analysis. Follow this workflow:

1. **Get a baseline count** — call clinicaltrials_get_study_count with conditionQuery="{topic}" to
   get the total number of trials.

2. **Break down by status** — call get_study_count for each status (RECRUITING, COMPLETED,
   ACTIVE_NOT_RECRUITING, TERMINATED, etc.) with the same conditionQuery plus statusFilter.
   Present as a table.

3. **Break down by phase** — call get_study_count for each phase (EARLY_PHASE1 through PHASE4, NA)
   with phaseFilter. Present as a table.

4. **Identify top sponsors** — call search_studies with conditionQuery, fields=[LeadSponsorName],
   pageSize=100, and examine sponsor distribution.

5. **Recent activity** — call search_studies sorted by LastUpdatePostDate:desc to see recent
   trial activity.

6. **Sample key studies** — call search_studies with fields=[NCTId,BriefTitle,Phase,OverallStatus,
   LeadSponsorName,EnrollmentCount,Condition,InterventionName] to get representative trials.

Present findings as structured tables and a narrative summary. Note any trends, gaps, or
notable patterns. Cite specific NCT IDs for key findings.

Focus areas: {focusAreas ?? "all aspects"}
```

---

## Services

| Service                 | Wraps                          | Used By              |
| :---------------------- | :----------------------------- | :------------------- |
| `ClinicalTrialsService` | ClinicalTrials.gov REST API v2 | All tools + resource |

### `ClinicalTrialsService`

Single service wrapping all API interactions. Init/accessor pattern.

**Methods:**

| Method                   | API Call                  | Description                                             |
| :----------------------- | :------------------------ | :------------------------------------------------------ |
| `searchStudies(params)`  | `GET /studies`            | Search with query, filters, pagination, field selection |
| `getStudy(nctId)`        | `GET /studies/{nctId}`    | Fetch single study by NCT ID                            |
| `getFieldValues(fields)` | `GET /stats/field/values` | Get value frequency stats for fields                    |
| `getEnums()`             | `GET /studies/enums`      | Get all enum type definitions                           |
| `getMetadata(indexed)`   | `GET /studies/metadata`   | Get field tree (optional indexed-only filter)           |

**No separate `getStudyCount` method** — it uses `searchStudies` with `pageSize=0, countTotal=true`.

**Resilience:**

| Concern             | Decision                                                                               |
| :------------------ | :------------------------------------------------------------------------------------- |
| Retry boundary      | Service method wraps full pipeline (fetch + JSON parse).                               |
| Backoff calibration | Base: 1s (rate-limited API). Max 3 retries. Jitter.                                    |
| Retryable errors    | HTTP 429, 500, 502, 503, 504. Network errors (ECONNRESET, ETIMEDOUT).                  |
| Non-retryable       | HTTP 400 (bad request), 404 (not found).                                               |
| Rate limiting       | Minimum 1s between requests. Queue or delay concurrent calls.                          |
| Request timeout     | 30s per request.                                                                       |
| Parse failure       | Detect HTML error pages (API sometimes returns HTML on errors). Classify as transient. |

**Internal details:**

- Base URL from config, default `https://clinicaltrials.gov/api/v2`
- All requests use `format=json`
- Uses `fetchWithTimeout` from framework utils or native `fetch` with `AbortSignal.timeout`
- Normalizes array filter params to pipe-delimited strings for the API

---

## Config

| Env Var                      | Required | Default                             | Description                                                                  |
| :--------------------------- | :------- | :---------------------------------- | :--------------------------------------------------------------------------- |
| `CT_API_BASE_URL`            | No       | `https://clinicaltrials.gov/api/v2` | API base URL override                                                        |
| `CT_REQUEST_TIMEOUT_MS`      | No       | `30000`                             | Per-request timeout in ms                                                    |
| `CT_MAX_PAGE_SIZE`           | No       | `200`                               | Maximum page size cap (API allows 1000 but 200 is practical for LLM context) |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` (Zod schema, lazy parse)
2. **Service** — `src/services/clinical-trials/` (API client, types, retry)
3. **Resource** — `clinicaltrials://{nctId}` (single study lookup)
4. **Tool: search_studies** — core search (exercises service layer fully)
5. **Tool: get_study_count** — count-only variant (thin wrapper over search)
6. **Tool: get_field_values** — field discovery
7. **Tool: get_study_results** — results extraction
8. **Tool: find_eligible** — patient matching workflow
9. **Prompt: analyze_trial_landscape** — analysis guide

Each step is independently testable via `bun run rebuild && bun run start:stdio`.

---

## Domain Mapping

| Noun         | Operations           | API Endpoint                                    | MCP Primitive                        |
| :----------- | :------------------- | :---------------------------------------------- | :----------------------------------- |
| Study        | search/list          | `GET /studies`                                  | Tool: `search_studies`               |
| Study        | get by ID            | `GET /studies/{nctId}`                          | Resource: `clinicaltrials://{nctId}` |
| Study        | get results          | `GET /studies/{nctId}` (extract resultsSection) | Tool: `get_study_results`            |
| Study        | count                | `GET /studies?countTotal=true&pageSize=0`       | Tool: `get_study_count`              |
| Field Values | list values          | `GET /stats/field/values`                       | Tool: `get_field_values`             |
| Metadata     | field definitions    | `GET /studies/metadata`                         | Tool: `get_field_definitions`        |
| Patient      | find eligible trials | `GET /studies` (composite query)                | Tool: `find_eligible`                |
| Analysis     | landscape analysis   | Multi-call orchestration                        | Prompt: `analyze_trial_landscape`    |

### Excluded

| Operation                   | Reason                                                                                                                                                         |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /studies/search-areas` | Internal reference — search area weights. Low value for LLM workflows.                                                                                         |
| `GET /stats/size`           | JSON payload size distribution — operational/devops concern, not useful for LLM workflows.                                                                     |
| `GET /stats/field/sizes`    | Array cardinality stats — not useful for LLM workflows.                                                                                                        |
| `GET /version`              | API version. Could be a resource, but low value.                                                                                                               |
| `GET /studies/enums`        | Enum type definitions with legacy display names. Removed — `get_field_values` covers value discovery with frequency data, which is more useful for LLM workflows. |
| Compare studies             | Dropped — LLM can fetch via resource and compare natively.                                                                                                     |
| Analyze trends (heavy)      | Replaced by `get_study_count` + `analyze_trial_landscape` prompt.                                                                                              |

---

## Workflow Analysis

### "Find trials for my condition"

1. `search_studies(conditionQuery="lung cancer", statusFilter="RECRUITING", fields=[...], pageSize=20, countTotal=true)`
2. Agent presents results, suggests refinements

### "Am I eligible for any trials?"

1. `find_eligible(age=45, sex="FEMALE", conditions=["breast cancer"], location={country:"United States", state:"Washington"})`
2. Agent presents matches with explanations

### "What do the results show for this trial?"

1. `get_study_results(nctIds="NCT12345678", sections=["outcomes", "adverseEvents"])`
2. Agent interprets outcomes, p-values, adverse events

### "Analyze the landscape for Alzheimer's trials"

1. Agent uses `analyze_trial_landscape` prompt
2. Multiple `get_study_count` calls for breakdown
3. `search_studies` for representative samples
4. Agent synthesizes narrative

### "What are the valid phases I can filter by?"

1. `get_field_values(fields="Phase")`
2. Agent sees values with counts, uses in next search

### "What fields can I use in the fields parameter?"

1. `get_field_definitions(mode="overview")` — top-level overview
2. `get_field_definitions(mode="drill", path="protocolSection.designModule")` — drill into design fields
3. Agent discovers piece names like `DesignAllocation`, `DesignMasking`, uses in search

### "What fields relate to enrollment?"

1. `get_field_definitions(mode="search", query="enrollment")`
2. Agent finds `EnrollmentCount`, `EnrollmentType` with paths and types

### "Get me full details on NCT03722472"

1. Read resource `clinicaltrials://NCT03722472`
2. Agent has full study context

---

## Design Decisions

### Resource vs. tool for single study

Single study by NCT ID is a **resource** — it's addressable by stable URI, read-only, parameterless beyond the ID. This lets clients inject study data as context without a tool call. `clinicaltrials_get_study_record` (§ Tool Designs 5) mirrors it as a tool for clients that don't read resources, and takes the list caps as caller arguments where the resource fixes them server-side. Batch multi-study is handled by `search_studies` with `nctIds` filter.

### Count tool replaces trend analysis

The old `analyze_trends` fetched up to 5,000 studies and aggregated locally. Problems: slow (multiple paginated calls with rate-limit delays), rate-limit risky, large code surface. The replacement: `get_study_count` (single fast API call, returns just a number) + `analyze_trial_landscape` prompt (teaches the LLM to orchestrate). Same capability, composable, fast, minimal code.

### Search tool parameter richness

The search tool exposes 14 parameters — intentionally rich. Search is the primary workflow and the API's query surface is the server's key value. Each parameter maps directly to an API parameter with clear descriptions. The LLM picks what it needs; unused params are optional.

### Simplified find_eligible

Dropped from the old server: complex multi-signal condition relevance scoring, healthy volunteer matching, criteria snippet extraction, multi-tier proximity ranking. Kept: demographic AREA[] filter construction, basic post-filtering, location sorting, and (reinstated in #72) a lightweight single-pass condition re-rank that keeps tangential MeSH-umbrella matches from outranking on-condition trials. The LLM can evaluate nuanced eligibility from the returned study data — the tool's job is query construction, not clinical judgment.

### No wrapper for every endpoint

Metadata, search-areas, enums, stats/size, stats/field/sizes are excluded. They're reference data for developers building queries, not LLM workflow operations. If agents need dynamic field discovery, `metadata` could become a resource later.

---

## Known Limitations

| Limitation                          | Impact                                                                               | Mitigation                                                                                               |
| :---------------------------------- | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| Rate limit ~1 req/sec               | Multi-page fetches are slow                                                          | Use `fields` to reduce payloads, `pageSize=0` for counts, avoid unnecessary pagination                   |
| `countTotal` first page only        | Can't get count on subsequent pages                                                  | Always request count on first call                                                                       |
| No auth / no write API              | Can't bookmark, save, or modify studies                                              | Read-only by design                                                                                      |
| Geographic filter requires lat/lon  | Users think in city names, not coordinates                                           | `find_eligible` uses `query.locn` for text-based location; `geoFilter` is the escape hatch for proximity |
| `pageToken` tied to data version    | Tokens may expire on data refresh (~daily)                                           | Document in pagination guidance; retry from page 1 on invalid token                                      |
| Full study payloads ~70KB           | Context window pressure                                                              | `fields` parameter is strongly recommended in tool descriptions                                          |
| Age filter via AREA[] is text-based | `AREA[MinimumAge]RANGE[MIN, 45 years]` compares normalized time strings, not numbers | `find_eligible` handles this correctly; search tool documents the format                                 |

---

## API Reference

See [docs/api-reference.md](api-reference.md) for the complete ClinicalTrials.gov REST API v2 reference, including all endpoints, parameters, enums, filter syntax, and study data structure.

---

## Implementation Checklist

### Setup

- [ ] `src/config/server-config.ts` — Zod schema for `CT_*` env vars, lazy-parse pattern
- [ ] `src/index.ts` — `createApp()` with tools, resources, prompts arrays

### Service: `ClinicalTrialsService`

- [ ] `src/services/clinical-trials/clinical-trials-service.ts` — init/accessor pattern
- [ ] `src/services/clinical-trials/types.ts` — response types (Study, PagedStudies, FieldValueStats)
- [ ] `searchStudies(params)` method — `GET /studies` with full param mapping
- [ ] `getStudy(nctId)` method — `GET /studies/{nctId}`
- [ ] `getFieldValues(fields)` method — `GET /stats/field/values`
- [x] `getEnums()` method — `GET /studies/enums`
- [x] `getMetadata(indexedOnly)` method — `GET /studies/metadata`
- [ ] Retry logic — retryable status codes (429, 5xx), exponential backoff, 1s base delay
- [ ] Request timeout — 30s via AbortSignal
- [ ] Rate limit awareness — minimum inter-request delay
- [ ] HTML error page detection — classify as transient
- [ ] Filter param normalization — arrays to pipe-delimited strings

### Resource: `clinicaltrials://{nctId}`

- [ ] `src/mcp-server/resources/definitions/study.resource.ts`
- [ ] Params: `nctId` with NCT ID regex validation
- [ ] Handler: fetch via service, apply the fixed list caps, drop `resultsSection` for counts, disclose omissions
- [ ] Error: `notFound` for 404, `serviceUnavailable` for API errors
- [ ] Register in `definitions/index.ts`

### Tool: `clinicaltrials_search_studies`

- [ ] `src/mcp-server/tools/definitions/search-studies.tool.ts`
- [ ] Input schema: all 14 params with `.describe()`, enum constraints for status/phase
- [ ] Output schema: `studies`, `totalCount`, `nextPageToken`
- [ ] Handler: map params → service `searchStudies`, pass `countTotal` default `true`
- [ ] Format: summary line + top 5 bullet list + pagination note
- [ ] Register in `definitions/index.ts`

### Tool: `clinicaltrials_get_study_count`

- [ ] `src/mcp-server/tools/definitions/get-study-count.tool.ts`
- [ ] Input schema: query/filter subset (no pagination, no fields, no sort)
- [ ] Output schema: `totalCount`
- [ ] Handler: call service `searchStudies` with `pageSize=0, countTotal=true`
- [ ] Format: single line count
- [ ] Register in `definitions/index.ts`

### Tool: `clinicaltrials_get_field_values`

- [ ] `src/mcp-server/tools/definitions/get-field-values.tool.ts`
- [ ] Input schema: `fields` (string or string array)
- [ ] Output schema: `fieldStats[]` with `topValues`
- [ ] Handler: call service `getFieldValues`
- [ ] Format: field name → values list with counts
- [ ] Register in `definitions/index.ts`

### Tool: `clinicaltrials_get_field_definitions`

- [x] `src/mcp-server/tools/definitions/get-field-definitions.tool.ts`
- [x] Input schema: `mode`, `query`, `path`, `limit`, `includeIndexedOnly` with `.describe()`
- [x] Output schema: `fields[]` with name, piece, types, path; `totalFields`, `resolvedPath`
- [x] Handler: call service `getMetadata`, then path navigation / keyword search / top-level overview
- [x] Format: tree-style for browsing, flat list for search
- [x] Register in `definitions/index.ts`

### Tool: `clinicaltrials_get_study_results`

- [ ] `src/mcp-server/tools/definitions/get-study-results.tool.ts`
- [ ] Input schema: `nctIds` (1-20), `sections` filter
- [ ] Output schema: `results[]`, `studiesWithoutResults`, `fetchErrors`
- [ ] Handler: concurrent fetch via service, extract resultsSection, reshape
- [ ] Partial success: individual failures in `fetchErrors`, throw only if all fail
- [ ] Format: markdown with outcomes, adverse events, participant flow, baseline
- [ ] Register in `definitions/index.ts`

### Tool: `clinicaltrials_find_eligible`

- [ ] `src/mcp-server/tools/definitions/find-eligible.tool.ts`
- [ ] Input schema: `age`, `sex`, `conditions`, `location`, `recruitingOnly`, `maxResults`
- [ ] Output schema: `eligibleStudies[]`, `totalMatches`, `searchCriteria`
- [ ] Handler: build condition query, status filter, location query, AREA[] for age/sex
- [ ] Post-filter: verify demographics from study data
- [ ] Sort: location proximity (city > state > country)
- [ ] Format: numbered list with match reasons, eligibility highlights, locations
- [ ] Register in `definitions/index.ts`

### Prompt: `analyze_trial_landscape`

- [ ] `src/mcp-server/prompts/definitions/analyze-trial-landscape.prompt.ts`
- [ ] Args: `topic` (required), `focusAreas` (optional)
- [ ] Generate: multi-step analysis workflow message
- [ ] Register in `definitions/index.ts`

### Barrel Exports

- [ ] `src/mcp-server/tools/definitions/index.ts` — all tool definitions
- [ ] `src/mcp-server/resources/definitions/index.ts` — all resource definitions
- [ ] `src/mcp-server/prompts/definitions/index.ts` — all prompt definitions

### Quality Gates

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` not needed (stateless read-only server)
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] All definitions registered in `createApp()` arrays
- [ ] Tests for each tool handler using `createMockContext()`
- [ ] `bun run devcheck` passes
- [ ] Smoke test with `bun run rebuild && bun run start:stdio`
