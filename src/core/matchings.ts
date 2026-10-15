/**
 * Perfect matchings of a tile's crossings and the non-crossing subset that
 * combination digits index into. Same enumeration order as the Spectre
 * project: the first point pairs with each later point in turn, recursing.
 */

export type Matching = readonly (readonly [number, number])[];

const cache = new Map<number, readonly Matching[]>();

function enumerateOn(indices: readonly number[]): Matching[] {
  if (indices.length === 0) return [[]];
  if (indices.length % 2 !== 0) return [];
  const [first, ...rest] = indices;
  const out: Matching[] = [];
  for (let i = 0; i < rest.length; i++) {
    const remaining = rest.slice(0, i).concat(rest.slice(i + 1));
    for (const sub of enumerateOn(remaining)) out.push([[first, rest[i]], ...sub]);
  }
  return out;
}

export function enumerateMatchings(n: number): readonly Matching[] {
  if (n < 0 || n % 2 !== 0) return [];
  const hit = cache.get(n);
  if (hit) return hit;
  const out = enumerateOn(Array.from({ length: n }, (_, i) => i));
  cache.set(n, out);
  return out;
}

const ncCache = new Map<number, readonly Matching[]>();

/**
 * Matchings whose chords don't cross when the points sit in cyclic order
 * around the tile. There are Catalan(n/2) of them: 1, 1, 2, 5, 14, 42, 132…
 */
export function nonCrossingMatchings(n: number): readonly Matching[] {
  const hit = ncCache.get(n);
  if (hit) return hit;
  const out = enumerateMatchings(n).filter((m) => {
    const pairs = m.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const);
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [a1, a2] = pairs[i];
        const [b1, b2] = pairs[j];
        if ((a1 < b1 && b1 < a2 && a2 < b2) || (b1 < a1 && a1 < b2 && b2 < a2)) return false;
      }
    }
    return true;
  });
  ncCache.set(n, out);
  return out;
}

export function catalan(k: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * 2 * (2 * i + 1)) / (i + 2);
  return Math.round(c);
}

/** Number of combination choices for a tile with `n` crossings (0 when odd). */
export function choiceCount(n: number): number {
  return n % 2 === 0 ? catalan(n / 2) : 0;
}

/**
 * Crossings this large get one fixed default pairing instead of an
 * enumerated list (Catalan(9) = 4862 is still fine; beyond that the UI
 * would be useless anyway).
 */
export const MAX_ENUMERATED_CROSSINGS = 18;

/**
 * The `index`-th non-crossing matching of `n` points. For very large `n`
 * falls back to pairing neighbours (0-1, 2-3, …), which never crosses.
 */
export function nonCrossingMatching(n: number, index: number): Matching | null {
  if (n % 2 !== 0) return null;
  if (n > MAX_ENUMERATED_CROSSINGS) {
    const out: [number, number][] = [];
    for (let i = 0; i < n; i += 2) out.push([i, i + 1]);
    return out;
  }
  const all = nonCrossingMatchings(n);
  return all[Math.max(0, Math.min(all.length - 1, index))] ?? null;
}
