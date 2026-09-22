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

  // Upstream resolves NCT IDs case-insensitively on every path this server
  // calls; the schema canonicalizes so Set/Map lookups keyed on the ID agree.
  describe('case and whitespace variants canonicalize (#140)', () => {
    it.each([
      ['nct12345678', 'NCT12345678'],
      ['Nct12345678', 'NCT12345678'],
      ['nCt12345678', 'NCT12345678'],
      ['  NCT12345678  ', 'NCT12345678'],
      ['\tnct12345678\n', 'NCT12345678'],
      // No-break space and a BOM — both are whitespace to trim().
      [`${String.fromCharCode(0xa0)}nct12345678${String.fromCharCode(0xfeff)}`, 'NCT12345678'],
    ])('parses %j to %s', (raw, canonical) => {
      expect(nctIdSchema.parse(raw)).toBe(canonical);
    });

    it('keeps the canonical form as-is', () => {
      expect(nctIdSchema.parse('NCT03722472')).toBe('NCT03722472');
    });

    it('still rejects a lowercase ID with the wrong digit count', () => {
      expect(() => nctIdSchema.parse('nct1234567')).toThrow();
      expect(() => nctIdSchema.parse(' nct123456789 ')).toThrow();
    });

    it('still rejects whitespace-only input and characters trim() leaves in place', () => {
      expect(() => nctIdSchema.parse('   ')).toThrow();
      // U+200B (zero-width space) is not whitespace to trim().
      expect(() => nctIdSchema.parse(`${String.fromCharCode(0x200b)}nct12345678`)).toThrow();
    });

    it('rejects a malformed ID with the same actionable message as before', () => {
      const result = nctIdSchema.safeParse('ABC123');
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        'NCT IDs must match format NCTxxxxxxxx (8 digits).',
      );
    });
  });

  describe('invalid inputs', () => {
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
      expect(() => nctIdSchema.parse('nct 12345678')).toThrow();
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
    'blank_value',
    'study_not_found',
    'ids_not_found',
    'field_invalid',
    'enum_invalid',
    'query_parse_error',
    'geo_invalid',
    'sort_invalid',
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

  it('blank_value hint leads with the fix that also works on a required parameter (#113)', () => {
    // `get_field_values.fields`, `get_study_results.nctIds`, `find_eligible.conditions`,
    // and `find_eligible.location.country` are all required and all raise
    // blank_value. Omitting one fails the schema and returns the bare -32602 the
    // typed contract exists to replace, so "omit it" cannot lead.
    const hint = RECOVERY_HINTS.blank_value;
    expect(hint).toMatch(/^Supply a value containing non-whitespace/);
    expect(hint).toContain('non-blank entry');
    expect(hint.indexOf('non-whitespace')).toBeLessThan(hint.indexOf('omit'));
  });

  it('blank_value hint keeps the omission contrast, qualified to optional parameters (#113)', () => {
    // Omission and a blank value still mean different things — an optional
    // parameter left unset is not the same request as one sent blank.
    const hint = RECOVERY_HINTS.blank_value;
    expect(hint).toContain('optional');
    expect(hint).toMatch(/omission and a blank value mean different things/i);
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

  it('path_not_found hint names the mode-based shape, not the removed no-args overview (#87)', () => {
    const hint = RECOVERY_HINTS.path_not_found;
    expect(hint).toContain('clinicaltrials_get_field_definitions');
    expect(hint).toContain('mode="overview"');
    // The no-args overview call was removed in #48/#49; the hint must not re-teach it.
    expect(hint).not.toContain('omit both arguments');
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
