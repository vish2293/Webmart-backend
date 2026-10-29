import type { FilterQuery } from 'mongoose';
import type { ProductRecord } from './product.model.js';

const maxTokens = 6;

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lower-case words of a phrase, as typed (no plural trimming). */
export const wordsOf = (keyword: string) =>
  (keyword.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, maxTokens);

const commonPrefixLength = (a: string, b: string) => {
  let length = 0;
  while (length < a.length && a[length] === b[length]) length += 1;
  return length;
};

/**
 * Words of a search phrase. Punctuation is dropped ("home & kitchen" → home, kitchen) and a
 * trailing plural "s" is trimmed so "headphones" still finds "Headphone Stand".
 */
export function tokenize(keyword: string) {
  const words = keyword.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .slice(0, maxTokens)
    .map((word) =>
      word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word,
    );
}

/**
 * Every word must appear somewhere in the name, category or description, in any order, so
 * "wireless headphones" finds "Headphones, Wireless". Matching is case-insensitive substring.
 */
export function buildSearchFilter(tokens: string[]): FilterQuery<ProductRecord> {
  return {
    $and: tokens.map((token) => {
      const pattern = { $regex: escapeRegex(token), $options: 'i' };
      return { $or: [{ name: pattern }, { category: pattern }, { description: pattern }] };
    }),
  };
}

type Searchable = Pick<ProductRecord, 'name' | 'category' | 'description' | 'rating'>;

/** Higher is a better match: name beats category beats description; word starts beat the middle of a word. */
export function scoreProduct(product: Searchable, tokens: string[], phrase: string) {
  const name = product.name.toLowerCase();
  const category = product.category.toLowerCase();
  const description = product.description.toLowerCase();
  const wordStart = (text: string, token: string) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(token)}`, 'u').test(text);

  let score = 0;
  const normalizedPhrase = phrase.toLowerCase().trim();
  if (name === normalizedPhrase) score += 20;
  else if (name.startsWith(normalizedPhrase)) score += 8;
  else if (name.includes(normalizedPhrase)) score += 5;

  for (const token of tokens) {
    if (wordStart(name, token)) score += 5;
    else if (name.includes(token)) score += 3;
    if (wordStart(category, token)) score += 2;
    if (description.includes(token)) score += 1;
  }
  // Ties go to better-rated products.
  return score + product.rating / 10;
}

/** Edit distance, capped: stops early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

/**
 * Replaces each misspelt word with the closest word the catalogue actually uses ("hedphones" →
 * "headphones"). A word is left alone if it already starts some catalogue word. Returns
 * undefined when nothing needed (or could be) corrected.
 */
export function correctSpelling(tokens: string[], vocabulary: string[]) {
  let changed = false;
  const corrected = tokens.map((token) => {
    if (vocabulary.some((word) => word.startsWith(token))) return token;
    const allowed = token.length <= 4 ? 1 : 2;
    let best: { word: string; rank: number } | undefined;
    for (const word of vocabulary) {
      const distance = editDistance(token, word.slice(0, token.length + 1), allowed);
      const full = distance <= allowed ? editDistance(token, word, allowed) : allowed + 1;
      const useful = Math.min(distance, full);
      // Fewer edits wins; among equals, the word sharing the longest start with what was typed.
      const rank = useful * 100 - commonPrefixLength(token, word);
      if (useful <= allowed && (!best || rank < best.rank)) best = { word, rank };
    }
    if (best) changed = true;
    return best?.word ?? token;
  });
  return changed ? corrected : undefined;
}

export const vocabularyFrom = (products: Pick<ProductRecord, 'name' | 'category'>[]) => [
  ...new Set(
    products.flatMap(
      (product) =>
        `${product.name} ${product.category}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [],
    ),
  ),
];
