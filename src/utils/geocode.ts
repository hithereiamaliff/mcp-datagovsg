/**
 * Place lookup (geocoding) via OneMap, Singapore Land Authority's map API.
 *
 * Turns place names, landmarks, addresses and 6-digit postal codes
 * ("Orchard", "Jewel Changi", "560123") into coordinates, so location-aware
 * tools are not limited to NEA's 47 forecast areas.
 *
 * - The OneMap search endpoint needs no token but rate-limits bursts hard,
 *   so calls are paced at ~1 per second and results cached for 7 days.
 */

import axios from 'axios';
import { z } from 'zod';
import { USER_AGENT } from '../config.js';
import { apiCache } from './cache.js';
import { isInSingapore, LatLng } from './geo.js';
import { UpstreamError } from './http-client.js';
import { SlidingWindowLimiter } from './rate-limiter.js';
import { tokenize } from './search.js';

const ONEMAP_SEARCH_URL = 'https://www.onemap.gov.sg/api/common/elastic/search';
const GEOCODE_TTL_MS = 7 * 24 * 60 * 60_000;
const onemapLimiter = new SlidingWindowLimiter(1100);

export interface ResolvedPlace extends LatLng {
  query: string;
  name: string;
  address?: string;
  postal_code?: string;
  source: 'OneMap (SLA)';
}

/** Shared input schema for tools that accept a place instead of coordinates. */
export const PLACE_INPUT = z
  .string()
  .min(2)
  .optional()
  .describe(
    'Place in Singapore: landmark, MRT station, building, road or 6-digit postal code, e.g. "Orchard", "Jewel Changi", "560123". Alternative to latitude/longitude.'
  );

interface OneMapResult {
  SEARCHVAL?: string;
  ADDRESS?: string;
  POSTAL?: string;
  LATITUDE?: string;
  LONGITUDE?: string;
}

/** Look up a place; returns null when OneMap finds nothing in Singapore. */
export async function geocodePlace(query: string): Promise<ResolvedPlace | null> {
  const q = query.trim();
  if (!q) return null;

  return apiCache.getOrLoad(`geocode:${q.toLowerCase()}`, GEOCODE_TTL_MS, async () => {
    await onemapLimiter.acquire('onemap', 1, 8000);
    let response;
    try {
      response = await axios.get(ONEMAP_SEARCH_URL, {
        params: { searchVal: q, returnGeom: 'Y', getAddrDetails: 'Y', pageNum: 1 },
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeout: 10_000,
        validateStatus: () => true,
      });
    } catch (error) {
      throw new UpstreamError(
        `Place lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        'GEOCODER_ERROR',
        'Pass latitude/longitude instead.'
      );
    }

    if (response.status === 429) {
      throw new UpstreamError(
        'Place lookup is busy right now',
        429,
        'GEOCODER_BUSY',
        'Retry in a few seconds, or pass latitude/longitude instead.'
      );
    }
    if (response.status >= 400 || typeof response.data !== 'object' || response.data === null) {
      throw new UpstreamError(
        `Place lookup failed (HTTP ${response.status})`,
        response.status,
        'GEOCODER_ERROR'
      );
    }

    const results = (response.data as { results?: OneMapResult[] }).results ?? [];
    const best = pickBestResult(q, results);
    if (!best) return null;
    return {
      latitude: Number(best.LATITUDE),
      longitude: Number(best.LONGITUDE),
      query: q,
      name: best.SEARCHVAL ?? q,
      address: best.ADDRESS,
      postal_code: best.POSTAL && best.POSTAL !== 'NIL' ? best.POSTAL : undefined,
      source: 'OneMap (SLA)' as const,
    };
  });
}

// Words that don't make a result name less specific ("TAMPINES MRT STATION")
const GENERIC_WORDS = new Set(['station', 'singapore', 'the', 'building', 'blk', 'block']);

/**
 * OneMap's own ranking is not always the most natural match: "Tampines MRT"
 * returns Tampines EAST MRT and station exits before Tampines MRT itself.
 * Re-rank its first page so the result whose name is closest to the query
 * wins, keeping OneMap's order as the tie-breaker.
 */
function pickBestResult(query: string, results: OneMapResult[]): OneMapResult | undefined {
  const valid = results.filter((r) => {
    const point = { latitude: Number(r.LATITUDE), longitude: Number(r.LONGITUDE) };
    return Number.isFinite(point.latitude) && isInSingapore(point);
  });
  if (valid.length === 0) return undefined;

  // Postal codes: prefer the exact postal match
  if (/^\d{6}$/.test(query)) return valid.find((r) => r.POSTAL === query) ?? valid[0];

  const queryWords = tokenize(query);
  const wantsExit = queryWords.includes('exit');
  let best: { result: OneMapResult; score: number } | undefined;
  valid.forEach((result, index) => {
    // Drop line codes like "(DT33)" or "(EW2 / DT32)" before comparing
    const nameWords = tokenize((result.SEARCHVAL ?? '').replace(/\([^)]*\)/g, ' '));
    const nameSet = new Set(nameWords);
    const matched = queryWords.filter((w) => nameSet.has(w)).length;
    const extra = nameWords.filter((w) => !queryWords.includes(w) && !GENERIC_WORDS.has(w)).length;
    let score = matched * 10 - extra - index * 0.01;
    if (!wantsExit && nameSet.has('exit')) score -= 5;
    if (!best || score > best.score) best = { result, score };
  });
  return best?.result;
}

/**
 * Work out the search origin from either a place name or coordinates.
 * Returns {} when neither is given.
 */
export async function resolveOrigin(input: {
  place?: string;
  latitude?: number;
  longitude?: number;
}): Promise<{ origin?: LatLng; resolved_place?: ResolvedPlace }> {
  if (input.place?.trim()) {
    const place = await geocodePlace(input.place);
    if (!place) {
      throw new UpstreamError(
        `Could not find "${input.place}" in Singapore`,
        404,
        'PLACE_NOT_FOUND',
        'Try a more specific name, a 6-digit postal code, or latitude/longitude.'
      );
    }
    return { origin: place, resolved_place: place };
  }
  if (input.latitude === undefined && input.longitude === undefined) return {};
  if (input.latitude === undefined || input.longitude === undefined) {
    throw new UpstreamError('Provide both latitude and longitude', 400, 'BAD_LOCATION');
  }
  return { origin: { latitude: input.latitude, longitude: input.longitude } };
}

/** Compact form of a resolved place for tool output. */
export function describePlace(place?: ResolvedPlace) {
  if (!place) return undefined;
  return {
    query: place.query,
    matched: place.name,
    address: place.address,
    latitude: place.latitude,
    longitude: place.longitude,
    source: place.source,
  };
}
