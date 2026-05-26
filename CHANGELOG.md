# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [2.5.1](changelog/2.5.x/2.5.1.md) — 2026-05-25

mcp-ts-core ^0.9.6 → ^0.9.9 (git-wrapup skill, release artifact verification, tag annotation format)

## [2.5.0](changelog/2.5.x/2.5.0.md) — 2026-05-25

get_field_definitions mode discriminator, enum error translation, funnel-aware no-match hints, transport framing removed from get_study_record description

## [2.4.12](changelog/2.4.x/2.4.12.md) — 2026-05-23

mcp-ts-core ^0.9.1 → ^0.9.6, zod added as direct dep, manifest.json + .mcpbignore scaffolded for MCPB bundle support, install badges added to README.

## [2.4.11](changelog/2.4.x/2.4.11.md) — 2026-05-21

Description hardening — `advancedFilter` anchors `AREA[FieldName]value` with composition examples ([#47](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/issues/47)); `path_not_found` hint on `clinicaltrials_get_field_definitions` promotes `query` mode ([#48](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/issues/48)).

## [2.4.10](changelog/2.4.x/2.4.10.md) — 2026-05-20

Fix `clinicaltrials_get_study_record` surface divergence ([#46](https://github.com/cyanheads/clinicaltrialsgov-mcp-server/issues/46)) — `locationLimit` / `outcomeLimit` / `nearLocation` now trim both surfaces identically, defaults flip to no cap, upstream totals surface in `filtersApplied`.

## [2.4.9](changelog/2.4.x/2.4.9.md) — 2026-05-20

Auto-normalize case/whitespace field-name mistakes (#44), surface Essie query parse errors with recovery hints (#34, #39), add locationLimit/outcomeLimit/nearLocation render controls on get_study_record (#40), and lift topAnalysis (p-value, CI, method) into get_study_results summary mode (#42).

## [2.4.8](changelog/2.4.x/2.4.8.md) — 2026-05-16

Framework 0.8.20 → 0.9.1: adopt server-level `instructions` on `createApp` (spec orientation text broadcast on `initialize`), summary cap 250 → 350 chars, `bun outdated` parser fix for markdown-style rows, skill resyncs including the new portability lint family in `api-linter`.

## [2.4.7](changelog/2.4.x/2.4.7.md) — 2026-05-10

Framework 0.8.14 → 0.8.20, engines bumped to Bun ≥1.3 / Node ≥24, search/count format() renders array criteria as [a, b], fuzz coverage for 3 tools, new api-telemetry skill, template-fork dep cleanup.

## [2.4.6](changelog/2.4.x/2.4.6.md) — 2026-05-04

search_studies fields description hardened against Sponsor/*List hallucinations; three tool descriptions anchor on "clinical trial"; framework bumped to 0.8.14 with skill sync.

## [2.4.5](changelog/2.4.x/2.4.5.md) — 2026-05-03

find_eligible adds match-prioritized location sort + 3-stage funnel diagnostics; search/count default-filter the EnrollmentCount=99999999 sentinel; search format() lifts truncation cap when fields is explicit.

## [2.4.4](changelog/2.4.x/2.4.4.md) — 2026-05-03

Polish LLM-facing definition language — flatten `clinicaltrials_get_field_definitions` description, enrich opaque output schemas in search/get-study/get-study-results, expand landscape prompt to all relevant tools.

## [2.4.3](changelog/2.4.x/2.4.3.md) — 2026-05-03

Field-name validation cache + did-you-mean suggestions (fixes #35); new `query` mode in `clinicaltrials_get_field_definitions`; typed error contracts on every tool/resource; framework 0.7.6 → 0.8.13

## [2.4.2](changelog/2.4.x/2.4.2.md) — 2026-04-27

Bump @cyanheads/mcp-ts-core 0.7.0 → 0.7.6, resync 7 skills and 1 script (+ 1 new), adopt 0.7.4 form-client safety guidance in CLAUDE.md/AGENTS.md checklist

## [2.4.1](changelog/2.4.x/2.4.1.md) — 2026-04-24

Bump @cyanheads/mcp-ts-core 0.6.17 → 0.7.0, resync 5 skills and 2 framework scripts, adopt expanded CLAUDE.md/AGENTS.md checklist and Changelog/Agent-skill-dir callouts

## [2.4.0](changelog/2.4.x/2.4.0.md) — 2026-04-24 · ⚠️ Breaking

Uppercase `find_eligible.sex` enum (breaking); specific offending-field error on field-values 404; directory-based changelog; new `security-pass` skill; framework 0.6.17

## [2.3.5](changelog/2.3.x/2.3.5.md) — 2026-04-23

Adopt `rateLimited()` error factory; document `MCP_PUBLIC_URL`; refresh bundled skills from mcp-ts-core 0.6

## [2.3.4](changelog/2.3.x/2.3.4.md) — 2026-04-21

Fix format()/structuredContent parity across 6 tools via new format-parity linter; sync scripts and skills from mcp-ts-core 0.5.3

## [2.3.3](changelog/2.3.x/2.3.3.md) — 2026-04-21

Fix format() drop-offs across 4 tools; fall back to per-ID calls when batch rejects on a single bad NCT

## [2.3.2](changelog/2.3.x/2.3.2.md) — 2026-04-21

Surface nextPageToken in search_studies format() so content[]-only agents can paginate

## [2.3.1](changelog/2.3.x/2.3.1.md) — 2026-04-21

Stop slicing conditions in format() for search_studies and find_eligible; narrow test-side types under strict tsconfig

## [2.3.0](changelog/2.3.x/2.3.0.md) — 2026-04-20

Rewrite get_study_record format() for full coverage; harden retry/backoff; consolidate duplicated NCT ID regex

## [2.2.0](changelog/2.2.x/2.2.0.md) — 2026-04-20

Catch invalid-field-name errors in search_studies with a piece-vs-module hint and pointer to get_field_definitions

## [2.1.1](changelog/2.1.x/2.1.1.md) — 2026-04-13

Add add-app-tool skill; broad skill refresh (13 updated); tool description rewrites across 4 tools

## [2.1.0](changelog/2.1.x/2.1.0.md) — 2026-04-04

Shared format-helpers utility (formatRemainingStudyFields); expanded test coverage; mirrored test directory layout

## [2.0.6](changelog/2.0.x/2.0.6.md) — 2026-03-30

Skill refresh for add-tool/add-resource/design-mcp-server; dependency bumps

## [2.0.5](changelog/2.0.x/2.0.5.md) — 2026-03-28

Bump @cyanheads/mcp-ts-core 0.2.3 → 0.2.8

## [2.0.4](changelog/2.0.x/2.0.4.md) — 2026-03-28

Refactor get_study_results format() into dedicated helpers; richer rendering for outcomes, adverse events, flow, and baseline

## [2.0.3](changelog/2.0.x/2.0.3.md) — 2026-03-28

Add BOOLEAN field support to get_field_values; validate NCT ID format and cap batch at 20 for get_study_results

## [2.0.2](changelog/2.0.x/2.0.2.md) — 2026-03-28

Batch get_study_results via /studies?filter.ids (single request); lift 5-NCT-ID cap; fix field name references

## [2.0.1](changelog/2.0.x/2.0.1.md) — 2026-03-28

Rewrite format() for 4 tools to produce full structured markdown reports; expand RawStudyShape

## [2.0.0](changelog/2.0.x/2.0.0.md) — 2026-03-27 · ⚠️ Breaking

Ground-up rewrite on @cyanheads/mcp-ts-core; 7 redesigned tools, new resource, new prompt, and full test suite
