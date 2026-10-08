/**
 * Small formatting helpers for tool output.
 */

/** Trim long free text (descriptions, footnotes) to keep responses compact. */
export function truncate(text: string | undefined | null, max = 300): string | undefined {
  if (!text) return undefined;
  const clean = text
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Convert a numeric-looking string to a number; leave anything else as-is. */
export function toNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '' || !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return value;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : value;
}

/** Parse a number from a string, returning undefined when it is not numeric. */
export function parseNum(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** Render rows as RFC 4180 CSV (header row first). */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) lines.push(columns.map((col) => escape(row[col])).join(','));
  return lines.join('\n');
}

/** Accept either an array or a comma-separated string and return a clean array. */
export function toList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : value.split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return list.length > 0 ? list : undefined;
}

/** Round to a fixed number of decimals (for distances and averages). */
export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Simple min / max / average summary for a list of numbers. */
export function summarise(values: number[]): {
  count: number;
  min?: number;
  max?: number;
  avg?: number;
} {
  if (values.length === 0) return { count: 0 };
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: round(sum / values.length, 2),
  };
}

/** Current time in Singapore (UTC+8) as an ISO string with offset. */
export function nowSgt(): string {
  const now = new Date(Date.now() + 8 * 60 * 60_000);
  return now.toISOString().replace('Z', '+08:00');
}
