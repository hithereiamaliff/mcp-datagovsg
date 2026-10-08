/**
 * Geographic helpers: distance calculation, nearest-point search, and
 * conversion from Singapore's SVY21 grid (used by HDB carpark data) to
 * WGS84 latitude/longitude.
 */

import { round } from './format.js';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Sort items by distance from `origin`, attach `distance_km`, and optionally
 * keep only those within `radiusKm`.
 */
export function sortByDistance<T>(
  items: T[],
  origin: LatLng,
  getLocation: (item: T) => LatLng | undefined,
  radiusKm?: number
): Array<T & { distance_km: number }> {
  const withDistance: Array<T & { distance_km: number }> = [];
  for (const item of items) {
    const loc = getLocation(item);
    if (!loc) continue;
    const d = distanceKm(origin, loc);
    if (radiusKm !== undefined && d > radiusKm) continue;
    withDistance.push({ ...item, distance_km: round(d, 3) });
  }
  return withDistance.sort((a, b) => a.distance_km - b.distance_km);
}

/** Rough bounding box check for Singapore (incl. offshore islands). */
export function isInSingapore(point: LatLng): boolean {
  return (
    point.latitude > 1.1 &&
    point.latitude < 1.5 &&
    point.longitude > 103.5 &&
    point.longitude < 104.15
  );
}

// ============================================================================
// SVY21 -> WGS84
// Port of the standard SVY21 transverse Mercator inverse projection
// (Singapore Land Authority parameters).
// ============================================================================
const a = 6378137;
const f = 1 / 298.257223563;
const oLat = 1.366666; // origin latitude (degrees)
const oLon = 103.833333; // origin longitude (degrees)
const oN = 38744.572; // false northing
const oE = 28001.642; // false easting
const k = 1; // scale factor

const b = a * (1 - f);
const e2 = 2 * f - f * f;
const e4 = e2 * e2;
const e6 = e4 * e2;
const A0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256;
const A2 = (3 / 8) * (e2 + e4 / 4 + (15 * e6) / 128);
const A4 = (15 / 256) * (e4 + (3 * e6) / 4);
const A6 = (35 * e6) / 3072;

function calcM(latDeg: number): number {
  const latR = (latDeg * Math.PI) / 180;
  return (
    a * (A0 * latR - A2 * Math.sin(2 * latR) + A4 * Math.sin(4 * latR) - A6 * Math.sin(6 * latR))
  );
}

function calcRho(sin2Lat: number): number {
  return (a * (1 - e2)) / Math.pow(1 - e2 * sin2Lat, 1.5);
}

function calcV(sin2Lat: number): number {
  return a / Math.sqrt(1 - e2 * sin2Lat);
}

/** Convert SVY21 northing/easting (metres) to WGS84 latitude/longitude. */
export function svy21ToWgs84(northing: number, easting: number): LatLng {
  const Nprime = northing - oN;
  const Mo = calcM(oLat);
  const Mprime = Mo + Nprime / k;
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n2 * n2;
  const G = a * (1 - n) * (1 - n2) * (1 + (9 * n2) / 4 + (225 * n4) / 64) * (Math.PI / 180);
  const sigma = (Mprime * Math.PI) / (180 * G);

  const latPrime =
    sigma +
    ((3 * n) / 2 - (27 * n3) / 32) * Math.sin(2 * sigma) +
    ((21 * n2) / 16 - (55 * n4) / 32) * Math.sin(4 * sigma) +
    ((151 * n3) / 96) * Math.sin(6 * sigma) +
    ((1097 * n4) / 512) * Math.sin(8 * sigma);

  const sinLatPrime = Math.sin(latPrime);
  const sin2LatPrime = sinLatPrime * sinLatPrime;
  const rhoPrime = calcRho(sin2LatPrime);
  const vPrime = calcV(sin2LatPrime);
  const psiPrime = vPrime / rhoPrime;
  const psiPrime2 = psiPrime * psiPrime;
  const psiPrime3 = psiPrime2 * psiPrime;
  const psiPrime4 = psiPrime3 * psiPrime;
  const tPrime = Math.tan(latPrime);
  const t2 = tPrime * tPrime;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  const Eprime = easting - oE;
  const x = Eprime / (k * vPrime);
  const x2 = x * x;
  const x3 = x2 * x;
  const x5 = x3 * x2;
  const x7 = x5 * x2;

  // Latitude
  const latFactor = tPrime / (k * rhoPrime);
  const latTerm1 = latFactor * ((Eprime * x) / 2);
  const latTerm2 =
    latFactor * ((Eprime * x3) / 24) * (-4 * psiPrime2 + 9 * psiPrime * (1 - t2) + 12 * t2);
  const latTerm3 =
    latFactor *
    ((Eprime * x5) / 720) *
    (8 * psiPrime4 * (11 - 24 * t2) -
      12 * psiPrime3 * (21 - 71 * t2) +
      15 * psiPrime2 * (15 - 98 * t2 + 15 * t4) +
      180 * psiPrime * (5 * t2 - 3 * t4) +
      360 * t4);
  const latTerm4 = latFactor * ((Eprime * x7) / 40320) * (1385 - 3633 * t2 + 4095 * t4 + 1575 * t6);
  const lat = latPrime - latTerm1 + latTerm2 - latTerm3 + latTerm4;

  // Longitude
  const secLatPrime = 1 / Math.cos(lat);
  const lonTerm1 = x * secLatPrime;
  const lonTerm2 = ((x3 * secLatPrime) / 6) * (psiPrime + 2 * t2);
  const lonTerm3 =
    ((x5 * secLatPrime) / 120) *
    (-4 * psiPrime3 * (1 - 6 * t2) + psiPrime2 * (9 - 68 * t2) + 72 * psiPrime * t2 + 24 * t4);
  const lonTerm4 = ((x7 * secLatPrime) / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const lon = (oLon * Math.PI) / 180 + lonTerm1 - lonTerm2 + lonTerm3 - lonTerm4;

  return {
    latitude: round((lat * 180) / Math.PI, 6),
    longitude: round((lon * 180) / Math.PI, 6),
  };
}
