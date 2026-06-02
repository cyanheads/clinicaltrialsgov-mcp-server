# Agent Protocol

**Server:** clinicaltrialsgov-mcp-server
**Version:** 2.5.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
**Engines:** Bun ≥1.3.0, Node ≥24.0.0

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

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Read-only server.** No `ctx.state` needed — the ClinicalTrials.gov API is stateless and public.
- **Secrets in env vars only** — never hardcoded. (This server has no secrets — public API, no auth.)
- **Rate limit awareness.** The API allows ~1 req/sec. Service layer handles retry/backoff.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

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
import { parseEnvConfig } from "@cyanheads/mcp-ts-core/config";

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
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: "CT_API_BASE_URL",
    requestTimeoutMs: "CT_REQUEST_TIMEOUT_MS",
    maxPageSize: "CT_MAX_PAGE_SIZE",
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`CT_API_BASE_URL`) rather than the internal path (`apiBaseUrl`).

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

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata (≥ 5 words, lint-validated); for the wire payload's `data.recovery.hint` (which the framework mirrors into `content[]` text), spread `ctx.recoveryFor('reason')` for the contract default, or pass `{ recovery: { hint: '...' } }` explicitly when dynamic context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from "@cyanheads/mcp-ts-core/errors";

errors: [
  { reason: "path_not_found", code: JsonRpcErrorCode.NotFound,
    when: "Field path doesn't match the data model tree",
    recovery: "Call clinicaltrials_get_field_definitions with no path to see top-level sections." },
],
async handler(input, ctx) {
  const node = navigateToPath(tree, input.path);
  if (!node) throw ctx.fail("path_not_found", `Path '${input.path}' not found`);
  return { node };
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture. Don't extract a shared `errors[]` constant or contract module to deduplicate; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** factories or plain `Error`.

```ts
// Error factories — explicit code, concise
import { notFound, serviceUnavailable } from "@cyanheads/mcp-ts-core/errors";
throw notFound("Study not found", { nctId });
throw serviceUnavailable(
  "ClinicalTrials.gov API unavailable",
  { url },
  { cause: err },
);

// Plain Error — framework auto-classifies from message patterns
throw new Error("Study not found"); // → NotFound

// HTTP errors from upstream — use httpErrorFromResponse for status-aware classification
import { httpErrorFromResponse } from "@cyanheads/mcp-ts-core/utils";
throw await httpErrorFromResponse(res, { service: "ClinicalTrials.gov" });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

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

**Agent skill directory:** Claude Code discovers skills at `.claude/skills/`. The `maintenance` skill re-syncs this directory from `skills/` automatically (Phase B) after framework updates.

Available skills:

| Skill                    | Purpose                                                                                    |
| :----------------------- | :----------------------------------------------------------------------------------------- |
| `setup`                  | Post-init project orientation                                                              |
| `design-mcp-server`      | Design tool surface, resources, and services for a new server                              |
| `add-tool`               | Scaffold a new tool definition                                                             |
| `add-app-tool`           | Scaffold an MCP App tool + paired UI resource                                              |
| `add-resource`           | Scaffold a new resource definition                                                         |
| `add-prompt`             | Scaffold a new prompt definition                                                           |
| `add-service`            | Scaffold a new service integration                                                         |
| `add-test`               | Scaffold test file for a tool, resource, or service                                        |
| `field-test`             | Exercise tools/resources/prompts with real inputs, verify behavior, report issues          |
| `security-pass`          | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `tool-defs-analysis`     | Audit definition language across the surface (voice, leaks, recovery, cross-refs)         |
| `code-simplifier`        | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck`               | Lint, format, typecheck, audit                                                             |
| `polish-docs-meta`       | Finalize docs, README, metadata, and agent protocol for shipping                           |
| `maintenance`            | Investigate changelogs, adopt upstream changes, sync skills to agent dirs                  |
| `git-wrapup`             | Version bump, changelog, commit, and annotated tag — local only, stops before push        |
| `release-and-publish`    | Post-wrapup ship workflow: verification gate, push, publish to npm/GHCR                    |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI               |
| `report-issue-local`     | File a bug or feature request against this server's own repo via `gh` CLI                  |
| `api-auth`               | Auth modes, scopes, JWT/OAuth                                                              |
| `api-canvas`             | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror`             | MirrorService: persistent SQLite-backed local mirror of a bulk upstream dataset — Tier 3 opt-in |
| `api-config`             | AppConfig, parseConfig, env vars                                                           |
| `api-context`            | Context interface, logger, state, progress                                                 |
| `api-errors`             | McpError, JsonRpcErrorCode, error patterns, typed contracts                                |
| `api-linter`             | Definition lint rule reference — look up rule IDs reported by `lint:mcp`/devcheck         |
| `api-services`           | LLM, Speech, Graph services                                                                |
| `api-telemetry`          | OTel catalog: spans, metrics, completion logs, env config, cardinality rules               |
| `api-testing`            | createMockContext, test patterns                                                           |
| `api-utils`              | Formatting, parsing, security, pagination, scheduling, telemetry helpers                   |
| `api-workers`            | Cloudflare Workers runtime                                                                 |
| `orchestrations`         | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command                   | Purpose                                                       |
| :------------------------ | :------------------------------------------------------------ |
| `bun run build`           | Compile TypeScript                                            |
| `bun run rebuild`         | Clean + build                                                 |
| `bun run devcheck`        | Lint + format + typecheck + security + changelog sync         |
| `bun run tree`            | Generate directory structure doc                              |
| `bun run format`          | Auto-fix formatting                                           |
| `bun run test`            | Run tests (Vitest)                                            |
| `bun run start:stdio`     | Production mode (stdio)                                       |
| `bun run start:http`      | Production mode (HTTP)                                        |
| `bun run inspector`       | Launch MCP Inspector                                          |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md`               |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck)           |
| `bun run bundle`          | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run audit:refresh`   | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series using the `.x` semver-wildcard convention. Source of truth is `changelog/<major.minor>.x/<version>.md` — one file per released version. At release time, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited, never renamed, never moved. `CHANGELOG.md` is a **navigation index** (header + link + one-line summary per version), regenerated by `bun run changelog:build`. Devcheck runs `changelog:check` and hard-fails on drift. Never hand-edit `CHANGELOG.md` — edit the per-version file and rerun the build.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 2.4.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Omit entirely when there's nothing to say.

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for request-scoped logging, no `console` calls
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Raw/domain/output schemas reviewed against real ClinicalTrials.gov sparsity/nullability before finalizing required vs optional fields
- [ ] Normalization and `format()` preserve uncertainty — do not fabricate facts from missing upstream data
- [ ] Tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
