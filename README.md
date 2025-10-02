<div align="center">

# clinicaltrialsgov-mcp-server

**Empower your AI agents with direct access to the ClinicalTrials.gov database!**

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.2-blue.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.18.2-green.svg?style=flat-square)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.2.0-blue.svg?style=flat-square)](./CHANGELOG.md)
[![Coverage](https://img.shields.io/badge/Coverage-92.46%25-brightgreen?style=flat-square)](./vitest.config.ts)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-stable-green.svg?style=flat-square)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/clinicaltrialsgov-mcp-server?style=social)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server)

</div>

Model Context Protocol (MCP) Server providing a robust, developer-friendly interface to the official [ClinicalTrials.gov v2 API](https://clinicaltrials.gov/data-api/api). Enables LLMs and AI agents to search, retrieve, and analyze clinical study data programmatically.

Built on the [`cyanheads/mcp-ts-template@v2.3.1`](https://github.com/cyanheads/mcp-ts-template), this server is designed for performance, portability, and developer experience. It can run as a standard Node.js process or be deployed as a serverless function on **Cloudflare Workers**.

## 🚀 Core Capabilities: ClinicalTrials.gov Tools 🛠️

This server equips your AI with specialized tools to interact with the ClinicalTrials.gov database:

| Tool Name                                                                | Description                                                                                                                                                                                                                                                                     | Example                                                     |
| :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------- |
| [`clinicaltrials_search_studies`](./src/mcp-server/tools/searchStudies/) | Searches for clinical studies using a combination of query terms and filters. Supports pagination, sorting, and geographic filtering.                                                                                                                                           | [View Example](./examples/clinicaltrials_search_studies.md) |
| [`clinicaltrials_get_study`](./src/mcp-server/tools/getStudy/)           | Fetches one or more clinical studies from ClinicalTrials.gov by their NCT IDs. Returns either complete study data or concise summaries for each.                                                                                                                                | [View Example](./examples/clinicaltrials_get_study.md)      |
| [`clinicaltrials_analyze_trends`](./src/mcp-server/tools/analyzeTrends/) | Performs a statistical analysis on a set of clinical trials, aggregating data by status, country, sponsor, or phase. Use specific query parameters to refine the analysis and filter the studies included in the analysis. The tool can handle up to 5000 studies per analysis. | [View Example](./examples/clinicaltrials_analyze_trends.md) |

---

## Table of Contents

| [Overview](#overview) | [Features](#features) | [Installation](#installation) |
| :--- | :--- | :--- |
| [Configuration](#configuration) | [Project Structure](#project-structure) | [Tools](#tools) |
| [Serverless Deployment](#serverless-deployment) | [Development & Testing](#development--testing) | [License](#license) |

## Overview

The ClinicalTrials.gov MCP Server acts as a bridge, allowing applications (MCP Clients) that understand the Model Context Protocol (MCP) – like advanced AI assistants (LLMs), IDE extensions, or custom research tools – to interact directly and efficiently with the official ClinicalTrials.gov database.

Instead of complex API integration or manual searches, your tools can leverage this server to:

- **Automate clinical research workflows**: Search for clinical trials, fetch detailed study metadata, and analyze trial characteristics programmatically.
- **Gain research insights**: Access comprehensive trial data including study protocols, eligibility criteria, outcomes, sponsors, and locations without leaving the host application.
- **Integrate clinical trial data into AI-driven research**: Enable LLMs to conduct clinical trial reviews, analyze research trends, and support evidence-based decision making.
- **Support regulatory and compliance workflows**: Retrieve structured data for regulatory submissions, competitive intelligence, and market research.

Built on the robust `mcp-ts-template`, this server provides a standardized, secure, and efficient way to expose ClinicalTrials.gov functionality via the MCP standard. It achieves this by integrating with the official ClinicalTrials.gov v2 API, ensuring compliance with rate limits and providing comprehensive error handling.

> **Developer Note**: This repository includes a [.clinerules](.clinerules) file that serves as a developer cheat sheet for your LLM coding agent with quick reference for the codebase patterns, file locations, and code snippets.

## Features

### Core Utilities

Leverages the robust utilities provided by the `mcp-ts-template`:

- **Logging**: Structured, configurable logging (file rotation, stdout JSON, MCP notifications) with sensitive data redaction.
- **Error Handling**: Centralized error processing, standardized error types (`McpError`), and automatic logging.
- **Configuration**: Environment variable loading (`dotenv`) with comprehensive validation using Zod.
- **Input Validation/Sanitization**: Uses `zod` for schema validation and custom sanitization logic.
- **Request Context**: Tracking and correlation of operations via unique request IDs using `AsyncLocalStorage`.
- **Type Safety**: Strong typing enforced by TypeScript and Zod schemas.
- **HTTP Transport**: High-performance HTTP server using **Hono** for routing and middleware.
- **Authentication**: Robust authentication layer supporting JWT and OAuth 2.1, with fine-grained scope enforcement.
- **Serverless & Edge Ready**: Includes a `src/worker.ts` entry point for seamless deployment to **Cloudflare Workers**.
- **Containerization**: Multi-stage `Dockerfile` for creating small, secure production images.
- **Dependency Injection**: Powered by `tsyringe` for a clean, decoupled architecture.
- **Observability**: Integrated with **OpenTelemetry** for tracing and metrics.
- **Advanced Storage**: Abstracted storage layer with providers for `in-memory`, `filesystem`, **Supabase**, and Cloudflare **R2** & **KV**.
- **Speech Services**: Built-in support for Text-to-Speech (ElevenLabs) and Speech-to-Text (Whisper).

### ClinicalTrials.gov Integration

- **Official API Integration**: Comprehensive access to ClinicalTrials.gov v2 API endpoints with automatic JSON parsing.
- **Advanced Search Capabilities**: Complex query construction with filters for study status, geographic location, conditions, interventions, and sponsors.
- **Full Study Metadata**: Retrieve complete trial data including protocols, eligibility criteria, study design, outcomes, sponsors, and contact information.
- **Flexible Field Selection**: Choose specific data fields to retrieve for efficient API usage and reduced response sizes.
- **Pagination Support**: Handle large result sets with built-in pagination using `pageSize` and `pageToken` parameters.
- **Data Cleaning**: Automatically cleans and simplifies redundant information from API responses for easier consumption.
- **Rate Limiting Compliance**: Built-in request throttling to comply with ClinicalTrials.gov API guidelines.

## Installation

### Prerequisites

- [Bun (>=1.0.0)](https://bun.sh/)

### MCP Client Settings

Add the following to your MCP client's configuration file (e.g., `cline_mcp_settings.json`). This configuration uses `npx` to run the server, which will automatically install the package if not already present:

```json
{
  "mcpServers": {
    "clinicaltrialsgov-mcp-server": {
      "command": "npx",
      "args": ["clinicaltrialsgov-mcp-server"],
      "env": {
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

### If running manually (for development or testing)

1.  Clone the repository:
    ```bash
    git clone https://github.com/cyanheads/clinicaltrialsgov-mcp-server.git
    cd clinicaltrialsgov-mcp-server
    ```
2.  Install dependencies:
    ```bash
    bun install
    ```
3.  Build the project:
    ```bash
    bun run build
    ```

## Configuration

### Environment Variables

Configure the server using environment variables. For local development, these can be set in a `.env` file at the project root or directly in your environment. Otherwise, you can set them in your MCP client configuration as shown above.

| Variable                   | Description                                                                              | Default       |
| :------------------------- | :--------------------------------------------------------------------------------------- | :------------ |
| `MCP_TRANSPORT_TYPE`       | Transport mechanism: `stdio` or `http`.                                                  | `stdio`       |
| `MCP_HTTP_PORT`            | Port for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                                 | `3010`        |
| `MCP_HTTP_HOST`            | Host address for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                         | `127.0.0.1`   |
| `MCP_ALLOWED_ORIGINS`      | Comma-separated list of allowed origins for CORS (if `MCP_TRANSPORT_TYPE=http`).         | (none)        |
| `MCP_LOG_LEVEL`            | Logging level (`debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg`). | `debug`       |
| `MCP_AUTH_MODE`            | Authentication mode for HTTP: `jwt` or `oauth`.                                          | `jwt`         |
| `MCP_AUTH_SECRET_KEY`      | **Required for `jwt` auth.** Minimum 32-character secret key for JWT authentication.     | (none)        |
| `CLINICALTRIALS_DATA_PATH` | Directory for caching ClinicalTrials.gov API data.                                       | `data/`       |
| `LOGS_DIR`                 | Directory for log file storage.                                                          | `logs/`       |
| `NODE_ENV`                 | Runtime environment (`development`, `production`, `testing`).                            | `development` |
>>>>>>> Stashed changes
| `STORAGE_PROVIDER_TYPE`    | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-r2`, `cloudflare-kv`. | `in-memory`   |
| `OTEL_ENABLED`             | Set to `true` to enable OpenTelemetry tracing and metrics.                               | `false`       |

## Project Structure

The codebase follows a modular structure within the `src/` directory:

```
src/
├── index.ts                # Main entry point for Node.js environment
├── worker.ts               # Entry point for Cloudflare Workers (serverless)
├── config/                 # Application configuration (Zod schema, env loading)
├── container/              # Dependency Injection (tsyringe) setup and tokens
├── mcp-server/             # Core MCP server logic
│   ├── prompts/            # Declarative prompt definitions
│   ├── resources/          # Declarative resource definitions
│   ├── tools/              # Declarative tool definitions
│   └── transports/         # HTTP and STDIO transport layers
├── services/               # External service integrations (ClinicalTrials.gov, LLMs, Speech)
├── storage/                # Storage abstraction layer and providers
├── types-global/           # App-wide TypeScript types (e.g., errors)
└── utils/                  # Common utilities (logger, error handling, etc.)
```

For a detailed file tree, run `bun run tree` or see [docs/tree.md](docs/tree.md).

## Tools

The ClinicalTrials.gov MCP Server provides a comprehensive suite of tools for clinical trial research, callable via the Model Context Protocol.

| Tool Name                       | Description                                                           | Key Arguments                                                                     |
| :------------------------------ | :-------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
| `clinicaltrials_search_studies` | Searches for clinical studies using queries, filters, and pagination. | `query?`, `filter?`, `fields?`, `sort?`, `pageSize?`, `pageToken?`, `countTotal?` |
| `clinicaltrials_get_study`      | Fetches detailed information for one or more studies by NCT ID.       | `nctIds`, `summaryOnly?`, `markupFormat?`, `fields?`                              |
| `clinicaltrials_analyze_trends` | Performs statistical analysis on a set of studies.                    | `analysisType`, `query?`, `filter?`                                               |

_Note: All tools support comprehensive error handling and return structured JSON responses._

## Examples

Comprehensive usage examples for each tool are available in the [`examples/`](examples/) directory.

- **`clinicaltrials_search_studies`**: [View Example](./examples/clinicaltrials_search_studies.md)
- **`clinicaltrials_get_study`**: [View Example](./examples/clinicaltrials_get_study.md)
- **`clinicaltrials_analyze_trends`**: [View Example](./examples/clinicaltrials_analyze_trends.md)

## Serverless Deployment

This server is optimized for serverless environments, particularly **Cloudflare Workers**.

- The `src/worker.ts` file is the entry point for serverless deployments.
- It leverages Cloudflare Bindings to securely access services like KV, R2, and environment variables.
- The storage layer can be configured to use `cloudflare-r2` or `cloudflare-kv` for persistent, globally distributed storage.

To deploy, configure your `wrangler.toml` file and run `bunx wrangler deploy`.

## Development & Testing

### Development Scripts

```bash
# Start the server in watch mode (restarts on file changes)
bun run dev

# Run all quality checks (lint, types, formatting, security, etc.)
bun run devcheck

# Generate comprehensive AI-readable context for documentation
bun run devdocs

# Build the project for production
bun run build

# Format code with Prettier
bun run format

# Generate a file tree representation for documentation
bun run tree
```

### Testing

This project uses **Bun's built-in test runner**, which is compatible with the Vitest API.

```bash
# Run all tests once
bun test

# Run tests and generate a code coverage report
bun test --coverage
```

### Running the Server

```bash
# Start the server using stdio (default)
bun start
# Or explicitly:
bun run start:stdio

# Start the server using HTTP transport
bun run start:http

# Test the server locally using the MCP inspector tool
bun run inspector
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Built with the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</div>
