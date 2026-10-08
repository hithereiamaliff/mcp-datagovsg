/**
 * data.gov.sg dataset tools: collection/dataset metadata, row queries
 * (CKAN datastore_search) and one-shot downloads.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  API_BASES,
  CACHE_TTL,
  COLLECTION_PAGE_URL,
  DATAGOVSG_SOURCE,
  DATASET_PAGE_URL,
} from './config.js';
import { apiCache } from './utils/cache.js';
import { getCatalog } from './utils/catalog-index.js';
import { toCsv, toList, toNumber, truncate } from './utils/format.js';
import { ApiAuth, apiGet, unwrapCkan, unwrapOgp, UpstreamError } from './utils/http-client.js';
import { REALTIME_BY_DATASET_ID } from './utils/realtime-catalog.js';
import { datagovsgTool, registerReadOnlyTool, ToolContext } from './utils/tool-helpers.js';

// ============================================================================
// Types
// ============================================================================

interface ColumnMeta {
  name: string;
  columnTitle?: string;
  dataType?: string;
  index?: string;
  isCategorical?: boolean;
}

export interface DatasetMetadata {
  datasetId: string;
  name: string;
  collectionIds?: string[];
  description?: string;
  format: string;
  lastUpdatedAt?: string;
  createdAt?: string;
  managedBy?: string;
  coverageStart?: string;
  coverageEnd?: string;
  datasetSize?: number;
  columnMetadata?: {
    order?: string[];
    metaMapping?: Record<string, ColumnMeta>;
  };
  geoJsonMetadata?: {
    properties?: { attribute: string; dataType?: { label?: string; value?: string } }[];
  };
}

interface CollectionMetadata {
  collectionMetadata: {
    collectionId: string;
    name: string;
    description?: string;
    createdAt?: string;
    lastUpdatedAt?: string;
    coverageStart?: string;
    coverageEnd?: string;
    frequency?: string;
    sources?: string[];
    managedBy?: string;
    childDatasets?: string[];
  };
}

interface DatastoreResult {
  resource_id: string;
  fields: { id: string; type: string }[];
  records: Record<string, unknown>[];
  total?: number;
  limit?: number;
}

// ============================================================================
// Shared helpers
// ============================================================================

const DATASET_ID = z
  .string()
  .regex(/^d_[a-zA-Z0-9]+$/, 'Dataset IDs look like "d_8b84c4ee58e3cfc0ece0d773c8ca6abc"')
  .describe('data.gov.sg dataset ID (starts with "d_"), e.g. "d_8b84c4ee58e3cfc0ece0d773c8ca6abc"');

const NUMERIC_TYPES = new Set(['numeric', 'int', 'int4', 'int8', 'float', 'float4', 'float8']);

export async function fetchDatasetMetadata(
  datasetId: string,
  auth: ApiAuth
): Promise<DatasetMetadata> {
  return apiGet<DatasetMetadata>({
    category: 'catalog',
    url: `${API_BASES.catalog}/datasets/${encodeURIComponent(datasetId)}/metadata`,
    ttlMs: CACHE_TTL.metadata,
    auth,
    unwrap: (body, status) => {
      try {
        return unwrapOgp<DatasetMetadata>(body, status);
      } catch (error) {
        if (status === 404) {
          throw new UpstreamError(
            `Dataset ${datasetId} was not found`,
            404,
            'NOT_FOUND',
            'Find valid dataset IDs with datagovsg_search_datasets or datagovsg_search_all.'
          );
        }
        throw error;
      }
    },
  });
}

/** Look up a dataset's format from the local index, falling back to the API. */
async function getDatasetFormat(
  datasetId: string,
  auth: ApiAuth
): Promise<{ format: string; name?: string }> {
  const catalog = await getCatalog(0);
  const entry = catalog?.datasetById.get(datasetId);
  if (entry) return { format: entry.format, name: entry.name };
  const meta = await fetchDatasetMetadata(datasetId, auth);
  return { format: (meta.format || 'UNKNOWN').toUpperCase(), name: meta.name };
}

/** Error for datasets that cannot be queried row-by-row. */
function notQueryable(datasetId: string, format: string): UpstreamError {
  const realtime = REALTIME_BY_DATASET_ID.get(datasetId);
  if (realtime) {
    return new UpstreamError(
      `${realtime.name} is a real-time API, not a table`,
      400,
      'REALTIME_DATASET',
      `Use ${realtime.tool}${realtime.args ? ` with ${JSON.stringify(realtime.args)}` : ''} instead.`
    );
  }
  if (format === 'API') {
    return new UpstreamError(
      'This is an external API (National Library Board) that needs its own credentials',
      400,
      'UNSUPPORTED_API'
    );
  }
  return new UpstreamError(
    `${format} datasets cannot be queried row by row`,
    400,
    'NOT_TABULAR',
    `Use datagovsg_get_download_url with dataset_id "${datasetId}" to get a download link for the ${format} file.`
  );
}

