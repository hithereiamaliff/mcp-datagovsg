/**
 * Singapore place names used to make search place-aware.
 *
 * Most Singapore datasets are island-wide with a town or planning-area
 * column, not one dataset per place. When a query names a planning area or
 * HDB town ("Woodlands", "Jurong West"), search can point at location tools
 * and at tables broken down by planning area.
 */

/** HDB resale flat prices (registration date from Jan 2017), filterable by town */
export const HDB_RESALE_DATASET = 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc';

/** URA Master Plan 2019 planning areas */
const PLANNING_AREAS = [
  'Ang Mo Kio',
  'Bedok',
  'Bishan',
  'Boon Lay',
  'Bukit Batok',
  'Bukit Merah',
  'Bukit Panjang',
  'Bukit Timah',
  'Central Water Catchment',
  'Changi',
  'Changi Bay',
  'Choa Chu Kang',
  'Clementi',
  'Downtown Core',
  'Geylang',
  'Hougang',
  'Jurong East',
  'Jurong West',
  'Kallang',
  'Lim Chu Kang',
  'Mandai',
  'Marina East',
  'Marina South',
  'Marine Parade',
  'Museum',
  'Newton',
  'North-Eastern Islands',
  'Novena',
  'Orchard',
  'Outram',
  'Pasir Ris',
  'Paya Lebar',
  'Pioneer',
  'Punggol',
  'Queenstown',
  'River Valley',
  'Rochor',
  'Seletar',
  'Sembawang',
  'Sengkang',
  'Serangoon',
  'Simpang',
  'Singapore River',
  'Southern Islands',
  'Straits View',
  'Sungei Kadut',
  'Tampines',
  'Tanglin',
  'Tengah',
  'Toa Payoh',
  'Tuas',
  'Western Islands',
  'Western Water Catchment',
  'Woodlands',
  'Yishun',
];

/** HDB town names as they appear in the resale dataset's `town` column */
const HDB_TOWNS: Record<string, string> = {
  'ang mo kio': 'ANG MO KIO',
  bedok: 'BEDOK',
  bishan: 'BISHAN',
  'bukit batok': 'BUKIT BATOK',
  'bukit merah': 'BUKIT MERAH',
  'bukit panjang': 'BUKIT PANJANG',
  'bukit timah': 'BUKIT TIMAH',
  'central area': 'CENTRAL AREA',
  'choa chu kang': 'CHOA CHU KANG',
  clementi: 'CLEMENTI',
  geylang: 'GEYLANG',
  hougang: 'HOUGANG',
  'jurong east': 'JURONG EAST',
  'jurong west': 'JURONG WEST',
  kallang: 'KALLANG/WHAMPOA',
  whampoa: 'KALLANG/WHAMPOA',
  'marine parade': 'MARINE PARADE',
  'pasir ris': 'PASIR RIS',
  punggol: 'PUNGGOL',
  queenstown: 'QUEENSTOWN',
  sembawang: 'SEMBAWANG',
  sengkang: 'SENGKANG',
  serangoon: 'SERANGOON',
  tampines: 'TAMPINES',
  'toa payoh': 'TOA PAYOH',
  woodlands: 'WOODLANDS',
  yishun: 'YISHUN',
};

/**
 * Well-known estates inside a larger HDB town. `street` is set when the
 * estate name also appears in HDB street names (e.g. MARSILING DR), so resale
 * queries can be narrowed to the estate.
 */
const ESTATES: Record<string, { town: string; street?: string }> = {
  marsiling: { town: 'WOODLANDS', street: 'MARSILING' },
  admiralty: { town: 'WOODLANDS', street: 'ADMIRALTY' },
  'teck whye': { town: 'CHOA CHU KANG', street: 'TECK WHYE' },
  'keat hong': { town: 'CHOA CHU KANG', street: 'KEAT HONG' },
  'yew tee': { town: 'CHOA CHU KANG' },
  'bukit gombak': { town: 'BUKIT BATOK' },
  'tiong bahru': { town: 'BUKIT MERAH', street: 'TIONG BAHRU' },
  redhill: { town: 'BUKIT MERAH', street: 'REDHILL' },
  'telok blangah': { town: 'BUKIT MERAH', street: 'TELOK BLANGAH' },
  henderson: { town: 'BUKIT MERAH', street: 'HENDERSON' },
  commonwealth: { town: 'QUEENSTOWN', street: 'COMMONWEALTH' },
  dover: { town: 'QUEENSTOWN', street: 'DOVER' },
  'ghim moh': { town: 'QUEENSTOWN', street: 'GHIM MOH' },
  'buona vista': { town: 'QUEENSTOWN' },
  simei: { town: 'TAMPINES', street: 'SIMEI' },
  'chai chee': { town: 'BEDOK', street: 'CHAI CHEE' },
  kembangan: { town: 'BEDOK' },
  aljunied: { town: 'GEYLANG', street: 'ALJUNIED' },
  macpherson: { town: 'GEYLANG', street: 'MACPHERSON' },
  'potong pasir': { town: 'TOA PAYOH', street: 'POTONG PASIR' },
  kovan: { town: 'HOUGANG' },
  buangkok: { town: 'HOUGANG', street: 'BUANGKOK' },
  compassvale: { town: 'SENGKANG', street: 'COMPASSVALE' },
  rivervale: { town: 'SENGKANG', street: 'RIVERVALE' },
  anchorvale: { town: 'SENGKANG', street: 'ANCHORVALE' },
  fernvale: { town: 'SENGKANG', street: 'FERNVALE' },
  canberra: { town: 'SEMBAWANG', street: 'CANBERRA' },
  khatib: { town: 'YISHUN' },
  'chong pang': { town: 'YISHUN' },
  yuhua: { town: 'JURONG EAST' },
  'taman jurong': { town: 'JURONG WEST' },
  'boon keng': { town: 'KALLANG/WHAMPOA', street: 'BOON KENG' },
  bendemeer: { town: 'KALLANG/WHAMPOA', street: 'BENDEMEER' },
  'marine terrace': { town: 'MARINE PARADE', street: 'MARINE TER' },
};

