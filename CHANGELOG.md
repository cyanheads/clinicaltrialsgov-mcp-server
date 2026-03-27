# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-03-27

Ground-up rewrite on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core). The custom MCP implementation (~64K lines — DI container, transport layer, storage providers, telemetry, and utility libraries) has been replaced by the framework. What remains is a focused ClinicalTrials.gov API client with a clean MCP surface.

### Breaking Changes

- **Tool surface redesigned.** 7 tools consolidated to 8. `clinicaltrials_analyze_trends` and `clinicaltrials_compare_studies` removed — LLMs compose these from the search and count primitives. Three new discovery and matching tools added.
- **Entry point rewritten.** `src/index.ts` is now a single `createApp()` call. The framework handles transport (stdio + HTTP), lifecycle, logging, and error formatting.
- **All definitions use new builders.** `tool()`, `resource()`, and `prompt()` with Zod input/output schemas, `format()` functions, and MCP annotations.
- **Dependencies gutted.** ~40 direct dependencies replaced by `@cyanheads/mcp-ts-core`. Removed `hono`, `jose`, `dotenv`, `@modelcontextprotocol/sdk`, `prettier`, and others. Added `@biomejs/biome` for formatting/linting.

### Tools

| Tool | Status | Notes |
|:-----|:-------|:------|
| `clinicaltrials_search_studies` | Rewritten | Accepts all 14 ClinicalTrials.gov statuses. Status/phase/nctIds accept `string \| string[]`. Phase filtering uses `AREA[Phase]` syntax. Returns contextual `noMatchHints` when results are empty. |
| `clinicaltrials_get_study` | **New** | Single study lookup by NCT ID. Tool equivalent of the `clinicaltrials://{nctId}` resource for clients that don't support MCP resources. |
| `clinicaltrials_get_study_results` | Rewritten | Partial-success pattern — returns results, `studiesWithoutResults`, and `fetchErrors` per study. Max 5 NCT IDs per call. |
| `clinicaltrials_get_field_values` | Rewritten | Invalid field names now return a validation error with guidance instead of a generic 404. |
| `clinicaltrials_get_study_count` | **New** | Count-only queries for fast statistics without fetching study data. |
| `clinicaltrials_get_enums` | **New** | Get canonical enum type definitions and values from the data model. Complements `get_field_values` (frequency stats) with the exhaustive allowed-value set. |
| `clinicaltrials_get_field_definitions` | **New** | Browse the study data model field tree — piece names, types, nesting. Supports subtree navigation via dot-notation `path` and keyword `search`. |
| `clinicaltrials_find_eligible` | **New** | Patient-to-trial matching with age/sex/location filtering and geographic proximity scoring. Replaces `clinicaltrials_find_eligible_studies`. |

### Resources & Prompts

- **`clinicaltrials://{nctId}`** — single study lookup by NCT ID.
- **`analyze_trial_landscape`** — guided 6-step workflow for systematic trial landscape analysis.

### Service Layer

- **`ClinicalTrialsService`** — new API client with retry (3 attempts, exponential backoff), rate limiting (1 req/sec), request timeout via `AbortSignal`, HTML error detection, and structured error factories. Methods: `searchStudies`, `getStudy`, `getFieldValues`, `getEnums`, `getMetadata`.
- **Server config** — lazy-parsed Zod schema for `CT_*` env vars (`CT_API_BASE_URL`, `CT_REQUEST_TIMEOUT_MS`, `CT_MAX_PAGE_SIZE`, `CT_MAX_ELIGIBLE_CANDIDATES`).

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
