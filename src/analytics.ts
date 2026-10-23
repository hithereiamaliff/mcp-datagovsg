/**
 * Request analytics with local file persistence + Firebase Realtime Database.
 *
 * Same model as the other TechMavie MCP servers (mcp-datagovmy etc.), with
 * privacy fixes: client IPs are never stored, only a salted hash used to
 * count unique clients, and the public /analytics endpoint exposes counts only.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { DATA_DIR } from './config.js';
import { loadAnalyticsFromFirebase, saveAnalyticsToFirebase } from './firebase-analytics.js';

export type AuthMode =
  'anonymous' | 'user_key' | 'user_key_empty' | 'server_fallback' | 'invalid_key';

interface ToolCall {
  tool: string;
  timestamp: string;
  userAgent: string;
  auth: AuthMode;
}

export interface Analytics {
  serverStartTime: string;
  totalRequests: number;
  totalToolCalls: number;
  requestsByMethod: Record<string, number>;
  requestsByEndpoint: Record<string, number>;
  requestsByAuth: Record<string, number>;
  toolCalls: Record<string, number>;
  recentToolCalls: ToolCall[];
  clientsByHash: Record<string, number>;
  clientsByUserAgent: Record<string, number>;
  hourlyRequests: Record<string, number>;
  /** Stamped on every save, so startup can tell which stored copy is newer. */
  lastUpdated?: string;
}

const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const MAX_RECENT_CALLS = 100;
const MAX_HOURLY_KEYS = 24 * 30; // keep 30 days of hourly counts
const SAVE_INTERVAL_MS = 30_000;

// Salt for hashing client IPs. Set ANALYTICS_SALT for unique-client counts
// that stay stable across restarts; otherwise a random per-process salt is used.
const SALT = process.env.ANALYTICS_SALT || crypto.randomBytes(16).toString('hex');

const freshAnalytics = (): Analytics => ({
  serverStartTime: new Date().toISOString(),
  totalRequests: 0,
  totalToolCalls: 0,
  requestsByMethod: {},
  requestsByEndpoint: {},
  requestsByAuth: {},
  toolCalls: {},
  recentToolCalls: [],
  clientsByHash: {},
  clientsByUserAgent: {},
  hourlyRequests: {},
});

/** Fill in defaults (Firebase drops empty objects) and drop legacy raw-IP data. */
function normalise(data: Partial<Analytics> & Record<string, unknown>): Analytics {
  const base = freshAnalytics();
  const { clientsByIp: _legacyIps, ...rest } = data;
  return {
    ...base,
    ...rest,
    requestsByMethod: data.requestsByMethod || {},
    requestsByEndpoint: data.requestsByEndpoint || {},
    requestsByAuth: data.requestsByAuth || {},
    toolCalls: data.toolCalls || {},
    recentToolCalls: Array.isArray(data.recentToolCalls) ? data.recentToolCalls : [],
    clientsByHash: data.clientsByHash || {},
    clientsByUserAgent: data.clientsByUserAgent || {},
    hourlyRequests: data.hourlyRequests || {},
  };
}

let analytics: Analytics = freshAnalytics();
// Set once the stored copies are loaded; saves wait for it (see saveAnalytics)
let initialised = false;

// ============================================================================
// Persistence
// ============================================================================

/** Milliseconds for an ISO timestamp; 0 (oldest) when missing or invalid. */
function timeOf(value: unknown): number {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? 0 : time;
}

const savedAtLabel = (time: number) =>
  time > 0 ? `saved ${new Date(time).toISOString()}` : 'save time unknown';

