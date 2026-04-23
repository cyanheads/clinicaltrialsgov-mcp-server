<div align="center">
  <h1>clinicaltrialsgov-mcp-server</h1>
  <p>
    <b>MCP server for the ClinicalTrials.gov v2 API. Search trials, retrieve study details and results, and match patients to eligible trials.</b>
  </p>
  <p><b>7 Tools · 1 Resource · 1 Prompt</b></p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/clinicaltrialsgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/clinicaltrialsgov-mcp-server)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/clinicaltrialsgov-mcp-server)
[![Version](https://img.shields.io/badge/Version-2.3.5-blue.svg?style=flat-square)](./CHANGELOG.md)
[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)


[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.28.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-^6.0-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

<div align="center">

**Public Hosted Server:** [https://clinicaltrials.caseyjhand.com/mcp](https://clinicaltrials.caseyjhand.com/mcp)

</div>

---

## Overview

Seven tools for searching, discovering, analyzing, and matching clinical trials:

| Tool Name                              | Description                                                                                      |
| :------------------------------------- | :----------------------------------------------------------------------------------------------- |
| `clinicaltrials_search_studies`        | Search studies with full-text queries, filters, pagination, sorting, and field selection.        |
| `clinicaltrials_get_study_record`      | Fetch a single study by NCT ID. Returns the full record: protocol, eligibility, outcomes, arms, interventions, contacts, and locations. |
| `clinicaltrials_get_study_count`       | Get total study count for a query without fetching data. Fast statistics and breakdowns.         |
| `clinicaltrials_get_field_values`      | Discover valid values for API fields (status, phase, study type, etc.) with per-value counts.    |
| `clinicaltrials_get_field_definitions` | Browse the study data model field tree — piece names, types, nesting. Supports subtree navigation and keyword search. |
| `clinicaltrials_get_study_results`     | Extract outcomes, adverse events, participant flow, and baseline from completed studies. Optional summary mode reduces ~200KB payloads to ~5KB. |
| `clinicaltrials_find_eligible`         | Match patient demographics and conditions to eligible recruiting trials. Provide age, sex, conditions, and location to find studies with matching eligibility criteria, contacts, and recruiting locations. |

| Resource                   | Description                                         |
| :------------------------- | :-------------------------------------------------- |
| `clinicaltrials://{nctId}` | Fetch a single clinical study by NCT ID. Full JSON. |

| Prompt                    | Description                                                                        |
| :------------------------ | :--------------------------------------------------------------------------------- |
| `analyze_trial_landscape` | Adaptable workflow for data-driven trial landscape analysis using count + search tools. |

## Tools

### `clinicaltrials_search_studies`

Primary search tool with full ClinicalTrials.gov query capabilities.

- Full-text and field-specific queries (condition, intervention, sponsor, location, title, outcome)
- Status and phase filters with typed enum values
- Geographic proximity filtering by coordinates and distance
- Advanced AREA[] Essie expression support for complex queries
- Field selection to reduce payload size (full records are ~70KB each)
- Pagination with cursor tokens, sorting by any field

---

### `clinicaltrials_get_study_results`

Fetch posted results data for completed studies.

- Outcome measures with statistics, adverse events, participant flow, baseline characteristics
- Section-level filtering (request only the data you need)
- Optional summary mode condenses full results (~200KB) to essential metadata (~5KB per study)
- Batch multiple NCT IDs per call with partial-success reporting
- Separate tracking of studies without results and fetch errors

---

### `clinicaltrials_find_eligible`

Match a patient profile to eligible recruiting trials.

- Takes age, sex, conditions, and location as patient demographics
- Builds optimized API queries with demographic filters (age range, sex, healthy volunteers)
- Returns studies with eligibility and location fields for the caller to evaluate
- Provides actionable hints when no studies match (broaden conditions, adjust filters)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool/resource/prompt definitions with Zod schemas and format functions
- Unified error handling — handlers throw, framework catches and classifies
- Dual transport: stdio and Streamable HTTP from the same codebase
- Pluggable auth (`none`, `jwt`, `oauth`) for HTTP transport
- Structured logging with optional OpenTelemetry tracing

ClinicalTrials.gov-specific:

- Type-safe client for the [ClinicalTrials.gov REST API v2](https://clinicaltrials.gov/data-api/api)
- Public API — no authentication or API keys required
- Retry with exponential backoff (3 attempts) and rate limiting (~1 req/sec)
- HTML error detection and structured error factories

## Getting Started

### Public Hosted Instance

A public instance is available at `https://clinicaltrials.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "clinicaltrialsgov-mcp-server": {
      "type": "streamable-http",
      "url": "https://clinicaltrials.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "clinicaltrialsgov-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["clinicaltrialsgov-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

Or for Streamable HTTP:

```sh
MCP_TRANSPORT_TYPE=http
MCP_HTTP_PORT=3010
```

### Prerequisites

- [Bun v1.2.0](https://bun.sh/) or higher (or Node.js >= 22.0.0)

### Installation

1. **Clone the repository:**

   ```sh
   git clone https://github.com/cyanheads/clinicaltrialsgov-mcp-server.git
   ```

2. **Navigate into the directory:**

   ```sh
   cd clinicaltrialsgov-mcp-server
   ```

3. **Install dependencies:**
   ```sh
   bun install
   ```

## Configuration

All configuration is optional — the server works with defaults and no API keys.

| Variable                     | Description                                 | Default                             |
| :--------------------------- | :------------------------------------------ | :---------------------------------- |
| `CT_API_BASE_URL`            | ClinicalTrials.gov API base URL.            | `https://clinicaltrials.gov/api/v2` |
| `CT_REQUEST_TIMEOUT_MS`      | Per-request timeout in milliseconds.        | `30000`                             |
| `CT_MAX_PAGE_SIZE`           | Maximum page size cap.                      | `200`                               |
| `MCP_TRANSPORT_TYPE`         | Transport: `stdio` or `http`.               | `stdio`                             |
| `MCP_HTTP_PORT`              | Port for HTTP server.                       | `3010`                              |
| `MCP_AUTH_MODE`              | Auth mode: `none`, `jwt`, or `oauth`.       | `none`                              |
| `MCP_LOG_LEVEL`              | Log level (RFC 5424).                       | `info`                              |
| `LOGS_DIR`                   | Directory for log files (Node.js only).     | `<project-root>/logs`               |
| `OTEL_ENABLED`               | Enable OpenTelemetry tracing.               | `false`                             |

## Running the Server

### Local Development

- **Build and run the production version:**

  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run in dev mode (with watch):**

  ```sh
  bun run dev:http     # or dev:stdio
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker build -t clinicaltrialsgov-mcp-server .
docker run -p 3010:3010 clinicaltrialsgov-mcp-server
```

## Project Structure

| Directory                       | Purpose                                               |
| :------------------------------ | :---------------------------------------------------- |
| `src/mcp-server/tools/`         | Tool definitions (`*.tool.ts`).                       |
| `src/mcp-server/resources/`     | Resource definitions (`*.resource.ts`).               |
| `src/mcp-server/prompts/`       | Prompt definitions (`*.prompt.ts`).                   |
| `src/services/clinical-trials/` | ClinicalTrials.gov API client and types.              |
| `src/config/`                   | Environment variable parsing and validation with Zod. |
| `tests/`                        | Unit and integration tests.                           |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, no `console` calls
- Register new tools and resources in the `index.ts` barrel files

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
