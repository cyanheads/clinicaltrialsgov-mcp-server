/**
 * @fileoverview Tests for the shared geo helpers (haversine + geoFilter parsing).
 * @module tests/mcp-server/tools/utils/geo-helpers
 */

import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_MI,
  haversineMi,
  parseGeoFilterCenter,
} from '@/mcp-server/tools/utils/geo-helpers.js';

describe('haversineMi', () => {
  const seattle = { lat: 47.6062, lon: -122.3321 };
  const phoenix = { lat: 33.4484, lon: -112.074 };
  const redmondWa = { lat: 47.674, lon: -122.1215 };

  it('returns 0 for identical points', () => {
    expect(haversineMi(seattle, seattle)).toBe(0);
  });

  it('computes the Seattle→Phoenix great-circle distance (~1110 mi)', () => {
    // Known reference distance is ~1110 mi; allow a few miles of slack for the
    // mean-radius approximation.
    expect(haversineMi(seattle, phoenix)).toBeGreaterThan(1100);
    expect(haversineMi(seattle, phoenix)).toBeLessThan(1125);
  });

  it('is symmetric', () => {
    expect(haversineMi(seattle, phoenix)).toBeCloseTo(haversineMi(phoenix, seattle), 6);
  });

  it('places a nearby WA site within ~15 mi of Seattle', () => {
    expect(haversineMi(seattle, redmondWa)).toBeLessThan(15);
  });

  it('exposes the mean Earth radius constant', () => {
    expect(EARTH_RADIUS_MI).toBeCloseTo(3958.76, 1);
  });
});

describe('parseGeoFilterCenter', () => {
  it('extracts lat/lon from a distance() expression with a mi suffix', () => {
    expect(parseGeoFilterCenter('distance(47.6062,-122.3321,50mi)')).toEqual({
      lat: 47.6062,
      lon: -122.3321,
    });
  });

  it('tolerates surrounding whitespace and a km suffix', () => {
    expect(parseGeoFilterCenter('distance( 47.6062 , -122.3321 , 80km )')).toEqual({
      lat: 47.6062,
      lon: -122.3321,
    });
  });

  it('handles positive longitudes and integer coordinates', () => {
    expect(parseGeoFilterCenter('distance(0,0,1mi)')).toEqual({ lat: 0, lon: 0 });
    expect(parseGeoFilterCenter('distance(51.5,-0.12,25mi)')).toEqual({ lat: 51.5, lon: -0.12 });
  });

  it('returns undefined for an undefined input', () => {
    expect(parseGeoFilterCenter(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-distance string', () => {
    expect(parseGeoFilterCenter('Seattle, WA')).toBeUndefined();
    expect(parseGeoFilterCenter('')).toBeUndefined();
  });

  it('returns undefined when the expression is malformed', () => {
    expect(parseGeoFilterCenter('distance(47.6062)')).toBeUndefined();
    expect(parseGeoFilterCenter('distance(,,50mi)')).toBeUndefined();
  });
});
