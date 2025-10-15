# clinicaltrialsgov-mcp-server - Directory Structure

Generated on: 2025-10-15 16:55:49

```
clinicaltrialsgov-mcp-server
├── .clinerules
│   └── AGENTS.md
├── .github
│   ├── workflows
│   │   └── publish.yml
│   └── FUNDING.yml
├── .husky
│   └── pre-commit
├── docs
│   ├── best-practices.md
│   └── tree.md
├── examples
│   ├── clinicaltrials_analyze_trends.md
│   ├── clinicaltrials_get_study.md
│   ├── clinicaltrials_search_studies.md
│   ├── clinicaltrials-compare-studies.md
│   └── clinicaltrials-find-eligible-studies.md
├── scripts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── devdocs.ts
│   ├── make-executable.ts
│   ├── tree.ts
│   └── update-coverage.ts
├── src
│   ├── config
│   │   └── index.ts
│   ├── container
│   │   ├── registrations
│   │   │   ├── core.ts
│   │   │   └── mcp.ts
│   │   ├── index.ts
│   │   └── tokens.ts
│   ├── mcp-server
│   │   ├── resources
│   │   │   ├── definitions
│   │   │   │   ├── echo.resource.ts
│   │   │   │   └── index.ts
│   │   │   ├── utils
│   │   │   │   ├── resourceDefinition.ts
│   │   │   │   └── resourceHandlerFactory.ts
│   │   │   └── resource-registration.ts
│   │   ├── tools
│   │   │   ├── definitions
│   │   │   │   ├── clinicaltrials-analyze-trends.tool.ts
│   │   │   │   ├── clinicaltrials-compare-studies.tool.ts
│   │   │   │   ├── clinicaltrials-find-eligible-studies.tool.ts
│   │   │   │   ├── clinicaltrials-get-study.tool.ts
│   │   │   │   ├── clinicaltrials-search-studies.tool.ts
│   │   │   │   └── index.ts
│   │   │   ├── utils
│   │   │   │   ├── ageParser.ts
│   │   │   │   ├── eligibilityCheckers.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── studyExtractors.ts
│   │   │   │   ├── studyRanking.ts
│   │   │   │   ├── toolDefinition.ts
│   │   │   │   └── toolHandlerFactory.ts
│   │   │   └── tool-registration.ts
│   │   ├── transports
│   │   │   ├── auth
│   │   │   │   ├── lib
│   │   │   │   │   ├── authContext.ts
│   │   │   │   │   ├── authTypes.ts
│   │   │   │   │   ├── authUtils.ts
│   │   │   │   │   └── withAuth.ts
│   │   │   │   ├── strategies
│   │   │   │   │   ├── authStrategy.ts
│   │   │   │   │   ├── jwtStrategy.ts
│   │   │   │   │   └── oauthStrategy.ts
│   │   │   │   ├── authFactory.ts
│   │   │   │   ├── authMiddleware.ts
│   │   │   │   └── index.ts
│   │   │   ├── http
│   │   │   │   ├── httpErrorHandler.ts
│   │   │   │   ├── httpTransport.ts
│   │   │   │   ├── httpTypes.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── sessionIdUtils.ts
│   │   │   │   └── sessionStore.ts
│   │   │   ├── stdio
│   │   │   │   ├── index.ts
│   │   │   │   └── stdioTransport.ts
│   │   │   ├── ITransport.ts
│   │   │   └── manager.ts
│   │   └── server.ts
│   ├── services
│   │   ├── clinical-trials-gov
│   │   │   ├── core
│   │   │   │   └── IClinicalTrialsProvider.ts
│   │   │   ├── providers
│   │   │   │   └── clinicaltrials-gov.provider.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── llm
│   │   │   ├── core
│   │   │   │   └── ILlmProvider.ts
│   │   │   ├── providers
│   │   │   │   └── openrouter.provider.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   └── speech
│   │       ├── core
│   │       │   ├── ISpeechProvider.ts
│   │       │   └── SpeechService.ts
│   │       ├── providers
│   │       │   ├── elevenlabs.provider.ts
│   │       │   └── whisper.provider.ts
│   │       ├── index.ts
│   │       └── types.ts
│   ├── storage
│   │   ├── core
│   │   │   ├── IStorageProvider.ts
│   │   │   ├── storageFactory.ts
│   │   │   ├── StorageService.ts
│   │   │   └── storageValidation.ts
│   │   ├── providers
│   │   │   ├── cloudflare
│   │   │   │   ├── index.ts
│   │   │   │   ├── kvProvider.ts
│   │   │   │   └── r2Provider.ts
│   │   │   ├── fileSystem
│   │   │   │   └── fileSystemProvider.ts
│   │   │   ├── inMemory
│   │   │   │   └── inMemoryProvider.ts
│   │   │   └── supabase
│   │   │       ├── supabase.types.ts
│   │   │       └── supabaseProvider.ts
│   │   └── index.ts
│   ├── types-global
│   │   └── errors.ts
│   ├── utils
│   │   ├── formatting
│   │   │   ├── index.ts
│   │   │   └── markdownBuilder.ts
│   │   ├── internal
│   │   │   ├── error-handler
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
│   │   ├── metrics
│   │   │   ├── index.ts
│   │   │   ├── registry.ts
│   │   │   └── tokenCounter.ts
│   │   ├── network
│   │   │   ├── fetchWithTimeout.ts
│   │   │   └── index.ts
│   │   ├── pagination
│   │   │   └── index.ts
│   │   ├── parsing
│   │   │   ├── csvParser.ts
│   │   │   ├── dateParser.ts
│   │   │   ├── index.ts
│   │   │   ├── jsonParser.ts
│   │   │   ├── pdfParser.ts
│   │   │   ├── xmlParser.ts
│   │   │   └── yamlParser.ts
│   │   ├── scheduling
│   │   │   ├── index.ts
│   │   │   └── scheduler.ts
│   │   ├── security
│   │   │   ├── idGenerator.ts
│   │   │   ├── index.ts
│   │   │   ├── rateLimiter.ts
│   │   │   └── sanitization.ts
│   │   ├── telemetry
│   │   │   ├── index.ts
│   │   │   ├── instrumentation.ts
│   │   │   ├── metrics.ts
│   │   │   ├── semconv.ts
│   │   │   └── trace.ts
│   │   └── index.ts
│   ├── index.ts
│   └── worker.ts
├── tests
│   ├── config
│   │   ├── index.int.test.ts
│   │   └── index.test.ts
│   ├── container
│   │   ├── registrations
│   │   │   ├── core.test.ts
│   │   │   └── mcp.test.ts
│   │   ├── index.test.ts
│   │   └── tokens.test.ts
│   ├── mcp-server
│   │   ├── resources
│   │   │   ├── definitions
│   │   │   ├── utils
│   │   │   │   ├── resourceDefinition.test.ts
│   │   │   │   └── resourceHandlerFactory.test.ts
│   │   │   └── resource-registration.test.ts
│   │   ├── tools
│   │   │   ├── definitions
│   │   │   │   ├── clinicaltrials-analyze-trends.tool.test.ts
│   │   │   │   ├── clinicaltrials-compare-studies.tool.test.ts
│   │   │   │   ├── clinicaltrials-get-study.tool.test.ts
│   │   │   │   └── clinicaltrials-search-studies.tool.test.ts
│   │   │   ├── utils
│   │   │   │   ├── core
│   │   │   │   ├── index.test.ts
│   │   │   │   ├── toolDefinition.test.ts
│   │   │   │   └── toolHandlerFactory.test.ts
│   │   │   └── tool-registration.test.ts
│   │   ├── transports
│   │   │   ├── auth
│   │   │   │   ├── lib
│   │   │   │   │   ├── authContext.test.ts
│   │   │   │   │   ├── authTypes.test.ts
│   │   │   │   │   ├── authUtils.test.ts
│   │   │   │   │   └── withAuth.test.ts
│   │   │   │   ├── strategies
│   │   │   │   │   ├── authStrategy.test.ts
│   │   │   │   │   ├── jwtStrategy.test.ts
│   │   │   │   │   └── oauthStrategy.test.ts
│   │   │   │   ├── authFactory.test.ts
│   │   │   │   ├── authMiddleware.test.ts
│   │   │   │   └── index.test.ts
│   │   │   ├── http
│   │   │   │   ├── httpErrorHandler.test.ts
│   │   │   │   ├── httpTransport.test.ts
│   │   │   │   ├── httpTypes.test.ts
│   │   │   │   ├── index.test.ts
│   │   │   │   ├── sessionIdUtils.test.ts
│   │   │   │   └── sessionStore.test.ts
│   │   │   ├── stdio
│   │   │   │   ├── index.test.ts
│   │   │   │   └── stdioTransport.test.ts
│   │   │   ├── ITransport.test.ts
│   │   │   └── manager.test.ts
│   │   └── server.test.ts.disabled
│   ├── mocks
│   │   ├── handlers.ts
│   │   └── server.ts
│   ├── scripts
│   │   └── devdocs.test.ts
│   ├── services
│   │   ├── llm
│   │   │   ├── core
│   │   │   │   └── ILlmProvider.test.ts
│   │   │   ├── providers
│   │   │   │   ├── openrouter.provider.test.ts
│   │   │   │   └── openrouter.provider.test.ts.disabled
│   │   │   ├── index.test.ts
│   │   │   └── types.test.ts
│   │   └── speech
│   │       ├── core
│   │       │   ├── ISpeechProvider.test.ts
│   │       │   └── SpeechService.test.ts
│   │       ├── providers
│   │       │   ├── elevenlabs.provider.test.ts
│   │       │   └── whisper.provider.test.ts
│   │       ├── index.test.ts
│   │       └── types.test.ts
│   ├── storage
│   │   ├── core
│   │   │   ├── IStorageProvider.test.ts
│   │   │   ├── storageFactory.test.ts
│   │   │   └── storageValidation.test.ts
│   │   ├── providers
│   │   │   ├── cloudflare
│   │   │   │   ├── kvProvider.test.ts
│   │   │   │   └── r2Provider.test.ts
│   │   │   ├── fileSystem
│   │   │   │   └── fileSystemProvider.test.ts
│   │   │   ├── inMemory
│   │   │   │   └── inMemoryProvider.test.ts
│   │   │   └── supabase
│   │   │       ├── supabase.types.test.ts
│   │   │       └── supabaseProvider.test.ts
│   │   ├── index.test.ts
│   │   ├── storageProviderCompliance.test.ts
│   │   └── StorageService.test.ts
│   ├── types-global
│   │   └── errors.test.ts
│   ├── utils
│   │   ├── formatting
│   │   │   ├── index.test.ts
│   │   │   └── markdownBuilder.test.ts
│   │   ├── internal
│   │   │   ├── error-handler
│   │   │   │   ├── errorHandler.test.ts
│   │   │   │   ├── helpers.test.ts
│   │   │   │   ├── index.test.ts
│   │   │   │   ├── mappings.test.ts
│   │   │   │   └── types.test.ts
│   │   │   ├── encoding.test.ts
│   │   │   ├── errorHandler.int.test.ts
│   │   │   ├── errorHandler.unit.test.ts
│   │   │   ├── health.test.ts
│   │   │   ├── logger.int.test.ts
│   │   │   ├── performance.init.test.ts
│   │   │   ├── performance.test.ts
│   │   │   ├── requestContext.test.ts
│   │   │   ├── runtime.test.ts
│   │   │   └── startupBanner.test.ts
│   │   ├── metrics
│   │   │   ├── index.test.ts
│   │   │   ├── registry.test.ts
│   │   │   └── tokenCounter.test.ts
│   │   ├── network
│   │   │   ├── fetchWithTimeout.test.ts
│   │   │   └── index.test.ts
│   │   ├── pagination
│   │   │   └── index.test.ts
│   │   ├── parsing
│   │   │   ├── csvParser.test.ts
│   │   │   ├── dateParser.test.ts
│   │   │   ├── index.test.ts
│   │   │   ├── jsonParser.test.ts
│   │   │   ├── pdfParser.test.ts
│   │   │   ├── xmlParser.test.ts
│   │   │   └── yamlParser.test.ts
│   │   ├── scheduling
│   │   │   ├── index.test.ts
│   │   │   └── scheduler.test.ts
│   │   ├── security
│   │   │   ├── idGenerator.test.ts
│   │   │   ├── index.test.ts
│   │   │   ├── rateLimiter.test.ts
│   │   │   └── sanitization.test.ts
│   │   ├── telemetry
│   │   │   ├── index.test.ts
│   │   │   ├── instrumentation.test.ts
│   │   │   ├── metrics.test.ts
│   │   │   ├── semconv.test.ts
│   │   │   └── trace.test.ts
│   │   └── index.test.ts
│   ├── index.test.ts
│   ├── setup.ts
│   └── worker.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .prettierignore
├── .prettierrc.json
├── AGENTS.md
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── Dockerfile
├── eslint.config.js
├── LICENSE
├── mcp.json
├── package.json
├── README.md
├── repomix.config.json
├── server.json
├── smithery.yaml
├── tsconfig.json
├── tsconfig.typedoc.json
├── tsconfig.vitest.json
├── tsdoc.json
├── typedoc.json
├── vitest.config.ts
└── wrangler.toml
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
