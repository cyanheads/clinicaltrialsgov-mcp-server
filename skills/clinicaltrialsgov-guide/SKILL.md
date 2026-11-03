---
name: clinicaltrialsgov-guide
description: Gates and query syntax for the clinicaltrials_* tools over ClinicalTrials.gov. Covers study versus site recruiting status, SEARCH[Location], RANGE and MISSING in advancedFilter, overlapping phase counts, partial dates, the status vocabulary, and reading posted results (group IDs, the adverse-event threshold, results published elsewhere). Use when finding trials near a place, counting or trending trials, building an advancedFilter, or interpreting a trial's results.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The ClinicalTrials.gov registry as sponsors and investigators submit it: protocols, recruitment status, sites, eligibility, and posted results. Keyless. Counts move as the registry updates, so date any count you report.

- Not the published literature. A record's references carry PMIDs; pass them to a PubMed tool for the papers.
- No tool geocodes. `geoFilter` and `nearLocation` take decimal latitude and longitude, so resolve a place name with a geocoding tool first.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| NCT ID | clinicaltrials_search_studies and clinicaltrials_find_eligible results, or the user | clinicaltrials_get_study_record, clinicaltrials_get_study_results, `nctIds` on search, `clinicaltrials://{nctId}` |
| Piece name (`LeadSponsorName`) | clinicaltrials_get_field_definitions `piece`: search mode by concept, drill mode by section. Copy it exactly as returned | `fields`, `sort`, clinicaltrials_get_field_values, and `AREA[…]` for leaf pieces only: `AREA[LeadSponsor]` is refused where `AREA[LeadSponsorName]` works |
| Enum value (`RECRUITING`, `PHASE3`, `OLDER_ADULT`) | clinicaltrials_get_field_values `topValues` | `statusFilter`, `phaseFilter`, `AREA[Piece]VALUE` |
| `nextPageToken` | clinicaltrials_search_studies | `pageToken`, with the same criteria |
| Results group ID (`OG000`, `EG001`, `FG000`, `BG002`) | the group list of the same results section | that section only (see Gates) |
| PMID | `ReferencePMID`, or `references[].pmid` on a record | a PubMed tool |

## Gates

**Study status is not site status.** `statusFilter` matches the study's overall status. A RECRUITING study can list a site near the patient that is NOT_YET_RECRUITING or ACTIVE_NOT_RECRUITING, and the compact index's nearest site carries no status at all. Before telling someone a trial recruits near them, confirm that site's own status: bind it in `advancedFilter` with `SEARCH[Location](…)` (see Syntax), read it from clinicaltrials_get_study_record with `nearLocation`, which shows each site's status, or read it on the sites clinicaltrials_find_eligible returns. When none of a candidate's matched sites recruits, find_eligible adds one recruiting site, which carries `distanceMi` and can be far from the patient. Two AREA terms outside `SEARCH[Location]` can match two different sites of one study.

**Location pieces return every site.** `fields` with any `Location*` piece returns the study's full site list, and multinational trials register hundreds of sites, some over a thousand: two such studies can make a response of hundreds of KB. For one study's nearby sites, use clinicaltrials_get_study_record with `nearLocation` and `locationLimit`.

**Phase counts overlap.** A study registered as PHASE2 and PHASE3 matches each phase on its own, so per-phase counts sum above the total. Count the combined studies with `AREA[Phase]PHASE2 AND AREA[Phase]PHASE3` and report them, or count a union with OR. Observational studies carry no phase, so a phase breakdown covers interventional studies only.

**RANGE skips studies without the field.** `AREA[X]RANGE[…]` matches only studies that publish X. A large share of recruiting trials publish no `MaximumAge` (no upper age limit), so `AREA[MaximumAge]RANGE[65 years, MAX]` drops all of them. Add the missing arm, `(AREA[MaximumAge]RANGE[65 years, MAX] OR AREA[MaximumAge]MISSING)`, or filter on `StdAge` (CHILD, ADULT, OLDER_ADULT), which already counts open-ended limits: among recruiting trials, `AREA[StdAge]OLDER_ADULT` matches exactly the studies that pair does.

**A month-only date sorts as the 1st.** Dates are registered as yyyy-MM-dd or yyyy-MM. A yyyy-MM date falls in a RANGE as the first day of its month, so `RANGE[2015-06-15, 2015-06-30]` misses every study registered as `2015-06`. Bin by whole months or years: `AREA[StartDate]RANGE[2015-01-01, 2015-12-31]`.

