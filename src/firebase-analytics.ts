/**
 * Firebase Analytics Persistence Module
 *
 * Provides cloud-based analytics storage using Firebase Realtime Database.
 * Falls back gracefully if Firebase credentials are not configured.
 */

import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

// Firebase configuration
const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://techmavie-mcp-analytics-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_CREDENTIALS_PATH =
  process.env.FIREBASE_CREDENTIALS_PATH ||
  '.credentials/firebase-service-account.json';
const FIREBASE_ANALYTICS_PATH = '/mcp-analytics/mcp-datagovsg';

let firebaseInitialized = false;
let db: admin.database.Database | null = null;

/**
 * Initialize Firebase Admin SDK
 */
function initializeFirebase(): boolean {
  if (firebaseInitialized) return true;

  try {
    // Try multiple credential paths
    const credentialPaths = [
      FIREBASE_CREDENTIALS_PATH,
      '/app/.credentials/firebase-service-account.json',
      path.join(process.cwd(), '.credentials/firebase-service-account.json'),
    ];

    let credentialPath: string | null = null;
    for (const p of credentialPaths) {
      if (fs.existsSync(p)) {
        credentialPath = p;
        break;
      }
    }

    if (!credentialPath) {
      console.log(
        'Firebase credentials not found. Firebase analytics disabled.'
      );
      return false;
    }

    const serviceAccount = JSON.parse(
      fs.readFileSync(credentialPath, 'utf-8')
    );

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_DATABASE_URL,
      });
    }

    db = admin.database();
    firebaseInitialized = true;
    console.log('Firebase analytics initialized successfully');
    return true;
  } catch (error) {
    console.error('Failed to initialize Firebase:', error);
    return false;
  }
}

/**
 * Sanitize keys for Firebase (Firebase doesn't allow . $ # [ ] / in keys)
 */
function sanitizeKey(key: string): string {
  return key
    .replace(/\./g, '_dot_')
    .replace(/\$/g, '_dollar_')
    .replace(/#/g, '_hash_')
    .replace(/\[/g, '_lb_')
    .replace(/\]/g, '_rb_')
    .replace(/\//g, '_slash_');
}

/**
 * Sanitize all keys in an object recursively
 */
function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const sanitizedKey = sanitizeKey(key);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      sanitized[sanitizedKey] = sanitizeObject(value as Record<string, unknown>);
    } else {
      sanitized[sanitizedKey] = value;
    }
  }
  return sanitized;
}

/**
 * Save analytics data to Firebase
 */
export async function saveAnalyticsToFirebase(
  analytics: Record<string, unknown>
): Promise<void> {
  if (!initializeFirebase() || !db) return;

  try {
    const sanitizedAnalytics = sanitizeObject(analytics);
    sanitizedAnalytics.lastUpdated = new Date().toISOString();

    await db.ref(FIREBASE_ANALYTICS_PATH).set(sanitizedAnalytics);
  } catch (error) {
    console.error('Failed to save analytics to Firebase:', error);
  }
}

/**
 * Load analytics data from Firebase
 */
export async function loadAnalyticsFromFirebase(): Promise<Record<
  string,
  unknown
> | null> {
  if (!initializeFirebase() || !db) return null;

  try {
    const snapshot = await db.ref(FIREBASE_ANALYTICS_PATH).get();
    if (snapshot.exists()) {
      const data = snapshot.val();
      console.log('Loaded analytics from Firebase');

      // Provide fallback defaults for all object/array fields
      // Firebase does not store empty objects {}, so they return as undefined
      return {
        ...data,
        requestsByMethod: data.requestsByMethod || {},
        requestsByEndpoint: data.requestsByEndpoint || {},
        toolCalls: data.toolCalls || {},
        recentToolCalls: data.recentToolCalls || [],
        clientsByIp: data.clientsByIp || {},
        clientsByUserAgent: data.clientsByUserAgent || {},
        hourlyRequests: data.hourlyRequests || {},
      };
    }
    console.log('No analytics data found in Firebase');
    return null;
  } catch (error) {
    console.error('Failed to load analytics from Firebase:', error);
    return null;
  }
}
