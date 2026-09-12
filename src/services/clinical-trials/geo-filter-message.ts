/**
 * @fileoverview The shape message every `geo_invalid` rejection leads with.
 * The search handler's local gate and the service's upstream-400 branch share
 * it so the wording cannot drift between the two paths. Kept in its own module
 * so tests that mock the service module still reach it.
 * @module services/clinical-trials/geo-filter-message
 */

export function geoFilterShapeMessage(geoFilter: string): string {
  return `Invalid value for \`geoFilter\`: '${geoFilter}'. Format must be distance(lat,lon,radius) with a \`mi\` or \`km\` suffix on the radius — e.g. "distance(47.6062,-122.3321,50mi)". A bare radius is rejected: upstream would read it as meters and match almost nothing.`;
}
