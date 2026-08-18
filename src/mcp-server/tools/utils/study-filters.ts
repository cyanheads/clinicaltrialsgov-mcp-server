/**
 * @fileoverview Bounding helpers shared by the surfaces that return a whole study —
 * caps on its location, outcome, and reference lists, and compact counts for the
 * heavy resultsSection. Applied once, before either output channel sees the
 * record, so `structuredContent` and `format()` render the same data.
 * @module mcp-server/tools/utils/study-filters
 */

import type { RawStudyShape, StudyLocation } from '@/services/clinical-trials/types.js';
import { haversineMi, type LocationWithDistance } from './geo-helpers.js';

/** Caps and geo filter a caller (or a fixed resource default) can request. */
export interface FilterInputs {
  locationLimit?: number | undefined;
  nearLocation?: { lat: number; lon: number; radiusMi: number } | undefined;
  outcomeLimit?: number | undefined;
  referenceLimit?: number | undefined;
}

/** What a filter pass actually did — populated only where it changed the data. */
export interface FilterMeta {
  locationLimit?: number;
  locationsWithoutGeo?: number;
  nearLocation?: { lat: number; lon: number; radiusMi: number };
  outcomeLimit?: number;
  referenceLimit?: number;
  totalLocations?: number;
  totalOtherOutcomes?: number;
  totalReferences?: number;
  totalSecondaryOutcomes?: number;
}

/**
 * Apply the requested filters to the study so structuredContent and format()
 * see the same data. A limit (and its corresponding upstream total) is recorded
 * in `meta` only when it actually reduced the set — reporting a cap that trimmed
 * nothing would imply a filter was applied when none was. `nearLocation` always
 * filters (drops non-geo sites, sorts, applies radius), so it is always echoed.
 */
export function applyFilters(
  study: RawStudyShape,
  input: FilterInputs,
): { study: RawStudyShape; meta: FilterMeta } {
  const ps = study.protocolSection;
  if (!ps) return { study, meta: {} };

  const meta: FilterMeta = {};
  let nextPs = ps;

  const origLocations = ps.contactsLocationsModule?.locations;
  const hasLocationFilter = input.nearLocation != null || input.locationLimit != null;
  if (origLocations?.length && hasLocationFilter) {
    let locations: LocationWithDistance[] = origLocations;

    if (input.nearLocation) {
      const { lat, lon, radiusMi } = input.nearLocation;
      const withGeo = origLocations.filter(
        (l): l is StudyLocation & { geoPoint: { lat: number; lon: number } } => l.geoPoint != null,
      );
      const withoutGeo = origLocations.length - withGeo.length;
      if (withoutGeo > 0) meta.locationsWithoutGeo = withoutGeo;
      locations = withGeo
        .map((l) => ({ ...l, distanceMi: haversineMi({ lat, lon }, l.geoPoint) }))
        .filter((l) => l.distanceMi <= radiusMi)
        .sort((a, b) => a.distanceMi - b.distanceMi);
      // nearLocation always filters → always echo it.
      meta.nearLocation = input.nearLocation;
    }

    const beforeLimit = locations.length;
    if (input.locationLimit != null) {
      locations = locations.slice(0, input.locationLimit);
      // Echo the limit only when the slice actually trimmed something.
      if (beforeLimit > input.locationLimit) meta.locationLimit = input.locationLimit;
    }

    // Record the upstream total only when the returned set is smaller than it.
    if (locations.length < origLocations.length) meta.totalLocations = origLocations.length;

    nextPs = {
      ...nextPs,
      contactsLocationsModule: {
        ...nextPs.contactsLocationsModule,
        locations,
      },
    };
  }

  const outcomes = ps.outcomesModule;
  if (outcomes && input.outcomeLimit != null) {
    const limit = input.outcomeLimit;
    const nextOutcomes = { ...outcomes };
    let trimmed = false;
    const secondary = outcomes.secondaryOutcomes;
    if (secondary && secondary.length > limit) {
      meta.totalSecondaryOutcomes = secondary.length;
      nextOutcomes.secondaryOutcomes = secondary.slice(0, limit);
      trimmed = true;
    }
    const other = outcomes.otherOutcomes;
    if (other && other.length > limit) {
      meta.totalOtherOutcomes = other.length;
      nextOutcomes.otherOutcomes = other.slice(0, limit);
      trimmed = true;
    }
    if (trimmed) {
      meta.outcomeLimit = limit;
      nextPs = { ...nextPs, outcomesModule: nextOutcomes };
    }
  }

  const refs = ps.referencesModule;
  const referenceLimit = input.referenceLimit;
  if (refs?.references && referenceLimit != null && refs.references.length > referenceLimit) {
    meta.totalReferences = refs.references.length;
    meta.referenceLimit = referenceLimit;
    nextPs = {
      ...nextPs,
      referencesModule: {
        ...refs,
        references: refs.references.slice(0, referenceLimit),
      },
    };
  }

  return { study: { ...study, protocolSection: nextPs }, meta };
}

/** Compact counts of a study's posted results. */
export interface ResultsSummary {
  baselineMeasures?: number;
  otherAdverseEvents?: number;
  outcomeMeasures?: number;
  participantFlowPeriods?: number;
  seriousAdverseEvents?: number;
}

/**
 * Compact counts of a study's posted results, computed before the heavy
 * resultsSection is dropped from a record-level payload. Returns undefined when
 * the study has no posted results.
 */
export function summarizeResults(study: RawStudyShape): ResultsSummary | undefined {
  if (!study.hasResults || !study.resultsSection) return;
  const rs = study.resultsSection;
  const om = rs.outcomeMeasuresModule as { outcomeMeasures?: unknown[] } | undefined;
  const ae = rs.adverseEventsModule as
    | { otherEvents?: unknown[]; seriousEvents?: unknown[] }
    | undefined;
  const pf = rs.participantFlowModule as { periods?: unknown[] } | undefined;
  const bl = rs.baselineCharacteristicsModule as { measures?: unknown[] } | undefined;
  const summary: ResultsSummary = {};
  if (om?.outcomeMeasures?.length) summary.outcomeMeasures = om.outcomeMeasures.length;
  if (ae?.seriousEvents?.length) summary.seriousAdverseEvents = ae.seriousEvents.length;
  if (ae?.otherEvents?.length) summary.otherAdverseEvents = ae.otherEvents.length;
  if (pf?.periods?.length) summary.participantFlowPeriods = pf.periods.length;
  if (bl?.measures?.length) summary.baselineMeasures = bl.measures.length;
  return Object.keys(summary).length > 0 ? summary : undefined;
}
