/**
 * Local search index over the full data.gov.sg catalogue.
 *
 * data.gov.sg has no dataset search API (search parameters on /datasets are
 * silently ignored), so we crawl every page of /datasets and /collections
 * (~600 small requests, about 20 seconds), keep the result in memory, and
 * save it to disk so restarts are instant.
 *
 * Refresh strategy (same idea as mcp-datagovmy's GitHub index):
 * - Fresh index (< CATALOG_REFRESH_MS old): served directly
 * - Stale index: served immediately while a background refresh runs
 * - No index yet: callers wait (up to a limit) for the first crawl
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import {
  API_BASES,
  CATALOG_CRAWL_CONCURRENCY,
  CATALOG_INDEX_FILE,
  CATALOG_REFRESH_MS,
  HTTP_TIMEOUT_MS,
  USER_AGENT,
} from '../config.js';
import { resolveAuth, unwrapOgp } from './http-client.js';
import { makeField, SearchField } from './search.js';

// ============================================================================
// Types
// ============================================================================

interface RawDataset {
  datasetId: string;
  createdAt?: string;
  name: string;
  status?: string;
  description?: string;
  format?: string;
  lastUpdatedAt?: string;
  managedByAgencyName?: string;
  coverageStart?: string;
  coverageEnd?: string;
}

interface RawCollection {
  collectionId: string;
  createdAt?: string;
  name: string;
  description?: string;
  lastUpdatedAt?: string;
  frequency?: string;
  sources?: string[];
  managedByAgencyName?: string;
  childDatasets?: string[];
  coverageStart?: string;
  coverageEnd?: string;
}

export interface DatasetEntry {
  id: string;
  name: string;
  description: string;
  format: string;
  agency: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  coverageStart?: string;
  coverageEnd?: string;
  collectionIds: string[];
}

export interface CollectionEntry {
  id: string;
  name: string;
  description: string;
  agency: string;
  frequency?: string;
  sources: string[];
  lastUpdatedAt?: string;
  coverageStart?: string;
  coverageEnd?: string;
  datasetIds: string[];
}

interface CatalogFile {
  version: 1;
  builtAt: string;
  datasets: DatasetEntry[];
  collections: CollectionEntry[];
}

export interface CatalogIndex {
  builtAt: string;
  builtAtMs: number;
  datasets: DatasetEntry[];
  collections: CollectionEntry[];
  datasetById: Map<string, DatasetEntry>;
  collectionById: Map<string, CollectionEntry>;
  datasetFields: Map<string, SearchField[]>;
  collectionFields: Map<string, SearchField[]>;
  agencies: string[];
  formats: Record<string, number>;
}

// ============================================================================
// State
// ============================================================================

let index: CatalogIndex | null = null;
let triedDisk = false;
let refreshPromise: Promise<void> | null = null;
let lastRefreshAttemptMs = 0;
let lastError: string | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Building
// ============================================================================

function buildIndex(file: CatalogFile): CatalogIndex {
  const datasetById = new Map(file.datasets.map((d) => [d.id, d]));
  const collectionById = new Map(file.collections.map((c) => [c.id, c]));

  const datasetFields = new Map<string, SearchField[]>();
  for (const dataset of file.datasets) {
    const collectionNames = dataset.collectionIds
      .map((id) => collectionById.get(id)?.name)
      .filter(Boolean)
      .join(' | ');
    datasetFields.set(dataset.id, [
      makeField(dataset.name, 3),
      makeField(collectionNames, 2),
      makeField(dataset.agency, 1.5),
      makeField(dataset.description, 1),
    ]);
  }

  const collectionFields = new Map<string, SearchField[]>();
  for (const collection of file.collections) {
    collectionFields.set(collection.id, [
      makeField(collection.name, 3),
      makeField(collection.agency, 1.5),
      makeField(collection.sources.join(' '), 1),
      makeField(collection.description, 1),
    ]);
  }

  const formats: Record<string, number> = {};
  const agencies = new Set<string>();
  for (const dataset of file.datasets) {
    formats[dataset.format] = (formats[dataset.format] || 0) + 1;
    if (dataset.agency) agencies.add(dataset.agency);
  }

  return {
    builtAt: file.builtAt,
    builtAtMs: Date.parse(file.builtAt) || 0,
    datasets: file.datasets,
    collections: file.collections,
    datasetById,
    collectionById,
    datasetFields,
    collectionFields,
    agencies: [...agencies].sort(),
    formats,
  };
}

async function fetchCatalogPage<T>(
  kind: 'datasets' | 'collections',
  page: number
): Promise<{ items: T[]; pages: number }> {
  const auth = resolveAuth();
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (auth.apiKey) headers['x-api-key'] = auth.apiKey;

  let lastFailure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await axios.get(`${API_BASES.catalog}/${kind}`, {
        params: { page },
        headers,
        timeout: HTTP_TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (response.status === 429) throw new Error('rate limited');
      const data = unwrapOgp<Record<string, unknown>>(response.data, response.status);
      return {
        items: (data[kind] as T[]) ?? [],
        pages: typeof data.pages === 'number' ? data.pages : 1,
      };
    } catch (error) {
      lastFailure = error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

/** Fetch every page of a listing with limited concurrency. */
async function crawlListing<T>(kind: 'datasets' | 'collections'): Promise<T[]> {
  const first = await fetchCatalogPage<T>(kind, 1);
  const results: T[] = [...first.items];
  const remaining = Array.from({ length: Math.max(0, first.pages - 1) }, (_, i) => i + 2);
  let failures = 0;

  const worker = async () => {
    for (;;) {
      const page = remaining.shift();
      if (page === undefined) return;
      try {
        const { items } = await fetchCatalogPage<T>(kind, page);
        results.push(...items);
      } catch {
        failures++;
      }
    }
  };
  await Promise.all(Array.from({ length: CATALOG_CRAWL_CONCURRENCY }, worker));

  // Accept a few failed pages, but not a badly incomplete catalogue
  if (failures > Math.max(2, first.pages * 0.03)) {
    throw new Error(`${failures} of ${first.pages} ${kind} pages failed to load`);
  }
  return results;
}

