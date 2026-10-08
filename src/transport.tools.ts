/**
 * Transport real-time tools (data.gov.sg v1 transport APIs):
 * HDB carpark availability, taxi availability and traffic camera images.
 *
 * Carpark availability only carries carpark numbers, so we join it with the
 * "HDB Carpark Information" dataset (addresses + SVY21 coordinates, cached
 * for 24h) to support searching by address or location.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { API_BASES, CACHE_TTL, DATAGOVSG_SOURCE } from './config.js';
import { apiCache } from './utils/cache.js';
import { parseNum, toList } from './utils/format.js';
import { LatLng, sortByDistance, svy21ToWgs84 } from './utils/geo.js';
import { ApiAuth, apiGet, unwrapCkan, unwrapPlain, UpstreamError } from './utils/http-client.js';
import { tokenize } from './utils/search.js';
import { datagovsgTool, registerReadOnlyTool, ToolContext } from './utils/tool-helpers.js';

const HDB_CARPARK_INFO_DATASET = 'd_23f946fa557947f93a8043bbef41dd09';

// ============================================================================
// Types
// ============================================================================

interface CarparkAvailabilityData {
  items: {
    timestamp: string;
    carpark_data: {
      carpark_number: string;
      update_datetime: string;
      carpark_info: { total_lots: string; lot_type: string; lots_available: string }[];
    }[];
  }[];
}

interface CarparkInfo {
  carpark_number: string;
  address: string;
  latitude?: number;
  longitude?: number;
  type?: string;
  parking_system?: string;
  short_term_parking?: string;
  free_parking?: string;
  night_parking?: string;
  decks?: number;
  gantry_height_m?: number;
  basement?: string;
}

interface TaxiData {
  features: {
    geometry: { coordinates: [number, number][] };
    properties: { timestamp: string; taxi_count: number };
  }[];
}

interface TrafficImagesData {
  items: {
    timestamp: string;
    cameras: {
      timestamp: string;
      image: string;
      location: { latitude: number; longitude: number };
      camera_id: string;
      image_metadata?: { height: number; width: number };
    }[];
  }[];
}

// ============================================================================
// Helpers
// ============================================================================

const DATE_TIME_INPUT = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Use YYYY-MM-DDTHH:mm:ss')
  .optional()
  .describe('Singapore time "YYYY-MM-DDTHH:mm:ss" for a past snapshot. Omit for the latest data.');

const LATITUDE = z
  .number()
  .min(1.1)
  .max(1.5)
  .optional()
  .describe('Latitude in Singapore, e.g. 1.3521');
const LONGITUDE = z
  .number()
  .min(103.5)
  .max(104.2)
  .optional()
  .describe('Longitude in Singapore, e.g. 103.8198');

const LOT_TYPES: Record<string, string> = {
  C: 'car',
  H: 'heavy_vehicle',
  Y: 'motorcycle',
  L: 'lorry',
};

function normaliseDateTime(value?: string): string | undefined {
  if (!value) return undefined;
  return /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

function originFrom(latitude?: number, longitude?: number): LatLng | undefined {
  if (latitude === undefined && longitude === undefined) return undefined;
  if (latitude === undefined || longitude === undefined) {
    throw new UpstreamError('Provide both latitude and longitude', 400, 'BAD_LOCATION');
  }
  return { latitude, longitude };
}

async function fetchTransport<T>(auth: ApiAuth, path: string, dateTime?: string): Promise<T> {
  const date_time = normaliseDateTime(dateTime);
  return apiGet<T>({
    category: 'transport',
    url: `${API_BASES.transport}/${path}`,
    params: { date_time },
    ttlMs: date_time ? CACHE_TTL.realtimeHistorical : CACHE_TTL.transport,
    auth,
    unwrap: unwrapPlain,
  });
}

/** HDB carpark static info keyed by carpark number (cached 24h). */
async function getCarparkInfo(auth: ApiAuth): Promise<Map<string, CarparkInfo>> {
  return apiCache.getOrLoad('hdb-carpark-info', CACHE_TTL.carparkInfo, async () => {
    const result = await apiGet<{ records: Record<string, string>[] }>({
      category: 'datastore',
      url: `${API_BASES.datastore}/datastore_search`,
      params: { resource_id: HDB_CARPARK_INFO_DATASET, limit: 5000 },
      ttlMs: 0,
      auth,
      unwrap: unwrapCkan,
    });
    const map = new Map<string, CarparkInfo>();
    for (const row of result.records) {
      const x = parseNum(row.x_coord);
      const y = parseNum(row.y_coord);
      const coords = x !== undefined && y !== undefined ? svy21ToWgs84(y, x) : undefined;
      map.set(row.car_park_no, {
        carpark_number: row.car_park_no,
        address: row.address,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
        type: row.car_park_type,
        parking_system: row.type_of_parking_system,
        short_term_parking: row.short_term_parking,
        free_parking: row.free_parking,
        night_parking: row.night_parking,
        decks: parseNum(row.car_park_decks),
        gantry_height_m: parseNum(row.gantry_height),
        basement: row.car_park_basement,
      });
    }
    return map;
  });
}

