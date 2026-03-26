# ClinicalTrials.gov MCP Server — Design

## MCP Surface

### Tools

| Name                               | Description                                                                                                                                                       | Key Inputs                                                                                                                                                                               | Annotations                                       |
| :--------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| `clinicaltrials_search_studies`    | Search for clinical trial studies using queries, filters, pagination, and field selection.                                                                        | `query`, `conditionQuery`, `interventionQuery`, `locationQuery`, `sponsorQuery`, `statusFilter`, `phaseFilter`, `advancedFilter`, `geoFilter`, `sort`, `fields`, `pageSize`, `pageToken` | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_results` | Extract outcomes, adverse events, participant flow, and baseline characteristics for completed studies with results.                                              | `nctIds`, `sections`                                                                                                                                                                     | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_field_values`  | Discover valid values for any ClinicalTrials.gov field with study counts per value. Use before constructing searches to find valid filter options.                | `fields`                                                                                                                                                                                 | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_get_study_count`   | Get total study count matching a query without fetching study data. Use for quick stats and building breakdowns by calling multiple times with different filters. | `query`, `conditionQuery`, `interventionQuery`, `statusFilter`, `phaseFilter`, `advancedFilter`                                                                                          | `readOnlyHint`, `idempotentHint`, `openWorldHint` |
| `clinicaltrials_find_eligible`     | Match patient demographics to recruiting clinical trials. Takes a patient profile and returns ranked eligible studies with match explanations.                    | `age`, `sex`, `conditions`, `location`, `recruitingOnly`, `maxResults`                                                                                                                   | `readOnlyHint`, `idempotentHint`, `openWorldHint` |

### Resources

| URI Template               | Description                                                       | Pagination |
| :------------------------- | :---------------------------------------------------------------- | :--------- |
| `clinicaltrials://{nctId}` | Fetch a single clinical study by NCT ID. Returns full study data. | No         |

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
selection. Use the fields parameter to reduce payload size — full study records are ~70KB each.
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
| `geoFilter`         | `string?`             | Geographic proximity filter. Format: `distance(lat,lon,radius)` where radius is e.g. `50mi` or `100km`. Example: `distance(47.6062,-122.3321,50mi)` for studies within 50 miles of Seattle.                                                                                                             |
| `nctIds`            | `string \| string[]?` | Filter to specific NCT IDs. Use for batch lookups of known studies.                                                                                                                                                                                                                                     |
| `fields`            | `string[]?`           | Specific fields to return (PascalCase piece names). **Strongly recommended** — without this, full ~70KB study records are returned. Common fields: `NCTId`, `BriefTitle`, `OverallStatus`, `Phase`, `LeadSponsorName`, `Condition`, `InterventionName`, `BriefSummary`, `EnrollmentCount`, `StartDate`. |
| `sort`              | `string?`             | Sort order. Format: `FieldName:asc` or `FieldName:desc`. E.g., `LastUpdatePostDate:desc`, `EnrollmentCount:desc`. Default: relevance when query params present. Max 2 sort fields comma-separated.                                                                                                      |
| `pageSize`          | `number?`             | Results per page, 1–1000. Default: 10.                                                                                                                                                                                                                                                                  |
| `pageToken`         | `string?`             | Pagination cursor from a previous response's `nextPageToken`.                                                                                                                                                                                                                                           |
| `countTotal`        | `boolean?`            | Include total study count in response. Only computed on the first page. Default: true.                                                                                                                                                                                                                  |

**Output schema:**

| Field           | Type      | Description                                                               |
| :-------------- | :-------- | :------------------------------------------------------------------------ |
| `studies`       | `Study[]` | Array of matching studies (shape depends on `fields` selection).          |
| `totalCount`    | `number?` | Total matching studies (present when `countTotal=true`, first page only). |
| `nextPageToken` | `string?` | Token for the next page. Absent on last page.                             |

**Error messages:**

- Invalid filter syntax: `"Invalid advancedFilter expression. AREA[] syntax: AREA[FieldName]value. Combine with AND/OR/NOT. Check field names via get_field_values."`
- No results: returns empty studies array with `totalCount: 0`, not an error.

**Format function:** Summary line (`Found N studies of M total`), then top 5 studies as bullet list (NCT ID, title, status), pagination note if more pages.

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
| `nctIds`   | `string \| string[]`  | One or more NCT IDs (max 5). E.g., `"NCT12345678"` or `["NCT12345678", "NCT87654321"]`.                                     |
| `sections` | `string \| string[]?` | Filter which sections to return. Values: `outcomes`, `adverseEvents`, `participantFlow`, `baseline`. Omit for all sections. |

