/**
 * Shared HTTP client for every upstream call.
 *
 * Responsibilities:
 * - Send a descriptive User-Agent (SingStat returns HTML when it is empty)
 * - Attach `x-api-key` to data.gov.sg calls when a key is available
 * - Pace requests under data.gov.sg rate limits (see rate-limiter.ts)
 * - Retry once after an HTTP 429 (data.gov.sg sends no Retry-After header)
 * - Cache successful responses (see cache.ts)
 * - Turn the different upstream error formats into one UpstreamError type
 *
 * axios is used instead of fetch because the data.gov.sg download API expects
 * a JSON body on a GET request, which Node's built-in fetch refuses to send.
 */

import axios from 'axios';
import crypto from 'crypto';
import {
  DATAGOVSG_API_KEY,
  DATAGOVSG_API_KEY_TIER,
  HTTP_TIMEOUT_MS,
  KeyTier,
  RATE_LIMITS,
  RateCategory,
  USER_AGENT,
} from '../config.js';
import { apiCache } from './cache.js';
import { limiter, RateLimitError } from './rate-limiter.js';

// ============================================================================
// Auth context (which data.gov.sg key a request uses)
// ============================================================================

export type KeySource = 'user' | 'server' | 'none';

export interface ApiAuth {
  apiKey?: string;
  /** user = resolved from the MCP Key Service; server = operator's key; none = anonymous */
  source: KeySource;
  tier: KeyTier;
}

/**
 * Pick the data.gov.sg key for a request: the caller's own key if they have
 * one, otherwise the operator's DATAGOVSG_API_KEY, otherwise anonymous.
 */
export function resolveAuth(userApiKey?: string): ApiAuth {
  const userKey = userApiKey?.trim();
  if (userKey) {
    // We cannot tell a user's key tier, so pace conservatively as "developer"
    return { apiKey: userKey, source: 'user', tier: 'developer' };
  }
  if (DATAGOVSG_API_KEY) {
    return { apiKey: DATAGOVSG_API_KEY, source: 'server', tier: DATAGOVSG_API_KEY_TIER };
  }
  return { source: 'none', tier: 'anonymous' };
}

