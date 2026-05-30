/**
 * @fileoverview Tests for shared utility modules: nctIdSchema and RECOVERY_HINTS.
 * @module tests/mcp-server/tools/utils/utils-shared
 */

import { describe, expect, it } from 'vitest';
import { nctIdSchema } from '@/mcp-server/tools/utils/_schemas.js';
import { RECOVERY_HINTS } from '@/mcp-server/tools/utils/recovery-hints.js';

// ---------------------------------------------------------------------------
// nctIdSchema
// ---------------------------------------------------------------------------

describe('nctIdSchema', () => {
  describe('valid inputs', () => {
    it('accepts standard 8-digit NCT ID', () => {
      expect(() => nctIdSchema.parse('NCT12345678')).not.toThrow();
    });

    it('accepts NCT ID with all zeros', () => {
      expect(() => nctIdSchema.parse('NCT00000000')).not.toThrow();
    });

    it('accepts NCT ID with all nines', () => {
      expect(() => nctIdSchema.parse('NCT99999999')).not.toThrow();
    });
  });

  describe('invalid inputs', () => {
    it('rejects lowercase prefix', () => {
      expect(() => nctIdSchema.parse('nct12345678')).toThrow();
    });

    it('rejects mixed-case prefix', () => {
      expect(() => nctIdSchema.parse('Nct12345678')).toThrow();
    });

    it('rejects too few digits (7)', () => {
      expect(() => nctIdSchema.parse('NCT1234567')).toThrow();
    });

    it('rejects too many digits (9)', () => {
      expect(() => nctIdSchema.parse('NCT123456789')).toThrow();
    });

    it('rejects non-numeric suffix', () => {
      expect(() => nctIdSchema.parse('NCTABCDEFGH')).toThrow();
    });

    it('rejects empty string', () => {
      expect(() => nctIdSchema.parse('')).toThrow();
    });

    it('rejects arbitrary string', () => {
      expect(() => nctIdSchema.parse('INVALID')).toThrow();
    });

    it('rejects NCT ID with embedded space', () => {
      expect(() => nctIdSchema.parse('NCT 12345678')).toThrow();
    });

    it('rejects null', () => {
      expect(() => nctIdSchema.parse(null)).toThrow();
    });

    it('rejects number type', () => {
      expect(() => nctIdSchema.parse(12345678)).toThrow();
    });

    it('rejects NCT prefix with mixed digits and letters in suffix', () => {
      expect(() => nctIdSchema.parse('NCT1234567A')).toThrow();
    });

    it('provides a descriptive error message on rejection', () => {
      try {
        nctIdSchema.parse('BADID');
        throw new Error('should have thrown');
      } catch (err) {
        const msg = String(err);
        // The schema uses NCT_ID_MESSAGE constant
        expect(msg.toLowerCase()).toMatch(/nct|format|digit/i);
      }
    });
  });

  describe('return type', () => {
    it('returns the string as-is when valid', () => {
      const result = nctIdSchema.parse('NCT12345678');
      expect(result).toBe('NCT12345678');
    });
  });
});

// ---------------------------------------------------------------------------
// RECOVERY_HINTS
// ---------------------------------------------------------------------------

describe('RECOVERY_HINTS', () => {
  const expectedKeys = [
    'study_not_found',
    'ids_not_found',
    'field_invalid',
    'query_parse_error',
    'path_not_found',
    'rate_limited',
  ] as const;

  it('exports an object with all required reason keys', () => {
    for (const key of expectedKeys) {
      expect(RECOVERY_HINTS).toHaveProperty(key);
    }
  });

  it('every hint value is a non-empty string', () => {
    for (const key of expectedKeys) {
      const hint = RECOVERY_HINTS[key];
      expect(typeof hint).toBe('string');
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  it('study_not_found hint references NCT ID or clinicaltrials', () => {
    expect(RECOVERY_HINTS.study_not_found.toLowerCase()).toMatch(/nct|clinicaltrials/);
  });

  it('ids_not_found hint references NCT IDs or search', () => {
    expect(RECOVERY_HINTS.ids_not_found.toLowerCase()).toMatch(/nct|search|id/);
  });

  it('field_invalid hint references get_field_definitions or piece names', () => {
    expect(RECOVERY_HINTS.field_invalid.toLowerCase()).toMatch(/field_definitions|piece/);
  });

  it('query_parse_error hint references AREA[] syntax or reserved chars', () => {
    expect(RECOVERY_HINTS.query_parse_error.toLowerCase()).toMatch(/area\[|reserved/);
  });

  it('path_not_found hint references get_field_definitions or overview', () => {
    expect(RECOVERY_HINTS.path_not_found.toLowerCase()).toMatch(/field_definitions|overview/);
  });

  it('rate_limited hint references wait time or retry', () => {
    expect(RECOVERY_HINTS.rate_limited.toLowerCase()).toMatch(/wait|retry|minute/);
  });

  it('has no duplicate hint values (each reason has unique guidance)', () => {
    const values = Object.values(RECOVERY_HINTS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
