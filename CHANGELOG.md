# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2025-10-01

### Alignment with `cyanheads/mcp-ts-template@v2.3.1`

This release represents a comprehensive architectural overhaul to align with the `cyanheads/mcp-ts-template@v2.3.1`. The project has been migrated to a more modern, modular, and extensible structure, designed to support serverless deployments (Cloudflare Workers), enhanced observability (OpenTelemetry), and improved developer experience.

### Added

- **Build System**: Migrated from `npm` and `ts-node` to **Bun** for dependency management, script execution, and bundling.
- **Dependency Injection**: Integrated **`tsyringe`** for Inversion of Control. Core services like configuration, logger, and providers are now managed by a central DI container.
- **Serverless Support**: Added a `src/worker.ts` entry point for deploying the MCP server on **Cloudflare Workers**, including support for bindings (KV, R2, AI).
- **Storage Abstraction**: Introduced a new storage service layer (`src/storage`) with an `IStorageProvider` interface. Implementations include `in-memory`, `filesystem`, and providers for **Cloudflare R2** and **Cloudflare KV**.
- **Observability**: Integrated **OpenTelemetry** for tracing and metrics. Added a `telemetry` utility module and semantic convention constants.
- **Speech Services**: Added a new speech service (`src/services/speech`) with providers for **ElevenLabs (TTS)** and **OpenAI Whisper (STT)**.
- **Declarative Components**: Extended the declarative pattern to all MCP components:
  - **Tools**: `ToolDefinition` with a `toolHandlerFactory`.
  - **Resources**: `ResourceDefinition` with a `resourceHandlerFactory`.
  - **Prompts**: `PromptDefinition` for generating structured LLM inputs.
- **Developer Tooling**:
  - `devcheck.ts`: A script for running lint, type checks, security audits, and more.
  - `devdocs.ts`: A script for generating comprehensive AI-readable context files.
  - `validate-mcp-publish-schema.ts`: A script for validating and publishing the server to the MCP registry.

### Changed

- **Project Structure**: Completely reorganized the `src/` directory into a domain-driven structure (`container`, `services`, `storage`, `utils`, etc.).
- **Error Handling**: `ErrorHandler` is now more robust, integrates with OpenTelemetry, and uses standardized `JsonRpcErrorCode`s.
- **Configuration**: `src/config/index.ts` is now environment-agnostic and loads configuration for all new services.
- **HTTP Transport**: The Hono-based HTTP transport was refactored for better integration with the new DI system and to support serverless environments.
- **Tool & Resource Registration**: All tools and resources are now registered through dedicated `ToolRegistry` and `ResourceRegistry` services, which are resolved from the DI container.

### Removed

- Deleted dozens of legacy files related to the old architecture, including the previous transport managers, old tool registration patterns, and outdated utility files.

## [1.1.11] - 2025-08-06

### Changed

- **Schema Resiliency**: Updated all core Zod schemas in `types.ts` and `logic.ts` to use `.passthrough()`. Trying to fix an error in the Zod schema for Structured responses. This prevents validation errors when the ClinicalTrials.gov API adds new, optional fields to its responses, making the server more robust and resilient to external API changes.
- Updated package version to `1.1.11`.

## [1.1.10] - 2025-08-06

### Changed

- **Schema Resiliency**: Updated core Zod schemas in `logic.ts` and `types.ts` to use `.passthrough()`. This prevents validation errors when the ClinicalTrials.gov API adds new, optional fields to its responses, making the server more robust and resilient to external API changes.
- Updated package version to `1.1.10`.

## [1.1.9] - 2025-08-06

### Fixed

- **Version Synchronization**: Corrected a versioning error where `v1.1.7` was published after `v1.1.8`. Version `1.1.7` has been deprecated, and this version (`1.1.9`) is released to ensure a clear and linear version history.
- Updated package version to `1.1.9`.

## [1.1.8] - 2025-08-06

### Changed

