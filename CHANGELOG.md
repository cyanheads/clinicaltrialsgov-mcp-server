# Changelog

All notable changes to this project will be documented in this file.

## [2.3.1] - 2026-04-21

### Fixed

- **`clinicaltrials_search_studies` and `clinicaltrials_find_eligible` condition rendering** — `format()` rendered only the first 2 (search) or 3 (eligible) conditions from `conditionsModule.conditions` and marked the full path as covered in `SEARCH_RENDERED`/`ELIGIBLE_RENDERED`, so the overflow helper also skipped them. Conditions beyond the slice disappeared from `content[]` with no "+N more" signal. Live reproducer NCT05956821 showed 8 conditions in `structuredContent` but only 2 in `content[]`. Dropped the slice; both tools now render all conditions with `.join(', ')`, matching the style already used in `get_study_record`. Closes #29.

### Chores

- **Test-side type narrowing** — Eliminated 249 pre-existing `tsc` errors in `tests/**/*.test.ts` that surfaced under the framework's strict `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` tsconfig. Narrowed optional framework attributes (`tool.input`, `resource.params`, `prompt.args`) via local `!` bindings; cast `ContentBlock[]` indexed access to a text-shaped type at call sites; added a typed `firstMessage()` helper for the prompt test; switched `makeStudy()` to conditional-spread for `resultsSection`. No runtime semantics changed; `bun run test` remains 262/262 passing.

## [2.3.0] - 2026-04-20

### Fixed

- **`clinicaltrials_get_study_record` rendering** — `format()` previously emitted only a subset of the fields it fetched, so clients reading `content[]` (e.g., Claude Desktop) never saw `detailedDescription`, `otherOutcomes`, collaborators, keywords, secondary IDs, design info (allocation/model/purpose/masking), submission/update dates, oversight flags, IPD sharing, or references. Rewrote `format()` to render every populated field; expanded `RawStudyShape` to type them. Closes #18.
- **Silent object-array truncation in shared formatter** — `collectLeaves` in `format-helpers.ts` hard-capped object arrays at 3 items and emitted a misleading `+N more` sentinel. The outer `maxLines` budget already bounds total output; the per-array cap was redundant and silently dropped data for clients reading `content[]`. Removed the cap. Affects `clinicaltrials_search_studies` and `clinicaltrials_find_eligible`. Closes #19.
- **Retry logic hardening in `ClinicalTrialsService`** — Raised `MAX_RETRIES` from 3 to 6, backoff cap from 8s to 30s, replaced fixed 0–500ms jitter with ±25% proportional jitter, and threw a distinct `McpError(JsonRpcErrorCode.RateLimited)` on 429 exhaustion (previously lumped with 5xx `ServiceUnavailable`). Added a `ClinicalTrialsServiceOptions` constructor parameter for test-friendly overrides. Closes #20.
- **`clinicaltrials_get_study_count` hint coupling** — `format()` now iterates `result.noMatchHints` instead of hardcoding a fallback string, eliminating a latent divergence between `structuredContent` and `content[]`. Closes #21.
- **Duplicated NCT ID regex** — Consolidated the inline `/^NCT\d{8}$/` pattern from six sites into a shared `nctIdSchema` export in `src/mcp-server/tools/utils/_schemas.ts`. Two of the prior sites (`get_study_record` input, `clinicaltrials://{nctId}` resource params) were missing the canonical error message and now return "NCT IDs must match format NCTxxxxxxxx (8 digits)." consistently. Closes #22.
- **`clinicaltrials_get_study_results` batch error handling** — When all submitted NCT IDs were rejected by the API (e.g., with 400 "incorrect format"), `getStudiesBatch` threw out of the handler instead of populating `fetchErrors`. Wrapped the batch call in a try/catch that maps the batch-wide failure into per-ID `fetchErrors` entries, matching the partial-failure response shape. Removed the companion `results.length === 0 && fetchErrors.length > 0` throw so the all-failed path stays graceful too. Closes #23.
- **`FieldValueStats` type/runtime divergence** — Marked `topValues` and `uniqueValuesCount` optional on `FieldValueStats`; the API omits them for BOOLEAN fields (which return `trueCount`/`falseCount` instead), so the prior required-typed signature lied to TS callers. Also added an empty-topValues fallback in `get_field_values` `format()` — it previously emitted no lines when the array was empty, silently hiding the field from the LLM. Closes #25.

