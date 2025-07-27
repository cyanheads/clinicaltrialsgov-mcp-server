[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/cyanheads-clinicaltrialsgov-mcp-server-badge.png)](https://mseep.ai/app/cyanheads-clinicaltrialsgov-mcp-server)

# ClinicalTrials.gov MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.17.0-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.1.1-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-stable-green.svg)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/clinicaltrialsgov-mcp-server?style=social)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server)

**Empower your AI agents with direct access to the official ClinicalTrials.gov database!**

An MCP (Model Context Protocol) server providing a robust, developer-friendly interface to the official [ClinicalTrials.gov v2 API](https://clinicaltrials.gov/data-api/api). Enables LLMs and AI agents to search, retrieve, and analyze clinical study data programmatically.

Built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), this server follows a modular architecture with robust error handling, logging, and security features.

## 🚀 Core Capabilities: ClinicalTrials.gov Tools 🛠️

This server equips your AI with specialized tools to interact with the ClinicalTrials.gov database:

| Tool Name                                                                | Description                                                                                                                                                                                                                                                                     | Example                                                     |
| :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------- |
| [`clinicaltrials_search_studies`](./src/mcp-server/tools/searchStudies/) | Searches for clinical studies using a combination of query terms and filters. Supports pagination, sorting, and geographic filtering.                                                                                                                                           | [View Example](./examples/clinicaltrials_search_studies.md) |
| [`clinicaltrials_get_study`](./src/mcp-server/tools/getStudy/)           | Fetches one or more clinical studies from ClinicalTrials.gov by their NCT IDs. Returns either complete study data or concise summaries for each.                                                                                                                                | [View Example](./examples/clinicaltrials_get_study.md)      |
| [`clinicaltrials_analyze_trends`](./src/mcp-server/tools/analyzeTrends/) | Performs a statistical analysis on a set of clinical trials, aggregating data by status, country, sponsor, or phase. Use specific query parameters to refine the analysis and filter the studies included in the analysis. The tool can handle up to 5000 studies per analysis. | [View Example](./examples/clinicaltrials_analyze_trends.md) |

---

## Table of Contents

| [Overview](#overview) | [Features](#features) | [Installation](#installation)
| [Configuration](#configuration) | [Project Structure](#project-structure)
| [Tools](#tools) | [Development](#development) | [License](#license)

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
- **HTTP Transport**: High-performance HTTP server using **Hono**, featuring session management and authentication support.
- **Authentication**: Robust authentication layer supporting JWT and OAuth 2.1, with fine-grained scope enforcement.
- **Deployment**: Multi-stage `Dockerfile` for creating small, secure production images with native dependency support.

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

- [Node.js (>=18.0.0)](https://nodejs.org/)
- [npm](https://www.npmjs.com/) (comes with Node.js)

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

### If running manually (not via MCP client for development or testing)

#### Install via npm

```bash
npm install clinicaltrialsgov-mcp-server
```

#### Alternatively Install from Source

1.  Clone the repository:
    ```bash
    git clone https://github.com/cyanheads/clinicaltrialsgov-mcp-server.git
    cd clinicaltrialsgov-mcp-server
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Build the project:
    ```bash
    npm run build
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
| `NODE_ENV`                 | Runtime environment (`development`, `production`).                                       | `development` |

## Project Structure

The codebase follows a modular structure within the `src/` directory:

```
src/
├── index.ts              # Entry point: Initializes and starts the server
├── config/               # Configuration loading (env vars, package info)
│   └── index.ts
├── mcp-server/           # Core MCP server logic and capability registration
│   ├── server.ts         # Server setup, capability registration
│   ├── transports/       # Transport handling (stdio, http)
│   └── tools/            # MCP Tool implementations (subdirs per tool)
├── services/             # External service integrations
│   └── clinical-trials-gov/ # ClinicalTrials.gov API client and types
├── types-global/         # Shared TypeScript type definitions
└── utils/                # Common utility functions (logger, error handler, etc.)
```

For a detailed file tree, run `npm run tree` or see [docs/tree.md](docs/tree.md).

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

## Development

### Build and Test

```bash
# Build the project (compile TS to JS in dist/ and make executable)
npm run build

# Test the server locally using the MCP inspector tool (stdio transport)
npm run inspector

# Test the server locally using the MCP inspector tool (http transport)
npm run inspector:http

# Clean build artifacts
npm run clean

# Generate a file tree representation for documentation
npm run tree

# Clean build artifacts and then rebuild the project
npm run rebuild

# Format code with Prettier
npm run format

# Start the server using stdio (default)
npm start
# Or explicitly:
npm run start:stdio

# Start the server using HTTP transport
npm run start:http
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Built with the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</div>
