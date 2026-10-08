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
    for (const result of results) {
      const point = { latitude: Number(result.LATITUDE), longitude: Number(result.LONGITUDE) };
      if (!Number.isFinite(point.latitude) || !isInSingapore(point)) continue;
      return {
        ...point,
        query: q,
        name: result.SEARCHVAL ?? q,
        address: result.ADDRESS,
        postal_code: result.POSTAL && result.POSTAL !== 'NIL' ? result.POSTAL : undefined,
        source: 'OneMap (SLA)' as const,
      };
    }
    return null;
  });
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
