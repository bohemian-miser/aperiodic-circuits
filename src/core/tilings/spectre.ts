/**
 * The Spectre (Tile(1,1)) and its combinatorially equivalent hexagons, grown
 * with the supertile construction from the Spectre project (itself a port of
 * Craig Kaplan's app). Nine tile types: the Mystic (Gamma) is treated as one
 * prototile, so the seams inside it never appear.
 *
 * Both are plain chain specs (see `chain.ts`), the same data the Substitution
 * lab's chain mode edits; this file only adds the Spectre project's edge
 * labels as a preset.
 */

import { chainTiling, MYSTIC, spectreChainSpec, SPECTRE_TYPES } from '../chain';
import { seamsFromLabels, type RuleSet } from '../ruleset';
import type { RuleSetPreset, Tiling } from '../tiling';

export { HEX_PTS, SPECTRE_PTS } from '../chain';
export const TYPES = SPECTRE_TYPES;

const SPECTRE_LABELS: Record<string, readonly string[]> = {
  Delta: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-3.1A', '-3.0A', '-6.1A', '-6.0A'],
  Theta: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '8.0A', '2.0B', '2.1B', '2.2B', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Lambda: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-8.0A', '-2.2A', '-2.1A', '-2.0A'],
  Xi: ['-1.2A', '-1.1A', '-1.0A', '5.0A', '5.1A', '8.0A', '2.0A', '2.1A', '2.2A', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Pi: ['-1.2A', '-1.1A', '-1.0A', '5.0A', '5.1A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-8.0A', '-2.2A', '-2.1A', '-2.0A'],
  Sigma: ['4.2A', '4.3A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-3.1A', '-3.0A', '4.0A', '4.1A'],
  Phi: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '5.0A', '5.1A', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Psi: ['-1.2A', '-1.1A', '-1.0A', '5.0A', '5.1A', '-5.1A', '-5.0A', '5.0B', '5.1B', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Gamma2: ['-7.1A', '-7.0A', '-3.1A', '-3.0A', '6.0A', '6.1A', '-4.3A', '-4.2A', '-4.1A', '-4.0A', '2.0A', '2.1A', '-7.3A', '-7.2A'],
  Gamma1: ['-1.2A', '-1.1A', '-1.0A', '1.0A', '1.1A', '1.2A', '7.0A', '7.1A', '7.2A', '7.3A', '2.2A', '-2.2A', '-2.1A', '-2.0A'],
};

/** Spectre-project labels for the hexagons (6 edges each). */
const HEX_LABELS: Record<string, readonly string[]> = {
  Delta: ['3.0A', '2.0A', '-5.0A', '1.0A', '-3.0A', '-6.0A'],
  Theta: ['3.0A', '2.0A', '8.0A', '2.0B', '0.0A', '-2.0A'],
  Lambda: ['3.0A', '2.0A', '-5.0A', '1.0A', '-8.0A', '-2.0A'],
  Xi: ['-1.0A', '5.0A', '8.0A', '2.0A', '0.0A', '-2.0A'],
  Pi: ['-1.0A', '5.0A', '-5.0A', '1.0A', '-8.0A', '-2.0A'],
  Sigma: ['6.0A', '2.0A', '-5.0A', '1.0A', '-3.0A', '4.0A'],
  Phi: ['3.0A', '2.0A', '-5.0A', '5.0A', '0.0A', '-2.0A'],
  Psi: ['-1.0A', '5.0A', '-5.0A', '5.0B', '0.0A', '-2.0A'],
  Gamma: ['-1.0A', '1.0A', '-3.0A', '-4.0A', '2.0A', '-2.0A'],
};

/** Labels on the Mystic's outer boundary, carried over from Gamma1 / Gamma2. */
const MYSTIC_LABELS = MYSTIC.source.map((s) => (s.poly === 0 ? SPECTRE_LABELS.Gamma1 : SPECTRE_LABELS.Gamma2)[s.edge]);

function labelsPreset(name: string, labels: Record<string, readonly string[]>): RuleSetPreset {
  return {
    id: 'spectre-labels',
    name,
    description: 'The 0–8 seam classes from the Spectre project (the Mystic counted as one tile, so class 7 is gone).',
    build: (t): RuleSet => ({
      id: `${t.id}:spectre-labels`,
      name,
      tilingId: t.id,
      seams: Object.fromEntries(TYPES.map((ty) => [ty, seamsFromLabels(labels[ty])])),
    }),
  };
}

export const spectreTiling: Tiling = chainTiling(spectreChainSpec('spectre'), [
  labelsPreset('Spectre classes 0–8', { ...SPECTRE_LABELS, Gamma: MYSTIC_LABELS }),
]);

export const hexTiling: Tiling = chainTiling(spectreChainSpec('hex'), [labelsPreset('Spectre classes 0–8', HEX_LABELS)]);
