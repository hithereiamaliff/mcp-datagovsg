/**
 * SingStat Table Builder tools (Department of Statistics Singapore).
 *
 * API: https://tablebuilder.singstat.gov.sg/view-api/for-developers
 * - No API key; ~100 requests/minute per IP
 * - Keyword search matches phrases literally ("gdp growth" -> 0 results),
 *   so singstat_search_tables retries word by word when a phrase finds nothing
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { API_BASES, CACHE_TTL, SINGSTAT_SOURCE, SINGSTAT_TABLE_URL } from './config.js';
import { parseNum, toList, truncate } from './utils/format.js';
import { ApiAuth, apiGet, unwrapSingstat } from './utils/http-client.js';
import { queryTerms, scoreDocument, makeField } from './utils/search.js';
import { registerReadOnlyTool, singstatTool, ToolContext } from './utils/tool-helpers.js';

// ============================================================================
// Types
// ============================================================================

interface SingstatSearchRecord {
  theme?: string;
  subject?: string;
  topic?: string;
  id: string;
  title: string;
  tableType?: string;
}

interface SingstatSearchData {
  total?: number;
  records?: SingstatSearchRecord[];
}

interface SingstatSeriesMeta {
  seriesNo?: string;
  rowNo?: string;
  rowText: string;
  uoM?: string;
  footnote?: string;
}

interface SingstatMetadata {
  records: {
    theme?: string;
    subject?: string;
    topic?: string;
    id: string;
    groupTitle?: string;
    title: string;
    frequency?: string;
    adjustmentType?: string;
    dataSource?: string;
    footnote?: string;
    dataLastUpdated?: string;
    startPeriod?: string;
    endPeriod?: string;
    total?: number;
    tableType?: string;
    row?: SingstatSeriesMeta[];
  };
}

interface SingstatColumn {
  key: string;
  value: string;
  columns?: SingstatColumn[];
}

interface SingstatDataRow {
  seriesNo?: string;
  rowNo?: string;
  rowText: string;
  uoM?: string;
  footnote?: string;
  columns?: SingstatColumn[];
}

interface SingstatTableData {
  id: string;
  title: string;
  frequency?: string;
  datasource?: string;
  footnote?: string;
  dataLastUpdated?: string;
  row?: SingstatDataRow[];
}

// ============================================================================
// Shared search helper (also used by datagovsg_search_all)
// ============================================================================

export interface SingstatTableHit {
  id: string;
  title: string;
  theme?: string;
  subject?: string;
  topic?: string;
  table_type?: string;
  score: number;
}

async function searchOnce(
  keyword: string,
  searchOption: string,
  auth: ApiAuth
): Promise<SingstatSearchRecord[]> {
  const data = await apiGet<SingstatSearchData>({
    category: 'singstat',
    url: `${API_BASES.singstat}/resourceid`,
    params: { keyword, searchoption: searchOption },
    ttlMs: CACHE_TTL.singstatSearch,
    auth,
    unwrap: unwrapSingstat,
  });
  return data.records ?? [];
}

/**
 * Search SingStat tables. If the full phrase returns nothing, fall back to
 * each meaningful word and rank tables that match the most words.
 *
 * SingStat search takes ~7s per call, so the phrase and the per-word
 * searches run in parallel rather than one after another.
 */
