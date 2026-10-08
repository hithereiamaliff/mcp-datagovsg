# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` - Start the HTTP server with tsx (http://localhost:8080/mcp)
- `npm run build` - Clean and compile TypeScript to dist/
- `npm start` - Build and run the production server (dist/http-server.js)
- `npm run smoke` - Call every tool against the live APIs (`MCP_URL=... npm run smoke` for another server)
- `npm run typecheck` / `npm run lint` / `npm run lint:fix` / `npm run format`

Docker (VPS): `docker compose up -d --build`, `docker compose logs -f`. Deployment guide: `deploy/DEPLOYMENT.md`.

## Architecture

### Single transport: Streamable HTTP on the VPS
- `src/http-server.ts` is the only entry point (Smithery support was removed in v2).
- Stateless: a **new McpServer + StreamableHTTPServerTransport per request** (`createServer()` in `src/server.ts`). Never reuse a transport across requests; SDK >= 1.2x throws.
- Endpoints: `/`, `/health`, `/mcp`, `/mcp/:userKey`, `/analytics`, `/analytics/tools`, `/analytics/dashboard`, `POST /analytics/reset|import`.

### API keys
- Default: every request uses the operator's `DATAGOVSG_API_KEY` (sent as `x-api-key`).
- Optional: callers pass a MCP Key Service `usr_...` key (`?api_key=`, `/mcp/usr_...`, `X-API-Key`, or `Bearer`). `src/utils/key-service.ts` resolves it to the user's own data.gov.sg key (`server_id: 'datagovsg'`, connector field `apiKey`, may be empty).
- Invalid `usr_` key → 401. Key service unreachable → fall back to the server key (data is public).
- Raw data.gov.sg keys are rejected over HTTP.
- The key never reaches SingStat (it doesn't use keys).

### Shared infrastructure (`src/utils/`)
- `http-client.ts` `apiGet()`: every upstream call goes through it. It handles the cache, rate limiter, `x-api-key`, User-Agent and retry after a 429. Pick the right `unwrap*`:
  - `unwrapOgp`: `{code: 0, data}`, used by catalogue, download and real-time
  - `unwrapCkan`: `{success, result}`, used by datastore_search
  - `unwrapPlain`: v1 transport
  - `unwrapSingstat`: `{Data, StatusCode: 200}`
- `rate-limiter.ts`: per (key, API family) sliding window using the limits in `config.ts` (`RATE_LIMITS`).
- `cache.ts`: shared TTL cache keyed by URL+params+body. Not keyed by API key, since the data is public.
- `catalog-index.ts`: data.gov.sg has **no search API**. The server crawls all `/datasets` and `/collections` pages (~600 requests, ~15s), saves them to `DATA_DIR/catalog-index.json` and refreshes daily, serving the stale copy while it refreshes.
- `tool-helpers.ts` `registerReadOnlyTool()`: wraps `registerTool` with read-only annotations. Handlers return plain objects, and thrown errors become `isError` results with hints.

### Tools (prefixes `datagovsg_` and `singstat_`)
- `search.tools.ts`: `search_all` (datasets + collections + real-time APIs + SingStat, each result with `next_step`), `search_datasets`, `list_collections`
- `datasets.tools.ts`: `get_collection`, `get_dataset_metadata`, `query_dataset`, `get_download_url`
- `weather.tools.ts`: forecast, readings, air quality, UV, heat stress, lightning, flood alerts, radar, current conditions
- `transport.tools.ts`: carpark availability (joined with the HDB carpark info dataset, SVY21→WGS84), taxis, traffic images
- `singstat.tools.ts`: `search_tables`, `get_table_metadata`, `get_table_data`
- `server.ts`: `datagovsg_hello` and the server `instructions` string

When adding a real-time API, also add it to `utils/realtime-catalog.ts` so search can point to it.

## API Provider Specifics

**data.gov.sg** (keys optional; limits per 10s, no key / dev / prod):

| API | Base | Limit |
|-----|------|-------|
| Catalogue | `api-production.data.gov.sg/v2/public/api` | not limited |
| Datastore search | `data.gov.sg/api/action/datastore_search` | 4/8/20 |
| Download | `api-open.data.gov.sg/v1/public/api` | 2/4/10 |
| Real-time | `api-open.data.gov.sg/v2/real-time/api` | 6/12/30 |
| Transport | `api.data.gov.sg/v1/transport` (still v1) | — |

Other notes:
- Success is `code: 0`. A bad collection ID returns **HTTP 200 with `code: 1`**.
- 429 bodies have `code: 24` and no Retry-After header. Invalid keys are silently treated as anonymous.
- Download filters go in a **JSON body on a GET request**. Node's built-in fetch can't send that, so axios is used. Poll with the same body. Non-CSV files skip initiate.
- Datastore values come back as strings. Only columns typed `numeric`/`int4` are converted, which keeps leading zeros in postal codes.
- Real-time `date` param: `YYYY-MM-DD` gives a paginated day (`paginationToken`), `YYYY-MM-DDTHH:mm:ss` gives that moment.
- Lightning and WBGT live at `/weather?api=lightning|wbgt`; flood alerts at `/weather/flood-alerts`.

**SingStat Table Builder** (`tablebuilder.singstat.gov.sg/api/table`):
- No key; about 100 calls/min per IP. An empty User-Agent returns HTML.
- Search takes ~7s per call and matches phrases literally.
- In `tabledata`, `limit`/`offset` count data points, not rows.

## Analytics
- `src/analytics.ts` tracks requests at the HTTP layer and saves every 30s to `DATA_DIR/analytics.json` and Firebase RTDB `/mcp-analytics/mcp-datagovsg`.
- Client IPs are stored only as salted HMAC hashes (`ANALYTICS_SALT`). Never expose per-client data on `/analytics`.
- Firebase drops empty objects, so always normalise loaded data with defaults (see `normalise()`).

## Deployment
- VPS path `/opt/mcp-servers/datagovsg`, container `mcp-datagovsg`, host port `127.0.0.1:8098`, nginx `location /datagovsg/`.
- External Docker network `mcp-network`, shared with mcp-key-service.
- GitHub Actions (`.github/workflows/deploy-vps.yml`): CI on push/PR, SSH deploy on `main`. `.env` on the VPS is created by hand and never overwritten by the workflow.
