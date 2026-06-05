/**
 * @fileoverview Server-specific configuration for the ClinicalTrials.gov MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .default('https://clinicaltrials.gov/api/v2')
    .describe('ClinicalTrials.gov API base URL'),
  requestTimeoutMs: z.coerce.number().default(30_000).describe('Per-request timeout in ms'),
  maxPageSize: z.coerce.number().default(200).describe('Maximum page size cap'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Get server configuration (lazy-parsed from env vars). */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'CT_API_BASE_URL',
    requestTimeoutMs: 'CT_REQUEST_TIMEOUT_MS',
    maxPageSize: 'CT_MAX_PAGE_SIZE',
  });
  return _config;
}
