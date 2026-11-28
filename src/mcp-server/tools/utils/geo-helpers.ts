/**
 * @fileoverview Geographic helpers shared by location-aware tools — great-circle
 * distance, the within-radius site pass, building a `filter.geo` value, the
 * radius cap, and parsing of the `geoFilter` center coordinates.
 * @module mcp-server/tools/utils/geo-helpers
 */

import { geoFilterShapeMessage } from '@/services/clinical-trials/geo-filter-message.js';
import type { StudyLocation } from '@/services/clinical-trials/types.js';

/** Mean Earth radius in miles, used by the Haversine formula. */
export const EARTH_RADIUS_MI = 3958.7613;

/**
 * The widest radius `filter.geo` is sent with, per unit. No two points on Earth
 * lie farther apart than half the equatorial circumference (12,450.7 mi,
 * 20,037.5 km), so a larger radius reaches the same sites as the cap — every
 * one that publishes coordinates — and is sent as the cap, which a notice
 * discloses (`radiusCapNotice`). Sent as asked, a radius past about 1.117e305 mi
 * (where its length in meters overflows a double) fails upstream as a bare
 * `Search error` that carries nothing to classify on (#211).
 */
export const MAX_RADIUS = { mi: 12451, km: 20039 } as const;

/** A radius unit `filter.geo` accepts: lowercase only, since upstream rejects a case variant. */
export type RadiusUnit = keyof typeof MAX_RADIUS;

const isRadiusUnit = (unit: string): unit is RadiusUnit => Object.hasOwn(MAX_RADIUS, unit);

/** The radius to send in place of `radius`: capped at `MAX_RADIUS` for its unit. */
export function capRadius(radius: number, unit: RadiusUnit): number {
  return Math.min(radius, MAX_RADIUS[unit]);
}

/** The notice sentence for a radius sent at `MAX_RADIUS`; `subject` names the radius as requested. */
export function radiusCapNotice(subject: string, unit: RadiusUnit): string {
  const cap = MAX_RADIUS[unit];
  return `${subject} is past ${cap.toLocaleString('en-US')} ${unit}, and no two points on Earth lie farther apart than that, so it was sent as ${cap} ${unit}: both reach every site that publishes coordinates.`;
}

/** A study location annotated with its distance from a reference point. */
export type LocationWithDistance = StudyLocation & { distanceMi?: number };

/** A point and a radius around it, in decimal degrees and miles. */
export interface NearPoint {
  lat: number;
  lon: number;
  radiusMi: number;
}

/** A distance in miles to the one decimal content[] renders, so both surfaces carry the same value. */
export function roundMi(distanceMi: number): number {
  return Math.round(distanceMi * 10) / 10;
}

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

/** A study's sites measured from a point and split at a radius; see `sitesByDistance`. */
export interface SitesByDistance<T extends StudyLocation> {
  /** Every site that publishes coordinates, nearest first, each carrying its distanceMi from the point. */
  measured: Array<T & { distanceMi: number }>;
  /** How many leading `measured` sites lie within the radius. */
  withinRadius: number;
  /** Sites that publish no coordinates, so were never measured and never lie within. */
  withoutGeo: number;
}

/**
 * Measure each site from `near` and order them nearest first. The exact
 * distance decides the order and the radius split; each site carries it
 * rounded (`roundMi`), since rounding first would admit a site just past the
 * radius. Ties keep list order. Because the order is by distance, the sites
 * within the radius are exactly the first `withinRadius` of `measured`.
 */
export function sitesByDistance<T extends StudyLocation>(
  locations: readonly T[],
  near: NearPoint,
): SitesByDistance<T> {
  const withGeo = locations.filter(
    (l): l is T & { geoPoint: { lat: number; lon: number } } => l.geoPoint != null,
  );
  const exact = withGeo
    .map((l) => ({ ...l, distanceMi: haversineMi(near, l.geoPoint) }))
    .sort((a, b) => a.distanceMi - b.distanceMi);
  const outside = exact.findIndex((l) => l.distanceMi > near.radiusMi);
  return {
    measured: exact.map((l) => ({ ...l, distanceMi: roundMi(l.distanceMi) })),
    withinRadius: outside === -1 ? exact.length : outside,
    withoutGeo: locations.length - withGeo.length,
  };
}

/**
 * A number in plain decimal notation. `String()` writes very small and very
 * large numbers in exponent form (`1e-7`, `1e+21`), which ClinicalTrials.gov
 * rejects inside `filter.geo`; this spells out the same digits.
 */
export function plainDecimal(n: number): string {
  const text = String(n);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, lead, fraction = '', exponent] = match;
  const digits = `${lead}${fraction}`;
  const pointAt = 1 + Number(exponent);
  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/** The `filter.geo` value for a radius in miles around a point: `distance(lat,lon,radiusmi)`. */
export function nearGeoFilter(near: NearPoint): string {
  return `distance(${plainDecimal(near.lat)},${plainDecimal(near.lon)},${plainDecimal(near.radiusMi)}mi)`;
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

/**
 * Describe why a `geoFilter` value cannot be sent upstream, or `undefined` when
 * it is well formed.
 *
 * ClinicalTrials.gov does not reject every bad geo expression: a radius with no
 * unit returns 200 and is read as meters, so it matches only sites geocoded to
 * the center point; a zero radius answers 500 through the whole retry budget,
 * and an out-of-range coordinate answers 400 with a bare `Search error` body
 * that carries nothing to classify on. Each surfaced as something other than a
 * bad-input error, so the caller saw a near-empty cohort, a service outage, or
 * an unreasoned validation failure instead of the mistake they made.
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
  if (!match || !isRadiusUnit(match[4] ?? '')) return shapeGuidance;

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

/**
 * The `geoFilter` to send in place of one whose radius is past `MAX_RADIUS` for
 * its unit: the cap in the radius's place, the rest as written. Undefined when
 * the radius is within the cap, and for a value outside the shape
 * `describeGeoFilterRejection` accepts, which that gate rejects first.
 */
export function capGeoFilterRadius(
  geoFilter: string,
): { geoFilter: string; unit: RadiusUnit } | undefined {
  const [, , , radius = '', unit = ''] = geoFilter.match(GEO_FILTER_SHAPE) ?? [];
  if (!isRadiusUnit(unit) || Number(radius) <= MAX_RADIUS[unit]) return;
  // The shape ends `<radius><unit>)`, so everything before the radius is kept.
  const kept = geoFilter.slice(0, geoFilter.length - radius.length - unit.length - 1);
  return { geoFilter: `${kept}${MAX_RADIUS[unit]}${unit})`, unit };
}
