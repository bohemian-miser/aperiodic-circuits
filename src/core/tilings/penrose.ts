/**
 * Penrose rhombs (P3), grown as Robinson triangles: each rhomb is two
 * triangles sharing its diagonal, which is drawn faintly. Subdivision as in
 * Jeff Preshing's well-known write-up, with golden-ratio inflation.
 */

import { lerpPt, type Pt } from '../geom';
import { childFromImages, similarityTiling, type SimilaritySpec } from '../tiling';

const PHI = (1 + Math.sqrt(5)) / 2;
const c36 = Math.cos(Math.PI / 5);
const s36 = Math.sin(Math.PI / 5);

// Thin half-rhomb: apex 36°, legs 1, base 1/φ. Vertices A (apex), B, C.
const THIN: Pt[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: c36, y: s36 },
];
// Thick half-rhomb: apex 108°, legs 1, base φ.
const THICK: Pt[] = [
  { x: 1, y: 0 },
  { x: PHI * c36, y: PHI * s36 },
  { x: 0, y: 0 },
];

function thinRule() {
  const [A, B, C] = THIN;
  const P = lerpPt(A, B, 1 / PHI);
  return [childFromImages(THIN, 'thin', [C, P, B]), childFromImages(THICK, 'thick', [P, C, A])];
}

function thickRule() {
  const [A, B, C] = THICK;
  const Q = lerpPt(B, A, 1 / PHI);
  const R = lerpPt(B, C, 1 / PHI);
  return [
    childFromImages(THICK, 'thick', [R, C, A]),
    childFromImages(THICK, 'thick', [Q, R, B]),
    childFromImages(THIN, 'thin', [R, Q, A]),
  ];
}

const xy = (p: Pt) => [p.x, p.y] as const;

export const penroseSpec: SimilaritySpec = {
  kind: 'similarity',
  id: 'penrose',
  name: 'Penrose rhombs (P3)',
  description:
    'Thin and thick rhombs, each split into two Robinson triangles along a diagonal. Five-fold symmetry, golden-ratio inflation.',
  prototiles: [
    { id: 'thin', name: 'Thin half', color: '#8fb3e8', pts: THIN.map(xy), hiddenEdges: [1] },
    { id: 'thick', name: 'Thick half', color: '#f4c95d', pts: THICK.map(xy), hiddenEdges: [1] },
  ],
  inflation: PHI,
  rules: { thin: thinRule(), thick: thickRule() },
  defaultLevel: 8,
  maxLevel: 11,
  deriveLevel: 9,
  defaultRoot: 'thick',
};

export const penroseTiling = similarityTiling(penroseSpec);
