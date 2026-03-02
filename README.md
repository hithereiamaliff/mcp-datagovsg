# Singapore Data MCP Server

**MCP Endpoint:** `https://mcp.techmavie.digital/datagovsg/mcp`

**Analytics Dashboard:** [`https://mcp.techmavie.digital/datagovsg/analytics/dashboard`](https://mcp.techmavie.digital/datagovsg/analytics/dashboard)

MCP (Model Context Protocol) server for Singapore's data.gov.sg and SingStat APIs, providing easy access to government datasets, collections, and statistical tables.

> This is a fork of [AniruddhaAdhikary/gahmen-mcp](https://github.com/AniruddhaAdhikary/gahmen-mcp), now maintained and improved by [@hithereiamaliff](https://github.com/hithereiamaliff).

## Features

- **Data.gov.sg Collections & Datasets** - Browse, search, and download Singapore government open data
- **CKAN Datastore Search** - Query datasets with filtering, sorting, and full-text search
- **SingStat Table Builder** - Access Department of Statistics Singapore tables and data cubes
- **Dataset Downloads** - Initiate and poll filtered dataset downloads
- **Multi-Transport** - Supports both Smithery (stdio) and Streamable HTTP transport
- **Firebase Analytics** - Cloud-based analytics with Firebase Realtime Database and local backup
- **VPS Deployment Ready** - Docker, Nginx, and GitHub Actions auto-deployment support
- **Analytics Dashboard** - Visual dashboard with Chart.js for MCP server usage monitoring

## Quick Start (Hosted Server)

The easiest way to use this MCP server is via the hosted endpoint. **No installation required!**

**Server URL:**
```
https://mcp.techmavie.digital/datagovsg/mcp
```

### Client Configuration

For Claude Desktop / Cursor / Windsurf, add to your MCP configuration:

```json
{
  "mcpServers": {
    "singapore-data": {
      "transport": "streamable-http",
      "url": "https://mcp.techmavie.digital/datagovsg/mcp"
    }
  }
}
```

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# Select "Streamable HTTP"
# Enter URL: https://mcp.techmavie.digital/datagovsg/mcp
```

## Available Tools

### Data.gov.sg Collections

- **`datagovsg_list_collections`** - List all collections on data.gov.sg
- **`datagovsg_get_collection`** - Get metadata for a specific collection (with optional dataset metadata)

### Data.gov.sg Datasets

- **`datagovsg_list_datasets`** - List all datasets on data.gov.sg
- **`datagovsg_get_dataset_metadata`** - Get metadata for a specific dataset
- **`datagovsg_search_dataset`** - Search for data within a dataset using CKAN datastore
- **`datagovsg_initiate_download`** - Initiate download of a dataset with optional filtering
- **`datagovsg_poll_download`** - Check download status and get download URL

### SingStat Table Builder

- **`singstat_search_resources`** - Search for SingStat tables by keyword
- **`singstat_get_metadata`** - Get metadata for a specific SingStat table
- **`singstat_get_table_data`** - Get data from a SingStat table with optional filtering

### Test

- **`hello`** - A simple test tool to verify the MCP server is working correctly

## Installation

```bash
npm install
```

## Local Development

```bash
# Run HTTP server in development mode
npm run dev:http

# Or build and run production version
npm run build
npm run start:http

# Test health endpoint
curl http://localhost:8080/health

# Test MCP endpoint
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Usage Examples

### Search a Dataset

```javascript
// Search population data
datagovsg_search_dataset({
  resource_id: "d_8b84c4ee58e3cfc0ece0d773c8ca6abc",
  q: "2023",
  limit: 10
})
```

### Get Collection with Datasets

```javascript
// Get collection 522 with all dataset metadata
datagovsg_get_collection({
  collectionId: "522",
  withDatasetMetadata: true
})
```

### Search SingStat Tables

```javascript
// Search for GDP data
singstat_search_resources({
  keyword: "GDP",
  searchOption: "all"
})

// Get table data with time filter
singstat_get_table_data({
  resourceId: "M015171",
  timeFilter: "2023",
  limit: 100
})
```

## Analytics Dashboard

The hosted server includes a built-in analytics dashboard:

**Dashboard URL:** [`https://mcp.techmavie.digital/datagovsg/analytics/dashboard`](https://mcp.techmavie.digital/datagovsg/analytics/dashboard)

### Analytics Endpoints

| Endpoint | Description |
|----------|-------------|
| `/analytics` | Full analytics summary (JSON) |
| `/analytics/tools` | Detailed tool usage stats (JSON) |
| `/analytics/dashboard` | Visual dashboard with charts (HTML) |

The dashboard tracks:
- Total requests and tool calls
- Tool usage distribution
- Hourly request trends (last 24 hours)
- Requests by endpoint
- Top clients by user agent
- Recent tool calls feed

Auto-refreshes every 30 seconds.

## Deployment

### Production Server

The MCP server is deployed at:
- **Endpoint:** `https://mcp.techmavie.digital/datagovsg/mcp`
- **Health Check:** `https://mcp.techmavie.digital/datagovsg/health`
- **Analytics Dashboard:** `https://mcp.techmavie.digital/datagovsg/analytics/dashboard`
- **Transport:** Streamable HTTP

### Self-Hosting (VPS)

To deploy your own instance:

```bash
# Using Docker
docker compose up -d --build

# Or run directly
npm run build
npm run start:http
```

### Auto-Deployment

This repository includes a GitHub Actions workflow for automatic VPS deployment. When you push to `main`, the server automatically redeploys.

Required GitHub Actions secrets:
- `VPS_HOST` - Your VPS IP address
- `VPS_USERNAME` - SSH username (e.g., `root`)
- `VPS_PORT` - SSH port (e.g., `22`)
- `VPS_SSH_KEY` - Private SSH key for authentication

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server host |
| `NODE_ENV` | — | Node environment |
| `ANALYTICS_DIR` | `/app/data` | Analytics data directory |
| `ANALYTICS_RESET_KEY` | — | Secret key for `/analytics/reset` endpoint |
| `FIREBASE_DATABASE_URL` | — | Firebase Realtime Database URL |
| `FIREBASE_CREDENTIALS_PATH` | `.credentials/firebase-service-account.json` | Path to Firebase credentials |

## Project Structure

```
mcp-datagovsg/
├── src/
│   ├── index.ts                  # Main MCP server (stdio/Smithery transport)
│   ├── http-server.ts            # Streamable HTTP server for VPS deployment
│   ├── datagovsg.tools.ts        # Data.gov.sg API tools
│   ├── singstat.tools.ts         # SingStat Table Builder API tools
│   ├── firebase-analytics.ts     # Firebase analytics persistence
│   └── types.ts                  # TypeScript type definitions
├── deploy/
│   └── nginx-mcp.conf            # Nginx reverse proxy configuration
├── .github/
│   └── workflows/
│       └── deploy-vps.yml        # GitHub Actions auto-deployment
├── Dockerfile                    # Docker container configuration
├── docker-compose.yml            # Docker Compose orchestration
├── package.json                  # Project dependencies and scripts
├── tsconfig.json                 # TypeScript configuration
├── .env.example                  # Environment variables template
└── README.md                     # This file
```

## API Information

### Data.gov.sg APIs
- **No authentication required** (public APIs)
- API responses use `code: 0` for success
- Dataset IDs start with `d_` prefix
- Collection IDs are numeric strings

### SingStat Table Builder APIs
- **No authentication required** (public APIs)
- Resource IDs are alphanumeric (e.g., M015171)
- Supports time series, cross-sectional, and multi-dimensional data cubes
- Search works best with single keywords rather than complex phrases

## Troubleshooting

### Container Issues

```bash
# Check container status
docker compose ps

# View logs
docker compose logs -f

# Restart container
docker compose restart
```

### Test MCP Connection

```bash
# List tools
curl -X POST https://mcp.techmavie.digital/datagovsg/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call hello tool
curl -X POST https://mcp.techmavie.digital/datagovsg/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{}}}'
```

## Contributing

1. Fork repository
2. Create feature branch
3. Commit changes
4. Create pull request

## License

MIT - See [LICENSE](./LICENSE) file for details.

## Acknowledgments

- [data.gov.sg](https://data.gov.sg/) - Singapore Open Data Portal
- [SingStat Table Builder](https://tablebuilder.singstat.gov.sg/) - Department of Statistics Singapore
- [AniruddhaAdhikary/gahmen-mcp](https://github.com/AniruddhaAdhikary/gahmen-mcp) - Original MCP server
- [Model Context Protocol](https://modelcontextprotocol.io/) for the MCP framework