/**
 * Search utilities: tokenising, synonym expansion and relevance scoring.
 *
 * Based on mcp-datagovmy's search helpers, extended with Singapore-specific
 * synonyms (HDB, COE, CPF, NEA...) and word-prefix matching so that "rain"
 * matches "rainfall" but "ion" does not match "population".
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'by',
  'data',
  'dataset',
  'datasets',
  'for',
  'from',
  'how',
  'in',
  'is',
  'latest',
  'of',
  'on',
  'or',
  'sg',
  'show',
  'singapore',
  'the',
  'to',
  'what',
  'which',
  'with',
]);

/**
 * Synonym groups. Any term in a group expands to every other term in it.
 * Multi-word entries are matched as phrases.
 */
const SYNONYM_GROUPS: string[][] = [
  ['hdb', 'housing', 'flat', 'public housing', 'housing development board'],
  ['resale', 'resale flat', 'hdb resale'],
  ['coe', 'certificate of entitlement', 'vehicle quota'],
  ['cpf', 'central provident fund'],
  ['gdp', 'gross domestic product', 'economic growth'],
  ['cpi', 'consumer price index', 'inflation'],
  ['weather', 'rainfall', 'temperature', 'forecast', 'climate'],
  ['rain', 'rainfall', 'precipitation'],
  ['school', 'education', 'moe', 'student'],
  ['population', 'resident', 'demographic', 'census'],
  ['car', 'vehicle', 'motor vehicle'],
  ['carpark', 'car park', 'parking'],
  ['employment', 'labour', 'labor', 'job', 'workforce', 'unemployment'],
  ['wage', 'income', 'salary', 'earnings'],
  ['hawker', 'food centre', 'market'],
  ['dengue', 'aedes', 'mosquito'],
  ['health', 'healthcare', 'hospital', 'medical'],
  ['tourism', 'tourist', 'visitor arrival', 'hotel'],
  ['property', 'real estate', 'private residential', 'ura'],
  ['crime', 'police', 'offence'],
  ['tax', 'gst', 'iras', 'revenue'],
  ['air quality', 'psi', 'haze', 'pm2.5', 'pollutant'],
  ['transport', 'traffic', 'lta', 'road'],
  ['mrt', 'train', 'rail'],
  ['bus', 'bus stop', 'public transport'],
  ['electricity', 'energy', 'power'],
  ['water', 'pub', 'reservoir'],
  ['birth', 'fertility', 'newborn'],
  ['death', 'mortality'],
  ['marriage', 'divorce'],
  ['trade', 'import', 'export'],
  ['company', 'business', 'acra', 'enterprise', 'uen'],
  ['park', 'nature', 'nparks', 'green'],
  ['library', 'nlb', 'book'],
];

const SYNONYM_INDEX = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const term of group) {
    const existing = SYNONYM_INDEX.get(term) ?? [];
    SYNONYM_INDEX.set(term, [...new Set([...existing, ...group])]);
  }
}

/** Lowercase, strip punctuation (keeping "." inside numbers like pm2.5), split. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** Query terms with stopwords removed (falls back to all terms if all are stopwords). */
export function queryTerms(query: string): string[] {
  const all = tokenize(query);
  const filtered = all.filter((term) => !STOPWORDS.has(term));
  return [...new Set(filtered.length > 0 ? filtered : all)];
}

/** Expand one term with simple plural/singular forms and synonyms. */
export function expandTerm(term: string): string[] {
  const forms = new Set<string>([term]);
  if (term.length > 3 && term.endsWith('ies')) forms.add(`${term.slice(0, -3)}y`);
  else if (term.length > 3 && term.endsWith('s')) forms.add(term.slice(0, -1));
  else forms.add(`${term}s`);

  for (const form of [...forms]) {
    for (const synonym of SYNONYM_INDEX.get(form) ?? []) forms.add(synonym);
  }
  return [...forms];
}

