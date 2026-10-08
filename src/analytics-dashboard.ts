/**
 * HTML for /analytics/dashboard (Chart.js, auto-refreshes every 30s).
 * Same layout as the other TechMavie MCP dashboards.
 */

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Singapore Open Data MCP - Analytics</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .header h1 { font-size: 1.8rem; color: #60a5fa; }
    .header p { color: #94a3b8; margin-top: 5px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: #1e293b; border-radius: 12px; padding: 20px; text-align: center; }
    .stat-card .value { font-size: 1.8rem; font-weight: 700; color: #60a5fa; word-break: break-word; }
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
    <h1>Singapore Open Data MCP</h1>
    <p id="uptime">Loading...</p>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value" id="totalRequests">-</div><div class="label">Total Requests</div></div>
    <div class="stat-card"><div class="value" id="totalToolCalls">-</div><div class="label">Tool Calls</div></div>
    <div class="stat-card"><div class="value" id="uniqueClients">-</div><div class="label">Unique Clients</div></div>
    <div class="stat-card"><div class="value" id="keyed">-</div><div class="label">Own-key Requests</div></div>
    <div class="stat-card"><div class="value" id="topTool">-</div><div class="label">Top Tool</div></div>
  </div>

  <div class="charts">
    <div class="chart-card"><h3>Tool Usage Distribution</h3><div class="chart-container"><canvas id="toolChart"></canvas></div></div>
    <div class="chart-card"><h3>Hourly Requests (Last 24h, UTC)</h3><div class="chart-container"><canvas id="hourlyChart"></canvas></div></div>
    <div class="chart-card"><h3>Requests by Endpoint</h3><div class="chart-container"><canvas id="endpointChart"></canvas></div></div>
    <div class="chart-card"><h3>Top Clients (User Agent)</h3><div class="chart-container"><canvas id="clientChart"></canvas></div></div>
  </div>

  <div class="recent-calls">
    <h3>Recent Tool Calls</h3>
    <div id="recentCalls">Loading...</div>
  </div>

  <button class="refresh-btn" onclick="loadData()">&#x1f504;</button>

  <script>
    let charts = {};
    const colors = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#38bdf8', '#c084fc', '#4ade80', '#facc15', '#fb923c'];
    const short = (name) => name.replace(/^datagovsg_/, '').replace(/^singstat_/, 'singstat:');
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function draw(id, config) {
      if (charts[id]) charts[id].destroy();
      charts[id] = new Chart(document.getElementById(id), config);
    }

    const axes = {
      x: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: { ticks: { color: '#71717a' }, grid: { color: 'rgba(255,255,255,0.05)' } },
    };

    async function loadData() {
      try {
        const basePath = window.location.pathname.replace(/\\/analytics\\/dashboard\\/?$/, '');
        const res = await fetch(basePath + '/analytics');
        const data = await res.json();

        const cache = data.cache ? ' | Cache hit rate: ' + Math.round(data.cache.hitRate * 100) + '%' : '';
        document.getElementById('uptime').textContent = 'Uptime: ' + data.uptime + cache;
        document.getElementById('totalRequests').textContent = data.summary.totalRequests.toLocaleString();
        document.getElementById('totalToolCalls').textContent = data.summary.totalToolCalls.toLocaleString();
        document.getElementById('uniqueClients').textContent = data.summary.uniqueClients.toLocaleString();
        document.getElementById('keyed').textContent = (data.summary.keyServiceRequests || 0).toLocaleString();
        const tools = Object.entries(data.breakdown.byTool);
        document.getElementById('topTool').textContent = tools.length > 0 ? short(tools[0][0]) : '-';

        draw('toolChart', {
          type: 'doughnut',
          data: { labels: tools.map(([t]) => short(t)), datasets: [{ data: tools.map(([, v]) => v), backgroundColor: colors, borderWidth: 0 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#a1a1aa' } } } },
        });
        draw('hourlyChart', {
          type: 'line',
          data: {
            labels: Object.keys(data.hourlyRequests).map((h) => h.substring(11) + ':00'),
            datasets: [{ label: 'Requests', data: Object.values(data.hourlyRequests), borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.1)', fill: true, tension: 0.4 }],
          },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes },
        });
        draw('endpointChart', {
          type: 'bar',
          data: { labels: Object.keys(data.breakdown.byEndpoint), datasets: [{ data: Object.values(data.breakdown.byEndpoint), backgroundColor: colors, borderRadius: 4 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes },
        });
        const clients = Object.entries(data.clients.byUserAgent).slice(0, 5);
        draw('clientChart', {
          type: 'bar',
          data: { labels: clients.map(([k]) => k.substring(0, 30)), datasets: [{ data: clients.map(([, v]) => v), backgroundColor: colors, borderRadius: 4 }] },
          options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes },
        });

        const container = document.getElementById('recentCalls');
        const calls = data.recentToolCalls || [];
        container.innerHTML = calls.length === 0
          ? '<p style="color: #71717a;">No tool calls yet</p>'
          : calls.map((call) =>
              '<div class="call-item"><div><span class="call-tool">' + escapeHtml(short(call.tool)) + '</span>' +
              '<div class="call-client">' + escapeHtml(call.userAgent) + (call.auth === 'user_key' ? ' &middot; own key' : '') + '</div></div>' +
              '<span class="call-time">' + new Date(call.timestamp).toLocaleTimeString() + '</span></div>'
            ).join('');
      } catch (err) {
        console.error('Failed to load analytics:', err);
      }
    }

    loadData();
    setInterval(loadData, 30000);
  </script>
</body>
</html>`;
}