### Added

- **`src/mcp-server/tools/utils/_schemas.ts`** — New module exporting shared Zod schemas (starting with `nctIdSchema`).
- **`ClinicalTrialsServiceOptions`** — New exported interface on `ClinicalTrialsService` for overriding retry/backoff behavior (`maxRetries`, `baseBackoffMs`, `maxBackoffMs`). Primarily used by tests.
- **Tests** — Added `tests/mcp-server/tools/utils/format-helpers.test.ts` covering primitive-array flattening, object-array traversal without truncation, `maxLines` budget, `maxValueLen` truncation, and structural path elision. Extended existing tests with regression cases for every fix above.

### Changed

- **`ClinicalTrialsService` constructor signature** — Now accepts an optional second `ClinicalTrialsServiceOptions` parameter. Callers using the one-arg form are unchanged.
- **`get_study_record` `format()` output** — Significantly richer. Header now includes `**Official Title:**` (when distinct from `briefTitle`), `**Org Study ID:**`, `**Organization:**`, `**Secondary IDs:**`. New `**Design:**`, `**Submission:**`, `**Collaborators:**`, `**Keywords:**`, `**Oversight:**` lines in the metadata block. New `## Detailed Description`, `## Other Outcomes`, `## IPD Sharing`, and `## References` sections (each conditional on presence in the study).

### Dependencies

- Upgraded `@cyanheads/mcp-ts-core` from `^0.4.1` to `^0.5.0`. Adopted the new `parseEnvConfig` helper in `src/config/server-config.ts`.

### Chores

- Synced `maintenance` skill (1.2 → 1.3) from the framework package.

## [2.2.0] - 2026-04-20

### Changed

- **`clinicaltrials_search_studies`** — 400 responses matching the upstream "contains invalid field name" pattern are now caught in the service layer and rethrown as a validation error with a module-vs-piece hint and a pointer to `clinicaltrials_get_field_definitions`. Parses the offending field from the upstream body when present so the error calls it out by name. Resolves a UX paper cut where callers (LLMs especially) would pass module names like `StudyDesign` and get only the terse upstream message back. Closes #17.
- **`clinicaltrials_get_field_values`** — Invalid-field-name guidance now also references `clinicaltrials_get_field_definitions` for consistency with `search_studies`.
- **`clinicaltrials_search_studies` `fields` description** — Tightened schema description with explicit piece-vs-module contrast (`DesignPrimaryPurpose` vs `StudyDesign`) and a pointer to `clinicaltrials_get_field_definitions`.

### Dependencies

- Upgraded `@cyanheads/mcp-ts-core` from `^0.3.5` to `^0.4.1`.
- Upgraded `@biomejs/biome` to `^2.4.12`, `@cloudflare/workers-types` to `^4.20260420.1`, `diff` to `^9.0.0`, `typescript` to `^6.0.3`, `vite` to `^8.0.9`.
- Unpinned `@types/validator` (`13.15.10` → `^13.15.10`) and `vite` (`8.0.9` → `^8.0.9`) so future `bun update` can track them. No `resolutions`/`overrides` in the project.
- `bun audit`: 0 vulnerabilities (prior `hono` moderate advisory resolved transitively).

### Chores

- Synced `add-tool` (1.3 → 1.4) and `design-mcp-server` (2.2 → 2.3) skills from framework.

## [2.1.1] - 2026-04-13

### Added

- **`add-app-tool` skill** — New scaffold skill for MCP App tool + UI resource pairs using `appTool()` and `appResource()` builders. Covers template, registration, UI design notes (bundling, CSP, SDK usage), and a full checklist.

### Changed

- **Skills** — Broad update across 13 skills: registration guidance aligned with direct `createApp()` pattern (fresh scaffolds use direct imports in `src/index.ts`); sparse upstream data handling and form-client empty-value defense added to `add-tool`, `add-service`, `add-test`, `api-testing`; `devcheck` expanded with full check suite docs (TODOs, secrets, MCP definition lint, dep/security checks); `field-test` extended with `structuredContent`/`content[]` parity, field projection, annotation review, workflow chaining, and resilience checks; `api-workers` adds `extensions` option; `design-mcp-server` adds App Tool primitive and updated implementation order; `api-testing` adds `notifyResourceListChanged`/`notifyResourceUpdated` mock context options; `maintenance`, `setup`, `polish-docs-meta` updated for `bun run test` command and current patterns. References in `polish-docs-meta` reformatted for readability.
- **`clinicaltrials_find_eligible`** — Description rewritten to surface what callers provide and what the tool returns, without leaking internal implementation details.
- **`clinicaltrials_get_study_record`** — Description rewritten to enumerate record contents (protocol details, eligibility criteria, outcomes, arms, interventions, contacts, locations) instead of referencing the resource URI.
- **`clinicaltrials_get_study_results`** — Description now names the specific prerequisite tool (`clinicaltrials_search_studies`) instead of the generic `search_studies`.

