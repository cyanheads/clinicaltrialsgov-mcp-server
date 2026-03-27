# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-03-26

### Breaking Changes

- **Complete framework migration**: Replaced the custom MCP server implementation with `@cyanheads/mcp-ts-core` v0.2.2. All tool, resource, and prompt definitions use the new `tool()`, `resource()`, and `prompt()` builders with Zod schemas, `format()` functions, and `annotations`.
- **Entry point rewritten**: `src/index.ts` is now a minimal `createApp()` call — the framework handles transport, lifecycle, logging, and error formatting.
- **Tool surface redesigned**: 7 tools consolidated to 5 purpose-built tools. Removed `clinicaltrials_get_study` (use the `clinicaltrials://{nctId}` resource), `clinicaltrials_analyze_trends` and `clinicaltrials_compare_studies` (LLMs can compose these from search + count tools).

### Added

- **`@cyanheads/mcp-ts-core` framework**: Declarative MCP server with built-in transport (stdio + HTTP), structured logging, error classification, request context, and schema validation.
- **`clinicaltrials_find_eligible` tool**: Patient-to-trial matching with age/sex/location filtering, geographic proximity scoring, and post-filter verification. Replaces and improves `clinicaltrials_find_eligible_studies`.
- **`clinicaltrials_get_study_count` tool**: Lightweight count-only queries (pageSize=0, countTotal=true) for fast statistics and breakdowns.
- **`clinicaltrials://{nctId}` resource**: Single study lookup as an MCP resource with NCT ID regex validation.
- **`analyze_trial_landscape` prompt**: 6-step guided workflow for systematic trial landscape analysis using count + search tools.
- **`ClinicalTrialsService`**: New API client with retry (3 attempts, exponential backoff), rate limiting (1 req/sec), timeout via `AbortSignal.any()`, HTML error detection, and structured error factories.
- **Server config**: `src/config/server-config.ts` with lazy-parsed Zod schema for CT\_\* env vars.
- **Design docs**: `docs/design.md` (MCP surface design, 45-item checklist) and `docs/api-reference.md` (complete v2 API reference).
- **Skills**: 20 modular skill definitions for scaffolding, testing, debugging, and maintenance workflows.
- **Build tooling**: `scripts/build.ts` (Bun bundler), `scripts/lint-mcp.ts` (definition linter), `devcheck.config.json`.
- **GitHub templates**: Bug report and feature request issue templates.
- **Changelog archive**: Previous v1.x changelog entries archived to `changelogs/archive1.md`.

### Changed

- **`clinicaltrials_search_studies`**: Rewritten with `tool()` builder. Status/phase/nctIds accept `string | string[]`. Phase filtering translates to `AREA[Phase]` syntax via `buildAdvancedFilter()`. All 16 input fields have `.describe()`. Status filter expanded to all 14 valid ClinicalTrials.gov statuses. `pageSize` minimum corrected from 0 to 1.
- **`clinicaltrials_get_study_results`**: Rewritten with partial-success pattern (`Promise.all` with per-study catch). Returns `studiesWithoutResults` and `fetchErrors` arrays. Max 5 NCT IDs. Removed unnecessary type assertions on outcomes array.
- **`clinicaltrials_get_field_values`**: Simplified wrapper around the service method with proper Zod output schema. Invalid field names now return a validation error with guidance instead of a generic 404.
- **Query helpers**: Extracted shared `toArray` and `buildAdvancedFilter` helpers to `src/mcp-server/tools/utils/query-helpers.ts`, removing duplication between `search-studies` and `get-study-count`.
- **Descriptions**: Converted all tool, resource, and prompt descriptions from `+` string concatenation to template literals.
- **Dockerfile**: Updated labels, log directory, and image metadata for the new server name.
- **tsconfig.json**: Strict mode with `exactOptionalPropertyTypes`, `@/` path alias, ESNext target.
- **server.json**: Rewritten to MCP registry schema with stdio and HTTP transport entries, CT\_\* env vars, and runtime hints.
- **Code style**: Biome formatting applied across the codebase (single quotes, consistent import ordering, formatting).
- **Dependencies**: Removed ~15 unused direct dependencies (`hono`, `jose`, `dotenv`, `@modelcontextprotocol/sdk`, `prettier`, etc.); added `@biomejs/biome` as dev dependency. Upgraded TypeScript to 6.0, OpenTelemetry packages to 0.214.0.

### Removed

- **Old architecture** (~64K lines): Container/DI system, custom transport layer (HTTP/stdio/auth), storage providers (filesystem, Cloudflare D1/KV/R2, Supabase, in-memory), utility libraries (formatting, parsing, security, telemetry, metrics, scheduling, network), error handler, logger, performance monitoring, request context, worker entry point.
- **Old tools**: `clinicaltrials_get_study`, `clinicaltrials_analyze_trends`, `clinicaltrials_compare_studies`, `clinicaltrials_find_eligible_studies` (all replaced by redesigned equivalents or composed from primitives).
- **Old tests** (~200 test files) and placeholder echo test stubs from initial scaffold.
- **Old config**: eslint, prettier, husky, bunfig.toml, smithery.yaml, wrangler.toml, mcp.json, repomix.config.json, typedoc.json, tsdoc.json, multiple tsconfig variants.
- **Old dependencies**: ~40 direct runtime/dev dependencies replaced by single `@cyanheads/mcp-ts-core` framework dependency.
- **Old README.md**: Deleted and replaced with new version reflecting the v2.0.0 architecture.
- **Old LICENSE**: Replaced with fresh Apache-2.0 license file.
- **Examples**: Removed old example markdown files.
