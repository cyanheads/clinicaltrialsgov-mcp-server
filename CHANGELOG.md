# Changelog

All notable changes to this project will be documented in this file.

## [2.0.3] - 2026-03-28

### Changed

- **`clinicaltrials_get_field_values`** — Added BOOLEAN field support: output schema now includes `trueCount` and `falseCount` fields; `uniqueValuesCount` and `topValues` are optional (present for ENUM/STRING fields only). Added `missingStudiesCount` to report studies where the field is absent. `format` updated to render true/false counts for boolean fields and missing-study count when non-zero.
- **`clinicaltrials_get_study_results`** — Added NCT ID format validation (`/^NCT\d{8}$/`) to the `nctIds` input (both single and array variants). Array variant now enforces `min(1)`/`max(20)`. Input description updated to reflect the 20-ID cap. `sections` input changed from `z.string()` to `z.enum(VALID_SECTIONS)` for compile-time type safety.

### Chores

- **`devcheck.config.json`** — Added `pino` to the security audit ignore list.

## [2.0.2] - 2026-03-28

### Changed

- **`clinicaltrials_get_study_results`** — Replaced N individual `/studies/{nctId}` requests with a single `GET /studies?filter.ids=...` batch request. All NCT IDs are fetched in one API call regardless of batch size, eliminating the serial-request bottleneck and rate-limit accumulation. Missing IDs are detected by cross-referencing the response against the requested IDs and reported in `fetchErrors`.
- **`clinicaltrials_get_study_results`** — Lifted the 5-NCT-ID cap. Input description updated to recommend `summary=true` for large batches to avoid large payloads. README updated accordingly.
- **`ClinicalTrialsService`** — Added `getStudiesBatch(nctIds, ctx)` method using `filter.ids` + `fields=NCTId|BriefTitle|HasResults|ResultsSection`.

### Fixed

- **`clinicaltrials_get_study_results`** — Corrected field name references in `summarizeParticipantFlow` (`flowGroups`→`groups`, `flowPeriods`→`periods`) and `summarizeBaseline` (`baselineGroups`→`groups`, `baselineMeasures`→`measures`) to match the actual ClinicalTrials.gov API response shape.
- **`clinicaltrials_get_study_results`** — Removed `frequencyModule` indirection in `summarizeAdverseEvents` and the format function; `timeFrame` is now read directly from `ae.timeFrame`.
- **`clinicaltrials_get_study_results`** — Extended format fallback chains for participant flow and baseline group/period counts (`numFlowGroups`, `numFlowPeriods`, `numBaselineGroups`) to improve resilience against API field shape variations.

## [2.0.1] - 2026-03-28

### Changed

- **`clinicaltrials_get_study_record`** — Rewrote `format` to produce a full structured markdown report: header, status/design, dates, sponsor, conditions, summary, eligibility (with criteria text), interventions, arms, primary/secondary outcomes, contacts, and locations.
- **`clinicaltrials_get_study_results`** — Rewrote `format` to render structured sections for each study: outcomes with per-group top-line stats (via new `extractTopStats` helper), adverse events with group/event counts, participant flow, and baseline characteristics with measure list.
- **`clinicaltrials_search_studies`** — Enhanced `format` to show all returned studies (removed 5-result cap) with per-study metadata: phase, enrollment count, sponsor, and conditions.
- **`clinicaltrials_find_eligible`** — Enhanced `format` to show all returned studies (removed 5-result cap) with per-study eligibility summary (age range, sex, healthy volunteers), recruiting locations (up to 3), and central contacts. Added `CentralContactName`, `CentralContactPhone`, `CentralContactEMail` to the fetched fields list.
- **`RawStudyShape`** — Expanded type with `armsInterventionsModule`, `outcomesModule`, `statusModule` date structs, `identificationModule` `acronym`/`officialTitle`, `conditionsModule` keywords, `eligibilityModule` `eligibilityCriteria`/`stdAges`, `contactsLocationsModule` `centralContacts`, and `sponsorCollaboratorsModule` `collaborators`.

### Dependencies

- Bumped `@cyanheads/mcp-ts-core` from `^0.2.2` to `^0.2.3`.

## [2.0.0] - 2026-03-27

Ground-up rewrite on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core). The custom MCP implementation (~64K lines — DI container, transport layer, storage providers, telemetry, and utility libraries) has been replaced by the framework. What remains is a focused ClinicalTrials.gov API client with a clean MCP surface.

### Breaking Changes

- **Tool surface redesigned.** 7 tools total, all with breaking changes from v1:
  - **Removed:** `clinicaltrials_analyze_trends`, `clinicaltrials_compare_studies`, `clinicaltrials_find_eligible_studies` — LLMs compose trend and comparison analysis from the search and count primitives.
  - **New:** `clinicaltrials_get_study_count`, `clinicaltrials_get_field_definitions`.
  - **Rewritten:** `clinicaltrials_search_studies`, `clinicaltrials_get_study_record` (batch→single), `clinicaltrials_get_study_results`, `clinicaltrials_get_field_values`, `clinicaltrials_find_eligible_studies`→`clinicaltrials_find_eligible`.
