/**
 * @fileoverview Local SQLite mirror of the ClinicalTrials.gov study corpus.
 *
 * Opt-in (requires `CT_MIRROR_ENABLED=true`). Wraps `defineMirror` from
 * `@cyanheads/mcp-ts-core/mirror` with the ClinicalTrials-specific ingester and
 * schema, and exposes the single accessor used by `ClinicalTrialsService` to
 * route local-first reads.
 *
 * Call `initMirror()` from `createApp({ setup() })` after `initClinicalTrialsService()`.
 * The accessor `getClinicalTrialsMirror()` returns `undefined` when the mirror is
 * disabled (env `CT_MIRROR_ENABLED` not set or falsy), so callers must guard
 * with `if (mirror)`.
 *
 * The mirror is **never** automatically bootstrapped on startup — a full init
 * takes ~10 min and must be run out-of-band. Only the incremental refresh is
 * scheduled automatically (daily by default, configurable via `CT_MIRROR_REFRESH_CRON`).
 * @module services/clinical-trials/mirror
 */

import type { Mirror } from '@cyanheads/mcp-ts-core/mirror';
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import type { MirrorConfig } from '@/config/server-config.js';
import { clinicalTrialsIngester } from './ingester.js';
import { STUDY_META_COLUMNS, STUDY_META_FTS } from './types.js';

export type { StudyMetaRow } from './types.js';

let _mirror: Mirror | undefined;

/**
 * Initialize the clinical-trials mirror from the provided mirror config.
 * No-op when `config.enabled` is `false`. Safe to call multiple times (idempotent).
 */
export function initMirror(config: MirrorConfig): void {
  if (!config.enabled || _mirror) return;

  _mirror = defineMirror({
    name: 'clinical-trials-studies',
    store: sqliteMirrorStore({
      path: config.path,
      table: 'studies',
      primaryKey: 'nct_id',
      columns: STUDY_META_COLUMNS,
      fts: STUDY_META_FTS as string[],
      indexes: [
        { columns: ['overall_status'] },
        { columns: ['last_update_post_date'] },
        { columns: ['study_type'] },
        { columns: ['lead_sponsor_class'] },
        { columns: ['has_results'] },
      ],
    }),
    logger,
    async *sync(ctx) {
      yield* clinicalTrialsIngester(ctx, {
        apiBaseUrl: config.apiBaseUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        log: logger,
      });
    },
  });

  logger.info(
    `Clinical-trials mirror initialized (path=${config.path}, refreshCron=${config.refreshCron}, fallbackLive=${config.fallbackLive})`,
  );
}

/** Return the mirror instance, or `undefined` when the mirror is disabled. */
export function getClinicalTrialsMirror(): Mirror | undefined {
  return _mirror;
}

/** Reset the mirror instance (for tests). */
export function resetMirrorForTest(): void {
  _mirror = undefined;
}