- **Enhanced `searchStudies` Tool**: The summary output for the `searchStudies` tool has been enriched to include additional key details for each study: `Study Type`, `Phases`, `Eligibility` (sex and minimum age), and `Locations` (countries). The locations are now also deduplicated for a cleaner output. This provides a more comprehensive overview of search results at a glance.
- **Expanded `StudySchema`**: The core `StudySchema` in `src/services/clinical-trials-gov/types.ts` has been updated to include the `eligibilityModule`, ensuring that new fields related to participant eligibility are correctly validated and typed.
- Updated package version to `1.1.8`.

## [1.1.7] - 2025-08-06

### Fixed

- **Schema Resiliency**: Updated the core `StudySchema` in `src/services/clinical-trials-gov/types.ts` to use `.passthrough()`. This prevents validation errors when the ClinicalTrials.gov API adds new, optional fields to its responses, making the server more robust and resilient to external API changes.
- Updated package version to `1.1.7`.

## [1.1.6] - 2025-08-06

### Changed

- **Improved Data Integrity**: Refactored core Zod schemas (`StudySchema`, `PagedStudiesSchema`) to enforce stricter data validation by removing `.passthrough()` and defining explicit, optional fields. This enhances type safety and ensures incoming data conforms to the expected structure. Key additions include the `derivedSection` and `hasResults` fields, along with making nested properties optional to gracefully handle sparse API responses.
- **Enhanced Robustness**: Added a validation step in `jsonCleaner.ts` that uses the new strict `StudySchema` to parse study objects. It now logs a warning and strips any unexpected fields, making the data cleaning process more transparent and resilient.
- Updated package version to `1.1.6`.

## [1.1.5] - 2025-08-06

### Changed

- **Refactoring**:
  - Removed the `cleanStudy` utility and updated Zod schemas in `types.ts` to use `.passthrough()`. This simplifies the data processing pipeline by making the schemas more flexible and resilient to unexpected fields from the API.
- **Configuration**:
  - Streamlined the `.dockerignore` file to be more concise and effective.
  - Updated `eslint.config.js` to explicitly ignore build, test, and dependency directories, improving linting performance.
- **Dependencies**:
  - Upgraded several key dependencies, including `typescript-eslint` to `^8.39.0` and `typedoc` to `^0.28.9`, to incorporate the latest features and security patches.

## [1.1.4] - 2025-07-31

### Changed

- **Error Handling**:
  - Improved shutdown logic in `src/index.ts` for more graceful and reliable server termination.
  - Enhanced error handling in the MCP server initialization sequence (`src/mcp-server/server.ts`) to provide clearer critical error logging.
  - Refined `ErrorHandler.ts` to prevent potential issues with error mapping.
  - Auth strategies (`jwtStrategy.ts`, `oauthStrategy.ts`) now re-throw structured `McpError` instances directly, improving error propagation.
- **Code Quality & Robustness**:
  - **Type Safety**: Replaced `export { AuthStrategy }` with `export type { AuthStrategy }` to enforce type-only imports. The `mcpTransportMiddleware` now has an explicit `MiddlewareHandler` return type.
  - **Robustness**: Added nullish coalescing and stricter checks in `jsonParser.ts` and `idGenerator.ts` to prevent runtime errors.
  - **HTTP Transport**: Improved client IP address detection and made JSON response handling in `httpTransport.ts` more resilient.
- **Dependencies**: Updated `@modelcontextprotocol/sdk` to `^1.17.1` and `openai` to `^5.11.0`.

### Fixed

- **Testing**:
  - Updated server tests (`server.test.ts`) to align with the improved error handling and initialization logic.
  - Removed redundant authentication strategy tests that are now covered by Zod schema validation at the entry point.

## [1.1.3] - 2025-07-29

### Added

- **Testing Framework**: Integrated **Vitest** as the primary testing framework for unit and integration tests.
  - Includes a comprehensive test suite with over 190 tests, achieving over 60% code coverage.
  - Added `vitest.config.ts`, `tsconfig.vitest.json`, and a `tests/` directory with detailed tests for tools, services, and utilities.
