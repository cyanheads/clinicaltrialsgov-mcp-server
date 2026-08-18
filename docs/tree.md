# clinicaltrialsgov-mcp-server - Directory Structure

Generated on: 2026-08-18 16:03:28

```text
clinicaltrialsgov-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .husky/
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 2.0.x/
│   ├── 2.1.x/
│   ├── 2.2.x/
│   ├── 2.3.x/
│   ├── 2.4.x/
│   ├── 2.5.x/
│   ├── 2.6.x/
│   ├── 2.7.x/
│   ├── 2.8.x/
│   ├── 2.9.x/
│   └── template.md
├── changelogs/
│   └── archive1.md
├── docs/
│   ├── api-reference.md
│   └── design.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
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
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
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
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
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
│   │           ├── _schemas.ts
│   │           ├── format-helpers.ts
│   │           ├── geo-helpers.ts
│   │           ├── query-helpers.ts
│   │           ├── recovery-hints.ts
│   │           └── study-filters.ts
│   ├── services/
│   │   └── clinical-trials/
│   │       ├── clinical-trials-service.ts
│   │       ├── field-search.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── nct03722472.json
│   │   └── nct06323538.json
│   ├── helpers/
│   │   └── format-parity.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── analyze-trial-landscape.prompt.test.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── study.resource.test.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── find-eligible.fuzz.test.ts
│   │       │   ├── find-eligible.tool.test.ts
│   │       │   ├── get-field-definitions.fuzz.test.ts
│   │       │   ├── get-field-definitions.tool.test.ts
│   │       │   ├── get-field-values.tool.test.ts
│   │       │   ├── get-study-count.tool.test.ts
│   │       │   ├── get-study-results.tool.test.ts
│   │       │   ├── get-study.tool.test.ts
│   │       │   ├── search-studies.fuzz.test.ts
│   │       │   └── search-studies.tool.test.ts
│   │       ├── utils/
│   │       │   ├── format-helpers.test.ts
│   │       │   ├── geo-helpers.test.ts
│   │       │   ├── query-helpers.test.ts
│   │       │   └── utils-shared.test.ts
│   │       ├── security.test.ts
│   │       └── tool-contract.test.ts
│   └── services/
│       └── clinical-trials/
│           ├── clinical-trials-service.test.ts
│           └── field-search.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
