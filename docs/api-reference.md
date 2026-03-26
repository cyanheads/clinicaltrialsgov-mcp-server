# ClinicalTrials.gov REST API v2 -- Complete Reference

> Compiled 2026-03-26 from the OpenAPI spec, live endpoint responses, and search-areas metadata.
> API Version: **2.0.5** | Data Timestamp: `2026-03-25T09:00:05`

---

## 1. Base URL and Versioning

| Key          | Value                                          |
| :----------- | :--------------------------------------------- |
| Base URL     | `https://clinicaltrials.gov/api/v2`            |
| API Version  | `2.0.5` (SemVer 2.0.0)                         |
| Data Version | UTC timestamp (`yyyy-MM-dd'T'HH:mm:ss`)        |
| OpenAPI Spec | `https://clinicaltrials.gov/api/oas/v2` (YAML) |
| Auth         | None required (public API)                     |

---

## 2. All Endpoints

| Method | Path                    | Tag     | Description                                                    |
| :----- | :---------------------- | :------ | :------------------------------------------------------------- |
| `GET`  | `/studies`              | Studies | Search/list studies with query, filters, pagination            |
| `GET`  | `/studies/{nctId}`      | Studies | Fetch a single study by NCT ID                                 |
| `GET`  | `/studies/metadata`     | Studies | List all study data model fields (field tree)                  |
| `GET`  | `/studies/search-areas` | Studies | List search documents and their search areas                   |
| `GET`  | `/studies/enums`        | Studies | List all enum types with values and legacy mappings            |
| `GET`  | `/stats/size`           | Stats   | Study JSON size statistics (distribution, percentiles)         |
| `GET`  | `/stats/field/values`   | Stats   | Value statistics for leaf fields (distribution, cardinality)   |
| `GET`  | `/stats/field/sizes`    | Stats   | Size statistics for list/array fields (min, max, distribution) |
| `GET`  | `/version`              | Version | API version and data timestamp                                 |

---

## 3. `GET /studies` -- Search/List Studies

### 3.1 Query Parameters (Essie search expressions)

Each `query.*` parameter maps to a named **search area** -- a weighted set of fields searched using the Essie engine.

| Parameter       | Search Area        | Description                                     |
| :-------------- | :----------------- | :---------------------------------------------- |
| `query.term`    | BasicSearch        | General keyword search across most fields       |
| `query.cond`    | ConditionSearch    | Condition or disease terms                      |
| `query.intr`    | InterventionSearch | Intervention/treatment terms                    |
| `query.titles`  | TitleSearch        | Title and acronym fields                        |
| `query.outc`    | OutcomeSearch      | Outcome measure terms                           |
| `query.spons`   | SponsorSearch      | Sponsor/collaborator names                      |
| `query.lead`    | LeadSponsorName    | Lead sponsor name field                         |
| `query.locn`    | LocationSearch     | Location terms (city, state, country, facility) |
| `query.id`      | IdSearch           | Study IDs (NCT ID, org study ID, secondary IDs) |
| `query.patient` | PatientSearch      | Patient-facing search (broadest area)           |

### 3.2 Filter Parameters

| Parameter                  | Type                            | Description                                                                               |
| :------------------------- | :------------------------------ | :---------------------------------------------------------------------------------------- |
| `filter.overallStatus`     | `string` (pipe/comma-delimited) | Filter by study status. Values from `Status` enum.                                        |
| `filter.geo`               | `string`                        | Geographic filter. Syntax: `distance(lat,lon,dist)` where dist is e.g. `50mi` or `100km`. |
| `filter.ids`               | `string` (pipe/comma-delimited) | Filter by NCT IDs. Pattern: `NCT\d+`.                                                     |
| `filter.advanced`          | `string`                        | Advanced Essie expression using `AREA[]` syntax.                                          |
| `filter.synonyms`          | `string` (pipe/comma-delimited) | Synonym pairs: `area:synonym_id`.                                                         |
| `postFilter.overallStatus` | same as filter.\*               | Equivalent post-filter versions of all filter params.                                     |
| `postFilter.geo`           | same as filter.\*               | Post-filter geographic.                                                                   |
| `postFilter.ids`           | same as filter.\*               | Post-filter NCT IDs.                                                                      |
| `postFilter.advanced`      | same as filter.\*               | Post-filter advanced expression.                                                          |
| `postFilter.synonyms`      | same as filter.\*               | Post-filter synonyms.                                                                     |
| `aggFilters`               | `string`                        | Aggregation filters: `filter_id:option_keys` pairs.                                       |

### 3.3 Response Control Parameters

| Parameter      | Type                            | Default    | Description                                                         |
| :------------- | :------------------------------ | :--------- | :------------------------------------------------------------------ |
| `format`       | enum                            | `json`     | Response format: `csv`, `json`                                      |
| `markupFormat` | enum                            | `markdown` | Markup field format: `markdown`, `legacy`                           |
| `fields`       | `string` (pipe/comma-delimited) | all        | Field/piece names to include in response (see Section 10)           |
| `sort`         | `string` (pipe/comma-delimited) | relevance  | Sort fields with optional `:asc`/`:desc`. Max 2 sort fields.        |
| `countTotal`   | `boolean`                       | `false`    | Include `totalCount` in response (first page only).                 |
| `pageSize`     | `integer`                       | `10`       | Results per page. Range: 0--1000.                                   |
| `pageToken`    | `string`                        | _(none)_   | Pagination cursor from `nextPageToken` of previous response.        |
| `geoDecay`     | `string`                        | _(none)_   | Geographic decay scoring: `func:...,scale:...,offset:...,decay:...` |

