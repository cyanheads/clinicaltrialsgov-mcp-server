<div align="center">
  <h1>clinicaltrialsgov-mcp-server</h1>
  <p><b>MCP server for the ClinicalTrials.gov v2 API. Search trials, retrieve study details, compare studies, analyze trends, and match patients to eligible trials. Runs over stdio or HTTP. Deployable to Cloudflare Workers.</b></p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/clinicaltrialsgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/clinicaltrialsgov-mcp-server) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/clinicaltrialsgov-mcp-server) [![Version](https://img.shields.io/badge/Version-1.8.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2025--06--18-8A2BE2.svg?style=flat-square)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/changelog.mdx) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Status](https://img.shields.io/badge/Status-Stable-brightgreen.svg?style=flat-square)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/issues) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/) [![Code Coverage](https://img.shields.io/badge/Coverage-92.46%25-brightgreen.svg?style=flat-square)](./vitest.config.ts)

</div>

---

## Tools

Seven tools for working with ClinicalTrials.gov data:

| Tool Name                              | Description                                                                                                                                 |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| `clinicaltrials_search_studies`        | Searches for clinical studies using query terms, filters, pagination, and sorting. Includes geographic and enum-based filtering.            |
| `clinicaltrials_get_study`             | Fetches one or more clinical studies by their NCT IDs, returning either full data or concise summaries.                                     |
| `clinicaltrials_get_study_results`     | Fetches trial results data for completed studies — outcomes, adverse events, participant flow, and baseline characteristics.                |
| `clinicaltrials_get_field_values`      | Discovers valid enum values for any API field with study counts, enabling informed query construction.                                      |
| `clinicaltrials_analyze_trends`        | Performs statistical analysis on up to 5000 studies by status, country, sponsor, phase, year, month, study type, or intervention type.      |
| `clinicaltrials_compare_studies`       | Side-by-side comparison of 2-5 clinical studies across eligibility, design, interventions, outcomes, and sponsors.                          |
| `clinicaltrials_find_eligible_studies` | Matches patient profiles to eligible clinical trials, filtering by age, sex, conditions, and location. Returns studies sorted by proximity. |

### `clinicaltrials_search_studies`

Search for clinical trials using free-text queries and filters.

- Full-text search plus specialized condition, intervention, and sponsor queries targeting specific API indexes
- Typed enum filters for study status and phase (single value or array)
- Geographic proximity filtering by coordinates and distance
- Advanced filtering with ClinicalTrials.gov's AREA[] syntax
- Pagination (up to 200 per page), sorting, and field selection

[View detailed examples](./examples/clinicaltrials_search_studies.md)

---

### `clinicaltrials_get_study`

Fetch one or more clinical trials by NCT ID, with full data or concise summaries.

- Batch fetch up to 5 studies at once
- Full data includes protocol sections, results, adverse events, outcome measures, eligibility, and locations
- Partial success reporting when some studies in a batch fail

[View detailed examples](./examples/clinicaltrials_get_study.md)

---

### `clinicaltrials_analyze_trends`

Aggregate statistics across up to 5,000 studies by status, country, sponsor, phase, year, month, study type, or intervention type.

- Combine multiple analysis types in a single request
- Filter to focus on specific subsets
- Returns counts and top categories (percentages omitted for phase breakdowns, where multi-phase studies make the denominator ambiguous)

[View detailed examples](./examples/clinicaltrials_analyze_trends.md)

---

### `clinicaltrials_compare_studies`

Compare 2-5 studies side-by-side across eligibility, design, interventions, outcomes, sponsors, and locations.

- Configurable comparison fields — compare everything or focus on specific aspects
- Handles partial failures if some studies can't be fetched

[View detailed examples](./examples/clinicaltrials-compare-studies.md)

---

### `clinicaltrials_find_eligible_studies`

Match a patient profile (age, sex, conditions, location) to eligible clinical trials.

- Hard filters on age, sex, healthy volunteer status, and country — ineligible studies are excluded entirely
- Condition token overlap used as a false-positive gate (studies with zero relevance to the patient's conditions are excluded)
- Results sorted by location proximity: city match → state match → country-only, then by number of nearby sites
- Returns a summary of why each study is a potential match

[View detailed examples](./examples/clinicaltrials-find-eligible-studies.md)

---

### `clinicaltrials_get_study_results`

Fetch results data (outcomes, adverse events, participant flow, baseline characteristics) for completed studies.

- Section-level filtering — request only the sections you need
- Batch up to 5 studies per request
- Reports which studies lack results or failed to fetch
- Includes statistical analyses (p-values, methods) with outcome data

---

### `clinicaltrials_get_field_values`

Look up valid enum values for any ClinicalTrials.gov API field, with study counts per value.

- Sorted by frequency
- Useful for exploring OverallStatus, Phase, InterventionType, StudyType, and other fields before constructing filters

## Features

Built on [`mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified `McpError` error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2`
- Structured logging (Pino) with optional OpenTelemetry tracing
- Typed DI container with `Token<T>` phantom branding
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

ClinicalTrials.gov-specific:

- Type-safe client for the ClinicalTrials.gov v2 API
- Tools for search, filtering, statistical aggregation, and patient matching
- Automatic cleaning and simplification of API responses for agent consumption

## Getting started

### Public Hosted Instance

A public instance is available at `https://clinicaltrials.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "clinicaltrialsgov": {
      "type": "streamable-http",
      "url": "https://clinicaltrials.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP Client configuration file (e.g., `cline_mcp_settings.json`).

```json
{
  "mcpServers": {
    "clinicaltrialsgov-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["clinicaltrialsgov-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or for Streamable HTTP:

```bash
MCP_TRANSPORT_TYPE=http
MCP_HTTP_PORT=3017
```

### Prerequisites

- [Bun v1.2.0](https://bun.sh/) or higher.

### Installation

1.  **Clone the repository:**

```sh
git clone https://github.com/cyanheads/clinicaltrialsgov-mcp-server.git
```

2.  **Navigate into the directory:**

```sh
cd clinicaltrialsgov-mcp-server
```

3.  **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is centralized and validated at startup in `src/config/index.ts`. Key environment variables in your `.env` file include:

| Variable                | Description                                                                                                        | Default     |
| :---------------------- | :----------------------------------------------------------------------------------------------------------------- | :---------- |
| `MCP_TRANSPORT_TYPE`    | The transport to use: `stdio` or `http`.                                                                           | `http`      |
| `MCP_HTTP_PORT`         | The port for the HTTP server.                                                                                      | `3017`      |
| `MCP_AUTH_MODE`         | Authentication mode: `none`, `jwt`, or `oauth`.                                                                    | `none`      |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv`, `cloudflare-r2`, `cloudflare-d1`.         | `in-memory` |
| `OTEL_ENABLED`          | Set to `true` to enable OpenTelemetry.                                                                             | `false`     |
| `MCP_LOG_LEVEL`         | The minimum level for logging (RFC 5424: `debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg`). | `info`      |
| `MCP_AUTH_SECRET_KEY`   | **Required for `jwt` auth.** A 32+ character secret key.                                                           | `(none)`    |
| `OAUTH_ISSUER_URL`      | **Required for `oauth` auth.** URL of the OIDC provider.                                                           | `(none)`    |

## Running the server

### Local Development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun rebuild

  # Run the built server
  bun start:http
  # or
  bun start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun devcheck # Lints, formats, type-checks, and more
  bun test # Runs the test suite
  ```

### Cloudflare Workers

1.  **Build the Worker bundle**:

```sh
bun build:worker
```

2.  **Run locally with Wrangler**:

```sh
bun deploy:dev
```

3.  **Deploy to Cloudflare**:
    ```sh
    bun deploy:prod
    ```

## Project structure

| Directory                   | Purpose & Contents                                                               |
| :-------------------------- | :------------------------------------------------------------------------------- |
| `src/mcp-server/tools`      | Your tool definitions (`*.tool.ts`). This is where you add new capabilities.     |
| `src/mcp-server/resources`  | Your resource definitions (`*.resource.ts`). This is where you add data sources. |
| `src/mcp-server/transports` | Implementations for HTTP and STDIO transports, including auth middleware.        |
| `src/storage`               | `StorageService` abstraction and all storage provider implementations.           |
| `src/services`              | Integrations with external services (ClinicalTrials.gov).                        |
| `src/container`             | Dependency injection container registrations and tokens.                         |
| `src/utils`                 | Core utilities for logging, error handling, performance, and security.           |
| `src/config`                | Environment variable parsing and validation with Zod.                            |
| `tests/`                    | Unit and integration tests, mirroring the `src/` directory structure.            |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Logic throws `McpError`, handlers catch — no `try/catch` in tool logic
- Pass `RequestContext` through the call stack for logging and tracing
- Register new tools and resources in the `index.ts` barrel files

## Contributing

Issues and pull requests are welcome! If you plan to contribute, please run the local checks and tests before submitting your PR.

```sh
bun run devcheck
bun test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