**Output schema:**

| Field                   | Type                | Description                                                                                            |
| :---------------------- | :------------------ | :----------------------------------------------------------------------------------------------------- |
| `results`               | `StudyResults[]`    | Extracted results per study. Each contains `nctId`, `title`, `hasResults`, and the requested sections. |
| `studiesWithoutResults` | `string[]?`         | NCT IDs of studies that don't have results available.                                                  |
| `fetchErrors`           | `{nctId, error}[]?` | NCT IDs that failed to fetch with error details.                                                       |

**Partial success semantics:** Studies are fetched concurrently. Individual failures are reported in `fetchErrors` without failing the entire request. Only throws if ALL studies fail.

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

| Field        | Type          | Description                                                                                             |
| :----------- | :------------ | :------------------------------------------------------------------------------------------------------ |
| `fieldStats` | `FieldStat[]` | Per-field stats. Each: `{ field, piece, type, uniqueValuesCount, topValues: {value, studiesCount}[] }`. |

**Format function:** List each field with its values and counts, sorted by frequency descending.

---

### 4. `clinicaltrials_get_study_count`

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
| `sponsorQuery`      | `string?`             | Sponsor search.                    |
| `statusFilter`      | `string \| string[]?` | Filter by study status.            |
| `phaseFilter`       | `string \| string[]?` | Filter by phase.                   |
| `advancedFilter`    | `string?`             | Advanced AREA[] filter expression. |

**Output schema:**

| Field        | Type     | Description                               |
| :----------- | :------- | :---------------------------------------- |
| `totalCount` | `number` | Total studies matching the query/filters. |

**Format function:** Single line: `"N studies match the specified criteria."`

---

### 5. `clinicaltrials_find_eligible`

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
| `sex`            | `enum`     | Biological sex: `Female`, `Male`, `All`.                                      |
| `conditions`     | `string[]` | Medical conditions or diagnoses. E.g., `["Type 2 Diabetes", "Hypertension"]`. |
| `location`       | `object`   | Patient location: `{ country: string, state?: string, city?: string }`.       |
| `recruitingOnly` | `boolean?` | Only include actively recruiting studies. Default: `true`.                    |
| `maxResults`     | `number?`  | Maximum results to return, 1–50. Default: `10`.                               |

**Output schema:**

| Field             | Type              | Description                                                                                                                                                                                                                                                 |
| :---------------- | :---------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eligibleStudies` | `EligibleStudy[]` | Matching studies with: `nctId`, `title`, `briefSummary`, `matchReasons[]`, `eligibility` (age range, sex, healthy volunteers), `locations[]` (facilities in patient's country/region), `contact` info, `studyDetails` (phase, status, enrollment, sponsor). |
| `totalMatches`    | `number`          | Total eligible studies found (before `maxResults` cap).                                                                                                                                                                                                     |
| `searchCriteria`  | `object`          | Echo of the search criteria used (conditions, location, demographics).                                                                                                                                                                                      |

**Handler logic (simplified from old server):**

1. Build condition query from `conditions` (quote multi-word terms, join with `OR`)
2. Build status filter (`RECRUITING`, `NOT_YET_RECRUITING` if `recruitingOnly`)
3. Build location query from `location`
4. Build advanced filter for age: `AREA[MinimumAge]RANGE[MIN, {age} years] AND AREA[MaximumAge]RANGE[{age} years, MAX]`
5. Build sex filter: skip if `All`, otherwise `AREA[Sex]ALL OR AREA[Sex]{sex}`
6. Search with `pageSize=100` (evaluation pool)
7. Post-filter: verify age range, sex, country match from study data
8. Sort by location proximity (city > state > country match)
9. Return top `maxResults`

**Dropped from old server:** Complex condition relevance scoring, healthy volunteer matching, detailed criteria snippet extraction. The post-filter catches the important cases; the LLM can evaluate nuanced eligibility from the returned study data.

---

## Resource Designs

### `clinicaltrials://{nctId}`

Single study by NCT ID. Wraps `GET /studies/{nctId}`. Returns full study data as JSON.

**URI examples:**

- `clinicaltrials://NCT03722472`
- `clinicaltrials://NCT04852770`

**Handler:** Fetch study, return full JSON. Throws `notFound` for 404, `serviceUnavailable` for API errors.

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
| `CT_MAX_ELIGIBLE_CANDIDATES` | No       | `100`                               | Max studies to evaluate in find_eligible                                     |

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

Each step is independently testable via `dev:stdio`.