### 3.4 Response Schema (`PagedStudies`)

```json
{
  "totalCount": 138795,          // only present when countTotal=true, first page only
  "nextPageToken": "abc123...",  // null/absent on last page
  "studies": [
    {
      "protocolSection": { ... },
      "resultsSection": { ... },
      "annotationSection": { ... },
      "documentSection": { ... },
      "derivedSection": { ... },
      "hasResults": true
    }
  ]
}
```

### 3.5 Error Response

- `400 Bad Request` -- plain text error message

---

## 4. `GET /studies/{nctId}` -- Single Study

### Path Parameter

| Param   | Pattern                        | Description                                               |
| :------ | :----------------------------- | :-------------------------------------------------------- |
| `nctId` | `^[Nn][Cc][Tt]0*[1-9]\d{0,7}$` | NCT identifier (case-insensitive, leading zeros optional) |

### Query Parameters

| Parameter      | Type                            | Default    | Description                                   |
| :------------- | :------------------------------ | :--------- | :-------------------------------------------- |
| `format`       | enum                            | `json`     | `csv`, `json`, `json.zip`, `fhir.json`, `ris` |
| `markupFormat` | enum                            | `markdown` | `markdown`, `legacy`                          |
| `fields`       | `string` (pipe/comma-delimited) | all        | Fields to include                             |

### Response

- `200` -- `Study` object (JSON), or CSV/ZIP/FHIR/RIS depending on format
- `301` -- Redirect when NCT ID found in alias field (follow redirect)
- `400` -- Bad request
- `404` -- Study not found

---

## 5. `GET /studies/metadata` -- Field Definitions

Returns the complete study data model as a field tree.

### Query Parameters

| Parameter             | Type      | Default | Description                 |
| :-------------------- | :-------- | :------ | :-------------------------- |
| `includeIndexedOnly`  | `boolean` | `false` | Only return indexed fields  |
| `includeHistoricOnly` | `boolean` | `false` | Only return historic fields |

### Response Schema (`FieldNodeList`)

Each `FieldNode` contains:

| Property      | Type          | Description                                                |
| :------------ | :------------ | :--------------------------------------------------------- |
| `name`        | `string`      | JSON field name (camelCase path element)                   |
| `piece`       | `string`      | Piece name (PascalCase, used in `fields` param and AREA[]) |
| `sourceType`  | `string`      | Data type in the model                                     |
| `type`        | `string`      | Semantic type                                              |
| `isEnum`      | `boolean`     | Whether the field is an enum type                          |
| `children`    | `FieldNode[]` | Nested child fields                                        |
| `description` | `string`      | Field description                                          |

---

## 6. `GET /studies/search-areas` -- Search Area Definitions

Returns all search documents and their constituent search areas, including field weights and synonym support.

---

## 7. `GET /studies/enums` -- Enum Definitions

Returns all enum types with values, legacy value mappings, and per-piece exceptions.

### Response Schema (`EnumInfoList`)

Each `EnumInfo` contains:

| Property | Type          | Description                    |
| :------- | :------------ | :----------------------------- |
| `type`   | `string`      | Enum type name                 |
| `pieces` | `string[]`    | Piece names that use this enum |
| `values` | `EnumValue[]` | Possible values                |

Each `EnumValue`: `{ value, legacyValue, exceptions? }`

---

## 8. Stats Endpoints

### 8.1 `GET /stats/size` -- Study Size Statistics

Returns gzip-compressed JSON size distribution across all studies.

| Response Field     | Type      | Description                                          |
| :----------------- | :-------- | :--------------------------------------------------- |
| `totalStudies`     | `integer` | Total study count (~577K)                            |
| `averageSizeBytes` | `number`  | Mean study size (~17.2 KB)                           |
| `percentiles`      | `object`  | Size thresholds: 5th through 99th percentile         |
| `ranges`           | `array`   | Histogram buckets with `studiesCount` per size range |
| `largestStudies`   | `array`   | Top 10 largest: `{ id, sizeBytes }`                  |

### 8.2 `GET /stats/field/values` -- Field Value Statistics

| Parameter | Type                            | Description                                                                          |
| :-------- | :------------------------------ | :----------------------------------------------------------------------------------- |
| `types`   | `string` (pipe/comma-delimited) | Filter by `FieldStatsType`: `ENUM`, `STRING`, `DATE`, `INTEGER`, `NUMBER`, `BOOLEAN` |
| `fields`  | `string` (pipe/comma-delimited) | Piece names or full dot-notation field paths                                         |

Response is an array of objects:

