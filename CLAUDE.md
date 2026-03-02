# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Core Development
- `npm run dev:http` - Start HTTP server in development mode with tsx
- `npm run dev` - Start Smithery MCP development server
- `npm run build` - Clean and compile TypeScript to dist/
- `npm run start:http` - Start production HTTP server

### Code Quality
- `npm run typecheck` - TypeScript type checking (no emit)
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check Prettier formatting

### Docker
- `docker compose up -d --build` - Build and start container
- `docker compose logs -f` - View container logs
- `docker compose down` - Stop container

## Architecture Overview

### Dual Transport Architecture
This MCP server supports **two transport modes**:

1. **Smithery (stdio)** - via `src/index.ts` (default export with `({ config })` signature)
2. **VPS HTTP** - via `src/http-server.ts` (Express + Streamable HTTP transport)

The VPS HTTP server wraps the same tool registration functions used by the Smithery entry point.

### File Structure
```
src/
├── index.ts                  # Smithery entry point (stdio transport)
├── http-server.ts            # VPS entry point (Express + Streamable HTTP)
├── datagovsg.tools.ts        # Data.gov.sg API tools (datagovsg_ prefix)
├── singstat.tools.ts         # SingStat API tools (singstat_ prefix)
├── firebase-analytics.ts     # Firebase Realtime Database analytics
└── types.ts                  # TypeScript type definitions
```

### API Integration Pattern
The codebase integrates with **4 different API bases**:
- `api-production.data.gov.sg/v2/public/api` - Collections and Datasets APIs
- `data.gov.sg/api/action` - CKAN Datastore Search API
- `api-open.data.gov.sg/v1/public/api` - Download APIs
- `tablebuilder.singstat.gov.sg/api/table` - SingStat Table Builder APIs

### Multi-Provider Architecture
Tools are organized by provider in separate files:
- `src/datagovsg.tools.ts` - Data.gov.sg API tools with `datagovsg_` prefix
- `src/singstat.tools.ts` - SingStat API tools with `singstat_` prefix
- Both are registered in `src/index.ts` (Smithery) and `src/http-server.ts` (VPS)

### Tool Categories
- **Data.gov.sg Collections**: `datagovsg_list_collections`, `datagovsg_get_collection`
- **Data.gov.sg Datasets**: `datagovsg_list_datasets`, `datagovsg_get_dataset_metadata`
- **Data.gov.sg CKAN Search**: `datagovsg_search_dataset` (main data querying tool)
- **Data.gov.sg Downloads**: `datagovsg_initiate_download`, `datagovsg_poll_download`
- **SingStat**: `singstat_search_resources`, `singstat_get_metadata`, `singstat_get_table_data`
- **Test**: `hello` (HTTP server only)

### Analytics Architecture
- **Primary storage**: Firebase Realtime Database (`/mcp-analytics/mcp-datagovsg`)
- **Backup storage**: Local JSON file (`/app/data/analytics.json`)
- **Dashboard**: Chart.js visual dashboard at `/analytics/dashboard`
- **Auto-save**: Every 30 seconds + on process exit

### Response Format Consistency
All tools return JSON-stringified responses in MCP text content format. Error handling follows consistent pattern with descriptive error messages.

### API Provider Specifics

**Data.gov.sg APIs:**
- No authentication required (public APIs)
- API responses use `code: 0` for success (not `code: 1`)
- Dataset IDs start with `d_` prefix
- Collection IDs are numeric strings
- CKAN datastore uses different response format (`success: true, result: {}`)

**SingStat Table Builder APIs:**
- No authentication required (public APIs)
- API responses use `StatusCode: 200` for success
- Resource IDs are alphanumeric (e.g., M015171)
- Response structure: `{ Data: {}, DataCount: number, StatusCode: number, Message: string }`
- Supports time series, cross-sectional, and multi-dimensional data cubes
- **Search limitations**: `singstat_search_resources` is basic and works best with single keywords rather than complex phrases

## VPS Deployment

### Infrastructure
- **Docker**: Node.js 20-alpine container, port 8087 → 8080
- **Nginx**: Reverse proxy at `mcp.techmavie.digital/datagovsg/`
- **CI/CD**: GitHub Actions auto-deploy on push to `main`
- **Analytics**: Firebase Realtime Database + local JSON backup

### Standard Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP requests (JSON-RPC) |
| `/analytics` | GET | Analytics JSON data |
| `/analytics/tools` | GET | Tool usage stats |
| `/analytics/dashboard` | GET | Visual dashboard (HTML) |
| `/analytics/reset` | POST | Reset analytics (requires key) |
| `/analytics/import` | POST | Import backup data (requires key) |

### Smithery Deployment
- Uses `smithery.yaml` with `runtime: typescript`
- Entry point is `src/index.ts` with default export
- `package.json` `module` field points to `./dist/index.js`

## Important Notes

### API Response Validation
Different APIs have different success indicators:
- Collections/Datasets APIs: Check for `data.data` presence
- CKAN Datastore: Check for `data.success && data.result`
- Download APIs: Check for `data.data` presence

### Firebase Analytics Null Handling
When loading analytics from Firebase, always provide fallback defaults for all object/array fields. Firebase does not store empty objects `{}`, so they return as `undefined`.