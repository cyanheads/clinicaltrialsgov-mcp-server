/**
 * @fileoverview Geographic helpers shared by location-aware tools — great-circle
 * distance and parsing of the `geoFilter` center coordinates.
 * @module mcp-server/tools/utils/geo-helpers
 */

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
