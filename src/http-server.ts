/**
 * Singapore Data MCP Server - Streamable HTTP Transport
 *
 * This file provides an HTTP server for self-hosting the MCP server on a VPS.
 * It uses the Streamable HTTP transport for MCP communication.
 *
 * Usage:
 *   npm run build
 *   node dist/http-server.js
 *
 * Or with environment variables:
 *   PORT=8080 node dist/http-server.js
 */

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Import tool registration functions
import { registerDataGovSgTools } from './datagovsg.tools.js';
import { registerSingStatTools } from './singstat.tools.js';

// Import Firebase analytics
import {
  saveAnalyticsToFirebase,
  loadAnalyticsFromFirebase,
} from './firebase-analytics.js';

// ============================================================================
// Analytics Tracking with File Persistence + Firebase
// ============================================================================
interface ToolCall {
  tool: string;
  timestamp: string;
  clientIp: string;
  userAgent: string;
}

interface Analytics {
  serverStartTime: string;
  totalRequests: number;
  totalToolCalls: number;
  requestsByMethod: Record<string, number>;
  requestsByEndpoint: Record<string, number>;
  toolCalls: Record<string, number>;
  recentToolCalls: ToolCall[];
  clientsByIp: Record<string, number>;
  clientsByUserAgent: Record<string, number>;
  hourlyRequests: Record<string, number>;
}

// Analytics file path - use /app/data for Docker volume mount
const ANALYTICS_DIR = process.env.ANALYTICS_DIR || '/app/data';
const ANALYTICS_FILE = path.join(ANALYTICS_DIR, 'analytics.json');

const MAX_RECENT_CALLS = 100;
const SAVE_INTERVAL_MS = 30000; // Save every 30 seconds

// Default analytics state
const defaultAnalytics: Analytics = {
  serverStartTime: new Date().toISOString(),
  totalRequests: 0,
  totalToolCalls: 0,
  requestsByMethod: {},
  requestsByEndpoint: {},
  toolCalls: {},
  recentToolCalls: [],
  clientsByIp: {},
  clientsByUserAgent: {},
  hourlyRequests: {},
};

// Load analytics from Firebase first, then fall back to file
async function loadAnalytics(): Promise<Analytics> {
  // Try Firebase first
  console.log('Attempting to load analytics from Firebase...');
  const firebaseData = await loadAnalyticsFromFirebase();
  if (firebaseData) {
    return firebaseData as unknown as Analytics;
  }

  // Fall back to local file
  try {
    if (!fs.existsSync(ANALYTICS_DIR)) {
      fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
    }

    if (fs.existsSync(ANALYTICS_FILE)) {
      const data = fs.readFileSync(ANALYTICS_FILE, 'utf-8');
      const loaded = JSON.parse(data) as Analytics;
      console.log(`Loaded analytics from ${ANALYTICS_FILE}:`, {
        totalRequests: loaded.totalRequests,
        totalToolCalls: loaded.totalToolCalls,
      });
      return loaded;
    }
  } catch (error) {
    console.error('Failed to load analytics from file:', error);
  }
  console.log('Starting with fresh analytics');
  return { ...defaultAnalytics };
}

// Save analytics to both file and Firebase
async function saveAnalytics(): Promise<void> {
  // Save to local file (synchronous backup)
  try {
    if (!fs.existsSync(ANALYTICS_DIR)) {
      fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
    }
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2));
  } catch (error) {
    console.error('Failed to save analytics locally:', error);
  }

  // Save to Firebase (async, non-blocking)
  saveAnalyticsToFirebase(analytics as unknown as Record<string, unknown>).catch(
    (err) => {
      console.error('Firebase save error:', err);
    }
  );
}

// Initialize analytics with defaults immediately to prevent race condition
let analytics: Analytics = { ...defaultAnalytics };

// Load persisted analytics asynchronously and merge on startup
loadAnalytics()
  .then((data) => {
    analytics = data;
    console.log('Analytics initialized:', {
      totalRequests: analytics.totalRequests.toLocaleString(),
      totalToolCalls: analytics.totalToolCalls,
    });
  })
  .catch((error) => {
    console.error('Failed to initialize analytics:', error);
  });

