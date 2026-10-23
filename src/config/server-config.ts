/**
 * @fileoverview Server-specific configuration for the ClinicalTrials.gov MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * The most studies ClinicalTrials.gov returns on one page. It answers a larger
 * `pageSize` with a 200 carrying 1,000 studies, so a value past it has no
 * effect upstream.
 */
export const UPSTREAM_MAX_PAGE_SIZE = 1000;

const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .default('https://clinicaltrials.gov/api/v2')
    .describe('ClinicalTrials.gov API base URL'),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-request timeout in ms'),
  maxPageSize: z.coerce
    .number()
    .int()
    .min(1)
    .transform((n) => Math.min(n, UPSTREAM_MAX_PAGE_SIZE))
    .default(200)
    .describe(
      `Most studies one clinicaltrials_search_studies page returns; values above ${UPSTREAM_MAX_PAGE_SIZE} clamp to it`,
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Get server configuration, parsed from env vars on first call and cached.
 * First called from `setup()` (via `initClinicalTrialsService()`), never at
 * module import, so an invalid `CT_*` value reaches the framework's startup
 * configuration banner. Throws a ConfigurationError naming the variable.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'CT_API_BASE_URL',
    requestTimeoutMs: 'CT_REQUEST_TIMEOUT_MS',
    maxPageSize: 'CT_MAX_PAGE_SIZE',
  });
  return _config;
}
