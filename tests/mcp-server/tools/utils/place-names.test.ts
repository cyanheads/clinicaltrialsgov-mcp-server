/**
 * @fileoverview Tests for the registry spellings of country and US state
 * synonyms — every row tabled once here; find_eligible's suite proves the wiring.
 * @module tests/mcp-server/tools/utils/place-names
 */

import { describe, expect, it } from 'vitest';
import { registryCountry, registryState } from '@/mcp-server/tools/utils/place-names.js';
import { expectLinearGrowth, LINE_BREAK_SHAPES } from '../../../helpers/cpu-timing.js';

/** Every country synonym row, as measured upstream (symmetric difference 0). */
const COUNTRY_ROWS = [
  ['USA', 'United States'],
  ['US', 'United States'],
  ['U.S.A.', 'United States'],
  ['United States of America', 'United States'],
  ['UK', 'United Kingdom'],
  ['U.K.', 'United Kingdom'],
  ['GB', 'United Kingdom'],
  ['Great Britain', 'United Kingdom'],
  ['Britain', 'United Kingdom'],
  ['England', 'United Kingdom'],
  ['Czech Republic', 'Czechia'],
  ['Republic of Korea', 'South Korea'],
  ['Korea, Republic of', 'South Korea'],
  ['Russian Federation', 'Russia'],
  ['Iran, Islamic Republic of', 'Iran'],
  ['Islamic Republic of Iran', 'Iran'],
  ['Viet Nam', 'Vietnam'],
  ['Holland', 'Netherlands'],
  ['The Netherlands', 'Netherlands'],
  ['Taiwan, Province of China', 'Taiwan'],
  ['Myanmar', 'Burma'],
  ['Swaziland', 'Eswatini'],
  ['Ivory Coast', 'Côte d’Ivoire'],
  ['Cape Verde', 'Cabo Verde'],
  ['PR', 'Puerto Rico'],
  ['GU', 'Guam'],
  ['VI', 'Virgin Islands'],
  ['AS', 'American Samoa'],
  ['MP', 'Northern Mariana Islands'],
] as const;

/** The 50 state abbreviations and DC, as measured bound to the United States. */
const US_STATE_ROWS = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
  ['DC', 'District of Columbia'],
] as const;

describe('registryCountry', () => {
  it.each(COUNTRY_ROWS)('compares %j as %j', (synonym, registry) => {
    expect(registryCountry(synonym)).toBe(registry);
  });

  // The #166 fold runs before the lookup: case, diacritics, periods,
  // apostrophes, punctuation, and spacing reach the same row.
  it.each([
    ['usa', 'United States'],
    ['u.s.a', 'United States'],
    ['  united   STATES of america ', 'United States'],
    ['u.k.', 'United Kingdom'],
    ['Ü.K.', 'United Kingdom'],
    ['great-britain', 'United Kingdom'],
    ['KOREA, REPUBLIC OF', 'South Korea'],
    ['korea republic of', 'South Korea'],
    ['Iran (Islamic Republic of)', 'Iran'],
    ['VIET-NAM', 'Vietnam'],
    ['p.r.', 'Puerto Rico'],
    // Folds to the US row. Upstream matches no study for U.S., so the row
    // never ranks a site for it.
    ['U.S.', 'United States'],
  ])('folds %j to its row', (spelling, registry) => {
    expect(registryCountry(spelling)).toBe(registry);
  });

  it.each([
    'United States',
    'United Kingdom',
    'Czechia',
    'South Korea',
    'Russia',
    'Iran',
    'Vietnam',
    'Netherlands',
    'Taiwan',
    'Burma',
    'Eswatini',
    'Côte d’Ivoire',
    'Cabo Verde',
    'Puerto Rico',
    'Guam',
    'Virgin Islands',
    'American Samoa',
    'Northern Mariana Islands',
  ])('keeps the registry spelling %j as it is', (registry) => {
    expect(registryCountry(registry)).toBe(registry);
  });

  // Spellings outside the table rank as before: the gate's word test (Korea
  // on South Korea, México on Mexico) or the ungated fallback (CZ).
  it.each([
    'Korea',
    'México',
    'Mexico',
    'Canada',
    'CZ',
    'Turkey',
    'Macedonia',
    'America',
    'United',
    'States',
    'United States Minor Outlying Islands',
    'Korea Republic',
    'USA UK',
    '',
    '.',
    '__proto__',
    'constructor',
    'toString',
  ])('returns %j unchanged', (spelling) => {
    expect(registryCountry(spelling)).toBe(spelling);
  });
});

describe('registryState', () => {
  it.each(US_STATE_ROWS)('compares %j as %j in the United States', (abbreviation, name) => {
    expect(registryState(abbreviation, 'United States')).toBe(name);
  });

  it.each(['United States', 'united states', 'USA', 'us', 'U.S.A.', 'United States of America'])(
    'applies the state rows when the country is %j',
    (country) => {
      expect(registryState('WA', country)).toBe('Washington');
    },
  );

  it.each([
    ['wa', 'Washington'],
    ['W.A.', 'Washington'],
    [' Wa ', 'Washington'],
    ['d.c.', 'District of Columbia'],
    ['N.Y.', 'New York'],
  ])('folds %j to its row', (spelling, name) => {
    expect(registryState(spelling, 'United States')).toBe(name);
  });

  // Unbound, WA is not Washington: it also covers Western Australia. The rows
  // apply only when the country is or resolves to the United States.
  it.each([
    'Australia',
    'Canada',
    'UK',
    'States',
    'United',
    'America',
    'United States Minor Outlying Islands',
    'Puerto Rico',
    'PR',
    'CZ',
  ])('leaves WA as it is when the country is %j', (country) => {
    expect(registryState('WA', country)).toBe('WA');
  });

  it.each([
    'Washington',
    'Ontario',
    'Western Australia',
    'Washington DC',
    // The territories are filed as countries, never as US states.
    'PR',
    'GU',
    'VI',
    'AS',
    'MP',
    'USA',
    '',
    '__proto__',
    'constructor',
  ])('returns %j unchanged in the United States', (state) => {
    expect(registryState(state, 'United States')).toBe(state);
  });
});

describe('place-name lookups stay linear on caller-sized text', () => {
  const lookups: Array<[name: string, fn: (input: string) => unknown]> = [
    ['registryCountry', registryCountry],
    ['registryState, state', (s) => registryState(s, 'United States')],
    ['registryState, country', (s) => registryState('WA', s)],
  ];
  for (const [name, fn] of lookups) {
    it.each(LINE_BREAK_SHAPES)(`${name}: %s`, (_shape, shape) => {
      expectLinearGrowth(fn, shape);
    });
  }
});
