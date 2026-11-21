---
name: clinicaltrialsgov-guide
description: Gates and query syntax for the clinicaltrials_* tools over ClinicalTrials.gov. Covers study versus site recruiting status, SEARCH[Location], DISTANCE, RANGE and MISSING in advancedFilter, overlapping phase counts, partial dates, the status vocabulary, and reading posted results (group IDs, the adverse-event threshold, results published elsewhere). Use when finding trials near a place, counting or trending trials, building an advancedFilter, or interpreting a trial's results.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

The ClinicalTrials.gov registry as sponsors and investigators submit it: protocols, recruitment status, sites, eligibility, and posted results. Keyless. Counts move as the registry updates, so date any count you report.

- Not the published literature. A record's references carry PMIDs; pass them to a PubMed tool for the papers.
- No tool geocodes. `geoFilter`, `location.near` on clinicaltrials_find_eligible, `nearLocation`, and `DISTANCE[]` in `advancedFilter` take decimal latitude and longitude, so resolve a place name with a geocoding tool first.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| NCT ID | clinicaltrials_search_studies and clinicaltrials_find_eligible results, or the user | clinicaltrials_get_study_record, clinicaltrials_get_study_results, `nctIds` on search, `clinicaltrials://{nctId}` |
| Piece name (`LeadSponsorName`) | clinicaltrials_get_field_definitions `piece`: search mode by concept, drill mode by section (with `includeIndexedOnly` it adds the index-only pieces such as `NumLocations`, which search mode never lists). Copy it exactly as returned | Search `fields`: any record piece, groups included; an index-only piece comes back as an empty module, so the tool refuses it there. `AREA[…]` and clinicaltrials_get_field_values: leaf pieces only, so `LeadSponsor` is refused where `LeadSponsorName` works. clinicaltrials_get_field_values also takes index-only pieces (`NumLocations`), record alt names (`OVERALL-STATUS`), and a name in another case (`numlocations`, which the registry itself rejects), but not a search area such as `ConditionSearch`. `sort`: date and numeric leaves only (type `NormalizedDate`, `PartialDate`, `DateTimeMinutes`, `integer`, `long`, or `short`), or `@relevance`. In `fields` on either tool, the full path printed beside the piece (`protocolSection.statusModule.overallStatus`) works as the piece |
| Enum value (`RECRUITING`, `PHASE3`, `OLDER_ADULT`) | clinicaltrials_get_field_values `topValues` | `statusFilter`, `phaseFilter`, `AREA[Piece]VALUE` |
| `nextPageToken` | clinicaltrials_search_studies | `pageToken`, with the same criteria |
| Results group ID (`OG000`, `EG001`, `FG000`, `BG002`) | the group list of the same results section | that section only (see Gates) |
| PMID | `ReferencePMID`, `references[].pmid` on a record, or `resultPublications[].pmid` from clinicaltrials_get_study_results | a PubMed tool |

## Gates

**Study status is not site status.** `statusFilter` matches the study's overall status. A RECRUITING study can list a site near the patient that is NOT_YET_RECRUITING or ACTIVE_NOT_RECRUITING, and the compact index shows one site per study (the nearest to `geoFilter`, else the lead registered site) with that site's own status in brackets, which says nothing about the study's other sites. Before telling someone a trial recruits near them, confirm the status of the site near them: bind it in `advancedFilter` with `SEARCH[Location](…)` (see Syntax), read it from clinicaltrials_get_study_record with `nearLocation`, which shows each site's status, or read it on the sites clinicaltrials_find_eligible returns. When none of a candidate's matched sites recruits, find_eligible adds one recruiting site, which carries `distanceMi` and can be far from the patient. Two AREA terms outside `SEARCH[Location]` can match two different sites of one study.

**Location pieces return every site.** `fields` with any `Location*` piece returns the study's full site list, and multinational trials register hundreds of sites, some over a thousand: two such studies can make a response of hundreds of KB. For one study's nearby sites, use clinicaltrials_get_study_record with `nearLocation` and `locationLimit`.

**Phase counts overlap.** A study registered as PHASE2 and PHASE3 matches each phase on its own, so per-phase counts sum above the total. Count the combined studies with `AREA[Phase]PHASE2 AND AREA[Phase]PHASE3` and report them, or count a union with OR. Observational studies carry no phase, so a phase breakdown covers interventional studies only.