### Dependencies

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.12` to `^0.3.5`. Removed the `resolutions` block (no longer needed).
- Upgraded `@biomejs/biome` to `^2.4.11`, `@cloudflare/workers-types` to `^4.20260413.1`, `@types/bun` to `^1.3.12`, `@types/node` to `^25.6.0`, `@vitest/coverage-istanbul` to `^4.1.4`, `typedoc` to `^0.28.19`, `vite` to `8.0.8`, `vitest` to `^4.1.4`.

## [2.1.0] - 2026-04-04

### Added

- **`format-helpers.ts`** — New shared formatting utility (`formatRemainingStudyFields`) that renders study fields not already covered by a tool's primary formatter. Prevents data loss in format output when the API returns fields beyond the hardcoded set.
- **Tests** — Added `server-config.test.ts` (config defaults, env var parsing, caching), `analyze-trial-landscape.prompt.test.ts` (args validation, generate output, tool references), and `get-field-definitions.tool.test.ts` (comprehensive handler and format coverage).

### Changed

- **`clinicaltrials_find_eligible`** — Format output now includes study metadata (phase, enrollment, sponsor, conditions, interventions, brief summary) and remaining fields via `formatRemainingStudyFields`. Improved `sex` input description.
- **`clinicaltrials_search_studies`** — Format output now renders remaining study fields via `formatRemainingStudyFields`, surfacing data beyond the standard metadata line.
- **`clinicaltrials_get_study_count`** — Improved input descriptions with concrete examples for `conditionQuery`, `interventionQuery`, `sponsorQuery`, and `advancedFilter`.
- **`ClinicalTrialsService`** — `filter.ids` rejection now throws `notFound` with the specific ID list instead of a generic validation error, improving debuggability for batch lookups.
- **Test suite** — Restructured test directory from flat `tests/` to mirror source layout (`tests/config/`, `tests/mcp-server/...`, `tests/services/...`). Expanded all existing test files with comprehensive coverage: input validation edge cases, handler behavior variants, format rendering, error paths, retry logic, HTML response handling, and batch operations. Improved mock pattern using `vi.hoisted()` for cleaner service mocking.

### Dependencies

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.10` to `^0.2.12`.
- Upgraded `@cloudflare/workers-types` from `^4.20260329.1` to `^4.20260404.1`.
- Upgraded `@types/node` from `^25.5.0` to `^25.5.2`.

## [2.0.6] - 2026-03-30

### Changed

- **Skills** — Updated `add-tool` (v1.1), `add-resource` (v1.1), and `design-mcp-server` (v2.1). Added `format()` content-completeness guidance, batch input design patterns, tool-first philosophy (tool surface must be self-sufficient for tool-only clients), expanded error classification with origin-based tables, and resource tool-coverage checklist item.

### Fixed

- **`clinicaltrials_get_study_results`** — Fixed formatting of conditional expression in `formatBaseline` helper.

### Dependencies

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.8` to `^0.2.10`.
- Upgraded `@biomejs/biome` from `^2.4.9` to `^2.4.10`.
- Upgraded `@cloudflare/workers-types` from `^4.20260317.1` to `^4.20260329.1`.

### Chores

- Consolidated `author` and `email` fields in `package.json` into standard npm author format.

## [2.0.5] - 2026-03-28

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.3` to `^0.2.8`.

## [2.0.4] - 2026-03-28

### Changed

- **`clinicaltrials_get_study_results`** — Refactored `format` function: extracted inline formatting into dedicated helpers (`formatOutcomes`, `formatAdverseEvents`, `formatParticipantFlow`, `formatBaseline`). Full-shape results now render richer detail — outcome analyses with p-values and CIs, adverse events with per-group affected/at-risk counts, participant flow milestones and drop/withdraw reasons, and baseline characteristics with per-group measurement values.

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
