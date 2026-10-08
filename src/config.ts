/**
 * Central configuration: environment variables, upstream API base URLs,
 * cache lifetimes and the data.gov.sg rate-limit table.
 *
 * Everything that can be tuned per deployment lives here so the tool files
 * stay focused on shaping data.
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// ============================================================================
// Server identity
// ============================================================================
export const SERVER_NAME = 'Singapore Open Data MCP Server';
export const SERVER_SLUG = 'mcp-datagovsg';
export const SERVER_VERSION = '2.0.0';
export const REPO_URL = 'https://github.com/hithereiamaliff/mcp-datagovsg';
export const KEY_PORTAL_URL = 'https://mcpkeys.techmavie.digital';

// ============================================================================
// Upstream APIs
// ============================================================================
export const API_BASES = {
  /** Collections + datasets metadata (not rate limited) */
  catalog: 'https://api-production.data.gov.sg/v2/public/api',
  /** CKAN-style row search inside a dataset */
  datastore: 'https://data.gov.sg/api/action',
  /** initiate-download / poll-download */
  download: 'https://api-open.data.gov.sg/v1/public/api',
  /** v2 real-time environment APIs (weather, PSI, UV, WBGT, floods, radar...) */
  realtime: 'https://api-open.data.gov.sg/v2/real-time/api',
  /** Transport real-time APIs are still served from v1 */
  transport: 'https://api.data.gov.sg/v1/transport',
  /** SingStat Table Builder */
  singstat: 'https://tablebuilder.singstat.gov.sg/api/table',
} as const;

export const DATASET_PAGE_URL = (datasetId: string) =>
  `https://data.gov.sg/datasets/${datasetId}/view`;
export const COLLECTION_PAGE_URL = (collectionId: string) =>
  `https://data.gov.sg/collections/${collectionId}/view`;
export const SINGSTAT_TABLE_URL = (resourceId: string) =>
  `https://tablebuilder.singstat.gov.sg/table/TS/${resourceId}`;

export const DATAGOVSG_SOURCE = 'data.gov.sg (Singapore Open Data Licence v1.0)';
export const SINGSTAT_SOURCE = 'SingStat Table Builder, Department of Statistics Singapore';

// ============================================================================
// Credentials
// ============================================================================

/**
 * The operator's own data.gov.sg API key. Used for every request unless the
 * caller supplies their own key via the MCP Key Service (usr_... key).
 * Optional: without it the server falls back to anonymous (lowest) limits.
 */
export const DATAGOVSG_API_KEY = (process.env.DATAGOVSG_API_KEY || '').trim();

/** Tier of DATAGOVSG_API_KEY, used to pace requests under its rate limit. */
export const DATAGOVSG_API_KEY_TIER: KeyTier =
  process.env.DATAGOVSG_API_KEY_TIER === 'developer' ? 'developer' : 'production';

// ============================================================================
// Rate limits (requests per 10-second window, per API key or per IP)
// Source: https://guide.data.gov.sg/developer-guide/api-overview/api-rate-limits
// ============================================================================
export type KeyTier = 'anonymous' | 'developer' | 'production';
export type RateCategory =
  'catalog' | 'datastore' | 'download' | 'realtime' | 'transport' | 'singstat';

export const RATE_WINDOW_MS = 10_500; // 10s upstream window + a small safety margin

export const RATE_LIMITS: Record<KeyTier, Record<RateCategory, number>> = {
  anonymous: { catalog: 20, datastore: 4, download: 2, realtime: 6, transport: 6, singstat: 15 },
  developer: { catalog: 20, datastore: 8, download: 4, realtime: 12, transport: 12, singstat: 15 },
  production: {
    catalog: 30,
    datastore: 20,
    download: 10,
    realtime: 30,
    transport: 30,
    singstat: 15,
  },
};

/** How long a request may wait in the local queue before we give up. */
export const RATE_MAX_WAIT_MS = parseInt(process.env.RATE_MAX_WAIT_MS || '20000', 10);

// ============================================================================
// Caching (milliseconds). Upstream data is public, so cache entries are
// shared across all callers regardless of which API key they use.
// ============================================================================
export const CACHE_TTL = {
  realtime: 60_000, // readings update every 1-5 minutes
  realtimeHistorical: 60 * 60_000, // past dates do not change
  transport: 60_000,
  datastore: 5 * 60_000, // matches upstream Cache-Control: max-age=300
  metadata: 6 * 60 * 60_000,
  download: 30 * 60_000, // presigned links expire after 1 hour
  carparkInfo: 24 * 60 * 60_000,
  singstatSearch: 60 * 60_000,
  singstatMetadata: 6 * 60 * 60_000,
  singstatData: 60 * 60_000,
} as const;

export const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10);

// ============================================================================
// Catalogue index (local search over every data.gov.sg dataset/collection)
// ============================================================================
export const DATA_DIR = path.resolve(
  process.env.DATA_DIR || process.env.ANALYTICS_DIR || path.join(process.cwd(), 'data')
);
export const CATALOG_INDEX_FILE = path.join(DATA_DIR, 'catalog-index.json');
export const CATALOG_REFRESH_MS = parseInt(
  process.env.CATALOG_REFRESH_MS || String(24 * 60 * 60_000),
  10
);
export const CATALOG_CRAWL_CONCURRENCY = parseInt(process.env.CATALOG_CRAWL_CONCURRENCY || '8', 10);

// ============================================================================
// HTTP
// ============================================================================
export const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10);
export const USER_AGENT = `${SERVER_SLUG}/${SERVER_VERSION} (+${REPO_URL})`;
