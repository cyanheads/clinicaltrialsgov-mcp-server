# clinicaltrialsgov-mcp-server - Directory Structure

Generated on: 2026-03-26 21:10:33

```text
clinicaltrialsgov-mcp-server/
├── .claude/
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .husky/
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── claude-plans/
├── docs/
├── scripts/
│   ├── build.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   └── tree.ts
├── skills/
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── devcheck/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   └── setup/
│       └── SKILL.md
├── src/
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── echo.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── echo.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           └── echo.tool.ts
│   └── index.ts
├── src_old/
│   ├── config/
│   │   └── index.ts
│   ├── container/
│   │   ├── core/
│   │   │   ├── container.ts
│   │   │   └── tokens.ts
│   │   ├── registrations/
│   │   │   ├── core.ts
│   │   │   └── mcp.ts
│   │   └── index.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   ├── definitions/
│   │   │   │   ├── echo.resource.ts
│   │   │   │   └── index.ts
│   │   │   ├── utils/
│   │   │   │   ├── resourceDefinition.ts
│   │   │   │   └── resourceHandlerFactory.ts
│   │   │   └── resource-registration.ts
│   │   ├── tools/
│   │   │   ├── definitions/
│   │   │   │   ├── clinicaltrials-analyze-trends.tool.ts
│   │   │   │   ├── clinicaltrials-compare-studies.tool.ts
│   │   │   │   ├── clinicaltrials-find-eligible-studies.tool.ts
│   │   │   │   ├── clinicaltrials-get-field-values.tool.ts
│   │   │   │   ├── clinicaltrials-get-study-results.tool.ts
│   │   │   │   ├── clinicaltrials-get-study.tool.ts
│   │   │   │   ├── clinicaltrials-search-studies.tool.ts
│   │   │   │   └── index.ts
│   │   │   ├── utils/
│   │   │   │   ├── ageParser.ts
│   │   │   │   ├── eligibilityCheckers.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── studyExtractors.ts
│   │   │   │   ├── studyRanking.ts
│   │   │   │   ├── toolDefinition.ts
│   │   │   │   └── toolHandlerFactory.ts
│   │   │   └── tool-registration.ts
│   │   ├── transports/
│   │   │   ├── auth/
│   │   │   │   ├── lib/
│   │   │   │   │   ├── authContext.ts
│   │   │   │   │   ├── authTypes.ts
│   │   │   │   │   ├── authUtils.ts
│   │   │   │   │   └── withAuth.ts
│   │   │   │   ├── strategies/
│   │   │   │   │   ├── authStrategy.ts
│   │   │   │   │   ├── jwtStrategy.ts
│   │   │   │   │   └── oauthStrategy.ts
│   │   │   │   ├── authFactory.ts
│   │   │   │   ├── authMiddleware.ts
│   │   │   │   └── index.ts
│   │   │   ├── http/
│   │   │   │   ├── httpErrorHandler.ts
│   │   │   │   ├── httpTransport.ts
│   │   │   │   ├── httpTypes.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── sessionIdUtils.ts
│   │   │   │   └── sessionStore.ts
│   │   │   ├── stdio/
│   │   │   │   ├── index.ts
│   │   │   │   └── stdioTransport.ts
│   │   │   ├── ITransport.ts
│   │   │   └── manager.ts
│   │   └── server.ts
│   ├── services/
│   │   └── clinical-trials-gov/
│   │       ├── core/
│   │       │   └── IClinicalTrialsProvider.ts
│   │       ├── providers/
│   │       │   └── clinicaltrials-gov.provider.ts
│   │       ├── index.ts
│   │       └── types.ts
│   ├── storage/
│   │   ├── core/
│   │   │   ├── IStorageProvider.ts
│   │   │   ├── storageFactory.ts
│   │   │   ├── StorageService.ts
│   │   │   └── storageValidation.ts
│   │   ├── providers/
│   │   │   ├── cloudflare/
│   │   │   │   ├── d1Provider.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── kvProvider.ts
│   │   │   │   └── r2Provider.ts
│   │   │   ├── fileSystem/
│   │   │   │   └── fileSystemProvider.ts
│   │   │   ├── inMemory/
│   │   │   │   └── inMemoryProvider.ts
│   │   │   └── supabase/
│   │   │       ├── supabase.types.ts
│   │   │       └── supabaseProvider.ts
│   │   ├── index.ts
│   │   └── README.md
│   ├── types-global/
│   │   └── errors.ts
│   ├── utils/
│   │   ├── formatting/
│   │   │   ├── diffFormatter.ts
│   │   │   ├── index.ts
│   │   │   ├── markdownBuilder.ts
│   │   │   ├── tableFormatter.ts
│   │   │   └── treeFormatter.ts
│   │   ├── internal/
│   │   │   ├── error-handler/
│   │   │   │   ├── errorHandler.ts
│   │   │   │   ├── helpers.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── mappings.ts
│   │   │   │   └── types.ts
│   │   │   ├── encoding.ts
│   │   │   ├── health.ts
│   │   │   ├── index.ts
│   │   │   ├── logger.ts
│   │   │   ├── performance.ts
│   │   │   ├── requestContext.ts
│   │   │   ├── runtime.ts
│   │   │   └── startupBanner.ts
│   │   ├── metrics/
│   │   │   ├── index.ts
│   │   │   ├── registry.ts
│   │   │   └── tokenCounter.ts
│   │   ├── network/
│   │   │   ├── fetchWithTimeout.ts
│   │   │   └── index.ts
│   │   ├── pagination/
│   │   │   └── index.ts
│   │   ├── parsing/
│   │   │   ├── csvParser.ts
│   │   │   ├── dateParser.ts
│   │   │   ├── frontmatterParser.ts
│   │   │   ├── index.ts
│   │   │   ├── jsonParser.ts
│   │   │   ├── pdfParser.ts
│   │   │   ├── xmlParser.ts
│   │   │   └── yamlParser.ts
│   │   ├── scheduling/
│   │   │   ├── index.ts
│   │   │   └── scheduler.ts
│   │   ├── security/
│   │   │   ├── idGenerator.ts
│   │   │   ├── index.ts
│   │   │   ├── rateLimiter.ts
│   │   │   └── sanitization.ts
│   │   ├── telemetry/
│   │   │   ├── index.ts
│   │   │   ├── instrumentation.ts
│   │   │   ├── metrics.ts
│   │   │   ├── semconv.ts
│   │   │   └── trace.ts
│   │   ├── types/
│   │   │   ├── guards.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── index.ts
│   └── worker.ts
├── tests/
│   ├── prompts/
│   │   └── echo.prompt.test.ts
│   ├── resources/
│   │   └── echo.resource.test.ts
│   └── tools/
│       └── echo.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── package-template.json
├── package.json
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
