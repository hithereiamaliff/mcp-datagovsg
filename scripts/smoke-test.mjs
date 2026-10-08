#!/usr/bin/env node
/**
 * Smoke test: calls every tool once against the live upstream APIs.
 *
 * Usage:
 *   npm run dev                                   # in another terminal
 *   npm run smoke                                 # defaults to http://localhost:8080/mcp
 *   MCP_URL=https://mcp.techmavie.digital/datagovsg/mcp npm run smoke
 *   MCP_URL=http://localhost:8080/mcp?api_key=usr_xxx npm run smoke
 *
 * Calls are spaced out so anonymous rate limits are not exceeded.
 * Each case may include a check(result) that returns an error string when the
 * content is wrong (a call that "succeeds" with empty data still fails).
 */

const MCP_URL = process.env.MCP_URL || 'http://localhost:8080/mcp';
const DELAY_MS = parseInt(process.env.SMOKE_DELAY_MS || '1500', 10);

const CASES = [
  ['datagovsg_hello', {}],
  ['datagovsg_search_all', { query: 'hdb resale prices', limit: 5 }],
  [
    'datagovsg_search_all',
    { query: 'Woodlands', limit: 8 },
    (r) =>
      r.place_guide?.suggestions?.length >= 4 && r.matches.singstat_tables > 0
        ? null
        : 'place-aware search missing guide or planning-area tables',
  ],
  [
    'datagovsg_search_all',
    { query: 'Marsiling', limit: 5, include_singstat: false },
    (r) => (r.place_guide?.kind === 'estate in Woodlands' ? null : 'estate not detected'),
  ],
  [
    'datagovsg_query_dataset',
    {
      dataset_id: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc',
      filters: { town: 'WOODLANDS' },
      q: { street_name: 'MARSILING' },
      sort: 'month desc',
      limit: 2,
    },
    (r) =>
      r.rows?.length === 2 && !r.columns.some((c) => c.name.startsWith('_') || c.name.startsWith('rank'))
        ? null
        : `internal columns leaked: ${r.columns?.map((c) => c.name)}`,
  ],
  ['datagovsg_search_datasets', { query: 'school', format: 'CSV', limit: 3 }],
  ['datagovsg_search_datasets', { agency: 'National Environment Agency', format: 'GEOJSON', limit: 3 }],
  ['datagovsg_list_collections', { query: 'resale', limit: 3 }],
  ['datagovsg_get_collection', { collection_id: '189' }],
  ['datagovsg_get_dataset_metadata', { dataset_id: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc' }],
  [
    'datagovsg_query_dataset',
    {
      dataset_id: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc',
      filters: { town: 'BISHAN', flat_type: '4 ROOM' },
      sort: 'month desc',
      limit: 3,
    },
    (r) => (r.rows?.length === 3 && Object.keys(r.rows[0]).length >= 5 ? null : 'expected 3 full rows'),
  ],
  [
    'datagovsg_query_dataset',
    { dataset_id: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc', fields: ['month', 'town', 'resale_price'], limit: 3, format: 'csv' },
    (r) => {
      const lines = (r.csv ?? '').split('\n');
      return lines[0] === 'month,town,resale_price' && lines.length === 4 && /^\d{4}-\d{2},.+,\d+$/.test(lines[1])
        ? null
        : `unexpected csv: ${JSON.stringify(r.csv)}`;
    },
  ],
  [
    'datagovsg_query_dataset',
    { dataset_id: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc', fields: 'month,resale_price', sort: 'resale_price desc', limit: 2 },
    (r) =>
      typeof r.rows?.[0]?.resale_price === 'number' && r.rows[0].month
        ? null
        : `fields rows empty or untyped: ${JSON.stringify(r.rows)}`,
  ],
  [
    'datagovsg_get_download_url',
    {
      dataset_id: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc',
      column_names: ['month', 'town', 'resale_price'],
      filters: [{ column_name: 'town', type: 'EQ', value: 'BISHAN' }],
    },
  ],
  ['datagovsg_get_weather_forecast', { period: '2h', area: 'bishan' }],
  ['datagovsg_get_weather_forecast', { period: '24h' }],
  ['datagovsg_get_weather_forecast', { period: '4day' }],
  ['datagovsg_get_weather_readings', { metric: 'temperature', latitude: 1.3521, longitude: 103.8198 }],
  ['datagovsg_get_weather_readings', { metric: 'rainfall' }],
  ['datagovsg_get_air_quality', {}],
  ['datagovsg_get_uv_index', {}],
  ['datagovsg_get_heat_stress', { latitude: 1.3521, longitude: 103.8198 }],
  ['datagovsg_get_lightning', {}],
  ['datagovsg_get_flood_alerts', {}],
  ['datagovsg_get_weather_radar', { range: '240km' }],
  ['datagovsg_get_current_conditions', { area: 'Tampines' }],
  [
    'datagovsg_get_current_conditions',
    { area: 'Orchard' },
    (r) => (r.location?.place && r.location?.forecast_area ? null : 'Orchard not resolved via place lookup'),
  ],
  [
    'datagovsg_get_weather_forecast',
    { period: '2h', area: '560123' },
    (r) => (r.forecast && r.resolved_place ? null : 'postal code not resolved'),
  ],
  ['datagovsg_get_carpark_availability', { latitude: 1.3016, longitude: 103.8547, radius_km: 0.5, limit: 3 }],
  [
    'datagovsg_get_carpark_availability',
    { place: 'Bishan MRT', radius_km: 1, limit: 3 },
    (r) => (r.carparks?.length > 0 && r.resolved_place ? null : 'no carparks near Bishan MRT'),
  ],
  ['datagovsg_get_taxi_availability', { latitude: 1.3016, longitude: 103.8547 }],
  [
    'datagovsg_get_taxi_availability',
    { place: 'Raffles Place' },
    (r) => (typeof r.available_within_radius === 'number' ? null : 'place not used for taxi search'),
  ],
  ['datagovsg_get_traffic_images', { limit: 2 }],
  ['singstat_search_tables', { keyword: 'gdp growth', limit: 3 }],
  ['singstat_get_table_metadata', { resource_id: 'M015721', max_series: 3 }],
  [
    'singstat_get_table_data',
    { resource_id: 'M015721', series: ['1'], time_filter: ['2023', '2024', '2025'] },
    (r) => (Object.keys(r.series?.[0]?.values ?? {}).length === 3 ? null : 'expected 3 yearly values'),
  ],
];

let id = 0;
async function rpc(method, params) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON
  const json = text.startsWith('{')
    ? JSON.parse(text)
    : JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tools = await rpc('tools/list', {});
console.log(`Connected to ${MCP_URL}: ${tools.tools.length} tools\n`);

let failed = 0;
for (const [name, args, check] of CASES) {
  const started = Date.now();
  try {
    const result = await rpc('tools/call', { name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    const ms = Date.now() - started;
    if (result.isError) {
      failed++;
      console.log(`FAIL ${name} (${ms}ms) ${text.slice(0, 300)}`);
    } else {
      const problem = check ? check(JSON.parse(text)) : null;
      if (problem) {
        failed++;
        console.log(`FAIL ${name} (${ms}ms) content check: ${problem}`);
      } else {
        console.log(`ok   ${name} (${ms}ms, ${text.length} chars) ${text.slice(0, 160)}`);
      }
    }
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
  await sleep(DELAY_MS);
}

const covered = new Set(CASES.map(([name]) => name));
const untested = tools.tools.map((t) => t.name).filter((n) => !covered.has(n));
if (untested.length) console.log(`\nNot covered: ${untested.join(', ')}`);
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed > 0 ? 1 : 0);
