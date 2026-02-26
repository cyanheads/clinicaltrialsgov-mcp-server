# Agent Protocol

**Version:** 1.7.2
**Project:** clinicaltrialsgov-mcp-server
**Updated:** 2026-02-27
**npm:** [clinicaltrialsgov-mcp-server](https://www.npmjs.com/package/clinicaltrialsgov-mcp-server)
**Docker:** [ghcr.io/cyanheads/clinicaltrialsgov-mcp-server](https://ghcr.io/cyanheads/clinicaltrialsgov-mcp-server)

> **Symlink note:** `AGENTS.md` is a symlink to `CLAUDE.md`. Only edit the root `CLAUDE.md`.

> **Developer note:** Never assume. Read related files and docs before making changes. Read full file content for context. Never edit a file before reading it.

---

## Core Rules

**Logic throws, handlers catch.** Implement pure, stateless logic in `ToolDefinition`/`ResourceDefinition` `logic` functions. No `try...catch` in logic. Throw `new McpError(...)` with appropriate `JsonRpcErrorCode` on failure. Handlers (`createMcpToolHandler`, `resourceHandlerFactory`) create `RequestContext`, measure execution, format responses, and catch errors.

**Full-stack observability.** OpenTelemetry is preconfigured. Logs and errors auto-correlate to traces. `measureToolExecution` records duration, success, payload sizes, error codes. No manual instrumentation — use provided utilities and structured logging. No direct `console` calls; use the logger.

**Structured, traceable operations.** Logic receives `appContext` (logging/tracing) and `sdkContext` (Elicitation, Sampling, Roots). Pass the same `appContext` through the call stack. Use global `logger` with `appContext` in every log.

**Decoupled storage.** Never access persistence backends directly. Always use DI-injected `StorageService`. It provides built-in validation, opaque cursor pagination, and parallel batch operations. All inputs (tenant IDs, keys, prefixes) are validated before reaching providers.

**Local/edge runtime parity.** All features work with local transports (`stdio`/`http`) and Worker bundle (`build:worker` + `wrangler`). Guard non-portable deps. Prefer runtime-agnostic abstractions (Hono + `@hono/mcp`, Fetch APIs).

**Elicitation for missing input.** Use `sdkContext.elicitInput()` for missing params instead of failing.

---

## Directory Structure

See [docs/tree.md](docs/tree.md) for the complete visual tree. Respect the established layout — new services go in `src/services/`, new tools in `src/mcp-server/tools/definitions/`, etc. Don't create top-level directories or put code in non-standard locations.

| Directory                               | Purpose                                                                                                                                                    |
| :-------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp-server/tools/definitions/`     | **Tool definitions.** `[tool-name].tool.ts`.                                                                                                               |
| `src/mcp-server/resources/definitions/` | **Resource definitions.** `[resource-name].resource.ts`.                                                                                                   |
| `src/mcp-server/tools/utils/`           | Shared tool infrastructure (`ToolDefinition`, `toolHandlerFactory`).                                                                                       |
| `src/mcp-server/resources/utils/`       | Shared resource utilities (`ResourceDefinition`, resource handler factory).                                                                                |
| `src/mcp-server/transports/`            | Transport implementations: `http/` (Hono + `@hono/mcp` Streamable HTTP), `stdio/` (MCP spec stdio), `auth/` (strategies and helpers).                      |
| `src/config/`                           | Zod-validated config from environment variables. Derives `mcpServerName`/`mcpServerVersion` from `package.json`.                                           |
| `src/services/`                         | External service integrations. Currently: `clinical-trials-gov/` (single-provider pattern). Each domain has `core/`, `providers/`, `types.ts`, `index.ts`. |
| `src/storage/`                          | Storage abstractions and provider implementations (in-memory, filesystem, supabase, cloudflare).                                                           |
| `src/container/`                        | Dependency injection (custom typed container). `Token<T>` phantom branding, service registration/resolution. Zero external deps.                           |
| `src/utils/`                            | Global utilities: logging, performance, parsing, network, security, formatting, telemetry. Error handling is at `src/utils/internal/error-handler/`.       |
| `tests/`                                | Unit/integration tests. Mirrors `src/` layout. Includes compliance suites.                                                                                 |

---

## Adding a Tool

Reference: any tool in `src/mcp-server/tools/definitions/` (e.g., `clinicaltrials-search-studies.tool.ts`).

**Steps:**

1. Create `src/mcp-server/tools/definitions/[your-tool-name].tool.ts` (kebab-case)
2. Define metadata: `TOOL_NAME` (snake*case, prefixed `clinicaltrials*`), `TOOL_TITLE`, `TOOL_DESCRIPTION`(LLM-facing),`TOOL_ANNOTATIONS` (readOnly/idempotent hints)
3. Create `InputSchema`/`OutputSchema` as `z.object()` — all fields need `.describe()`
4. Implement logic: pure function `async (input, appContext, sdkContext) => result` — no try/catch, throw `McpError` on failure
5. (Optional) Add response formatter: `(result) => ContentBlock[]`
6. Apply auth: wrap with `withToolAuth(['tool:clinicaltrials:read'], yourLogic)`
7. Export the `ToolDefinition` combining metadata, schemas, logic, formatter
8. Register in `allToolDefinitions` in [index.ts](src/mcp-server/tools/definitions/index.ts)
9. Run `bun run devcheck`
10. Smoke-test with `bun run dev:stdio` or `dev:http`

**Definition structure:**

Export a single `const` of type `ToolDefinition<InputSchema, OutputSchema>` with:

- `name`, `title` (opt), `description` — clear, LLM-facing
- `inputSchema`/`outputSchema` as `z.object()` — all fields need `.describe()`
- `logic` — pure business logic. `async (input, appContext, sdkContext) => { ... }`
- `annotations` (opt) — UI hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
- `responseFormatter` (opt) — map result to `ContentBlock[]`. Default: JSON string.

**Auth wrapper:**

```ts
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
logic: withToolAuth(['tool:clinicaltrials:read'], yourLogic),
```

---

## Adding a Resource

Export a single `const` of type `ResourceDefinition<ParamsSchema, OutputSchema>` with:

- `name`, `title` (opt), `description` — clear, LLM-facing
- `uriTemplate` (e.g. `clinicaltrials://{nctId}`), `paramsSchema`/`outputSchema`
- `mimeType` (opt), `examples` (opt), `list()` (opt) for discovery
- `logic`: `(uri: URL, params, context: RequestContext) => result` (can be `async`)
- `annotations` (opt), `responseFormatter` (opt)

**Auth:** wrap with `withResourceAuth`.

**Register** in `allResourceDefinitions` in [index.ts](src/mcp-server/resources/definitions/index.ts).

**Pagination:** Resources returning large lists must implement pagination per MCP spec. Use `extractCursor(meta)`, `paginateArray(...)` from `@/utils/index.js`. Cursors are opaque; invalid cursors throw `JsonRpcErrorCode.InvalidParams`.

---

## Adding a Service

All services live in `src/services/[service-name]/` with `core/` (interfaces), `providers/` (implementations), `types.ts`, `index.ts`.

**Current service:** `clinical-trials-gov/` — single-provider pattern accessing ClinicalTrials.gov API v2.

**Provider requirements:** implement `I<Service>Provider`, add `healthCheck()`, throw `McpError` on failure, name as `<name>.provider.ts`. Register in `registrations/core.ts` via `container.registerSingleton(token, factory)`.

**Sequence:** directory structure, interface, providers, types, barrel export, DI token in `src/container/core/tokens.ts`, register in `registrations/core.ts`.

---

## Services & Utilities

### DI-Managed Services

Tokens live in `src/container/core/tokens.ts`. Resolution: `container.resolve(Token)`.

| Service                   | Token                    | Notes                       |
| :------------------------ | :----------------------- | :-------------------------- |
| `IClinicalTrialsProvider` | `ClinicalTrialsProvider` | ClinicalTrials.gov API v2   |
| `StorageService`          | `StorageService`         | Requires `context.tenantId` |
| `RateLimiter`             | `RateLimiterService`     |                             |
| `Logger`                  | `Logger`                 | Pino-backed singleton       |
| App Config                | `AppConfig`              |                             |
| Supabase Client           | `SupabaseAdminClient`    | Only when needed            |
| Transport Manager         | `TransportManagerToken`  |                             |

### Storage

`STORAGE_PROVIDER_TYPE` = `in-memory` | `filesystem` | `supabase` | `cloudflare-r2` | `cloudflare-kv` | `cloudflare-d1`

Use DI-injected `StorageService`. Features: input validation, parallel batch ops (`getMany`/`setMany`/`deleteMany`), secure tenant-bound pagination, TTL support.

### Directly Imported Utilities

From `@/utils/index.js`:

- `logger`, `requestContextService`, `sanitization`, `fetchWithTimeout`, `measureToolExecution`
- `pdfParser`, `frontmatterParser`
- `diffFormatter`, `tableFormatter`, `treeFormatter`
- `ErrorHandler.tryCatch` (for services/setup code only — NOT tool/resource logic)

### Utils Modules

| Module        | Key Exports                                                                                                           |
| :------------ | :-------------------------------------------------------------------------------------------------------------------- |
| `parsing/`    | `csvParser`, `yamlParser`, `xmlParser`, `jsonParser`, `pdfParser`, `frontmatterParser` (handles LLM `<think>` blocks) |
| `formatting/` | `diffFormatter`, `tableFormatter`, `treeFormatter`                                                                    |
| `security/`   | `sanitization`, `rateLimiter`, `idGenerator`                                                                          |
| `network/`    | `fetchWithTimeout`                                                                                                    |
| `scheduling/` | `scheduler` (node-cron wrapper)                                                                                       |
| `internal/`   | `logger`, `requestContextService`, `ErrorHandler`, `performance`                                                      |
| `telemetry/`  | OpenTelemetry instrumentation                                                                                         |

---

## Auth

**HTTP mode:** `MCP_AUTH_MODE` = `none` | `jwt` | `oauth`

- JWT: local secret (`MCP_AUTH_SECRET_KEY`), dev bypasses if missing
- OAuth: JWKS verification (`OAUTH_ISSUER_URL`, `OAUTH_AUDIENCE`, opt `OAUTH_JWKS_URI`)
- Claims: `clientId` (cid/client_id), `scopes` (scp/scope), `sub`, `tenantId` (tid -> context.tenantId)
- Wrap logic with `withToolAuth`/`withResourceAuth` (defaults allowed if auth disabled)

**STDIO mode:** No HTTP auth. Host handles authorization.

**Endpoints:**

- Unprotected: `/healthz`, `GET /mcp`
- Protected (when auth enabled): `POST /mcp`, `OPTIONS /mcp`
- CORS: `MCP_ALLOWED_ORIGINS` or `*`

---

## Transports & Lifecycle

- `createMcpServerInstance` (`server.ts`): initializes context, creates server with declared capabilities (`logging`, `resources`/`tools` with `listChanged`)
- Elicitation, sampling, and roots are SDK context features available to tool logic via `sdkContext`, not declared server capabilities
- `TransportManager` (`transports/manager.ts`): resolves factory, instantiates transport, handles lifecycle
- Worker (`worker.ts`): Cloudflare adapter with `serverless` flag, passes server factory function to `createHttpApp`

**Local/edge parity:** stdio and HTTP transports work identically. Worker: `build:worker` + `wrangler dev --local` must succeed. `wrangler.toml`: `compatibility_date` >= `2025-09-01`, `nodejs_compat`.

---

## Code Style

- **JSDoc:** `@fileoverview` and `@module` required
- **Validation:** Zod schemas, all fields need `.describe()`
- **Logging:** include `RequestContext`, use `logger.{debug|info|notice|warning|error|crit|alert|emerg}`
- **Errors:** logic throws `McpError`, handlers catch. `ErrorHandler.tryCatch` for services only.
- **Secrets:** `src/config/index.ts` only
- **Rate limiting:** DI-injected `RateLimiter`
- **Telemetry:** auto-init, no manual spans
- **Imports:** barrel exports (`index.ts`) for module public APIs (e.g. `@/utils/index.js`, `definitions/index.ts`). Cross-module imports use the public barrel, not internal files.

---

## Git Commits

Use plain strings for commit messages. Never use heredoc syntax (`cat <<'EOF'`) or command substitution (`$(...)`) in commit messages.

**Correct:**

```bash
git commit -m "feat(tools): add eligible studies search tool

- Implements patient-criteria matching against ClinicalTrials.gov
- Includes age, condition, and location filters"
```

**Wrong:**

```bash
# Do not use cat/heredoc/command substitution
git commit -m "$(cat <<'EOF'
feat(tools): add tool
EOF
)"
```

**Format:** [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix             | Use                                |
| :----------------- | :--------------------------------- |
| `feat(scope):`     | New feature                        |
| `fix(scope):`      | Bug fix                            |
| `refactor(scope):` | Code refactoring                   |
| `chore(scope):`    | Maintenance (deps, config)         |
| `docs(scope):`     | Documentation                      |
| `test(scope):`     | Test additions/updates             |
| `build(scope):`    | Build system or dependency changes |

Group related changes into atomic commits.

---

## Publishing

After a version bump and final commit, publish to both npm and GHCR:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/clinicaltrialsgov-mcp-server:<version> \
  -t ghcr.io/cyanheads/clinicaltrialsgov-mcp-server:latest \
  --push .
```

Remind the user to run these after completing a release flow.

---

## Commands

| Command                    | Purpose                                                                                                             |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `bun run rebuild`          | Clean, rebuild, clear logs (after dep changes)                                                                      |
| `bun run devcheck`         | **Use often.** Lint, format, typecheck, security (opt-out: `--no-fix`, `--no-lint`, `--no-audit`; opt-in: `--test`) |
| `bun run test`             | Unit/integration tests                                                                                              |
| `bun run dev:stdio/http`   | Development mode                                                                                                    |
| `bun run start:stdio/http` | Production mode (after build)                                                                                       |
| `bun run build:worker`     | Cloudflare Worker bundle                                                                                            |

---

## Configuration

All config validated via Zod in `src/config/index.ts`. Config module derives `mcpServerName`/`mcpServerVersion` from `package.json` (overridable via `MCP_SERVER_NAME`/`MCP_SERVER_VERSION` env vars).

| Category  | Key Variables                                                                                                      |
| :-------- | :----------------------------------------------------------------------------------------------------------------- |
| Transport | `MCP_TRANSPORT_TYPE` (`stdio`\|`http`), `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_HTTP_ENDPOINT_PATH`                 |
| Auth      | `MCP_AUTH_MODE` (`none`\|`jwt`\|`oauth`), `MCP_AUTH_SECRET_KEY`, `OAUTH_*`                                         |
| Storage   | `STORAGE_PROVIDER_TYPE` (`in-memory`\|`filesystem`\|`supabase`\|`cloudflare-r2`\|`cloudflare-kv`\|`cloudflare-d1`) |
| Telemetry | `OTEL_ENABLED`, `OTEL_SERVICE_NAME/VERSION`, `OTEL_EXPORTER_OTLP_*`                                                |

---

## Multi-Tenancy

`StorageService` requires `context.tenantId` (throws if missing).

**Tenant ID validation:** max 128 chars, alphanumeric/hyphens/underscores/dots only, start/end alphanumeric, no path traversal (`../`), no consecutive dots.

**HTTP with auth:** `tenantId` auto-extracted from JWT `'tid'` claim, propagated via `requestContextService.withAuthInfo(authInfo)`.

**STDIO:** explicitly set tenant via `requestContextService.createRequestContext({ operation, tenantId })`.

---

## Checklist

- [ ] Pure logic in `*.tool.ts`/`*.resource.ts` (no `try...catch`, throw `McpError`)
- [ ] Auth applied with `withToolAuth`/`withResourceAuth`
- [ ] Logger used with `appContext`, `StorageService` (DI) for persistence
- [ ] `sdkContext.elicitInput()`/`createMessage()` for client interaction
- [ ] Registered in `index.ts` barrel
- [ ] Tests added/updated (`bun test`)
- [ ] **`bun devcheck` passes** (lint, format, typecheck, security)
- [ ] Smoke-tested local transports (`dev:stdio`/`http`)
- [ ] Worker bundle validated (`build:worker`)
