/**
 * @fileoverview Discover valid field names from the ClinicalTrials.gov data model.
 * Supports keyword search, path-based drill-down, and top-level overview.
 * @module mcp-server/tools/definitions/get-field-definitions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { RECOVERY_HINTS } from '@/mcp-server/tools/utils/recovery-hints.js';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
import type { FieldIndexEntry } from '@/services/clinical-trials/field-search.js';
import type { FieldNode } from '@/services/clinical-trials/types.js';

/** Flattened field result returned by the tool. */
interface FieldDefResult {
  children?: Array<Record<string, unknown>>;
  description?: string;
  isEnum?: boolean;
  name: string;
  path?: string;
  piece?: string;
  sourceType?: string;
  type?: string;
}

/** Build a result object, omitting undefined optional fields (exactOptionalPropertyTypes). */
function toFieldResult(node: FieldNode, path: string): FieldDefResult {
  const r: FieldDefResult = { name: node.name, path };
  if (node.piece != null) r.piece = node.piece;
  if (node.sourceType != null) r.sourceType = node.sourceType;
  if (node.type != null) r.type = node.type;
  if (node.isEnum != null) r.isEnum = node.isEnum;
  if (node.description != null) r.description = node.description;
  return r;
}

/** Convert a flat search-index entry into the tool's output shape. */
function indexEntryToResult(entry: FieldIndexEntry): FieldDefResult {
  const r: FieldDefResult = { name: entry.name, path: entry.path, piece: entry.piece };
  if (entry.sourceType != null) r.sourceType = entry.sourceType;
  if (entry.type != null) r.type = entry.type;
  if (entry.isEnum != null) r.isEnum = entry.isEnum;
  if (entry.description != null) r.description = entry.description;
  return r;
}

