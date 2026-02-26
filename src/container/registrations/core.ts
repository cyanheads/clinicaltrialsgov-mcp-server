/**
 * @fileoverview Registers core application services with the DI container.
 * This module encapsulates the registration of fundamental services such as
 * configuration, logging, storage, and the LLM provider.
 * @module src/container/registrations/core
 */
import { createClient } from '@supabase/supabase-js';

import { config as parsedConfig } from '@/config/index.js';
import { container } from '@/container/core/container.js';
import {
  AppConfig,
  ClinicalTrialsProvider,
  Logger,
  RateLimiterService,
  StorageProvider,
  StorageService,
  SupabaseAdminClient,
} from '@/container/core/tokens.js';
import { ClinicalTrialsGovProvider } from '@/services/clinical-trials-gov/providers/clinicaltrials-gov.provider.js';
import { StorageService as StorageServiceClass } from '@/storage/core/StorageService.js';
import {
  createStorageProvider,
  type StorageFactoryDeps,
} from '@/storage/core/storageFactory.js';
import type { Database } from '@/storage/providers/supabase/supabase.types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/index.js';
import { RateLimiter } from '@/utils/security/rateLimiter.js';

/**
 * Registers core application services and values with the container.
 */
export const registerCoreServices = () => {
  container.registerValue(AppConfig, parsedConfig);
  container.registerValue(Logger, logger);

  // Supabase client — lazy singleton, resolved on first use
  container.registerSingleton(SupabaseAdminClient, (c) => {
    const cfg = c.resolve(AppConfig);
    if (!cfg.supabase?.url || !cfg.supabase?.serviceRoleKey) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        'Supabase URL or service role key is missing for admin client.',
      );
    }
    return createClient<Database>(
      cfg.supabase.url,
      cfg.supabase.serviceRoleKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
  });

  // Storage provider — resolve DB clients here so storageFactory stays DI-agnostic
  container.registerSingleton(StorageProvider, (c) => {
    const cfg = c.resolve(AppConfig);
    const pt = cfg.storage.providerType;
    const deps: StorageFactoryDeps = {
      ...(pt === 'supabase' && {
        supabaseClient: c.resolve(SupabaseAdminClient),
      }),
    };
    return createStorageProvider(cfg, deps);
  });

  // StorageService — singleton, receives provider via container
  container.registerSingleton(
    StorageService,
    (c) => new StorageServiceClass(c.resolve(StorageProvider)),
  );

  // RateLimiter
  container.registerSingleton(
    RateLimiterService,
    (c) => new RateLimiter(c.resolve(AppConfig), c.resolve(Logger)),
  );

  // ClinicalTrials.gov Provider
  container.registerSingleton(
    ClinicalTrialsProvider,
    () => new ClinicalTrialsGovProvider(),
  );

  logger.info('Core services registered with the DI container.');
};
