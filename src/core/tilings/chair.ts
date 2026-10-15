/**
 * The chair tiling: an L-tromino that splits into four half-size copies.
 * The long sides are cut into unit edges so the tiling is edge-to-edge.
 */

import { similarityTiling, type SimilaritySpec } from '../tiling';

export const chairSpec: SimilaritySpec = {
  kind: 'similarity',
  id: 'chair',
  name: 'Chair',
  description: 'An L-shaped tromino that tiles a twice-as-big copy of itself with four copies. Every edge is one unit.',
  prototiles: [
    {
      id: 'chair',
      name: 'Chair',
      color: '#7cc6a4',
      pts: [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 2],
        [0, 2],
        [0, 1],
      ],
    },
  ],
  inflation: 2,
  rules: {
    chair: [
      { type: 'chair', v0: [0.5, 0.5], v1: [1, 0.5] },
      { type: 'chair', v0: [0, 0], v1: [0.5, 0] },
      { type: 'chair', v0: [2, 0], v1: [2, 0.5] },
      { type: 'chair', v0: [0, 2], v1: [0, 1.5] },
    ],
  },
  defaultLevel: 5,
  maxLevel: 8,
  deriveLevel: 5,
  defaultRoot: 'chair',
};

export const chairTiling = similarityTiling(chairSpec);