function loadAnalyticsFromFile(): { data: Record<string, unknown>; savedAt: number } | null {
  try {
    if (!fs.existsSync(ANALYTICS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf-8'));
    // Files saved before lastUpdated was stamped locally carry a stale value copied
    // from Firebase, so also use the file's mtime and take the later of the two
    const savedAt = Math.max(timeOf(data.lastUpdated), fs.statSync(ANALYTICS_FILE).mtimeMs);
    return { data, savedAt };
  } catch (error) {
    console.error('[analytics] Failed to load from file:', error);
    return null;
  }
}

/**
 * Load the newer of the local file and the Firebase copy. Either can be stale:
 * Firebase after it was unavailable for a while (local saves carried on), the
 * local file after the data volume was replaced.
 */
async function loadAnalytics(): Promise<Analytics> {
  const fromFirebase = await loadAnalyticsFromFirebase();
  const fromFile = loadAnalyticsFromFile();
  const firebaseSavedAt = timeOf(fromFirebase?.lastUpdated);

  // Ties go to the local file: it is the exact JSON, without Firebase's key encoding
  if (fromFile && (!fromFirebase || fromFile.savedAt >= firebaseSavedAt)) {
    const other = fromFirebase
      ? `Firebase copy ${savedAtLabel(firebaseSavedAt)}`
      : 'no Firebase copy';
    console.log(
      `[analytics] Loaded from ${ANALYTICS_FILE} (${savedAtLabel(fromFile.savedAt)}; ${other})`
    );
    return normalise(fromFile.data);
  }
  if (fromFirebase) {
    const other = fromFile ? `local file ${savedAtLabel(fromFile.savedAt)}` : 'no local copy';
    console.log(`[analytics] Loaded from Firebase (${savedAtLabel(firebaseSavedAt)}; ${other})`);
    return normalise(fromFirebase);
  }
  console.log('[analytics] Starting fresh');
  return freshAnalytics();
}

function pruneHourly(): void {
  const keys = Object.keys(analytics.hourlyRequests).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_HOURLY_KEYS))) {
    delete analytics.hourlyRequests[key];
  }
}

export async function saveAnalytics(): Promise<void> {
  // Saving before the stored copies are loaded would overwrite them with near-empty
  // counts, and that copy would then look newest at the next startup
  if (!initialised) return;
  pruneHourly();
  // One stamp for both copies, so loadAnalytics() can tell which is newer
  analytics.lastUpdated = new Date().toISOString();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics));
  } catch (error) {
    console.error('[analytics] Failed to save locally:', error);
  }
  await saveAnalyticsToFirebase(analytics as unknown as Record<string, unknown>);
}

/** Load persisted analytics (merging anything tracked during startup). */
export async function initAnalytics(): Promise<void> {
  const startupCounts = analytics;
  const loaded = await loadAnalytics();
  analytics = loaded;
  // Requests tracked while loading are added on top
  analytics.totalRequests += startupCounts.totalRequests;
  analytics.totalToolCalls += startupCounts.totalToolCalls;
  initialised = true;
  console.log('[analytics] Initialised:', {
    totalRequests: analytics.totalRequests,
    totalToolCalls: analytics.totalToolCalls,
  });
  const timer = setInterval(() => {
    saveAnalytics().catch((error) => console.error('[analytics] Periodic save failed:', error));
  }, SAVE_INTERVAL_MS);
  timer.unref?.();
}

// ============================================================================
// Tracking
// ============================================================================

const inc = (record: Record<string, number>, key: string, by = 1) => {
  record[key] = (record[key] || 0) + by;
};

function clientHash(req: Request): string {
  const ip = req.ip || 'unknown';
  return crypto.createHmac('sha256', SALT).update(ip).digest('hex').slice(0, 12);
}

const userAgentOf = (req: Request) => (req.headers['user-agent'] || 'unknown').substring(0, 50);

export function trackRequest(req: Request, endpoint: string): void {
  analytics.totalRequests++;
  inc(analytics.requestsByMethod, req.method);
  inc(analytics.requestsByEndpoint, endpoint);
  inc(analytics.clientsByHash, clientHash(req));
  inc(analytics.clientsByUserAgent, userAgentOf(req));
  inc(analytics.hourlyRequests, new Date().toISOString().substring(0, 13));
}

export function trackAuth(mode: AuthMode): void {
  inc(analytics.requestsByAuth, mode);
}