/** Suggest the next tool for a dataset based on its format. */
export function nextStepFor(
  datasetId: string,
  format: string
): { tool: string; args: Record<string, unknown> } | undefined {
  const realtime = REALTIME_BY_DATASET_ID.get(datasetId);
  if (realtime) return { tool: realtime.tool, args: realtime.args ?? {} };
  if (format === 'CSV') return { tool: 'datagovsg_query_dataset', args: { dataset_id: datasetId } };
  if (format === 'API') return undefined;
  return { tool: 'datagovsg_get_download_url', args: { dataset_id: datasetId } };
}

// ============================================================================
// Tools
// ============================================================================

export function registerDatasetTools(server: McpServer, ctx: ToolContext) {
  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_collection'),
    {
      title: 'Get data.gov.sg collection',
      description:
        'Get a data.gov.sg collection (a group of related datasets, e.g. "Resale Flat Prices") with its description, publishing agency, update frequency and the datasets it contains.',
      inputSchema: {
        collection_id: z
          .union([z.string(), z.number()])
          .describe('Numeric collection ID, e.g. "189" (Resale Flat Prices)'),
      },
      errorContext: 'Failed to get collection',
      errorHint: 'Find collection IDs with datagovsg_list_collections or datagovsg_search_all.',
    },
    async ({ collection_id }) => {
      const id = String(collection_id).trim();
      const data = await apiGet<CollectionMetadata>({
        category: 'catalog',
        url: `${API_BASES.catalog}/collections/${encodeURIComponent(id)}/metadata`,
        ttlMs: CACHE_TTL.metadata,
        auth: ctx.auth,
        unwrap: unwrapOgp,
      });
      const meta = data.collectionMetadata;
      const catalog = await getCatalog(0);
      const datasetIds = meta.childDatasets ?? [];

      return {
        id: meta.collectionId,
        name: meta.name,
        description: truncate(meta.description, 800),
        agency: meta.managedBy,
        sources: meta.sources,
        frequency: meta.frequency,
        coverage: { start: meta.coverageStart, end: meta.coverageEnd },
        last_updated: meta.lastUpdatedAt,
        dataset_count: datasetIds.length,
        datasets: datasetIds.map((datasetId) => {
          const entry = catalog?.datasetById.get(datasetId);
          return entry
            ? {
                id: datasetId,
                name: entry.name,
                format: entry.format,
                last_updated: entry.lastUpdatedAt,
                coverage: { start: entry.coverageStart, end: entry.coverageEnd },
                next_step: nextStepFor(datasetId, entry.format),
              }
            : { id: datasetId };
        }),
        url: COLLECTION_PAGE_URL(meta.collectionId),
        source: DATAGOVSG_SOURCE,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_dataset_metadata'),
    {
      title: 'Get data.gov.sg dataset metadata',
      description:
        "Get a data.gov.sg dataset's details: description, format, publishing agency, coverage period, last update, size, and its columns (name, title, data type, whether categorical). Call this before datagovsg_query_dataset to learn the exact column names to filter and sort on.",
      inputSchema: { dataset_id: DATASET_ID },
      errorContext: 'Failed to get dataset metadata',
    },
    async ({ dataset_id }) => {
      const meta = await fetchDatasetMetadata(dataset_id, ctx.auth);
      const catalog = await getCatalog(0);
      const format = (meta.format || 'UNKNOWN').toUpperCase();

      const mapping = meta.columnMetadata?.metaMapping ?? {};
      const order = meta.columnMetadata?.order ?? Object.keys(mapping);
      const columns = order
        .map((key) => mapping[key])
        .filter(Boolean)
        .map((col) => ({
          name: col.name,
          title: col.columnTitle,
          type: col.dataType,
          categorical: col.isCategorical || undefined,
        }));

      const geoProperties = meta.geoJsonMetadata?.properties?.map((p) => ({
        name: p.attribute,
        type: p.dataType?.label ?? p.dataType?.value,
      }));

      const firstCategorical = columns.find((c) => c.categorical);
      const howToQuery =
        format === 'CSV'
          ? {
              tool: 'datagovsg_query_dataset',
              example: {
                dataset_id,
                ...(firstCategorical ? { filters: { [firstCategorical.name]: '<value>' } } : {}),
                limit: 20,
              },
              tip: 'Filter values must match exactly (case-sensitive). Use datagovsg_get_download_url for the full file.',
            }
          : nextStepFor(dataset_id, format);

      return {
        id: meta.datasetId,
        name: meta.name,
        description: truncate(meta.description, 1200),
        format,
        agency: meta.managedBy,
        coverage: { start: meta.coverageStart, end: meta.coverageEnd },
        last_updated: meta.lastUpdatedAt,
        size_bytes: meta.datasetSize,
        collections: (meta.collectionIds ?? []).map((id) => ({
          id,
          name: catalog?.collectionById.get(id)?.name,
        })),
        column_count: columns.length || undefined,
        columns: columns.length > 0 ? columns : undefined,
        geojson_properties: geoProperties,
        how_to_query: howToQuery,
        url: DATASET_PAGE_URL(meta.datasetId),
        source: DATAGOVSG_SOURCE,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('query_dataset'),
    {
      title: 'Query rows in a data.gov.sg dataset',
      description:
        'Query rows from a tabular (CSV) data.gov.sg dataset with exact-match filters, full-text search, column selection, sorting and pagination. Numeric columns are returned as numbers. Prefer `filters` over `q` (plain-text `q` totals can be approximate). Call datagovsg_get_dataset_metadata first to get exact column names. For GeoJSON/XLSX/PDF datasets use datagovsg_get_download_url instead.',
      inputSchema: {
        dataset_id: DATASET_ID,
        filters: z
          .record(
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.union([z.string(), z.number()])),
            ])
          )
          .optional()
          .describe(
            'Exact-match filters by column name. An array means "any of" (OR). e.g. {"town": ["BISHAN", "BEDOK"], "flat_type": "4 ROOM"}'
          ),
        q: z
          .union([z.string(), z.record(z.string())])
          .optional()
          .describe(
            'Full-text search: a string searches all columns; an object searches specific columns, e.g. {"street_name": "ANG MO KIO"}'
          ),
        fields: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe('Columns to return (array or comma-separated). Default: all columns'),
        sort: z
          .string()
          .optional()
          .describe('Sort by column(s), e.g. "resale_price desc" or "month desc, town asc"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Rows to return (default 50, max 1000)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Rows to skip for pagination (default 0)'),
        format: z
          .enum(['json', 'csv'])
          .optional()
          .describe('Row format: "json" (default) or "csv" (more compact for many rows)'),
      },
      errorContext: 'Failed to query dataset',
      errorHint: (error) =>
        error instanceof UpstreamError && error.code === 'VALIDATION_ERROR'
          ? 'A filter or column name is invalid. Check exact column names with datagovsg_get_dataset_metadata.'
          : undefined,
    },
    async ({ dataset_id, filters, q, fields, sort, limit = 50, offset = 0, format = 'json' }) => {
      const info = await getDatasetFormat(dataset_id, ctx.auth);
      if (info.format !== 'CSV' && info.format !== 'UNKNOWN')
        throw notQueryable(dataset_id, info.format);

      // Normalise filter values to strings (datastore values are stored as text)
      const normalisedFilters = filters
        ? Object.fromEntries(
            Object.entries(filters).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.map(String) : String(value),
            ])
          )
        : undefined;
      const fieldList = toList(fields);

      const result = await apiGet<DatastoreResult>({
        category: 'datastore',
        url: `${API_BASES.datastore}/datastore_search`,
        params: {
          resource_id: dataset_id,
          limit,
          offset: offset > 0 ? offset : undefined,
          fields: fieldList?.join(','),
          filters: normalisedFilters ? JSON.stringify(normalisedFilters) : undefined,
          q: q === undefined ? undefined : typeof q === 'string' ? q : JSON.stringify(q),
          sort,
        },
        ttlMs: CACHE_TTL.datastore,
        auth: ctx.auth,
        unwrap: unwrapCkan,
      });

      const columns = result.fields.filter((f) => f.id !== '_id');
      const numeric = new Set(columns.filter((f) => NUMERIC_TYPES.has(f.type)).map((f) => f.id));
      const rows = result.records.map((record) => {
        const row: Record<string, unknown> = {};
        for (const col of columns) {
          const value = record[col.id];
          row[col.id] = numeric.has(col.id) ? toNumber(value) : value;
        }
        return row;
      });

      const total = result.total ?? rows.length;
      const nextOffset =
        offset + rows.length < total && rows.length > 0 ? offset + rows.length : null;

      return {
        dataset_id,
        dataset_name: info.name,
        total_matching_rows: total,
        returned: rows.length,
        pagination: {
          limit,
          offset,
          next_offset: nextOffset,
        },
        columns: columns.map((c) => ({
          name: c.id,
          type: NUMERIC_TYPES.has(c.type) ? 'number' : 'text',
        })),
        ...(format === 'csv'
          ? {
              csv: toCsv(
                columns.map((c) => c.id),
                rows
              ),
            }
          : { rows }),
        note:
          typeof q === 'string'
            ? 'Plain-text q matches across all columns; total may be approximate. Use filters for exact counts.'
            : undefined,
        url: DATASET_PAGE_URL(dataset_id),
        source: DATAGOVSG_SOURCE,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_download_url'),
    {
      title: 'Get a download link for a data.gov.sg dataset',
      description:
        'Get a temporary download URL for a full data.gov.sg dataset file (CSV, GeoJSON, XLSX or PDF). For CSV datasets you can choose columns and add filters so the file only contains matching rows. The tool starts the export and waits for it to finish (usually a few seconds). Links expire after about 1 hour. Use this when you need the whole dataset or map data (GeoJSON), not for quick lookups (use datagovsg_query_dataset).',
      inputSchema: {
        dataset_id: DATASET_ID,
        column_names: z
          .array(z.string())
          .optional()
          .describe('CSV only: columns to include, e.g. ["month", "town", "resale_price"]'),
        filters: z
          .array(
            z.object({
              column_name: z.string().describe('Column to filter on'),
              type: z
                .enum(['EQ', 'LIKE', 'ILIKE'])
                .describe(
                  'EQ = exact match, LIKE = pattern (case-sensitive), ILIKE = pattern (case-insensitive)'
                ),
              value: z
                .union([z.string(), z.number()])
                .describe('Value to match. For LIKE/ILIKE use % as wildcard, e.g. "%ANG MO KIO%"'),
            })
          )
          .optional()
          .describe('CSV only: row filters applied to the exported file'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(40)
          .optional()
          .describe('How long to wait for the export to finish (default 20 seconds)'),
      },
      errorContext: 'Failed to get download URL',
    },
    async ({ dataset_id, column_names, filters, wait_seconds = 20 }) => {
      const info = await getDatasetFormat(dataset_id, ctx.auth);
      if (info.format === 'API') throw notQueryable(dataset_id, info.format);

      const hasOptions = (column_names?.length ?? 0) > 0 || (filters?.length ?? 0) > 0;
      if (hasOptions && info.format !== 'CSV') {
        throw new UpstreamError(
          `Columns and filters are only supported for CSV datasets (this one is ${info.format})`,
          400,
          'OPTIONS_NOT_SUPPORTED'
        );
      }

      const body = hasOptions
        ? {
            ...(column_names?.length ? { columnNames: column_names } : {}),
            ...(filters?.length
              ? {
                  filters: filters.map((f) => ({
                    columnName: f.column_name,
                    type: f.type,
                    value: f.value,
                  })),
                }
              : {}),
          }
        : undefined;

      const cacheKey = `download:${dataset_id}:${JSON.stringify(body ?? {})}`;
      const cached = apiCache.get<Record<string, unknown>>(cacheKey);
      if (cached) return cached;

      const base = `${API_BASES.download}/datasets/${encodeURIComponent(dataset_id)}`;
      let url: string | undefined;
      let status: string | undefined;

      // Non-CSV files are pre-generated: poll returns the link directly
      if (info.format === 'CSV' || info.format === 'UNKNOWN') {
        const initiated = await apiGet<{ message?: string; url?: string }>({
          category: 'download',
          url: `${base}/initiate-download`,
          body,
          ttlMs: 0,
          auth: ctx.auth,
          unwrap: unwrapOgp,
        });
        url = initiated.url;
      }

      const deadline = Date.now() + wait_seconds * 1000;
      while (!url) {
        const polled = await apiGet<{ status?: string; url?: string }>({
          category: 'download',
          url: `${base}/poll-download`,
          body,
          ttlMs: 0,
          auth: ctx.auth,
          unwrap: unwrapOgp,
        });
        status = polled.status;
        url = polled.url;
        if (url) break;
        if (status && /FAIL|ERROR/i.test(status)) {
          throw new UpstreamError(`Export failed with status ${status}`, 502, status);
        }
        if (Date.now() + 3000 > deadline) {
          return {
            dataset_id,
            dataset_name: info.name,
            status: status ?? 'PENDING',
            ready: false,
            message:
              'The export is still being prepared. Call this tool again with the same arguments to keep waiting.',
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      const result = {
        dataset_id,
        dataset_name: info.name,
        format: info.format,
        ready: true,
        download_url: url,
        generated_at: new Date().toISOString(),
        expires: 'about 1 hour after generated_at',
        columns_included: column_names,
        filters_applied: filters,
        tip:
          info.format === 'CSV'
            ? 'Share the link with the user or fetch it to analyse the full CSV. For quick lookups use datagovsg_query_dataset.'
            : `This is a ${info.format} file; share the link with the user or fetch it to analyse.`,
        url: DATASET_PAGE_URL(dataset_id),
        source: DATAGOVSG_SOURCE,
      };
      apiCache.set(cacheKey, result, CACHE_TTL.download);
      return result;
    }
  );
}