- **Entry point rewritten.** `src/index.ts` is now a single `createApp()` call. The framework handles transport (stdio + HTTP), lifecycle, logging, and error formatting.
- **All definitions use new builders.** `tool()`, `resource()`, and `prompt()` with Zod input/output schemas, `format()` functions, and MCP annotations.
- **Dependencies consolidated.** Removed `hono`, `jose`, `dotenv`, `@modelcontextprotocol/sdk`, `prettier`, and others from this package's direct deps. Added `@biomejs/biome` for formatting/linting.

### Tools

| Tool | Status | Notes |
|:-----|:-------|:------|
| `clinicaltrials_search_studies` | **Rewritten** | Accepts all 14 ClinicalTrials.gov statuses. Status/phase/nctIds accept `string \| string[]`. Phase filtering uses `AREA[Phase]` syntax. Cursor-based pagination (`pageToken`) replaces page-number pagination. `pageSize` capped at 200 (configurable via `CT_MAX_PAGE_SIZE`). Returns contextual `noMatchHints` when results are empty. |
| `clinicaltrials_get_study_record` | **Rewritten** | Redesigned from batch-fetch (up to 5 NCT IDs) to single-study lookup. Returns the full study record including protocol and results sections. Batch protocol lookups migrate to `search_studies` with the `nctIds` filter — use the `fields` param to select only the fields you need. Tool equivalent of the `clinicaltrials://{nctId}` resource for clients that don't support MCP resources. |
| `clinicaltrials_get_study_results` | **Rewritten** | Partial-success pattern — returns results, `studiesWithoutResults`, and `fetchErrors` per study. Max 5 NCT IDs per call. |
| `clinicaltrials_get_field_values` | **Rewritten** | Invalid field names now return a validation error with guidance instead of a generic 404. |
| `clinicaltrials_get_study_count` | **New** | Count-only queries for fast statistics without fetching study data. |
| `clinicaltrials_get_field_definitions` | **New** | Browse the study data model field tree — piece names, types, nesting. Supports subtree navigation via dot-notation `path` and keyword `search`. |
| `clinicaltrials_find_eligible` | **Rewritten** | Replaces `clinicaltrials_find_eligible_studies`. Redesigned from client-side filtering and proximity sorting to an API-query-first approach — builds an optimized query from a patient profile (age, sex, conditions, location) and returns studies with eligibility/location fields for the caller to evaluate. |

### Resources & Prompts

- **`clinicaltrials://{nctId}`** — single study lookup by NCT ID.
- **`analyze_trial_landscape`** — adaptable workflow for data-driven trial landscape analysis using count + search tools.

### Service Layer

- **`ClinicalTrialsService`** — new API client with retry (3 attempts, exponential backoff), rate limiting (1 req/sec), request timeout via `AbortSignal`, HTML error detection, and structured error factories. Methods: `searchStudies`, `getStudy`, `getFieldValues`, `getMetadata`.
- **Server config** — lazy-parsed Zod schema for `CT_*` env vars (`CT_API_BASE_URL`, `CT_REQUEST_TIMEOUT_MS`, `CT_MAX_PAGE_SIZE`).

### Improvements

- **Empty-result feedback.** `search_studies` returns contextual `noMatchHints` based on which query and filter params were used. `get_study_count` echoes search criteria and returns `noMatchHints` on zero-count results. `find_eligible` returns `noMatchHints` with actionable suggestions (broaden conditions, adjust age/sex, widen location, include non-recruiting studies).
- **Better 404 errors.** Service layer extracts the study ID from the request path for clearer error messages (`"Study NCT12345678 not found"` instead of generic `"Not found: /studies/NCT12345678"`).
- **Results summary mode.** `get_study_results` accepts `summary: true` to return condensed metadata (~5KB) instead of full result data (~200KB per study). Summaries include outcome titles, types, timeframes, group/measure counts, and top-level stats.
- **Consistent criteria echo.** `get_study_count` always returns `searchCriteria` when query parameters are present (previously only on zero-count results).
- **NCT ID validation.** `search_studies` validates nctIds against `NCTxxxxxxxx` format at the schema level. Service layer returns a specific validation error for malformed IDs.
- **CodeQL workflow.** Added `.github/workflows/codeql.yml` for automated security analysis on push, PR, and weekly schedule.

### Testing

- Full test suite with 9 test files covering all tools, the resource, the service layer, and shared query helpers.
- Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing` with mocked service layer via `vi.mock`.
- Separate `tsconfig.test.json` for test type checking; `bun run typecheck` now validates both source and test configs.

### Project

- Biome replaces ESLint + Prettier for formatting and linting.
- TypeScript 6.0 strict mode with `exactOptionalPropertyTypes` and `@/` path alias.
- Bun bundler (`scripts/build.ts`) and MCP definition linter (`scripts/lint-mcp.ts`).
- `server.json` rewritten to MCP registry schema with stdio/HTTP transport entries.
- Design doc (`docs/design.md`) and API reference (`docs/api-reference.md`).
- Bug report and feature request issue templates.
- Previous v1.x changelog archived to `changelogs/archive1.md`.
