/**
 * Firebase Realtime Database persistence for analytics.
 *
 * Stores one analytics document at /mcp-analytics/mcp-datagovsg.
 * Disabled gracefully when FIREBASE_DATABASE_URL or the service account
 * credentials file is missing.
 */

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { Database, getDatabase } from 'firebase-admin/database';
import fs from 'fs';
import path from 'path';

const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || '').trim();
const FIREBASE_CREDENTIALS_PATH =
  process.env.FIREBASE_CREDENTIALS_PATH || '.credentials/firebase-service-account.json';
const FIREBASE_ANALYTICS_PATH = '/mcp-analytics/mcp-datagovsg';

let initialised = false;
let attempted = false;
let db: Database | null = null;

function initialiseFirebase(): boolean {
  if (initialised) return true;
  if (attempted) return false;
  attempted = true;

  if (!FIREBASE_DATABASE_URL) {
    console.log('[firebase] FIREBASE_DATABASE_URL not set. Firebase analytics disabled.');
    return false;
  }

  try {
    const candidates = [
      FIREBASE_CREDENTIALS_PATH,
      '/app/.credentials/firebase-service-account.json',
      path.join(process.cwd(), '.credentials/firebase-service-account.json'),
    ];
    const credentialPath = candidates.find((p) => fs.existsSync(p));
    if (!credentialPath) {
      console.log('[firebase] Credentials not found. Firebase analytics disabled.');
      return false;
    }

    const serviceAccount = JSON.parse(fs.readFileSync(credentialPath, 'utf-8'));
    if (getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccount),
        databaseURL: FIREBASE_DATABASE_URL,
      });
    }
    db = getDatabase();
    initialised = true;
    console.log('[firebase] Analytics persistence enabled');
    return true;
  } catch (error) {
    console.error('[firebase] Failed to initialise:', error);
    return false;
  }
}

export function isFirebaseEnabled(): boolean {
  return initialiseFirebase();
}

// Firebase keys may not contain . $ # [ ] /
const ENCODE: [RegExp, string][] = [
  [/\./g, '_dot_'],
  [/\$/g, '_dollar_'],
  [/#/g, '_hash_'],
  [/\[/g, '_lb_'],
  [/\]/g, '_rb_'],
  [/\//g, '_slash_'],
];
const DECODE: [RegExp, string][] = [
  [/_dot_/g, '.'],
  [/_dollar_/g, '$'],
  [/_hash_/g, '#'],
  [/_lb_/g, '['],
  [/_rb_/g, ']'],
  [/_slash_/g, '/'],
];

function mapKeys(value: unknown, rules: [RegExp, string][]): unknown {
  if (Array.isArray(value)) return value.map((item) => mapKeys(item, rules));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const mapped = rules.reduce(
        (k, [pattern, replacement]) => k.replace(pattern, replacement),
        key
      );
      out[mapped] = mapKeys(inner, rules);
    }
    return out;
  }
  return value;
}

export async function saveAnalyticsToFirebase(analytics: Record<string, unknown>): Promise<void> {
  if (!initialiseFirebase() || !db) return;
  try {
    const encoded = mapKeys(analytics, ENCODE) as Record<string, unknown>;
    encoded.lastUpdated = new Date().toISOString();
    await db.ref(FIREBASE_ANALYTICS_PATH).set(encoded);
  } catch (error) {
    console.error('[firebase] Failed to save analytics:', error);
  }
}

export async function loadAnalyticsFromFirebase(): Promise<Record<string, unknown> | null> {
  if (!initialiseFirebase() || !db) return null;
  try {
    const snapshot = await db.ref(FIREBASE_ANALYTICS_PATH).get();
    if (!snapshot.exists()) {
      console.log('[firebase] No analytics stored yet');
      return null;
    }
    console.log('[firebase] Loaded analytics');
    // Callers fill defaults: Firebase drops empty objects, so they come back undefined
    return mapKeys(snapshot.val(), DECODE) as Record<string, unknown>;
  } catch (error) {
    console.error('[firebase] Failed to load analytics:', error);
    return null;
  }
}
