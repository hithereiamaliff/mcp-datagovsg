/**
 * Real-time weather and environment tools (data.gov.sg v2 real-time APIs).
 *
 * Base: https://api-open.data.gov.sg/v2/real-time/api
 * All endpoints accept `date` (SGT): "YYYY-MM-DD" for a whole day (paginated)
 * or "YYYY-MM-DDTHH:mm:ss" for the reading at that time.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { API_BASES, CACHE_TTL, DATAGOVSG_SOURCE } from './config.js';
import { nowSgt, parseNum, round, summarise } from './utils/format.js';
import { distanceKm, LatLng, sortByDistance } from './utils/geo.js';
import { ApiAuth, apiGet, unwrapOgp, UpstreamError } from './utils/http-client.js';
import { findBestName } from './utils/search.js';
import { datagovsgTool, registerReadOnlyTool, ToolContext } from './utils/tool-helpers.js';

// ============================================================================
// Upstream types
// ============================================================================

interface Station {
  id: string;
  deviceId?: string;
  name: string;
  location: { latitude: number; longitude: number };
}

interface StationReadingsData {
  stations: Station[];
  readings: { timestamp: string; data: { stationId: string; value: number }[] }[];
  readingType?: string;
  readingUnit?: string;
  paginationToken?: string;
}

interface ValidPeriod {
  start: string;
  end: string;
  text: string;
}

interface TwoHourData {
  area_metadata: { name: string; label_location: { latitude: number; longitude: number } }[];
  items: {
    update_timestamp: string;
    timestamp: string;
    valid_period: ValidPeriod;
    forecasts: { area: string; forecast: string }[];
  }[];
  paginationToken?: string;
}

interface Range {
  low: number;
  high: number;
  unit?: string;
}

interface TwentyFourHourData {
  records: {
    date: string;
    updatedTimestamp: string;
    general: {
      validPeriod: ValidPeriod;
      temperature: Range;
      relativeHumidity: Range;
      forecast: { code: string; text: string };
      wind: { speed: Range; direction: string };
    };
    periods: { timePeriod: ValidPeriod; regions: Record<string, { code: string; text: string }> }[];
  }[];
  paginationToken?: string;
}

interface FourDayData {
  records: {
    date: string;
    updatedTimestamp: string;
    forecasts: {
      day: string;
      timestamp: string;
      forecast: { code: string; text: string; summary?: string };
      temperature: Range;
      relativeHumidity: Range;
      wind: { direction: string; speed: Range };
    }[];
  }[];
  paginationToken?: string;
}

interface RegionalData {
  regionMetadata: { name: string; labelLocation: { latitude: number; longitude: number } }[];
  items: {
    date: string;
    updatedTimestamp: string;
    timestamp: string;
    readings: Record<string, Record<string, number>>;
  }[];
  paginationToken?: string;
}

interface UvData {
  records: {
    date: string;
    updatedTimestamp: string;
    timestamp: string;
    index: { hour: string; value: number }[];
  }[];
  paginationToken?: string;
}

interface ObservationData<R> {
  records: {
    datetime: string;
    updatedTimestamp?: string;
    item: { type?: string; isStationData?: boolean; readings: R[] };
  }[];
  paginationToken?: string;
}

interface WbgtReading {
  station: { id: string; name: string; townCenter?: string };
  location: { latitude: string | number; longitude: string | number };
  wbgt: string | number;
  heatStress: string;
}

interface RadarData {
  projection?: unknown;
  boundaryBox?: unknown;
  records: { timestamp: string; updatedTimestamp?: string; image: { url: string } }[];
}

// ============================================================================
// Shared inputs and helpers
// ============================================================================

const DATE_INPUT = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'Use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss')
  .optional()
  .describe(
    'Singapore time. "YYYY-MM-DD" = that whole day (paginated); "YYYY-MM-DDTHH:mm:ss" = the reading at that moment. Omit for the latest data.'
  );

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

const PAGINATION_TOKEN = z
  .string()
  .optional()
  .describe('next_page_token from a previous call (only for whole-day "date" queries)');

const REGIONS = ['north', 'south', 'east', 'west', 'central'] as const;

const METRIC_PATHS = {
  temperature: 'air-temperature',
  rainfall: 'rainfall',
  humidity: 'relative-humidity',
  wind_speed: 'wind-speed',
  wind_direction: 'wind-direction',
} as const;
type Metric = keyof typeof METRIC_PATHS;

function normaliseDate(date?: string): string | undefined {
  if (!date) return undefined;
  return /T\d{2}:\d{2}$/.test(date) ? `${date}:00` : date;
}

const isWholeDay = (date?: string) => Boolean(date && !date.includes('T'));

/** Past days never change, so they can be cached much longer. */
function ttlFor(date?: string): number {
  if (!date) return CACHE_TTL.realtime;
  return date.slice(0, 10) < nowSgt().slice(0, 10)
    ? CACHE_TTL.realtimeHistorical
    : CACHE_TTL.realtime;
}

