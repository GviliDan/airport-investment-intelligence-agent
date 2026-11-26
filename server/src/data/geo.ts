export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

const BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));

/**
 * Turns "CA", "ca" or "California" into "CA". Returns undefined when the text is not a known state, so callers can
 * report the problem instead of guessing. (A bare "WA" is Washington; "Washington" is also the state, not the city.)
 */
export function normalizeState(text: string): string | undefined {
  const t = text.trim();
  const upper = t.toUpperCase();
  if (upper in US_STATES) return upper;
  return BY_NAME.get(t.toLowerCase());
}

const EARTH_RADIUS_MI = 3958.8;
const rad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance in statute miles. */
export function distanceMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * U.S. Census Bureau divisions. This is reference data for translating a place name into states; analytics code takes
 * explicit state lists and never assumes a region. Names beyond the Census ones are not defined here on purpose.
 */
export const CENSUS_DIVISIONS: Readonly<Record<string, readonly string[]>> = {
  'New England': ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'],
  'Middle Atlantic': ['NJ', 'NY', 'PA'],
  'East North Central': ['IL', 'IN', 'MI', 'OH', 'WI'],
  'West North Central': ['IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
  'South Atlantic': ['DE', 'DC', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'WV'],
  'East South Central': ['AL', 'KY', 'MS', 'TN'],
  'West South Central': ['AR', 'LA', 'OK', 'TX'],
  Mountain: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY'],
  Pacific: ['AK', 'CA', 'HI', 'OR', 'WA'],
};

export const CENSUS_REGIONS: Readonly<Record<string, readonly string[]>> = {
  Northeast: [...(CENSUS_DIVISIONS['New England'] as string[]), ...(CENSUS_DIVISIONS['Middle Atlantic'] as string[])],
  Midwest: [...(CENSUS_DIVISIONS['East North Central'] as string[]), ...(CENSUS_DIVISIONS['West North Central'] as string[])],
  South: [...(CENSUS_DIVISIONS['South Atlantic'] as string[]), ...(CENSUS_DIVISIONS['East South Central'] as string[]), ...(CENSUS_DIVISIONS['West South Central'] as string[])],
  West: [...(CENSUS_DIVISIONS['Mountain'] as string[]), ...(CENSUS_DIVISIONS['Pacific'] as string[])],
};