export interface DetectedPlace {
  name: string;
  isPlanningArea: boolean;
  /** Value for the HDB resale dataset's `town` filter, when it is an HDB town */
  hdbTown?: string;
  /** Estate name found in HDB street names, to narrow resale queries */
  streetKeyword?: string;
  /** For estates: the HDB town / planning area they belong to */
  partOf?: string;
}

const normalise = (text: string) =>
  ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

const CANDIDATES = [
  ...new Set([
    ...PLANNING_AREAS.map((p) => p.toLowerCase()),
    ...Object.keys(HDB_TOWNS),
    ...Object.keys(ESTATES),
  ]),
]
  // Longest first so "jurong west" wins over shorter overlaps
  .sort((a, b) => b.length - a.length);

const titleCase = (text: string) => text.replace(/\b\w/g, (c) => c.toUpperCase());

/** Find a planning area, HDB town or well-known estate named in the query (whole words). */
export function detectPlace(query: string): DetectedPlace | undefined {
  const text = normalise(query);
  for (const candidate of CANDIDATES) {
    if (!text.includes(normalise(candidate))) continue;
    const planningArea = PLANNING_AREAS.find((p) => p.toLowerCase() === candidate);
    const estate = planningArea || HDB_TOWNS[candidate] ? undefined : ESTATES[candidate];
    if (estate) {
      return {
        name: titleCase(candidate),
        isPlanningArea: false,
        hdbTown: estate.town,
        streetKeyword: estate.street,
        partOf: titleCase(estate.town.split('/')[0].toLowerCase()),
      };
    }
    return {
      name: planningArea ?? titleCase(candidate),
      isPlanningArea: Boolean(planningArea),
      hdbTown: HDB_TOWNS[candidate],
    };
  }
  return undefined;
}

/** Ready-to-run tool calls for questions about a place. */
export function placeGuide(place: DetectedPlace) {
  const suggestions: { for: string; tool: string; args: Record<string, unknown> }[] = [
    {
      for: 'Current weather, rain, haze (PSI), UV, heat stress and flood alerts',
      tool: 'datagovsg_get_current_conditions',
      args: { area: place.name },
    },
    {
      for: 'Live HDB carpark lots nearby',
      tool: 'datagovsg_get_carpark_availability',
      args: { place: place.name, radius_km: 1 },
    },
    {
      for: 'Available taxis nearby',
      tool: 'datagovsg_get_taxi_availability',
      args: { place: place.name },
    },
  ];
  if (place.hdbTown) {
    suggestions.push({
      for: place.streetKeyword
        ? `Recent HDB resale transactions on ${titleCase(place.streetKeyword.toLowerCase())} streets`
        : `Recent HDB resale transactions in ${place.partOf ?? place.name}`,
      tool: 'datagovsg_query_dataset',
      args: {
        dataset_id: HDB_RESALE_DATASET,
        filters: { town: place.hdbTown },
        ...(place.streetKeyword ? { q: { street_name: place.streetKeyword } } : {}),
        sort: 'month desc',
        limit: 20,
      },
    });
  }
  const areaForTables = place.partOf ?? place.name;
  return {
    name: place.name,
    kind: place.partOf
      ? `estate in ${place.partOf}`
      : [
          place.isPlanningArea ? 'URA planning area' : undefined,
          place.hdbTown ? 'HDB town' : undefined,
        ]
          .filter(Boolean)
          .join(' and '),
    suggestions,
    note: `Most Singapore datasets are island-wide with a town or planning-area column, so filter them by area rather than searching for a dataset per place. SingStat tables "by Planning Area" include ${areaForTables} as a row.`,
  };
}