**RANGE skips studies without the field.** `AREA[X]RANGE[…]` matches only studies that publish X. A large share of recruiting trials publish no `MaximumAge` (no upper age limit), so `AREA[MaximumAge]RANGE[65 years, MAX]` drops all of them. Add the missing arm, `(AREA[MaximumAge]RANGE[65 years, MAX] OR AREA[MaximumAge]MISSING)`, or filter on `StdAge` (CHILD, ADULT, OLDER_ADULT), which already counts open-ended limits: among recruiting trials, `AREA[StdAge]OLDER_ADULT` matches exactly the studies that pair does.

**A month-only date sorts as the 1st.** Dates are registered as yyyy-MM-dd or yyyy-MM. A yyyy-MM date falls in a RANGE as the first day of its month, so `RANGE[2015-06-15, 2015-06-30]` misses every study registered as `2015-06`. Bin by whole months or years: `AREA[StartDate]RANGE[2015-01-01, 2015-12-31]`.

**Enrollment and dates can be projections.** The compact index's `enrollmentCount`, `startDate`, and `primaryCompletionDate` carry no ACTUAL/ESTIMATED qualifier. A recruiting trial's enrollment is its target (EnrollmentType ESTIMATED), and any date may be planned rather than actual. clinicaltrials_get_study_record shows each date's type and `enrollmentInfo.type`; on search, request `EnrollmentType`, `StartDateType`, or `PrimaryCompletionDateType` in `fields`.

**A lead sponsor needs `AREA[LeadSponsorName]`.** `sponsorQuery` also matches collaborators and the organization name. `AREA[LeadSponsorName]Pfizer` is a word match: it also catches names such as "Wyeth is now a wholly owned subsidiary of Pfizer". Look at the `LeadSponsorName` values you are counting before attributing them to one company.

**Read status values for what they mean.** UNKNOWN marks a study whose status has not been verified in over two years; its `LastKnownStatus` (RECRUITING, NOT_YET_RECRUITING, ACTIVE_NOT_RECRUITING, ENROLLING_BY_INVITATION) is what it last reported, so count it as neither active nor finished. AVAILABLE, NO_LONGER_AVAILABLE, TEMPORARILY_NOT_AVAILABLE, and APPROVED_FOR_MARKETING occur only on expanded-access records (`StudyType` EXPANDED_ACCESS), never on trials.

**No posted results is not no results.** `hasResults` is true only when results were posted to the registry, and most COMPLETED studies have none. Many report results in a journal instead: a reference with `ReferenceType` RESULT carries that paper's PMID, and a few carry a citation and no PMID. clinicaltrials_get_study_results answers a study without posted results with `resultPublications`, its RESULT references in registry order, each with `pmid`, `citation`, and `retractions` when a notice is linked; BACKGROUND and DERIVED references are not listed there. Before saying a trial has no results, check `resultPublications` (or the record's references) and pass the PMIDs to a PubMed tool.

**Results group IDs belong to one section.** Outcomes use OG…, adverse events EG…, participant flow FG…, and baseline BG…, and each section defines its own groups: a study can report two outcome groups and four event groups. Match arms across sections by group title, never by the number in the ID.

**Other adverse events stop at a threshold.** Serious events are reported however rare; other (non-serious) events only at or above the study's `frequencyThreshold`, usually a percentage (`5`, `0.5`) and in rare records text (`any`). An event absent from `otherEvents` may have occurred below it. Summary and full mode both carry the threshold, so read it before saying an event did not occur.

## Syntax

`advancedFilter` takes these Essie expressions:

| Expression | Matches |
|:--|:--|
| `AREA[Condition]breast cancer` | every word within that field, each widened by the registry's synonyms; quoting (`AREA[Condition]"breast cancer"`) keeps the words together but still matches synonyms such as Breast Neoplasms, and `AREA[Condition]EXPANSION[Term]"breast cancer"` drops them |
| `AREA[StartDate]RANGE[2020-01-01, MAX]` | an inclusive range; `MIN` and `MAX` leave an end open; dates are yyyy-MM-dd. RANGE takes date, numeric, and age fields only (`StartDate`, `EnrollmentCount`, `MinimumAge`), and every other field a value. NCT IDs follow first-posting order, so bound an ID range as a `StudyFirstPostDate` window |
| `AREA[MaximumAge]RANGE[MIN, 2 years]` | ages compared across units: `24 months` matches the same studies |
| `AREA[MaximumAge]MISSING` | studies that do not publish the field |
| `SEARCH[Location](AREA[LocationCity]Seattle AND AREA[LocationStatus]RECRUITING)` | every term inside holding for the same site. Only a site's own fields go inside (`LocationFacility`, `LocationCity`, `LocationState`, `LocationZip`, `LocationCountry`, `LocationStatus`, the `LocationContact…` fields); a study-level field such as `OverallStatus` or `NumLocations` goes beside the wrapper, `AREA[OverallStatus]RECRUITING AND SEARCH[Location](…)`, and a search area such as `LocationSearch` is unknown inside it. No `DISTANCE[]` or `RANGE[]` term goes inside the wrapper (a `DISTANCE[]` there fails as `field_invalid`; a `RANGE[]` there fails as `field_invalid` or `query_parse_error`, depending on how ClinicalTrials.gov answers it): a radius goes beside the wrapper, `AREA[LocationGeoPoint]DISTANCE[47.6062,-122.3321,25mi] AND SEARCH[Location](…)`, where it can match a different site of the study than the wrapper's other terms |
| `AREA[LocationGeoPoint]DISTANCE[47.6062,-122.3321,25mi]` | studies with any site within the radius, the same studies `geoFilter` matches. `LocationGeoPoint` is the only field `DISTANCE[]` takes, and the radius needs at least 1 and a `mi` or `km` unit (`25mi`, `40km`). A bare `DISTANCE[]` with no `AREA[…]` before it fails as `field_invalid` |
| `AREA[OverallStatus]COMPLETED AND NOT AREA[HasResults]true` | AND, OR, NOT between whole expressions; parentheses group |

## Workflows

**Recruiting trials near a place.** Geocode the place, then call clinicaltrials_search_studies with `geoFilter`, the condition, `statusFilter` RECRUITING, and any phase. `geoFilter` admits a study when any of its sites falls in the radius, whatever that site's status, so read the status in brackets on each candidate's nearest site, and where it is not RECRUITING check the in-radius sites with clinicaltrials_get_study_record and `nearLocation` before presenting the study. For a named city with no radius, bind city and site status together with `SEARCH[Location](…)` in `advancedFilter` instead. For one patient, clinicaltrials_find_eligible takes the radius as `location: { country, near: { lat, lon, radiusMi } }` (`radiusMi` at least 1, default 50) and returns each candidate's sites within the radius, nearest first, each with `distanceMi` from the patient; when no site measures inside the radius, the nearest measured site stands alone, and an added recruiting site can lie past it. `near` replaces `city` and `state`: either beside it fails as `location_conflict`. `country` is still required, but it is matched on any one site of the study, separately from the radius, so a candidate's sites in range can all lie in another country (Detroit sites for a patient in Windsor, Ontario): read each site's country before presenting it to a patient who must enroll at home.

**Counts and trends.** Make one clinicaltrials_get_study_count call per bucket (status, phase, year, sponsor class). clinicaltrials_get_field_values gives the vocabulary and registry-wide counts only; it cannot be scoped to a query. clinicaltrials_get_study_count takes no `geoFilter` or `nctIds`: count inside a radius with `AREA[LocationGeoPoint]DISTANCE[lat,lon,radius]` in its `advancedFilter` (the count `geoFilter` gives on clinicaltrials_search_studies), or with clinicaltrials_search_studies at `pageSize` 1 reading `totalCount`. For trends by year, bin `StartDate` (planned for studies not yet started) or `StudyFirstPostDate` (when the record was first posted), per the month-only date gate.

**Screening candidates for one patient.** clinicaltrials_find_eligible never reads inclusion or exclusion criteria. Fetch the candidates' criteria with clinicaltrials_search_studies: `nctIds` set to the candidate IDs, `fields` to `NCTId`, `EligibilityCriteria`, `MinimumAge`, and `MaximumAge`, and `pageSize` at least the number of candidates, since a page otherwise stops at 10 studies. Follow `nextPageToken` while one appears, and fetch any `deferredNctIds` the same way. Read each candidate's criteria against the patient and present the ones that survive as possible matches for the patient's care team to confirm.