// Periodic save
setInterval(saveAnalytics, SAVE_INTERVAL_MS);

// Save on process exit
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, saving analytics...');
  saveAnalytics();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, saving analytics...');
  saveAnalytics();
  process.exit(0);
});

function trackRequest(req: Request, endpoint: string) {
  analytics.totalRequests++;

  // Track by method
  const method = req.method;
  analytics.requestsByMethod[method] =
    (analytics.requestsByMethod[method] || 0) + 1;

  // Track by endpoint
  analytics.requestsByEndpoint[endpoint] =
    (analytics.requestsByEndpoint[endpoint] || 0) + 1;

  // Track by client IP
  const clientIp =
    req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown';
  analytics.clientsByIp[clientIp] =
    (analytics.clientsByIp[clientIp] || 0) + 1;

  // Track by user agent
  const userAgent = req.headers['user-agent'] || 'unknown';
  const shortAgent = userAgent.substring(0, 50);
  analytics.clientsByUserAgent[shortAgent] =
    (analytics.clientsByUserAgent[shortAgent] || 0) + 1;

  // Track hourly
  const hour = new Date().toISOString().substring(0, 13); // YYYY-MM-DDTHH
  analytics.hourlyRequests[hour] =
    (analytics.hourlyRequests[hour] || 0) + 1;
}

function trackToolCall(toolName: string, req: Request) {
  analytics.totalToolCalls++;
  analytics.toolCalls[toolName] =
    (analytics.toolCalls[toolName] || 0) + 1;

  const toolCall: ToolCall = {
    tool: toolName,
    timestamp: new Date().toISOString(),
    clientIp:
      req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
    userAgent: (req.headers['user-agent'] || 'unknown').substring(0, 50),
  };

  analytics.recentToolCalls.unshift(toolCall);
  if (analytics.recentToolCalls.length > MAX_RECENT_CALLS) {
    analytics.recentToolCalls.pop();
  }
}

function getUptime(): string {
  const start = new Date(analytics.serverStartTime).getTime();
  const now = Date.now();
  const diff = now - start;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  );
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Configuration
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Create MCP server
const mcpServer = new McpServer({
  name: 'Singapore Data MCP Server',
  version: '1.0.0',
});

// Register all tools
registerDataGovSgTools(mcpServer);
registerSingStatTools(mcpServer);

// Register hello tool for testing
mcpServer.tool(
  'hello',
  'A simple test tool to verify that the MCP server is working correctly',
  {},
  async () => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Hello from Singapore Data MCP!',
              timestamp: new Date().toISOString(),
              transport: 'streamable-http',
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Create Express app
const app = express();

// Middleware
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'Mcp-Session-Id',
    ],
    exposedHeaders: ['Mcp-Session-Id'],
  })
);

app.use(express.json());

// Trust proxy for correct IP detection behind nginx
app.set('trust proxy', true);