// ============================================================================
// Tools
// ============================================================================

export function registerTransportTools(server: McpServer, ctx: ToolContext) {
  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_carpark_availability'),
    {
      title: 'Get HDB carpark availability',
      description:
        'Get live available lots at HDB carparks (~2,000 carparks, updated every minute), with address, coordinates, parking system, free/night parking and gantry height. Find carparks near a latitude/longitude, by address/street/block (e.g. "Ang Mo Kio Ave 3", "Blk 270"), or by carpark number. Only HDB carparks are covered (not malls/private).',
      inputSchema: {
        latitude: LATITUDE,
        longitude: LONGITUDE,
        radius_km: z
          .number()
          .min(0.1)
          .max(5)
          .optional()
          .describe('Search radius around latitude/longitude (default 0.5 km)'),
        address: z
          .string()
          .optional()
          .describe('Words that must all appear in the address, e.g. "bishan st 22"'),
        carpark_numbers: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe('HDB carpark numbers, e.g. ["ACB", "BE3"]'),
        lot_type: z
          .enum(['car', 'motorcycle', 'heavy_vehicle'])
          .optional()
          .describe('Lot type used for min_available and sorting (default car)'),
        min_available: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only carparks with at least this many free lots'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max carparks to return (default 10)'),
        date_time: DATE_TIME_INPUT,
      },
      errorContext: 'Failed to get carpark availability',
    },
    async ({
      latitude,
      longitude,
      radius_km = 0.5,
      address,
      carpark_numbers,
      lot_type = 'car',
      min_available,
      limit = 10,
      date_time,
    }) => {
      const [availability, info] = await Promise.all([
        fetchTransport<CarparkAvailabilityData>(ctx.auth, 'carpark-availability', date_time),
        getCarparkInfo(ctx.auth),
      ]);
      const item = availability.items?.[0];
      if (!item) return { message: 'No carpark availability data for that time' };

      let carparks = item.carpark_data.map((cp) => {
        const lots: Record<string, { available: number; total: number }> = {};
        for (const lot of cp.carpark_info) {
          const key = LOT_TYPES[lot.lot_type] ?? lot.lot_type;
          lots[key] = {
            available: parseNum(lot.lots_available) ?? 0,
            total: parseNum(lot.total_lots) ?? 0,
          };
        }
        const meta = info.get(cp.carpark_number);
        return {
          carpark_number: cp.carpark_number,
          address: meta?.address,
          latitude: meta?.latitude,
          longitude: meta?.longitude,
          lots,
          updated: cp.update_datetime,
          type: meta?.type,
          parking_system: meta?.parking_system,
          free_parking: meta?.free_parking,
          night_parking: meta?.night_parking,
          short_term_parking: meta?.short_term_parking,
          gantry_height_m: meta?.gantry_height_m,
        };
      });

      const totalCarparks = carparks.length;
      const totalAvailable = carparks.reduce(
        (sum, cp) => sum + (cp.lots[lot_type]?.available ?? 0),
        0
      );
      const numbers = toList(carpark_numbers)?.map((n) => n.toUpperCase());
      const origin = originFrom(latitude, longitude);
      const hasFilter = Boolean(numbers || address || origin);

      if (numbers)
        carparks = carparks.filter((cp) => numbers.includes(cp.carpark_number.toUpperCase()));
      if (address) {
        const words = tokenize(address);
        carparks = carparks.filter((cp) => {
          const haystack = new Set(tokenize(cp.address ?? ''));
          const text = (cp.address ?? '').toLowerCase();
          return words.every((w) => haystack.has(w) || text.includes(w));
        });
      }
      if (min_available !== undefined) {
        carparks = carparks.filter((cp) => (cp.lots[lot_type]?.available ?? 0) >= min_available);
      }

      let results: Array<(typeof carparks)[number] & { distance_km?: number }>;
      if (origin) {
        results = sortByDistance(
          carparks,
          origin,
          (cp) =>
            cp.latitude !== undefined && cp.longitude !== undefined
              ? { latitude: cp.latitude, longitude: cp.longitude }
              : undefined,
          radius_km
        );
      } else {
        results = [...carparks].sort(
          (a, b) => (b.lots[lot_type]?.available ?? 0) - (a.lots[lot_type]?.available ?? 0)
        );
      }

      return {
        timestamp: item.timestamp,
        singapore_summary: {
          carparks: totalCarparks,
          [`available_${lot_type}_lots`]: totalAvailable,
        },
        matched: results.length,
        returned: Math.min(limit, results.length),
        carparks: hasFilter ? results.slice(0, limit) : undefined,
        note: !hasFilter
          ? 'Pass latitude/longitude, address or carpark_numbers to list specific carparks.'
          : results.length === 0
            ? origin
              ? `No HDB carparks found within ${radius_km} km. Try a larger radius_km.`
              : 'No carparks matched. Try fewer address words.'
            : undefined,
        source: `HDB via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_taxi_availability'),
    {
      title: 'Get taxi availability',
      description:
        'Get the number of available taxis in Singapore (updated every 30 seconds). With latitude/longitude, also counts available taxis within a radius and lists the nearest ones.',
      inputSchema: {
        latitude: LATITUDE,
        longitude: LONGITUDE,
        radius_km: z
          .number()
          .min(0.1)
          .max(10)
          .optional()
          .describe('Radius around the location (default 1 km)'),
        nearest: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe('Nearest taxis to list (default 5)'),
        date_time: DATE_TIME_INPUT,
      },
      errorContext: 'Failed to get taxi availability',
    },
    async ({ latitude, longitude, radius_km = 1, nearest = 5, date_time }) => {
      const data = await fetchTransport<TaxiData>(ctx.auth, 'taxi-availability', date_time);
      const feature = data.features?.[0];
      if (!feature) return { message: 'No taxi availability data for that time' };
      const origin = originFrom(latitude, longitude);
      const result: Record<string, unknown> = {
        timestamp: feature.properties.timestamp,
        available_taxis_singapore: feature.properties.taxi_count,
      };
      if (origin) {
        const taxis = feature.geometry.coordinates.map(([lng, lat]) => ({
          latitude: lat,
          longitude: lng,
        }));
        const within = sortByDistance(taxis, origin, (t) => t, radius_km);
        result.radius_km = radius_km;
        result.available_within_radius = within.length;
        result.nearest = within.slice(0, nearest);
      }
      result.source = `LTA via ${DATAGOVSG_SOURCE}`;
      return result;
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_traffic_images'),
    {
      title: 'Get traffic camera images',
      description:
        'Get the latest traffic camera snapshots (image URL, location, time). Note: data.gov.sg currently publishes only a handful of cameras (mainly Woodlands and Tuas checkpoint approaches), useful for Causeway/Second Link traffic.',
      inputSchema: {
        camera_ids: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe('Camera IDs to return, e.g. ["2701", "4703"]'),
        latitude: LATITUDE,
        longitude: LONGITUDE,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max cameras to return (default 20)'),
        date_time: DATE_TIME_INPUT,
      },
      errorContext: 'Failed to get traffic images',
    },
    async ({ camera_ids, latitude, longitude, limit = 20, date_time }) => {
      const data = await fetchTransport<TrafficImagesData>(ctx.auth, 'traffic-images', date_time);
      const item = data.items?.[0];
      if (!item) return { message: 'No traffic images for that time' };
      let cameras = item.cameras.map((c) => ({
        camera_id: c.camera_id,
        image_url: c.image,
        captured_at: c.timestamp,
        latitude: c.location.latitude,
        longitude: c.location.longitude,
        resolution: c.image_metadata
          ? `${c.image_metadata.width}x${c.image_metadata.height}`
          : undefined,
      }));
      const ids = toList(camera_ids);
      if (ids) cameras = cameras.filter((c) => ids.includes(c.camera_id));
      const origin = originFrom(latitude, longitude);
      const ordered = origin ? sortByDistance(cameras, origin, (c) => c) : cameras;
      return {
        timestamp: item.timestamp,
        cameras_available: item.cameras.length,
        returned: Math.min(limit, ordered.length),
        cameras: ordered.slice(0, limit),
        source: `LTA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );
}
