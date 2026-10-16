/** Starting points for the Substitution lab. */

import { cellKey, expansionOptions, type Cell, type GridKind, type LatticeChild, type LatticeSpec } from './lattice';

const TYPE3 = [
  { id: 'A', name: 'A', color: '#f4c95d' },
  { id: 'B', name: 'B', color: '#8fb3e8' },
  { id: 'C', name: 'C', color: '#e89a8f' },
];

function make(
  id: string,
  name: string,
  description: string,
  grid: GridKind,
  cells: Cell[],
  table: Record<string, (string | [string, number, boolean?] | null)[]>,
): LatticeSpec {
  const opts = expansionOptions(grid, cells);
  const rules: Record<string, Record<string, LatticeChild | null>> = {};
  for (const [t, row] of Object.entries(table)) {
    rules[t] = {};
    row.forEach((v, i) => {
      rules[t][cellKey(cells[i])] = v === null ? null : typeof v === 'string' ? { type: v, rot: 0, flip: false } : { type: v[0], rot: v[1], flip: !!v[2] };
    });
  }
  return { kind: 'lattice', id, name, description, grid, cells, matrix: opts[0]?.matrix ?? [2, 0, 0, 2], types: TYPE3, rules };
}

const FLOWER: Cell[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
];

export const LATTICE_PRESETS: readonly LatticeSpec[] = [
  make('lab-flower', 'Hex flower', 'Seven hexagons: a centre and its ring. Grows into Gosper islands.', 'hex', FLOWER, {
    A: ['B', 'A', 'C', 'A', 'C', 'A', 'C'],
    B: ['A', 'B', 'C', 'B', 'A', 'B', 'C'],
    C: ['A', 'C', 'B', 'A', 'B', 'C', 'A'],
  }),
  make(
    'lab-triad',
    'Hex triad',
    'Three hexagons round a point. The supertile turns 30° and grows by √3 each level.',
    'hex',
    [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    { A: ['A', 'B', 'C'], B: ['C', 'A', 'B'], C: ['B', 'C', 'A'] },
  ),
  make(
    'lab-square4',
    'Square quartet',
    'Two by two squares, doubling each level. Try turning and flipping the children.',
    'square',
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
    { A: ['A', 'B', 'C', 'A'], B: ['B', 'A', 'A', 'C'], C: ['C', 'C', 'B', 'A'] },
  ),
  make(
    'lab-plus',
    'Square plus',
    'A plus of five squares. It grows by √5 and turns about 26.6° each level, so the supertiles spiral.',
    'square',
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ],
    { A: ['B', 'A', 'C', 'A', 'C'], B: ['A', 'C', 'B', 'B', 'A'], C: ['C', 'A', 'A', 'B', 'B'] },
  ),
];