async function fetchRealtime<T>(
  auth: ApiAuth,
  path: string,
  options: { date?: string; paginationToken?: string; api?: string } = {}
): Promise<T> {
  const date = normaliseDate(options.date);
  return apiGet<T>({
    category: 'realtime',
    url: `${API_BASES.realtime}/${path}`,
    params: { api: options.api, date, paginationToken: options.paginationToken },
    ttlMs: ttlFor(date),
    auth,
    unwrap: (body, status) => {
      try {
        return unwrapOgp<T>(body, status);
      } catch (error) {
        if (error instanceof UpstreamError && status === 404) {
          throw new UpstreamError(
            'No data available for the requested time',
            404,
            error.code,
            'Try a more recent date or omit `date` for the latest data.'
          );
        }
        throw error;
      }
    },
  });
}

function toLatLng(lat?: number | string, lng?: number | string): LatLng | undefined {
  const latitude = parseNum(lat);
  const longitude = parseNum(lng);
  return latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined;
}

function originFrom(latitude?: number, longitude?: number): LatLng | undefined {
  if (latitude === undefined && longitude === undefined) return undefined;
  if (latitude === undefined || longitude === undefined) {
    throw new UpstreamError('Provide both latitude and longitude', 400, 'BAD_LOCATION');
  }
  return { latitude, longitude };
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];
const toCompass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

export function psiBand(value: number): string {
  if (value <= 50) return 'Good';
  if (value <= 100) return 'Moderate';
  if (value <= 200) return 'Unhealthy';
  if (value <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

function psiAdvice(value: number): string {
  if (value <= 100) return 'Normal activities.';
  if (value <= 200)
    return 'Reduce prolonged or strenuous outdoor physical exertion. Elderly, pregnant women, children and people with chronic lung or heart disease should minimise outdoor activity.';
  if (value <= 300) return 'Avoid prolonged or strenuous outdoor physical exertion.';
  return 'Minimise outdoor activity.';
}

function pm25Band(value: number): string {
  if (value <= 55) return 'Band I (Normal)';
  if (value <= 150) return 'Band II (Elevated)';
  if (value <= 250) return 'Band III (High)';
  return 'Band IV (Very High)';
}

export function uvCategory(value: number): string {
  if (value <= 2) return 'Low';
  if (value <= 5) return 'Moderate';
  if (value <= 7) return 'High';
  if (value <= 10) return 'Very High';
  return 'Extreme';
}

function nearestRegion(
  origin: LatLng,
  regions: RegionalData['regionMetadata']
): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const region of regions) {
    if (!REGIONS.includes(region.name as (typeof REGIONS)[number])) continue;
    const d = distanceKm(origin, region.labelLocation);
    if (!best || d < best.d) best = { name: region.name, d };
  }
  return best?.name;
}

/** Latest reading per station, joined with station names/locations. */
function stationSnapshot(
  data: StationReadingsData,
  reading?: StationReadingsData['readings'][number]
) {
  const stations = new Map(data.stations.map((s) => [s.id, s]));
  const latest =
    reading ??
    [...data.readings].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  if (!latest) return { timestamp: undefined, rows: [] };
  const rows = latest.data.map((d) => {
    const station = stations.get(d.stationId);
    return {
      station_id: d.stationId,
      station_name: station?.name,
      latitude: station?.location.latitude,
      longitude: station?.location.longitude,
      value: d.value,
    };
  });
  return { timestamp: latest.timestamp, rows };
}

// ============================================================================
// Fetchers (shared by individual tools and get_current_conditions)
// ============================================================================

const getStationMetric = (auth: ApiAuth, metric: Metric, date?: string, paginationToken?: string) =>
  fetchRealtime<StationReadingsData>(auth, METRIC_PATHS[metric], { date, paginationToken });
const getTwoHour = (auth: ApiAuth, date?: string, paginationToken?: string) =>
  fetchRealtime<TwoHourData>(auth, 'two-hr-forecast', { date, paginationToken });
const getPsi = (auth: ApiAuth, date?: string) => fetchRealtime<RegionalData>(auth, 'psi', { date });
const getPm25 = (auth: ApiAuth, date?: string) =>
  fetchRealtime<RegionalData>(auth, 'pm25', { date });
const getUv = (auth: ApiAuth, date?: string) => fetchRealtime<UvData>(auth, 'uv', { date });
const getWbgt = (auth: ApiAuth, date?: string) =>
  fetchRealtime<ObservationData<WbgtReading>>(auth, 'weather', { api: 'wbgt', date });
