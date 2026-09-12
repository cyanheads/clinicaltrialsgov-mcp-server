/**
 * @fileoverview Geographic helpers shared by location-aware tools — great-circle
 * distance and parsing of the `geoFilter` center coordinates.
 * @module mcp-server/tools/utils/geo-helpers
 */

import { geoFilterShapeMessage } from '@/services/clinical-trials/geo-filter-message.js';
import type { StudyLocation } from '@/services/clinical-trials/types.js';

/** Mean Earth radius in miles, used by the Haversine formula. */
export const EARTH_RADIUS_MI = 3958.7613;

/** A study location annotated with its distance from a reference point. */
export type LocationWithDistance = StudyLocation & { distanceMi?: number };

/** Great-circle distance in miles between two lat/lon points (Haversine). */
export function haversineMi(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Extract the center coordinates from a `geoFilter` value of the form
 * `distance(lat, lon, radius)`. The radius (with an optional `mi`/`km` suffix) is
 * already applied by the upstream query, so only lat/lon are returned here — used
 * to re-rank a study's locations by proximity. Tolerates surrounding whitespace.
 * Returns undefined when the value isn't a parseable distance expression.
 */
export function parseGeoFilterCenter(
  geoFilter: string | undefined,
): { lat: number; lon: number } | undefined {
  if (!geoFilter) return;
  const match = geoFilter.match(/distance\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/i);
  if (!match) return;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  return { lat, lon };
}

/**
 * The exact `distance(lat,lon,radius<unit>)` shape ClinicalTrials.gov accepts.
 * No internal whitespace and no sign on the radius — upstream rejects both. The
 * unit is captured loosely and checked separately so a missing one (a bare
 * radius) and a case variant are told apart from a malformed expression.
 */
const GEO_FILTER_SHAPE =
  /^distance\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)([A-Za-z]*)\)$/i;

/** Radius units upstream accepts — lowercase only; a case variant is rejected. */
const GEO_RADIUS_UNITS = new Set(['mi', 'km']);

/**
 * Describe why a `geoFilter` value cannot be sent upstream, or `undefined` when
 * it is well formed.
 *
 * ClinicalTrials.gov does not reject every bad geo expression: a radius with no
 * unit returns 200 with an empty result set (the number is read as meters), a
 * zero radius answers 500 through the whole retry budget, and an out-of-range
 * coordinate answers 400 with a bare `Search error` body that carries nothing
 * to classify on. Each surfaced as something other than a bad-input error, so
 * the caller saw an empty cohort, a service outage, or an unreasoned validation
 * failure instead of the mistake they made.
 *
 * Shapes upstream does reject with `incorrect format` are caught here early
 * with the same message the service would have thrown, so only the round trip
 * changes. Range and positivity violations — which have no upstream
 * counterpart — name the offending value as well.
 *
 * This is the validation gate; `parseGeoFilterCenter` is not. That one reads a
 * center for re-ranking and must keep answering silently for anything it cannot
 * parse. The value is matched as supplied — the blank check has already run,
 * and upstream rejects surrounding whitespace too, so trimming here would pass
 * a string the request then fails on.
 */
export function describeGeoFilterRejection(geoFilter: string): string | undefined {
  const shapeGuidance = geoFilterShapeMessage(geoFilter);

  const match = geoFilter.match(GEO_FILTER_SHAPE);
  if (!match || !GEO_RADIUS_UNITS.has(match[4] ?? '')) return shapeGuidance;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  const radius = Number(match[3]);
  const problems: string[] = [];
  if (lat < -90 || lat > 90) problems.push(`Latitude must be between -90 and 90 (got ${lat}).`);
  if (lon < -180 || lon > 180)
    problems.push(`Longitude must be between -180 and 180 (got ${lon}).`);
  if (radius <= 0) problems.push(`The radius must be greater than 0 (got ${radius}).`);

  return problems.length > 0 ? `${shapeGuidance} ${problems.join(' ')}` : undefined;
}
