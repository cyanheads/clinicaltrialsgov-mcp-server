<div align="center">
  <h1>clinicaltrialsgov-mcp-server</h1>
  <p><b>Search ClinicalTrials.gov trials, retrieve study details and results, and match patients to eligible trials via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-2.9.8-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/clinicaltrialsgov-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/clinicaltrialsgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/clinicaltrialsgov-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/releases/latest/download/clinicaltrialsgov-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=clinicaltrialsgov-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNsaW5pY2FsdHJpYWxzZ292LW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22clinicaltrialsgov-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22clinicaltrialsgov-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://clinicaltrials.caseyjhand.com/mcp](https://clinicaltrials.caseyjhand.com/mcp)

</div>

---

## Overview

Clinical trial data from the [ClinicalTrials.gov REST API v2](https://clinicaltrials.gov/data-api/api) — the US National Library of Medicine's registry of ~577K clinical trial studies. Search trials, fetch full study records and posted results, discover field names and valid values, and match patient demographics to eligible recruiting trials. Public, read-only, no authentication required. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `clinicaltrials_search_studies` | Search studies with full-text and field-specific queries, status/phase/geographic filters, pagination, sorting, and field selection |
| `clinicaltrials_get_study_record` | Fetch a single study by NCT ID — full protocol record with optional location/outcome/reference caps |
| `clinicaltrials_get_study_count` | Fast total study count for a query, without fetching data |
| `clinicaltrials_get_field_values` | Discover valid values for API fields, with per-value study counts |
| `clinicaltrials_get_field_definitions` | Resolve valid field names — keyword search, path drill-down, or top-level overview |
| `clinicaltrials_get_study_results` | Fetch posted results — outcomes, adverse events, participant flow, baseline — for completed studies |
| `clinicaltrials_find_eligible` | Match patient demographics and conditions to eligible recruiting trials |

### Resources

| Resource | Description |
|:---|:---|
| `clinicaltrials://{nctId}` | Fetch a single clinical study by NCT ID as JSON, with capped lists and results replaced by counts |

### Prompts

| Prompt | Description |
|:---|:---|
| `analyze_trial_landscape` | Guides a data-driven clinical trial landscape analysis using the count and search tools |

## Capability reference

### `clinicaltrials_search_studies` <sub>tool</sub>

- Free-text `query` plus field-specific `conditionQuery` / `interventionQuery` / `locationQuery` / `sponsorQuery` / `titleQuery` / `outcomeQuery`; `statusFilter` / `phaseFilter` enums, `advancedFilter` (`AREA[FieldName]value` / `RANGE[min, max]` syntax), and `geoFilter` (`distance(lat,lon,radius)` with a `mi`/`km` suffix) for proximity search with nearest-site re-ranking
- Returns a compact per-study index by default (`nctId`, `briefTitle`, `overallStatus`, `phases`, `enrollmentCount`, `leadSponsor`, `conditions`, a bounded locations summary); pass `fields` (PascalCase leaves) for a full-fidelity projection — full records run ~70KB
- `pageSize` 1–`CT_MAX_PAGE_SIZE` (default 200), cursor pagination via `pageToken`, `sort` on up to 2 fields
- Excludes the upstream "unknown" enrollment sentinel (`99999999`) by default — `includeUnknownEnrollment` to include it, or automatically lifted when `nctIds` is supplied
- Typed errors: `blank_value`, `ids_not_found`, `field_invalid`, `enum_invalid`, `query_parse_error`, `geo_invalid`, `sort_invalid`, `rate_limited`

---

### `clinicaltrials_get_study_record` <sub>tool</sub>

- Full protocol record by NCT ID — identification, status, sponsor, conditions, design, arms/interventions, outcomes, eligibility, contacts/locations
- Optional `locationLimit` (≤500), `outcomeLimit` / `referenceLimit` (≤100), and `nearLocation` (`lat`, `lon`, `radiusMi` default 50) to bound and sort locations; upstream totals reported in `filtersApplied` only when a cap actually trims the list
- `resultsSection` is replaced by compact `resultsSummary` counts — fetch full results via `clinicaltrials_get_study_results`
- Typed errors: `study_not_found`, `rate_limited`

---

### `clinicaltrials_get_study_count` <sub>tool</sub>

- Same query/filter surface as `clinicaltrials_search_studies` (free-text and field-specific queries, status/phase filters, `advancedFilter`) but returns only `totalCount` — no study data fetched
- Excludes the unknown-enrollment sentinel by default (`includeUnknownEnrollment` to include it)
- Typed errors: `blank_value`, `field_invalid`, `enum_invalid`, `query_parse_error`, `rate_limited`

---

### `clinicaltrials_get_field_values` <sub>tool</sub>

- One or more PascalCase field names (e.g. `OverallStatus`, `Phase`, `LeadSponsorClass`) — returns each field's type, unique-value count, and top values with study counts (capped at 250 by the API)
- Numeric/date fields report `min` / `max` / `avg` / `formats` instead of top values; boolean fields report `trueCount` / `falseCount`
- `multiValued` flags fields where a study can carry several values, so per-value study counts can sum above the study total
- Typed errors: `blank_value`, `field_invalid`, `rate_limited`

---

### `clinicaltrials_get_field_definitions` <sub>tool</sub>

- Three modes: `search` (keyword, ranked matches, `limit` up to 100, default 20), `drill` (dot-notation `path` into a section), `overview` (top-level sections, no other args)
- Resolves the canonical PascalCase field names accepted by `fields`, `advancedFilter`, `sort`, and `clinicaltrials_get_field_values`
- Typed errors: `blank_value`, `mode_mismatch`, `mode_requires`, `path_not_found`, `rate_limited`

---

### `clinicaltrials_get_study_results` <sub>tool</sub>

- Up to 20 NCT IDs per call; only returns data for studies where `hasResults` is true — outcome measures, adverse events, participant flow, baseline characteristics, and results metadata
- `summary` (default false) condenses a full result set — which can exceed 500KB per study — to a few KB; full mode supports `outcomeLimit` (≤100) and `adverseEventLimit` (≤500), resumable via `outcomeOffset` / `seriousEventOffset` / `otherEventOffset`
- `sections` filters to `outcomes`, `adverseEvents`, `participantFlow`, `baseline`, `moreInfo`
- A previous (alias) NCT ID resolves to its canonical study, named in `canonicalNctId`
- Typed errors: `blank_value`, `offset_not_applicable`, `rate_limited`

---

### `clinicaltrials_find_eligible` <sub>tool</sub>

- Takes `age`, `sex` (`FEMALE` / `MALE` / `ALL`), `conditions[]`, `location` (`country` required, `state` / `city` optional), `healthyVolunteer`, `recruitingOnly` (default true), `maxResults` (≤50)
- Re-ranks results so studies whose own condition list names a requested condition surface above tangential MeSH-umbrella matches from the upstream fuzzy search
- Bounds each candidate's locations to the sites matching the requested location (capped by `locationLimit`, ≤500) instead of every registered site, adding the nearest recruiting site when none of the matched ones is open
- `funnel` reports match counts at each filter stage (condition → +location → +demographics) to show where the query narrowed to zero
- Typed errors: `blank_value`, `rate_limited`

---

### `clinicaltrials://{nctId}` <sub>resource</sub>

- Full protocol record as `application/json`, with locations, secondary/other outcomes, and references each capped at 50 — fixed server-side, no arguments
- Results data is replaced by `resultsSummary` counts; `truncated` and `filtersApplied` disclose what was capped, with `retrieval` naming the tools that fetch the full data
- Typed errors: `study_not_found`, `rate_limited`

---

### `analyze_trial_landscape` <sub>prompt</sub>

- Arguments: `topic` required; `focusAreas` (comma-separated) optional
- Returns one user message pointing the agent at the count, search, field-discovery, and results tools for a data-driven landscape analysis

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ClinicalTrials.gov-specific:

- Type-safe client for the [ClinicalTrials.gov REST API v2](https://clinicaltrials.gov/data-api/api) — public, no authentication or API keys required
- Serialized request queue enforcing ClinicalTrials.gov's ~1 req/sec rate limit, with retry and exponential backoff on 429/5xx responses
- Auto-corrects field names passed to `fields`/`sort` — case/whitespace fixes and known legacy aliases (e.g. `RecruitmentStatus` → `OverallStatus`) — before validating, logging every correction
- Detects upstream HTML error pages returned with a JSON content-type and retries rather than parsing them as data
- Geographic proximity search and nearest-site re-ranking, with no geocoding dependency

Agent-friendly output:

- Provenance — `clinicaltrials_search_studies` / `clinicaltrials_get_study_count` / `clinicaltrials_find_eligible` echo `searchCriteria` on every call, including `sentinelFilterActive` when the default unknown-enrollment exclusion applies, and `clinicaltrials_get_study_results` names `canonicalNctId` when a previous (alias) ID resolves to a different study
- Graceful partial failure — `clinicaltrials_get_study_results` returns per-study `fetchErrors` / `studiesWithoutResults` rows instead of failing the whole batch when one ID is malformed or lacks results
- Discriminated output — typed error `reason` codes per tool (`study_not_found`, `blank_value`, `offset_not_applicable`, …), and bounded lists (`filtersApplied`, `locationSummary`) carry a `next*Offset` only when more remains, so callers branch on presence instead of parsing text
- Response shaping — `clinicaltrials_search_studies` and `clinicaltrials_find_eligible` return a compact per-study index or location-bounded set by default instead of the ~70KB full record, escalating to full fidelity only via `fields` or `clinicaltrials_get_study_record`

## Getting started

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

Add the following to your MCP client configuration file.

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

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "clinicaltrialsgov-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "clinicaltrialsgov-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "clinicaltrialsgov-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/clinicaltrialsgov-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

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

| Variable | Description | Default |
|:---|:---|:---|
| `CT_API_BASE_URL` | ClinicalTrials.gov API base URL. | `https://clinicaltrials.gov/api/v2` |
| `CT_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds. | `30000` |
| `CT_MAX_PAGE_SIZE` | Maximum page size cap. | `200` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, and security audit
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t clinicaltrialsgov-mcp-server .
docker run --rm -p 3010:3010 clinicaltrialsgov-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/clinicaltrialsgov-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits the ClinicalTrials.gov service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services/clinical-trials` | ClinicalTrials.gov REST API v2 client — retry, rate limiting, field search, types. |
| `tests/` | Unit and integration tests. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, no `console` calls
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Validate raw API responses, normalize to domain types, and never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
