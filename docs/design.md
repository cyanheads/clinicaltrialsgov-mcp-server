# ClinicalTrials.gov MCP Server — Design

## MCP Surface

### Tools

| Name                               | Description                                                                                                                                                       | Key Inputs                                                                                                                                                                               | Annotations                                       |
| :--------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| `clinicaltrials_search_studies`    | Search for clinical trial studies using queries, filters, pagination, and field selection.                                                                        | `query`, `conditionQuery`, `interventionQuery`, `locationQuery`, `sponsorQuery`, `statusFilter`, `phaseFilter`, `advancedFilter`, `geoFilter`, `sort`, `fields`, `pageSize`, `pageToken` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_results` | Extract outcomes, adverse events, participant flow, baseline characteristics, and results metadata for completed studies with results; names the result publications of a study without posted results.                            | `nctIds`, `sections`, `summary`, `outcomeLimit`, `adverseEventLimit`, `outcomeOffset`, `seriousEventOffset`, `otherEventOffset`                                                           | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_field_values`  | Discover valid values for any ClinicalTrials.gov field with study counts per value. Use before constructing searches to find valid filter options.                | `fields`                                                                                                                                                                                 | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_count`   | Get total study count matching a query without fetching study data. Use for quick stats and building breakdowns by calling multiple times with different filters. | `query`, `conditionQuery`, `interventionQuery`, `statusFilter`, `phaseFilter`, `advancedFilter`                                                                                          | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_field_definitions` | Get field definitions from the study data model — piece names, types, nesting. For discovering available fields and AREA[] filter targets.                   | `mode`, `query`, `path`, `limit`, `includeIndexedOnly`                                                                                                                                                             | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_record`  | Fetch a single study by NCT ID. The tool equivalent of the `clinicaltrials://{nctId}` resource, for clients that don't read resources.                            | `nctId`, `locationLimit`, `outcomeLimit`, `referenceLimit`, `nearLocation`                                                                                                               | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_find_eligible`     | Match patient demographics to candidate recruiting clinical trials, by place name or by distance from the patient (`location.near`). Builds optimized API queries from a patient profile and returns candidates with demographic, contact, and location fields; inclusion/exclusion criteria are not checked. | `age`, `ageUnit`, `sex`, `conditions`, `location`, `healthyVolunteer`, `recruitingOnly`, `maxResults`, `locationLimit`                                                                                             | `readOnlyHint`, `idempotentHint`, `openWorldHint` |

### Resources

| URI Template               | Description                                                       | Pagination |
| :------------------------- | :---------------------------------------------------------------- | :--------- |
| `clinicaltrials://{nctId}` | Fetch a single clinical study by NCT ID. Returns a bounded study record. | No         |

### Prompts

| Name                      | Description                                                                                                                                                                                | Args                  |
| :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------- |
| `analyze_trial_landscape` | Guides systematic analysis of a clinical trial landscape using study counts and search. Teaches the multi-call workflow for building breakdowns by phase, status, year, sponsor type, etc. | `topic`, `focusAreas` |

### Skills

| Name                      | Path / URI                                                                                     | Carries                                                                                                                                                                                                                  |
| :------------------------ | :--------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clinicaltrialsgov-guide` | `skills/clinicaltrialsgov-guide/SKILL.md`, served as `skill://clinicaltrialsgov-guide/SKILL.md` | Identifier sources; gates for study versus site recruiting status, overlapping phase counts, `RANGE` against missing fields and month-only dates, the status vocabulary, and posted results (per-section group IDs, the adverse-event threshold, results published elsewhere); the `advancedFilter` syntax (`SEARCH[Location]`, `DISTANCE[]`, `MISSING`, age units) |

One skill, because every gate it carries fires on the same triggers (finding, counting, or interpreting trials) and none fits a tool description: each spans several tools or concerns upstream data semantics rather than one parameter. The `instructions` string names its URI and stays a single orientation paragraph.

---

## Overview

