/**
 * Singapore Open Data MCP Server - Streamable HTTP entry point.
 *
 * Deployed at https://mcp.techmavie.digital/datagovsg/mcp behind nginx.
 *
 * Authentication model (all optional):
 * - No key            -> uses the operator's data.gov.sg API key (DATAGOVSG_API_KEY)
 * - usr_... key       -> resolved via the MCP Key Service to the caller's own
 *                        data.gov.sg API key (their own rate-limit quota).
 *                        Accepted as ?api_key=, /mcp/usr_..., X-API-Key header,
 *                        or Authorization: Bearer usr_...
 *
 * Usage:
 *   npm run build && npm start        (production)
 *   npm run dev                        (development, tsx)
 */

import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  DATAGOVSG_API_KEY,
  DATAGOVSG_API_KEY_TIER,
  KEY_PORTAL_URL,
  REPO_URL,
  SERVER_NAME,
  SERVER_VERSION,
} from './config.js';
import { createServer } from './server.js';
import {
  AuthMode,
  getAnalyticsSummary,
  getToolStats,
  importAnalytics,
  initAnalytics,
  resetAnalytics,
  saveAnalytics,
  trackAuth,
  trackRequest,
  trackToolCalls,
} from './analytics.js';
import { renderDashboard } from './analytics-dashboard.js';
import { isFirebaseEnabled } from './firebase-analytics.js';
import { getCatalogStatus, warmCatalog } from './utils/catalog-index.js';
import { getCacheStats, upstreamStats } from './utils/http-client.js';
import {
  isKeyServiceEnabled,
  looksLikeUserKey,
  resolveKeyCredentials,
} from './utils/key-service.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

// Behind exactly one reverse proxy (nginx): trust its X-Forwarded-For
app.set('trust proxy', 1);

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      'X-API-Key',
    ],
    exposedHeaders: ['Mcp-Session-Id', 'X-Datagovsg-Key-Source'],
  })
);
app.use(express.json({ limit: '1mb' }));

// ============================================================================
// Info and health
// ============================================================================

app.get('/', (req: Request, res: Response) => {
  trackRequest(req, '/');
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description:
      'MCP server for Singapore open data: data.gov.sg datasets, real-time weather/environment/transport APIs, and SingStat statistics',
    transport: 'streamable-http',
    endpoints: {
      mcp: '/mcp',
      health: '/health',
      analytics: '/analytics',
      analyticsTools: '/analytics/tools',
      analyticsDashboard: '/analytics/dashboard',
    },
    authentication: {
      required: false,
      default: "Requests use the server operator's data.gov.sg API key.",
      optional_own_key: isKeyServiceEnabled()
        ? {
            description:
              'Use your own data.gov.sg API key (separate rate-limit quota) by registering it at the MCP Key Service and adding your usr_... key.',
            register: KEY_PORTAL_URL,
            methods: {
              query: '/mcp?api_key=usr_...',
              path: '/mcp/usr_...',
              header: 'X-API-Key: usr_...',
            },
          }
        : undefined,
    },
    documentation: REPO_URL,
  });
});

app.get('/health', (req: Request, res: Response) => {
  trackRequest(req, '/health');
  res.json({
    status: 'healthy',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'streamable-http',
    serverApiKey: DATAGOVSG_API_KEY ? DATAGOVSG_API_KEY_TIER : 'not configured',
    keyServiceEnabled: isKeyServiceEnabled(),
    firebaseEnabled: isFirebaseEnabled(),
    catalogue: getCatalogStatus(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// Analytics
// ============================================================================

function checkAdminKey(req: Request, res: Response): boolean {
  const expected = process.env.ANALYTICS_RESET_KEY || process.env.ANALYTICS_IMPORT_KEY;
  if (!expected) {
    res.status(403).json({ error: 'Endpoint is disabled' });
    return false;
  }
  const provided = req.headers['x-reset-key'] || req.query.key;
  if (provided !== expected) {
    res.status(403).json({ error: 'Invalid key' });
    return false;
  }
  return true;
}

app.get('/analytics', (req: Request, res: Response) => {
  trackRequest(req, '/analytics');
  res.json(
    getAnalyticsSummary({
      cache: getCacheStats(),
      upstream: upstreamStats,
      catalogue: getCatalogStatus(),
    })
  );
});

app.get('/analytics/tools', (req: Request, res: Response) => {
  trackRequest(req, '/analytics/tools');
  res.json(getToolStats());
});

app.get('/analytics/dashboard', (req: Request, res: Response) => {
  trackRequest(req, '/analytics/dashboard');
  res.type('html').send(renderDashboard());
});

app.post('/analytics/reset', async (req: Request, res: Response) => {
  if (!checkAdminKey(req, res)) return;
  await resetAnalytics();
  res.json({ message: 'Analytics reset successfully' });
});

app.post('/analytics/import', async (req: Request, res: Response) => {
  if (!checkAdminKey(req, res)) return;
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Invalid import data' });
    return;
  }
  await importAnalytics(req.body);
  res.json({ message: 'Analytics imported successfully' });
});

// ============================================================================
// MCP endpoint
// ============================================================================

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Find a usr_ key in the path, X-API-Key header, Bearer token or query string. */
function extractUserKey(req: Request): string | undefined {
  const fromPath = firstString(req.params.userKey);
  if (fromPath) return fromPath;
  const header = firstString(req.headers['x-api-key']);
  if (header) return header;
  const authorization = firstString(req.headers.authorization);
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token.startsWith('usr_')) return token;
  }
  return firstString(req.query.api_key) ?? firstString(req.query.apiKey);
}

function jsonRpcError(
  res: Response,
  status: number,
  message: string,
  data?: Record<string, unknown>
) {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message, data }, id: null });
}

