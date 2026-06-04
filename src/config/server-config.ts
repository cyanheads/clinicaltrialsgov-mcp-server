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

/** Mirror-specific configuration parsed separately from the flat env var set. */
const MirrorConfigSchema = z.object({
  enabled: z.coerce.boolean().default(false).describe('Enable the local SQLite study mirror'),
  path: z
    .string()
    .default('./clinical-trials-mirror.db')
    .describe('Filesystem path for the mirror SQLite database'),
  refreshCron: z
    .string()
    .default('0 3 * * *')
    .describe('Cron expression for incremental mirror refresh (default: 3 AM daily)'),
  fallbackLive: z.coerce
    .boolean()
    .default(true)
    .describe('Fall back to live API when mirror is not ready'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type MirrorConfig = z.infer<typeof MirrorConfigSchema> & {
  /** API base URL forwarded from the main config for the mirror ingester. */
  apiBaseUrl: string;
  /** Per-request timeout forwarded from the main config for the mirror ingester. */
  requestTimeoutMs: number;
};

let _config: ServerConfig | undefined;
let _mirrorConfig: MirrorConfig | undefined;

/** Get server configuration (lazy-parsed from env vars). */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'CT_API_BASE_URL',
    requestTimeoutMs: 'CT_REQUEST_TIMEOUT_MS',
    maxPageSize: 'CT_MAX_PAGE_SIZE',
  });
  return _config;
}

/** Get mirror configuration (lazy-parsed from env vars). */
export function getMirrorConfig(): MirrorConfig {
  if (!_mirrorConfig) {
    const base = parseEnvConfig(MirrorConfigSchema, {
      enabled: 'CT_MIRROR_ENABLED',
      path: 'CT_MIRROR_PATH',
      refreshCron: 'CT_MIRROR_REFRESH_CRON',
      fallbackLive: 'CT_MIRROR_FALLBACK_LIVE',
    });
    const server = getServerConfig();
    _mirrorConfig = {
      ...base,
      apiBaseUrl: server.apiBaseUrl,
      requestTimeoutMs: server.requestTimeoutMs,
    };
  }
  return _mirrorConfig;
}
