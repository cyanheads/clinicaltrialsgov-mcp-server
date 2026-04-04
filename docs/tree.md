# clinicaltrialsgov-mcp-server - Directory Structure

Generated on: 2026-04-04 22:16:55

```text
clinicaltrialsgov-mcp-server/
├── .claude/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   └── workflows/
│       └── codeql.yml
├── .husky/
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelogs/
│   └── archive1.md
├── claude-plans/
├── docs/
│   ├── api-reference.md
│   └── design.md
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
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── analyze-trial-landscape.prompt.ts
│   │   │       └── index.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       └── study.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── find-eligible.tool.ts
│   │       │   ├── get-field-definitions.tool.ts
│   │       │   ├── get-field-values.tool.ts
│   │       │   ├── get-study-count.tool.ts
│   │       │   ├── get-study-results.tool.ts
│   │       │   ├── get-study.tool.ts
│   │       │   ├── index.ts
│   │       │   └── search-studies.tool.ts
│   │       └── utils/
│   │           ├── format-helpers.ts
│   │           └── query-helpers.ts
│   ├── services/
│   │   └── clinical-trials/
│   │       ├── clinical-trials-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── analyze-trial-landscape.prompt.test.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── study.resource.test.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── find-eligible.tool.test.ts
│   │       │   ├── get-field-definitions.tool.test.ts
│   │       │   ├── get-field-values.tool.test.ts
│   │       │   ├── get-study-count.tool.test.ts
│   │       │   ├── get-study-results.tool.test.ts
│   │       │   ├── get-study.tool.test.ts
│   │       │   └── search-studies.tool.test.ts
│   │       └── utils/
│   │           └── query-helpers.test.ts
│   └── services/
│       └── clinical-trials/
│           └── clinical-trials-service.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
├── tsconfig.test.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
