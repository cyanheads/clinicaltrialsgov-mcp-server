/**
 * @fileoverview Pins the agent-doc selector shared by the bundle cleaner and the packaging
 * linter: package-root agent-skill trees and stray `SKILL.md` files are stripped, while runtime
 * `skills/` directories nested inside a package (the MCP SDK's `dist/ext/skills/`) ship.
 * @module tests/scripts/packaging-selectors.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY } from '../../scripts/clean-mcpb.js';

/**
 * `lint-packaging.ts` is synced from the framework and carries a fallback import that resolves
 * only inside the framework's own repository, so it is loaded through a non-literal specifier
 * the typecheck does not follow.
 */
const lintPackagingPath = '../../scripts/lint-packaging.js';
const lintPackaging: unknown = await import(lintPackagingPath);
if (
  typeof lintPackaging !== 'object' ||
  lintPackaging === null ||
  !('AGENT_DOC_ENTRY' in lintPackaging) ||
  !(lintPackaging.AGENT_DOC_ENTRY instanceof RegExp)
) {
  throw new Error('scripts/lint-packaging.ts no longer exports an AGENT_DOC_ENTRY RegExp');
}
const LINT_AGENT_DOC_ENTRY = lintPackaging.AGENT_DOC_ENTRY;

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-dep/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/plain-pkg/lib/skills/loader.js',
  'node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/skills.js',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/example.md',
  'node_modules/plain-pkg/skills/guide/SKILL.md',
  'node_modules/plain-pkg/skills/guide/references/notes.md',
  'node_modules/@scope/pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/x/SKILL.md',
  'node_modules/plain-pkg/docs/SKILL.md',
  'node_modules/some-dep/node_modules/nested-pkg/skills/guide/SKILL.md',
  'node_modules/some-dep/node_modules/@scope/nested/framework-skills/a/SKILL.md',
];

describe.each([
  ['clean-mcpb.ts', CLEAN_AGENT_DOC_ENTRY],
  ['lint-packaging.ts', LINT_AGENT_DOC_ENTRY],
])('AGENT_DOC_ENTRY in %s', (_name, selector) => {
  it.each(RUNTIME_ENTRIES)('keeps runtime entry %s', (entry) => {
    expect(selector.test(entry)).toBe(false);
  });

  it.each(AGENT_DOC_ENTRIES)('strips agent-doc entry %s', (entry) => {
    expect(selector.test(entry)).toBe(true);
  });
});

describe('AGENT_DOC_ENTRY pair', () => {
  it('is the same literal in the cleaner and the linter', () => {
    expect(LINT_AGENT_DOC_ENTRY.source).toBe(CLEAN_AGENT_DOC_ENTRY.source);
    expect(LINT_AGENT_DOC_ENTRY.flags).toBe(CLEAN_AGENT_DOC_ENTRY.flags);
  });
});