// ============================================================================
// Health endpoint
// ============================================================================
app.get('/health', (req: Request, res: Response) => {
  trackRequest(req, '/health');
  res.json({
    status: 'healthy',
    server: 'Singapore Data MCP Server',
    version: '1.0.0',
    transport: 'streamable-http',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// Analytics endpoints
// ============================================================================
app.get('/analytics', (req: Request, res: Response) => {
  trackRequest(req, '/analytics');

  const sortedTools = Object.entries(analytics.toolCalls)
    .sort(([, a], [, b]) => b - a)
    .reduce(
      (obj, [key, val]) => {
        obj[key] = val;
        return obj;
      },
      {} as Record<string, number>
    );

  // Get last 24 hours of hourly data
  const now = new Date();
  const last24h: Record<string, number> = {};
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const key = d.toISOString().substring(0, 13);
    last24h[key] = analytics.hourlyRequests[key] || 0;
  }

  res.json({
    uptime: getUptime(),
    summary: {
      totalRequests: analytics.totalRequests,
      totalToolCalls: analytics.totalToolCalls,
      uniqueClients: Object.keys(analytics.clientsByIp).length,
      serverStartTime: analytics.serverStartTime,
    },
    breakdown: {
      byMethod: analytics.requestsByMethod,
      byEndpoint: analytics.requestsByEndpoint,
      byTool: sortedTools,
    },
    hourlyRequests: last24h,
    clients: {
      byIp: analytics.clientsByIp,
      byUserAgent: analytics.clientsByUserAgent,
    },
    recentToolCalls: analytics.recentToolCalls.slice(0, 20),
  });
});

// Analytics tools endpoint
app.get('/analytics/tools', (req: Request, res: Response) => {
  trackRequest(req, '/analytics/tools');

  const tools = Object.entries(analytics.toolCalls)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => ({
      name,
      calls: count,
      percentage:
        analytics.totalToolCalls > 0
          ? ((count / analytics.totalToolCalls) * 100).toFixed(1)
          : '0',
    }));

  res.json({
    totalToolCalls: analytics.totalToolCalls,
    tools,
    recentCalls: analytics.recentToolCalls.slice(0, 50),
  });
});

// Analytics reset endpoint
app.post('/analytics/reset', (req: Request, res: Response) => {
  const resetKey = process.env.ANALYTICS_RESET_KEY;
  if (!resetKey) {
    res.status(403).json({ error: 'Reset endpoint is disabled' });
    return;
  }

  const providedKey =
    req.headers['x-reset-key'] || (req.query.key as string);
  if (providedKey !== resetKey) {
    res.status(403).json({ error: 'Invalid reset key' });
    return;
  }

  analytics = {
    ...defaultAnalytics,
    serverStartTime: new Date().toISOString(),
  };
  saveAnalytics();
  res.json({ message: 'Analytics reset successfully' });
});

// Analytics import endpoint
app.post('/analytics/import', (req: Request, res: Response) => {
  const importKey =
    process.env.ANALYTICS_RESET_KEY || process.env.ANALYTICS_IMPORT_KEY;
  if (!importKey) {
    res.status(403).json({ error: 'Import endpoint is disabled' });
    return;
  }

  const providedKey =
    req.headers['x-reset-key'] || (req.query.key as string);
  if (providedKey !== importKey) {
    res.status(403).json({ error: 'Invalid import key' });
    return;
  }

  const importData = req.body;
  if (!importData || typeof importData !== 'object') {
    res.status(400).json({ error: 'Invalid import data' });
    return;
  }

  // Merge imported data with current analytics
  analytics = {
    ...analytics,
    totalRequests:
      (importData.totalRequests || 0) + analytics.totalRequests,
    totalToolCalls:
      (importData.totalToolCalls || 0) + analytics.totalToolCalls,
    requestsByMethod: {
      ...analytics.requestsByMethod,
      ...importData.requestsByMethod,
    },
    requestsByEndpoint: {
      ...analytics.requestsByEndpoint,
      ...importData.requestsByEndpoint,
    },
    toolCalls: { ...analytics.toolCalls, ...importData.toolCalls },
    clientsByIp: {
      ...analytics.clientsByIp,
      ...importData.clientsByIp,
    },
    clientsByUserAgent: {
      ...analytics.clientsByUserAgent,
      ...importData.clientsByUserAgent,
    },
    hourlyRequests: {
      ...analytics.hourlyRequests,
      ...importData.hourlyRequests,
    },
  };
  saveAnalytics();
  res.json({ message: 'Analytics imported successfully' });
});

// ============================================================================
// Analytics Dashboard
// ============================================================================
app.get('/analytics/dashboard', (req: Request, res: Response) => {
  trackRequest(req, '/analytics/dashboard');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Singapore Data MCP - Analytics Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .header h1 { font-size: 1.8rem; color: #60a5fa; }
    .header p { color: #94a3b8; margin-top: 5px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: #1e293b; border-radius: 12px; padding: 20px; text-align: center; }
    .stat-card .value { font-size: 2rem; font-weight: 700; color: #60a5fa; }
    .stat-card .label { color: #94a3b8; font-size: 0.85rem; margin-top: 5px; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .chart-card { background: #1e293b; border-radius: 12px; padding: 20px; }
    .chart-card h3 { color: #94a3b8; font-size: 0.9rem; margin-bottom: 15px; }
    .chart-container { position: relative; height: 250px; }
    .recent-calls { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .recent-calls h3 { color: #94a3b8; font-size: 0.9rem; margin-bottom: 15px; }
    .call-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #334155; }
    .call-item:last-child { border-bottom: none; }
    .call-tool { color: #60a5fa; font-weight: 600; }
    .call-time { color: #64748b; font-size: 0.8rem; }
    .call-client { color: #64748b; font-size: 0.75rem; }
    .refresh-btn { position: fixed; bottom: 20px; right: 20px; background: #3b82f6; color: white; border: none; border-radius: 50%; width: 50px; height: 50px; font-size: 1.2rem; cursor: pointer; box-shadow: 0 4px 15px rgba(59,130,246,0.3); }
    .refresh-btn:hover { background: #2563eb; }
    @media (max-width: 768px) { .charts { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
  <div class="header">
    <h1>Singapore Data MCP</h1>
    <p id="uptime">Loading...</p>
  </div>

  <div class="stats">
    <div class="stat-card">
      <div class="value" id="totalRequests">-</div>
      <div class="label">Total Requests</div>
    </div>
    <div class="stat-card">
      <div class="value" id="totalToolCalls">-</div>
      <div class="label">Tool Calls</div>
    </div>
    <div class="stat-card">
      <div class="value" id="uniqueClients">-</div>
      <div class="label">Unique Clients</div>
    </div>
    <div class="stat-card">
      <div class="value" id="topTool">-</div>
      <div class="label">Top Tool</div>
    </div>
  </div>

  <div class="charts">
    <div class="chart-card">
      <h3>Tool Usage Distribution</h3>
      <div class="chart-container">
        <canvas id="toolChart"></canvas>
      </div>
    </div>
    <div class="chart-card">
      <h3>Hourly Requests (Last 24h)</h3>
      <div class="chart-container">
        <canvas id="hourlyChart"></canvas>
      </div>
    </div>
    <div class="chart-card">
      <h3>Requests by Endpoint</h3>
      <div class="chart-container">
        <canvas id="endpointChart"></canvas>
      </div>
    </div>
    <div class="chart-card">
      <h3>Top Clients</h3>
      <div class="chart-container">
        <canvas id="clientChart"></canvas>
      </div>
    </div>
  </div>

  <div class="recent-calls">
    <h3>Recent Tool Calls</h3>
    <div class="call-list" id="recentCalls">Loading...</div>
  </div>

  <button class="refresh-btn" onclick="loadData()">&#x1f504;</button>

  <script>
    let toolChart, hourlyChart, endpointChart, clientChart;

    const chartColors = [
      '#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171',
      '#38bdf8', '#c084fc', '#4ade80', '#facc15', '#fb923c'
    ];

    async function loadData() {
      try {
        const basePath = window.location.pathname.replace(/\\/analytics\\/dashboard\\/?$/, '');
        const res = await fetch(basePath + '/analytics');
        const data = await res.json();

        document.getElementById('uptime').textContent = 'Uptime: ' + data.uptime;
        document.getElementById('totalRequests').textContent = data.summary.totalRequests.toLocaleString();
        document.getElementById('totalToolCalls').textContent = data.summary.totalToolCalls.toLocaleString();
        document.getElementById('uniqueClients').textContent = data.summary.uniqueClients.toLocaleString();

        const tools = Object.entries(data.breakdown.byTool);
        document.getElementById('topTool').textContent = tools.length > 0 ? tools[0][0].replace('datagovsg_', '').replace('singstat_', '') : '-';

        updateToolChart(data.breakdown.byTool);
        updateHourlyChart(data.hourlyRequests);
        updateEndpointChart(data.breakdown.byEndpoint);
        updateClientChart(data.clients.byUserAgent);
        updateRecentCalls(data.recentToolCalls);
      } catch (err) {
        console.error('Failed to load analytics:', err);
      }
    }

    function updateToolChart(toolData) {
      const labels = Object.keys(toolData).map(t => t.replace('datagovsg_', '').replace('singstat_', ''));
      const values = Object.values(toolData);

      if (toolChart) toolChart.destroy();
      toolChart = new Chart(document.getElementById('toolChart'), {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{ data: values, backgroundColor: chartColors, borderWidth: 0 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'right', labels: { color: '#a1a1aa' } } }
        }
      });
    }

    function updateHourlyChart(hourlyData) {
      const labels = Object.keys(hourlyData).map(h => h.substring(11) + ':00');
      const values = Object.values(hourlyData);

      if (hourlyChart) hourlyChart.destroy();
      hourlyChart = new Chart(document.getElementById('hourlyChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{ label: 'Requests', data: values, borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.1)', fill: true, tension: 0.4 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      });
    }

    function updateEndpointChart(endpointData) {
      const labels = Object.keys(endpointData);
      const values = Object.values(endpointData);

      if (endpointChart) endpointChart.destroy();
      endpointChart = new Chart(document.getElementById('endpointChart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [{ data: values, backgroundColor: chartColors, borderRadius: 4 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#71717a' }, grid: { display: false } },
            y: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      });
    }

    function updateClientChart(clientData) {
      const entries = Object.entries(clientData).slice(0, 5);
      const labels = entries.map(([k]) => k.substring(0, 30));
      const values = entries.map(([, v]) => v);

      if (clientChart) clientChart.destroy();
      clientChart = new Chart(document.getElementById('clientChart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [{ data: values, backgroundColor: chartColors, borderRadius: 4 }]
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#71717a' }, grid: { display: false } }
          }
        }
      });
    }

    function updateRecentCalls(calls) {
      const container = document.getElementById('recentCalls');
      if (!calls || calls.length === 0) {
        container.innerHTML = '<p style="color: #71717a;">No tool calls yet</p>';
        return;
      }

      container.innerHTML = calls.map(call =>
        '<div class="call-item">' +
          '<div>' +
            '<span class="call-tool">' + call.tool.replace('datagovsg_', '').replace('singstat_', '') + '</span>' +
            '<div class="call-client">' + call.userAgent + '</div>' +
          '</div>' +
          '<span class="call-time">' + new Date(call.timestamp).toLocaleTimeString() + '</span>' +
        '</div>'
      ).join('');
    }

    loadData();
    setInterval(loadData, 30000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ============================================================================
// MCP Endpoint
// ============================================================================

// Create Streamable HTTP transport (stateless)
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless transport
});

// MCP endpoint - handles POST (requests), GET (SSE), DELETE (session close)
app.all('/mcp', async (req: Request, res: Response) => {
  try {
    // Track request
    trackRequest(req, '/mcp');

    // Track tool calls from request body
    if (
      req.body &&
      req.body.method === 'tools/call' &&
      req.body.params?.name
    ) {
      trackToolCall(req.body.params.name, req);
    }

    // Log request info
    console.log('Received MCP request:', {
      method: req.method,
      path: req.path,
      mcpMethod: req.body?.method,
    });

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// ============================================================================
// Root endpoint with server info
// ============================================================================
app.get('/', (req: Request, res: Response) => {
  trackRequest(req, '/');
  res.json({
    name: 'Singapore Data MCP Server',
    version: '1.0.0',
    description:
      "MCP server for Singapore's data.gov.sg and SingStat APIs",
    transport: 'streamable-http',
    endpoints: {
      mcp: '/mcp',
      health: '/health',
      analytics: '/analytics',
      analyticsTools: '/analytics/tools',
      analyticsDashboard: '/analytics/dashboard',
    },
    documentation: 'https://github.com/hithereiamaliff/mcp-datagovsg',
  });
});

// ============================================================================
// Start Server
// ============================================================================
mcpServer.server
  .connect(transport)
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log('='.repeat(60));
      console.log('Singapore Data MCP Server (Streamable HTTP)');
      console.log('='.repeat(60));
      console.log(`Server running on http://${HOST}:${PORT}`);
      console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
      console.log(`Health check: http://${HOST}:${PORT}/health`);
      console.log(
        `Analytics dashboard: http://${HOST}:${PORT}/analytics/dashboard`
      );
      console.log('='.repeat(60));
      console.log('');
      console.log('Test with MCP Inspector:');
      console.log('  npx @modelcontextprotocol/inspector');
      console.log(
        `  Select "Streamable HTTP" and enter: http://localhost:${PORT}/mcp`
      );
      console.log('');
    });
  })
  .catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
