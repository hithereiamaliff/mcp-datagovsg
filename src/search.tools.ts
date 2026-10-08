/**
 * Discovery tools: unified search, dataset search and collection listing.
 *
 * Dataset/collection search runs against the local catalogue index
 * (utils/catalog-index.ts) because data.gov.sg has no search API.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  COLLECTION_PAGE_URL,
  DATAGOVSG_SOURCE,
  DATASET_PAGE_URL,
  SINGSTAT_TABLE_URL,
} from './config.js';
import { nextStepFor } from './datasets.tools.js';
import { searchSingstatTables } from './singstat.tools.js';
import {
  CatalogIndex,
  getCatalog,
  getCatalogStatus,
  requireCatalog,
} from './utils/catalog-index.js';
import { round, truncate } from './utils/format.js';
import { detectPlace, placeGuide } from './utils/places.js';
import { REALTIME_APIS } from './utils/realtime-catalog.js';
import { makeField, recencyBoost, scoreDocument } from './utils/search.js';
import { datagovsgTool, registerReadOnlyTool, ToolContext } from './utils/tool-helpers.js';

type ResultType = 'realtime_api' | 'dataset' | 'collection' | 'singstat_table';

/** Max time search_all waits for SingStat before returning without it */
const SINGSTAT_BUDGET_MS = 12_000;

interface UnifiedResult {
  type: ResultType;
  id: string;
  title: string;
  description?: string;
  agency?: string;
  format?: string;
  last_updated?: string;
  score: number;
  next_step?: { tool: string; args: Record<string, unknown> };
  url?: string;
}

const REALTIME_FIELDS = new Map(
  REALTIME_APIS.map((api) => [
    api.datasetId,
    [makeField(api.name, 3), makeField(api.keywords, 2), makeField(api.description, 1)],
  ])
);

function searchDatasetsInIndex(catalog: CatalogIndex, query: string) {
  const hits: { id: string; score: number }[] = [];
  for (const dataset of catalog.datasets) {
    const fields = catalog.datasetFields.get(dataset.id);
    if (!fields) continue;
    const score = scoreDocument(query, fields);
    if (score > 0)
      hits.push({ id: dataset.id, score: score * recencyBoost(dataset.lastUpdatedAt) });
  }
  return hits.sort((a, b) => b.score - a.score);
}

function searchCollectionsInIndex(catalog: CatalogIndex, query: string) {
  const hits: { id: string; score: number }[] = [];
  for (const collection of catalog.collections) {
    const fields = catalog.collectionFields.get(collection.id);
    if (!fields) continue;
    const score = scoreDocument(query, fields);
    if (score > 0)
      hits.push({ id: collection.id, score: score * recencyBoost(collection.lastUpdatedAt) });
  }
  return hits.sort((a, b) => b.score - a.score);
}

const sinceFilter = (since?: string) => {
  const time = since ? Date.parse(since) : NaN;
  return (lastUpdated?: string) =>
    Number.isNaN(time) || (lastUpdated !== undefined && Date.parse(lastUpdated) >= time);
};

