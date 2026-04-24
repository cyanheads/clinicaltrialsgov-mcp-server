# Agent Protocol

**Server:** clinicaltrialsgov-mcp-server
**Version:** 2.3.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Overview

MCP server wrapping the [ClinicalTrials.gov REST API v2](https://clinicaltrials.gov/data-api/api) — the US National Library of Medicine's registry of ~577K clinical trial studies. Public, read-only, no auth required.

**Design doc:** `docs/design.md` — full MCP surface design, tool schemas, service plan, implementation checklist.
**API reference:** `docs/api-reference.md` — complete ClinicalTrials.gov v2 endpoint reference.

---

## MCP Surface

### Tools (7)

| Name                                   | Description                                                                         |
| :------------------------------------- | :---------------------------------------------------------------------------------- |
| `clinicaltrials_search_studies`        | Search studies with queries, filters, pagination, field selection. Primary tool.    |
| `clinicaltrials_get_study_record`      | Single study by NCT ID. Tool equivalent of the resource for resource-unaware clients. |
| `clinicaltrials_get_study_results`     | Extract outcomes, adverse events, participant flow, baseline for completed studies. |
| `clinicaltrials_get_field_values`      | Discover valid enum values for API fields with study counts.                        |
| `clinicaltrials_get_field_definitions` | Browse the study data model field tree — piece names, types, nesting.               |
| `clinicaltrials_get_study_count`       | Lightweight study count for a query (no data fetched).                              |
| `clinicaltrials_find_eligible`         | Match patient demographics to recruiting trials.                                    |

### Resources (1)

| URI Template               | Description                              |
| :------------------------- | :--------------------------------------- |
| `clinicaltrials://{nctId}` | Single study by NCT ID. Full study data. |

### Prompts (1)

| Name                      | Description                                                  |
| :------------------------ | :----------------------------------------------------------- |
| `analyze_trial_landscape` | Guides multi-step trend analysis using count + search tools. |

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Add services** — scaffold the `ClinicalTrialsService` using the `add-service` skill
2. **Add tools/resources/prompts** — scaffold definitions using `add-tool`, `add-resource`, `add-prompt` skills
3. **Add tests** — scaffold tests using the `add-test` skill
4. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill
5. **Run `devcheck`** — lint, format, typecheck, and security audit
6. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
7. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata for shipping
8. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Read-only server.** No `ctx.state` needed — the ClinicalTrials.gov API is stateless and public.
- **Secrets in env vars only** — never hardcoded. (This server has no secrets — public API, no auth.)
- **Rate limit awareness.** The API allows ~1 req/sec. Service layer handles retry/backoff.

---

## Patterns

### Tool

```ts
import { tool, z } from "@cyanheads/mcp-ts-core";
import { getClinicalTrialsService } from "@/services/clinical-trials/clinical-trials-service.js";

export const searchStudies = tool("clinicaltrials_search_studies", {
  description: "Search for clinical trial studies from ClinicalTrials.gov.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    conditionQuery: z.string().optional().describe("Condition/disease search"),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(10)
      .describe("Results per page"),
  }),
  output: z.object({
    studies: z.array(z.record(z.unknown())).describe("Matching studies"),
    totalCount: z.number().optional().describe("Total matching studies"),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const result = await service.searchStudies(
      { conditionQuery: input.conditionQuery, pageSize: input.pageSize },
      ctx,
    );
    ctx.log.info("Search completed", { count: result.studies?.length });
    return result;
  },

  format: (result) => [
    { type: "text", text: `Found ${result.studies.length} studies` },
  ],
});
```

### Resource

```ts
import { resource, z } from "@cyanheads/mcp-ts-core";
import { getClinicalTrialsService } from "@/services/clinical-trials/clinical-trials-service.js";

export const studyResource = resource("clinicaltrials://{nctId}", {
  description: "Fetch a single clinical study by NCT ID.",
  mimeType: "application/json",
  params: z.object({
    nctId: z
      .string()
      .regex(/^NCT\d{8}$/)
      .describe("NCT identifier"),
  }),

  async handler(params, ctx) {
    const service = getClinicalTrialsService();
    return await service.getStudy(params.nctId, ctx);
  },
});
```

### Prompt

```ts
import { prompt, z } from "@cyanheads/mcp-ts-core";

export const analyzeTrialLandscape = prompt("analyze_trial_landscape", {
  description: "Guides systematic analysis of a clinical trial landscape.",
  args: z.object({
    topic: z
      .string()
      .describe("Disease, condition, or research area to analyze"),
    focusAreas: z.array(z.string()).optional().describe("Aspects to analyze"),
  }),
  generate: (args) => [
    {
      role: "user",
      content: {
        type: "text",
        text: `Analyze the trial landscape for: ${args.topic}`,
      },
    },
  ],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from "@cyanheads/mcp-ts-core";

const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .default("https://clinicaltrials.gov/api/v2")
    .describe("ClinicalTrials.gov API base URL"),
  requestTimeoutMs: z.coerce
    .number()
    .default(30000)
    .describe("Per-request timeout in ms"),
  maxPageSize: z.coerce.number().default(200).describe("Maximum page size cap"),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= ServerConfigSchema.parse({
    apiBaseUrl: process.env.CT_API_BASE_URL,
    requestTimeoutMs: process.env.CT_REQUEST_TIMEOUT_MS,
    maxPageSize: process.env.CT_MAX_PAGE_SIZE,
  });
  return _config;
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property        | Description                                                                                                                         |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.log`       | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.signal`    | `AbortSignal` for cancellation.                                                                                                     |
| `ctx.requestId` | Unique request ID.                                                                                                                  |

Note: `ctx.state` is available but unused — this is a stateless read-only server.

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error("Study not found"); // → NotFound
throw new Error("Invalid filter expression"); // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, serviceUnavailable } from "@cyanheads/mcp-ts-core/errors";
throw notFound("Study not found", { nctId });
throw serviceUnavailable(
  "ClinicalTrials.gov API unavailable",
  { url },
  { cause: err },
);

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from "@cyanheads/mcp-ts-core/errors";
throw new McpError(
  JsonRpcErrorCode.ServiceUnavailable,
  "Rate limited by ClinicalTrials.gov",
  { retryAfter: 60 },
);
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # CT_* env vars (Zod schema)
  services/
    clinical-trials/
      clinical-trials-service.ts        # API client (init/accessor pattern)
      types.ts                          # Study, PagedStudies, FieldValueStats, FieldNode types
  mcp-server/
    tools/definitions/
      search-studies.tool.ts            # clinicaltrials_search_studies
      get-study.tool.ts                 # clinicaltrials_get_study
      get-study-results.tool.ts         # clinicaltrials_get_study_results
      get-field-values.tool.ts          # clinicaltrials_get_field_values
      get-field-definitions.tool.ts     # clinicaltrials_get_field_definitions
      get-study-count.tool.ts           # clinicaltrials_get_study_count
      find-eligible.tool.ts             # clinicaltrials_find_eligible
      index.ts                          # allToolDefinitions barrel
    tools/utils/
      query-helpers.ts                  # toArray, buildAdvancedFilter shared helpers
    resources/definitions/
      study.resource.ts                 # clinicaltrials://{nctId}
      index.ts                          # allResourceDefinitions barrel
    prompts/definitions/
      analyze-trial-landscape.prompt.ts # analyze_trial_landscape
      index.ts                          # allPromptDefinitions barrel
```

---

## Naming

| What                       | Convention                                              | Example                                |
| :------------------------- | :------------------------------------------------------ | :------------------------------------- |
| Files                      | kebab-case with suffix                                  | `search-studies.tool.ts`               |
| Tool/resource/prompt names | snake*case with `clinicaltrials*` prefix                | `clinicaltrials_search_studies`        |
| Directories                | kebab-case                                              | `src/services/clinical-trials/`        |
| Descriptions               | Single string or template literal, no `+` concatenation | `'Search for clinical trial studies.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

Available skills:

| Skill                    | Purpose                                                                           |
| :----------------------- | :-------------------------------------------------------------------------------- |
| `setup`                  | Post-init project orientation                                                     |
| `design-mcp-server`      | Design tool surface, resources, and services for a new server                     |
| `add-tool`               | Scaffold a new tool definition                                                    |
| `add-resource`           | Scaffold a new resource definition                                                |
| `add-prompt`             | Scaffold a new prompt definition                                                  |
| `add-service`            | Scaffold a new service integration                                                |
| `add-test`               | Scaffold test file for a tool, resource, or service                               |
| `field-test`             | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass`          | Audit handlers for MCP-specific security gaps (injection, scopes, input sinks)    |
| `devcheck`               | Lint, format, typecheck, audit                                                    |
| `polish-docs-meta`       | Finalize docs, README, metadata, and agent protocol for shipping                  |
| `maintenance`            | Sync skills and dependencies after updates                                        |
| `release-and-publish`    | Post-wrapup ship workflow: verification gate, push, publish to npm/GHCR           |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI       |
| `report-issue-local`     | File a bug or feature request against this server's own repo via `gh` CLI         |
| `api-auth`               | Auth modes, scopes, JWT/OAuth                                                     |
| `api-config`             | AppConfig, parseConfig, env vars                                                  |
| `api-context`            | Context interface, logger, state, progress                                        |
| `api-errors`             | McpError, JsonRpcErrorCode, error patterns                                        |
| `api-linter`             | Definition lint rule reference — look up rule IDs reported by `lint:mcp`/devcheck |
| `api-services`           | LLM, Speech, Graph services                                                       |
| `api-testing`            | createMockContext, test patterns                                                  |
| `api-utils`              | Formatting, parsing, security, pagination, scheduling                             |
| `api-workers`            | Cloudflare Workers runtime                                                        |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command               | Purpose                              |
| :-------------------- | :----------------------------------- |
| `bun run build`       | Compile TypeScript                   |
| `bun run rebuild`     | Clean + build                        |
| `bun run devcheck`    | Lint + format + typecheck + security |
| `bun run tree`        | Generate directory structure doc     |
| `bun run format`      | Auto-fix formatting                  |
| `bun run test`        | Run tests (Vitest)                   |
| `bun run dev:stdio`   | Dev mode (stdio)                     |
| `bun run dev:http`    | Dev mode (HTTP)                      |
| `bun run start:stdio` | Production mode (stdio)              |
| `bun run start:http`  | Production mode (HTTP)               |
| `bun run inspector`   | Launch MCP Inspector                 |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |

---

## Publishing

Run the `release-and-publish` skill after the git wrapup (version bumps, CHANGELOG, commit, tag) is complete. It runs the verification gate (`devcheck`, `rebuild`, `test`), pushes commits and tags, then publishes to npm and GHCR — halting on the first non-zero exit. Reference commands:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/clinicaltrialsgov-mcp-server:<version> \
  -t ghcr.io/cyanheads/clinicaltrialsgov-mcp-server:latest \
  --push .
```

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from "@cyanheads/mcp-ts-core";
import { McpError, JsonRpcErrorCode } from "@cyanheads/mcp-ts-core/errors";
import { notFound, serviceUnavailable } from "@cyanheads/mcp-ts-core/errors";

// Server's own code — via path alias
import { getClinicalTrialsService } from "@/services/clinical-trials/clinical-trials-service.js";
import { getServerConfig } from "@/config/server-config.js";
```

---

## Config

| Env Var                      | Required | Default                             | Description                              |
| :--------------------------- | :------- | :---------------------------------- | :--------------------------------------- |
| `CT_API_BASE_URL`            | No       | `https://clinicaltrials.gov/api/v2` | API base URL override                    |
| `CT_REQUEST_TIMEOUT_MS`      | No       | `30000`                             | Per-request timeout in ms                |
| `CT_MAX_PAGE_SIZE`           | No       | `200`                               | Maximum page size cap                    |

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for request-scoped logging, no `console` calls
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
