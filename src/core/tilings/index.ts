import { chainTiling, validateChainSpec } from '../chain';
import { latticeTiling, validateLatticeSpec } from '../lattice';
import { similarityTiling, validateSimilaritySpec, type Tiling, type TilingSpec } from '../tiling';
import { chairTiling } from './chair';
import { penroseTiling } from './penrose';
import { hexTiling, spectreTiling } from './spectre';

export const BUILTIN_TILINGS: readonly Tiling[] = [hexTiling, spectreTiling, penroseTiling, chairTiling];

const custom = new Map<string, Tiling>();

export function validateTilingSpec(spec: TilingSpec): string[] {
  if (spec?.kind === 'lattice') return validateLatticeSpec(spec);
  if (spec?.kind === 'chain') return validateChainSpec(spec);
  if (spec?.kind === 'similarity') return validateSimilaritySpec(spec);
  return ['kind must be "similarity", "lattice" or "chain"'];
}

export function tilingFromSpec(spec: TilingSpec): Tiling {
  if (spec.kind === 'lattice') return latticeTiling(spec);
  if (spec.kind === 'chain') return chainTiling(spec);
  return similarityTiling(spec);
}

/** Register a data-defined tiling (imported, refined, or from the Substitution lab). */
export function registerCustomTiling(spec: TilingSpec): Tiling {
  if (BUILTIN_TILINGS.some((t) => t.id === spec.id)) throw new Error(`"${spec.id}" is a built-in tiling id`);
  const t = tilingFromSpec(spec);
  custom.set(t.id, t);
  return t;
}

export function allTilings(): Tiling[] {
  return [...BUILTIN_TILINGS, ...custom.values()];
}

export function getTiling(id: string): Tiling | undefined {
  return BUILTIN_TILINGS.find((t) => t.id === id) ?? custom.get(id);
}
