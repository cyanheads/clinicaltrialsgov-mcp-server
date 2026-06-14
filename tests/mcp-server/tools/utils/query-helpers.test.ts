/**
 * @fileoverview Tests for query helper utilities.
 * @module tests/query-helpers
 */

import { describe, expect, it } from 'vitest';
import { buildAdvancedFilter, toArray } from '@/mcp-server/tools/utils/query-helpers.js';

describe('toArray', () => {
  it('returns undefined for undefined input', () => {
    expect(toArray(undefined)).toBeUndefined();
  });

  it('wraps a string in an array', () => {
    expect(toArray('RECRUITING')).toEqual(['RECRUITING']);
  });

  it('passes arrays through unchanged', () => {
    const arr = ['RECRUITING', 'COMPLETED'];
    expect(toArray(arr)).toBe(arr);
  });

  it('handles empty string', () => {
    expect(toArray('')).toEqual(['']);
  });

  it('handles empty array', () => {
    expect(toArray([])).toEqual([]);
  });

  it('parses a JSON-stringified string array (#75)', () => {
    expect(toArray('["RECRUITING","COMPLETED"]')).toEqual(['RECRUITING', 'COMPLETED']);
  });

  it('parses a single-element JSON-stringified array (#75)', () => {
    expect(toArray('["OverallStatus"]')).toEqual(['OverallStatus']);
  });

  it('parses a whitespace-padded JSON-stringified array (#75)', () => {
    expect(toArray('  ["PHASE1", "PHASE2"]  ')).toEqual(['PHASE1', 'PHASE2']);
  });

  it('scalar-wraps a truncated "[" string rather than parsing (#75)', () => {
    expect(toArray('[')).toEqual(['[']);
  });

  it('scalar-wraps a JSON array with non-string elements (#75)', () => {
    expect(toArray('[1, 2]')).toEqual(['[1, 2]']);
  });

  it('scalar-wraps a JSON object string — only [-leading values are parsed (#75)', () => {
    expect(toArray('{"a":1}')).toEqual(['{"a":1}']);
  });
});

describe('buildAdvancedFilter', () => {
  it('returns undefined when both args are empty', () => {
    expect(buildAdvancedFilter(undefined, undefined)).toBeUndefined();
    expect(buildAdvancedFilter([], undefined)).toBeUndefined();
    expect(buildAdvancedFilter([], '')).toBeUndefined();
  });

  it('builds single phase filter', () => {
    expect(buildAdvancedFilter(['PHASE3'])).toBe('AREA[Phase]PHASE3');
  });

  it('builds multi-phase filter with OR', () => {
    expect(buildAdvancedFilter(['PHASE1', 'PHASE2'])).toBe(
      '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2)',
    );
  });

  it('passes through advancedFilter alone', () => {
    expect(buildAdvancedFilter(undefined, 'AREA[StudyType]INTERVENTIONAL')).toBe(
      'AREA[StudyType]INTERVENTIONAL',
    );
  });

  it('combines phase filter with advancedFilter using AND', () => {
    expect(buildAdvancedFilter(['PHASE3'], 'AREA[StudyType]INTERVENTIONAL')).toBe(
      'AREA[Phase]PHASE3 AND AREA[StudyType]INTERVENTIONAL',
    );
  });

  it('combines multi-phase filter with advancedFilter', () => {
    expect(buildAdvancedFilter(['PHASE1', 'PHASE2'], 'AREA[StudyType]INTERVENTIONAL')).toBe(
      '(AREA[Phase]PHASE1 OR AREA[Phase]PHASE2) AND AREA[StudyType]INTERVENTIONAL',
    );
  });
});