export function registerSearchTools(server: McpServer, ctx: ToolContext) {
  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('search_all'),
    {
      title: 'Search all Singapore open data',
      description:
        '⭐ START HERE for any question about Singapore government data. One search across: (1) all ~4,600 data.gov.sg datasets and their collections, (2) real-time APIs (weather, rainfall, air quality/PSI, UV, heat stress, lightning, flood alerts, radar, HDB carparks, taxis, traffic cameras), and (3) SingStat Table Builder statistics (GDP, CPI, population, labour...). Every result includes `next_step`: the exact tool and arguments to call next. When the query names a town or planning area (e.g. "Woodlands"), a `place_guide` lists ready-to-run location calls and SingStat tables broken down by planning area.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'What you are looking for, e.g. "HDB resale prices", "dengue clusters", "GDP", "rainfall"'
          ),
        limit: z.number().int().min(1).max(30).optional().describe('Max results (default 10)'),
        include_singstat: z
          .boolean()
          .optional()
          .describe('Also search SingStat statistics tables (default true)'),
      },
      errorContext: 'Search failed',
    },
    async ({ query, limit = 10, include_singstat = true }) => {
      // SingStat search is slow (~7s per call). Give it a time budget so it
      // never holds up data.gov.sg results; a late answer still warms the cache.
      const singstatSearch = include_singstat
        ? Promise.race([
            searchSingstatTables(query, ctx.auth).catch((error: unknown) => ({
              error: error instanceof Error ? error.message : String(error),
            })),
            new Promise<{ error: string }>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    error: `timed out after ${SINGSTAT_BUDGET_MS / 1000}s; try singstat_search_tables directly`,
                  }),
                SINGSTAT_BUDGET_MS
              )
            ),
          ])
        : Promise.resolve(undefined);
      const [catalog, singstat] = await Promise.all([getCatalog(), singstatSearch]);
      const place = detectPlace(query);

      const results: UnifiedResult[] = [];

      // Real-time APIs get a small boost: they answer "now" questions directly
      for (const api of REALTIME_APIS) {
        const score = scoreDocument(query, REALTIME_FIELDS.get(api.datasetId)!);
        if (score > 0) {
          results.push({
            type: 'realtime_api',
            id: api.datasetId,
            title: api.name,
            description: `${api.description} (updates every ${api.updateFrequency})`,
            score: score * 1.25,
            next_step: { tool: api.tool, args: api.args ?? {} },
          });
        }
      }

      let datasetMatches = 0;
      let collectionMatches = 0;
      if (catalog) {
        const datasetHits = searchDatasetsInIndex(catalog, query).filter(
          (hit) => catalog.datasetById.get(hit.id)?.format !== 'API'
        );
        datasetMatches = datasetHits.length;
        for (const hit of datasetHits.slice(0, limit)) {
          const d = catalog.datasetById.get(hit.id)!;
          results.push({
            type: 'dataset',
            id: d.id,
            title: d.name,
            description: truncate(d.description, 160),
            agency: d.agency,
            format: d.format,
            last_updated: d.lastUpdatedAt?.slice(0, 10),
            score: hit.score,
            next_step: nextStepFor(d.id, d.format),
          });
        }

        const collectionHits = searchCollectionsInIndex(catalog, query);
        collectionMatches = collectionHits.length;
        for (const hit of collectionHits.slice(0, Math.ceil(limit / 2))) {
          const c = catalog.collectionById.get(hit.id)!;
          results.push({
            type: 'collection',
            id: c.id,
            title: c.name,
            description:
              `${c.datasetIds.length} dataset(s). ${truncate(c.description, 140) ?? ''}`.trim(),
            agency: c.agency,
            last_updated: c.lastUpdatedAt?.slice(0, 10),
            score: hit.score * 0.95,
            next_step: { tool: 'datagovsg_get_collection', args: { collection_id: c.id } },
          });
        }
      }

      let singstatMatches = 0;
      if (singstat && 'tables' in singstat) {
        // SingStat also matches on row/variable text, which is usually noise
        // ("weather" -> merchandise trade tables), so keep only tables whose
        // title is relevant. Exception: for a place query ("Woodlands"), tables
        // broken down "by Planning Area/Subzone" list the place as a row.
        const byArea = (title: string) => /planning area|subzone/i.test(title);
        const relevant = singstat.tables
          .filter((table) => table.score > 0 || (place && byArea(table.title)))
          .map((table) => ({ ...table, score: table.score > 0 ? table.score : 3 }))
          .sort((a, b) => b.score - a.score);
        singstatMatches = relevant.length;
        for (const table of relevant.slice(0, Math.ceil(limit / 2))) {
          results.push({
            type: 'singstat_table',
            id: table.id,
            title: table.title,
            description: [table.subject, table.topic, table.table_type].filter(Boolean).join(' / '),
            agency: 'Department of Statistics Singapore',
            score: table.score,
            next_step: { tool: 'singstat_get_table_metadata', args: { resource_id: table.id } },
            url: SINGSTAT_TABLE_URL(table.id),
          });
        }
      }

      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, limit);
      // Make sure each source with a reasonably relevant match is represented
      const threshold = (top[0]?.score ?? 0) * 0.3;
      for (const type of [
        'realtime_api',
        'dataset',
        'collection',
        'singstat_table',
      ] as ResultType[]) {
        if (!top.some((r) => r.type === type)) {
          const best = results.find((r) => r.type === type);
          if (best && best.score >= threshold) top.push(best);
        }
      }

      const notes: string[] = [];
      if (!catalog) {
        notes.push(
          'The data.gov.sg catalogue index is still being built (first start only); dataset results are missing. Retry in ~30 seconds.'
        );
      }
      if (singstat && 'error' in singstat)
        notes.push(`SingStat search unavailable: ${singstat.error}`);

      return {
        query,
        // Place queries get ready-to-run location tool calls first
        place_guide: place ? placeGuide(place) : undefined,
        matches: {
          realtime_apis: results.filter((r) => r.type === 'realtime_api').length,
          datasets: datasetMatches,
          collections: collectionMatches,
          singstat_tables: singstatMatches,
        },
        returned: top.length,
        results: top.map((r) => ({
          ...r,
          score: round(r.score, 2),
          url:
            r.url ?? (r.type === 'collection' ? COLLECTION_PAGE_URL(r.id) : DATASET_PAGE_URL(r.id)),
        })),
        tips: [
          "Follow each result's next_step. For more datasets with filters (format, agency, date), use datagovsg_search_datasets.",
          ...notes,
        ],
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('search_datasets'),
    {
      title: 'Search data.gov.sg datasets',
      description:
        'Search and filter the full data.gov.sg dataset catalogue (~4,600 datasets) by keyword, file format, publishing agency and last-updated date, with pagination. Omit `query` to browse (e.g. all GeoJSON datasets from NEA, newest first). Use datagovsg_search_all instead for a quick cross-source search.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Keywords, e.g. "primary school", "electricity consumption"'),
        format: z
          .enum(['CSV', 'GEOJSON', 'XLSX', 'PDF', 'API'])
          .optional()
          .describe('Only datasets of this format (CSV = queryable tables, GEOJSON = map data)'),
        agency: z
          .string()
          .optional()
          .describe(
            'Publishing agency name or part of it, e.g. "Housing", "National Environment Agency", "LTA"'
          ),
        updated_since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Only datasets updated on/after this date (YYYY-MM-DD)'),
        sort: z
          .enum(['relevance', 'last_updated', 'name'])
          .optional()
          .describe('Sort order (default: relevance with a query, otherwise last_updated)'),
        limit: z.number().int().min(1).max(50).optional().describe('Results per page (default 10)'),
        offset: z.number().int().min(0).optional().describe('Results to skip (default 0)'),
      },
      errorContext: 'Failed to search datasets',
    },
    async ({ query, format, agency, updated_since, sort, limit = 10, offset = 0 }) => {
      const catalog = await requireCatalog();
      const isRecent = sinceFilter(updated_since);
      const agencyNeedle = agency?.toLowerCase().trim();

      let hits: { id: string; score: number }[] = query?.trim()
        ? searchDatasetsInIndex(catalog, query)
        : catalog.datasets.map((d) => ({ id: d.id, score: 0 }));

      hits = hits.filter((hit) => {
        const d = catalog.datasetById.get(hit.id)!;
        if (format && d.format !== format) return false;
        if (agencyNeedle && !d.agency.toLowerCase().includes(agencyNeedle)) return false;
        return isRecent(d.lastUpdatedAt);
      });

      const order = sort ?? (query?.trim() ? 'relevance' : 'last_updated');
      if (order === 'last_updated') {
        hits.sort(
          (a, b) =>
            Date.parse(catalog.datasetById.get(b.id)!.lastUpdatedAt ?? '0') -
            Date.parse(catalog.datasetById.get(a.id)!.lastUpdatedAt ?? '0')
        );
      } else if (order === 'name') {
        hits.sort((a, b) =>
          catalog.datasetById.get(a.id)!.name.localeCompare(catalog.datasetById.get(b.id)!.name)
        );
      }

      const total = hits.length;
      const page = hits.slice(offset, offset + limit);
      const agencySuggestions =
        agencyNeedle && total === 0
          ? catalog.agencies
              .filter((a) => a.toLowerCase().includes(agencyNeedle.split(' ')[0]))
              .slice(0, 10)
          : undefined;

      return {
        query: query ?? null,
        filters: { format, agency, updated_since },
        total,
        showing:
          total > 0 ? `${offset + 1}-${Math.min(offset + limit, total)} of ${total}` : '0 of 0',
        pagination: {
          limit,
          offset,
          next_offset: offset + limit < total ? offset + limit : null,
          previous_offset: offset > 0 ? Math.max(0, offset - limit) : null,
        },
        datasets: page.map((hit) => {
          const d = catalog.datasetById.get(hit.id)!;
          return {
            id: d.id,
            name: d.name,
            format: d.format,
            agency: d.agency,
            last_updated: d.lastUpdatedAt?.slice(0, 10),
            coverage:
              d.coverageStart || d.coverageEnd
                ? `${d.coverageStart?.slice(0, 10) ?? '?'} to ${d.coverageEnd?.slice(0, 10) ?? '?'}`
                : undefined,
            collections: d.collectionIds.map((id) => catalog.collectionById.get(id)?.name ?? id),
            description: truncate(d.description, 200),
            score: hit.score > 0 ? round(hit.score, 2) : undefined,
            next_step: nextStepFor(d.id, d.format),
          };
        }),
        agency_suggestions: agencySuggestions?.length ? agencySuggestions : undefined,
        formats_in_catalogue: catalog.formats,
        catalogue_built_at: catalog.builtAt,
        source: DATAGOVSG_SOURCE,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('list_collections'),
    {
      title: 'List data.gov.sg collections',
      description:
        "List or search data.gov.sg collections (groups of related datasets, ~1,400 in total) with pagination. Optionally filter by keyword or agency. Use datagovsg_get_collection for a collection's datasets.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Keywords to search collection names and descriptions'),
        agency: z.string().optional().describe('Publishing agency name or part of it'),
        limit: z.number().int().min(1).max(50).optional().describe('Results per page (default 20)'),
        offset: z.number().int().min(0).optional().describe('Results to skip (default 0)'),
      },
      errorContext: 'Failed to list collections',
    },
    async ({ query, agency, limit = 20, offset = 0 }) => {
      const catalog = await requireCatalog();
      const agencyNeedle = agency?.toLowerCase().trim();

      let hits = query?.trim()
        ? searchCollectionsInIndex(catalog, query)
        : [...catalog.collections]
            .sort((a, b) => Date.parse(b.lastUpdatedAt ?? '0') - Date.parse(a.lastUpdatedAt ?? '0'))
            .map((c) => ({ id: c.id, score: 0 }));

      if (agencyNeedle) {
        hits = hits.filter((hit) => {
          const c = catalog.collectionById.get(hit.id)!;
          return (
            c.agency.toLowerCase().includes(agencyNeedle) ||
            c.sources.some((s) => s.toLowerCase().includes(agencyNeedle))
          );
        });
      }

      const total = hits.length;
      return {
        query: query ?? null,
        agency: agency ?? null,
        total,
        showing:
          total > 0 ? `${offset + 1}-${Math.min(offset + limit, total)} of ${total}` : '0 of 0',
        pagination: {
          limit,
          offset,
          next_offset: offset + limit < total ? offset + limit : null,
          previous_offset: offset > 0 ? Math.max(0, offset - limit) : null,
        },
        collections: hits.slice(offset, offset + limit).map((hit) => {
          const c = catalog.collectionById.get(hit.id)!;
          return {
            id: c.id,
            name: c.name,
            agency: c.agency,
            frequency: c.frequency,
            dataset_count: c.datasetIds.length,
            last_updated: c.lastUpdatedAt?.slice(0, 10),
            description: truncate(c.description, 160),
          };
        }),
        catalogue_built_at: getCatalogStatus().builtAt,
        source: DATAGOVSG_SOURCE,
      };
    }
  );
}