| Field                 | Type      | Description                                   |
| :-------------------- | :-------- | :-------------------------------------------- |
| `type`                | `string`  | Data type (`ENUM`, `STRING`, etc.)            |
| `piece`               | `string`  | Piece name                                    |
| `field`               | `string`  | Full dot-notation path                        |
| `missingStudiesCount` | `integer` | Studies missing this field                    |
| `uniqueValuesCount`   | `integer` | Distinct value count                          |
| `topValues`           | `array`   | `{ value, studiesCount }` ranked by frequency |

Errors: `400` (bad request), `404` (field not found)

### 8.3 `GET /stats/field/sizes` -- List Field Size Statistics

| Parameter | Type                            | Description                                      |
| :-------- | :------------------------------ | :----------------------------------------------- |
| `fields`  | `string` (pipe/comma-delimited) | Piece names or field paths for array/list fields |

Response is an array of objects:

| Field              | Type      | Description                                  |
| :----------------- | :-------- | :------------------------------------------- |
| `piece`            | `string`  | Piece name                                   |
| `field`            | `string`  | Full dot-notation path                       |
| `uniqueSizesCount` | `integer` | Distinct array sizes observed                |
| `minSize`          | `integer` | Smallest array length                        |
| `maxSize`          | `integer` | Largest array length                         |
| `topSizes`         | `array`   | `{ size, studiesCount }` ranked by frequency |

Errors: `400`, `404`

---

## 9. `GET /version`

| Response Field  | Type     | Example                 |
| :-------------- | :------- | :---------------------- |
| `apiVersion`    | `string` | `"2.0.5"`               |
| `dataTimestamp` | `string` | `"2026-03-25T09:00:05"` |

---

## 10. Pagination

| Mechanism      | Detail                                                 |
| :------------- | :----------------------------------------------------- |
| Cursor-based   | Uses opaque `pageToken` / `nextPageToken` strings      |
| Page size      | `pageSize` parameter, 0--1000, default 10              |
| Total count    | `countTotal=true` adds `totalCount` to first page only |
| Last page      | `nextPageToken` is absent/null                         |
| Token lifetime | Tied to data version; may expire on data refresh       |

Usage pattern:

1. First request: `GET /studies?query.cond=cancer&pageSize=50&countTotal=true`
2. Response includes `totalCount`, `nextPageToken`, and `studies[]`
3. Next page: `GET /studies?query.cond=cancer&pageSize=50&pageToken={nextPageToken}`
4. Repeat until `nextPageToken` is absent

---

## 11. Rate Limits

No explicit rate limit documentation exists in the API spec or official docs. Observed behavior:

| Signal             | Detail                                                          |
| :----------------- | :-------------------------------------------------------------- |
| `robots.txt`       | `Crawl-delay: 1` for `/api/` paths                              |
| Practical guidance | ~1 request/second is a safe baseline                            |
| HTTP 429           | Expected response for throttled requests                        |
| Recommendation     | Implement exponential backoff on 429 responses                  |
| Contact            | `register@clinicaltrials.gov` for bulk/commercial use questions |

---

## 12. Study Object Structure

A full study has five top-level sections plus a `hasResults` flag:

```
Study
├── protocolSection
│   ├── identificationModule
│   │   ├── nctId, nctIdAliases, orgStudyIdInfo, secondaryIdInfos
│   │   ├── briefTitle, officialTitle, acronym
│   │   └── organization { fullName, class }
│   ├── statusModule
│   │   ├── overallStatus, lastKnownStatus, statusVerifiedDate
│   │   ├── startDateStruct { date, type }
│   │   ├── primaryCompletionDateStruct { date, type }
│   │   ├── completionDateStruct { date, type }
│   │   ├── studyFirstSubmitDate, studyFirstSubmitQcDate
│   │   ├── studyFirstPostDateStruct { date, type }
│   │   ├── resultsFirstSubmitDate, resultsFirstSubmitQcDate
│   │   ├── resultsFirstPostDateStruct { date, type }
│   │   ├── lastUpdateSubmitDate
│   │   ├── lastUpdatePostDateStruct { date, type }
│   │   ├── expandedAccessInfo { hasExpandedAccess, nctId, statusForNctId }
│   │   ├── whyStopped, delayedPosting, resultsWaived
│   │   └── dispFirstSubmitDate, dispFirstPostDateStruct
│   ├── sponsorCollaboratorsModule
│   │   ├── leadSponsor { name, class }
│   │   ├── collaborators[] { name, class }
│   │   └── responsibleParty { type, investigatorFullName, investigatorTitle, investigatorAffiliation }
│   ├── oversightModule
│   │   ├── oversightHasDmc, isFdaRegulatedDrug, isFdaRegulatedDevice
│   │   ├── isUnapprovedDevice, isPpsd, isUsExport
│   │   └── fdaaa801Violation
│   ├── descriptionModule
│   │   ├── briefSummary
│   │   └── detailedDescription
│   ├── conditionsModule
│   │   ├── conditions[]
│   │   └── keywords[]
│   ├── designModule
│   │   ├── studyType, phases[]
│   │   ├── designInfo
│   │   │   ├── allocation, interventionModel, primaryPurpose
│   │   │   ├── observationalModel, timePerspective
│   │   │   ├── interventionModelDescription
│   │   │   └── maskingInfo { masking, maskingDescription, whoMasked[] }
│   │   ├── enrollmentInfo { count, type }
│   │   ├── expandedAccessTypes { individual, intermediate, treatment }
│   │   ├── bioSpec { retention, description }
│   │   ├── patientRegistry, targetDuration
│   │   └── nPtrsToThisExpAccNctId
│   ├── armsInterventionsModule
│   │   ├── armGroups[] { label, type, description, interventionNames[] }
│   │   └── interventions[] { type, name, description, armGroupLabels[], otherNames[] }
│   ├── outcomesModule
│   │   ├── primaryOutcomes[] { measure, description, timeFrame }
│   │   ├── secondaryOutcomes[] { measure, description, timeFrame }
│   │   └── otherOutcomes[] { measure, description, timeFrame }
│   ├── eligibilityModule
│   │   ├── eligibilityCriteria, healthyVolunteers
│   │   ├── sex, genderBased, genderDescription
│   │   ├── minimumAge, maximumAge, stdAges[]
│   │   ├── studyPopulation, samplingMethod
│   │   └── (NormalizedTime format for ages, e.g. "18 Years")
│   ├── contactsLocationsModule
│   │   ├── centralContacts[] { name, role, phone, phoneExt, email }
│   │   ├── overallOfficials[] { name, affiliation, role }
│   │   └── locations[] { facility, status, city, state, zip, country, geoPoint { lat, lon }, contacts[] }
│   ├── referencesModule
│   │   ├── references[] { pmid, type, citation, retractions[] }
│   │   ├── seeAlsoLinks[] { label, url }
│   │   └── availIpds[] { id, type, url, comment }
│   └── ipdSharingStatementModule
│       ├── ipdSharing, description, infoTypes[]
│       ├── timeFrame, accessCriteria, url
│       └── (values: YES, NO, UNDECIDED)
├── resultsSection
│   ├── participantFlowModule
│   │   ├── preAssignmentDetails, recruitmentDetails, typeUnitsAnalyzed
│   │   ├── groups[] { id, title, description }
│   │   └── periods[] { title, milestones[], dropWithdraws[] }
│   ├── baselineCharacteristicsModule
│   │   ├── populationDescription, typeUnitsAnalyzed
│   │   ├── groups[] { id, title, description }
│   │   ├── denoms[] { units, counts[] { groupId, value } }
│   │   └── measures[] { title, paramType, dispersionType, unitOfMeasure, ... }
│   ├── outcomeMeasuresModule
│   │   └── outcomeMeasures[] { type, title, paramType, groups[], denoms[], classes[], analyses[] }
│   ├── adverseEventsModule
│   │   ├── frequencyThreshold, timeFrame, description
│   │   ├── groups[] { id, title, description }
│   │   ├── seriousEvents[] { term, organSystem, assessmentType, stats[] }
│   │   └── otherEvents[] { term, organSystem, assessmentType, stats[] }
│   └── moreInfoModule
│       ├── certainAgreement { piSponsorEmployee, restrictionType, ... }
│       ├── pointOfContact { title, organization, email, phone }
│       └── limitationsAndCaveats { description }
├── annotationSection
│   └── annotationModule
│       ├── unpostedAnnotation { unpostedResponsibleParty, unpostedEvents[] }
│       └── violationAnnotation { violationEvents[] }
├── documentSection
│   └── largeDocumentModule
│       ├── noSap
│       └── largeDocs[] { hasProtocol, hasSap, hasIcf, label, date, uploadDate, filename, size }
├── derivedSection
│   ├── miscInfoModule { versionHolder, removedCountries[], submissionTracking }
│   ├── conditionBrowseModule { meshes[], ancestors[], browseLeaves[], browseBranches[] }
│   └── interventionBrowseModule { meshes[], ancestors[], browseLeaves[], browseBranches[] }
└── hasResults (boolean)
```

---

## 13. Fields Parameter

The `fields` parameter accepts **piece names** (PascalCase) or **field paths** (dot-notation). Use pipe `|` or comma `,` as delimiters.

### Piece Names (used in fields param and AREA[] syntax)

These are the PascalCase identifiers from the metadata endpoint. Key examples:

| Piece Name                | JSON Path                                                         |
| :------------------------ | :---------------------------------------------------------------- |
| `NCTId`                   | `protocolSection.identificationModule.nctId`                      |
| `BriefTitle`              | `protocolSection.identificationModule.briefTitle`                 |
| `OfficialTitle`           | `protocolSection.identificationModule.officialTitle`              |
| `Acronym`                 | `protocolSection.identificationModule.acronym`                    |
| `OrgFullName`             | `protocolSection.identificationModule.organization.fullName`      |
| `OrgClass`                | `protocolSection.identificationModule.organization.class`         |
| `OverallStatus`           | `protocolSection.statusModule.overallStatus`                      |
| `StartDate`               | `protocolSection.statusModule.startDateStruct.date`               |
| `PrimaryCompletionDate`   | `protocolSection.statusModule.primaryCompletionDateStruct.date`   |
| `CompletionDate`          | `protocolSection.statusModule.completionDateStruct.date`          |
| `StudyFirstPostDate`      | `protocolSection.statusModule.studyFirstPostDateStruct.date`      |
| `LastUpdatePostDate`      | `protocolSection.statusModule.lastUpdatePostDateStruct.date`      |
| `LeadSponsorName`         | `protocolSection.sponsorCollaboratorsModule.leadSponsor.name`     |
| `LeadSponsorClass`        | `protocolSection.sponsorCollaboratorsModule.leadSponsor.class`    |
| `CollaboratorName`        | `protocolSection.sponsorCollaboratorsModule.collaborators[].name` |
| `BriefSummary`            | `protocolSection.descriptionModule.briefSummary`                  |
| `DetailedDescription`     | `protocolSection.descriptionModule.detailedDescription`           |
| `Condition`               | `protocolSection.conditionsModule.conditions[]`                   |
| `Keyword`                 | `protocolSection.conditionsModule.keywords[]`                     |
| `StudyType`               | `protocolSection.designModule.studyType`                          |
| `Phase`                   | `protocolSection.designModule.phases[]`                           |
| `EnrollmentCount`         | `protocolSection.designModule.enrollmentInfo.count`               |
| `EnrollmentType`          | `protocolSection.designModule.enrollmentInfo.type`                |
| `DesignAllocation`        | `protocolSection.designModule.designInfo.allocation`              |
| `DesignInterventionModel` | `protocolSection.designModule.designInfo.interventionModel`       |
| `DesignPrimaryPurpose`    | `protocolSection.designModule.designInfo.primaryPurpose`          |
| `DesignMasking`           | `protocolSection.designModule.designInfo.maskingInfo.masking`     |
| `InterventionType`        | `protocolSection.armsInterventionsModule.interventions[].type`    |
| `InterventionName`        | `protocolSection.armsInterventionsModule.interventions[].name`    |
| `ArmGroupLabel`           | `protocolSection.armsInterventionsModule.armGroups[].label`       |
| `ArmGroupType`            | `protocolSection.armsInterventionsModule.armGroups[].type`        |
| `PrimaryOutcomeMeasure`   | `protocolSection.outcomesModule.primaryOutcomes[].measure`        |
| `SecondaryOutcomeMeasure` | `protocolSection.outcomesModule.secondaryOutcomes[].measure`      |
| `EligibilityCriteria`     | `protocolSection.eligibilityModule.eligibilityCriteria`           |
| `Sex`                     | `protocolSection.eligibilityModule.sex`                           |
| `MinimumAge`              | `protocolSection.eligibilityModule.minimumAge`                    |
| `MaximumAge`              | `protocolSection.eligibilityModule.maximumAge`                    |
| `StdAge`                  | `protocolSection.eligibilityModule.stdAges[]`                     |
| `HealthyVolunteers`       | `protocolSection.eligibilityModule.healthyVolunteers`             |
| `LocationFacility`        | `protocolSection.contactsLocationsModule.locations[].facility`    |
| `LocationCity`            | `protocolSection.contactsLocationsModule.locations[].city`        |
| `LocationState`           | `protocolSection.contactsLocationsModule.locations[].state`       |
| `LocationCountry`         | `protocolSection.contactsLocationsModule.locations[].country`     |
| `LocationStatus`          | `protocolSection.contactsLocationsModule.locations[].status`      |
| `LocationGeoPoint`        | `protocolSection.contactsLocationsModule.locations[].geoPoint`    |
| `ReferencePMID`           | `protocolSection.referencesModule.references[].pmid`              |
| `ReferenceCitation`       | `protocolSection.referencesModule.references[].citation`          |
| `ConditionMeshTerm`       | `derivedSection.conditionBrowseModule.meshes[].term`              |
| `InterventionMeshTerm`    | `derivedSection.interventionBrowseModule.meshes[].term`           |

For the **complete** field tree, call `GET /studies/metadata`.

---

## 14. Sort Options

The `sort` parameter accepts up to 2 sort fields (pipe/comma-delimited), each with optional direction:

```
sort=LastUpdatePostDate:desc
sort=EnrollmentCount:desc,LastUpdatePostDate:asc
```

Sortable fields include any indexed field piece name. Common sort fields:

| Sort Field           | Description                                                   |
| :------------------- | :------------------------------------------------------------ |
| `LastUpdatePostDate` | Most recently updated                                         |
| `StudyFirstPostDate` | Newest studies first                                          |
| `EnrollmentCount`    | By enrollment size                                            |
| `@relevance`         | Default relevance ranking (used when query.\* params present) |

Direction: `:asc` (ascending) or `:desc` (descending). Default varies by field.

---

## 15. Filter Syntax -- `filter.advanced` and AREA[]

The `filter.advanced` parameter accepts **Essie expressions** using the `AREA[]` operator to target specific fields.

### Basic AREA Syntax

```
AREA[PieceName]value
```

Example: `AREA[StudyType]INTERVENTIONAL`

### Boolean Operators

| Operator | Usage                          |
| :------- | :----------------------------- |
| `AND`    | Both conditions must match     |
| `OR`     | Either condition must match    |
| `NOT`    | Negate the following condition |
| `()`     | Grouping for precedence        |

Example:

```
AREA[Phase]PHASE3 AND AREA[StudyType]INTERVENTIONAL AND AREA[OverallStatus]RECRUITING
```

### RANGE Operator (dates and numbers)

```
AREA[FieldName]RANGE[min, max]
```

- Use `MIN` for open lower bound, `MAX` for open upper bound
- Date format: `yyyy-MM-dd`

Examples:

```
AREA[LastUpdatePostDate]RANGE[2024-01-01, MAX]
AREA[EnrollmentCount]RANGE[100, 1000]
AREA[StartDate]RANGE[MIN, 2025-12-31]
```

### Complex Expression Examples

```
// Phase 1-4 interventional studies updated since mid-2023
AREA[StudyType]Interventional AND (AREA[Phase]PHASE1 OR AREA[Phase]PHASE2 OR AREA[Phase]PHASE3 OR AREA[Phase]PHASE4) AND AREA[LastUpdatePostDate]RANGE[2023-06-29, MAX]

// FDA-regulated drug studies
AREA[IsFDARegulatedDrug]true

// Studies with results
AREA[ResultsFirstPostDate]RANGE[MIN, MAX]
```

### Verified Behavior

- `filter.advanced` with `AREA[]` syntax is confirmed working (tested: returned 4,103 results for `AREA[Phase]PHASE3 AND AREA[StudyType]INTERVENTIONAL AND AREA[OverallStatus]RECRUITING`)
- Multiple AREA conditions combine with AND/OR
- Parentheses for grouping are supported

---

## 16. Geographic Filtering

### `filter.geo` Syntax

```
distance(latitude, longitude, radius)
```

| Component   | Format          | Example         |
| :---------- | :-------------- | :-------------- |
| `latitude`  | Decimal degrees | `47.6062`       |
| `longitude` | Decimal degrees | `-122.3321`     |
| `radius`    | Number + unit   | `50mi`, `100km` |

Example:

```
filter.geo=distance(47.6062,-122.3321,50mi)
```

**Behavior**: Returns studies where **any** location site falls within the radius. The full study (with all its locations) is returned if at least one site matches.

### `geoDecay` Parameter

Adjusts relevance scoring based on distance:

```
geoDecay=func:exp,scale:50mi,offset:0mi,decay:0.5
```

| Property | Description                                     |
| :------- | :---------------------------------------------- |
| `func`   | Decay function (e.g., `exp`, `gauss`, `linear`) |
| `scale`  | Distance at which decay begins                  |
| `offset` | Distance within which no decay is applied       |
| `decay`  | Decay factor at `scale` distance                |

---

## 17. All Enum Types and Values

### Status (14 values)

| Value                       | Legacy Display            |
| :-------------------------- | :------------------------ |
| `ACTIVE_NOT_RECRUITING`     | Active, not recruiting    |
| `COMPLETED`                 | Completed                 |
| `ENROLLING_BY_INVITATION`   | Enrolling by invitation   |
| `NOT_YET_RECRUITING`        | Not yet recruiting        |
| `RECRUITING`                | Recruiting                |
| `SUSPENDED`                 | Suspended                 |
| `TERMINATED`                | Terminated                |
| `WITHDRAWN`                 | Withdrawn                 |
| `AVAILABLE`                 | Available                 |
| `NO_LONGER_AVAILABLE`       | No longer available       |
| `TEMPORARILY_NOT_AVAILABLE` | Temporarily not available |
| `APPROVED_FOR_MARKETING`    | Approved for marketing    |
| `WITHHELD`                  | Withheld                  |
| `UNKNOWN`                   | Unknown status            |

### Phase (6 values)

`NA`, `EARLY_PHASE1`, `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`

### StudyType (3 values)

`EXPANDED_ACCESS`, `INTERVENTIONAL`, `OBSERVATIONAL`

### Sex (3 values)

`FEMALE`, `MALE`, `ALL`

### StandardAge (3 values)

`CHILD`, `ADULT`, `OLDER_ADULT`

### AgencyClass (9 values)

`NIH`, `FED`, `OTHER_GOV`, `INDIV`, `INDUSTRY`, `NETWORK`, `AMBIG`, `OTHER`, `UNKNOWN`

### InterventionType (11 values)

`BEHAVIORAL`, `BIOLOGICAL`, `COMBINATION_PRODUCT`, `DEVICE`, `DIAGNOSTIC_TEST`, `DIETARY_SUPPLEMENT`, `DRUG`, `GENETIC`, `PROCEDURE`, `RADIATION`, `OTHER`

### DesignAllocation (3 values)

`RANDOMIZED`, `NON_RANDOMIZED`, `NA`

### InterventionalAssignment (5 values)

`SINGLE_GROUP`, `PARALLEL`, `CROSSOVER`, `FACTORIAL`, `SEQUENTIAL`

### PrimaryPurpose (10 values)

`TREATMENT`, `PREVENTION`, `DIAGNOSTIC`, `ECT`, `SUPPORTIVE_CARE`, `SCREENING`, `HEALTH_SERVICES_RESEARCH`, `BASIC_SCIENCE`, `DEVICE_FEASIBILITY`, `OTHER`

### ObservationalModel (9 values)

