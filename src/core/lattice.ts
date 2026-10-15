/**
 * Lattice substitutions: the Substitution lab's model.
 *
 * Every tile is one cell of a fixed grid (hexagons or squares). A supertile
 * is a set of cells (the slots), and each type says which type fills each
 * slot, turned by a grid rotation and optionally flipped. An integer
 * expansion matrix M says how far apart the supertiles of the next level
 * sit, so level n is
 *
 *   S_n(t) = ⋃_slots  M^(n-1)·c  +  O·S_(n-1)(child type)
 *
 * Because everything stays on the grid, "does the replacement work" has an
 * exact answer: no two tiles land on the same cell (overlap) and no cell is
 * walled in without a tile (hole).
 */

import { type Affine, type Pt } from './geom';
import { MAX_INSTANCES, paletteColor, type Prototile, type TileInstance, type Tiling } from './tiling';

export type GridKind = 'hex' | 'square';

/** 2x2 integer matrix [a, b, c, d] acting on column vectors: (x, y) -> (a x + b y, c x + d y). */
export type IMat = readonly [number, number, number, number];
export type Cell = readonly [number, number];

export interface LatticeChild {
  readonly type: string;
  /** Rotation in grid steps (60° for hexagons, 90° for squares). */
  readonly rot: number;
  readonly flip: boolean;
}

export interface LatticeSpec {
  readonly kind: 'lattice';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly grid: GridKind;
  /** Slot cells, in grid coordinates (axial for hexagons). */
  readonly cells: readonly Cell[];
  /** Expansion matrix in grid coordinates. */
  readonly matrix: IMat;
  readonly types: readonly { readonly id: string; readonly name: string; readonly color?: string }[];
  /** rules[type][cellKey] = child, or null for an empty slot. A missing entry means "same type, unturned". */
  readonly rules: Readonly<Record<string, Readonly<Record<string, LatticeChild | null>>>>;
  readonly defaultRoot?: string;
  readonly defaultLevel?: number;
  readonly maxLevel?: number;
}

export function cellKey(c: Cell): string {
  return `${c[0]},${c[1]}`;
}

// ---------------------------------------------------------------------------
// Grid geometry
// ---------------------------------------------------------------------------

const S3 = Math.sqrt(3);

interface Grid {
  /** Grid coordinates -> world (columns are the images of (1,0) and (0,1)). */
  readonly basis: readonly [number, number, number, number];
  readonly rot: IMat;
  readonly flip: IMat;
  readonly steps: number;
  readonly neighbours: readonly Cell[];
  /** Prototile outline, edge length 1, centred on the origin. */
  readonly pts: readonly Pt[];
}

export const GRIDS: Readonly<Record<GridKind, Grid>> = {
  hex: {
    basis: [S3, S3 / 2, 0, 1.5],
    rot: [0, -1, 1, 1],
    flip: [1, 1, 0, -1],
    steps: 6,
    neighbours: [
      [1, 0],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [0, -1],
      [1, -1],
    ],
    pts: Array.from({ length: 6 }, (_, k) => ({ x: Math.cos(((30 + 60 * k) * Math.PI) / 180), y: Math.sin(((30 + 60 * k) * Math.PI) / 180) })),
  },
  square: {
    basis: [1, 0, 0, 1],
    rot: [0, -1, 1, 0],
    flip: [1, 0, 0, -1],
    steps: 4,
    neighbours: [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ],
    pts: [
      { x: 0.5, y: -0.5 },
      { x: 0.5, y: 0.5 },
      { x: -0.5, y: 0.5 },
      { x: -0.5, y: -0.5 },
    ],
  },
};