**Enrollment and dates can be projections.** The compact index's `enrollmentCount`, `startDate`, and `primaryCompletionDate` carry no ACTUAL/ESTIMATED qualifier. A recruiting trial's enrollment is its target (EnrollmentType ESTIMATED), and any date may be planned rather than actual. clinicaltrials_get_study_record shows each date's type and `enrollmentInfo.type`; on search, request `EnrollmentType`, `StartDateType`, or `PrimaryCompletionDateType` in `fields`.

**A lead sponsor needs `AREA[LeadSponsorName]`.** `sponsorQuery` also matches collaborators and the organization name. `AREA[LeadSponsorName]Pfizer` is a word match: it also catches names such as "Wyeth is now a wholly owned subsidiary of Pfizer". Look at the `LeadSponsorName` values you are counting before attributing them to one company.

**Read status values for what they mean.** UNKNOWN marks a study whose status has not been verified in over two years; its `LastKnownStatus` (RECRUITING, NOT_YET_RECRUITING, ACTIVE_NOT_RECRUITING, ENROLLING_BY_INVITATION) is what it last reported, so count it as neither active nor finished. AVAILABLE, NO_LONGER_AVAILABLE, TEMPORARILY_NOT_AVAILABLE, and APPROVED_FOR_MARKETING occur only on expanded-access records (`StudyType` EXPANDED_ACCESS), never on trials.

**No posted results is not no results.** `hasResults` is true only when results were posted to the registry, and most COMPLETED studies have none. Many report results in a journal instead: a reference with `ReferenceType` RESULT carries that paper's PMID. Before saying a trial has no results, read its references and pass RESULT PMIDs to a PubMed tool.

**Results group IDs belong to one section.** Outcomes use OG…, adverse events EG…, participant flow FG…, and baseline BG…, and each section defines its own groups: a study can report two outcome groups and four event groups. Match arms across sections by group title, never by the number in the ID.

**Other adverse events stop at a threshold.** Serious events are reported however rare; other (non-serious) events only at or above the study's `frequencyThreshold`, a percentage. An event absent from `otherEvents` may have occurred below it. Summary mode leaves the threshold out: read it in full mode with `sections` set to adverseEvents and `adverseEventLimit` to bound the lists.

## Syntax

`advancedFilter` takes these Essie expressions:

| Expression | Matches |
|:--|:--|
| `AREA[Condition]breast cancer` | every word within that field, each widened by the registry's synonyms; quoting (`AREA[Condition]"breast cancer"`) keeps the words together but still matches synonyms such as Breast Neoplasms, and `AREA[Condition]EXPANSION[Term]"breast cancer"` drops them |
| `AREA[StartDate]RANGE[2020-01-01, MAX]` | an inclusive range; `MIN` and `MAX` leave an end open; dates are yyyy-MM-dd |
| `AREA[MaximumAge]RANGE[MIN, 2 years]` | ages compared across units: `24 months` matches the same studies |
| `AREA[MaximumAge]MISSING` | studies that do not publish the field |
| `SEARCH[Location](AREA[LocationCity]Seattle AND AREA[LocationStatus]RECRUITING)` | every term inside holding for the same site |
| `AREA[OverallStatus]COMPLETED AND NOT AREA[HasResults]true` | AND, OR, NOT between whole expressions; parentheses group |

## Workflows

**Recruiting trials near a place.** Geocode the place, then call clinicaltrials_search_studies with `geoFilter`, the condition, `statusFilter` RECRUITING, and any phase. `geoFilter` admits a study when any of its sites falls in the radius, whatever that site's status, so check each candidate's nearby site with clinicaltrials_get_study_record and `nearLocation` before presenting it. For a named city with no radius, bind city and site status together with `SEARCH[Location](…)` in `advancedFilter` instead.

**Counts and trends.** Make one clinicaltrials_get_study_count call per bucket (status, phase, year, sponsor class). clinicaltrials_get_field_values gives the vocabulary and registry-wide counts only; it cannot be scoped to a query. clinicaltrials_get_study_count takes no `geoFilter` or `nctIds`: count inside a radius with clinicaltrials_search_studies at `pageSize` 1 and read `totalCount`. For trends by year, bin `StartDate` (planned for studies not yet started) or `StudyFirstPostDate` (when the record was first posted), per the month-only date gate.

**Screening candidates for one patient.** clinicaltrials_find_eligible never reads inclusion or exclusion criteria. Fetch the candidates' criteria with clinicaltrials_search_studies: `nctIds` set to the candidate IDs, `fields` to `NCTId`, `EligibilityCriteria`, `MinimumAge`, and `MaximumAge`, and `pageSize` at least the number of candidates, since a page otherwise stops at 10 studies. Follow `nextPageToken` while one appears, and fetch any `deferredNctIds` the same way. Read each candidate's criteria against the patient and present the ones that survive as possible matches for the patient's care team to confirm.
