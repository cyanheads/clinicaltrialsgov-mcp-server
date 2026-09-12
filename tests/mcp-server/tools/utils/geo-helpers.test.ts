/**
 * @fileoverview Tests for the shared geo helpers (haversine + geoFilter parsing).
 * @module tests/mcp-server/tools/utils/geo-helpers
 */

import { describe, expect, it } from 'vitest';
import {
  describeGeoFilterRejection,
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

  // parseGeoFilterCenter is the re-ranking reader, not the validation gate: it
  // must keep answering silently for anything it cannot read, so a shape the
  // validator rejects still returns a center (or undefined) without throwing.
  it('stays non-throwing for shapes the validator rejects (#123)', () => {
    expect(parseGeoFilterCenter('distance(47.6,-122.9,50)')).toEqual({ lat: 47.6, lon: -122.9 });
    expect(parseGeoFilterCenter('distance(147.6,-122.9,50mi)')).toEqual({
      lat: 147.6,
      lon: -122.9,
    });
  });
});

describe('describeGeoFilterRejection (#123)', () => {
  const ACCEPTED = [
    'distance(47.6,-122.9,50mi)',
    'distance(47.6,-122.9,50km)',
    'distance(47.6,-122.9,50.5mi)',
    'distance(0,0,1km)',
    'distance(-90,-180,0.5mi)',
    'distance(90,180,12000km)',
  ];

  it.each(ACCEPTED)('accepts %s', (geoFilter) => {
    expect(describeGeoFilterRejection(geoFilter)).toBeUndefined();
  });

  it('rejects surrounding whitespace — the value is forwarded as supplied and upstream rejects it too', () => {
    expect(describeGeoFilterRejection('  distance(47.6,-122.9,50mi)  ')).toContain(
      'Format must be distance(lat,lon,radius)',
    );
  });

  // Upstream returns 200 for a unit-less radius and reads it as metres, so the
  // caller gets an ordinary empty result for what is an input mistake.
  it('rejects a bare radius with no unit', () => {
    const message = describeGeoFilterRejection('distance(47.6,-122.9,50)');
    expect(message).toContain("Invalid value for `geoFilter`: 'distance(47.6,-122.9,50)'");
    expect(message).toContain('`mi` or `km` suffix');
  });

  it.each([
    'distance(47.6,-122.9,0mi)',
    'distance(47.6,-122.9,0km)',
    'distance(47.6,-122.9,0.0mi)',
  ])('rejects a zero radius (%s)', (geoFilter) => {
    expect(describeGeoFilterRejection(geoFilter)).toContain('radius must be greater than 0');
  });

  it('rejects a negative radius', () => {
    // The sign fails the shape before the positivity check, so this lands on
    // the same format guidance upstream returns for it.
    expect(describeGeoFilterRejection('distance(47.6,-122.9,-50mi)')).toContain(
      'Format must be distance(lat,lon,radius)',
    );
  });

  it.each(['distance(147.6,-122.9,50mi)', 'distance(-90.1,-122.9,50mi)'])(
    'rejects a latitude outside [-90, 90] (%s)',
    (geoFilter) => {
      expect(describeGeoFilterRejection(geoFilter)).toContain(
        'Latitude must be between -90 and 90',
      );
    },
  );

  it.each(['distance(47.6,-222.9,50mi)', 'distance(47.6,180.5,50mi)'])(
    'rejects a longitude outside [-180, 180] (%s)',
    (geoFilter) => {
      expect(describeGeoFilterRejection(geoFilter)).toContain(
        'Longitude must be between -180 and 180',
      );
    },
  );

  it.each([
    'distance(47.6,-122.9,50MI)',
    'distance(47.6,-122.9,50KM)',
    'distance(47.6,-122.9,50Mi)',
  ])('rejects a case-variant unit upstream also rejects (%s)', (geoFilter) => {
    expect(describeGeoFilterRejection(geoFilter)).toContain(
      'Format must be distance(lat,lon,radius)',
    );
  });

  it('rejects internal whitespace, which upstream also rejects', () => {
    expect(describeGeoFilterRejection('distance( 47.6 , -122.9 , 50mi )')).toContain(
      'Format must be distance(lat,lon,radius)',
    );
  });

  it.each(['Seattle, WA', 'distance(47.6062)', '50mi', 'distance(47.6,-122.9)'])(
    'rejects a non-distance expression (%s)',
    (geoFilter) => {
      expect(describeGeoFilterRejection(geoFilter)).toContain('Invalid value for `geoFilter`');
    },
  );
});