async function crawlCatalog(): Promise<CatalogFile> {
  const started = Date.now();
  const [rawDatasets, rawCollections] = await Promise.all([
    crawlListing<RawDataset>('datasets'),
    crawlListing<RawCollection>('collections'),
  ]);

  // Map dataset -> parent collections (collections list their child datasets)
  const parents = new Map<string, string[]>();
  const collections: CollectionEntry[] = [];
  for (const raw of rawCollections) {
    const datasetIds = raw.childDatasets ?? [];
    for (const datasetId of datasetIds) {
      parents.set(datasetId, [...(parents.get(datasetId) ?? []), raw.collectionId]);
    }
    collections.push({
      id: raw.collectionId,
      name: raw.name,
      description: (raw.description ?? '').trim(),
      agency: raw.managedByAgencyName ?? '',
      frequency: raw.frequency,
      sources: raw.sources ?? [],
      lastUpdatedAt: raw.lastUpdatedAt,
      coverageStart: raw.coverageStart,
      coverageEnd: raw.coverageEnd,
      datasetIds,
    });
  }

  const seen = new Set<string>();
  const datasets: DatasetEntry[] = [];
  for (const raw of rawDatasets) {
    if (seen.has(raw.datasetId) || (raw.status && raw.status !== 'active')) continue;
    seen.add(raw.datasetId);
    datasets.push({
      id: raw.datasetId,
      name: raw.name,
      description: (raw.description ?? '').trim(),
      format: (raw.format ?? 'UNKNOWN').toUpperCase(),
      agency: raw.managedByAgencyName ?? '',
      createdAt: raw.createdAt,
      lastUpdatedAt: raw.lastUpdatedAt,
      coverageStart: raw.coverageStart,
      coverageEnd: raw.coverageEnd,
      collectionIds: parents.get(raw.datasetId) ?? [],
    });
  }

  console.log(
    `[catalog] Crawled ${datasets.length} datasets and ${collections.length} collections in ${(
      (Date.now() - started) /
      1000
    ).toFixed(1)}s`
  );
  return { version: 1, builtAt: new Date().toISOString(), datasets, collections };
}

// ============================================================================
// Persistence
// ============================================================================

function loadFromDisk(): void {
  if (triedDisk) return;
  triedDisk = true;
  try {
    if (!fs.existsSync(CATALOG_INDEX_FILE)) return;
    const file = JSON.parse(fs.readFileSync(CATALOG_INDEX_FILE, 'utf-8')) as CatalogFile;
    if (file.version !== 1 || !Array.isArray(file.datasets)) return;
    index = buildIndex(file);
    console.log(
      `[catalog] Loaded ${file.datasets.length} datasets from disk (built ${file.builtAt})`
    );
  } catch (error) {
    console.error('[catalog] Failed to read index from disk:', error);
  }
}

function saveToDisk(file: CatalogFile): void {
  try {
    fs.mkdirSync(path.dirname(CATALOG_INDEX_FILE), { recursive: true });
    const tmp = `${CATALOG_INDEX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, CATALOG_INDEX_FILE);
  } catch (error) {
    console.error('[catalog] Failed to save index to disk:', error);
  }
}

// ============================================================================
// Public API
// ============================================================================

function startRefresh(): void {
  if (refreshPromise) return;
  lastRefreshAttemptMs = Date.now();
  refreshPromise = crawlCatalog()
    .then((file) => {
      index = buildIndex(file);
      lastError = undefined;
      saveToDisk(file);
    })
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('[catalog] Refresh failed:', lastError);
    })
    .finally(() => {
      refreshPromise = null;
    });
}

/**
 * Get the catalogue index. If none exists yet, waits up to `waitMs` for the
 * first crawl and returns null if it is still not ready.
 */
export async function getCatalog(waitMs = 35_000): Promise<CatalogIndex | null> {
  loadFromDisk();

  const isFresh = index !== null && Date.now() - index.builtAtMs < CATALOG_REFRESH_MS;
  if (!isFresh) {
    // Retry failed refreshes after a cooldown (shorter when we have nothing)
    const cooldown = index ? 5 * 60_000 : 15_000;
    if (Date.now() - lastRefreshAttemptMs > cooldown) startRefresh();
  }

  if (index) return index;
  if (refreshPromise && waitMs > 0) {
    await Promise.race([refreshPromise, sleep(waitMs)]);
  }
  return index;
}

/** Start loading the index in the background (call once at startup). */
export function warmCatalog(): void {
  getCatalog(0).catch(() => undefined);
}

export function getCatalogStatus() {
  return {
    ready: index !== null,
    datasets: index?.datasets.length ?? 0,
    collections: index?.collections.length ?? 0,
    builtAt: index?.builtAt ?? null,
    ageHours: index ? Number(((Date.now() - index.builtAtMs) / 3_600_000).toFixed(1)) : null,
    refreshing: refreshPromise !== null,
    lastError: lastError ?? null,
  };
}

/** Throw a friendly error when the index is unavailable. */
export async function requireCatalog(): Promise<CatalogIndex> {
  const catalog = await getCatalog();
  if (!catalog) {
    throw new Error(
      'The data.gov.sg catalogue index is still being built (first start takes about 30 seconds). Please retry shortly.'
    );
  }
  return catalog;
}