MCP server wrapping the [ClinicalTrials.gov REST API v2](https://clinicaltrials.gov/data-api/api) — the US National Library of Medicine's registry of 600K+ clinical trial studies. Public, read-only, no auth required.

**Target users:** LLM agents helping people research clinical trials — patients seeking candidate trials, researchers analyzing trial landscapes, clinicians comparing treatment options.

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
| `query`             | `string?`             | General full-text search across all fields (conditions, interventions, sponsors, etc.). Maps to `query.term`. Also accepted as `query.term` or `query_term`.                                                                                                                                             |
| `conditionQuery`    | `string?`             | Condition/disease-specific search. More precise than general query — searches only the condition/synonym index. E.g., `"Type 2 Diabetes"`, `"non-small cell lung cancer"`. Maps to `query.cond`. Also accepted as `query.cond`, `query_cond`, or `condition`.                                          |
| `interventionQuery` | `string?`             | Intervention/treatment-specific search. E.g., `"pembrolizumab"`, `"cognitive behavioral therapy"`. Maps to `query.intr`. Also accepted as `query.intr`, `query_intr`, or `intervention`.                                                                                                                |
| `locationQuery`     | `string?`             | Location search — city, state, country, or facility name. E.g., `"Seattle"`, `"United States"`. Maps to `query.locn`. Also accepted as `query.locn` or `query_locn`.                                                                                                                                     |
| `sponsorQuery`      | `string?`             | Sponsor/collaborator name search. Searches both lead sponsor and collaborators. For lead sponsor only, use `advancedFilter` with `AREA[LeadSponsorName]`. Maps to `query.spons`. Also accepted as `query.spons`, `query_spons`, or `sponsor`.                                                           |
| `titleQuery`        | `string?`             | Search within study titles and acronyms only. Maps to `query.titles`. Also accepted as `query.titles` or `query_titles`.                                                                                                                                                                                 |
| `outcomeQuery`      | `string?`             | Search within outcome measure fields. Maps to `query.outc`. Also accepted as `query.outc` or `query_outc`.                                                                                                                                                                                               |
| `statusFilter`      | `string \| string[]?` | Filter by overall study status. Values: `RECRUITING`, `COMPLETED`, `ACTIVE_NOT_RECRUITING`, `NOT_YET_RECRUITING`, `ENROLLING_BY_INVITATION`, `SUSPENDED`, `TERMINATED`, `WITHDRAWN`, `UNKNOWN`, `WITHHELD`, `NO_LONGER_AVAILABLE`, `AVAILABLE`, `APPROVED_FOR_MARKETING`, `TEMPORARILY_NOT_AVAILABLE`. Each entry is trimmed, uppercased, stripped of whitespace around a `,`/`\|` delimiter, and its remaining whitespace/hyphen/underscore runs collapsed to `_` before the request (`"active not recruiting"` → `ACTIVE_NOT_RECRUITING`, `"recruiting, completed"` → `RECRUITING,COMPLETED`) — upstream matches the value case-sensitively and splits it on `,` and `\|`. The registry display labels `"Active, not recruiting"` and `"Unknown status"` map to `ACTIVE_NOT_RECRUITING` and `UNKNOWN`. A value that still names no status fails upstream as `enum_invalid`. Also accepted as `filter.overallStatus` or `filter_overallStatus`. |
| `phaseFilter`       | `string \| string[]?` | Filter by trial phase. Values: `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`, `NA`. Each entry is split on `,`/`\|`, then matched with case, whitespace, `-`, `_`, and quotes ignored (`"Phase 3"` → `PHASE3`, `"Not Applicable"` → `NA`, `"PHASE2,PHASE3"` → `[PHASE2, PHASE3]`). An entry that names no phase — including a search expression such as `PHASE3 OR AREA[StudyType]OBSERVATIONAL` — fails as `enum_invalid` in the handler before any request, naming the caller's whole entry (`RANGE[PHASE1,PHASE3]`, not the fragment `RANGE[PHASE1`); expressions belong in `advancedFilter`. An entry of only quotes, whitespace, and zero-width characters fails as `blank_value`. Also accepted as `phase`. |
| `advancedFilter`    | `string?`             | Advanced filter using AREA[] Essie syntax. Examples: `AREA[StudyType]INTERVENTIONAL`, `AREA[MinimumAge]RANGE[MIN, 18 years]`, `AREA[EnrollmentCount]RANGE[100, 1000]`, `AREA[HasResults]true` (studies with posted results). Combine with `AND`/`OR`/`NOT` and parentheses. Also accepted as `filter.advanced` or `filter_advanced`.                                                   |
| `geoFilter`         | `string?`             | Geographic proximity filter. Format: `distance(lat,lon,radius)` where radius carries a required `mi` or `km` suffix. Example: `distance(47.6062,-122.3321,50mi)` for studies within 50 miles of Seattle. Validated in the handler before the upstream call — a unit-less radius, a non-positive radius, a number in exponent notation (`1e3`, `1e-7`, at any size), a latitude outside [-90, 90] or a longitude outside [-180, 180] all fail as `geo_invalid` (upstream reads a bare radius as meters, so it matches only sites geocoded to the center point and answers a near-empty 200, and the other shapes answer a 500 or a bare 400, so none of these would otherwise surface as an input error). A radius past 12,451 mi (20,039 km) is sent as `12451mi` (`20039km`), which reaches the same sites; `searchCriteria.geoFilter` shows the value sent and `notice` says so on every page. Also accepted as `filter.geo` or `filter_geo`. |
| `nctIds`            | `string \| string[]?` | Filter to specific NCT IDs. Use for batch lookups of known studies. Each ID is trimmed and uppercased before the format check (`nct03722472` → `NCT03722472`), and repeats collapse in first-occurrence order. One request carries the leading IDs that fit beside the other parameters — 563 when nothing else is set — and the rest return unqueried in `deferredNctIds` (see **ID lists past one request**). More than 1000 entries, repeats included, are rejected at the input root. |
| `fields`            | `string[]?`           | Specific fields to return (PascalCase piece names; a full metadata path such as `protocolSection.statusModule.overallStatus` is sent as its piece). **Strongly recommended** — without this, results are a compact per-study index; pass `fields` to receive those leaves at full fidelity (a full record is ~70KB). A comma- or pipe-joined entry (`["NCTId,BriefTitle"]`) or a lone string (`"NCTId,BriefTitle"`) is split into separate names before validation. Common fields: `NCTId`, `BriefTitle`, `OverallStatus`, `Phase`, `LeadSponsorName`, `Condition`, `InterventionName`, `BriefSummary`, `EnrollmentCount`, `StartDate`. Takes record pieces only: an index-only piece (`NumLocations`) is answered with an empty module, so it is refused locally. Naming `ResultsSection`, or a module or group under it, caps the page at 10 studies, and naming `ProtocolSection` caps it at 75; a module or leaf under the protocol section (`StatusModule`, `BriefTitle`) keeps the server's cap, and a list takes the lowest cap any of its names earns (see **Per-page cap**). |
| `sort`              | `string?`             | Sort order. Format: `FieldName:asc` or `FieldName:desc` on a date or numeric field, or `@relevance` (a bare `relevance` is sent as `@relevance`). E.g., `LastUpdatePostDate:desc`, `EnrollmentCount:desc`. Default: relevance when query params present. Max 2 sort fields comma-separated.                                                                                                      |
| `pageSize`          | `number?`             | Results per page, at least 1. Default: 10. No schema maximum: a larger value is served at the per-call cap `CT_MAX_PAGE_SIZE` (200 unless overridden, never above ClinicalTrials.gov's page maximum of 1000), or at 10 when `fields` names `ResultsSection` or a module or group under it, or cannot be checked for one, or otherwise at 75 when it names `ProtocolSection` (the operator's cap when that is lower); when a next page remains, `truncated` / `shown` / `cap` and a `notice` naming both numbers and `nextPageToken` disclose the cut on both surfaces. Also accepted as `limit` or `max_results`. |
| `pageToken`         | `string?`             | Pagination cursor: a previous response's `nextPageToken`, passed back unchanged with the same criteria. A token ClinicalTrials.gov rejects — malformed, issued before a data refresh, or altered after it was issued — fails as `page_token_invalid` (not retryable); restart from the first page without `pageToken`. |
| `countTotal`        | `boolean?`            | Include total study count in response. Only computed on the first page. Default: true.                                                                                                                                                                                                                  |

**Parameter aliases (#190):** each query and filter parameter also accepts the REST parameter ClinicalTrials.gov takes it as, dotted and with `_` for `.` (`query.cond`, `query_cond`), and the generic names `condition`, `intervention`, `sponsor`, `phase`, `limit`, and `max_results`. They are `inputAliases`, rewritten to the canonical key before validation and never advertised: `inputSchema` is the same with or without them, an alias sent beside its target is rejected, and a case variant of an alias (`Query.Term`) is not folded. `conditions` and `filter.ids` are left out: `clinicaltrials_find_eligible` declares `conditions` as a list, which `conditionQuery` refuses, and the REST `filter.ids` value is a `|`-joined list, which fails the `nctIds` pattern.

**Output schema:**

| Field           | Type      | Description                                                               |
| :-------------- | :-------- | :------------------------------------------------------------------------ |
| `studies`       | `Study[]` | Matching studies. By default each entry is a **compact index projection** — `nctId`, `briefTitle`, `overallStatus`, `phases`, `enrollmentCount`, `leadSponsor`, `conditions`, `hasResults`, `startDate` and `primaryCompletionDate` (the `statusModule` date strings as upstream sends them, `YYYY-MM` or `YYYY-MM-DD`), and a bounded `{ total, nearest }` locations summary (`nearest` carries the site's own `status`, which can differ from the study's `overallStatus`; #173), each key omitted when the study does not publish it — mirroring the rendered summary, **not** the full ~70KB record. With explicit `fields`, each entry carries exactly the requested leaves at full fidelity (e.g. every location). |
| `totalCount`    | `number?` | Total matching studies (present when `countTotal=true`, first page only). |
| `nextPageToken` | `string?` | Token for the next page. Absent on last page.                             |
| `requestedFields` | `string[]?` | Echo of the explicit `fields` input, joined entries split into separate names and repeated names listed once — present only when `fields` was passed. Signals the full-fidelity (non-index) study shape. |
| `pageExhausted` | `boolean?` | `true` when the call supplied a `pageToken` and the continuation page came back empty: the walk is finished, not unmatched. Absent otherwise, including on an empty first page. Whether the request itself carried a cursor is the only signal available — an exhausted page carries neither `totalCount` nor `nextPageToken` — so no look-ahead request or cross-call state is involved. `format()` renders a matching line and the empty-result `notice` withholds its broaden-the-search guidance, so both channels read the page the same way. |
| `deferredNctIds` | `string[]?` | IDs from `nctIds` the request had no room for, deduplicated, in first-occurrence order — not queried, so `studies` and `totalCount` cover only the IDs that went out. Every page of a walk defers the same IDs. `format()` leads with a `Deferred:` line naming every one. Absent when every ID was queried. |

**Error messages:**

- Invalid filter syntax: `query_parse_error`, e.g. `"Query syntax error near '['. [ ] are valid only as part of an AREA[FieldName]value or RANGE[min, max] expression, which the free-text params accept as well as advancedFilter; a stray bracket fails. Free-text fields otherwise take plain words plus AND, OR, NOT."`, worded per upstream parse-error shape (`describeQueryParseError`). A field the expression names that upstream refuses is `field_invalid` instead, with a hint per kind: an unknown name or a group (did-you-mean beside it), a study-level field or a search area inside `SEARCH[Location](…)`, `RANGE[]` on a field that is not a date, number, or age, a `DISTANCE[]` term inside `SEARCH[Location](…)` (the term goes beside the wrapper, a radius as `AREA[LocationGeoPoint]DISTANCE[lat,lon,radius] AND SEARCH[Location](…)`, #206; a `RANGE[]` term there fails the same way, including when upstream names no cause and only repeats the expression as sent, #208), `DISTANCE[]` on a field other than `LocationGeoPoint`, a bare `RANGE[]` or `DISTANCE[]`. A `DISTANCE[]` operand upstream cannot read (a latitude or longitude that is not a number or is out of range, a radius under 1, past 500 mi or 805 km, or with no `mi` or `km` unit, no radius) stays `query_parse_error`, with a hint that restates `DISTANCE[lat,lon,radius]` in place of the free-text tail; for a radius past the ceiling the hint sends the caller to `geoFilter` on `clinicaltrials_search_studies` or `location.near` on `clinicaltrials_find_eligible`, which take a larger one. A body that names no cause and only repeats an expression holding no `SEARCH[Location](…)` is `query_parse_error`, with a hint to send the expression's `AREA[…]`, `RANGE[…]`, and `DISTANCE[…]` terms one at a time to find the one upstream refuses.
- Malformed ID: `ids_not_found` when ClinicalTrials.gov refuses an `nctIds` entry as malformed although it fits `NCT` + 8 digits (`NCT00000000` is refused this way); `data.invalid` names the refused ID when upstream names it. A well-formed ID with no study is not this error: it matches no study.
- Request too long: `request_too_long` (`ValidationError`, `data.requestBytes` / `data.maxRequestBytes`, never the upstream error page) when ClinicalTrials.gov answers 414, and before any request when the other parameters leave no room for even one `nctIds` entry. `get_study_count`, `get_field_values`, and `find_eligible` declare the same reason.
- No results: returns empty studies array with `totalCount: 0`, not an error. An empty first page carries a `notice` naming the constraints that matched nothing: broadening guidance for queries and filters, and — when `nctIds` was supplied — an ID-aware clause. An ID-only lookup gets the ID clause alone, pointing at `clinicaltrials_get_study_record` (a direct not-found check; upstream 404s a nonexistent NCT ID cleanly) and `clinicaltrials_get_study_results` (which resolves a previous/alias ID to its canonical study). Combined with a query or filter, the ID clause is added alongside the existing guidance and asserts nothing about whether the IDs exist — distinguishing "no such study" from "excluded by the other criteria" would cost an extra upstream request. A partial match is not an empty result and carries no notice. An exhausted continuation page (`pageExhausted`) carries no notice of any kind, `nctIds` or not.

**Format function:** Summary line (`Found N studies (M total matching)`), then **every** study in the page as a compact index row (NCT ID, title, status; a phase/enrollment/sponsor/conditions meta line that ends with `results posted` or `no results`, `start <date>`, and `primary completion <date>` when the study carries them; and a lead-or-nearest site line with the site's status in brackets after the place — `(unnamed site)` when the site files no place, so its status or distance still renders — and the total site count), pagination note if more pages. With explicit `fields`, each study instead renders every requested leaf, including all locations. Registry text in each single-line slot has CR/LF folded to a space (`oneLine`), so a line break in a title or sponsor cannot start a new `content[]` line and forge structure; prose keeps its breaks, and `structuredContent` keeps every value verbatim (#180). The `searchCriteria` trailer renders each string value as a code span (a fenced block when it holds a line break) and each list entry the same way, through `formatSearchCriteria` in `format-helpers.ts`, so a `content[]`-only caller can replay it as sent (#177).

**Per-page cap (#153, #157):** `pageSize` carries no schema maximum. The cap is a config value, and reading `CT_MAX_PAGE_SIZE` at module import parsed the whole `CT_*` config before `createApp()` ran, so a bad value crashed with a raw stack instead of the startup banner; a static `.max()` above the cap protected nothing, since the clamp already maps every larger value to the cap, and advertised a number the tool never serves. The service exposes the cap as `maxPageSize` (config parsed once in `setup()`, clamped to ClinicalTrials.gov's page maximum of 1000), and only this handler applies it, because it is the only caller-facing page: the service sends every other `pageSize` unchanged, so the results ID batch and the eligibility candidate fetch, sized by their own inputs, never lose studies to it. The default cap of 200 sits below upstream's 1000 because full records run to tens of KB each. Any page size above the cap is served rather than rejected, since it has one reading; the disclosure fires only when a next page remains, since a page the match set ran out on lost nothing to the cap.

A `fields` list that reaches into posted results takes a lower cap of 10 studies (`RESULTS_PAGE_CAP`), or the server's own when that is lower. A typical results-bearing record is about 30 KB and a heavy one runs past 1 MB, and each surface carries the page (`content[]` renders it, `structuredContent` holds it): ten typical records render about 1 MB per surface, where a page of 200 heavy ones built a response too large for Node to serialize. The cap applies to a name that is `ResultsSection` or a `STRUCT` group under it (`OutcomeMeasuresModule`, `OutcomeMeasure`); a leaf under it (`OutcomeMeasureTitle`) returns one field of each record and keeps the server's cap. Names are classified as the caller sent them with the folds field normalization applies (trimmed, case-folded, a metadata path read as its piece). When the field index cannot be read, or local validation is off, the list cannot be checked and takes the results cap rather than risk the large page; the service reads the index once per call, so the search's own validation shares that read. The capped size goes upstream as the page size, so `nextPageToken` continues at it, and the `notice` names which cap applied: the server's, the results cap, the results cap for a list it could not check, or the protocol cap.

A list that names `ProtocolSection` itself takes a cap of 75 (`PROTOCOL_PAGE_CAP`, #199), or the server's own when that is lower. Measured 2026-11-21, a page of 200 protocol sections renders 2,148,237 characters in `content[]` and 2,039,887 bytes in `structuredContent` (2.0–2.6 MB per surface across pages, and a page sorted `NumOutcomeMeasures:desc` built a 31.3 MB message), two to two and a half times the ~1 MB per surface the results cap is sized to; 75 render 0.8–0.9 MB. The cap is per projection, not one lower cap for every section: `DerivedSection`, `AnnotationSection`, `DocumentSection`, and every single protocol module render at most 0.69 MB per surface at 200 (the largest, `OutcomesModule`), so they keep the server's cap. Only the protocol section itself is classified, from the group's metadata path (`protocolSection`), so a module or leaf under it never earns the cap, and a list that earns both takes the lower, the results cap. The disclosure is the existing one: `truncated`, `shown`, `cap`, the notice (`… per-page cap of 75 for fields that name ProtocolSection …`), and `nextPageToken`.

**ID lists past one request (#163):** ClinicalTrials.gov answers any request target (path plus query string) over 8,177 bytes with HTTP 414, whichever parameter carries the bytes (measured 2026-11-02), and offers no POST search. An ID costs 14 bytes (`NCT` + 8 digits + `%7C`), and the limit is shared with every other parameter, so the service fits the list to the bytes left rather than to a fixed count: a fixed cap would still overflow beside long criteria. The fit is measured on the request as built and encoded, from the parameters as the handler passes them with a relevance sort already spelled as upstream accepts it (`relevance` → `@relevance`, the one rewrite that lengthens a request, so it runs before the fit). Field and sort normalization run after the fit and never lengthen the request: trimming, case-folding, a metadata path mapped to its piece (no piece is longer than its path), and the legacy renames each yield an equal or shorter name. It leaves out the paging parameters, holding a fixed 256 bytes for `pageSize`, `countTotal`, and a `pageToken` (longest measured: 100 characters) instead — upstream accepts a token replayed against a different ID set without complaint, so a fit that moved with the token would skip or repeat studies silently. The same criteria therefore fit the same IDs on every page. When the criteria leave no room for even one ID beside the reserve, the first ID still goes out alone as long as the page's whole request fits — refusing it would refuse a request upstream answers — so the fit is one ID on every page, and a page whose token runs the request past the limit fails `request_too_long`. When even the one-ID request is past the limit, the call fails `request_too_long` before any request: an empty `filter.ids` would widen an ID lookup to the whole registry. The 1000-entry ceiling, counted on the input as sent so a stringified list gets the same rejection, guards against absurd input and bounds the `deferredNctIds` echo. `getStudiesBatch` (the results tool's 20-ID batch, about 485 bytes with the reference fields it requests, #204) goes through the same fit and never defers.

**Output-channel parity (#86):** `structuredContent` is bound to exactly what `format()` renders — the compact index by default, the requested-leaf projection with `fields`. Search is an index: it never carries full ~70KB records in `structuredContent` while summarizing them in `content[]`. This keeps `content[]`-only clients (e.g. Claude Desktop) and `structuredContent` clients (e.g. Claude Code) in parity. Fetch one full record with `clinicaltrials_get_study_record`.

---

### 2. `clinicaltrials_get_study_results`

Extracts and reshapes the deeply nested `resultsSection` from completed studies. This is a workflow tool — the raw results data is complex and deeply nested; the tool flattens it into a structured, LLM-readable format.

**Description:**

```
Fetch trial results data for completed studies — outcome measures with statistics, adverse
events, participant flow, and baseline characteristics. Posted results exist only for
studies where hasResults is true; the entry for a study without them names, in
resultPublications, the journal articles its record lists as reporting its results (RESULT
references, with PMID and citation), when it lists any. Use search_studies first to find
studies with results.
```

**Input schema:**

| Parameter  | Type                  | Description                                                                                                                 |
| :--------- | :-------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `nctIds`   | `string \| string[]`  | One or more NCT IDs. E.g., `"NCT12345678"` or `["NCT12345678", "NCT87654321"]`. IDs are trimmed and uppercased first, so repeated IDs — case variants included — collapse to one entry, in first-occurrence order. A call fetches the first 20 distinct IDs and returns the rest, unfetched, in `deferredNctIds`; a list over 500 entries, repeats included, is rejected with the same message whether it arrives as an array, a JSON-stringified array, or under `nctId`. A previous (alias) ID resolves to its canonical study. Required — advertised in the input schema's `required`. Also accepted as `nctId` (the `clinicaltrials_get_study_record` spelling), an input alias that is not advertised; sending both is rejected. |
| `sections` | `string \| string[]?` | Filter which sections to return. Values: `outcomes`, `adverseEvents`, `participantFlow`, `baseline`, `moreInfo`. Omit for all sections. |
| `summary`  | `boolean?`            | Return condensed summaries instead of full data, which can exceed 500KB per study. Typically a few KB — it scales with the measure count and the participant flow's groups × periods, not to a fixed ceiling. Default: `false`.                                     |
| `outcomeLimit` | `number?` | Cap on outcome measures returned per study (≥ 1), in upstream order. Omit for no cap; a limit at or past the list length returns the whole list. Applies in both modes — in summary mode it windows the summarized measures, each keeping its whole projection. |
| `adverseEventLimit` | `number?` | Cap on adverse events returned per study (≥ 1), applied to the serious and other lists separately. Omit for no cap; a limit at or past a list's length returns that whole list. Full mode only; event groups are never capped. |
| `outcomeOffset` | `number?` | Index of the first outcome measure to return (≥ 0). Pairs with `outcomeLimit` to page a long list, in full or summary mode. |
| `seriousEventOffset` | `number?` | Index of the first serious adverse event to return (≥ 0). Pages independently of `otherEventOffset`. |
| `otherEventOffset` | `number?` | Index of the first other adverse event to return (≥ 0). Pages independently of `seriousEventOffset`. |

**Bounded continuation:** the caps bound a large record; the offsets resume one. Both are applied once in the handler, ahead of `structuredContent` and `format()` — a `format()`-side bound would leave one channel carrying rows the other never shows. Offsets apply uniformly to every study in the call, so continuation is reported **per study** in its own `filtersApplied`: each study exhausts its lists at a different index. For every list left short, that study's `filtersApplied` names the applied offset and the next one to request (`nextOutcomeOffset`, `nextSeriousEventOffset`, `nextOtherEventOffset`); a list is exhausted when its next offset is absent. Nothing is disclosed for a list a bound did not actually trim, including a window that lands exactly on the end. `seriousEvents` and `otherEvents` page on their own axes — their lengths are uncorrelated (87/328 on NCT02130466, 248/51 on NCT05226598) — and the group rosters (`eventGroups`, and `groups[]` on outcomes and baseline) ride every page unbounded, since every per-item stat joins back to them by id. An offset at or past the end returns an empty list with the upstream total, not an error. There is no default bound: an unbounded call returns everything, as before. `participantFlow`, `baseline`, and `moreInfo` are never bounded.

Summary mode pages outcomes the same way (#149): `outcomeLimit` / `outcomeOffset` window the measure list before each surviving measure is summarized, with the same `filtersApplied` fields, `truncated` roll-up, and `Bounded:` line. A summarized measure carries no roster to separate from it — its group references are resolved to titles inside the measure — so a page is self-contained, and a summary walk reassembles the unpaged summary item for item. On NCT02130466 one summarized measure runs 429–2,233 B structured (median 636), so a row count bounds a summary page reasonably. The adverse-event bounds stay full-mode only: `topEvents` ranks the whole event list, so windowing it first would change which events rank.

Every page costs a full upstream fetch — the ClinicalTrials.gov v2 API has no results-level pagination, so the slice is local and each page re-pulls the whole `ResultsSection` under the service's ~1 req/sec limit. Continuation buys context budget, not bandwidth.

An offset the call cannot honor is answered rather than ignored: `seriousEventOffset` / `otherEventOffset` supplied with `summary: true`, or any offset targeting a section the `sections` filter excludes, is a typed `offset_not_applicable` rejection. (`adverseEventLimit` keeps its pre-existing silent no-op in summary mode, and both limits keep it for an excluded section.)

**Summary-mode outcome shape:** each measure keeps its identifying metadata (`type`, `title`, `timeFrame`, `paramType`, `dispersionType`, `unitOfMeasure`, `reportingStatus`, `groupCount`, `classCount`, and `analysisCount` when it has analyses), its per-group `denoms` (the whole measure's), one `topAnalysis` lifted from `analyses[0]`, and `topStats` — the per-group cells of a single `classes[0].categories[0]` projection. Each `topStats` entry carries the upstream `value` verbatim (an `NA`/`NR` sentinel included, never re-interpreted), plus `spread`, `lowerLimit`/`upperLimit`, and the record's own `comment` when present — ClinicalTrials.gov publishes no structured field saying why a value is missing, so the comment is the only signal and is passed through rather than read. `topStatsFrom` names the projection: `classTitle` / `categoryTitle` for the cell that survived, `omittedClasses` / `omittedCategories` for the siblings it displaced, and a `note` pointing at `summary: false` when anything was dropped. Upstream titles a class or category only when more than one exists, so the label that disambiguates a retained value is exactly the one a bare projection would discard.

Subgroup values and analyses stay attributable (#146). `topStatsFrom.classDenoms` carries the shown class's own denominators, shaped like `denoms`, whenever upstream publishes them: a subgroup's values are counted out of its own n (NCT04280705's "Time to Recovery by Sex" reports 332/352 Male participants against measure totals of 521/541), and `content[]` prints them on a line named for the class, apart from the measure-level `Denominator` line. `topAnalysis` keeps `groupDescription` verbatim — upstream publishes no structured link from an analysis to a class, so that prose is the analysis's only identity, and nothing here tries to match one — plus `groups`, the compared groups' titles in `groupIds` order, an untitled group standing in as its id. `groupIds` stays as the join key into full mode, and `content[]` prints each id with its title. `analysisCount` says how many analyses `topAnalysis` stands in for. A per-study roster was rejected: the outcome summary already keys `topStats` and `denoms` on titles, and resolving per measure keeps every field inside its measure, so a windowed summary page carries each measure whole. A line break in `groupDescription` is flattened to a space on `content[]`, where the analysis renders as one line; `structuredContent` keeps it verbatim.

**Summary-mode adverse-event shape:** `timeFrame`, `frequencyThreshold` when the study publishes one, the counts (`groupCount`, `seriousEventCount`, `otherEventCount`), an `eventGroups` roster of `id`, `title`, and each group's whole-study totals (`deathsNumAffected` / `deathsNumAtRisk`, `seriousNumAffected` / `seriousNumAtRisk`, `otherNumAffected` / `otherNumAtRisk`, #203), and `topEvents` — up to 20 events ranked by the most participants affected in any one group, each with `term`, `organSystem`, `kind`, and `byGroup` rows `{ groupId, numAffected, numAtRisk }`. Nothing is summed across groups: groups can overlap (a crossover or second-course group re-counts participants of its parent arm), so a pooled figure is not an incidence (#137). Rows key on the id, as full mode does (#128), and each title prints once in the roster: repeated on every row, titles outweighed the counts (KEYNOTE-189's reached 99 characters and differed only in a trailing "(Second Course)"). `frequencyThreshold` rides along verbatim because other (non-serious) events are listed only at or above it, so it is what tells an unlisted event from one reported below it (#174). Upstream usually sends a number (`"5"`, `"0"`) and occasionally text (`"any"`); `content[]` prints `Frequency threshold: 5%` for a numeric value and the text as written, with no `%`, otherwise.

The group totals are passed through as upstream sends them: an unpublished total is absent, never 0 (29,923 of the 80,932 studies with event groups publish no death counts, as of 2026-11-21), and a published 0 stays. `content[]` follows each roster line with `  deaths A/R | serious A/R | other A/R`, the shape full mode prints; a pair whose affected count is absent is left out, and a missing at-risk count prints `?`. They sit on the roster rather than being summed or repeated per event, in keeping with the no-pooling rule above. Summary mode is how a batch of up to 20 studies is screened, and these totals are the per-arm numbers a safety screen reads first (#203).

**Summary-mode participant-flow shape (#203):** `groupCount` and `periodCount`, plus `groups` (`{ id, title? }` per flow group) and `periods` — each `{ title?, milestones?: [{ type?, achievements?: [{ groupId?, numSubjects? }] }] }`, every milestone kept in upstream order with `numSubjects` verbatim (a string). Milestone and achievement comments, `numUnits`, `dropWithdraws`, recruitment and pre-assignment details, and group descriptions stay full-mode only. `content[]` prints the `N groups | N periods` line, a `Groups:` roster, then per period a `**Title**` line and `- **TYPE**: FG000: n, FG001: m` lines, as full mode does. Every milestone is kept: `STARTED`, `COMPLETED`, and `NOT COMPLETED` appear in every study with a flow, other types are free text and cheap to carry, and the period title separates a multi-period flow's `STARTED` lines. The cost is that the summary now scales with groups × periods: NCT05580003 (28 groups, 27 periods) adds about 28 KB to `content[]` and 96 KB to `structuredContent`. Full mode is unchanged.

**Output schema:**

| Field                   | Type                | Description                                                                                            |
| :---------------------- | :------------------ | :----------------------------------------------------------------------------------------------------- |
| `results`               | `StudyResults[]`    | Extracted results per study. Each contains `nctId`, `title`, `hasResults`, the requested sections, and — when a bound trimmed one of its lists — `filtersApplied`. |
| `canonicalNctId`        | `string?`           | On a `results[]` entry: the canonical NCT ID of the study that answered, present only when the requested `nctId` is a previous (alias) ID pointing at a different record. |
| `filtersApplied`        | `object?`           | On a `results[]` entry: what the bounds trimmed on that study — `totalOutcomes` / `totalSeriousEvents` / `totalOtherEvents`, the applied `outcomeLimit` / `adverseEventLimit` / `outcomeOffset` / `seriousEventOffset` / `otherEventOffset`, and `nextOutcomeOffset` / `nextSeriousEventOffset` / `nextOtherEventOffset` for each list left short. Absent when nothing was trimmed. |
| `resultPublications`    | `{pmid?, citation?, retractions?}[]?` | On a `results[]` entry with `hasResults: false`: the journal articles the study record lists as reporting its results (its `RESULT` references), in registry order and uncapped, each with whichever of `pmid`, `citation`, and `retractions: {pmid?, source?}[]` the record holds. Present only when the record lists at least one; the same in summary and full mode, and through the per-ID fallback (#204). Absent on a study with posted results. |
| `studiesWithoutResults` | `string[]?`         | NCT IDs of the studies with no results posted to ClinicalTrials.gov. Each still has its entry in `results`, carrying `resultPublications` when its record lists any. |
| `fetchErrors`           | `{nctId, error}[]?` | Requested NCT IDs with no study on ClinicalTrials.gov, in requested order: absent from the batch answer, refused by the batch as malformed (the batch is then re-sent without them, as `Study <ID> not found. Verify the NCT ID exists on ClinicalTrials.gov.`), or refused as not found when fetched one by one. Any other failure ends the call with its own error and never lands here (#201). |
| `deferredNctIds`        | `string[]?`         | Requested IDs past the per-call cap of 20 distinct IDs, normalized and deduplicated, in first-occurrence order. Not fetched; `content[]` names them on a leading `Deferred:` line. Absent when every requested ID was processed. |
| `truncated`             | `boolean?`          | True when a bound trimmed a list on at least one study. Absent when nothing was trimmed, matching `filtersApplied` one level down. |

**Partial success semantics:** Studies are fetched in one batch request. A malformed ID rejects the whole batch (`ids_not_found`), while an ordinary nonexistent but well-formed ID is answered 200 with the record simply absent. The refusal's body numbers the first refused item (`` Item N in parameter `filter.ids` ``), the service names that ID in `data.invalid`, and the tool records it in `fetchErrors` and re-sends the batch without it (#207). Re-sending costs one request per refused ID where walking every ID costs one per requested ID. Each re-send drops one ID, so a call sends at most one batch per requested ID, and none once every ID is refused: an empty `filter.ids` would widen the lookup to the whole registry. A refusal that names no item, or one past the end of the list, falls back to sequential per-ID fetches over the IDs still unanswered. An ID with no study is reported in `fetchErrors` without failing the request — including when no requested ID names a study. Any other batch failure (an outage, a 504 on every attempt, the call's 50 s budget running out, a rate limit, a cancellation) would fail every per-ID request the same way, so it ends the call instead of entering the fallback or a re-send: a rate limit as this tool's retryable `rate_limited`, the rest as thrown. Inside the fallback, a rate limit, the spent budget (`retry_deadline_exceeded`), or a cancellation ends the call the same way, with no request sent for the IDs after it (#181), and so does every other per-ID failure but `study_not_found` — a 404, or the 400 the single-study route answers `NCT00000000` with — whether `upstream_unavailable`, `upstream_timeout`, `upstream_rejected`, or one carrying no reason (#201). An outage would meet each remaining ID the same way and rerun its four-attempt ladder on each, until the 50 s budget ended the call as `retry_deadline_exceeded` and discarded what was fetched; and a 5xx confined to one record already fails any batch that carries it. `fetchErrors` therefore lists only IDs with no study, never an outage told apart by message text, and its `{ nctId, error }` entries carry no `reason`, which every entry would share. The three upstream reasons' `when` text names a batch request (the first, or one re-sent without a refused ID) or a per-ID fetch.

**Previous (alias) NCT IDs:** ClinicalTrials.gov reassigns some records, leaving the old ID as an alias. Both fetch paths resolve it silently — the batch endpoint rewrites the ID, the single-study endpoint 301-redirects — and answer under the canonical ID. `NCTIdAlias` is requested alongside `NCTId` so the returned record can be matched back to the ID the caller asked for; `results[].nctId` echoes that requested ID and `canonicalNctId` names the study that answered. Requesting an alias and its own canonical ID together returns one entry per requested ID, both carrying the same study, even though the batch endpoint deduplicates them to a single record.

**The 500-entry ceiling:** enforced by a check on the input root, with the array arm advertising it only as JSON Schema `maxItems`. The framework undoes a JSON-stringified list only when the repaired call then validates, and an issue raised at `nctIds` itself refuses that repair, so a `.max(500)` on the array arm told a caller who sent 501 IDs as a string that the string failed the single-ID format. Raised at the root, the issue lets the repair stand, and every input shape gets the plain array's rejection.

**Error messages:**

- No results posted: not an error. The study gets a `results[]` entry with `hasResults: false`, is listed in `studiesWithoutResults`, and renders `No results available.` in `content[]`; when its record lists `RESULT` references, the entry carries `resultPublications` and renders `No results posted to ClinicalTrials.gov. Result publications (N):` over one line per article in `clinicaltrials_get_study_record`'s reference format (`- <citation> (PMID: <pmid>)`, then `  Retracted — <source>, PMID: <pmid>` per retraction notice). Most completed studies post nothing, and many report in a journal instead: 22,570 completed studies without posted results carry a `RESULT` reference, against 67,670 completed studies with posted results (as of 2026-11-21). Example: NCT03288740 → `resultPublications: [{ pmid: "33159658", citation: "Shi A, …" }]` (#204).
- `RESULT` references only: `BACKGROUND` references are not results, and `DERIVED` references are indexed by NCT number by the registry itself rather than labelled results by the study. A reference with no PMID keeps its citation alone (183 of 3,203 in a 1,000-study sample); the list is uncapped, so a caller reads every article.
- The batch request adds `ReferencePMID`, `ReferenceType`, `ReferenceCitation`, `RetractionPMID`, and `RetractionSource` to its `fields` beside `ResultsSection`; the per-ID fallback fetches whole records, which carry the same references. The request target of a 20-ID batch grows from about 400 to about 485 bytes.

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
| `fields`  | `string \| string[]` | PascalCase leaf piece name(s) to get values for: record pieces, their alt names (`OVERALL-STATUS`), and index-only pieces (`NumLocations`, `StudyFirstPostYear`; the lookup order is under **Design Decisions** › input normalization). A group of fields and a search area (`ConditionSearch`) are refused (Error messages below), a metadata path is read as its piece, and a comma- or pipe-joined string (`"Phase,StudyType"`) is split into separate names. Common fields: `OverallStatus`, `Phase`, `StudyType`, `InterventionType`, `LeadSponsorClass`, `Sex`, `StdAge`, `DesignAllocation`, `DesignPrimaryPurpose`, `DesignMasking`. |

**Output schema:**

| Field        | Type          | Description                                                                                                                                          |
| :----------- | :------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fieldStats` | `FieldStat[]` | Per-field stats. Always `{ field, piece, type, missingStudiesCount?, multiValued? }`, plus the statistics variant the field's `type` carries (below). |

Upstream keys the statistics shape on `type` and omits the keys a variant does not carry:

| `type`              | Variant fields                                                                                                                |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------- |
| `ENUM`, `STRING`    | `uniqueValuesCount`, `topValues: {value, studiesCount}[]`; `STRING` may add `longest: {value, length, nctId, truncated?}` and `uniqueValuesCounted: false` |
| `BOOLEAN`           | `trueCount`, `falseCount`                                                                                                     |
| `INTEGER`, `NUMBER` | `min`, `max`, `avg` — numbers, each individually optional                                                                      |
| `DATE`              | `min`, `max` — date strings keeping the upstream precision, so `"1900-01"` stays partial — and `formats: string[]`             |

`multiValued` marks a repeated field: array-typed itself (`Phase`) or nested under a repeated object (`LocationCountry`, one per site; the index-only `LocationCountryCode` likewise, its repetition read from its ancestry in the index-only read). Its per-value `studiesCount` buckets sum above the study total, so they are not percentages of the corpus. The flag is absent for a single-valued field (`NumLocations`), and also for a piece neither the record index nor the index-only tier holds, or every piece when the field index is unavailable: an absent flag would then read as single-valued, so the service names those pieces and the handler adds a `notice` saying `multiValued` was not determined for them and that their buckets may sum above the study total. That sentence shares the one `notice` with the `longest` preview disclosure.

Upstream reports `uniqueValuesCount: 0` and no `topValues` for free-text STRING fields whose distinct values it does not count (`DetailedDescription`, filled in ~400k studies). The handler passes that 0 through unchanged and adds `uniqueValuesCounted: false` whenever a `longest` value shows the field has values, so the 0 reads as no count rather than a count of zero; a field upstream reports no values for carries no `longest`, and its 0 gets no flag. The flag is additive rather than a dropped 0: omitting a value earlier releases returned would read as a removed output field.

`longest.value` is a whole recorded value, so the handler bounds it before either surface reads it: past 2,000 characters it becomes the first 2,000 (one fewer when the cut would split a surrogate pair), `longest.truncated` is `true`, and `length` stays the full length. A 2,000 bound previews only the document-scale fields (`DetailedDescription`, `ReferenceCitation`, `EligibilityCriteria`, `BriefSummary`, up to ~32k); every other field's longest value sits at or under ~1,600 and stays whole. An enrichment `notice` names, per truncated field, `clinicaltrials_search_studies` with `{"nctIds":["<nctId>"],"fields":["<piece>"]}`, which returns the full text on both surfaces for protocol and results fields alike. `clinicaltrials_get_study_record` is not the retrieval path: it replaces `resultsSection` with counts. No input raises the bound — raising one request-wide would re-inflate every other requested field to recover one value.

**Format function:** One block per field. `type` picks the header and, when a field reports no statistics at all, which absence line is honest for that variant; every statistic renders on presence, since upstream already omits the keys a variant does not carry. ENUM/STRING list every fetched value with its count, the 250-cap disclosure, and the longest value; BOOLEAN lists the true/false counts; INTEGER/NUMBER and DATE render their range. An absent `topValues` on those last two is a different statistics variant, not an empty dataset, so they never render the ENUM/STRING "No recorded values" line. A field flagged `uniqueValuesCounted: false` renders its header as `distinct values not counted`, never as `0 unique values`. A truncated preview's line reads `longest value (first 2000 of 32344 characters, in NCT…)`. A single-line longest value sits inside quotes on that line and takes the same inline escapes as a `topValues` entry (below), so an email in angle brackets, an emphasis run, or a backtick renders as its exact text; no block marker applies mid-line. A longest value holding a line break renders as a fenced block, longer than any backtick run in the value, so every line break survives verbatim and no line of the value can start a heading, a list item, or a field line of the listing.

Each `topValues` entry starts its own `content[]` line, where values such as `# fallopian tubes`, `+ 33`, `1. Publication`, and `>=65 years` would render as headings, list items, and blockquotes. The line backslash-escapes exactly the characters that would make CommonMark render something other than the value there — a block marker at the start, a `*` or `_` run that can open or close emphasis (it could pair with a run on another line), every backtick, a backslash before punctuation, `<` opening a tag or autolink, `&` opening an entity, `](` closing a link — and writes everything else as is, so `cdrh_docs` and `<=18 years` stay byte-identical. A value holding a line break or leading whitespace, which no single line carries exactly, renders as `value (N studies):` over a fenced block. `structuredContent` keeps every value verbatim.

**Error messages:**

- Group of fields (#191): `"'ConditionMesh' is a group of fields; ClinicalTrials.gov counts values in its leaf pieces only: 'ConditionMeshId', 'ConditionMeshTerm'."` (`field_invalid`, `data.invalid`, `data.suggestions` mapping each group to its direct leaf pieces), raised from the field index before any request. `/stats/field/values` counts leaf pieces only and answers a group with HTTP 400 `Unsupported field type: <type>`, which names a type, never the field, and fails the whole request, so every group in the call is named locally. A section or module that holds only groups gets its drill path instead of leaves: `"'ProtocolSection' holds only groups of fields; call clinicaltrials_get_field_definitions with mode=\"drill\" and path=\"protocolSection\" to find its leaf pieces."` `search_studies` accepts every group in `fields`, so the refusal belongs to this tool alone.
- Uncountable type: the upstream 400 is still translated to `field_invalid`, naming the requested pieces whose metadata `type`, `[]` stripped, is the reported type (`"Invalid field for value statistics: 'LocationGeoPoint' has type GeoPoint, which ClinicalTrials.gov does not count. …"`). It is the only signal for a leaf upstream refuses (`LocationGeoPoint`), and the path a group takes when the field index is unavailable or local validation is off, where a lone requested field is the one named. No type list is kept locally for this endpoint: `GeoPoint` is the only leaf type probed that upstream refuses, and a list would drift.
- Unknown name: `"Invalid field name: 'X'."`, raised only once the index-only tier misses the name too, plus up to three did-you-mean pieces drawn from the non-`STRUCT` pieces, so no suggestion is a group this tool would refuse (`Status` is not offered `StatusModule`); a dotted name is ranked on its last segment. An index-only piece the name is within two edits of leads the suggestions (`NumLocation` → `NumLocations`), and no search area is ever suggested. Without the index, upstream's 404 `Unknown piece name of field path: X` names only the first offender, and the message says so. When the index-only read fails, the names it would have checked go upstream as written and an unknown one's 404 is translated to the same `field_invalid`.
- Request too long: `request_too_long`, as in § 1.

---

### 4. `clinicaltrials_get_field_definitions`

Discovery tool for the study data model. Wraps `GET /studies/metadata`. Requires an explicit `mode`: `"search"` (keyword search), `"drill"` (subtree browsing by `path`), or `"overview"` (top-level sections).

**Description:**

```
Resolve valid field names from the ClinicalTrials.gov data model — the canonical
PascalCase identifiers (OverallStatus, EnrollmentCount, LeadSponsorName) the other tools
take. Every record piece works in clinicaltrials_search_studies `fields`; a leaf piece
(sourceType other than STRUCT) also works in `AREA[…]` expressions in `advancedFilter`
and the query parameters, and as input to clinicaltrials_get_field_values
(LocationGeoPoint aside); a leaf of a date or integer type (NormalizedDate, PartialDate,
DateTimeMinutes, integer, long, short) also works in `sort`. An index-only piece (drill
with includeIndexedOnly, e.g. NumLocations) works wherever a leaf does except `fields`.
Select a mode: "search" —
keyword search returning ranked matches (pass `query`, e.g. "enrollment", "sponsor",
"adverse events"); "drill" — drill into a specific section by dot-notation path (pass
`path`, e.g. "protocolSection.designModule"); "overview" — top-level summary of all
sections (no additional args).
```

**Input schema:**

| Parameter          | Type        | Description                                                                                                                                                           |
| :----------------- | :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`             | `enum`      | Required. `"search"` (keyword search, needs `query`), `"drill"` (subtree by `path`), or `"overview"` (top-level sections).                                            |
| `query`            | `string?`   | search mode only. Keyword to match field names against (e.g., `"enrollment"`, `"sponsor"`).                                                                           |
| `path`             | `string?`   | drill mode only. Dot-notation path to navigate into (e.g., `"protocolSection.designModule"`).                                                                         |
| `limit`            | `number?`   | search mode only. Max results to return, ≥ 1 with no upper bound — the whole index is scored either way, so a value past the match count returns every match. Default: 20. |
| `includeIndexedOnly` | `boolean?` | drill mode only. Also list index-only pieces (search-index fields such as StudyFirstPostYear, NumLocations) alongside the record fields. They work in `AREA[…]`, in `sort` (the integer counts), and in `clinicaltrials_get_field_values`, but not in `clinicaltrials_search_studies` `fields`; search mode never lists them. Default: false. |

**Output schema:**

| Field          | Type            | Description                                                               |
| :------------- | :-------------- | :------------------------------------------------------------------------ |
| `fields`       | `FieldDef[]`    | Field definitions with name, piece, sourceType, type, isEnum, path.       |
| `totalFields`  | `number`        | Total fields returned (including nested).                                 |
| `resolvedPath` | `string?`       | The resolved path (when mode is `"drill"`).                               |

**Behavior:**

- `mode="overview"`: returns top-level overview (2 levels deep) — sections and their direct children. Prevents context bloat.
- `mode="drill"`: navigates to the `path` subtree and flattens all descendants.
- `mode="search"`: returns keyword matches for `query`, ranked by relevance and capped by `limit`. Its answer is the field index, so when the shared index read (one attempt under 5 s) fails, the index is read again on the full retry ladder within the call's budget and the index built is kept for every later call. A tree with no fields is a failed read, `upstream_unavailable`, never an index.
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
| `nctId`          | `string`  | Required. `NCT` followed by 8 digits (e.g., `NCT03722472`); trimmed and uppercased before the check.       |
| `locationLimit`  | `number?` | Cap on locations returned, ≥ 0; `0` leaves the locations out (#188). Omit for the full upstream list.       |
| `outcomeLimit`   | `number?` | Cap on secondary and other outcomes, ≥ 0; `0` leaves them out (#188). Primary outcomes are never capped.    |
| `referenceLimit` | `number?` | Cap on references, ≥ 0; `0` leaves them out (#188). `seeAlsoLinks` are never capped.                        |
| `nearLocation`   | `object?` | `{ lat, lon, radiusMi }` (radius ≥ 1, default 50). Filters locations to the radius, sorts by distance, adds `distanceMi` (miles, one decimal; the exact distance decides inclusion and order). Sites without published coordinates are dropped. |

The limits and the radius have no upper bound: they slice or filter the one record already fetched, so a larger value costs nothing and means "everything" — a limit at or past a list's length, or a radius past the farthest site, returns the list reported exactly as an untrimmed one (#153).

**Output schema:**

| Field            | Type       | Description                                                                                                  |
| :--------------- | :--------- | :------------------------------------------------------------------------------------------------------------ |
| `study`          | `Study`    | The record with the caller's filters already applied. `protocolSection`, `derivedSection`, `documentSection`, `annotationSection`, `hasResults`. The heavy `resultsSection` is omitted. |
| `filtersApplied` | `object`   | Which caps trimmed a list, each with the upstream total. Empty when nothing was trimmed.                     |
| `resultsSummary` | `object?`  | Counts of the omitted posted results, present when the study has results to count.                           |

**Behavior:**

- Filters are applied once, before either output channel sees the record, so `structuredContent` and `format()` render the same data. A cap (and its upstream total) is echoed in `filtersApplied` only when it actually trimmed something — reporting a cap that trimmed nothing would imply a filter ran when none did. `nearLocation` always filters, so it is always echoed.
- The `resultsSection` (up to ~600KB on a large trial, against ~70KB of protocol) is dropped and replaced by `resultsSummary` counts. Fetch the data itself with `clinicaltrials_get_study_results`.
- A `nearLocation` filter that matched nothing still renders the Locations header and the reason. Omitting the section would make "sites exist, none within the radius" indistinguishable from "this study publishes no sites at all". A limit of `0` that empties a list (Locations, Secondary or Other Outcomes, References) likewise keeps the heading with the upstream total and one line naming the limit (#188); on a list the study does not carry, `0` records and renders nothing.
- **Document download URLs.** Each entry in `documentSection.largeDocumentModule.largeDocs[]` gains a `downloadUrl`. Upstream carries only a bare `filename`, which leaves a caller who can see that a protocol or SAP exists with no way to retrieve it.
  - Construction: `https://cdn.clinicaltrials.gov/large-docs/{XX}/{nctId}/{filename}`, where `{XX}` is the last two digits of the NCT number (zero-padded — `NCT03607500` → `00`) and the filename is URL-encoded as a path segment. `{XX}` is a per-study shard, not a fixed segment: the same filename under another study's prefix 404s.
  - This is an **observed CDN pattern, not a documented API contract** — the official OpenAPI v2 `LargeDoc` schema defines no URL field. Treat it as best-effort.
  - The NCT ID comes from the record's own `identificationModule.nctId`, not the one the caller passed: upstream resolves a previous (alias) ID to its canonical record, and the shard follows the canonical ID.
  - An entry with no `filename` gets no `downloadUrl` rather than a fabricated one.
  - The builder lives in `services/clinical-trials/document-url.ts` — its own module, so tool and resource tests that mock the service module still reach it. It is applied in the shared pre-render pass (`applyFilters`), the one place both this tool and the `clinicaltrials://{nctId}` resource route a whole record through, so the two surfaces cannot disagree about where a document lives.

**Error messages:**

- Unknown NCT ID: `study_not_found` (`NotFound`) — upstream 404s a nonexistent ID cleanly.
- Upstream 429 after the retry budget: `rate_limited` (`RateLimited`, retryable) — also when the call's budget runs out after a 429 that completed.
- No answer within the call's 50 s budget: `retry_deadline_exceeded` (`Timeout`, retryable), `data.deadlineMs` the call's budget.
- Upstream 504 or 408, or an attempt's own timeout, on every attempt: `upstream_timeout` (`Timeout`, retryable).
- A 500, 502, or 503, a dropped connection, or a 200 body that is not a study (not JSON, or without an object `protocolSection`) on every attempt, or a 5xx the retry set lacks (505) or a refused or unresolvable connection on its one attempt: `upstream_unavailable` (`ServiceUnavailable`, retryable).
- A 501, a 3xx, a 4xx other than 400, 404, 408, 414, and 429, or a 404 whose body is an HTML page rather than the API's plain-text answer: `upstream_rejected` (`ServiceUnavailable`, not retryable). Every other tool and the resource take the same three upstream reasons (see **Resilience**).

**Format function:** A `# Study {nctId}: {title}` header, then the protocol record section by section — status/design, dates, sponsor, conditions and MeSH terms, summary, eligibility, interventions, arms, outcomes, results summary, contacts, locations, IPD sharing, documents (each with its `downloadUrl` rendered verbatim), references, annotations — closing with a `*Filters applied: …*` footer that guarantees every `filtersApplied` field reaches `content[]` regardless of which sections rendered. Registry text in a single-line slot (titles, `**Label:** value` rows, MeSH and browse-term lists, the non-prose rows of the remaining-field dump) has CR/LF folded to a space (`oneLine`); long-form prose (summaries, descriptions, criteria) keeps its breaks (#180). The `## Results Summary` line gives a count of 1 its singular noun (`1 participant flow period`, `1 baseline measure`, `1 outcome measure`, `1 serious adverse event`, `1 other adverse event`; 0 and plurals unchanged, and `resultsSummary` keeps the numbers), and a contact with an extension but no phone renders `ext. N` rather than `undefined ext. N` (10 studies carry such a central contact, e.g. NCT03653156).

---

### 6. `clinicaltrials_get_study_count`

Lightweight count-only tool. Uses `GET /studies?countTotal=true&pageSize=1&fields=NCTId` — one study ID rides along with the total, since upstream answers `pageSize=0` with its default page of ten full studies. Replaces the heavy `analyze_trends` tool — the LLM can call this multiple times with different filters to build breakdowns.

**Description:**

```
Get total study count matching a query without fetching study data. Fast and lightweight.
Use for quick statistics or to build breakdowns by calling multiple times with different filters
(e.g., count by phase, count by status, count recruiting vs completed for a condition).
```

**Input schema:**

| Parameter           | Type                  | Description                        |
| :------------------ | :-------------------- | :--------------------------------- |
| `query`             | `string?`             | General full-text search. Maps to `query.term`. Also accepted as `query.term` or `query_term`. |
| `conditionQuery`    | `string?`             | Condition/disease search. Maps to `query.cond`. Also accepted as `query.cond`, `query_cond`, or `condition`. |
| `interventionQuery` | `string?`             | Intervention/treatment search. Maps to `query.intr`. Also accepted as `query.intr`, `query_intr`, or `intervention`. |
| `locationQuery`     | `string?`             | Location search (city/state/country/facility). Maps to `query.locn`. Also accepted as `query.locn` or `query_locn`. |
| `sponsorQuery`      | `string?`             | Sponsor search. Maps to `query.spons`. Also accepted as `query.spons`, `query_spons`, or `sponsor`. |
| `titleQuery`        | `string?`             | Search within study titles/acronyms. Maps to `query.titles`. Also accepted as `query.titles` or `query_titles`. |
| `outcomeQuery`      | `string?`             | Search within outcome measures. Maps to `query.outc`. Also accepted as `query.outc` or `query_outc`. |
| `statusFilter`      | `string \| string[]?` | Filter by study status. Normalized like `search_studies`' (`"recruiting"` → `RECRUITING`). Also accepted as `filter.overallStatus` or `filter_overallStatus`. |
| `phaseFilter`       | `string \| string[]?` | Filter by phase. Normalized and validated like `search_studies`' (`"Phase 3"` → `PHASE3`; an expression fails as `enum_invalid`). Also accepted as `phase`. |
| `advancedFilter`    | `string?`             | Advanced AREA[] filter expression. Also accepted as `filter.advanced` or `filter_advanced`. |

The aliases are `search_studies`' (see **Parameter aliases** there), less `filter.geo`, `limit`, and `max_results`: this tool has no `geoFilter` or page size, so `limit` stays an unknown key.

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
Find candidate clinical trials for a patient profile (age, sex, conditions, location).
Candidates are matched on age, sex, location, recruitment status, and a fuzzy condition
search only — inclusion/exclusion criteria are not checked, and a candidate can exclude the
requested condition, so review each one with clinicaltrials_get_study_record. Internally
builds optimized queries with demographic filters.
```

The tool name keeps `eligible`, but the results are candidates, not eligibility determinations: the returned records carry the demographic limits (age range, sex, healthy volunteers) and never the free-text criteria. Hard-filtering on literal condition names was rejected because it drops legitimate synonym matches (#72), and inferring eligibility from free text would overclaim what a demographic profile can establish (#147).

**Input schema:**

| Parameter        | Type       | Description                                                                   |
| :--------------- | :--------- | :---------------------------------------------------------------------------- |
| `age`            | `number`   | Patient age, a whole number 0–120 read in `ageUnit`.                          |
| `ageUnit`        | `enum?`    | Unit of `age`: `years` (default), `months`, `weeks`, `days`, read case-insensitively and singular or plural (`Month` → `months`); a blank is treated as omitted. Lets an infant reach a study registered for 6 to 8 months, which no whole number of years matches (#162). |
| `sex`            | `enum`     | Biological sex: `FEMALE`, `MALE`, `ALL`.                                      |
| `conditions`     | `string[]` | Medical conditions or diagnoses. E.g., `["Type 2 Diabetes", "Hypertension"]`. |
| `location`       | `object`   | Patient location: `{ country: string, state?: string, city?: string, near?: { lat, lon, radiusMi } }`. `near` is the patient's coordinates and how far they can travel: `lat` -90 to 90, `lon` -180 to 180, `radiusMi` at least 1 (decimals allowed), default 50, no maximum; an out-of-range `lat`, `lon`, or `radiusMi` below 1 is rejected as invalid arguments, never clamped, while a `radiusMi` past 12,451 mi is sent as 12451 and the notice says so. It replaces `city` and `state`: either with content beside `near` fails as `location_conflict`, and a blank or quote-only one is unset and does not conflict. `country` stays required and is still sent (#205). A country synonym ranks sites as the registry spelling does (`USA`/`US` → `United States`, `UK`/`England` → `United Kingdom`, `Czech Republic` → `Czechia`, `Republic of Korea` → `South Korea`, `PR`/`GU`/`VI`/`AS`/`MP` → the US territories, which the registry files as countries); a US state or DC abbreviation (`WA`, `DC`) ranks as its full name when the country is the United States or a synonym for it (#172). |
| `healthyVolunteer` | `boolean?` | Query only studies accepting healthy volunteers. Default: `false`. |
| `recruitingOnly` | `boolean?` | Only include actively recruiting studies. Default: `true`.                    |
| `maxResults`     | `number?`  | Maximum candidates to return, ≥ 1, no maximum. Default: `10`. Each call returns at most 50; above that it serves 50 and, when more studies match, discloses the cut (`truncated`, `shown`, `cap`, and a sentence appended to the candidate `notice`) pointing at the `searchCriteria` replay (#153). Also accepted as `limit`, the result-count name `search_studies` takes too, an input alias that is not advertised; sending both is rejected. |
| `locationLimit`  | `number?`  | Cap on the matched sites returned per candidate, ≥ 1, no maximum. Default: `10`. A limit past the matched sites returns all of them, reported as an untrimmed list (#153). Under `location.near` the matched sites are those within `radiusMi` in any country, nearest first. A candidate with no recruiting site among those the cap keeps carries one more — a recruiting site, the nearest one (in the requested country when one recruits there) when coordinates allow. Under `location.near` the same one site is also added when none of the sites the cap keeps is in `location.country` and a site there recruits. Under `location.near` the cap keeps the nearest sites whatever their status, so the added site can be one within the radius that the cap cut. |

**Output schema:**

| Field        | Type      | Description                                                                                                                                                                                                                                                                              |
| :----------- | :-------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studies`    | `Study[]` | Candidate studies, re-ranked and capped at `maxResults` (at most 50); inclusion/exclusion criteria are not checked. Each carries the requested fields: `nctId`, `briefTitle`, `briefSummary`, `overallStatus`, phase/enrollment/sponsor, `conditions`, interventions, `eligibilityModule` (age range, sex, healthy volunteers), a bounded `locations[]` — the sites matching the requested location at the narrowest level that matched (city, else state, else country), sorted by match score and capped at `locationLimit`, plus one recruiting site when none of the matched ones is recruiting (under `location.near`, also when none of them is in `location.country` while a site there recruits; the nearest one by published coordinates, in the requested country when one recruits there, carrying `distanceMi`, else the first in match order) — and central contacts (with `role`, and `phoneExt` when registered). Each returned site, the added recruiting site included, keeps every contact it registers in `contacts[]` (`name`, `role`, `phone`, `phoneExt`, `email` — the keys the registry has); a site with no contacts has no `contacts` key (#202). A candidate whose sites were bounded also carries a top-level `locationSummary` (`totalLocations`, `matchedLocations`, `locationsTruncated`, `nearestRecruitingSiteAdded?`, `retrieveFullStudyWith`); it is absent when nothing was dropped, and `nearestRecruitingSiteAdded` is present only when that extra site was added, keeping its name when the site was picked by match order. Under `location.near`, `locations[]` holds the sites within the radius in any country (`country` is matched on some site of the study, not necessarily these), nearest first, capped at `locationLimit`, each with `distanceMi` (miles from the patient's point, one decimal); when none measures inside the radius the nearest measured site stands alone, and when no site publishes coordinates the sites are kept, capped and unmeasured. The added recruiting site is the one nearest the point, home country first, its `distanceMi` from the point, so it can lie past the radius, or within it when the cap cut it; `locationSummary.matchedLocations` is the within-radius count and can be 0. Candidate order is unchanged (#205). |
| `totalCount` | `number?` | Total candidate studies matching the full filter set upstream, before the `maxResults` cap.                                                                                                                                                                                              |
| `near`       | `object?` | Echo of `location.near` (`lat`, `lon`, `radiusMi`), present only when it was given; `radiusMi` is the radius sent, 12451 when the one requested was past it. Each candidate's sites were bounded to `radiusMi` of this point, apart from the fallbacks and the added recruiting site `studies` describes, and every site's `distanceMi` is miles from it. |

**Enrichment (agent-facing context, rendered as a `content[]` trailer):**

- `searchCriteria` — echo of the normalized query (`conditions`, `age`, `sex`, and `ageUnit` only when it is not years, so the trailer reads `age=7 months`) plus the exact upstream strings needed to reproduce the full match set via `clinicaltrials_search_studies`: `location` (the composed `queryLocn`, `SEARCH[Location](…)` and its `AREA[LocationState]` / `AREA[LocationCountry]` operands included, replayed as `locationQuery`), `conditionQuery`, `statusFilter`, `advancedFilter`, and, only under `location.near`, `geoFilter` (the `distance(lat,lon,radiusMi mi)` value sent, numbers in plain decimal, the radius at most 12451, replayed as `geoFilter` beside `locationQuery`; the replay line gains ``geoFilter=`…` ``). `find_eligible` returns only `maxResults`; a caller replays these to page the remaining matches (ranking is not reproduced — the condition/location re-rank runs only over the fetched page). Each string value renders as a code span (a fenced block when it holds a line break) and each list entry the same way, through `formatEchoValue`, so a `content[]`-only caller copies it back as sent; `structuredContent` carries the raw values (#177).
- `funnel` — match counts at each filter stage (`conditionMatched` → `locationMatched` → `demographicsMatched`), showing where the funnel collapsed. Under `location.near`, `locationMatched` and `demographicsMatched` include the radius; `conditionMatched` is unchanged.
- `notice` — recovery guidance when no studies matched, which quotes the caller's conditions; it renders in `content[]` with Markdown escaped and quoted line by line, while `structuredContent` keeps the raw text (#177). When studies are returned, one caveat for the whole response, never per study: candidates were matched on age, sex, location, recruitment status, and a fuzzy condition search only, inclusion/exclusion criteria were not checked, and each should be reviewed with `clinicaltrials_get_study_record` (#147). When `maxResults` was above the per-call cap of 50 and more studies match, a sentence follows the caveat naming the requested, served, and total counts and pointing at the `searchCriteria` replay.
- `truncated` / `shown` / `cap` — set together, via `ctx.enrich.truncated`, only when `maxResults` exceeded the per-call cap of 50 and more studies match than were returned (#153). Numbers only; no configuration name.

**Handler logic (simplified from old server):**

1. Judge blankness on what the query builder emits — `"` and invisible format characters (`\p{Cf}`: U+200B, U+FEFF, …) stripped, then trimmed (#145). A `conditions` entry or `location.country` with no content left fails with `blank_value` before any upstream call, its message saying neither counts as content (a zero-width value otherwise reaches upstream, which answers a bare `Search error`); an optional `city` or `state` with no content left is unset, as `""` is. Then build the condition query from `conditions`: an entry containing whitespace is quoted, any other entry is sent as written, punctuation and `( ) [ ]` included (an embedded `"` stripped), and the entries are joined with `OR`
2. Build location query from `location` — the present parts joined with an explicit ` AND ` and the whole wrapped in `SEARCH[Location](…)`. A comma join sent multiword components upstream as loose tokens, so a study listing exactly the requested site could score zero and the tool reported no trials in a location that has them (#118). A bare AND matched the parts across a study's whole site list — London + Canada admitted a study whose London site is in the UK and whose Canadian site is in Toronto — while `SEARCH[Location](…)` requires one site to carry every part (#159). The city is a search term, quoted unless it is a single run of letters and digits (`Toronto` stays bare; `"Winston-Salem"`, `"L'Aquila"`, `"a)OR(b"` are quoted). Location parts take this wider quoting and conditions do not: inside the wrapper a bare part carrying punctuation under-matches (bare `Winston-Salem` finds a small fraction of the cancer studies its quoted form finds, all with a Winston-Salem, NC site), while a condition keeps the match set it has always had. `AREA[LocationCity]` binding was rejected because it drops genuine sites whose city field holds a borough or a neighbouring town: Harrow and Sutton under state London, The Bronx and Brooklyn for New York, a Seattle-named clinic in Burien. State and country are bound to their own fields as `AREA[LocationState]"…"` and `AREA[LocationCountry]"…"` (#164). As search terms they matched any field of a site — `Washington` admitted studies whose only match was a `Washington D.C.` city or a `Washington University` facility, and `Mexico` matched New Mexico — and missed the country synonyms only `AREA[…]` resolves (`Czech Republic` for `Czechia`, `UK`, `USA`). Both operands are always quoted, since a bare one-word state such as `Missing` reads as the `MISSING` operator. When a city is also given, the state arm is `(AREA[LocationState]"…" OR AREA[LocationState]MISSING)`: the city locates a site that files no state (most London sites file none), while a site filing a different state fails. Without a city the state is the only locator below the country, so it stays strict. The state field folds diacritics (`São Paulo` and `Sao Paulo` match the same sites); the country field resolves synonyms (`UK`, `Türkiye`) but folds none — `México` matches no study while `Mexico` matches every Mexican site — so a country carrying diacritics becomes `(AREA[LocationCountry]"México" OR AREA[LocationCountry]"Mexico")`, both arms on the same site field. An embedded `"` is stripped from every part, since upstream has no working escape for one; quoting keeps a part carrying `(`, `)`, `[`, or `]` from closing the wrapper and regrouping the expression, and a quoted value's backslashes are doubled, since a single one would escape the closing quote and leave the phrase open for a later part to regroup. The same string feeds the main search, the location-stage funnel count, and the `searchCriteria.location` echo. `location.near` with a `city` or `state` that has content fails as `location_conflict` before any request: upstream matches `filter.geo` and `SEARCH[Location](…)` independently, so a radius beside a city either narrows back to that place or qualifies a study on two different sites, one in the city and another near the point (#159), and the radius replaces them (#205). `country` is still required and still sent, so a study must register a site in that country as well as one within the radius; replaying `geoFilter` through `clinicaltrials_search_studies` without `locationQuery` is what drops the country
3. Build status filter: `['RECRUITING']` when `recruitingOnly`, otherwise unfiltered
4. Build advanced filter: age range `(AREA[MinimumAge]RANGE[MIN, {age} {ageUnit}] OR AREA[MinimumAge]MISSING) AND (AREA[MaximumAge]RANGE[{age} {ageUnit}, MAX] OR AREA[MaximumAge]MISSING)` (an absent bound is unbounded, so a study registered as "18 Years and older" still qualifies). The unit passes through unconverted (`7 months`): upstream compares ages across units and ignores case and number, so `7 months`, `30 weeks`, and `213 days` all match a `6 Months`–`8 Months` study (#162). Plus `(AREA[Sex]ALL OR AREA[Sex]{sex})` when sex ≠ `ALL`, plus `AREA[HealthyVolunteers]true` when `healthyVolunteer`
5. Run the main search (`pageSize=min(maxResults, 50)`, unclamped by `CT_MAX_PAGE_SIZE`, `fields=ELIGIBLE_FIELDS`, which includes `LocationGeoPoint` and the `LocationContact` and `CentralContact` groups, `countTotal`) then two funnel-stage counts (condition-only, condition+location) through the service's `countStudies`, awaited in that sequence. Under `location.near`, `filter.geo=distance(lat,lon,radiusMi mi)` goes on the main search and the location-stage count, never on the condition-only count, with each number written in plain decimal (`1e-7` is spelled out, since upstream rejects exponent notation) (#205). The service paces outbound requests at least ~1s apart, so issuing them together saved no time, and a failure left the others queued to reach ClinicalTrials.gov after the error returned, delaying the next call's requests; in sequence a failure sends nothing further and the caller gets that request's own error (#176)
6. Re-rank studies so those whose own condition list names a requested condition surface above tangential MeSH-umbrella matches (#72/#79), comparing each requested condition as the query carries it (quotes stripped, so `"ALS"` ranks like `ALS`), then sort each study's locations by match to the patient location (city > state > country) and bound each list to the best-matching tier, capped at `locationLimit`. City and state compare as folded word sequences, the way upstream's own location match folds them: lowercased, decomposed and stripped of diacritics, `ß æ ø ł ı` mapped to `ss ae o l i`, periods and apostrophes deleted, then split on everything but letters and digits — so `Montréal` ranks like `Montreal`, `St. Louis` like `St Louis`, and `Washington DC` like the registry's `Washington D.C.`; a name that folds to no words never matches (#166). Each distinct site spelling is folded once per request and reused, never refolded on each comparison of the sort. City and state points go only to sites whose country contains every word of the requested one, folded the same way (`Korea` matches the registry's `South Korea`, `México` its `Mexico`), so a foreign namesake (London, UK for a London, Canada request) never leads the matched tier (#159). The country point uses the same word test, so `Korea` earns it on `South Korea` sites (#166). Upstream resolves country synonyms the gate's word test does not (`Czech Republic` for `Czechia`, `UK`, `USA`), so the ranking compares the registry's spelling of a requested country instead: `place-names.ts` maps the common synonyms (`USA`/`US`, `UK`/`England`, `Czech Republic`, `Republic of Korea`, the US territory codes `PR`/`GU`/`VI`/`AS`/`MP`) to it, each measured to match exactly the studies of the registry spelling through `AREA[LocationCountry]`, and maps a US state or DC abbreviation to its full name when the country is the United States or a synonym for it (unbound, `WA` also covers Western Australia). The query and its echo keep the caller's spelling (#172). The gate still applies to a study only when at least one of its sites passes it: upstream also resolves spellings neither the table nor the word test carries (`CZ` for `Czechia`), so a study can qualify on sites the gate rejects, and gating such a study would score every site 0 and keep its whole site list, so it is scored ungated and the city still bounds it. The tier is geographic, so a tier holding only closed sites would answer with a candidate nobody can enroll in — when that happens one recruiting site is admitted alongside it (#114): the one nearest the matched tier, by haversine distance from `LocationGeoPoint` to the closest site of the whole tier before the `locationLimit` cap, carrying `distanceMi`; ties keep match order. Candidates in the requested country (by the gate's word test) are ranked alone whenever there are any, so a nearer site across a border (Seattle → Vancouver, BC) never displaces one at home; the rest of the tier score is ignored, since an out-of-state site is often the nearer one (Portland, OR → Vancouver, WA). When the matched tier or every recruiting candidate lacks coordinates, the first candidate in match order is admitted with no `distanceMi`, and the text makes no distance claim (#138). Under `location.near` the radius decides instead of the match tier: each candidate's sites are measured from the point with the pass `clinicaltrials_get_study_record`'s `nearLocation` runs (`sitesByDistance` in `geo-helpers.ts`, the exact distance deciding inclusion and order, each site carrying it rounded to one decimal), and the sites within the radius, nearest first, are kept up to `locationLimit`. Upstream's `filter.geo` can admit a study on a site this measurement puts just past the radius, so when no site measures inside, the nearest measured site stands alone and the list is never empty; sites without coordinates are never within the radius, and a study whose sites publish none keeps them, capped and unmeasured, as an unmatched study does. Sites are in distance order, so a recruiting site within the radius can sit past the cap, and the #114 admission applies measured from the point: the recruiting site nearest it, home country first, with its `distanceMi` from the point (it can lie past the radius). The admission has two triggers and adds at most one site: none of the sites the cap keeps is recruiting, or none of them is in the requested country while a site there recruits (#210). The second keeps a site in the patient's country from hiding behind sites across a border, and a candidate meeting both triggers still gets one added site, never two. Candidate order is untouched (#205). Coordinates are dropped from the returned sites once measured. The bound is applied here, once, so `structuredContent` and `format()` render the same sites (#46, #91)
7. Enrich with `searchCriteria` (including the reproducible `conditionQuery`/`statusFilter`/`advancedFilter` strings, and `geoFilter` under `location.near`) and `funnel` diagnostics, plus `notice`: stage-specific recovery guidance on zero results, otherwise the once-per-response candidate caveat. The zero-result guidance follows the first funnel stage that matched nothing and names only steps that widen it (#50, #185): a condition matching nothing alone gets condition-level steps (a synonym, broader, or MeSH term as another entry, or fewer words), since no location, demographic, or status filter applies to that count; a location matching nothing gets a step by request shape (#205). Under `location.near` it is "Widen location.near.radiusMi past <r> to reach sites farther from the patient", the one step that widens that stage, since the country is already as wide as `near` goes; when the radius sent is already 12451 it reaches every site that publishes coordinates, so the step is the `geoFilter` replay through `clinicaltrials_search_studies` instead, without `locationQuery` and with `includeUnknownEnrollment=true`. A radius past the cap adds a closing sentence to the `notice` naming the requested radius and the 12451 mi sent, on every outcome, ending a collapsed stage's no-match guidance too. A city or state request without `near` is told to remove them to search the whole country, or to replace them with `location.near` (the patient's coordinates and a `radiusMi`, default 50) to match sites by distance. A country-only request keeps the replay step — geocode the patient, then replay `searchCriteria` through `clinicaltrials_search_studies` with `geoFilter` in place of `locationQuery`, which reaches past the country — because `near` still sends the country and cannot widen it; only the demographics stage gets the age, sex, `recruitingOnly`, and `healthyVolunteer` hints. The zero-result note on an extreme age (≤ 1 or ≥ 100 years) judges the age in years and names a non-year unit (`Age 7 months …`), so 120 months is not called extreme
8. Return the re-ranked studies (capped at `maxResults`, at most 50) with `totalCount`

**Site contacts (#202):** a central contact is often a sponsor's national line, while the matched site carries the local coordinator and principal investigator, and a study can publish no central contact at all (4,090 of 65,223 recruiting studies, as of 2026-11-21, 4,088 of them with contacts on their sites). So `ELIGIBLE_FIELDS` requests the `LocationContact` group (name, role, phone, phoneExt, email), and each returned site keeps the upstream `contacts[]` whole. Contacts are requested as groups, `CentralContact` included, never leaf by leaf: the five site-contact leaf names add 141 bytes to a request that a long `conditions` list already puts beside ClinicalTrials.gov's 8,177-byte limit, where a 548-condition call that fit without them failed `request_too_long`; with the two groups the field list is 30 bytes shorter than the one sent before site contacts joined it. The `CentralContact` group returns each central contact's `role` as well, so central contacts carry it. In `content[]` the one-line `Locations:` is one line per site, with unchanged place, status, and distance text, each followed by its contacts, one `Contact: name | role | phone ext. N | email` line apiece (`contactLine`, shared with `clinicaltrials_get_study_record` from `format-helpers.ts`); a central contact with an extension renders `…, 555-1234 ext. 9, …`. There is no per-site contact bound, as in `get_study_record`: the largest site list in the registry (57 contacts, recruiting NCT04654923) adds 3,512 B to `content[]` and 3,722 B to `structuredContent`, and `maxResults` and `locationLimit` already keep response size in the caller's hands.

**Location by distance (#205):** what limits a patient is travel distance, and place names split it badly. For non-small cell lung cancer, age 62, male, recruiting (2026-11-21): city Seattle matches 73 candidates, within 15 mi of Seattle 78, within 25 mi 88, state Washington 106, so a city misses Renton (10.1 mi) and Edmonds (14.3 mi) while a state takes in Spokane (228 mi) and puts a distance on no site. `location.near` takes the point and radius with the names, units, and bounds of `get_study_record`'s `nearLocation`; the decisions:

- `near` cannot be combined with `city` or `state`. Upstream matches `filter.geo` and `SEARCH[Location](…)` independently, so the pair either narrows back to the city or qualifies a study on two different sites (#159). The call fails as `location_conflict` (`ValidationError`) before any request, its hint naming both ways out. A blank or quote-only `city` or `state` is unset (#145) and does not conflict.
- `country` stays required and is still sent, so the radius is one more constraint beside it rather than a replacement for the location query; the country is also what the home-country preference for the added recruiting site is read from. Upstream matches the country inside `SEARCH[Location](…)` and `filter.geo` on separate sites, as it does a city (#159), and a radius cannot go inside the wrapper (#206), so a candidate can qualify on a site in the country far away and list only sites in range across a border: for a patient in Windsor, Ontario with `country` Canada and a 10 mi radius, 18 of the first 20 breast-cancer candidates list Detroit sites only (2026-11-21). The sites listed stay the ones in range, in any country, since a site across a border can still be the one the patient reaches. `content[]` says once that the country is matched on any site, the Sites line counts `K within <r> mi of the patient`, never sites matching the requested location, and each site line names its country. The added recruiting site keeps the home-country preference, and it is also added when none of the listed sites is in the country and a site there recruits, even if a listed site recruits across the border (#210); its Sites-line note says so, since a nearer recruiting site across the border can beat it on distance (NCT06590857 for that Windsor patient: Vancouver, BC at 1,965 mi over Indianapolis at 240 mi).
- Out-of-range values are rejected at the schema (`lat` 91, `lon` 181, `radiusMi` 0 or 0.5), never clamped: a clamped value answers a different question than the caller asked.
- A `radiusMi` past 12,451 mi (20,039 km for `geoFilter`) is sent at that cap instead of rejected (#211): no two points on Earth are farther apart, so the capped radius reaches the same sites, while a radius past about 1.1e305 mi overflows upstream and draws a bare 400. The echo, `searchCriteria.geoFilter`, and every rendered line carry the radius sent.
- Numbers go upstream in plain decimal (`plainDecimal`): `String(0.0000001)` is `1e-7`, which upstream rejects inside `filter.geo`. A `geoFilter` string in exponent notation fails as `geo_invalid` at any size, with a message that asks for the number written out in digits.
- The sites kept are the ones the haversine pass puts inside the radius, nearest first. When none does, the nearest measured site stands alone instead of an empty list: upstream decides which studies qualify with its own geometry, so a candidate can arrive on a site that measures just past the radius, and an empty `locations[]` would present a matched study with no site to contact. `locationSummary.matchedLocations` is then 0, the true within-radius count. Upstream's boundary agrees with this pass to about a millionth of a mile (a Fairbanks, AK site cluster at 10.000 mi from the point is admitted at `radiusMi` 10, at 10.001 mi it is not), so the stand-in appears only for a site on the boundary itself.
- `content[]` leads with `Sites within <r> mi of the patient at <lat>,<lon> (location.near), nearest first, in any country: …` (the country sentence above) and each site's note reads `(X mi from the patient)`, where without `near` an added site's note is `(X mi from the nearest matched site)` (#138). The Sites line reads `(K within <r> mi of the patient…)`, adding `, so the nearest measured site is shown` or `: no site publishes coordinates, so the sites are shown unmeasured` when K is 0. When a recruiting site is added, the line names the sites listed before it (`the first site listed is not recruiting`, or `none of the first N sites listed is recruiting`), never the sites in range: the cap keeps sites by distance, so a recruiting site in range can sit past it and be the one added, and `locationsTruncated` then counts it among the sites shown. When the site is added only because none of the sites listed is in the requested country (a listed site recruits), the clause reads `the first site listed is not in the requested country` or `none of the first N sites listed is in the requested country`, and the header says once that such a site is added last.
- The location-stage no-match notice names the step that widens that stage, as step 7 lists; a country-only request keeps the `geoFilter` replay because `near` cannot widen a country-only search.
- Measured 2026-11-21 with that patient at 15 mi and 25 mi: 78 candidates (funnel 8148 → 421 → 78) and 88 (8148 → 496 → 88), and the echoed `searchCriteria` replayed through `clinicaltrials_search_studies` returns the same totals.

**Dropped from old server:** Complex multi-signal condition relevance scoring, healthy volunteer matching, detailed criteria snippet extraction. A lightweight condition re-rank was reinstated in #72 — results are stable-sorted so studies whose own condition names a requested condition rank above tangential MeSH-umbrella matches (recall preserved, nothing dropped). The returned records carry the age, sex, and healthy-volunteer fields but not the free-text inclusion/exclusion criteria, so the LLM evaluates nuanced eligibility from `clinicaltrials_get_study_record`.

---

## Resource Designs

### `clinicaltrials://{nctId}`

Single study by NCT ID. Wraps `GET /studies/{nctId}`. Returns a bounded study record as JSON.

**URI examples:**

- `clinicaltrials://NCT03722472`
- `clinicaltrials://NCT04852770`

**Params:** `nctId` — the shared NCT ID schema, so `clinicaltrials://nct03722472` reads `NCT03722472`.

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
| `countStudies(params)`   | `GET /studies`            | Total for a query and filters (`countTotal=true&pageSize=1&fields=NCTId`) |
| `getStudy(nctId)`        | `GET /studies/{nctId}`    | Fetch single study by NCT ID                            |
| `getFieldValues(fields)` | `GET /stats/field/values` | Get value frequency stats for fields                    |
| `getMetadata(indexed)`   | `GET /studies/metadata`   | Get field tree (optional indexed-only filter)           |

**A separate `countStudies` method** serves every count-only request — `clinicaltrials_get_study_count` and both `clinicaltrials_find_eligible` funnel stages. Upstream treats `pageSize=0` as its default page (ten full studies, ~200–650 KB on a broad query), so the count asks for one `NCTId`-only study (~160 B) and reads `totalCount`. It skips local `fields` validation: `NCTId` is fixed and valid, and validating it would fetch `/studies/metadata` (~175 KB) on a fresh server's first count. The results ID batch (`getStudiesBatch`) and the eligibility candidate search send fixed projections the same way (`fixedFields`).

**Resilience:**

| Concern             | Decision                                                                               |
| :------------------ | :------------------------------------------------------------------------------------- |
| Retry boundary      | The framework's `withRetry` around one paced attempt (fetch + JSON parse).             |
| Backoff calibration | Base: 1s (rate-limited API). Max 3 retries, 30 s cap, ±25% jitter.                     |
| Retryable errors    | HTTP 408, 429, 500, 502, 503, 504; a 200 body no consumer can read (HTML, text that does not parse as JSON, or JSON that fails its route's envelope — see **Response check**); a dropped or timed-out connection (`ECONNRESET`, `ETIMEDOUT`, on the rejection or its `cause`; on Node also `UND_ERR_SOCKET`, a socket the other side closed, and `UND_ERR_CONNECT_TIMEOUT`, undici's 10 s connect timeout); an attempt's own timeout. Once retries are spent, a 429 ends as `rate_limited`; a 408, a 504, or an attempt's own timeout as `upstream_timeout` (`Timeout`); anything else as `upstream_unavailable` (`ServiceUnavailable`). Each carries the path and a fixed `lastError` (an HTTP status, a transport code, a body fault, or `TimeoutError` for an attempt's own timeout), never text from upstream or the runtime. |
| Non-retryable       | HTTP 400 (bad request), 404 (not found), 414 (request target past 8,177 bytes → `request_too_long`). |
| Untranslated        | Every other status (304, 401, 403, 409, 410, 501, 505, …), and a 404 whose body is an HTML page rather than the API's plain-text answer, is sent once and ends as `ServiceUnavailable` — never `Unauthorized`, `Forbidden`, or `InvalidRequest`, since the API is public and keyless and none of those faults sits with the caller's credentials or arguments. A 5xx other than 501 is `upstream_unavailable`; 501, a 3xx, or a 4xx is `upstream_rejected` (not retryable). A connection that never opens (`ECONNREFUSED`, `ENOTFOUND`) is sent once and ends as `upstream_unavailable`. The message names the status and the path; the body stays on the server. |
| Rate limiting       | `createPacer` with `minStartGapMs: 1000`: request starts at least 1 s apart, FIFO across concurrent calls; a waiter cancelled or out of budget leaves the queue without spending a gap. |
| Request timeout     | `CT_REQUEST_TIMEOUT_MS` per attempt (30 s default), cut short when the call's budget runs out. The reference reads behind field validation — the field index (`/studies/metadata`) and the two second-tier reads — are one attempt each under a 5 s timeout, timed from their pacer slot, and fail open. |
| Call budget         | 50 s per tool call or resource read, keyed on its `Context` and started at its first reach into the service, covering every request it chains and each attempt, backoff, and pacer wait. Expiry → `retry_deadline_exceeded` (`Timeout`, `data.deadlineMs: 50000`); a budget that runs out after a 429 that completed → `rate_limited`; with nothing left, no request is sent. Sits under the MCP SDK clients' 60 s default request timeout. A wait on a load another call started (the field index, the second-tier reads) ends at the waiting call's own deadline without failing the load for the others. |
| Cancellation        | The caller's abort surfaces as `RequestCancelled` at once — mid-attempt, mid-backoff, or queued — and outranks the budget. |
| Response check      | A 200 body is parsed whatever its content type says, then checked for the top level its route serves before any consumer reads it, so a wrong-shaped body is never a success and the parser's error, which quotes the body, never reaches a caller. `/studies`: an object whose `studies` is an array (a count also needs a numeric `totalCount`, so a page without one is an outage, never a total of 0); `/studies/{nctId}`: an object with an object `protocolSection`; `/studies/metadata` (both forms), `/stats/field/values`, and `/studies/search-areas`: a non-empty array. No schema runs per study, statistic, or field node, which would refuse records the registry serves. A failure is classified as markup (HTML), not JSON, or an unexpected shape, and is transient. |

**Internal details:**

- Base URL from config, default `https://clinicaltrials.gov/api/v2`
- All requests use `format=json`
- Native `fetch`; the attempt timer and the call budget are armed with `setTimeout`, never `AbortSignal.timeout`, so vitest fake timers drive every bound
- Normalizes array filter params to pipe-delimited strings for the API

---

## Config

| Env Var                      | Required | Default                             | Description                                                                  |
| :--------------------------- | :------- | :---------------------------------- | :--------------------------------------------------------------------------- |
| `CT_API_BASE_URL`            | No       | `https://clinicaltrials.gov/api/v2` | API base URL override                                                        |
| `CT_REQUEST_TIMEOUT_MS`      | No       | `30000`                             | Timeout per request attempt in ms; a positive integer. An attempt ends sooner when its call's 50 s budget runs out |
| `CT_MAX_PAGE_SIZE`           | No       | `200`                               | Most studies one `clinicaltrials_search_studies` page returns; an integer ≥ 1, values above 1000 (the API's page maximum) clamp to 1000. 200 keeps a page within LLM context |

An invalid value fails startup with the framework's configuration banner naming the variable: config is first parsed in `setup()`, never at module import (#157).

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
| Study        | count                | `GET /studies?countTotal=true&pageSize=1&fields=NCTId` | Tool: `get_study_count`              |
| Field Values | list values          | `GET /stats/field/values`                       | Tool: `get_field_values`             |
| Metadata     | field definitions    | `GET /studies/metadata`                         | Tool: `get_field_definitions`        |
| Patient      | find eligible trials | `GET /studies` (composite query)                | Tool: `find_eligible`                |
| Analysis     | landscape analysis   | Multi-call orchestration                        | Prompt: `analyze_trial_landscape`    |

### Excluded

| Operation                   | Reason                                                                                                                                                         |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /studies/search-areas` | No tool. Read internally for its area names, which `advancedFilter` case correction folds (#179). Weights are low value for LLM workflows.                      |
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
2. Agent reviews each candidate's inclusion/exclusion criteria with `get_study_record(nctId)`, then presents the ones that still fit, with explanations

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

Dropped from the old server: complex multi-signal condition relevance scoring, healthy volunteer matching, criteria snippet extraction, multi-tier proximity ranking. Kept: demographic AREA[] filter construction, basic post-filtering, location sorting, and (reinstated in #72) a lightweight single-pass condition re-rank that keeps tangential MeSH-umbrella matches from outranking on-condition trials. The returned records omit the free-text inclusion/exclusion criteria, so the LLM evaluates nuanced eligibility from `clinicaltrials_get_study_record` — the tool's job is query construction, not clinical judgment.

### Input normalization for statusFilter, phaseFilter, fields, NCT IDs, and AREA[] names

Case and spacing variants that map one-to-one onto a valid value are accepted rather than rejected. `statusFilter` is normalized in the handler (`normalizeStatusFilter`) instead of a schema `z.enum`, so a value that still names no status reaches upstream and keeps the `enum_invalid` reason and recovery hint — a schema rejection would surface as a bare `-32602`. NCT IDs are canonicalized in the shared `nctIdSchema` with Zod's in-place `.trim().toUpperCase()` string checks: one change covers every tool and the resource, the advertised JSON Schema `pattern` stays `^NCT\d{8}$`, and handlers that dedup or look up by ID see one spelling. A `/i` regex flag was rejected because it accepts without canonicalizing, and `.transform()` cannot be emitted as JSON Schema. `z.preprocess` was rejected too (#154): a preprocess is a transform, which Zod marks optional, so a union over one (`get_study_results` `nctIds`) was advertised without its key in `required`.

`phaseFilter` is resolved in the handler too (`normalizePhaseFilter`), but validated there as well: each entry is interpolated into `AREA[Phase]<entry>`, so an entry upstream would accept as an expression (`PHASE3 OR AREA[StudyType]OBSERVATIONAL`) widens the cohort past the phase constraint instead of failing. Every entry must resolve to one of the six phase values — case, whitespace, `-`, `_`, and quotes ignored, `Not Applicable` mapped to `NA` — or the handler throws `enum_invalid` naming the caller's whole entry (never a split fragment), with a recovery hint that routes expressions to `advancedFilter`. Since quotes are ignored in matching, an entry with nothing left once quotes, whitespace, and format characters go is `blank_value`, as `find_eligible` judges a quote-only value. Still no `z.enum`, for the same reason as `statusFilter`. Upstream's own phase-enum rejection can then only answer a caller's `AREA[Phase]` expression in `advancedFilter` or a query parameter, so the service names that expression and no tool parameter.

`fields` (on `search_studies` and `get_field_values`) and `phaseFilter` entries are split on `,` and `|` (`splitListEntries`), the delimiters upstream itself uses for multi-value parameters; no piece name or phase value contains either. The split runs in the handler ahead of the blank check, not in the service's `normalizeFields`: there `[","]` would empty the list and silently fall back to the default projection, where the handler answers it `blank_value`. An entry that splits to nothing stays a blank entry for the same reason; a piece of only invisible format characters (U+200B) counts as nothing. A repeated piece is dropped after its first occurrence, order kept: it changes nothing but the URL length, and a long enough repeat runs the request past the length upstream accepts (`request_too_long`). `search_studies` `fields` also wraps a lone string in a `z.preprocess`, because the framework's lone-string repair refuses a string holding a comma; a `[`-leading string is left to the framework's stringified-array repair, and the advertised schema stays `type: array`.

After the split, the service's `normalizeFields` makes the unambiguous fixes against the field index — trimming surrounding whitespace, folding a case-only miss to its piece, mapping a metadata path, as `clinicaltrials_get_field_definitions` prints it or in another case, to its piece (`protocolSection.statusModule.overallStatus` → `OverallStatus`, #189), and applying the legacy renames (`RecruitmentStatus` → `OverallStatus`) — and logs every change in one `Field names auto-corrected` notice; `validateFields` then checks what is left. Upstream answers a path wherever it answers the piece, but matches paths case-sensitively (`protocolSection.StatusModule.OverallStatus` is HTTP 400 on `/studies` and 404 on `/stats/field/values`). The metadata paths stay unique when lowercased, so the fold has one reading, and a module or section path maps to its own piece, which upstream answers identically. A dotted name that matches no path stays `field_invalid`, its did-you-mean ranked on its last segment (`protocolSection.designModule.phase` → `Phase`): ranked whole, its enclosing module and section outrank the leaf. Without the field index a path goes upstream unchanged. `search_studies` takes every record piece in `fields`, groups included (`StatusModule` returns the module), and no index-only piece; `get_field_values` takes leaf pieces only (§ 3), but counts more kinds of name than `fields` does.

`/stats/field/values` counts the record leaf pieces, their alt names (`OVERALL-STATUS`, `COLLABORATOR`, answered under the piece: `COLLABORATOR` → `CollaboratorName`), and the index-only pieces with theirs (`NumLocations`, `NUMBER-OF-LOCATIONS`), and refuses every search area. So for `get_field_values` the `fields` lookup runs in this order, the first step that resolves a name deciding it: the record piece, or a record alt name, as written (an alt name goes out unchanged); the trimmed name; a case-only miss folded to its record piece (`collaborator` → the group `Collaborator`, which validation still refuses, #191); a metadata path, as printed or in another case, mapped to its piece; a record alt name in another case folded to its piece (`overall-status` → `OverallStatus`); the legacy renames; then, only when a name still misses, the index-only tier (`numlocations` → `NumLocations`, `NUMBER-OF-LOCATIONS` as written); and only then `field_invalid`. The alt-name fold sits after the piece fold so a lowered group name still names the group. The index-only tier is read on a record-tier miss only, so a call whose names all resolve never reads it. The read is `/studies/metadata?includeIndexedOnly=true`, shared with the `AREA[]` and `sort` second tier but never `/studies/search-areas`, which this endpoint refuses and whose outage must not cost a statistics call anything: one attempt per call under 5 s, shared by normalization and validation, nothing cached on failure. When it fails or its wait ends with the call's budget, a warning is logged, the names it would have checked go upstream as written (an unknown one's 404 becomes `field_invalid`), and an answered piece neither tier settled is named in the `multiValued` not-determined `notice`. Suggestions for a refused name lead with an index-only piece it is a near miss of and never name a search area. `multiValued` for an index-only piece comes from its repeated ancestry in that read (`LocationCountryCode` is repeated, `NumLocations` is not).

`AREA[…]` field names are matched case-sensitively by ClinicalTrials.gov in `filter.advanced` and every `query.*` parameter (#170). `search_studies` and `get_study_count` run the caller's `advancedFilter` and seven query parameters through `normalizeAreaNames` before `buildAdvancedFilter`, so the corrected text is what is sent, what the `nctIds` fit measures, and what `searchCriteria` echoes on both surfaces; `ctx.log.notice` records each rewrite. The AREA index is every non-`STRUCT` piece plus its `altPieceNames` (`OVERALL-STATUS`, `SPONSOR`): upstream refuses a `STRUCT` group inside `AREA[]`, and leaving the groups out is what keeps the case fold unambiguous (`collaborator` otherwise names both `Collaborator` and, through the alt name `COLLABORATOR`, `CollaboratorName`). A name the index holds as written goes out byte-identical; one absent from it that folds to exactly one piece is rewritten to that piece (`overallstatus` → `OverallStatus`, `Sponsor` → `LeadSponsorName`); anything else reaches upstream unchanged. A name the record index leaves unresolved is looked up in a second tier before that: the index-only pieces (`NumLocations`, from `/studies/metadata?includeIndexedOnly=true`) and the search areas (`ConditionSearch`, from `/studies/search-areas`), so `AREA[numlocations]` becomes `AREA[NumLocations]` and `AREA[conditionsearch]` becomes `AREA[ConditionSearch]` (#179). The second tier is read only when a name misses the record index (a `STRUCT` group, which upstream refuses, never reads it), once per call and shared by the AREA[] rewrite, the sort fold, and the suggestions on a rejection; each read is one attempt under a 5 s timeout, because a correction the call can do without must not spend a client's request timeout. The field index's own read has the same bound and the same decision: one attempt under 5 s on a context of its own, kept once built and dropped on failure (a tree with no fields counts as a failure, since a kept empty index would refuse every name until restart), because every consumer fails open and a hung `/studies/metadata` on the full retry ladder would spend the call's 50 s budget before the call's own request went out. The one consumer whose answer is the index, `clinicaltrials_get_field_definitions` in search mode, reads it again on the full ladder when the shared read fails. When either read fails, that lookup is skipped, a warning is logged, and the call goes out as it would with the record index alone; a failed read is re-read by the next call that needs it. The record index decides whenever it can, so the second tier changes nothing the record index resolves, and a lowercased form shared by two names folds to neither. The scanner is one left-to-right pass with no backtracking: outside a double-quoted literal the uppercase `AREA[` opens a name ending at the next `]`, inside `SEARCH[Location](…)` too; inside a literal `\` escapes the next character and `"` closes it. The index loads with the cached field index only when an expression contains `AREA[`, so a call without one never waits on `/studies/metadata`; when the metadata is unavailable every name passes through. Upstream's two AREA rejections — `Unknown area name` and `This type of query is not allowed for <piece>` (a `STRUCT` piece) — both become `field_invalid` with up to three `nearestPieces` suggestions drawn from the same index, so no suggestion names a group upstream would refuse in turn. An index-only piece or search area leads the suggestions only when the rejected name is within two edits of it (`NumLocation` → `NumLocations`); scored beside the record pieces they would reorder the ranking (`NumPhases` outranking `Phase` for `Phases`, every search area sharing the `Search` token). Those two keep the declared `field_invalid` hint, which sends the caller to look the name up. Upstream refuses a valid field or term in five more places, and `parseAreaRejection` reads each one into `field_invalid` with a `recovery.hint` written for that refusal, because the declared hint misdirects a caller whose name is already right (#183, #187, #206). The first place is `` `X` is outside Location scope ``: inside `SEARCH[Location](…)` upstream takes only the fields of one site, the pieces under the `Location[]` node, so `NumLocations` is refused while the index-only `LocationCountryCode` is accepted. The message lists the site fields and gives the form that goes beside the wrapper, `AREA[OverallStatus]RECRUITING AND SEARCH[Location](…)`. It has no did-you-mean, since ranking would offer site fields for a study-level count that shares their token. A listed search area that upstream reports as an `Unknown area name` can only have been named inside the wrapper, and the message says to move it outside. The second place is `RANGE is not supported for <type> field <path>`, a field that is not a date, a number, or an age. The piece is read from the field index's path map with `STRUCT` entries included (`leadSponsor` → `LeadSponsor`), and the path itself stands in when the index is unavailable. For the NCT ID path the message names the `StudyFirstPostDate` window, since NCT IDs are assigned in first-posting order. The third place is `… for multiple (N) fields`, a bare `RANGE[]` or one after a search area, which blames no field and asks for `AREA[Field]`; upstream answers a bare `DISTANCE[]`, or one after a search area, with the same body, naming RANGE, so the message covers both and asks for `AREA[LocationGeoPoint]` for a radius. The fourth place is a `DISTANCE[]` term inside `SEARCH[Location](…)`, which upstream answers on every site field probed (`LocationGeoPoint`, `LocationCity`, `LocationZip`) with one Java exception sentence (`Cannot invoke "…Piece.getDataType()" …`) that names neither the operator nor the field, so nothing is blamed and the `field_invalid` carries no `invalid` entry. A `RANGE[]` term inside the wrapper (`LocationZip`, `LocationCity`, `LocationGeoPoint`) has drawn both answers to the same request: that sentence, and a body that names no cause and only repeats the expression as sent. Both read as `field_invalid` (#208): a repeat-only body whose expression holds `SEARCH[Location]` is read as the location-operator refusal, because upstream answers the same expression with that sentence at other times. A repeat-only body with no `SEARCH[Location]` in its expression stays `query_parse_error`. The reading takes the sentence whichever operator draws it. Its message says the wrapper evaluates no `DISTANCE[]` or `RANGE[]` term on any site field, so the term goes beside the wrapper joined with `AND`: a radius as `AREA[LocationGeoPoint]DISTANCE[lat,lon,radius] AND SEARCH[Location](…)`, or as `geoFilter` or `location.near`. When the term inside the wrapper is a `RANGE[]`, the message adds that beside the wrapper `RANGE[]` takes date, numeric, and age fields, which no site field is but the count `NumLocationContacts`, and offers the other lever: match the site field by value, OR-joined inside the wrapper, as in `SEARCH[Location](AREA[LocationZip]98101 OR AREA[LocationZip]98102)`. Beside the wrapper the radius matches what `geoFilter` matches, but it and the wrapper's terms can match different sites of one study (breast cancer within 25 mi of Seattle with `SEARCH[Location](AREA[LocationStatus]RECRUITING)` beside it: 83 studies, against 699 for the radius alone, and in 9 of the 83 the site in range is not recruiting), so the hint sends the caller to `clinicaltrials_get_study_record` with `nearLocation` for each in-range site's own status. The case is recognized from upstream's exact sentence after the request, as #183 and #187 are, not by scanning the wrapper's scope before it: a pre-scan would restate upstream's grammar and could refuse a call upstream answers, and upstream stays the judge. After the sentence, one scan of the parameters as sent (skipping double-quoted literals; `RANGE[` at parenthesis depth 1 or more inside `SEARCH[Location](`) only words the message. A repeat-only body always takes the `RANGE[]` wording, a wrapper with no parenthesis included, since a `DISTANCE[]` term inside the wrapper draws the sentence instead. The sentence is read whole, never as generic exception text, since a `DISTANCE[]` with no radius outside the wrapper answers with a different exception, and a study-level field inside the wrapper is still `` `X` is outside Location scope ``. The fifth place is `DISTANCE is not supported for <type> field <path>`, `DISTANCE[]` on any field but `LocationGeoPoint` (`LocationCity`, `EnrollmentCount`): the piece is read from the path map as for RANGE and named in `invalid`, and the message and hint say `DISTANCE[]` takes `LocationGeoPoint` only. The messages and hints for the fourth and fifth places, and for a bare `DISTANCE[]`, name the three places a radius goes, each with the tool that has it, since a hint reaches every tool and each takes a radius its own way: the `advancedFilter` of `clinicaltrials_search_studies` or `clinicaltrials_get_study_count`, `geoFilter` on `clinicaltrials_search_studies`, and `location.near` on `clinicaltrials_find_eligible`, which takes neither an `advancedFilter` nor a `geoFilter`. A `DISTANCE[]` operand upstream cannot read is not one of these places: a latitude or longitude that is not a number or is out of range, a radius under 1, past 500 mi or 805 km, or with no `mi` or `km` unit, or no radius at all stays `query_parse_error`, with its own message and an explicit hint (`DISTANCE[lat,lon,radius]`, latitude -90 to 90, longitude -180 to 180, a radius of 1 to 500 mi or 1 to 805 km, written with its unit, as in `25mi` or `40km`) in place of the declared bracket-and-free-text one. A radius past the ceiling is the caller's to move: `geoFilter` and `location.near` take a larger one, so that hint names them. Every other body stays `query_parse_error` with its upstream sentence kept: `Search scope must be …` and `Cannot parse number for … field` (a bad bound, not a bad field). The enum rejection `Allowed values for enum field <path>` resolves its piece through the same path map, falling back to the path, and every expression or value a message or hint quotes for the caller to send back rides the throw's `literals`, so `content[]` renders it as a code span instead of Markdown-escaped brackets.

`sort` runs the same fold over its field names with the same two reads, except that the search areas are left out: upstream sorts on an index-only piece (`numlocations:desc` → `NumLocations:desc`) and refuses a search area (`Unknown sort field`), so a search area is never folded or suggested for `sort`.

Upstream sorts only date and numeric pieces — a metadata `type`, `[]` stripped, of `NormalizedDate`, `PartialDate`, `DateTimeMinutes`, `integer`, `long`, or the index-only `short` — and answers every other type `Unsupported sort field type: <type>` (#184). The metadata carries no sortable flag, so `isSortable` in `field-search.ts` holds that list, and it only narrows suggestions: normalization still never rejects a sort (#107), because a type list drifts and upstream stays the judge. Both rejection branches draw their did-you-mean from the sortable record and index-only pieces, so following a suggestion never meets the type refusal in turn (`conditionsearch` gets none, `Enrolment` gets `EnrollmentCount`, `StartDateStruct` leads with `StartDate`), and both add the date-or-numeric and `@relevance` guidance. Relevance is spelled `@relevance` upstream: a bare `relevance` answers `Unknown sort field` and `@Relevance` answers `incorrect format`, and no piece, index-only piece, or search area is named relevance in any case, so `rewriteRelevance` sends every other spelling as `@relevance`, direction lowercased, in the same `Sort field auto-corrected` notice as the fold. It reads no metadata, so it also runs with the field index unavailable or local validation off, and it runs before the `nctIds` fit because it lengthens the request (`@` encodes as `%40`).

`fetchJson` maps a 404 (and a 400 `incorrect format`) to `study_not_found` only on a single-study request, where the caller named the study. On every other endpoint, including the two second-tier reads, the upstream body surfaces as it came, so a failed reference read is never blamed on a study no one named.

### No wrapper for every endpoint

Metadata, search-areas, enums, stats/size, stats/field/sizes are excluded as tools. They're reference data for developers building queries, not LLM workflow operations. If agents need dynamic field discovery, `metadata` could become a resource later. The service still reads `/studies/metadata` (the field index) and, for the case-correction second tier, `/studies/metadata?includeIndexedOnly=true` and `/studies/search-areas` internally; none is exposed.

---

## Known Limitations

| Limitation                          | Impact                                                                               | Mitigation                                                                                               |
| :---------------------------------- | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| Rate limit ~1 req/sec               | Multi-page fetches are slow                                                          | Use `fields` to reduce payloads, `pageSize=1&fields=NCTId` for counts, avoid unnecessary pagination                |
| `countTotal` first page only        | Can't get count on subsequent pages                                                  | Always request count on first call                                                                       |
| No auth / no write API              | Can't bookmark, save, or modify studies                                              | Read-only by design                                                                                      |
| Geographic filter requires lat/lon  | Users think in city names, not coordinates                                           | `find_eligible` takes a place name (`query.locn`) or, with the patient's coordinates, `location.near` for sites within a radius; nothing geocodes, so the caller looks the coordinates up. `geoFilter` on `search_studies` is the radius for the raw cohort |
| `pageToken` tied to data version    | Tokens may expire on data refresh (~daily)                                           | Malformed, expired, or altered tokens fail as `page_token_invalid`; the recovery hint restarts from page 1 |
| Full study payloads ~70KB           | Context window pressure                                                              | `fields` parameter is strongly recommended in tool descriptions                                          |
| Age RANGE skips open-ended studies  | `AREA[MaximumAge]RANGE[65 years, MAX]` matches only studies that publish a maximum age; ages compare across units (`24 months` matches what `2 years` does) | `find_eligible` ORs each bound with `AREA[…]MISSING`; the `clinicaltrialsgov-guide` skill documents that pattern and `StdAge` |

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
- [x] `getMetadata(indexedOnly)` method — `GET /studies/metadata`
- [ ] Retry logic — `withRetry`, retryable status codes (408, 429, 500, 502, 503, 504), exponential backoff, 1s base delay, inside the call's 50 s budget
- [ ] Request timeout — `CT_REQUEST_TIMEOUT_MS` (30 s) per attempt, armed with `setTimeout`
- [ ] Rate limit awareness — minimum inter-request delay
- [ ] Response check — a 200 body that is HTML, not JSON, or the wrong shape for its route is transient
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
- [ ] Handler: call service `countStudies` with the query and filters
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
- [ ] Output schema: `results[]` (with `resultPublications` on a study without posted results), `studiesWithoutResults`, `fetchErrors`
- [ ] Handler: concurrent fetch via service, extract resultsSection, reshape
- [ ] Partial success: IDs with no study in `fetchErrors`, even when no ID names a study; any other failure (an outage, a rate limit, the call budget, a cancellation) ends the call
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
