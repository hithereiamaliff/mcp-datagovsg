/**
 * Shared MCP server factory.
 *
 * The HTTP server creates a fresh server per request (required by the MCP SDK
 * in stateless mode), passing the data.gov.sg API key for that request:
 * the caller's own key from the MCP Key Service, or the operator's key.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { registerDatasetTools } from './datasets.tools.js';
import { registerSearchTools } from './search.tools.js';
import { registerSingStatTools } from './singstat.tools.js';
import { registerTransportTools } from './transport.tools.js';
import { getCatalogStatus } from './utils/catalog-index.js';
import { ApiAuth, resolveAuth } from './utils/http-client.js';
import { datagovsgTool, registerReadOnlyTool, ToolContext } from './utils/tool-helpers.js';
import { registerWeatherTools } from './weather.tools.js';

export const SERVER_INSTRUCTIONS = `Singapore Open Data: official data from data.gov.sg (all government datasets, real-time weather/environment/transport APIs) and SingStat Table Builder (official statistics).

How to use:
1. Start with datagovsg_search_all for any data question. Each result has a next_step telling you which tool and arguments to call.
2. For "right now" questions use the real-time tools directly: datagovsg_get_current_conditions (weather summary for a place), datagovsg_get_weather_forecast, datagovsg_get_air_quality (PSI/haze), datagovsg_get_carpark_availability, datagovsg_get_taxi_availability.
3. For tabular datasets: datagovsg_get_dataset_metadata (column names) then datagovsg_query_dataset (filters are exact and case-sensitive, e.g. town "BISHAN"). For whole files or GeoJSON maps use datagovsg_get_download_url.
4. For official statistics (GDP, CPI, population, labour, trade): singstat_search_tables -> singstat_get_table_metadata -> singstat_get_table_data (filter by series and time_filter).

Dates and times are Singapore time (UTC+8). Cite "data.gov.sg" or "SingStat" as the source.`;

export interface CreateServerOptions {
  /** The caller's own data.gov.sg API key (from the MCP Key Service), if any */
  userApiKey?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const auth: ApiAuth = resolveAuth(options.userApiKey);
  const ctx: ToolContext = { auth };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerSearchTools(server, ctx);
  registerDatasetTools(server, ctx);
  registerWeatherTools(server, ctx);
  registerTransportTools(server, ctx);
  registerSingStatTools(server, ctx);

  registerReadOnlyTool(
    server,
    datagovsgTool('hello'),
    {
      title: 'Server status',
      description:
        'Check that the Singapore Open Data MCP server is working. Shows the server version, which data.gov.sg API key type this connection uses (never the key itself) and the dataset catalogue index status.',
      inputSchema: {},
      errorContext: 'Status check failed',
    },
    async () => ({
      message: 'Hello from the Singapore Open Data MCP server!',
      version: SERVER_VERSION,
      api_key: {
        source: auth.source,
        description:
          auth.source === 'user'
            ? 'Using your own data.gov.sg API key (from the MCP Key Service)'
            : auth.source === 'server'
              ? "Using the server operator's data.gov.sg API key"
              : 'No data.gov.sg API key configured (anonymous rate limits)',
      },
      catalogue_index: getCatalogStatus(),
      timestamp: new Date().toISOString(),
    })
  );

  return server;
}