`COHORT`, `CASE_CONTROL`, `CASE_ONLY`, `CASE_CROSSOVER`, `ECOLOGIC_OR_COMMUNITY`, `FAMILY_BASED`, `DEFINED_POPULATION`, `NATURAL_HISTORY`, `OTHER`

### DesignTimePerspective (4 values)

`RETROSPECTIVE`, `PROSPECTIVE`, `CROSS_SECTIONAL`, `OTHER`

### DesignMasking (5 values)

`NONE`, `SINGLE`, `DOUBLE`, `TRIPLE`, `QUADRUPLE`

### WhoMasked (4 values)

`PARTICIPANT`, `CARE_PROVIDER`, `INVESTIGATOR`, `OUTCOMES_ASSESSOR`

### ArmGroupType (6 values)

`EXPERIMENTAL`, `ACTIVE_COMPARATOR`, `PLACEBO_COMPARATOR`, `SHAM_COMPARATOR`, `NO_INTERVENTION`, `OTHER`

### BioSpecRetention (3 values)

`NONE_RETAINED`, `SAMPLES_WITH_DNA`, `SAMPLES_WITHOUT_DNA`

### EnrollmentType (2 values)

`ACTUAL`, `ESTIMATED`

### DateType (2 values)

`ACTUAL`, `ESTIMATED`

### ResponsiblePartyType (3 values)

`SPONSOR`, `PRINCIPAL_INVESTIGATOR`, `SPONSOR_INVESTIGATOR`

### ReferenceType (3 values)

`BACKGROUND`, `RESULT`, `DERIVED`

### IpdSharing (3 values)

`YES`, `NO`, `UNDECIDED`

### IpdSharingInfoType (5 values)

`STUDY_PROTOCOL`, `SAP`, `ICF`, `CSR`, `ANALYTIC_CODE`

### SamplingMethod (2 values)

`PROBABILITY_SAMPLE`, `NON_PROBABILITY_SAMPLE`

### ContactRole (5 values)

`STUDY_CHAIR`, `STUDY_DIRECTOR`, `PRINCIPAL_INVESTIGATOR`, `SUB_INVESTIGATOR`, `CONTACT`

### OfficialRole (4 values)

`STUDY_CHAIR`, `STUDY_DIRECTOR`, `PRINCIPAL_INVESTIGATOR`, `SUB_INVESTIGATOR`

### RecruitmentStatus (9 values)

`ACTIVE_NOT_RECRUITING`, `COMPLETED`, `ENROLLING_BY_INVITATION`, `NOT_YET_RECRUITING`, `RECRUITING`, `SUSPENDED`, `TERMINATED`, `WITHDRAWN`, `AVAILABLE`

### OrgStudyIdType (6 values)

`NIH`, `FDA`, `VA`, `CDC`, `AHRQ`, `SAMHSA`

### SecondaryIdType (11 values)

`NIH`, `FDA`, `VA`, `CDC`, `AHRQ`, `SAMHSA`, `OTHER_GRANT`, `EUDRACT_NUMBER`, `CTIS`, `REGISTRY`, `OTHER`

### MeasureParam (9 values)

`GEOMETRIC_MEAN`, `GEOMETRIC_LEAST_SQUARES_MEAN`, `LEAST_SQUARES_MEAN`, `LOG_MEAN`, `MEAN`, `MEDIAN`, `NUMBER`, `COUNT_OF_PARTICIPANTS`, `COUNT_OF_UNITS`

### MeasureDispersionType (12 values)

`NA`, `STANDARD_DEVIATION`, `STANDARD_ERROR`, `INTER_QUARTILE_RANGE`, `FULL_RANGE`, `CONFIDENCE_80`, `CONFIDENCE_90`, `CONFIDENCE_95`, `CONFIDENCE_975`, `CONFIDENCE_99`, `CONFIDENCE_OTHER`, `GEOMETRIC_COEFFICIENT`

### OutcomeMeasureType (4 values)

`PRIMARY`, `SECONDARY`, `OTHER_PRE_SPECIFIED`, `POST_HOC`

### ReportingStatus (2 values)

`NOT_POSTED`, `POSTED`

### EventAssessment (2 values)

`NON_SYSTEMATIC_ASSESSMENT`, `SYSTEMATIC_ASSESSMENT`

### AnalysisDispersionType (2 values)

`STANDARD_DEVIATION`, `STANDARD_ERROR_OF_MEAN`

### ConfidenceIntervalNumSides (2 values)

`ONE_SIDED`, `TWO_SIDED`

### NonInferiorityType (8 values)

`SUPERIORITY`, `NON_INFERIORITY`, `EQUIVALENCE`, `OTHER`, `NON_INFERIORITY_OR_EQUIVALENCE`, `SUPERIORITY_OR_OTHER`, `NON_INFERIORITY_OR_EQUIVALENCE_LEGACY`, `SUPERIORITY_OR_OTHER_LEGACY`

### AgreementRestrictionType (3 values)

`LTE60`, `GT60`, `OTHER`

### UnpostedEventType (3 values)

`RESET`, `RELEASE`, `UNRELEASE`

### ViolationEventType (4 values)

