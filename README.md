# ClinicalTrials.gov MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.13.1-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.0.3-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-beta-orange.svg)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/clinicaltrialsgov-mcp-server?style=social)](https://github.com/cyanheads/clinicaltrialsgov-mcp-server)

**Empower your AI agents with direct access to the official ClinicalTrials.gov database!**

An MCP (Model Context Protocol) server providing a robust, developer-friendly interface to the official [ClinicalTrials.gov v2 API](https://clinicaltrials.gov/data-api/api). Enables LLMs and AI agents to search, retrieve, and analyze clinical study data programmatically.

Built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), this server follows a modular architecture with robust error handling, logging, and security features.

## 🚀 Core Capabilities: ClinicalTrials.gov Tools 🛠️

This server equips your AI with specialized tools to interact with the ClinicalTrials.gov database:

| Tool Name                                                            | Description                                                                                                                                               | Key Features                                                                                                                                                                                                                                                                                                                                             |
| :------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`clinicaltrials_list_studies`](./src/mcp-server/tools/listStudies/) | Searches for clinical studies using a combination of query terms and filters. (See [Example](./examples/studies_2025-06-17T11-15-33-773Z.json))           | - `query`: Search by condition, term, location, title, intervention, outcomes, sponsor, or ID.<br/>- `filter`: Refine results by NCT IDs, study status, geographic distance, or advanced Essie expressions.<br/>- `pagination`: Control result sets with `pageSize` and `pageToken`.<br/>- `fields`: Specify which data fields to return for efficiency. |
| [`clinicaltrials_get_study`](./src/mcp-server/tools/getStudy/)       | Retrieves detailed information for a single clinical study by its NCT number. (See [Example](./examples/study_NCT03934567_2025-06-17T11-17-59-791Z.json)) | - `nctId`: Fetches a study using its unique identifier (e.g., "NCT03934567").<br/>- `fields`: Select specific fields to retrieve.<br/>- `markupFormat`: Choose between `markdown` or `legacy` for formatted content.<br/>- Uses ClinicalTrials.gov REST API v2.                                                                                          |

---

## Table of Contents

| [Overview](#overview) | [Features](#features) | [Installation](#installation) |

| [Configuration](#configuration) | [Project Structure](#project-structure) |

| [Tools](#tools) | [Resources](#resources) | [Development](#development) | [License](#license) |

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
- **Configuration**: Environment variable loading (`dotenv`) with comprehensive validation.
- **Input Validation/Sanitization**: Uses `zod` for schema validation and custom sanitization logic.
- **Request Context**: Tracking and correlation of operations via unique request IDs using `AsyncLocalStorage`.
- **Type Safety**: Strong typing enforced by TypeScript and Zod schemas.
- **HTTP Transport**: High-performance HTTP server using **Hono**, featuring session management with garbage collection and authentication support.
- **Authentication**: Robust authentication layer supporting JWT and OAuth 2.1, with fine-grained scope enforcement.
- **Deployment**: Multi-stage `Dockerfile` for creating small, secure production images with native dependency support.

### ClinicalTrials.gov Integration

- **Official API Integration**: Comprehensive access to ClinicalTrials.gov v2 API endpoints with automatic JSON parsing.
- **Advanced Search Capabilities**: Complex query construction with filters for study status, geographic location, conditions, interventions, and sponsors.
- **Full Study Metadata**: Retrieve complete trial data including protocols, eligibility criteria, study design, outcomes, sponsors, and contact information.
- **Flexible Field Selection**: Choose specific data fields to retrieve for efficient API usage and reduced response sizes.
- **Pagination Support**: Handle large result sets with built-in pagination using `pageSize` and `pageToken` parameters.
- **Multiple Query Types**: Support for condition-based, intervention-based, location-based, and sponsor-based searches.
- **Data Format Options**: Choose between `markdown` and `legacy` markup formats for study descriptions.
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

## If running manually (not via MCP client for development or testing)

### Install via npm

```bash
npm install clinicaltrialsgov-mcp-server
```

### Alternatively Install from Source

1. Clone the repository:

   ```bash
   git clone https://github.com/cyanheads/clinicaltrialsgov-mcp-server.git
   cd clinicaltrialsgov-mcp-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   *or npm run rebuild*
   ```

## Configuration

### Environment Variables

Configure the server using environment variables. These environmental variables are set within your MCP client config/settings (e.g. `claude_desktop_config.json` for Claude Desktop)

| Variable                   | Description                                                                              | Default                   |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| `MCP_TRANSPORT_TYPE`       | Transport mechanism: `stdio` or `http`.                                                  | `stdio`                   |
| `MCP_HTTP_PORT`            | Port for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                                 | `3010`                    |
| `MCP_HTTP_HOST`            | Host address for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                         | `127.0.0.1`               |
| `MCP_ALLOWED_ORIGINS`      | Comma-separated list of allowed origins for CORS (if `MCP_TRANSPORT_TYPE=http`).         | (none)                    |
| `MCP_LOG_LEVEL`            | Logging level (`debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg`). | `debug`                   |
| `LOG_OUTPUT_MODE`          | Logging output mode: `file` or `stdout`.                                                 | `file`                    |
| `MCP_AUTH_MODE`            | Authentication mode for HTTP: `jwt` or `oauth`.                                          | `jwt`                     |
| `MCP_AUTH_SECRET_KEY`      | **Required for `jwt` auth.** Minimum 32-character secret key for JWT authentication.     | (none)                    |
| `CLINICALTRIALS_DATA_PATH` | Directory for caching ClinicalTrials.gov API data.                                       | `data/` (in project root) |
| `LOGS_DIR`                 | Directory for log file storage (if `LOG_OUTPUT_MODE=file`).                              | `logs/`                   |
| `NODE_ENV`                 | Runtime environment (`development`, `production`).                                       | `development`             |

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
│   ├── resources/        # MCP Resource implementations
│   └── tools/            # MCP Tool implementations (subdirs per tool)
├── services/             # External service integrations
│   └── clinical-trials-gov/ # ClinicalTrials.gov API client and parsing
├── types-global/         # Shared TypeScript type definitions
└── utils/                # Common utility functions (logger, error handler, etc.)
```

For a detailed file tree, run `npm run tree` or see [docs/tree.md](docs/tree.md).

## Tools

The ClinicalTrials.gov MCP Server provides a comprehensive suite of tools for clinical trial research, callable via the Model Context Protocol.

| Tool Name                     | Description                                                           | Key Arguments                                                                     |
| :---------------------------- | :-------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
| `clinicaltrials_list_studies` | Searches for clinical studies using queries, filters, and pagination. | `query?`, `filter?`, `fields?`, `sort?`, `pageSize?`, `pageToken?`, `countTotal?` |
| `clinicaltrials_get_study`    | Fetches detailed information for a single study by NCT number.        | `nctId`, `markupFormat?`, `fields?`                                               |

_Note: All tools support comprehensive error handling and return structured JSON responses._

## Examples

Comprehensive usage examples are available in the [`examples/`](examples/) directory:

- [List Studies](examples/studies_2025-06-17T11-15-33-773Z.json)
- [Get Study Details](examples/study_NCT03934567_2025-06-17T11-17-59-791Z.json)

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