const getFlood = (auth: ApiAuth, date?: string, paginationToken?: string) =>
  fetchRealtime<ObservationData<Record<string, unknown>>>(auth, 'weather/flood-alerts', {
    date,
    paginationToken,
  });
const getLightning = (auth: ApiAuth, date?: string) =>
  fetchRealtime<ObservationData<Record<string, unknown>>>(auth, 'weather', {
    api: 'lightning',
    date,
  });

function resolveArea(input: string, data: TwoHourData) {
  const names = data.area_metadata.map((a) => a.name);
  const match = findBestName(input, names);
  if (!match) {
    throw new UpstreamError(
      `Unknown forecast area "${input}"`,
      400,
      'UNKNOWN_AREA',
      `Valid areas: ${names.join(', ')}. Or pass latitude/longitude instead.`
    );
  }
  return data.area_metadata.find((a) => a.name === match)!;
}

function nearestArea(origin: LatLng, data: TwoHourData) {
  const sorted = sortByDistance(data.area_metadata, origin, (a) => a.label_location);
  return sorted[0];
}

function wbgtRows(readings: WbgtReading[]) {
  return readings.map((r) => ({
    station_id: r.station.id,
    station_name: r.station.name,
    town_centre: r.station.townCenter,
    latitude: parseNum(r.location.latitude),
    longitude: parseNum(r.location.longitude),
    wbgt_celsius: parseNum(r.wbgt),
    heat_stress: r.heatStress,
  }));
}

/** Extract a lat/lng from loosely-typed reading objects (lightning, floods). */
function readingLocation(reading: Record<string, unknown>): LatLng | undefined {
  const loc = (reading.location ?? reading.coordinates ?? reading) as Record<string, unknown>;
  return toLatLng(
    (loc.latitude ?? loc.lat) as number | string | undefined,
    (loc.longitude ?? loc.lon ?? loc.lng) as number | string | undefined
  );
}

// ============================================================================
// Tools
// ============================================================================