async function handleMcp(req: Request, res: Response): Promise<void> {
  trackRequest(req, req.params.userKey ? '/mcp/:userKey' : '/mcp');

  // Stateless server: no SSE streams or sessions to open/close
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    jsonRpcError(
      res,
      405,
      'Method not allowed. This server is stateless; send JSON-RPC requests with POST.'
    );
    return;
  }

  let userApiKey: string | undefined;
  let mode: AuthMode = 'anonymous';
  const userKey = extractUserKey(req);

  if (userKey !== undefined) {
    if (!looksLikeUserKey(userKey)) {
      jsonRpcError(
        res,
        400,
        'Only MCP Key Service keys (usr_...) are accepted. Register your data.gov.sg API key at the key portal, or connect without a key to use the shared server key.',
        { register: KEY_PORTAL_URL }
      );
      return;
    }

    const result = await resolveKeyCredentials(userKey);
    if (result.ok) {
      userApiKey = result.apiKey || undefined;
      mode = userApiKey ? 'user_key' : 'user_key_empty';
    } else if (result.reason === 'invalid_key') {
      trackAuth('invalid_key');
      jsonRpcError(res, 401, 'Invalid, revoked or suspended API key.', {
        register: KEY_PORTAL_URL,
        hint: 'Check your usr_ key, or remove it from the URL to use the shared server key.',
      });
      return;
    } else {
      // Data is public, so fall back to the server key instead of failing
      console.warn(
        `[key-service] ${result.reason}: ${result.message}. Falling back to server key.`
      );
      mode = 'server_fallback';
    }
  }

  trackAuth(mode);
  trackToolCalls(req.body, req, mode);
  res.setHeader(
    'X-Datagovsg-Key-Source',
    userApiKey ? 'user' : DATAGOVSG_API_KEY ? 'server' : 'none'
  );

  // A fresh server + transport per request (required for stateless mode)
  const server = createServer({ userApiKey });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    void transport.close();
    void server.close();
  };
  res.once('close', cleanup);
  res.once('finish', cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

app.all('/mcp', handleMcp);
app.all('/mcp/:userKey', handleMcp);

// Malformed JSON bodies -> JSON-RPC parse error instead of an HTML page
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (
    error &&
    typeof error === 'object' &&
    (error as { type?: string }).type === 'entity.parse.failed'
  ) {
    res
      .status(400)
      .json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    return;
  }
  next(error);
});

// ============================================================================
// Start / stop
// ============================================================================

initAnalytics().catch((error) => console.error('[analytics] Init failed:', error));

// Express 5 passes listen errors (e.g. port already in use) to this callback
const httpServer = app.listen(PORT, HOST, (error?: Error) => {
  if (error) {
    console.error(`Failed to start server on ${HOST}:${PORT}:`, error.message);
    process.exit(1);
  }
  console.log('='.repeat(60));
  console.log(`${SERVER_NAME} v${SERVER_VERSION} (Streamable HTTP)`);
  console.log('='.repeat(60));
  console.log(`Server:     http://${HOST}:${PORT}`);
  console.log(`MCP:        http://${HOST}:${PORT}/mcp`);
  console.log(`Health:     http://${HOST}:${PORT}/health`);
  console.log(`Dashboard:  http://${HOST}:${PORT}/analytics/dashboard`);
  console.log(
    `API key:    ${DATAGOVSG_API_KEY ? `server key (${DATAGOVSG_API_KEY_TIER})` : 'none (anonymous limits)'}`
  );
  console.log(`Key svc:    ${isKeyServiceEnabled() ? 'enabled' : 'disabled'}`);
  console.log('='.repeat(60));
  warmCatalog();
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, saving analytics...`);
  httpServer.close();
  try {
    await Promise.race([saveAnalytics(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