export function imul(A: IMat, B: IMat): IMat {
  return [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
}

export function iapply(A: IMat, v: Cell): Cell {
  return [A[0] * v[0] + A[1] * v[1], A[2] * v[0] + A[3] * v[1]];
}

export function idet(A: IMat): number {
  return A[0] * A[3] - A[1] * A[2];
}

export const IID: IMat = [1, 0, 0, 1];

function ipow(A: IMat, n: number): IMat {
  let r = IID;
  for (let i = 0; i < n; i++) r = imul(r, A);
  return r;
}

/** Orientation matrix for a child: flip first, then rotate. */
export function orientation(grid: GridKind, rot: number, flip: boolean): IMat {
  const g = GRIDS[grid];
  const r = ipow(g.rot, ((rot % g.steps) + g.steps) % g.steps);
  return flip ? imul(r, g.flip) : r;
}

/** Grid-coordinate linear map -> world linear map. */
function worldLinear(grid: GridKind, A: IMat): [number, number, number, number] {
  const [p, q, r, s] = GRIDS[grid].basis;
  const det = p * s - q * r;
  const inv = [s / det, -q / det, -r / det, p / det];
  const BA = [p * A[0] + q * A[2], p * A[1] + q * A[3], r * A[0] + s * A[2], r * A[1] + s * A[3]];
  return [BA[0] * inv[0] + BA[1] * inv[2], BA[0] * inv[1] + BA[1] * inv[3], BA[2] * inv[0] + BA[3] * inv[2], BA[2] * inv[1] + BA[3] * inv[3]];
}

export function cellCenter(grid: GridKind, c: Cell): Pt {
  const [p, q, r, s] = GRIDS[grid].basis;
  return { x: p * c[0] + q * c[1], y: r * c[0] + s * c[1] };
}

export function leafXform(grid: GridKind, pos: Cell, O: IMat): Affine {
  const [a, b, c, d] = worldLinear(grid, O);
  const t = cellCenter(grid, pos);
  return [a, b, t.x, c, d, t.y];
}

// ---------------------------------------------------------------------------
// Growing supertiles
// ---------------------------------------------------------------------------

export interface LatticeLeaf {
  readonly pos: Cell;
  readonly O: IMat;
  readonly type: string;
  /** Which top-level slot the leaf sits in (for drawing child supertile outlines). */
  readonly slot?: number;
}

/** The world edge facing grid direction j, as a pair of prototile vertex indices (cells aren't turned for this). */
export function edgeFacing(grid: GridKind, j: number): [number, number] {
  if (grid === 'hex') return [(j + 5) % 6, j % 6];
  return [j % 4, (j + 1) % 4];
}

export function childOf(spec: LatticeSpec, parent: string, c: Cell): LatticeChild | null {
  const r = spec.rules[parent]?.[cellKey(c)];
  return r === undefined ? { type: parent, rot: 0, flip: false } : r;
}

/** The leaves of a level-`level` supertile of type `root`. */
export function growLattice(spec: LatticeSpec, root: string, level: number, cap = MAX_INSTANCES): LatticeLeaf[] {
  const memo = new Map<string, LatticeLeaf[]>();
  const grow = (type: string, n: number): LatticeLeaf[] => {
    const k = `${type}/${n}`;
    const hit = memo.get(k);
    if (hit) return hit;
    let out: LatticeLeaf[];
    if (n === 0) out = [{ pos: [0, 0], O: IID, type }];
    else {
      out = [];
      const Mn = ipow(spec.matrix, n - 1);
      for (const c of spec.cells) {
        const ch = childOf(spec, type, c);
        if (!ch) continue;
        const O = orientation(spec.grid, ch.rot, ch.flip);
        const base = iapply(Mn, c);
        const slot = spec.cells.indexOf(c);
        for (const leaf of grow(ch.type, n - 1)) {
          const p = iapply(O, leaf.pos);
          out.push({ pos: [base[0] + p[0], base[1] + p[1]], O: imul(O, leaf.O), type: leaf.type, slot });
          if (out.length > cap) break;
        }
        if (out.length > cap) break;
      }
    }
    memo.set(k, out);
    return out;
  };
  return grow(root, level);
}

export interface LevelCheck {
  readonly level: number;
  readonly tiles: number;
  readonly overlaps: number;
  readonly holes: number;
  /** Cells covered more than once (for drawing). */
  readonly overlapCells: readonly Cell[];
  readonly holeCells: readonly Cell[];
}

/** Overlapping and walled-in cells of one supertile. */
export function checkLeaves(spec: LatticeSpec, leaves: readonly LatticeLeaf[], level: number): LevelCheck {
  const count = new Map<string, number>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const l of leaves) {
    const k = cellKey(l.pos);
    count.set(k, (count.get(k) ?? 0) + 1);
    minX = Math.min(minX, l.pos[0]);
    maxX = Math.max(maxX, l.pos[0]);
    minY = Math.min(minY, l.pos[1]);
    maxY = Math.max(maxY, l.pos[1]);
  }
  const overlapCells: Cell[] = [];
  let overlaps = 0;
  for (const [k, n] of count) {
    if (n > 1) {
      overlaps += n - 1;
      overlapCells.push(k.split(',').map(Number) as unknown as Cell);
    }
  }
  // Flood the empty cells from just outside the bounding box; any empty cell
  // inside the box that the flood never reaches is a hole.
  const holeCells: Cell[] = [];
  if (leaves.length) {
    minX -= 1;
    maxX += 1;
    minY -= 1;
    maxY += 1;
    const seen = new Set<string>();
    const stack: Cell[] = [[minX, minY]];
    seen.add(cellKey([minX, minY]));
    const nb = GRIDS[spec.grid].neighbours;
    while (stack.length) {
      const c = stack.pop()!;
      for (const d of nb) {
        const n: Cell = [c[0] + d[0], c[1] + d[1]];
        if (n[0] < minX || n[0] > maxX || n[1] < minY || n[1] > maxY) continue;
        const k = cellKey(n);
        if (seen.has(k) || count.has(k)) continue;
        seen.add(k);
        stack.push(n);
      }
    }
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const k = cellKey([x, y]);
        if (!count.has(k) && !seen.has(k)) holeCells.push([x, y]);
      }
    }
  }
  return { level, tiles: leaves.length, overlaps, holes: holeCells.length, overlapCells, holeCells };
}

