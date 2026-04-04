/**
 * @fileoverview Tests for server configuration.
 * @module tests/config/server-config
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('getServerConfig', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  async function loadConfig() {
    const mod = await import('@/config/server-config.js');
    return mod.getServerConfig();
  }

  it('returns default values when env vars are unset', async () => {
    const config = await loadConfig();
    expect(config.apiBaseUrl).toBe('https://clinicaltrials.gov/api/v2');
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.maxPageSize).toBe(200);
  });

  it('reads CT_API_BASE_URL from env', async () => {
    vi.stubEnv('CT_API_BASE_URL', 'https://custom.api/v2');
    const config = await loadConfig();
    expect(config.apiBaseUrl).toBe('https://custom.api/v2');
  });

  it('reads CT_REQUEST_TIMEOUT_MS from env and coerces to number', async () => {
    vi.stubEnv('CT_REQUEST_TIMEOUT_MS', '5000');
    const config = await loadConfig();
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('reads CT_MAX_PAGE_SIZE from env and coerces to number', async () => {
    vi.stubEnv('CT_MAX_PAGE_SIZE', '100');
    const config = await loadConfig();
    expect(config.maxPageSize).toBe(100);
  });

  it('caches config on subsequent calls', async () => {
    const mod = await import('@/config/server-config.js');
    const first = mod.getServerConfig();
    const second = mod.getServerConfig();
    expect(first).toBe(second);
  });
});
