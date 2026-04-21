/**
 * @fileoverview Get field definitions from the ClinicalTrials.gov study data model.
 * @module mcp-server/tools/definitions/get-field-definitions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getClinicalTrialsService } from '@/services/clinical-trials/clinical-trials-service.js';
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

export const getFieldDefinitions = tool('clinicaltrials_get_field_definitions', {
  description: `Get field definitions from the ClinicalTrials.gov study data model. Returns the field tree with piece names (used in the fields parameter and AREA[] filters), data types, and nesting structure. Call with no path for a top-level overview, then drill into a section with the path parameter to see its fields.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },

  input: z.object({
    path: z
      .string()
      .optional()
      .describe(
        `Dot-notation path to get a subtree. E.g., "protocolSection.designModule", "protocolSection.eligibilityModule", "resultsSection". Omit for top-level overview (sections + direct children, not the full tree).`,
      ),
    includeIndexedOnly: z
      .boolean()
      .optional()
      .describe(
        'Only return indexed (searchable) fields. Default: false. Has no visible effect at the top level — use with a path to filter leaf fields.',
      ),
  }),

  output: z.object({
    fields: z
      .array(
        z.object({
          name: z.string().describe('Field name (camelCase).'),
          piece: z.string().optional().describe('PascalCase piece name for fields/AREA[] params.'),
          sourceType: z.string().optional().describe('Data type in the model.'),
          type: z.string().optional().describe('Semantic type.'),
          isEnum: z.boolean().optional().describe('Whether the field is an enum type.'),
          description: z.string().optional().describe('Field description.'),
          path: z.string().optional().describe('Full dot-notation path.'),
          children: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe('Child fields (top-level overview only).'),
        }),
      )
      .describe('Field definitions.'),
    totalFields: z.number().describe('Total fields returned.'),
    resolvedPath: z.string().optional().describe('Resolved path when path param was used.'),
  }),

  async handler(input, ctx) {
    const service = getClinicalTrialsService();
    const tree = await service.getMetadata(input.includeIndexedOnly ?? false, ctx);

    if (input.path) {
      const node = navigateToPath(tree, input.path);
      if (!node) {
        throw new Error(
          `Path '${input.path}' not found. Top-level sections: ` +
            `${tree.map((n) => n.name).join(', ')}.`,
        );
      }
      const fields = flattenChildren(node, input.path);
      ctx.log.info('Field path resolved', { path: input.path, fieldCount: fields.length });
      return { fields, totalFields: fields.length, resolvedPath: input.path };
    }

    /** No path — return top-level overview (2 levels deep). */
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