/** Check every type's supertile at levels 1..maxLevel; the worst result per level. */
export function checkSpec(spec: LatticeSpec, maxLevel: number, cap = 40_000): { perType: Record<string, LevelCheck[]>; firstBad: number | null } {
  const perType: Record<string, LevelCheck[]> = {};
  let firstBad: number | null = null;
  for (const t of spec.types) {
    perType[t.id] = [];
    for (let lv = 1; lv <= maxLevel; lv++) {
      const leaves = growLattice(spec, t.id, lv, cap);
      if (leaves.length > cap) break;
      const chk = checkLeaves(spec, leaves, lv);
      perType[t.id].push(chk);
      if ((chk.overlaps || chk.holes) && (firstBad === null || lv < firstBad)) firstBad = lv;
    }
  }
  return { perType, firstBad };
}

// ---------------------------------------------------------------------------
// Expansion matrices
// ---------------------------------------------------------------------------

export interface ExpansionOption {
  readonly matrix: IMat;
  /** The slots are distinct mod M, so unturned copies are guaranteed to tile. */
  readonly residues: boolean;
  /** A rotation + scaling (+ mirror) in the plane, rather than a shear. */
  readonly similarity: boolean;
  readonly mirror: boolean;
  readonly label: string;
  /** |rotation| in degrees for similarities (for sorting). */
  readonly turn: number;
}

