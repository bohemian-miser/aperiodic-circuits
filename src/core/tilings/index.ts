import { similarityTiling, type SimilaritySpec, type Tiling } from '../tiling';
import { chairTiling } from './chair';
import { penroseTiling } from './penrose';
import { hexTiling, spectreTiling } from './spectre';

export const BUILTIN_TILINGS: readonly Tiling[] = [hexTiling, spectreTiling, penroseTiling, chairTiling];

const custom = new Map<string, Tiling>();

/** Register a JSON-defined tiling (from an imported rule set or the builder). */
export function registerCustomTiling(spec: SimilaritySpec): Tiling {
  if (BUILTIN_TILINGS.some((t) => t.id === spec.id)) throw new Error(`"${spec.id}" is a built-in tiling id`);
  const t = similarityTiling(spec);
  custom.set(t.id, t);
  return t;
}

export function allTilings(): Tiling[] {
  return [...BUILTIN_TILINGS, ...custom.values()];
}

export function getTiling(id: string): Tiling | undefined {
  return BUILTIN_TILINGS.find((t) => t.id === id) ?? custom.get(id);
}