function keyIdentity(apiKey?: string): string {
  if (!apiKey) return 'anon';
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

// ============================================================================
// Errors
// ============================================================================

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string | number,
    public readonly hint?: string
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export { RateLimitError };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const snippet = (value: unknown): string =>
  (typeof value === 'string' ? value : JSON.stringify(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/** data.gov.sg platform format: { code: 0, data, errorMsg } */
export function unwrapOgp<T>(body: unknown, status: number): T {
  if (isObject(body) && 'code' in body) {
    if (body.code === 0 && status < 400 && body.data !== null && body.data !== undefined) {
      return body.data as T;
    }
    const message =
      (typeof body.errorMsg === 'string' && body.errorMsg) ||
      (typeof body.name === 'string' && body.name) ||
      'data.gov.sg returned an error';
    throw new UpstreamError(message, status, (body.name as string) ?? (body.code as number));
  }
  if (isObject(body) && typeof body.error === 'string') {
    throw new UpstreamError(body.error, status);
  }
  if (status >= 400) {
    throw new UpstreamError(snippet(body) || `HTTP ${status}`, status);
  }
  throw new UpstreamError('Unexpected response format from data.gov.sg', status);
}

/** CKAN datastore format: { success: true, result } */
export function unwrapCkan<T>(body: unknown, status: number): T {
  if (isObject(body) && body.success === true && isObject(body.result)) {
    return body.result as T;
  }
  if (isObject(body) && body.success === false && isObject(body.error)) {
    // e.g. { __type: 'Validation Error', filters: ['invalid value "nope"'] }
    const details = Object.entries(body.error)
      .filter(([key]) => key !== '__type')
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('; ') : String(value)}`)
      .join(' | ');
    throw new UpstreamError(
      `${String(body.error.__type || 'Query error')}${details ? ` (${details})` : ''}`,
      status,
      'VALIDATION_ERROR'
    );
  }
  if (isObject(body) && 'code' in body) return unwrapOgp<T>(body, status);
  if (status === 404) {
    throw new UpstreamError('Dataset not found for row queries', 404, 'NOT_FOUND');
  }
  throw new UpstreamError(
    'This dataset does not support row queries (GeoJSON, XLSX and PDF datasets must be downloaded instead)',
    status,
    'UNSUPPORTED_DATASET'
  );
}

/** v1 transport APIs return the payload directly */
export function unwrapPlain<T>(body: unknown, status: number): T {
  if (status >= 400 || !isObject(body)) {
    if (isObject(body) && 'code' in body) return unwrapOgp<T>(body, status);
    throw new UpstreamError(snippet(body) || `HTTP ${status}`, status);
  }
  return body as T;
}

/** SingStat format: { Data, StatusCode: 200, Message } */
export function unwrapSingstat<T>(body: unknown, status: number): T {
  if (typeof body === 'string') {
    throw new UpstreamError(
      'SingStat returned a web page instead of data (the resource ID may be invalid)',
      status
    );
  }
  if (isObject(body) && body.StatusCode === 200 && body.Data) {
    return body.Data as T;
  }
  const message = isObject(body) && typeof body.Message === 'string' ? body.Message : '';
  throw new UpstreamError(
    message || `SingStat returned status ${isObject(body) ? body.StatusCode : status}`,
    isObject(body) && typeof body.StatusCode === 'number' ? body.StatusCode : status
  );
}

// ============================================================================
// Upstream stats (exposed on /analytics)
// ============================================================================
export const upstreamStats = {
  requests: 0,
  rateLimited429: 0,
  errors: 0,
  localQueueRejections: 0,
};

export function getCacheStats() {
  const total = apiCache.hits + apiCache.misses;
  return {
    entries: apiCache.size,
    hits: apiCache.hits,
    misses: apiCache.misses,
    hitRate: total > 0 ? Number((apiCache.hits / total).toFixed(3)) : 0,
  };
}

// ============================================================================
// Request
// ============================================================================

export interface ApiRequest<T> {
  category: RateCategory;
  url: string;
  params?: Record<string, string | number | boolean | undefined>;
  /** JSON body sent with the GET request (download API only) */
  body?: unknown;
  /** Cache lifetime; 0 disables caching for this call */
  ttlMs: number;
  auth: ApiAuth;
  unwrap: (body: unknown, status: number) => T;
  timeoutMs?: number;
}

function cleanParams(params?: ApiRequest<unknown>['params']) {
  if (!params) return undefined;
  const cleaned: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  return cleaned;
}

function cacheKeyFor(req: ApiRequest<unknown>, params?: Record<string, unknown>): string {
  const sortedParams = params
    ? Object.keys(params)
        .sort()
        .map((key) => `${key}=${String(params[key])}`)
        .join('&')
    : '';
  const body = req.body === undefined ? '' : JSON.stringify(req.body);
  return `${req.url}?${sortedParams}#${body}`;
}

/**
 * GET an upstream URL with caching, rate limiting and error normalisation.
 */
export async function apiGet<T>(req: ApiRequest<T>): Promise<T> {
  const params = cleanParams(req.params);
  const load = () => fetchWithLimits(req, params);
  if (req.ttlMs <= 0) return load();
  return apiCache.getOrLoad(cacheKeyFor(req, params), req.ttlMs, load);
}

async function fetchWithLimits<T>(
  req: ApiRequest<T>,
  params: Record<string, string | number | boolean> | undefined
): Promise<T> {
  const isSingstat = req.category === 'singstat';
  // SingStat limits are per IP and it does not use data.gov.sg keys
  const tier: KeyTier = isSingstat ? 'anonymous' : req.auth.tier;
  const identity = isSingstat ? 'singstat' : keyIdentity(req.auth.apiKey);
  const bucket = `${identity}:${req.category}`;
  const limit = RATE_LIMITS[tier][req.category];

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  if (!isSingstat && req.auth.apiKey) headers['x-api-key'] = req.auth.apiKey;
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await limiter.acquire(bucket, limit);
    } catch (error) {
      upstreamStats.localQueueRejections++;
      throw error;
    }

    upstreamStats.requests++;
    let response;
    try {
      response = await axios.request({
        method: 'GET',
        url: req.url,
        params,
        data: req.body,
        headers,
        timeout: req.timeoutMs ?? HTTP_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      upstreamStats.errors++;
      const message = axios.isAxiosError(error)
        ? error.code === 'ECONNABORTED'
          ? 'Upstream request timed out'
          : error.message
        : String(error);
      throw new UpstreamError(message, undefined, 'NETWORK_ERROR');
    }

    if (response.status === 429) {
      upstreamStats.rateLimited429++;
      limiter.penalise(bucket, limit);
      if (attempt === 0) continue; // next acquire() waits out a full window
      throw new RateLimitError('data.gov.sg rate limit exceeded. Please retry shortly.', 10);
    }

    try {
      return req.unwrap(response.data, response.status);
    } catch (error) {
      upstreamStats.errors++;
      throw error;
    }
  }

  // Only reached if both attempts were rate limited (handled above)
  throw new RateLimitError('data.gov.sg rate limit exceeded. Please retry shortly.', 10);
}
