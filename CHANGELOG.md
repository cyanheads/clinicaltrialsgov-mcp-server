# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-03-26

Ground-up rewrite on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core). The custom MCP implementation (~64K lines — DI container, transport layer, storage providers, telemetry, and utility libraries) has been replaced by the framework. What remains is a focused ClinicalTrials.gov API client with a clean MCP surface.

### Breaking Changes

- **Tool surface redesigned.** 7 tools consolidated to 5. `clinicaltrials_get_study` replaced by the `clinicaltrials://{nctId}` resource. `clinicaltrials_analyze_trends` and `clinicaltrials_compare_studies` removed — LLMs compose these from the search and count primitives.
- **Entry point rewritten.** `src/index.ts` is now a single `createApp()` call. The framework handles transport (stdio + HTTP), lifecycle, logging, and error formatting.
- **All definitions use new builders.** `tool()`, `resource()`, and `prompt()` with Zod input/output schemas, `format()` functions, and MCP annotations.
- **Dependencies gutted.** ~40 direct dependencies replaced by `@cyanheads/mcp-ts-core`. Removed `hono`, `jose`, `dotenv`, `@modelcontextprotocol/sdk`, `prettier`, and others. Added `@biomejs/biome` for formatting/linting.

### Tools

| Tool | Status | Notes |
|:-----|:-------|:------|
| `clinicaltrials_search_studies` | Rewritten | Accepts all 14 ClinicalTrials.gov statuses. Status/phase/nctIds accept `string \| string[]`. Phase filtering uses `AREA[Phase]` syntax. |
| `clinicaltrials_get_study_results` | Rewritten | Partial-success pattern — returns results, `studiesWithoutResults`, and `fetchErrors` per study. Max 5 NCT IDs per call. |
| `clinicaltrials_get_field_values` | Rewritten | Invalid field names now return a validation error with guidance instead of a generic 404. |
| `clinicaltrials_get_study_count` | **New** | Count-only queries for fast statistics without fetching study data. |
| `clinicaltrials_find_eligible` | **New** | Patient-to-trial matching with age/sex/location filtering and geographic proximity scoring. Replaces `clinicaltrials_find_eligible_studies`. |

### Resources & Prompts

- **`clinicaltrials://{nctId}`** — single study lookup by NCT ID.
- **`analyze_trial_landscape`** — guided 6-step workflow for systematic trial landscape analysis.

### Service Layer

- **`ClinicalTrialsService`** — new API client with retry (3 attempts, exponential backoff), rate limiting (1 req/sec), request timeout via `AbortSignal`, HTML error detection, and structured error factories.
- **Server config** — lazy-parsed Zod schema for `CT_*` env vars (`CT_API_BASE_URL`, `CT_REQUEST_TIMEOUT_MS`, `CT_MAX_PAGE_SIZE`, `CT_MAX_ELIGIBLE_CANDIDATES`).

### Improvements

- **Empty-result feedback.** `search_studies` and `get_study_count` echo search criteria back when results are empty, with guidance to broaden the query.
- **NCT ID validation.** `search_studies` validates nctIds against `NCTxxxxxxxx` format at the schema level. Service layer returns a specific validation error for malformed IDs.
- **CodeQL workflow.** Added `.github/workflows/codeql.yml` for automated security analysis on push, PR, and weekly schedule.

### Project

- Biome replaces ESLint + Prettier for formatting and linting.
- TypeScript 6.0 strict mode with `exactOptionalPropertyTypes` and `@/` path alias.
- Bun bundler (`scripts/build.ts`) and MCP definition linter (`scripts/lint-mcp.ts`).
- `server.json` rewritten to MCP registry schema with stdio/HTTP transport entries.
- Design doc (`docs/design.md`) and API reference (`docs/api-reference.md`).
- Bug report and feature request issue templates.
- Previous v1.x changelog archived to `changelogs/archive1.md`.