- **Test Scripts**: Added new npm scripts for running tests:
  - `npm test`: Runs all tests once.
  - `npm test:watch`: Runs tests in interactive watch mode.
  - `npm test:coverage`: Runs all tests and generates a code coverage report.

### Changed

- **Logger**: Added a `resetForTesting` method to the `Logger` singleton to ensure clean state between test runs.
- **Sanitization**: Improved the `sanitizeHtml` and `sanitizeForLogging` methods for more robust and accurate sanitization.
- **Dependencies**: Added `vitest`, `@vitest/coverage-v8`, and `msw` for testing. Updated `package.json` version to `1.1.3`.

## [1.1.2] - 2025-07-29

### Alignment with `cyanheads/mcp-ts-template@v1.7.7`

- **mcp-ts-template Alignment**: Updated the server to align with the latest changes in the [`mcp-ts-template` v1.7.7](https://github.com/cyanheads/mcp-ts-template/releases/tag/v1.7.7), including improvements to the project structure and configuration.

### Changed

- **Transport Layer Refactor**: Overhauled the HTTP and STDIO transport layers for improved modularity, robustness, and adherence to modern best practices.
  - **HTTP Transport**: Re-architected to use a strategy pattern with `StatelessTransportManager` and `StatefulTransportManager` to handle different session modes (`stateless`, `stateful`, `auto`). This decouples session logic from the Hono web server implementation.
  - **STDIO Transport**: Refactored into a dedicated module with improved error handling and clearer separation of concerns.
  - **Hono Integration**: Introduced a `honoNodeBridge` to seamlessly connect the MCP SDK's Node.js-style streamable transport with Hono's Web Standards-based streaming responses.
- **Authentication Refactor**: Abstracted authentication into a strategy pattern (`AuthStrategy`) with concrete implementations for `jwt` and `oauth`.
  - A new `authFactory` now selects the appropriate strategy based on configuration.
  - A unified `authMiddleware` handles token extraction and delegates verification to the selected strategy.
  - The `none` authentication mode is now explicitly supported for development and testing.
- **Configuration**: Added new environment variables to support the enhanced transport and session management features, including `MCP_SESSION_MODE`, `MCP_HTTP_ENDPOINT_PATH`, and timeouts for stateful sessions.
- **Dependencies**: Updated several dependencies and added new ones for testing (`vitest`, `supertest`, `msw`) and improved mocking (`@faker-js/faker`, `@anatine/zod-mock`).

### Removed

- **Deleted Legacy Files**: Removed several legacy transport and authentication files that were replaced by the new, more modular architecture.

## [1.1.1] - 2025-07-26

### Changed

- **`getStudy` Tool Enhancement**:
  - The tool now processes an array of NCT IDs and returns both successful results and a list of errors for any IDs that could not be fetched, rather than throwing an error on the first failure.
  - The `nctIds` parameter now enforces a stricter validation regex (`/^[Nn][Cc][Tt]\d{8}$/`) and has a more precise description.
  - The underlying `fetchStudy` service method now supports `fields` and `markupFormat` options for more targeted queries.
- **`searchStudies` Tool Refinement**:
  - The `countTotal` parameter has been removed from the input schema and is now always enabled by default in the logic layer to ensure the `totalCount` is consistently returned.
  - The logic for handling the `geo` filter was refactored for improved clarity and robustness.
- **Configuration**: Added a new environment variable, `MAX_STUDIES_FOR_ANALYSIS`, to control the maximum number of studies processed by the `analyzeTrends` tool.
- **Dependencies**: Updated `package.json` and `package-lock.json` to version `1.1.1` and added the `llm-agent` keyword for better discoverability.

## [1.1.0] - 2025-07-26

### Changed

- **Tool Schemas and Descriptions**:
  - **`getStudy`**: The `nctIds` parameter description is now more concise. The `summaryOnly` description was updated for clarity. All field descriptions were refined to be more direct and LLM-friendly.
  - **`searchStudies`**: The default `pageSize` was changed from `50` to `10` to provide more focused results and match native API behavior.
- **Output Formatting**:
  - **`getStudy`**: The tool's text output now only contains the JSON result, removing redundant summary text for a cleaner response.
  - **`searchStudies`**: The text output is now formatted as a structured Markdown list, providing a clear, readable summary of each study's key details (NCT ID, Title, Status, Summary, Interventions, Sponsor).
- **Examples**: Replaced all `.json` example files with more descriptive `.md` files. The new Markdown examples provide both the tool call and a formatted response, making them easier to understand.

## [1.0.10] - 2025-07-26

### Changed

- **`analyzeTrends` Tool Enhancement**: The `clinicaltrials_analyze_trends` tool can now process an array of analysis types in a single request (e.g., `["countByStatus", "countByCountry"]`), returning a distinct analysis for each type. This improves efficiency by allowing multiple aggregations over a single dataset.
- **Dependencies**: Updated `typescript` to `^5.5.4` and `@types/node` to `^20.16.1`.

## [1.0.9] - 2025-07-26

### Added

- **`searchStudies` Tool**: Introduced the `clinicaltrials_search_studies` tool, replacing the former `listStudies` tool. This new tool provides a more explicit and descriptive interface for searching clinical trials.
- **Zod Output Schemas**: Implemented Zod schemas for the output of all tools (`getStudy`, `searchStudies`, `analyzeTrends`), ensuring that the data returned to the model is strictly validated and typed.
- **Enhanced Type Safety**: Introduced `StudySchema` and `PagedStudiesSchema` in `types.ts` using Zod, establishing a single source of truth for data structures and improving runtime type safety.

### Changed

- **Architectural Overhaul**: Upgraded the entire project to align with the new v2.0 architectural standards defined in `.clinerules`. This includes:
  - **Strict "Logic Throws, Handlers Catch" Pattern**: All tools (`getStudy`, `searchStudies`, `analyzeTrends`) were refactored to isolate business logic in `logic.ts` files, which now throw structured `McpError`s. The `registration.ts` files now exclusively handle `try...catch` blocks and format the final `CallToolResult`.
  - **Standardized Tool Registration**: The tool registration process in `server.ts` and individual registration files has been updated to use the new `server.registerTool` method, which requires explicit `title`, `description`, `inputSchema`, and `outputSchema`.
- **`getStudy` Tool Refactor**: The `clinicaltrials_get_study` tool now returns a structured object `{ studies: [...] }` and supports fetching multiple studies or summaries in a single call, aligning with the new output schema standards.
- **`analyzeTrends` Tool Refactor**: The `clinicaltrials_analyze_trends` tool was updated to use the new `searchStudies` logic as its foundation and now returns a structured `AnalysisResult` object.
- **Dependencies**: Updated all major dependencies to their latest versions, including `@modelcontextprotocol/sdk` to `^1.17.0`, `hono` to `^4.8.9`, and `typescript-eslint` to `^8.38.0`.
- **Developer Guidelines**: The `.clinerules` file was updated to v2.0, formalizing the new architectural patterns and providing clearer guidance for future development.

### Removed

- **`listStudies` Tool**: The `clinicaltrials_list_studies` tool has been completely removed and replaced by the new `clinicaltrials_search_studies` tool to better reflect its functionality.

## [1.0.8] - 2025-07-12

### Changed

- **Singleton Service**: Refactored `ClinicalTrialsGovService` to implement the singleton pattern, ensuring a single, shared instance is used across the application. This improves efficiency and consistency.
- **Type Safety**: Enhanced type safety throughout the codebase by replacing `any` with more specific types like `unknown` or defined interfaces. This includes updates to tool registrations, service layers, and utility fnctions.
- **Error Handling**: Improved error handling in scripts and configuration loaders by using `unknown` and providing more robust error messages.
- **Dependencies**: Updated all major dependencies to their latest versions, including `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `@types/node`, `eslint`, `node-cron`, and `openai`.
- **Documentation**: Regenerated the `docs/tree.md` file to reflect the latest project structure.

### Fixed

- **`listStudies` Logic**: Corrected the logic for handling the `geo` filter to ensure it is properly transformed into the required API format.
- **`analyzeTrends` Logic**: Fixed an issue in the `countByPhase` analysis to correctly handle studies with multiple phases.

## [1.0.7] - 2025-07-09

### Changed

- **Documentation**: Updated `README.md` to accurately reflect the current toolset, including the `analyzeTrends` tool and the multi-ID capabilities of `getStudy`. Also regenerated the `docs/tree.md` file to match the current project structure.
- **Package Metadata**: Improved the project's `package.json` by refining the description for clarity and adding more relevant keywords to enhance discoverability.

## [1.0.6] - 2025-07-09

### Added

- **Scheduling Service**: Introduced a new `SchedulerService` (`src/utils/scheduling`) to manage cron jobs. This service provides a unified interface for scheduling, starting, stopping, and listing recurring tasks.

### Changed

- **Template Alignment**: Updated the project to align with the latest `cyanheads/mcp-ts-template@v1.6.2`, incorporating improvements in error handling, configuration management, and code structure.
- **HTTP Transport**: Refactored the HTTP transport layer to improve port handling and retry logic, making the server startup more robust.
- **`listStudies` Tool**: Adjusted the default `pageSize` to `5` and the maximum to `50` to better align with current model token limits.
- **`analyzeTrends` Tool**: Increased the `pageSize` to `1000` to optimize data fetching for large-scale analyses.
- **Error Handling**: Improved error message generation in the `ErrorHandler` for non-standard error objects.
- **Dependencies**: Added `node-cron` for the new scheduling service.

### Fixed

- **Sanitization Logic**: Corrected the `structuredClone` usage to be compatible with different JavaScript environments.

## [1.0.5] - 2025-07-09

### Added

- **`analyzeTrends` Tool**: Introduced a new tool, `clinicaltrials_analyze_trends`, to perform statistical analysis on study sets. This tool can aggregate data by status, country, sponsor type, or phase, providing valuable insights into clinical trial trends.
- **ESLint Configuration**: Added a new ESLint setup (`eslint.config.js`) to enforce code quality and consistency across the project.

### Changed

- **`getStudy` Tool Enhancement**: The `clinicaltrials_get_study` tool can now fetch multiple studies by accepting an array of NCT IDs. It also includes a `summaryOnly` option to return condensed study summaries instead of full data.
- **`listStudies` Tool Enhancement**: The `clinicaltrials_list_studies` tool now supports geographic filtering with a structured `geo` object (latitude, longitude, radius), making location-based searches more intuitive.
- **Type Definitions**: Significantly expanded the `Study` type in `types.ts` to more accurately reflect the structure of the ClinicalTrials.gov API, improving type safety and developer experience.

### Dependencies

- Updated numerous dependencies to their latest versions, including `@supabase/supabase-js`, `@types/node`, `openai`, and `zod`.
- Added new development dependencies for ESLint, including `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, and `eslint-plugin-prettier`.

## [1.0.4] - 2025-07-05

### Changed

- **Configuration Resilience**: Improved the startup process by making the `logs` and `data` directory configurations more resilient. The server now falls back to default paths and logs a warning instead of exiting if a custom path is invalid or inaccessible.
- **Conditional Backup**: The `ClinicalTrialsGovService` now only attempts to write backup files if a valid data path is configured, preventing errors when the data directory is unavailable.

### Dependencies

- Updated various dependencies to their latest versions, including `@hono/node-server`, `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `hono`, `openai`, and `zod`.

## [1.0.3] - 2025-06-24

### Dependencies

- Updated various dependencies to their latest versions, including `@modelcontextprotocol/sdk` to `^1.13.1`, `@supabase/supabase-js` to `^2.50.1`, and `hono` to `^4.8.3`.
- Removed `jsonwebtoken` as it is no longer a direct dependency.

### Changed

- **Documentation**: Cleaned up minor formatting inconsistencies in JSDoc reference documentation and project-related markdown files.

## [1.0.2] - 2025-06-20

**Alignment with cyanheads/mcp-ts-template@v1.5.6**

### Changed

- **Authentication Refactor**: Restructured the authentication middleware to be more modular and extensible. The core logic is now separated into `core` and `strategies` directories, with dedicated modules for JWT and OAuth. This improves separation of concerns and makes it easier to add new authentication methods in the future.
- **Centralized HTTP Error Handling**: Implemented a new `httpErrorHandler.ts` to centralize all HTTP error responses. This ensures consistent error formatting and status codes across the application, improving predictability and making the API easier to consume.
- **Session Management**: Removed the manual session garbage collection logic from `httpTransport.ts`. Session cleanup is now handled by the `StreamableHTTPServerTransport`'s `onclose` event, making the implementation cleaner and more reliable.

### Dependencies

- Updated `hono` to `^4.8.2` and `openai` to `^5.6.0`.

## [1.0.1] - 2025-06-18

### Changed

- **Error Handling**: Refactored `getStudy` and `listStudies` tool logic to align with the "Logic Throws, Handlers Catch" principle, ensuring that core logic files only throw structured `McpError` instances, while registration files handle the `try...catch` blocks and response formatting.
- **Dockerfile**: Optimized the `Dockerfile` by restructuring it into a multi-stage build. This change improves caching, reduces the final image size, and separates build-time dependencies from runtime dependencies.
- **Documentation**: Updated `README.md` with clearer installation instructions, updated dependency badges, and moved the project specification to the `docs/` directory.

### Dependencies

- Bumped `@modelcontextprotocol/sdk` from `^1.12.3` to `^1.13.0`.
- Updated `hono`, `openai`, and other dependencies to their latest patch versions.

## [1.0.0] - 2025-06-17

### Added

- **Initial Project Setup**: Migrated from `mcp-ts-template` to establish the `clinicaltrialsgov-mcp-server` project.
- **Project Specification**: Added `PROJECT-SPEC.md` outlining the architecture, tools, and implementation plan for the server.
- **API Specification**: Included the ClinicalTrials.gov OpenAPI specification in `docs/ctg-oas-v2.yaml`.
- **ClinicalTrials.gov Service**: Implemented `ClinicalTrialsGovService` to interact with the official ClinicalTrials.gov API, including response caching to the `data/` directory.
- **`getStudy` Tool**: Created the `clinicaltrials_get_study` tool to fetch detailed information for a single clinical study by its NCT number.
- **`listStudies` Tool**: Created the `clinicaltrials_list_studies` tool to search for studies with advanced filtering and pagination.
- **Data Cleaning Utilities**: Added `jsonCleaner.ts` to process and simplify API responses.
- **Configuration**: Added `CLINICALTRIALS_DATA_PATH` to environment configuration for managing backed up data (all data retrieved from the ClinicalTrials.gov API is automatically backed up, but the tools always use live data).

### Changed

- **Project Identity**: Updated `package.json`, `README.md`, `.clinerules`, and other configuration files to reflect the new project name, description, and version.
- **Project Focus**: Refactored the server to remove generic example tools (`echo`, `catFactFetcher`, `imageTest`) and resources, replacing them with a dedicated ClinicalTrials.gov integration.
- **Error Handling**: Added `INVALID_INPUT` to `BaseErrorCode` for more specific error handling.
- **Dependencies**: Removed `duck-db` and `openai` dependencies that were part of the old example code.

### Removed

- **Example Tools and Resources**: Deleted all files related to `echoTool`, `catFactFetcher`, `imageTest`, and `echoResource`.
- **DuckDB Service**: Removed the `duck-db` service module as it is no longer required.
- **OpenRouter Service**: Removed the `openRouterProvider` as it is no longer required.
