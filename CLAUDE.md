# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Core Development
- `npm run dev` - Start development server with tsx (not Smithery dev server)
- `npx @smithery/cli dev` - Start Smithery MCP development server on port 8181
- `npx @smithery/cli build` - Build for Smithery deployment

### Code Quality
- `npm run typecheck` - TypeScript type checking (no emit)
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check Prettier formatting
- `npm run build` - Compile TypeScript to dist/

## Architecture Overview

### MCP Server Structure
This is a **stateless MCP server** that exposes Singapore's data.gov.sg APIs through Model Context Protocol tools. The server follows Smithery's convention requiring a default export function with signature `({ config })`.

### API Integration Pattern
The codebase integrates with **4 different data.gov.sg API bases**:
- `api-production.data.gov.sg/v2/public/api` - Collections and Datasets APIs
- `data.gov.sg/api/action` - CKAN Datastore Search API  
- `api-open.data.gov.sg/v1/public/api` - Download APIs

### Rate Limiting Architecture
Built-in rate limiter implements **5 requests per minute** (12-second intervals) as required by data.gov.sg APIs. All MCP tools automatically apply rate limiting before API calls.

### HTTP Logging
Global axios interceptors provide comprehensive request/response logging with emojis for easy debugging. All API calls are automatically logged with parameters, responses, and errors.

### Future Multi-Provider Architecture
The codebase is structured for future expansion to support **SingStats APIs** alongside data.gov.sg. Current monolithic structure in `src/index.ts` is planned for refactoring into provider-based architecture.

### Tool Categories
- **Collections**: `list_collections`, `get_collection`
- **Datasets**: `list_datasets`, `get_dataset_metadata` 
- **CKAN Search**: `search_dataset` (main data querying tool)
- **Downloads**: `initiate_download`, `poll_download`

### Response Format Consistency
All tools return JSON-stringified responses in MCP text content format. Error handling follows consistent pattern with descriptive error messages.

### Data.gov.sg API Specifics
- No authentication required (public APIs)
- API responses use `code: 0` for success (not `code: 1`)
- Dataset IDs start with `d_` prefix
- Collection IDs are numeric strings
- CKAN datastore uses different response format (`success: true, result: {}`)

## Important Notes

### Smithery Deployment
- Uses `smithery.yaml` with `runtime: typescript`
- Entry point is `src/index.ts` with default export
- Requires `package.json` `module` field pointing to source TypeScript

### Rate Limiting Compliance
Always respect the 5 requests/minute limit when adding new tools or modifying existing ones. The `rateLimiter.waitIfNeeded()` call is mandatory before any API request.

### API Response Validation
Different APIs have different success indicators:
- Collections/Datasets APIs: Check for `data.data` presence
- CKAN Datastore: Check for `data.success && data.result`
- Download APIs: Check for `data.data` presence