/** Count tools/call requests in a JSON-RPC body (single or batch). */
export function trackToolCalls(body: unknown, req: Request, auth: AuthMode): void {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const msg = message as { method?: string; params?: { name?: string } } | undefined;
    if (msg?.method !== 'tools/call' || !msg.params?.name) continue;
    analytics.totalToolCalls++;
    inc(analytics.toolCalls, msg.params.name);
    analytics.recentToolCalls.unshift({
      tool: msg.params.name,
      timestamp: new Date().toISOString(),
      userAgent: userAgentOf(req),
      auth,
    });
    if (analytics.recentToolCalls.length > MAX_RECENT_CALLS)
      analytics.recentToolCalls.length = MAX_RECENT_CALLS;
  }
}

// ============================================================================
// Reporting
// ============================================================================

function uptime(): string {
  const diff = Date.now() - new Date(analytics.serverStartTime).getTime();
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const sortDesc = (record: Record<string, number>) =>
  Object.fromEntries(Object.entries(record).sort(([, a], [, b]) => b - a));

export function getAnalyticsSummary(extra: Record<string, unknown> = {}) {
  const last24h: Record<string, number> = {};
  const now = Date.now();
  for (let i = 23; i >= 0; i--) {
    const key = new Date(now - i * 3_600_000).toISOString().substring(0, 13);
    last24h[key] = analytics.hourlyRequests[key] || 0;
  }
  const keyed =
    (analytics.requestsByAuth.user_key || 0) + (analytics.requestsByAuth.user_key_empty || 0);

  return {
    uptime: uptime(),
    summary: {
      totalRequests: analytics.totalRequests,
      totalToolCalls: analytics.totalToolCalls,
      uniqueClients: Object.keys(analytics.clientsByHash).length,
      keyServiceRequests: keyed,
      serverStartTime: analytics.serverStartTime,
    },
    breakdown: {
      byMethod: analytics.requestsByMethod,
      byEndpoint: sortDesc(analytics.requestsByEndpoint),
      byAuth: analytics.requestsByAuth,
      byTool: sortDesc(analytics.toolCalls),
    },
    hourlyRequests: last24h,
    clients: { byUserAgent: sortDesc(analytics.clientsByUserAgent) },
    recentToolCalls: analytics.recentToolCalls.slice(0, 20),
    ...extra,
  };
}

export function getToolStats() {
  const total = analytics.totalToolCalls;
  return {
    totalToolCalls: total,
    tools: Object.entries(analytics.toolCalls)
      .sort(([, a], [, b]) => b - a)
      .map(([name, calls]) => ({
        name,
        calls,
        percentage: total > 0 ? ((calls / total) * 100).toFixed(1) : '0',
      })),
    recentCalls: analytics.recentToolCalls.slice(0, 50),
  };
}

export async function resetAnalytics(): Promise<void> {
  analytics = freshAnalytics();
  await saveAnalytics();
}

/** Merge an exported analytics blob into the current counts. */
export async function importAnalytics(data: Partial<Analytics>): Promise<void> {
  const incoming = normalise(data as Partial<Analytics> & Record<string, unknown>);
  const merge = (a: Record<string, number>, b: Record<string, number>) => {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = (out[key] || 0) + value;
    return out;
  };
  analytics = {
    ...analytics,
    totalRequests: analytics.totalRequests + incoming.totalRequests,
    totalToolCalls: analytics.totalToolCalls + incoming.totalToolCalls,
    requestsByMethod: merge(analytics.requestsByMethod, incoming.requestsByMethod),
    requestsByEndpoint: merge(analytics.requestsByEndpoint, incoming.requestsByEndpoint),
    requestsByAuth: merge(analytics.requestsByAuth, incoming.requestsByAuth),
    toolCalls: merge(analytics.toolCalls, incoming.toolCalls),
    clientsByHash: merge(analytics.clientsByHash, incoming.clientsByHash),
    clientsByUserAgent: merge(analytics.clientsByUserAgent, incoming.clientsByUserAgent),
    hourlyRequests: merge(analytics.hourlyRequests, incoming.hourlyRequests),
  };
  await saveAnalytics();
}