`VIOLATION_IDENTIFIED`, `CORRECTION_CONFIRMED`, `PENALTY_IMPOSED`, `ISSUES_IN_LETTER_ADDRESSED_CONFIRMED`

### BrowseLeafRelevance (2 values)

`LOW`, `HIGH`

### FieldStatsType (6 values)

`ENUM`, `STRING`, `DATE`, `INTEGER`, `NUMBER`, `BOOLEAN`

---

## 18. Search Areas -- Detailed Mapping

Each `query.*` parameter searches a weighted set of fields. The weight (0.0--1.0) affects relevance scoring.

### BasicSearch (`query.term`)

Highest-weighted fields: NCTId (1.0), Acronym (1.0), BriefTitle (0.89), OfficialTitle (0.85), Condition (0.81), InterventionName (0.80), InterventionOtherName (0.75), Phase (0.65), StdAge (0.65), BriefSummary (0.60), PrimaryOutcomeMeasure (0.60), Keyword (0.60).

Covers 50+ fields total with decreasing weights down to 0.10.

### ConditionSearch (`query.cond`)

Condition (0.95), BriefTitle (0.60), OfficialTitle (0.55), ConditionMeshTerm (0.50), ConditionAncestorTerm (0.40), Keyword (0.30), NCTId (0.20).

### InterventionSearch (`query.intr`)

InterventionName (0.95), InterventionType (0.85), ArmGroupType (0.85), InterventionOtherName (0.75), BriefTitle (0.65), OfficialTitle (0.60), ArmGroupLabel (0.50), InterventionMeshTerm (0.50), Keyword (0.50), InterventionAncestorTerm (0.40), InterventionDescription (0.40), ArmGroupDescription (0.40).

### TitleSearch (`query.titles`)

Acronym (1.0), BriefTitle (0.95), OfficialTitle (0.80).

### OutcomeSearch (`query.outc`)

PrimaryOutcomeMeasure (0.90), SecondaryOutcomeMeasure (0.80), PrimaryOutcomeDescription (0.60), SecondaryOutcomeDescription (0.50), OtherOutcomeMeasure (0.40), OutcomeMeasureTitle (0.40), OtherOutcomeDescription (0.30), OutcomeMeasureDescription (0.30), OutcomeMeasurePopulationDescription (0.30).

### SponsorSearch (`query.spons`)

LeadSponsorName (1.0), CollaboratorName (0.9), OrgFullName (0.6).

### LocationSearch (`query.locn`)

LocationCity (0.95), LocationState (0.95), LocationCountry (0.95), LocationFacility (0.95), LocationZip (0.35).

### IdSearch (`query.id`)

NCTId (1.0), NCTIdAlias (0.9), Acronym (0.85), OrgStudyId (0.80), SecondaryId (0.75).

### PatientSearch (`query.patient`)

Broadest search area. Covers nearly all fields with similar weighting to BasicSearch but includes patient-relevant fields.

---

## 19. Data Types Reference

| Type              | Format                             | Example                            |
| :---------------- | :--------------------------------- | :--------------------------------- |
| `nct`             | 11-char string                     | `NCT03722472`                      |
| `PartialDate`     | `yyyy`, `yyyy-MM`, or `yyyy-MM-dd` | `2024`, `2024-03`, `2024-03-15`    |
| `NormalizedDate`  | `yyyy-MM-dd`                       | `2024-03-15`                       |
| `DateTimeMinutes` | `yyyy-MM-dd'T'HH:mm`               | `2024-03-15T14:30`                 |
| `NormalizedTime`  | Duration string                    | `18 Years`, `6 Months`             |
| `GeoPoint`        | `{ lat, lon }`                     | `{ "lat": 47.6, "lon": -122.3 }`   |
| `markup`          | String (markdown or legacy HTML)   | Controlled by `markupFormat` param |
| `text`            | Plain string                       | --                                 |
| `boolean`         | JSON boolean                       | `true`, `false`                    |
| `integer`         | JSON number                        | `500`                              |

---

## 20. Example API Calls

### Search recruiting cancer trials

```
GET /api/v2/studies?query.cond=cancer&filter.overallStatus=RECRUITING&pageSize=20&countTotal=true&fields=NCTId,BriefTitle,OverallStatus,Phase,LeadSponsorName,EnrollmentCount,Condition
```

### Fetch a single study

```
GET /api/v2/studies/NCT03722472
```

### Phase 3 interventional trials near Seattle

```
GET /api/v2/studies?filter.advanced=AREA[Phase]PHASE3 AND AREA[StudyType]INTERVENTIONAL&filter.geo=distance(47.6062,-122.3321,50mi)&filter.overallStatus=RECRUITING&pageSize=50
```

### Studies updated in 2024+ with results

```
GET /api/v2/studies?filter.advanced=AREA[LastUpdatePostDate]RANGE[2024-01-01,MAX] AND AREA[ResultsFirstPostDate]RANGE[MIN,MAX]&pageSize=10&countTotal=true
```

### Get all enum definitions

```
GET /api/v2/studies/enums
```

### Get field value distribution

```
GET /api/v2/stats/field/values?fields=OverallStatus,Phase
```

### Get API version

```
GET /api/v2/version
```