export async function searchSingstatTables(
  query: string,
  auth: ApiAuth,
  searchOption: 'all' | 'title' | 'variable' = 'all'
): Promise<{ tables: SingstatTableHit[]; keywordsUsed: string[]; usedFallback: boolean }> {
  const phrase = query.trim();
  // Longest words first: they tend to be the most specific
  const words = queryTerms(phrase)
    .filter((w) => w.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const needsFallback =
    words.length > 1 || (words.length === 1 && words[0] !== phrase.toLowerCase());

  const [phraseRecords, ...wordRecords] = await Promise.all([
    searchOnce(phrase, searchOption, auth),
    // Word searches failing must not break the phrase search
    ...(needsFallback
      ? words.map((word) => searchOnce(word, searchOption, auth).catch(() => []))
      : []),
  ]);

  let records = phraseRecords;
  let keywordsUsed = [phrase];
  let usedFallback = false;
  if (records.length === 0 && needsFallback) {
    usedFallback = true;
    keywordsUsed = words;
    const byId = new Map<string, SingstatSearchRecord>();
    for (const list of wordRecords) for (const record of list) byId.set(record.id, record);
    records = [...byId.values()];
  }

  const tables = records
    .map((record) => ({
      id: record.id,
      title: record.title,
      theme: record.theme,
      subject: record.subject,
      topic: record.topic,
      table_type: record.tableType,
      score: scoreDocument(phrase, [
        makeField(record.title, 3),
        makeField(`${record.topic ?? ''} ${record.subject ?? ''}`, 1.5),
        makeField(record.theme, 1),
      ]),
    }))
    // SingStat already matched these; keep them even if our scorer gives 0
    .sort((a, b) => b.score - a.score);

  return { tables, keywordsUsed, usedFallback };
}

// ============================================================================
// Tools
// ============================================================================

export function registerSingStatTools(server: McpServer, ctx: ToolContext) {
  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    singstatTool('search_tables'),
    {
      title: 'Search SingStat tables',
      description:
        'Search SingStat Table Builder (Department of Statistics Singapore) for official statistics tables: GDP, CPI/inflation, population, labour, trade, household income, tourism and more. Returns table IDs (e.g. M015721) for singstat_get_table_metadata and singstat_get_table_data. Short keywords work best ("gdp", "retail sales"); if a phrase finds nothing the tool automatically retries word by word.',
      inputSchema: {
        keyword: z
          .string()
          .min(1)
          .describe(
            'Keyword or short phrase, e.g. "GDP", "consumer price index", "resident population"'
          ),
        search_option: z
          .enum(['all', 'title', 'variable'])
          .optional()
          .describe('Where to search: "all" (default), "title" only, or "variable" (row) names'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max tables to return (default 15)'),
      },
      errorContext: 'Failed to search SingStat tables',
    },
    async ({ keyword, search_option = 'all', limit = 15 }) => {
      const { tables, keywordsUsed, usedFallback } = await searchSingstatTables(
        keyword,
        ctx.auth,
        search_option
      );
      return {
        keyword,
        keywords_used: keywordsUsed,
        used_word_fallback: usedFallback,
        total: tables.length,
        returned: Math.min(limit, tables.length),
        tables: tables.slice(0, limit).map(({ score: _score, ...table }) => ({
          ...table,
          url: SINGSTAT_TABLE_URL(table.id),
        })),
        next_step:
          tables.length > 0
            ? 'Call singstat_get_table_metadata with a table id to see its series and time range, then singstat_get_table_data.'
            : 'No tables found. Try a broader single keyword, or datagovsg_search_all to also search data.gov.sg.',
        source: SINGSTAT_SOURCE,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    singstatTool('get_table_metadata'),
    {
      title: 'Get SingStat table metadata',
      description:
        "Get a SingStat table's description: title, frequency (annual/quarterly/monthly), time coverage, units, footnotes and the list of data series (rows) with their series numbers. Use the series numbers to filter singstat_get_table_data.",
      inputSchema: {
        resource_id: z.string().min(1).describe('SingStat table ID, e.g. "M015721"'),
        max_series: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max series (rows) to list (default 200)'),
      },
      errorContext: 'Failed to get SingStat table metadata',
      errorHint: 'Check the table ID with singstat_search_tables.',
    },
    async ({ resource_id, max_series = 200 }) => {
      const id = resource_id.trim().toUpperCase();
      const data = await apiGet<SingstatMetadata>({
        category: 'singstat',
        url: `${API_BASES.singstat}/metadata/${encodeURIComponent(id)}`,
        ttlMs: CACHE_TTL.singstatMetadata,
        auth: ctx.auth,
        unwrap: unwrapSingstat,
      });
      const meta = data.records;
      const series = meta.row ?? [];
      return {
        id: meta.id,
        title: meta.title,
        group_title: meta.groupTitle,
        theme: meta.theme,
        subject: meta.subject,
        topic: meta.topic,
        table_type: meta.tableType,
        frequency: meta.frequency,
        adjustment: meta.adjustmentType,
        start_period: meta.startPeriod,
        end_period: meta.endPeriod,
        last_updated: meta.dataLastUpdated,
        total_data_points: meta.total,
        footnote: truncate(meta.footnote, 600),
        series_count: series.length,
        series: series.slice(0, max_series).map((row) => ({
          series_no: row.seriesNo ?? row.rowNo,
          name: row.rowText,
          unit: row.uoM || undefined,
          footnote: row.footnote || undefined,
        })),
        series_truncated: series.length > max_series ? true : undefined,
        url: SINGSTAT_TABLE_URL(meta.id),
        source: meta.dataSource || SINGSTAT_SOURCE,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    singstatTool('get_table_data'),
    {
      title: 'Get SingStat table data',
      description:
        'Get values from a SingStat table, with optional filters by series number, time period, value range or row text. Note: limit/offset count individual DATA POINTS (cells), not rows. A table with 60 series x 66 years has ~4,000 points, so filter by series and/or time_filter for focused answers. Values are returned per series as {period: value}.',
      inputSchema: {
        resource_id: z.string().min(1).describe('SingStat table ID, e.g. "M015721"'),
        series: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe(
            'Series numbers to include (from singstat_get_table_metadata), e.g. ["1", "1.1"] or "1,1.1"'
          ),
        time_filter: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe(
            'Periods to include, e.g. ["2023","2024"], ["2024 4Q"], ["2025 Mar"], ["2024 1H"]. Must match the table frequency.'
          ),
        between: z
          .string()
          .optional()
          .describe('Keep values within a numeric range "min,max" (filters VALUES, not dates)'),
        search: z.string().optional().describe('Keep series whose name contains this text'),
        sort_by: z
          .enum([
            'key asc',
            'key desc',
            'value asc',
            'value desc',
            'seriesno asc',
            'seriesno desc',
            'rowtext asc',
            'rowtext desc',
          ])
          .optional()
          .describe('Sort order. "key desc" puts the most recent periods first.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Max data points to return (default 1000, max 5000)'),
        offset: z.number().int().min(0).optional().describe('Data points to skip (pagination)'),
      },
      errorContext: 'Failed to get SingStat table data',
      errorHint:
        'Check the table ID with singstat_search_tables and filters with singstat_get_table_metadata.',
    },
    async ({
      resource_id,
      series,
      time_filter,
      between,
      search,
      sort_by,
      limit = 1000,
      offset = 0,
    }) => {
      const id = resource_id.trim().toUpperCase();
      const seriesList = toList(series);
      const timeList = toList(time_filter);
      const data = await apiGet<SingstatTableData>({
        category: 'singstat',
        url: `${API_BASES.singstat}/tabledata/${encodeURIComponent(id)}`,
        params: {
          seriesNoORrowNo: seriesList?.join(','),
          timeFilter: timeList?.join(','),
          between: between?.replace(/\s+/g, ''),
          search,
          sortBy: sort_by,
          limit,
          offset: offset > 0 ? offset : undefined,
        },
        ttlMs: CACHE_TTL.singstatData,
        auth: ctx.auth,
        unwrap: unwrapSingstat,
      });

      let points = 0;
      const rows = (data.row ?? []).map((row) => {
        const values: Record<string, unknown> = {};
        const nested: Record<string, unknown> = {};
        for (const column of row.columns ?? []) {
          if (column.columns && column.columns.length > 0) {
            // Multi-dimensional tables nest a second level of columns
            nested[column.key] = Object.fromEntries(
              column.columns.map((c) => [c.key, parseNum(c.value) ?? c.value])
            );
            points += column.columns.length;
          } else {
            values[column.key] = parseNum(column.value) ?? column.value;
            points++;
          }
        }
        return {
          series_no: row.seriesNo ?? row.rowNo,
          name: row.rowText,
          unit: row.uoM || undefined,
          values: Object.keys(values).length > 0 ? values : undefined,
          breakdown: Object.keys(nested).length > 0 ? nested : undefined,
        };
      });

      return {
        id: data.id,
        title: data.title,
        frequency: data.frequency,
        last_updated: data.dataLastUpdated,
        data_points_returned: points,
        pagination: {
          limit,
          offset,
          next_offset: points >= limit ? offset + limit : null,
        },
        series_count: rows.length,
        series: rows,
        footnote: truncate(data.footnote, 400),
        url: SINGSTAT_TABLE_URL(data.id),
        source: data.datasource || SINGSTAT_SOURCE,
      };
    }
  );
}
