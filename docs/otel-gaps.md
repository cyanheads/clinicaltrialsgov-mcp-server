# OpenTelemetry Architecture & Known Limitations

How OTel instrumentation works in this server, what the Bun runtime means for it, and what's left out.

## Instrumentation Overview

The server emits telemetry through three paths:

| Path | What it produces | Durable (survives restart) |
|------|-----------------|:-:|
| `@hono/otel` middleware ([httpTransport.ts](../src/mcp-server/transports/http/httpTransport.ts)) | `http.server.request.duration` histogram, `http.server.active_requests` counter | Yes |
| `measureToolExecution` in [performance.ts](../src/utils/internal/performance.ts) | `mcp.tool.calls` counter, `mcp.tool.duration` histogram, tool execution trace spans | Yes |
| `logger.info('Tool execution finished.')` in [performance.ts](../src/utils/internal/performance.ts) | Structured JSON to stdout with per-call detail (payload sizes, memory deltas) | No |
| Node SDK auto-instrumentation ([instrumentation.ts](../src/utils/telemetry/instrumentation.ts)) | `nodejs.eventloop.*` gauges | Yes |

All OTel data flows through `BatchSpanProcessor` / `PeriodicExportingMetricReader` → OTLP HTTP exporter → external collector.

## OTel Metrics Inventory

| Metric | Type | Attributes | Added |
|--------|------|-----------|-------|
| `mcp.tool.calls` | Counter (monotonic) | `mcp.tool.name`, `mcp.tool.success` | v1.9.1 |
| `mcp.tool.duration` | Histogram (ms) | `mcp.tool.name` | v1.9.1 |
| `mcp.sessions.active` | Observable gauge | — | v1.9.1 (stateful mode only) |
| `http.server.request.duration` | Histogram (s) | `http.request.method`, `http.route`, `http.response.status_code` | v1.0 |
| `http.server.active_requests` | UpDownCounter | `http.request.method` | v1.0 |
| `nodejs.eventloop.delay.*` | Gauge | — | v1.0 |
| `nodejs.eventloop.utilization` | Gauge | — | v1.0 |

## Bun Runtime Implications

The server runs on Bun, which implements a large subset of Node.js APIs but not the internal `http` module hooks that `@opentelemetry/instrumentation-http` relies on.

**What happens:** The OTel Node SDK initializes (Bun sets `process.versions.node` for compat), but `instrumentation-http`'s monkey-patching silently no-ops because Hono uses Bun's native HTTP server, not Node's `http.createServer`.

**What fills the gap:** `@hono/otel`'s `httpInstrumentationMiddleware` creates manual spans with `http.request.method`, `http.route`, and `http.response.status_code` attributes. This produces the `http.server.request.duration` histogram.

**What else is affected:** V8 heap metrics error out (Bun doesn't run V8). Event loop metrics (`nodejs.eventloop.*`) do work through Bun's `perf_hooks` compatibility layer.

This is the expected degradation path — not a bug. The instrumentations that work, work. The ones that don't, silently fail. The `@hono/otel` middleware covers the HTTP gap explicitly.

## What's Not in OTel

| Data | Where it lives | Why |
|------|---------------|-----|
| Session counts (stateless mode) | Container logs only (`grep "Initializing MCP server instance"`) | `mcp.sessions.active` gauge only registers when `SessionStore` exists (stateful mode). In stateless mode there's no session store, so there's nothing to gauge. |
| Per-call payload sizes | Container logs (`metrics.inputBytes`, `metrics.outputBytes`) | Not added as OTel attributes/metrics. The aggregates (count, latency, success) are in OTel; payload detail is forensic. |
| Per-call memory deltas | Container logs (`metrics.memory.rss.delta`) | Same — forensic detail, not aggregated. |
| Upstream API latency breakdown | Nowhere | Tool spans are atomic. No child spans for ClinicalTrials.gov API calls within each tool. Total duration is tracked but can't be decomposed. |
