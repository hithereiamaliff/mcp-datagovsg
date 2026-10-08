/**
 * MCP Key Service client (https://mcpkeys.techmavie.digital).
 *
 * Users may optionally connect with their own data.gov.sg API key by
 * registering it in the MCP Key Service and adding their usr_... key to the
 * MCP URL. This module exchanges that usr_ key for the stored credentials.
 *
 * Adapted from mcp-ltadatamallsg's key-service client:
 * - Only successful lookups are cached (60s), so revocations apply quickly
 * - Concurrent lookups for the same key share one request
 * - KEY_SERVICE_URL is the FULL resolve URL, e.g.
 *   http://mcp-key-service:8090/internal/resolve (inside Docker network)
 *   https://mcpkeys.techmavie.digital/internal/resolve (public proxy)
 */

export type ResolveResult =
  | { ok: true; apiKey: string }
  | {
      ok: false;
      reason: 'invalid_key' | 'service_unavailable' | 'malformed_response';
      message: string;
    };

const KEY_SERVICE_URL = (process.env.KEY_SERVICE_URL || '').trim();
const KEY_SERVICE_TOKEN = (process.env.KEY_SERVICE_TOKEN || '').trim();
const SERVER_ID = 'datagovsg';

const CACHE_TTL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface CacheEntry {
  apiKey: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ResolveResult>>();

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now >= entry.expiresAt) cache.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

function extractErrorMessage(rawBody: string): string {
  const bodySnippet = rawBody.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!bodySnippet) return '';
  try {
    const parsed = JSON.parse(rawBody) as { error?: string; message?: string };
    return parsed.error || parsed.message || bodySnippet;
  } catch {
    return bodySnippet;
  }
}

/** True when KEY_SERVICE_URL and KEY_SERVICE_TOKEN are both configured. */
export function isKeyServiceEnabled(): boolean {
  return Boolean(KEY_SERVICE_URL && KEY_SERVICE_TOKEN);
}

/** usr_ followed by 32 hex characters (format issued by the key service). */
export function looksLikeUserKey(value: string): boolean {
  return /^usr_[a-f0-9]{16,64}$/i.test(value);
}

/**
 * Resolve a usr_... key to the user's data.gov.sg API key.
 * `apiKey` may be an empty string when the user registered without a key.
 *
 * Key service status mapping:
 * - 401            -> invalid_key (bad, revoked or suspended key)
 * - 400/403/5xx    -> service_unavailable (server-side misconfiguration)
 * - 200 valid:true -> ok
 */
export async function resolveKeyCredentials(userKey: string): Promise<ResolveResult> {
  const cached = cache.get(userKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { ok: true, apiKey: cached.apiKey };
  }

  const inflight = pending.get(userKey);
  if (inflight) return inflight;

  const promise = doResolve(userKey);
  pending.set(userKey, promise);
  try {
    return await promise;
  } finally {
    pending.delete(userKey);
  }
}

async function doResolve(userKey: string): Promise<ResolveResult> {
  const shortKey = userKey.substring(0, 12);

  if (!isKeyServiceEnabled()) {
    return { ok: false, reason: 'service_unavailable', message: 'Key service not configured' };
  }

  try {
    const res = await fetch(KEY_SERVICE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: userKey, server_id: SERVER_ID }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!res.ok) {
      let rawBody = '';
      try {
        rawBody = await res.text();
      } catch {
        rawBody = '';
      }
      const errorMessage = extractErrorMessage(rawBody);

      if (res.status === 401 && isJson) {
        return {
          ok: false,
          reason: 'invalid_key',
          message: errorMessage || 'Invalid, revoked, or suspended API key',
        };
      }

      console.error(
        `[key-service] Returned ${res.status} (${contentType || 'unknown'}) for key ${shortKey}...` +
          (errorMessage ? ` Body: ${errorMessage}` : '')
      );
      return {
        ok: false,
        reason: 'service_unavailable',
        message: errorMessage || `Key service returned status ${res.status}`,
      };
    }

    if (!isJson) {
      console.error(`[key-service] Non-JSON success response for key ${shortKey}...`);
      return {
        ok: false,
        reason: 'malformed_response',
        message: 'Key service returned non-JSON response',
      };
    }

    const data = (await res.json()) as { valid?: boolean; credentials?: Record<string, unknown> };
    if (!data.valid) {
      return { ok: false, reason: 'invalid_key', message: 'Key service reported key as invalid' };
    }

    // Connector field is "apiKey"; it is optional, so it may be missing/empty
    const apiKey =
      typeof data.credentials?.apiKey === 'string' ? data.credentials.apiKey.trim() : '';
    cache.set(userKey, { apiKey, expiresAt: Date.now() + CACHE_TTL_MS });
    return { ok: true, apiKey };
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      console.error(`[key-service] Request timed out for key ${shortKey}...`);
    } else {
      console.error(`[key-service] Request failed for key ${shortKey}...:`, error);
    }
    return { ok: false, reason: 'service_unavailable', message: 'Key service unreachable' };
  }
}
