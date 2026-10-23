/**
 * @fileoverview Tests for server configuration.
 * @module tests/config/server-config
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

  it('treats empty env values as unset and falls back to defaults', async () => {
    vi.stubEnv('CT_API_BASE_URL', '');
    vi.stubEnv('CT_REQUEST_TIMEOUT_MS', '');
    vi.stubEnv('CT_MAX_PAGE_SIZE', '');
    const config = await loadConfig();
    expect(config.apiBaseUrl).toBe('https://clinicaltrials.gov/api/v2');
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.maxPageSize).toBe(200);
  });

  it('treats unsubstituted MCPB user_config placeholders as unset', async () => {
    const placeholder = (option: string) => `\${user_config.${option}}`;
    vi.stubEnv('CT_API_BASE_URL', placeholder('CT_API_BASE_URL'));
    vi.stubEnv('CT_REQUEST_TIMEOUT_MS', placeholder('CT_REQUEST_TIMEOUT_MS'));
    vi.stubEnv('CT_MAX_PAGE_SIZE', placeholder('CT_MAX_PAGE_SIZE'));
    const config = await loadConfig();
    expect(config.apiBaseUrl).toBe('https://clinicaltrials.gov/api/v2');
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.maxPageSize).toBe(200);
  });

  it('caches config on subsequent calls', async () => {
    const mod = await import('@/config/server-config.js');
    const first = mod.getServerConfig();
    const second = mod.getServerConfig();
    expect(first).toBe(second);
  });

  describe('range checks (#157)', () => {
    it.each(['0', '-1', '1.5', 'abc'])(
      'rejects CT_MAX_PAGE_SIZE=%s, naming the variable',
      async (value) => {
        vi.stubEnv('CT_MAX_PAGE_SIZE', value);
        await expect(loadConfig()).rejects.toMatchObject({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining('CT_MAX_PAGE_SIZE'),
        });
      },
    );

    it.each([
      ['1', 1],
      ['1000', 1000],
      ['1001', 1000],
      ['5000', 1000],
    ])(
      'accepts CT_MAX_PAGE_SIZE=%s as a cap of %i (values above 1000 clamp)',
      async (value, expected) => {
        vi.stubEnv('CT_MAX_PAGE_SIZE', value);
        const config = await loadConfig();
        expect(config.maxPageSize).toBe(expected);
      },
    );

    it.each(['0', '-5', '1.5', 'abc'])(
      'rejects CT_REQUEST_TIMEOUT_MS=%s, naming the variable',
      async (value) => {
        vi.stubEnv('CT_REQUEST_TIMEOUT_MS', value);
        await expect(loadConfig()).rejects.toMatchObject({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining('CT_REQUEST_TIMEOUT_MS'),
        });
      },
    );

    it('accepts CT_REQUEST_TIMEOUT_MS=1', async () => {
      vi.stubEnv('CT_REQUEST_TIMEOUT_MS', '1');
      const config = await loadConfig();
      expect(config.requestTimeoutMs).toBe(1);
    });
  });
});

/**
 * Spawns the server entry the way a user launches it and reads what a bad
 * `CT_*` value produces. The entry runs from source under Bun so the test
 * always exercises the working tree, never a stale `dist/`. Bun is the
 * project's runtime, so it is on PATH in both test lanes.
 */
describe('startup with an invalid CT_* value (#157)', () => {
  const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
  const BOOT_TIMEOUT_MS = 20_000;

  interface BootResult {
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }

  function boot(env: Record<string, string>): Promise<BootResult> {
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('CT_') && key !== 'DEBUG') childEnv[key] = value;
    }
    Object.assign(childEnv, env);
    return new Promise((resolve, reject) => {
      const child = spawn('bun', [ENTRY], {
        cwd: tmpdir(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: BOOT_TIMEOUT_MS,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }

  const transports = [
    ['stdio', { MCP_TRANSPORT_TYPE: 'stdio' }],
    ['http', { MCP_TRANSPORT_TYPE: 'http', MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: '3922' }],
  ] as const;

  const badValues = [
    ['CT_REQUEST_TIMEOUT_MS', 'abc'],
    ['CT_MAX_PAGE_SIZE', 'abc'],
    ['CT_MAX_PAGE_SIZE', '0'],
  ] as const;

  for (const [transport, transportEnv] of transports) {
    for (const [name, value] of badValues) {
      it(
        `exits 1 with the configuration banner on ${transport} for ${name}=${value}`,
        async () => {
          const { exitCode, stdout, stderr } = await boot({ ...transportEnv, [name]: value });
          expect(exitCode).toBe(1);
          expect(stdout).toBe('');
          expect(stderr).toContain('Configuration error — server failed to start');
          expect(stderr).toContain(`- ${name} (`);
          expect(stderr).toContain('Set DEBUG=true for the full stack trace.');
          // No uncaught-exception dump: the banner replaces the stack.
          expect(stderr).not.toMatch(/\n\s+at /);
        },
        BOOT_TIMEOUT_MS + 5_000,
      );
    }
  }
});
