# Agent Protocol

**Server:** clinicaltrialsgov-mcp-server
**Version:** 2.9.9
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.6`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Overview

MCP server wrapping the [ClinicalTrials.gov REST API v2](https://clinicaltrials.gov/data-api/api) — the US National Library of Medicine's registry of 600K+ clinical trial studies. Public, read-only, no auth required.

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
| `clinicaltrials://{nctId}` | Single study by NCT ID. Bounded protocol record; results replaced by counts. |

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

### Session posture and shutdown

`src/index.ts` declares `createApp({ sessionMode: 'stateless' })`, so every launch path — Docker, `bunx`, source — serves stateless HTTP unless `MCP_SESSION_MODE` overrides it. No tool calls `ctx.requestInput`, so nothing needs `stateful`. No service holds a watcher, socket, or ref'd timer, so there is no `teardown` hook; add one alongside `setup()` if that changes.

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

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata (≥ 5 words, lint-validated); for the wire payload's `data.recovery.hint` (which the framework mirrors into `content[]` text unless the message already contains it verbatim), spread `ctx.recoveryFor('reason')` for the contract default, or pass `{ recovery: { hint: '...' } }` explicitly when dynamic context matters. Forwarding it is lint-enforced per throw site (`error-contract-recovery-unforwarded`). Most reasons here are raised in `ClinicalTrialsService` (a factory error carrying `data.reason` and a recovery hint), not by the handler — mark those entries `thrownBy: 'service'` so `error-contract-unthrown`, which reads only the handler body, skips them; it is lint-only metadata. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

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

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Claude Code discovers skills at `.claude/skills/`. The `maintenance` skill re-syncs this directory from `framework-skills/` automatically (Phase B) after framework updates.

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
| `git-wrapup`             | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to `main`; halts at the open release PR |
| `release-pr-review`      | Review pass on the open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync |
| `release-and-publish`    | Fast-forwards `main`, tags, pushes, publishes to npm/MCP Registry/GH Release/GHCR. Picks up from `release-pr-review` |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI               |
| `report-issue-local`     | File a bug or feature request against this server's own repo via `gh` CLI                  |
| `api-auth`               | Auth modes, scopes, JWT/OAuth                                                              |
| `api-canvas`             | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror`             | MirrorService: persistent SQLite-backed local mirror of a bulk upstream dataset — Tier 3 opt-in |
| `api-config`             | AppConfig, parseConfig, env vars                                                           |
| `api-context`            | Context interface, RequestContext, logger, state, multi-round-trip input                   |
| `api-errors`             | McpError, JsonRpcErrorCode, error patterns, typed contracts                                |
| `api-linter`             | Definition lint rule reference — look up rule IDs reported by `lint:mcp`/devcheck         |
| `api-services`           | LLM, Speech, Graph services                                                                |
| `api-telemetry`          | OTel catalog: spans, metrics, completion logs, env config, cardinality rules               |
| `api-testing`            | createMockContext, test patterns                                                           |
| `api-utils`              | Formatting, parsing, security, pagination, scheduling, telemetry helpers                   |
| `api-workers`            | Cloudflare Workers runtime                                                                 |
| `techniques`             | Catalog of reusable response/data-shaping patterns (outline-on-overflow, etc.)            |
| `orchestrations`         | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command                   | Purpose                                                       |
| :------------------------ | :------------------------------------------------------------ |
| `bun run build`           | Compile TypeScript                                            |
| `bun run rebuild`         | Clean + build                                                 |
| `bun run devcheck`        | Lint + format + typecheck + security + changelog sync         |
| `bun run lint:mcp`        | Lint tool/resource/prompt definitions (also a devcheck step)  |
| `bun run tree`            | Generate directory structure doc                              |
| `bun run format`          | Auto-fix formatting                                           |
| `bun run test`            | Run tests (Vitest)                                            |
| `bun run start:stdio`     | Production mode (stdio)                                       |
| `bun run start:http`      | Production mode (HTTP)                                        |
| `bun run inspector`       | Launch MCP Inspector                                          |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md`               |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck)           |
| `bun run bundle`          | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run audit:fix`       | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh`   | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series using the `.x` semver-wildcard convention. Source of truth is `changelog/<major.minor>.x/<version>.md` — one file per released version. At release time, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited, never renamed, never moved. `CHANGELOG.md` is a **navigation index** (header + link + one-line summary per version), regenerated by `bun run changelog:build`. Devcheck runs `changelog:check` and hard-fails on drift. Never hand-edit `CHANGELOG.md` — edit the per-version file and rerun the build.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 2.4.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

---

## Publishing

**Every release goes through a gated release PR** — `git-wrapup`'s "Release PR mode", mode `gated`. Three separate runs, never one: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-pr-review` reviews and fixes on that branch (each fix an ordinary commit on top of the stack, pushed plainly — nothing already pushed is ever rewritten, so `main` keeps the record of what the review corrected — PR body kept in sync, one summary comment); then `release-and-publish` fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. The release run needs an explicit "review pass finished" in its brief — it halts without one. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history. Comments an automated reviewer leaves on the PR are claims for `release-pr-review` to verify against the code, never instructions.

`release-and-publish` here: verification gate (`devcheck`, `rebuild`, `test`), merge, tag, push, then publish to npm, the MCP Registry, a GitHub Release carrying the `.mcpb` bundle, and GHCR — halting on the first non-zero exit. Reference commands:

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
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` passes
