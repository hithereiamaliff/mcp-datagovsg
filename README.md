# Singapore Open Data MCP

**MCP Endpoint:** `https://mcp.techmavie.digital/datagovsg/mcp`

**Analytics Dashboard:** [`https://mcp.techmavie.digital/datagovsg/analytics/dashboard`](https://mcp.techmavie.digital/datagovsg/analytics/dashboard)

MCP (Model Context Protocol) server for Singapore's open data: every [data.gov.sg](https://data.gov.sg) dataset, the real-time weather, environment and transport APIs, and official statistics from [SingStat Table Builder](https://tablebuilder.singstat.gov.sg).

This is **not** an official MCP server from the Government of Singapore, GovTech, Open Government Products or the Department of Statistics.

> Originally forked from [aniruddha-adhikary/gahmen-mcp](https://github.com/aniruddha-adhikary/gahmen-mcp); rebuilt in v2 by [@hithereiamaliff](https://github.com/hithereiamaliff).

## Features

- **One search for everything**: `datagovsg_search_all` covers ~4,600 datasets, ~1,400 collections, 18 real-time APIs and SingStat tables. Each result says which tool to call next.
- **Working dataset search**: data.gov.sg has no search API, so the server keeps a local index of the whole catalogue, refreshed daily.
- **Real-time Singapore conditions**: forecasts (2-hour, 24-hour, 4-day), station readings, PSI/PM2.5 with health advice, UV, heat stress (WBGT), lightning, PUB flood alerts, rain radar, plus a one-call `get_current_conditions` for any area.
- **Transport**: HDB carpark availability searchable by address or location, taxi availability near a point, traffic cameras.
- **Dataset querying**: typed rows with filters, sorting and pagination, CSV output, and one-call download links (including GeoJSON map data).
- **Official statistics**: SingStat search with automatic word fallback, table metadata and filtered data.
- **Place names everywhere**: location-aware tools accept landmarks, MRT stations, buildings and postal codes ("Orchard", "Jewel Changi", "560123") via OneMap, not just coordinates.
- **Historical queries**: real-time tools accept a past `date`.
- **Rate-limit aware**: requests are queued under data.gov.sg limits, cached, and retried after a 429.
- **Bring your own key (optional)**: use your own data.gov.sg API key through the [MCP Key Service](https://mcpkeys.techmavie.digital) for a separate quota.
- Built-in analytics endpoints and dashboard.

## Quick Start

### Hosted server

No key needed:

```text
https://mcp.techmavie.digital/datagovsg/mcp
```

Example MCP client config:

```json
{
  "mcpServers": {
    "singapore-opendata": {
      "transport": "streamable-http",
      "url": "https://mcp.techmavie.digital/datagovsg/mcp"
    }
  }
}
```

### Using your own data.gov.sg API key (optional)

By default every request uses the server's own data.gov.sg API key. For heavy use, you can bring your own key and get a separate rate-limit quota:

1. Create a key at [data.gov.sg](https://data.gov.sg) (log in → **API Keys**).
2. Register it at [mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital) using the **Singapore Open Data (data.gov.sg)** connector. You get a `usr_...` key.
3. Connect with any of:
   - `https://mcp.techmavie.digital/datagovsg/mcp?api_key=usr_...`
   - `https://mcp.techmavie.digital/datagovsg/mcp/usr_...`
   - Header `X-API-Key: usr_...` (or `Authorization: Bearer usr_...`)

Raw data.gov.sg keys are not accepted over HTTP; use the key service. Ask `datagovsg_hello` which key a connection is using.

### Self-hosted

Detailed VPS instructions are in [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md).

```bash
npm install
cp .env.example .env    # add DATAGOVSG_API_KEY
npm run build
npm start
```

## Tool Overview

Full parameter reference and examples: [TOOLS.md](TOOLS.md).

### Search and discovery

| Tool | Purpose |
|------|---------|
| `datagovsg_search_all` | ⭐ Start here. Datasets, collections, real-time APIs and SingStat tables in one search |
| `datagovsg_search_datasets` | Search/browse datasets with format, agency and date filters |
| `datagovsg_list_collections` | Search/browse collections (groups of datasets) |

### Datasets

| Tool | Purpose |
|------|---------|
| `datagovsg_get_collection` | Collection details and its datasets |
| `datagovsg_get_dataset_metadata` | Dataset details and column names/types |
| `datagovsg_query_dataset` | Query rows: filters, full-text search, sort, pagination, CSV |
| `datagovsg_get_download_url` | Download link for the full file (CSV with optional filters, GeoJSON, XLSX, PDF) |

### Weather and environment (real-time, NEA/PUB)

| Tool | Purpose |
|------|---------|
| `datagovsg_get_current_conditions` | One-call summary for an area or coordinates |
| `datagovsg_get_weather_forecast` | 2-hour area nowcast, 24-hour regional forecast, 4-day outlook |
| `datagovsg_get_weather_readings` | Temperature, rainfall, humidity, wind by station or nearest |
| `datagovsg_get_air_quality` | PSI and PM2.5 with health bands and advice |
| `datagovsg_get_uv_index` | Hourly UV index |
| `datagovsg_get_heat_stress` | WBGT heat stress readings |
| `datagovsg_get_lightning` | Lightning strikes, optionally near a location |
| `datagovsg_get_flood_alerts` | PUB flash flood alerts |
| `datagovsg_get_weather_radar` | Rain radar image (beta) |

### Transport (real-time)

| Tool | Purpose |
|------|---------|
| `datagovsg_get_carpark_availability` | HDB carpark lots near a location, by address or carpark number |
| `datagovsg_get_taxi_availability` | Taxi count island-wide and near a location |
| `datagovsg_get_traffic_images` | Traffic camera snapshots (currently checkpoint cameras only) |

### SingStat (official statistics)

| Tool | Purpose |
|------|---------|
| `singstat_search_tables` | Find statistics tables (GDP, CPI, population...) |
| `singstat_get_table_metadata` | Series, frequency and time coverage of a table |
| `singstat_get_table_data` | Values, filtered by series and time period |

### Misc

| Tool | Purpose |
|------|---------|
| `datagovsg_hello` | Server status, key type in use, catalogue index status |

## Local Development

```bash
npm install
npm run dev                 # tsx, http://localhost:8080/mcp

# In another terminal: call every tool against the live APIs
npm run smoke
MCP_URL=https://mcp.techmavie.digital/datagovsg/mcp npm run smoke

npm run typecheck
npm run lint
npm run format
```

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:8080/mcp
```

## Analytics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/analytics` | GET | Usage summary, cache hit rate, upstream stats, catalogue status |
| `/analytics/tools` | GET | Tool usage counts |
| `/analytics/dashboard` | GET | Visual dashboard |
| `/analytics/reset` | POST | Reset (requires `ANALYTICS_RESET_KEY`) |
| `/analytics/import` | POST | Merge exported data (requires `ANALYTICS_RESET_KEY`) |

Analytics are stored in `/app/data/analytics.json` and Firebase Realtime Database at `/mcp-analytics/mcp-datagovsg`. Client IPs are never stored, only a salted hash used to count unique clients.

## Configuration

### Core environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATAGOVSG_API_KEY` | – | Server's data.gov.sg API key, used unless the caller brings their own. Strongly recommended |
| `DATAGOVSG_API_KEY_TIER` | `production` | `production` or `developer`; sets local request pacing |
| `KEY_SERVICE_URL` | – | Full MCP Key Service resolve URL, e.g. `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | – | This server's bearer token in the key service (`datagovsg:<token>`) |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP listen address |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Analytics backup and catalogue index |
| `ANALYTICS_RESET_KEY` | – | Enables the reset/import endpoints |
| `ANALYTICS_SALT` | random | Salt for hashing client IPs (set it for stable unique-client counts) |
| `FIREBASE_DATABASE_URL` | – | Firebase RTDB URL (analytics persistence) |
| `FIREBASE_CREDENTIALS_PATH` | `.credentials/firebase-service-account.json` | Service account file |
| `CATALOG_REFRESH_MS` | `86400000` | How often the catalogue index is rebuilt |

See [.env.example](.env.example) for all options.

### data.gov.sg rate limits

Per 10 seconds, per API key (or per IP without a key):

| API | No key | Developer key | Production key |
|-----|--------|---------------|----------------|
| Real-time | 6 | 12 | 30 |
| Dataset query | 4 | 8 | 20 |
| Download | 2 | 4 | 10 |

The server queues requests to stay within these limits, caches responses (60 s for real-time data, 5 minutes for queries, 6 hours for metadata), and retries once after a 429.

## Project Structure

```
src/
├── http-server.ts          # Express server: per-request MCP transport, key-service auth, analytics routes
├── server.ts               # createServer(): registers all tools + server instructions
├── config.ts               # Env vars, API base URLs, cache TTLs, rate-limit table
├── search.tools.ts         # search_all, search_datasets, list_collections
├── datasets.tools.ts       # get_collection, get_dataset_metadata, query_dataset, get_download_url
├── weather.tools.ts        # Real-time weather/environment tools
├── transport.tools.ts      # Carpark, taxi, traffic camera tools
├── singstat.tools.ts       # SingStat Table Builder tools
├── analytics.ts            # Tracking + persistence
├── analytics-dashboard.ts  # Dashboard HTML
├── firebase-analytics.ts   # Firebase RTDB persistence
└── utils/
    ├── http-client.ts      # axios client: API key, rate limiting, caching, error handling
    ├── rate-limiter.ts     # Sliding-window request queue
    ├── cache.ts            # TTL cache with in-flight de-duplication
    ├── catalog-index.ts    # Local index of the data.gov.sg catalogue
    ├── search.ts           # Tokenising, synonyms, relevance scoring
    ├── realtime-catalog.ts # Real-time API → tool mapping
    ├── geo.ts              # Distances, SVY21 → WGS84
    ├── key-service.ts      # MCP Key Service client
    ├── format.ts           # Output formatting helpers
    └── tool-helpers.ts     # registerReadOnlyTool, ok/fail envelopes
```

## Data Sources

| Source | Base URL | Used for |
|--------|----------|----------|
| data.gov.sg catalogue | `api-production.data.gov.sg/v2/public/api` | Collections and dataset metadata |
| data.gov.sg datastore | `data.gov.sg/api/action/datastore_search` | Row queries |
| data.gov.sg downloads | `api-open.data.gov.sg/v1/public/api` | File downloads |
| data.gov.sg real-time | `api-open.data.gov.sg/v2/real-time/api` | Weather, environment, floods, radar |
| data.gov.sg transport | `api.data.gov.sg/v1/transport` | Carparks, taxis, traffic images |
| SingStat Table Builder | `tablebuilder.singstat.gov.sg/api/table` | Official statistics |
| OneMap (SLA) | `www.onemap.gov.sg/api/common/elastic/search` | Place name and postal code lookup |

Data from data.gov.sg is provided under the [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). Tool responses include a `source` field for attribution.

## Troubleshooting

```bash
# Health (shows API key, key service, Firebase and catalogue status)
curl https://mcp.techmavie.digital/datagovsg/health

# List tools
curl -X POST https://mcp.techmavie.digital/datagovsg/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

| Symptom | Cause |
|---------|-------|
| Dataset search says the index is being built | First start only; the catalogue crawl takes ~20 seconds |
| Rate limit errors | No API key configured, or it expired (data.gov.sg treats invalid keys as anonymous) |
| `401 Invalid, revoked or suspended API key` | The `usr_` key is wrong or revoked; remove it to use the shared key |
| Slow `search_all` | SingStat search takes ~7 seconds per new query; results are cached for an hour |

More in [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md#troubleshooting).

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgments

- [data.gov.sg](https://data.gov.sg/), Singapore's open data portal (Open Government Products)
- [SingStat Table Builder](https://tablebuilder.singstat.gov.sg/), Department of Statistics Singapore
- [National Environment Agency](https://www.nea.gov.sg/), [PUB](https://www.pub.gov.sg/), [HDB](https://www.hdb.gov.sg/) and [LTA](https://www.lta.gov.sg/) for the real-time data
- [OneMap](https://www.onemap.gov.sg/) by the Singapore Land Authority for place lookups
- [aniruddha-adhikary/gahmen-mcp](https://github.com/aniruddha-adhikary/gahmen-mcp), the original MCP server this project started from
- [Model Context Protocol](https://modelcontextprotocol.io/)
