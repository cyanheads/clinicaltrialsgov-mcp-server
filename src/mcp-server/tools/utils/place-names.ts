/**
 * @fileoverview Place-name folding, and the registry spellings of the country
 * and US state synonyms ClinicalTrials.gov resolves, for ranking a study's sites
 * against a requested location.
 * @module mcp-server/tools/utils/place-names
 */

/**
 * The words of a place name, folded the way upstream folds a location match so
 * a site ranks the way it was found: `Montréal` and `Montreal`, `Wrocław` and
 * `Wroclaw`, `St. Louis` and `St Louis`. Lowercased first, since stripping
 * marks before lowercasing changes context-dependent case mappings (`İ`); then
 * decomposed and stripped of combining marks; then the Latin letters with no
 * decomposition mapped; then periods and apostrophes deleted, so `D.C.` is one
 * word, `dc`; then split on every run of anything but letters and digits. Each
 * step is one linear pass over the name.
 */
export function foldedWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ß', 'ss')
    .replaceAll('æ', 'ae')
    .replaceAll('ø', 'o')
    .replaceAll('ł', 'l')
    .replaceAll('ı', 'i')
    .replace(/[.'’‘ʼ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** A place name's folded words joined by single spaces, the form the tables are keyed by. */
function foldedKey(name: string): string {
  return foldedWords(name).join(' ');
}

/**
 * Country synonyms, by the spelling the registry files on its site records.
 * Each synonym was measured to match exactly the registry spelling's studies
 * through `AREA[LocationCountry]` (symmetric difference 0); a row is added only
 * after the same check. The registry files the US territories as countries,
 * never as US states, so their codes are country rows.
 */
const COUNTRY_SYNONYMS: Record<string, readonly string[]> = {
  'United States': ['USA', 'US', 'U.S.A.', 'United States of America'],
  'United Kingdom': ['UK', 'U.K.', 'GB', 'Great Britain', 'Britain', 'England'],
  Czechia: ['Czech Republic'],
  'South Korea': ['Republic of Korea', 'Korea, Republic of'],
  Russia: ['Russian Federation'],
  Iran: ['Iran, Islamic Republic of', 'Islamic Republic of Iran'],
  Vietnam: ['Viet Nam'],
  Netherlands: ['Holland', 'The Netherlands'],
  Taiwan: ['Taiwan, Province of China'],
  Burma: ['Myanmar'],
  Eswatini: ['Swaziland'],
  'Côte d’Ivoire': ['Ivory Coast'],
  'Cabo Verde': ['Cape Verde'],
  'Puerto Rico': ['PR'],
  Guam: ['GU'],
  'Virgin Islands': ['VI'],
  'American Samoa': ['AS'],
  'Northern Mariana Islands': ['MP'],
};

/**
 * The 50 state abbreviations and DC, by the name the registry files. Each was
 * measured bound to the United States, as find_eligible binds a state:
 * `AREA[LocationState]"WA"` with `AREA[LocationCountry]"United States"` matches
 * exactly the studies `Washington` does. Unbound they differ (`WA` also covers
 * Western Australia), so these rows apply only to a United States request.
 */
const US_STATE_ABBREVIATIONS: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
};

const COUNTRY_BY_KEY = new Map(
  Object.entries(COUNTRY_SYNONYMS).flatMap(([registry, synonyms]) =>
    synonyms.map((synonym) => [foldedKey(synonym), registry] as const),
  ),
);

const US_STATE_BY_KEY = new Map(
  Object.entries(US_STATE_ABBREVIATIONS).map(([abbr, name]) => [foldedKey(abbr), name] as const),
);

const UNITED_STATES_KEY = foldedKey('United States');

/**
 * The registry's spelling of a requested country when it folds (`foldedWords`)
 * to a synonym row — `USA` and `u.s.a.` give `United States` — else the request
 * as given.
 */
export function registryCountry(requested: string): string {
  return COUNTRY_BY_KEY.get(foldedKey(requested)) ?? requested;
}

/**
 * The registry's spelling of a requested state: a US state or DC abbreviation
 * (`WA`, `d.c.`) gives its name when `country` is, or resolves through
 * `registryCountry` to, the United States; anything else is returned as given.
 */
export function registryState(requested: string, country: string): string {
  if (foldedKey(registryCountry(country)) !== UNITED_STATES_KEY) return requested;
  return US_STATE_BY_KEY.get(foldedKey(requested)) ?? requested;
}
