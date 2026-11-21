/**
 * @fileoverview Tests for the shared geo helpers (haversine, the within-radius
 * pass, filter.geo building, geoFilter parsing).
 * @module tests/mcp-server/tools/utils/geo-helpers
 */

import { describe, expect, it } from 'vitest';
import {
  describeGeoFilterRejection,
  EARTH_RADIUS_MI,
  haversineMi,
  nearGeoFilter,
  parseGeoFilterCenter,
  plainDecimal,
  sitesByDistance,
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

// Shared by clinicaltrials_get_study_record's nearLocation and
// clinicaltrials_find_eligible's location.near (#205).
describe('sitesByDistance', () => {
  /** Miles in one degree of latitude on the sphere the distances are measured on. */
  const MI_PER_DEG_LAT = (EARTH_RADIUS_MI * Math.PI) / 180;
  const center = { lat: 47.6062, lon: -122.3321 };
  /** A site due north of `center`, exactly `miles` away along the meridian. */
  const north = (facility: string, miles: number, extra: Record<string, unknown> = {}) => ({
    facility,
    geoPoint: { lat: center.lat + miles / MI_PER_DEG_LAT, lon: center.lon },
    ...extra,
  });
  const summary = (r: ReturnType<typeof sitesByDistance>) => ({
    order: r.measured.map((s) => [s.facility, s.distanceMi]),
    withinRadius: r.withinRadius,
    withoutGeo: r.withoutGeo,
  });

  it('orders measured sites nearest first and counts the leading ones within the radius', () => {
    const result = sitesByDistance(
      [north('Twelve', 12), { facility: 'No Coords' }, north('Two', 2), north('Seven', 7)],
      { ...center, radiusMi: 8 },
    );
    expect(summary(result)).toEqual({
      order: [
        ['Two', 2],
        ['Seven', 7],
        ['Twelve', 12],
      ],
      withinRadius: 2,
      withoutGeo: 1,
    });
  });

  it('splits at the radius on the exact distance, then carries it rounded', () => {
    // 10.06 rounds to 10.1, past a 10.07 radius, and lies inside it; 10.04
    // rounds to 10.0 and lies outside a 10 mi radius.
    const inside = sitesByDistance([north('Just Outside', 10.09), north('Just Inside', 10.06)], {
      ...center,
      radiusMi: 10.07,
    });
    expect(summary(inside)).toEqual({
      order: [
        ['Just Inside', 10.1],
        ['Just Outside', 10.1],
      ],
      withinRadius: 1,
      withoutGeo: 0,
    });
    const outside = sitesByDistance([north('Past The Edge', 10.04)], { ...center, radiusMi: 10 });
    expect(outside.withinRadius).toBe(0);
    expect(outside.measured[0]?.distanceMi).toBe(10);
  });

  it('counts a site exactly at the radius as within it', () => {
    const onTheEdge = north('On The Edge', 10);
    // The radius is the site's own exact distance, so the two compare equal.
    const radiusMi = haversineMi(center, onTheEdge.geoPoint);
    const result = sitesByDistance([north('Past It', 10.5), onTheEdge], { ...center, radiusMi });
    expect(summary(result)).toEqual({
      order: [
        ['On The Edge', 10],
        ['Past It', 10.5],
      ],
      withinRadius: 1,
      withoutGeo: 0,
    });
  });

  it('keeps list order between sites at the same distance, and the nearer of two that round alike first', () => {
    const result = sitesByDistance(
      [
        north('Farther', 3.04),
        north('First Tie', 1),
        north('Nearer', 3.01),
        north('Second Tie', 1),
      ],
      { ...center, radiusMi: 50 },
    );
    expect(result.measured.map((s) => s.facility)).toEqual([
      'First Tie',
      'Second Tie',
      'Nearer',
      'Farther',
    ]);
  });

  it('keeps every measured site when none lies within the radius, nearest first', () => {
    const result = sitesByDistance([north('Forty', 40), north('Thirty', 30)], {
      ...center,
      radiusMi: 5,
    });
    expect(summary(result)).toEqual({
      order: [
        ['Thirty', 30],
        ['Forty', 40],
      ],
      withinRadius: 0,
      withoutGeo: 0,
    });
  });

  it('measures nothing on a list without coordinates or on an empty list', () => {
    expect(
      summary(sitesByDistance([{ facility: 'A' }, { facility: 'B' }], { ...center, radiusMi: 50 })),
    ).toEqual({ order: [], withinRadius: 0, withoutGeo: 2 });
    expect(summary(sitesByDistance([], { ...center, radiusMi: 50 }))).toEqual({
      order: [],
      withinRadius: 0,
      withoutGeo: 0,
    });
  });

  it('keeps every other field of a site, and leaves a field the site omits absent', () => {
    const [site] = sitesByDistance(
      [north('Clinic', 1, { status: 'RECRUITING', city: 'Seattle' })],
      {
        ...center,
        radiusMi: 5,
      },
    ).measured;
    expect(site).toEqual({
      facility: 'Clinic',
      status: 'RECRUITING',
      city: 'Seattle',
      geoPoint: { lat: center.lat + 1 / MI_PER_DEG_LAT, lon: center.lon },
      distanceMi: 1,
    });
    expect(site).not.toHaveProperty('country');
  });
});

describe('plainDecimal', () => {
  it.each([
    [0.0000001, '0.0000001'],
    [-0.0000001, '-0.0000001'],
    [1.5e-7, '0.00000015'],
    [1.234e-10, '0.0000000001234'],
    [1e21, '1000000000000000000000'],
    [2.5e22, '25000000000000000000000'],
    [47.6062, '47.6062'],
    [-122.3321, '-122.3321'],
    [50, '50'],
    [0, '0'],
  ])('writes %s as %s', (n, text) => {
    expect(plainDecimal(n)).toBe(text);
    expect(Number(plainDecimal(n))).toBe(n);
  });
});

describe('nearGeoFilter', () => {
  it('builds distance(lat,lon,radiusmi) in plain decimal', () => {
    expect(nearGeoFilter({ lat: 47.6062, lon: -122.3321, radiusMi: 15 })).toBe(
      'distance(47.6062,-122.3321,15mi)',
    );
    expect(nearGeoFilter({ lat: 0.0000001, lon: -0.0000002, radiusMi: 1.5 })).toBe(
      'distance(0.0000001,-0.0000002,1.5mi)',
    );
  });

  it('builds a value the geoFilter gate accepts', () => {
    for (const near of [
      { lat: 0.0000001, lon: 179.9999999, radiusMi: 1 },
      { lat: -90, lon: -180, radiusMi: 1e21 },
    ]) {
      expect(describeGeoFilterRejection(nearGeoFilter(near))).toBeUndefined();
    }
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
  // caller gets an ordinary near-empty result for what is an input mistake.
  it('rejects a bare radius with no unit', () => {
    const message = describeGeoFilterRejection('distance(47.6,-122.9,50)');
    expect(message).toContain("Invalid value for `geoFilter`: 'distance(47.6,-122.9,50)'");
    expect(message).toContain('`mi` or `km` suffix');
  });

  // Live, the meters reading matches the sites geocoded to the center point
  // itself, not an empty result set.
  it('says what a bare radius matches upstream', () => {
    const message = describeGeoFilterRejection('distance(47.6,-122.9,50)');
    expect(message).toContain(
      'A bare radius is rejected: it is read as meters, so it matches only sites geocoded to the center point.',
    );
    expect(message).not.toContain('almost nothing');
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