/** Searchable text for one field: original lowercase text plus its word set. */
export interface SearchField {
  text: string;
  words: Set<string>;
  weight: number;
}

export function makeField(text: string | undefined, weight: number): SearchField {
  const lower = (text ?? '').toLowerCase();
  return { text: lower, words: new Set(tokenize(lower)), weight };
}

function fieldMatches(field: SearchField, form: string): boolean {
  if (form.includes(' ')) return field.text.includes(form);
  if (field.words.has(form)) return true;
  // Prefix match for longer terms ("rain" -> "rainfall"), avoids noisy substrings
  if (form.length >= 4) {
    for (const word of field.words) if (word.startsWith(form)) return true;
  }
  return false;
}

/**
 * Score a document (a set of weighted fields) against a query.
 * Returns 0 when no query term matches. fields[0] is treated as the title.
 *
 * - Exact phrase in a field:   + 4 x weight
 * - Each query term matched:   + weight of the best matching field
 *   (synonym/plural matches count 80%)
 * - Title focus bonus: titles mostly made of query words rank higher, so
 *   "General Information of Schools" beats "Number of Secondary Schools by..."
 * - Coverage multiplier: documents matching more of the query terms rank higher
 */
export function scoreDocument(query: string, fields: SearchField[]): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;

  let score = 0;
  let matchedTerms = 0;
  const titleWordsMatched = new Set<string>();
  const title = fields[0];

  const phrase = terms.join(' ');
  if (terms.length > 1) {
    for (const field of fields) if (field.text.includes(phrase)) score += 4 * field.weight;
  }

  for (const term of terms) {
    let best = 0;
    for (const form of expandTerm(term)) {
      const factor = form === term ? 1 : 0.8;
      for (const field of fields) {
        if (fieldMatches(field, form)) best = Math.max(best, field.weight * factor);
      }
      if (title) {
        for (const word of title.words) {
          if (word === form || (form.length >= 4 && word.startsWith(form)))
            titleWordsMatched.add(word);
        }
        if (form.includes(' ') && title.text.includes(form)) {
          for (const w of form.split(' ')) titleWordsMatched.add(w);
        }
      }
    }
    if (best > 0) {
      matchedTerms++;
      score += best;
    }
  }

  if (matchedTerms === 0) return 0;

  if (title) {
    const meaningful = [...title.words].filter((w) => !STOPWORDS.has(w));
    if (meaningful.length > 0) {
      const focus = meaningful.filter((w) => titleWordsMatched.has(w)).length / meaningful.length;
      score += 2 * focus;
    }
  }

  const coverage = matchedTerms / terms.length;
  return score * coverage * coverage;
}

/** Mild boost for recently updated items (used as a ranking tie-breaker). */
export function recencyBoost(lastUpdatedAt?: string): number {
  const time = lastUpdatedAt ? Date.parse(lastUpdatedAt) : NaN;
  if (Number.isNaN(time)) return 1;
  const ageDays = (Date.now() - time) / 86_400_000;
  if (ageDays < 365) return 1.15;
  if (ageDays < 3 * 365) return 1.05;
  return 1;
}

/** Fuzzy match a name against a list of candidates (case/space-insensitive). */
export function findBestName(input: string, candidates: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(input);
  if (!target) return undefined;
  const exact = candidates.find((c) => norm(c) === target);
  if (exact) return exact;
  const contains = candidates.filter((c) => norm(c).includes(target) || target.includes(norm(c)));
  if (contains.length > 0) return contains.sort((x, y) => x.length - y.length)[0];
  // Word-level overlap as a last resort
  const inputWords = new Set(tokenize(input));
  let best: { name: string; overlap: number } | undefined;
  for (const candidate of candidates) {
    const overlap = tokenize(candidate).filter((w) => inputWords.has(w)).length;
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { name: candidate, overlap };
  }
  return best?.name;
}