---

## Domain Mapping

| Noun         | Operations           | API Endpoint                                    | MCP Primitive                        |
| :----------- | :------------------- | :---------------------------------------------- | :----------------------------------- |
| Study        | search/list          | `GET /studies`                                  | Tool: `search_studies`               |
| Study        | get by ID            | `GET /studies/{nctId}`                          | Resource: `clinicaltrials://{nctId}` |
| Study        | get results          | `GET /studies/{nctId}` (extract resultsSection) | Tool: `get_study_results`            |
| Study        | count                | `GET /studies?countTotal=true&pageSize=0`       | Tool: `get_study_count`              |
| Field Values | list values          | `GET /stats/field/values`                       | Tool: `get_field_values`             |
| Patient      | find eligible trials | `GET /studies` (composite query)                | Tool: `find_eligible`                |
| Analysis     | landscape analysis   | Multi-call orchestration                        | Prompt: `analyze_trial_landscape`    |

### Excluded

| Operation                   | Reason                                                                                                                                                         |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /studies/metadata`     | Internal reference — field tree. Not useful as an LLM-facing tool. Could be a resource in a future version if agents need to discover field names dynamically. |
| `GET /studies/search-areas` | Internal reference — search area weights.                                                                                                                      |
| `GET /studies/enums`        | Subsumed by `get_field_values` which provides the same info with study counts.                                                                                 |
| `GET /stats/size`           | JSON payload size distribution — operational/devops concern, not useful for LLM workflows.                                                                     |
| `GET /stats/field/sizes`    | Array cardinality stats — not useful for LLM workflows.                                                                                                        |
| `GET /version`              | API version. Could be a resource, but low value.                                                                                                               |
| Compare studies             | Dropped — LLM can fetch via resource and compare natively.                                                                                                     |
| Analyze trends (heavy)      | Replaced by `get_study_count` + `analyze_trial_landscape` prompt.                                                                                              |

---

## Workflow Analysis

### "Find trials for my condition"

1. `search_studies(conditionQuery="lung cancer", statusFilter="RECRUITING", fields=[...], pageSize=20, countTotal=true)`
2. Agent presents results, suggests refinements

### "Am I eligible for any trials?"

1. `find_eligible(age=45, sex="Female", conditions=["breast cancer"], location={country:"United States", state:"Washington"})`
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

### "Get me full details on NCT03722472"

1. Read resource `clinicaltrials://NCT03722472`
2. Agent has full study context

---

## Design Decisions

### Resource vs. tool for single study

Single study by NCT ID is a **resource** — it's addressable by stable URI, read-only, parameterless beyond the ID. This lets clients inject study data as context without a tool call. Batch multi-study is handled by `search_studies` with `nctIds` filter.

### Count tool replaces trend analysis

The old `analyze_trends` fetched up to 5,000 studies and aggregated locally. Problems: slow (multiple paginated calls with rate-limit delays), rate-limit risky, large code surface. The replacement: `get_study_count` (single fast API call, returns just a number) + `analyze_trial_landscape` prompt (teaches the LLM to orchestrate). Same capability, composable, fast, minimal code.

### Search tool parameter richness

The search tool exposes 14 parameters — intentionally rich. Search is the primary workflow and the API's query surface is the server's key value. Each parameter maps directly to an API parameter with clear descriptions. The LLM picks what it needs; unused params are optional.

### Simplified find_eligible

Dropped from the old server: complex condition relevance scoring (token overlap), healthy volunteer matching, criteria snippet extraction, multi-tier proximity ranking. Kept: demographic AREA[] filter construction, basic post-filtering, location sorting. The LLM can evaluate nuanced eligibility from the returned study data — the tool's job is query construction, not clinical judgment.

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
- [ ] Retry logic — retryable status codes (429, 5xx), exponential backoff, 1s base delay
- [ ] Request timeout — 30s via AbortSignal
- [ ] Rate limit awareness — minimum inter-request delay
- [ ] HTML error page detection — classify as transient
- [ ] Filter param normalization — arrays to pipe-delimited strings

### Resource: `clinicaltrials://{nctId}`

- [ ] `src/mcp-server/resources/definitions/study.resource.ts`
- [ ] Params: `nctId` with NCT ID regex validation
- [ ] Handler: fetch via service, return full study JSON
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

### Tool: `clinicaltrials_get_study_results`

- [ ] `src/mcp-server/tools/definitions/get-study-results.tool.ts`
- [ ] Input schema: `nctIds` (1-5), `sections` filter
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
- [ ] Smoke test with `dev:stdio`