export function registerWeatherTools(server: McpServer, ctx: ToolContext) {
  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_weather_forecast'),
    {
      title: 'Get Singapore weather forecast',
      description:
        'Get NEA weather forecasts: "2h" = nowcast for 47 areas/towns (updated every 30 min; filter by area name or latitude/longitude), "24h" = island-wide and 5-region forecast with temperature, humidity and wind, "4day" = 4-day outlook. Supports past dates.',
      inputSchema: {
        period: z
          .enum(['2h', '24h', '4day'])
          .optional()
          .describe('"2h" (default) area nowcast, "24h" regional forecast, or "4day" outlook'),
        area: z
          .string()
          .optional()
          .describe('2h only: area/town name, e.g. "Bishan", "Jurong West", "Changi"'),
        latitude: LATITUDE,
        longitude: LONGITUDE,
        region: z.enum(REGIONS).optional().describe('24h only: limit to one region'),
        date: DATE_INPUT,
        pagination_token: PAGINATION_TOKEN,
      },
      errorContext: 'Failed to get weather forecast',
    },
    async ({ period = '2h', area, latitude, longitude, region, date, pagination_token }) => {
      if (period === '2h') {
        const data = await getTwoHour(ctx.auth, date, pagination_token);
        const origin = originFrom(latitude, longitude);
        const target = area
          ? { ...resolveArea(area, data), distance_km: undefined as number | undefined }
          : origin
            ? nearestArea(origin, data)
            : undefined;

        const items = [...data.items].sort(
          (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
        );
        const shaped = items.map((item) => ({
          valid_period: item.valid_period.text,
          valid_from: item.valid_period.start,
          valid_to: item.valid_period.end,
          updated: item.update_timestamp,
          forecast: target
            ? item.forecasts.find((f) => f.area === target.name)?.forecast
            : undefined,
          forecasts: target
            ? undefined
            : Object.fromEntries(item.forecasts.map((f) => [f.area, f.forecast])),
        }));

        return {
          period: '2h',
          area: target
            ? {
                name: target.name,
                latitude: target.label_location.latitude,
                longitude: target.label_location.longitude,
                distance_km: target.distance_km,
              }
            : undefined,
          ...(isWholeDay(date)
            ? { forecasts_by_time: shaped }
            : (shaped[0] ?? { message: 'No forecast available' })),
          next_page_token: data.paginationToken,
          source: `NEA via ${DATAGOVSG_SOURCE}`,
        };
      }

      if (period === '24h') {
        const data = await fetchRealtime<TwentyFourHourData>(ctx.auth, 'twenty-four-hr-forecast', {
          date,
          paginationToken: pagination_token,
        });
        const records = [...data.records].sort(
          (a, b) => Date.parse(b.updatedTimestamp) - Date.parse(a.updatedTimestamp)
        );
        const shaped = records.map((record) => ({
          date: record.date,
          updated: record.updatedTimestamp,
          valid_period: record.general.validPeriod.text,
          general: {
            forecast: record.general.forecast.text,
            temperature_celsius: {
              low: record.general.temperature.low,
              high: record.general.temperature.high,
            },
            humidity_percent: {
              low: record.general.relativeHumidity.low,
              high: record.general.relativeHumidity.high,
            },
            wind: {
              direction: record.general.wind.direction,
              speed_kmh: {
                low: record.general.wind.speed.low,
                high: record.general.wind.speed.high,
              },
            },
          },
          periods: record.periods.map((p) => ({
            period: p.timePeriod.text,
            start: p.timePeriod.start,
            end: p.timePeriod.end,
            ...(region
              ? { forecast: p.regions[region]?.text }
              : {
                  regions: Object.fromEntries(
                    Object.entries(p.regions).map(([k, v]) => [k, v.text])
                  ),
                }),
          })),
        }));
        return {
          period: '24h',
          region: region ?? 'all',
          ...(isWholeDay(date)
            ? { forecasts: shaped }
            : (shaped[0] ?? { message: 'No forecast available' })),
          next_page_token: data.paginationToken,
          source: `NEA via ${DATAGOVSG_SOURCE}`,
        };
      }

      const data = await fetchRealtime<FourDayData>(ctx.auth, 'four-day-outlook', {
        date,
        paginationToken: pagination_token,
      });
      const record = [...data.records].sort(
        (a, b) => Date.parse(b.updatedTimestamp) - Date.parse(a.updatedTimestamp)
      )[0];
      return {
        period: '4day',
        updated: record?.updatedTimestamp,
        forecasts: (record?.forecasts ?? []).map((f) => ({
          day: f.day,
          date: f.timestamp.slice(0, 10),
          forecast: f.forecast.text,
          summary: f.forecast.summary,
          temperature_celsius: { low: f.temperature.low, high: f.temperature.high },
          humidity_percent: { low: f.relativeHumidity.low, high: f.relativeHumidity.high },
          wind: {
            direction: f.wind.direction,
            speed_kmh: { low: f.wind.speed.low, high: f.wind.speed.high },
          },
        })),
        source: `NEA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_weather_readings'),
    {
      title: 'Get live weather station readings',
      description:
        'Get NEA weather station readings: temperature (°C, per minute), rainfall (mm per 5 min), humidity (%), wind_speed (knots) or wind_direction (degrees). Returns all stations with a min/max/avg summary, or the nearest stations to a latitude/longitude, or one station. With a whole-day `date`, returns a time series (paginated).',
      inputSchema: {
        metric: z
          .enum(['temperature', 'rainfall', 'humidity', 'wind_speed', 'wind_direction'])
          .describe('Which measurement to return'),
        latitude: LATITUDE,
        longitude: LONGITUDE,
        nearest: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('With latitude/longitude: how many nearest stations to return (default 3)'),
        station: z
          .string()
          .optional()
          .describe('Station ID (e.g. "S109") or part of a station name'),
        date: DATE_INPUT,
        pagination_token: PAGINATION_TOKEN,
      },
      errorContext: 'Failed to get weather readings',
    },
    async ({ metric, latitude, longitude, nearest = 3, station, date, pagination_token }) => {
      const data = await getStationMetric(ctx.auth, metric, date, pagination_token);
      const origin = originFrom(latitude, longitude);
      const unit = data.readingUnit;

      const selectStations = <
        T extends {
          station_id: string;
          station_name?: string;
          latitude?: number;
          longitude?: number;
        },
      >(
        rows: T[]
      ) => {
        if (station) {
          const needle = station.toLowerCase();
          return rows.filter(
            (r) =>
              r.station_id.toLowerCase() === needle ||
              (r.station_name ?? '').toLowerCase().includes(needle)
          );
        }
        if (origin) {
          return sortByDistance(rows, origin, (r) => toLatLng(r.latitude, r.longitude)).slice(
            0,
            nearest
          );
        }
        return rows;
      };

      const decorate = (value: number) =>
        metric === 'wind_direction'
          ? { compass: toCompass(value) }
          : metric === 'wind_speed'
            ? { kmh: round(value * 1.852, 1) }
            : {};

      if (!isWholeDay(date)) {
        const snapshot = stationSnapshot(data);
        const selected = selectStations(snapshot.rows);
        const values = snapshot.rows.map((r) => r.value);
        return {
          metric,
          unit,
          timestamp: snapshot.timestamp,
          station_count: snapshot.rows.length,
          singapore_summary: {
            ...summarise(values),
            ...(metric === 'rainfall'
              ? { stations_with_rain: values.filter((v) => v > 0).length }
              : {}),
          },
          readings: selected.map((r) => ({ ...r, ...decorate(r.value) })),
          note:
            station && selected.length === 0
              ? `No station matched "${station}". Omit station to list all stations.`
              : undefined,
          source: `NEA via ${DATAGOVSG_SOURCE}`,
        };
      }

      // Whole-day time series
      const readings = [...data.readings].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      );
      const focus =
        station || origin
          ? selectStations(stationSnapshot(data, readings[readings.length - 1]).rows)
          : [];
      const focusIds = new Set(focus.map((r) => r.station_id));

      const series = readings.map((reading) => {
        if (focusIds.size > 0) {
          return {
            timestamp: reading.timestamp,
            values: Object.fromEntries(
              reading.data
                .filter((d) => focusIds.has(d.stationId))
                .map((d) => [d.stationId, d.value])
            ),
          };
        }
        return { timestamp: reading.timestamp, ...summarise(reading.data.map((d) => d.value)) };
      });

      return {
        metric,
        unit,
        date,
        stations: focus.length > 0 ? focus.map(({ value: _v, ...rest }) => rest) : undefined,
        series_mode: focusIds.size > 0 ? 'per_station' : 'singapore_min_max_avg',
        points: series.length,
        series,
        next_page_token: data.paginationToken,
        tip: data.paginationToken
          ? 'Pass next_page_token as pagination_token for more of the day.'
          : undefined,
        source: `NEA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_air_quality'),
    {
      title: 'Get Singapore air quality (PSI and PM2.5)',
      description:
        'Get the latest (or historical) air quality: 24-hour PSI with health band (Good/Moderate/Unhealthy/Very unhealthy/Hazardous) and NEA activity advice, 1-hour PM2.5 band, and pollutant concentrations (PM2.5, PM10, SO2, CO, O3, NO2) for north/south/east/west/central regions. Use this for haze questions.',
      inputSchema: {
        region: z.enum(REGIONS).optional().describe('Only this region'),
        latitude: LATITUDE,
        longitude: LONGITUDE,
        date: DATE_INPUT,
      },
      errorContext: 'Failed to get air quality',
    },
    async ({ region, latitude, longitude, date }) => {
      const [psi, pm25] = await Promise.all([getPsi(ctx.auth, date), getPm25(ctx.auth, date)]);
      const latestPsi = [...psi.items].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      )[0];
      const latestPm25 = [...pm25.items].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      )[0];
      if (!latestPsi) return { message: 'No PSI readings available for that time' };

      const origin = originFrom(latitude, longitude);
      const focusRegion =
        region ?? (origin ? nearestRegion(origin, psi.regionMetadata) : undefined);
      const pick = (values?: Record<string, number>) =>
        values ? (focusRegion ? values[focusRegion] : values) : undefined;

      const psi24 = latestPsi.readings.psi_twenty_four_hourly ?? {};
      const pm1h = latestPm25?.readings.pm25_one_hourly ?? {};
      const worstPsi = Math.max(...Object.values(psi24).filter((v) => typeof v === 'number'));
      const focusPsi = focusRegion ? psi24[focusRegion] : worstPsi;

      return {
        timestamp: latestPsi.timestamp,
        updated: latestPsi.updatedTimestamp,
        region: focusRegion ?? 'all',
        psi_24h: focusRegion
          ? { value: psi24[focusRegion], band: psiBand(psi24[focusRegion]) }
          : Object.fromEntries(
              Object.entries(psi24).map(([r, v]) => [r, { value: v, band: psiBand(v) }])
            ),
        pm25_1h: focusRegion
          ? {
              value_ugm3: pm1h[focusRegion],
              band: pm1h[focusRegion] !== undefined ? pm25Band(pm1h[focusRegion]) : undefined,
            }
          : Object.fromEntries(
              Object.entries(pm1h).map(([r, v]) => [r, { value_ugm3: v, band: pm25Band(v) }])
            ),
        pollutants: {
          pm25_24h_ugm3: pick(latestPsi.readings.pm25_twenty_four_hourly),
          pm10_24h_ugm3: pick(latestPsi.readings.pm10_twenty_four_hourly),
          so2_24h_ugm3: pick(latestPsi.readings.so2_twenty_four_hourly),
          co_8h_max_mgm3: pick(latestPsi.readings.co_eight_hour_max),
          o3_8h_max_ugm3: pick(latestPsi.readings.o3_eight_hour_max),
          no2_1h_max_ugm3: pick(latestPsi.readings.no2_one_hour_max),
        },
        health_advice: Number.isFinite(focusPsi)
          ? { based_on_psi: focusPsi, band: psiBand(focusPsi), advice: psiAdvice(focusPsi) }
          : undefined,
        source: `NEA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_uv_index'),
    {
      title: 'Get UV index',
      description:
        "Get the hourly UV index for Singapore (latest value with category Low/Moderate/High/Very High/Extreme, plus today's hourly series).",
      inputSchema: { date: DATE_INPUT },
      errorContext: 'Failed to get UV index',
    },
    async ({ date }) => {
      const data = await getUv(ctx.auth, date);
      const record = [...data.records].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      )[0];
      if (!record) return { message: 'No UV readings available for that time' };
      const series = [...record.index].sort((a, b) => Date.parse(a.hour) - Date.parse(b.hour));
      const latest = series[series.length - 1];
      const peak = series.reduce((max, p) => (p.value > max.value ? p : max), series[0]);
      return {
        date: record.date,
        latest: latest
          ? { hour: latest.hour, value: latest.value, category: uvCategory(latest.value) }
          : undefined,
        peak_so_far: peak
          ? { hour: peak.hour, value: peak.value, category: uvCategory(peak.value) }
          : undefined,
        hourly: series.map((p) => ({ hour: p.hour, value: p.value })),
        advice:
          latest && latest.value >= 6
            ? 'High UV: seek shade, wear sunglasses, hat and sunscreen between 11am and 3pm.'
            : undefined,
        source: `NEA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_heat_stress'),
    {
      title: 'Get heat stress (WBGT)',
      description:
        'Get Wet Bulb Globe Temperature (WBGT) heat stress readings from ~30 stations with NEA heat stress levels (Low < 31°C, Moderate 31-33°C, High >= 33°C). Useful for outdoor activity and exercise planning. Filter by nearest to latitude/longitude or by station/town name.',
      inputSchema: {
        latitude: LATITUDE,
        longitude: LONGITUDE,
        nearest: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Nearest stations to return (default 3)'),
        station: z
          .string()
          .optional()
          .describe('Station ID, station name or town centre (partial match)'),
        date: DATE_INPUT,
      },
      errorContext: 'Failed to get heat stress readings',
    },
    async ({ latitude, longitude, nearest = 3, station, date }) => {
      const data = await getWbgt(ctx.auth, date);
      const record = [...data.records].sort(
        (a, b) => Date.parse(b.datetime) - Date.parse(a.datetime)
      )[0];
      if (!record) return { message: 'No heat stress readings available for that time' };
      let rows = wbgtRows(record.item.readings);
      const all = rows;
      const origin = originFrom(latitude, longitude);
      if (station) {
        const needle = station.toLowerCase();
        rows = rows.filter((r) =>
          [r.station_id, r.station_name, r.town_centre].some((v) =>
            (v ?? '').toLowerCase().includes(needle)
          )
        );
      } else if (origin) {
        rows = sortByDistance(rows, origin, (r) => toLatLng(r.latitude, r.longitude)).slice(
          0,
          nearest
        );
      }
      const levels: Record<string, number> = {};
      for (const r of all) levels[r.heat_stress] = (levels[r.heat_stress] || 0) + 1;
      return {
        timestamp: record.datetime,
        station_count: all.length,
        stations_by_level: levels,
        readings: rows,
        guidance:
          'NEA heat stress levels: Low (<31°C) normal activity; Moderate (31-33°C) reduce strenuous outdoor activity, hydrate; High (>=33°C) minimise prolonged outdoor activity.',
        source: `NEA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_lightning'),
    {
      title: 'Get lightning observations',
      description:
        'Get recent lightning strikes detected over Singapore. Optionally count strikes within a radius of a latitude/longitude (useful for outdoor safety).',
      inputSchema: {
        latitude: LATITUDE,
        longitude: LONGITUDE,
        radius_km: z
          .number()
          .min(0.5)
          .max(50)
          .optional()
          .describe('Radius around the location (default 10 km)'),
        date: DATE_INPUT,
      },
      errorContext: 'Failed to get lightning observations',
    },
    async ({ latitude, longitude, radius_km = 10, date }) => {
      const data = await getLightning(ctx.auth, date);
      const records = [...data.records].sort(
        (a, b) => Date.parse(b.datetime) - Date.parse(a.datetime)
      );
      const latest = records[0];
      if (!latest) return { message: 'No lightning observations available for that time' };
      const origin = originFrom(latitude, longitude);

      const strikes = records.flatMap((r) =>
        r.item.readings.map((reading) => ({ observed: r.datetime, ...reading }))
      );
      const located = origin
        ? sortByDistance(
            strikes,
            origin,
            (s) => readingLocation(s as Record<string, unknown>),
            radius_km
          )
        : strikes;

      return {
        latest_observation: latest.datetime,
        observations_checked: records.length,
        strikes_total: strikes.length,
        ...(origin ? { radius_km, strikes_within_radius: located.length } : {}),
        strikes: located.slice(0, 50),
        summary:
          strikes.length === 0
            ? 'No lightning detected in the latest observation(s).'
            : origin && located.length === 0
              ? `Lightning detected in Singapore, but none within ${radius_km} km of the location.`
              : 'Lightning detected. Avoid open areas and seek shelter if outdoors.',
        source: `NEA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_flood_alerts'),
    {
      title: 'Get PUB flood alerts',
      description:
        'Get PUB flash flood alerts for Singapore. Returns currently active alerts from the latest check plus any alerts seen in recent checks (every ~2 minutes).',
      inputSchema: { date: DATE_INPUT, pagination_token: PAGINATION_TOKEN },
      errorContext: 'Failed to get flood alerts',
    },
    async ({ date, pagination_token }) => {
      const data = await getFlood(ctx.auth, date, pagination_token);
      const records = [...data.records].sort(
        (a, b) => Date.parse(b.datetime) - Date.parse(a.datetime)
      );
      const latest = records[0];
      const withAlerts = records.filter((r) => r.item.readings.length > 0);
      return {
        latest_check: latest?.datetime,
        checks_in_page: records.length,
        active_alerts_count: latest?.item.readings.length ?? 0,
        active_alerts: latest?.item.readings ?? [],
        recent_alerts: withAlerts
          .slice(0, 10)
          .map((r) => ({ observed: r.datetime, alerts: r.item.readings })),
        summary:
          (latest?.item.readings.length ?? 0) > 0
            ? 'Flash flood alerts are active. Avoid the affected areas.'
            : withAlerts.length > 0
              ? 'No active alerts now, but alerts were issued in recent checks.'
              : 'No flood alerts in the checked period.',
        next_page_token: data.paginationToken,
        source: `PUB via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_weather_radar'),
    {
      title: 'Get rain radar image',
      description:
        'Get the latest NEA rain radar image (PNG overlay, updated every 5 minutes) for a 70km, 240km or 480km range, with its geographic bounding box. The image URL expires after ~20 minutes. Beta dataset.',
      inputSchema: {
        range: z
          .enum(['70km', '240km', '480km'])
          .optional()
          .describe('Radar range (default 240km)'),
        date: DATE_INPUT,
      },
      errorContext: 'Failed to get radar image',
    },
    async ({ range = '240km', date }) => {
      const data = await fetchRealtime<RadarData>(ctx.auth, `weather-radar-images/${range}`, {
        date,
      });
      const records = [...data.records].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      );
      const latest = records[0];
      if (!latest) return { message: 'No radar image available for that time' };
      return {
        range,
        timestamp: latest.timestamp,
        image_url: latest.image.url,
        image_url_expires_in_seconds: 1200,
        frames_available: records.length,
        boundary_box: data.boundaryBox,
        projection: data.projection,
        note: 'Beta dataset. Transparent PNG intended as a map overlay; coloured areas show rain intensity.',
        source: `NEA via ${DATAGOVSG_SOURCE}`,
      };
    }
  );

  // --------------------------------------------------------------------------
  registerReadOnlyTool(
    server,
    datagovsgTool('get_current_conditions'),
    {
      title: 'Get current conditions for a place',
      description:
        'One-call summary of current conditions for a Singapore area or coordinates: 2-hour forecast, nearest temperature/humidity/rain/wind readings, PSI and PM2.5 band, UV index, heat stress (WBGT) and active flood alerts. Without a location, gives an island-wide summary. Best for "what\'s the weather like in X right now?"',
      inputSchema: {
        area: z
          .string()
          .optional()
          .describe('Area or town name, e.g. "Tampines", "Orchard", "Jurong East"'),
        latitude: LATITUDE,
        longitude: LONGITUDE,
      },
      errorContext: 'Failed to get current conditions',
    },
    async ({ area, latitude, longitude }) => {
      const auth = ctx.auth;
      const twoHour = await getTwoHour(auth);
      let origin = originFrom(latitude, longitude);
      let areaInfo: { name: string; distance_km?: number } | undefined;
      if (area) {
        const match = resolveArea(area, twoHour);
        origin = origin ?? match.label_location;
        areaInfo = { name: match.name };
      } else if (origin) {
        const near = nearestArea(origin, twoHour);
        areaInfo = near ? { name: near.name, distance_km: near.distance_km } : undefined;
      }

      const settled = await Promise.allSettled([
        getStationMetric(auth, 'temperature'),
        getStationMetric(auth, 'humidity'),
        getStationMetric(auth, 'rainfall'),
        getStationMetric(auth, 'wind_speed'),
        getPsi(auth),
        getUv(auth),
        getWbgt(auth),
        getFlood(auth),
      ]);
      const [temperature, humidity, rainfall, windSpeed, psi, uv, wbgt, flood] = settled.map((s) =>
        s.status === 'fulfilled' ? s.value : undefined
      ) as [
        StationReadingsData?,
        StationReadingsData?,
        StationReadingsData?,
        StationReadingsData?,
        RegionalData?,
        UvData?,
        ObservationData<WbgtReading>?,
        ObservationData<Record<string, unknown>>?,
      ];
      const unavailable = [
        'temperature',
        'humidity',
        'rainfall',
        'wind_speed',
        'psi',
        'uv',
        'heat_stress',
        'flood_alerts',
      ].filter((_, i) => settled[i].status === 'rejected');

      const metricSummary = (data: StationReadingsData | undefined, decimals = 1) => {
        if (!data) return undefined;
        const snapshot = stationSnapshot(data);
        const values = snapshot.rows.map((r) => r.value);
        if (origin) {
          const near = sortByDistance(snapshot.rows, origin, (r) =>
            toLatLng(r.latitude, r.longitude)
          )[0];
          return near
            ? {
                value: near.value,
                unit: data.readingUnit,
                station: near.station_name,
                distance_km: near.distance_km,
                at: snapshot.timestamp,
              }
            : undefined;
        }
        const s = summarise(values);
        return {
          min: s.min,
          max: s.max,
          avg: s.avg !== undefined ? round(s.avg, decimals) : undefined,
          unit: data.readingUnit,
          at: snapshot.timestamp,
        };
      };

      const latestTwoHour = [...twoHour.items].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      )[0];
      const psiItem = psi
        ? [...psi.items].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]
        : undefined;
      const region = origin && psi ? nearestRegion(origin, psi.regionMetadata) : undefined;
      const psiValues = psiItem?.readings.psi_twenty_four_hourly ?? {};
      const psiValue = region ? psiValues[region] : Math.max(...Object.values(psiValues));
      const uvRecord = uv?.records[0];
      const uvLatest = uvRecord
        ? [...uvRecord.index].sort((a, b) => Date.parse(b.hour) - Date.parse(a.hour))[0]
        : undefined;
      const wbgtLatest = wbgt
        ? [...wbgt.records].sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime))[0]
        : undefined;
      const wbgtAll = wbgtLatest ? wbgtRows(wbgtLatest.item.readings) : [];
      const wbgtNear = origin
        ? sortByDistance(wbgtAll, origin, (r) => toLatLng(r.latitude, r.longitude))[0]
        : undefined;
      const floodLatest = flood
        ? [...flood.records].sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime))[0]
        : undefined;
      const rainSnapshot = rainfall ? stationSnapshot(rainfall) : undefined;

      return {
        location: origin
          ? {
              area: areaInfo?.name,
              latitude: origin.latitude,
              longitude: origin.longitude,
              psi_region: region,
            }
          : 'Singapore (island-wide)',
        forecast_2h: latestTwoHour
          ? {
              forecast: areaInfo
                ? latestTwoHour.forecasts.find((f) => f.area === areaInfo!.name)?.forecast
                : undefined,
              area: areaInfo?.name,
              valid_period: latestTwoHour.valid_period.text,
              island_wide: areaInfo
                ? undefined
                : Object.entries(
                    latestTwoHour.forecasts.reduce<Record<string, number>>((acc, f) => {
                      acc[f.forecast] = (acc[f.forecast] || 0) + 1;
                      return acc;
                    }, {})
                  ).map(([forecast, areas]) => ({ forecast, areas })),
            }
          : undefined,
        temperature: metricSummary(temperature),
        humidity: metricSummary(humidity, 0),
        rainfall_5min: {
          ...metricSummary(rainfall, 2),
          stations_reporting_rain: rainSnapshot
            ? rainSnapshot.rows.filter((r) => r.value > 0).length
            : undefined,
        },
        wind_speed: metricSummary(windSpeed),
        air_quality: Number.isFinite(psiValue)
          ? {
              psi_24h: psiValue,
              band: psiBand(psiValue),
              region: region ?? 'worst region',
              advice: psiAdvice(psiValue),
            }
          : undefined,
        uv_index: uvLatest
          ? { value: uvLatest.value, category: uvCategory(uvLatest.value), hour: uvLatest.hour }
          : undefined,
        heat_stress: wbgtNear
          ? {
              wbgt_celsius: wbgtNear.wbgt_celsius,
              level: wbgtNear.heat_stress,
              station: wbgtNear.station_name,
              distance_km: wbgtNear.distance_km,
            }
          : wbgtAll.length > 0
            ? {
                highest_wbgt_celsius: Math.max(...wbgtAll.map((r) => r.wbgt_celsius ?? 0)),
                stations_high: wbgtAll.filter((r) => r.heat_stress === 'High').length,
              }
            : undefined,
        flood_alerts: floodLatest
          ? { active: floodLatest.item.readings.length, checked_at: floodLatest.datetime }
          : undefined,
        unavailable: unavailable.length > 0 ? unavailable : undefined,
        source: `NEA and PUB via ${DATAGOVSG_SOURCE}`,
      };
    }
  );
}