function residueComplete(M: IMat, cells: readonly Cell[]): boolean {
  const det = idet(M);
  // c ≡ c' (mod M) iff M^-1 (c - c') is integral; adj(M) (c - c') ≡ 0 mod det.
  const adj: IMat = [M[3], -M[1], -M[2], M[0]];
  const seen = new Set<string>();
  for (const c of cells) {
    const v = iapply(adj, c);
    const m = Math.abs(det);
    const k = `${((v[0] % m) + m) % m},${((v[1] % m) + m) % m}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

export function expansionOptions(grid: GridKind, cells: readonly Cell[], range = 4): ExpansionOption[] {
  const n = cells.length;
  const out: ExpansionOption[] = [];
  if (n < 2) return out;
  for (let a = -range; a <= range; a++)
    for (let b = -range; b <= range; b++)
      for (let c = -range; c <= range; c++)
        for (let d = -range; d <= range; d++) {
          const M: IMat = [a, b, c, d];
          if (Math.abs(idet(M)) !== n) continue;
          // Both eigenvalues must expand, or the supertiles collapse.
          const tr = a + d;
          const det = idet(M);
          const disc = tr * tr - 4 * det;
          const minAbs = disc >= 0 ? Math.min(Math.abs((tr + Math.sqrt(disc)) / 2), Math.abs((tr - Math.sqrt(disc)) / 2)) : Math.sqrt(Math.abs(det));
          if (minAbs <= 1.0001) continue;
          const W = worldLinear(grid, M);
          const s2 = Math.abs(W[0] * W[3] - W[1] * W[2]);
          const similarity = Math.abs(W[0] * W[0] + W[2] * W[2] - s2) < 1e-6 && Math.abs(W[1] * W[1] + W[3] * W[3] - s2) < 1e-6 && Math.abs(W[0] * W[1] + W[2] * W[3]) < 1e-6;
          const mirror = det < 0;
          const residues = residueComplete(M, cells);
          let label: string;
          if (similarity) {
            const ang = (Math.atan2(W[2], W[0]) * 180) / Math.PI;
            label = `×√${n}${Number.isInteger(Math.sqrt(n)) ? ` (×${Math.sqrt(n)})` : ''}, turn ${ang.toFixed(1)}°${mirror ? ', mirrored' : ''}`;
          } else label = `shear [${a} ${b}; ${c} ${d}]${mirror ? ', mirrored' : ''}`;
          const turn = similarity ? Math.abs((Math.atan2(W[2], W[0]) * 180) / Math.PI) : 999;
          out.push({ matrix: M, residues, similarity, mirror, label, turn });
        }
  const size = (o: ExpansionOption) => o.matrix.reduce((s, x) => s + Math.abs(x), 0);
  out.sort((x, y) => Number(y.residues) - Number(x.residues) || Number(y.similarity) - Number(x.similarity) || Number(x.mirror) - Number(y.mirror) || x.turn - y.turn || size(x) - size(y));
  return out.slice(0, 40);
}

// ---------------------------------------------------------------------------
// Substitution matrix
// ---------------------------------------------------------------------------

export interface SubstitutionStats {
  readonly types: readonly string[];
  /** counts[i][j] = how many type-j children a type-i supertile has. */
  readonly counts: readonly (readonly number[])[];
  readonly primitive: boolean;
  /** Perron eigenvalue: growth in tile count per level. */
  readonly growth: number;
  /** Long-run share of each type. */
  readonly frequencies: readonly number[];
  /** Types that never appear inside any supertile. */
  readonly unused: readonly string[];
}

export function substitutionStats(spec: LatticeSpec): SubstitutionStats {
  const types = spec.types.map((t) => t.id);
  const idx = new Map(types.map((t, i) => [t, i]));
  const k = types.length;
  const counts = types.map((t) => {
    const row = new Array<number>(k).fill(0);
    for (const c of spec.cells) {
      const ch = childOf(spec, t, c);
      if (ch && idx.has(ch.type)) row[idx.get(ch.type)!]++;
    }
    return row;
  });
  // Primitive: some power of the matrix is strictly positive (Wielandt bound).
  let P = counts.map((r) => r.map((x) => (x > 0 ? 1 : 0)));
  const A = P.map((r) => [...r]);
  let primitive = false;
  for (let step = 0; step < (k - 1) * (k - 1) + 2; step++) {
    if (P.every((r) => r.every((x) => x > 0))) {
      primitive = true;
      break;
    }
    P = P.map((r) => A[0].map((_, j) => (r.some((x, m) => x > 0 && A[m][j] > 0) ? 1 : 0)));
  }
  // Power iteration on the transpose gives type frequencies.
  let v = new Array<number>(k).fill(1 / k);
  let growth = 0;
  for (let it = 0; it < 200; it++) {
    const w = new Array<number>(k).fill(0);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) w[j] += v[i] * counts[i][j];
    const s = w.reduce((x, y) => x + y, 0);
    if (s === 0) break;
    growth = s / v.reduce((x, y) => x + y, 0);
    v = w.map((x) => x / s);
  }
  const used = new Set<string>();
  for (const t of types) for (const c of spec.cells) {
    const ch = childOf(spec, t, c);
    if (ch) used.add(ch.type);
  }
  return { types, counts, primitive, growth, frequencies: v, unused: types.filter((t) => !used.has(t)) };
}

// ---------------------------------------------------------------------------
// As a Tiling
// ---------------------------------------------------------------------------

export function validateLatticeSpec(spec: LatticeSpec): string[] {
  const errs: string[] = [];
  if (spec.kind !== 'lattice') errs.push('kind must be "lattice"');
  if (!GRIDS[spec.grid]) errs.push('grid must be "hex" or "square"');
  if (!Array.isArray(spec.cells) || spec.cells.length < 2) errs.push('needs at least two cells');
  if (!Array.isArray(spec.matrix) || spec.matrix.length !== 4) errs.push('matrix must have four entries');
  if (!Array.isArray(spec.types) || spec.types.length === 0) errs.push('needs at least one type');
  const ids = new Set((spec.types ?? []).map((t) => t.id));
  for (const [t, row] of Object.entries(spec.rules ?? {})) {
    if (!ids.has(t)) errs.push(`rule for unknown type ${t}`);
    for (const ch of Object.values(row)) if (ch && !ids.has(ch.type)) errs.push(`${t}: child of unknown type ${ch.type}`);
  }
  return errs;
}

export function latticeTiling(spec: LatticeSpec): Tiling {
  const errs = validateLatticeSpec(spec);
  if (errs.length) throw new Error(errs.join('; '));
  const pts = GRIDS[spec.grid].pts;
  const prototiles: Prototile[] = spec.types.map((t, i) => ({ id: t.id, name: t.name, color: t.color ?? paletteColor(i), pts }));
  const n = spec.cells.length;
  // Aim for a few thousand tiles at the default level.
  const defaultLevel = spec.defaultLevel ?? Math.max(2, Math.min(6, Math.floor(Math.log(3000) / Math.log(n))));
  const maxLevel = spec.maxLevel ?? Math.max(defaultLevel, Math.floor(Math.log(60000) / Math.log(n)));
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? `Built in the Substitution lab: ${n} ${spec.grid === 'hex' ? 'hexagons' : 'squares'} per supertile.`,
    prototiles,
    roots: prototiles.map((p) => p.id),
    defaultRoot: spec.defaultRoot ?? prototiles[0].id,
    defaultLevel,
    maxLevel,
    deriveLevel: Math.max(2, Math.min(defaultLevel, Math.floor(Math.log(5000) / Math.log(n)))),
    spec,
    generate(level, root): readonly TileInstance[] {
      return growLattice(spec, root, level)
        .slice(0, MAX_INSTANCES)
        .map((l, id) => ({ id, type: l.type, xform: leafXform(spec.grid, l.pos, l.O) }));
    },
  };
}

/** Split types by the slot they fill, like `refineSpec` for similarity tilings. */
export function refineLatticeSpec(spec: LatticeSpec): LatticeSpec {
  const slots: { parent: string; cell: Cell; child: LatticeChild }[] = [];
  for (const t of spec.types) for (const c of spec.cells) {
    const ch = childOf(spec, t.id, c);
    if (ch) slots.push({ parent: t.id, cell: c, child: ch });
  }
  const sid = (parent: string, c: Cell) => `${parent}@${cellKey(c)}`;
  const nameOf = new Map(spec.types.map((t) => [t.id, t.name]));
  const types = slots.map((s, i) => ({ id: sid(s.parent, s.cell), name: `${nameOf.get(s.child.type)}@${nameOf.get(s.parent)}${i}`, color: paletteColor(i) }));
  const rules: Record<string, Record<string, LatticeChild | null>> = {};
  for (const s of slots) {
    const row: Record<string, LatticeChild | null> = {};
    for (const c of spec.cells) {
      const ch = childOf(spec, s.child.type, c);
      row[cellKey(c)] = ch ? { ...ch, type: sid(s.child.type, c) } : null;
    }
    rules[sid(s.parent, s.cell)] = row;
  }
  const root = slots.find((s) => s.child.type === (spec.defaultRoot ?? spec.types[0].id)) ?? slots[0];
  return { ...spec, id: `${spec.id}-refined`, name: `${spec.name}, refined`, types, rules, defaultRoot: sid(root.parent, root.cell) };
}