export const getFieldDefinitions = tool('clinicaltrials_get_field_definitions', {
  description: `Discover valid field names from the ClinicalTrials.gov data model. Call this FIRST when you need to know which field names to use in \`fields\`, \`advancedFilter\`, or \`sort\` parameters of other tools, or as input to clinicaltrials_get_field_values.

Three usage modes:
- \`query\`: keyword search. Pass a concept (e.g., "enrollment", "sponsor", "adverse events") to get a ranked list of matching field names with their data types and locations.
- \`path\`: drill into a section. Pass a dot-notation path (e.g., "protocolSection.designModule") to see its individual fields.
- (no input): top-level overview of all sections in the study record.

Returns canonical PascalCase identifiers like OverallStatus, EnrollmentCount, LeadSponsorName — these are the exact names the API accepts.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  errors: [
    {
      reason: 'path_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dot-notation path does not match any node in the field tree.',
      recovery: RECOVERY_HINTS.path_not_found,
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ClinicalTrials.gov returned 429 after retry budget exhausted.',
      recovery: RECOVERY_HINTS.rate_limited,
      retryable: true,
    },
  ],

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        `Keyword to search field names by — e.g., "enrollment", "sponsor", "adverse events". Returns matching field names ranked by relevance with their full paths and data types. Cannot be combined with \`path\`.`,
      ),
    path: z
      .string()
      .optional()
      .describe(
        `Dot-notation path to drill into a section. E.g., "protocolSection.designModule", "protocolSection.eligibilityModule", "resultsSection". Returns the section's individual fields. Cannot be combined with \`query\`. Omit both \`path\` and \`query\` for a top-level overview.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum results to return when using `query`. Default: 20.'),
    includeIndexedOnly: z
      .boolean()
      .optional()
      .describe(
        'Only return indexed (searchable) fields. Default: false. Has no visible effect at the top level — use with `path` to filter.',
      ),
  }),

  output: z.object({
    fields: z
      .array(
        z
          .object({
            name: z.string().describe('Field name (camelCase).'),
            piece: z
              .string()
              .optional()
              .describe('PascalCase identifier for use in `fields`/`AREA[]`/`sort` params.'),
            sourceType: z.string().optional().describe('Data type in the model.'),
            type: z.string().optional().describe('Semantic type.'),
            isEnum: z.boolean().optional().describe('Whether the field is an enum type.'),
            description: z.string().optional().describe('Field description.'),
            path: z.string().optional().describe('Full dot-notation path.'),
            children: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe('Child fields (top-level overview only).'),
          })
          .describe('A single field definition node.'),
      )
      .describe('Field definitions, ordered by relevance when `query` is used.'),
    totalFields: z.number().describe('Total fields returned.'),
    resolvedPath: z.string().optional().describe('Resolved path when `path` was used.'),
    searchQuery: z.string().optional().describe('Echo of the keyword when `query` was used.'),
  }),

  async handler(input, ctx) {
    if (input.query && input.path) {
      throw validationError(
        'Provide either `query` or `path`, not both. Use `query` for keyword search; use `path` to drill into a known section.',
      );
    }

    const service = getClinicalTrialsService();

    if (input.query) {
      const matches = await service.searchFieldDefinitions(input.query, input.limit, ctx);
      const fields = matches.map(indexEntryToResult);
      ctx.log.info('Field search completed', { query: input.query, matchCount: fields.length });
      return { fields, totalFields: fields.length, searchQuery: input.query };
    }

    const tree = await service.getMetadata(input.includeIndexedOnly ?? false, ctx);

    if (input.path) {
      const node = navigateToPath(tree, input.path);
      if (!node) {
        throw ctx.fail(
          'path_not_found',
          `Path '${input.path}' not found. Top-level sections: ${tree.map((n) => n.name).join(', ')}.`,
          { ...ctx.recoveryFor('path_not_found') },
        );
      }
      const fields = flattenChildren(node, input.path);
      ctx.log.info('Field path resolved', { path: input.path, fieldCount: fields.length });
      return { fields, totalFields: fields.length, resolvedPath: input.path };
    }

    /** No path or query — return top-level overview (2 levels deep). */
    const overview: FieldDefResult[] = tree.map((section) => {
      const r = toFieldResult(section, section.name);
      if (section.children) {
        r.children = section.children.map((child) => ({
          name: child.name,
          ...(child.piece != null && { piece: child.piece }),
          ...(child.type != null && { type: child.type }),
          ...(child.isEnum != null && { isEnum: child.isEnum }),
          hasChildren: (child.children?.length ?? 0) > 0,
        }));
      }
      return r;
    });
    const total = overview.reduce(
      (n, s) => n + 1 + (Array.isArray(s.children) ? s.children.length : 0),
      0,
    );
    ctx.log.info('Field overview returned', { sections: overview.length, totalFields: total });
    return { fields: overview, totalFields: total };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.searchQuery) {
      lines.push(`**${result.totalFields} field(s) matching '${result.searchQuery}':**\n`);
    }
    if (result.resolvedPath) {
      lines.push(`**${result.resolvedPath}** (${result.totalFields} fields):\n`);
    }

    for (const field of result.fields) {
      const piece = field.piece ? ` [${field.piece}]` : '';
      const typeParts = [field.sourceType, field.type].filter(Boolean);
      if (field.isEnum) typeParts.push('ENUM');
      const typeStr = typeParts.length ? ` (${typeParts.join(', ')})` : '';
      const path = field.path ? ` — ${field.path}` : '';

      if (field.children && Array.isArray(field.children)) {
        lines.push(`${field.name}${piece}${typeStr}${path}`);
        if (field.description) lines.push(`  ${field.description}`);
        lines.push(`  children (${field.children.length}):`);
        for (const child of field.children) {
          const cp = child.piece ? ` [${child.piece as string}]` : '';
          const ct = (child.type as string) ?? '';
          const ce = child.isEnum ? ', ENUM' : '';
          const cts = ct || ce ? ` (${ct}${ce})` : '';
          const arrow = child.hasChildren ? ' →' : '';
          lines.push(`    ${child.name as string}${cp}${cts}${arrow}`);
        }
      } else {
        lines.push(`${field.name}${piece}${typeStr}${path}`);
        if (field.description) lines.push(`  ${field.description}`);
      }
    }

    if (lines.length === 0) lines.push('No fields found.');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Navigate the field tree to a dot-notation path. */
function navigateToPath(nodes: FieldNode[], path: string): FieldNode | null {
  const segments = path.split('.');
  let current: FieldNode[] = nodes;

  for (let i = 0; i < segments.length; i++) {
    const match = current.find((n) => n.name === segments[i]);
    if (!match) return null;
    if (i === segments.length - 1) return match;
    if (!match.children) return null;
    current = match.children;
  }

  return null;
}

/** Flatten a node's children into a field list. */
function flattenChildren(node: FieldNode, basePath: string): FieldDefResult[] {
  const results: FieldDefResult[] = [];

  if (node.children) {
    for (const child of node.children) {
      const childPath = `${basePath}.${child.name}`;
      results.push(toFieldResult(child, childPath));
      if (child.children) {
        results.push(...flattenChildren(child, childPath));
      }
    }
  }

  return results;
}
