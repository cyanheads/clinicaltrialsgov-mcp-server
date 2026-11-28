/**
 * @fileoverview The shape message every `geo_invalid` rejection leads with.
 * The search handler's local gate and the service's upstream-400 branch share
 * it so the wording cannot drift between the two paths. Kept in its own module
 * so tests that mock the service module still reach it.
 * @module services/clinical-trials/geo-filter-message
 */

/**
 * A `distance(lat,lon,radius)` value in the accepted shape except that a number
 * carries an exponent (`1e3mi`, `1e-7`), which upstream refuses as a format
 * error at any size. A capture holds each number's exponent, when it has one.
 */
const EXPONENT_FORM =
  /^distance\(-?\d+(?:\.\d+)?(e[+-]?\d+)?,-?\d+(?:\.\d+)?(e[+-]?\d+)?,\d+(?:\.\d+)?(e[+-]?\d+)?[a-z]*\)$/i;

export function geoFilterShapeMessage(geoFilter: string): string {
  const format = `Invalid value for \`geoFilter\`: '${geoFilter}'. Format must be distance(lat,lon,radius) with a \`mi\` or \`km\` suffix on the radius and every number in plain decimal digits — e.g. "distance(47.6062,-122.3321,50mi)".`;
  const exponent = EXPONENT_FORM.exec(geoFilter)?.slice(1).some(Boolean);
  return exponent
    ? `${format} Exponent notation such as 1e3 or 1e-7 is rejected at any size: write the number out in digits, as in 1000mi.`
    : `${format} A bare radius is rejected: it is read as meters, so it matches only sites geocoded to the center point.`;
}
