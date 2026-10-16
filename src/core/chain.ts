/**
 * Chain substitutions: how the Spectre is actually built, as data.
 *
 * Every tile has four "quad" points. A supertile is a chain of slots: slot 0
 * sits as it is (optionally flipped); each later slot turns by a running
 * angle and is moved so its quad point `to` lands on the previous slot's
 * quad point `from`. The supertile's own quad is four of its children's quad
 * points, so the same chain applies again at the next level, with the
 * children now being supertiles. Optionally every level is mirrored, as the
 * Spectre's is. Which type fills each slot (or nothing) is per type.
 *
 * The Spectre and its hexagons are this with seven steps
 *   [60,3,1] [0,2,0] [60,3,1] [60,3,1] [0,2,0] [60,3,1] [-120,3,3]
 * and the Spectre project's slot table.
 */

import { IDENT, REFLECT_X, mul, radians, transPt, trot, ttrans, type Affine, type Pt } from './geom';
import { unionBoundary } from './polygon';
import { MAX_INSTANCES, paletteColor, type HierarchyChild, type Prototile, type RuleSetPreset, type TileInstance, type Tiling } from './tiling';

export type ChainBase = 'hex' | 'spectre';

export interface ChainStep {
  /** Added to the running angle, in degrees. */
  readonly turn: number;
  /** Quad point of the previous slot to attach to. */
  readonly from: number;
  /** Quad point of this slot that goes there. */
  readonly to: number;
  readonly flip?: boolean;
}

export interface ChainSpec {
  readonly kind: 'chain';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly base: ChainBase;
  /** Vertex indices of the base tile's four quad points. */
  readonly quad: readonly [number, number, number, number];
  /** Flip slot 0. */
  readonly firstFlip?: boolean;
  /** Slots 1..n; there are steps.length + 1 slots. */
  readonly steps: readonly ChainStep[];
  /** The supertile's quad: [slot, quad point] four times. */
  readonly superQuad: readonly (readonly [number, number])[];
  /** Mirror every level (the Spectre does). */
  readonly mirror: boolean;
  readonly types: readonly { readonly id: string; readonly name: string; readonly color?: string; readonly mystic?: boolean }[];
  /** rules[type][slot] = child type, or null for an empty slot. */
  readonly rules: Readonly<Record<string, readonly (string | null)[]>>;
  readonly defaultRoot?: string;
  readonly defaultLevel?: number;
  readonly maxLevel?: number;
}

export const SPECTRE_PTS: readonly Pt[] = [
  { x: 0, y: 0 },
  { x: 1.0, y: 0.0 },
  { x: 1.5, y: -0.8660254037844386 },
  { x: 2.366025403784439, y: -0.36602540378443865 },
  { x: 2.366025403784439, y: 0.6339745962155614 },
  { x: 3.366025403784439, y: 0.6339745962155614 },
  { x: 3.866025403784439, y: 1.5 },
  { x: 3.0, y: 2.0 },
  { x: 2.133974596215561, y: 1.5 },
  { x: 1.6339745962155614, y: 2.3660254037844393 },
  { x: 0.6339745962155614, y: 2.3660254037844393 },
  { x: -0.3660254037844386, y: 2.3660254037844393 },
  { x: -0.866025403784439, y: 1.5 },
  { x: 0.0, y: 1.0 },
];

const H = 0.8660254037844386;
export const HEX_PTS: readonly Pt[] = [
  { x: 0, y: 0 },
  { x: 1.0, y: 0.0 },
  { x: 1.5, y: H },
  { x: 1, y: 2 * H },
  { x: 0, y: 2 * H },
  { x: -0.5, y: H },
];

/** Gamma2's placement inside the Mystic (Spectre project `buildSpectreBase`). */
export const GAMMA2_XFORM: Affine = mul(ttrans(SPECTRE_PTS[8].x, SPECTRE_PTS[8].y), trot(Math.PI / 6));
export const MYSTIC = unionBoundary([SPECTRE_PTS, SPECTRE_PTS], [IDENT, GAMMA2_XFORM]);

export function basePts(base: ChainBase): readonly Pt[] {
  return base === 'hex' ? HEX_PTS : SPECTRE_PTS;
}

/** Turn steps that keep the base on its own grid of directions. */
export function turnStep(base: ChainBase): number {
  return base === 'hex' ? 60 : 30;
}

export function slotCount(spec: ChainSpec): number {
  return spec.steps.length + 1;
}

/** Child transforms for one level, given the current quad; and the next quad. */
export function chainStep(spec: ChainSpec, quad: readonly Pt[]): { Ts: Affine[]; quad: Pt[] } {
  const Ts: Affine[] = [spec.firstFlip ? REFLECT_X : IDENT];
  let total = 0;
  for (const st of spec.steps) {
    total += st.turn;
    const rot = st.flip ? mul(trot(radians(total)), REFLECT_X) : trot(radians(total));
    const to = transPt(rot, quad[st.to]);
    const prev = transPt(Ts[Ts.length - 1], quad[st.from]);
    Ts.push(mul(ttrans(prev.x - to.x, prev.y - to.y), rot));
  }
  const out = spec.mirror ? Ts.map((T) => mul(REFLECT_X, T)) : Ts;
  const next = spec.superQuad.map(([s, q]) => transPt(out[Math.min(s, out.length - 1)], quad[q]));
  return { Ts: out, quad: next };
}

export function validateChainSpec(spec: ChainSpec): string[] {
  const errs: string[] = [];
  if (spec.kind !== 'chain') errs.push('kind must be "chain"');
  if (spec.base !== 'hex' && spec.base !== 'spectre') errs.push('base must be "hex" or "spectre"');
  const n = basePts(spec.base ?? 'hex').length;
  if (!Array.isArray(spec.quad) || spec.quad.length !== 4 || spec.quad.some((q) => !(q >= 0 && q < n))) errs.push(`quad must be four vertex indices 0..${n - 1}`);
  if (!Array.isArray(spec.steps)) errs.push('steps must be a list');
  for (const st of spec.steps ?? []) if (!(st.from >= 0 && st.from < 4 && st.to >= 0 && st.to < 4)) errs.push('step quad points must be 0..3');
  if (!Array.isArray(spec.superQuad) || spec.superQuad.length !== 4) errs.push('superQuad needs four [slot, point] pairs');
  const ids = new Set((spec.types ?? []).map((t) => t.id));
  if (!ids.size) errs.push('needs at least one type');
  for (const [t, row] of Object.entries(spec.rules ?? {})) {
    if (!ids.has(t)) errs.push(`rule for unknown type ${t}`);
    for (const c of row) if (c !== null && !ids.has(c)) errs.push(`${t}: child of unknown type ${c}`);
  }
  return errs;
}

interface Level {
  /** children[type] = [{type, xform}] for supertiles at this level. */
  readonly children: Map<string, HierarchyChild[]>;
}

/** The levels of a chain substitution, built lazily. */
export class ChainSystem {
  private readonly levels: Level[] = [{ children: new Map() }];
  private quad: Pt[];

  constructor(readonly spec: ChainSpec) {
    const pts = basePts(spec.base);
    this.quad = spec.quad.map((i) => pts[i]);
  }

  /** Children of a level-`level` supertile of `type` (level >= 1). */
  children(type: string, level: number): HierarchyChild[] {
    while (this.levels.length <= level) {
      const { Ts, quad } = chainStep(this.spec, this.quad);
      const children = new Map<string, HierarchyChild[]>();
      for (const t of this.spec.types) {
        const row = this.spec.rules[t.id] ?? [];
        const kids: HierarchyChild[] = [];
        Ts.forEach((T, i) => {
          const c = i < row.length ? row[i] : t.id;
          if (c) kids.push({ type: c, xform: T });
        });
        children.set(t.id, kids);
      }
      this.levels.push({ children });
      this.quad = quad;
    }
    return this.levels[level].children.get(type) ?? [];
  }

  /** Leaves of a level-`level` supertile, mirrored back so every level faces the same way. */
  leaves(root: string, level: number, cap = MAX_INSTANCES): TileInstance[] {
    const out: TileInstance[] = [];
    const walk = (type: string, lv: number, M: Affine): void => {
      if (out.length >= cap) return;
      if (lv === 0) {
        out.push({ id: out.length, type, xform: M });
        return;
      }
      for (const k of this.children(type, lv)) walk(k.type, lv - 1, mul(M, k.xform));
    };
    walk(root, level, this.spec.mirror && level % 2 === 1 ? REFLECT_X : IDENT);
    return out;
  }

  /** Top-level slot of each leaf of `leaves(root, level)`, in the same order. */
  slots(root: string, level: number, cap = MAX_INSTANCES): number[] {
    if (level === 0) return [0];
    const out: number[] = [];
    const kids = this.children(root, level);
    const slotOf = this.slotIndices(root);
    kids.forEach((k, i) => {
      const count = this.leafCount(k.type, level - 1);
      for (let j = 0; j < count && out.length < cap; j++) out.push(slotOf[i]);
    });
    return out;
  }

  private slotIndices(type: string): number[] {
    const row = this.spec.rules[type] ?? [];
    const out: number[] = [];
    for (let i = 0; i < slotCount(this.spec); i++) if ((i < row.length ? row[i] : type) !== null) out.push(i);
    return out;
  }

  private readonly counts = new Map<string, number>();
  leafCount(type: string, level: number): number {
    if (level === 0) return 1;
    const k = `${type}/${level}`;
    const hit = this.counts.get(k);
    if (hit !== undefined) return hit;
    const n = this.children(type, level).reduce((s, c) => s + this.leafCount(c.type, level - 1), 0);
    this.counts.set(k, n);
    return n;
  }
}

export function chainPrototiles(spec: ChainSpec): Prototile[] {
  const pts = basePts(spec.base);
  return spec.types.map((t, i) => ({
    id: t.id,
    name: t.name,
    color: t.color ?? paletteColor(i),
    pts: spec.base === 'spectre' && t.mystic ? MYSTIC.pts : pts,
  }));
}

export function chainTiling(spec: ChainSpec, presets?: readonly RuleSetPreset[]): Tiling {
  const errs = validateChainSpec(spec);
  if (errs.length) throw new Error(errs.join('; '));
  const sys = new ChainSystem(spec);
  const prototiles = chainPrototiles(spec);
  const n = slotCount(spec);
  const defaultLevel = spec.defaultLevel ?? Math.max(2, Math.min(5, Math.floor(Math.log(3000) / Math.log(Math.max(2, n)))));
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? `A chain substitution with ${n} slots per supertile.`,
    prototiles,
    roots: prototiles.map((p) => p.id),
    defaultRoot: spec.defaultRoot ?? prototiles[0].id,
    defaultLevel,
    maxLevel: spec.maxLevel ?? Math.max(defaultLevel, Math.floor(Math.log(60000) / Math.log(Math.max(2, n)))),
    deriveLevel: Math.min(3, defaultLevel),
    presets,
    spec,
    hierarchy: { children: (type, level) => sys.children(type, level) },
    generate: (level, root) => sys.leaves(root, level),
  };
}

/** Split types by the slot they fill (as for the other kinds of spec). */
export function refineChainSpec(spec: ChainSpec): ChainSpec {
  const n = slotCount(spec);
  const childAt = (t: string, i: number): string | null => {
    const row = spec.rules[t] ?? [];
    return i < row.length ? row[i] : t;
  };
  const slots: { parent: string; slot: number; child: string }[] = [];
  for (const t of spec.types) for (let i = 0; i < n; i++) {
    const c = childAt(t.id, i);
    if (c) slots.push({ parent: t.id, slot: i, child: c });
  }
  const sid = (p: string, i: number) => `${p}@${i}`;
  const byId = new Map(spec.types.map((t) => [t.id, t]));
  const types = slots.map((s, i) => ({ id: sid(s.parent, s.slot), name: `${byId.get(s.child)!.name}@${byId.get(s.parent)!.name}${s.slot}`, color: paletteColor(i), mystic: byId.get(s.child)!.mystic }));
  const rules: Record<string, (string | null)[]> = {};
  for (const s of slots) rules[sid(s.parent, s.slot)] = Array.from({ length: n }, (_, j) => (childAt(s.child, j) ? sid(s.child, j) : null));
  const root = slots.find((s) => s.child === (spec.defaultRoot ?? spec.types[0].id)) ?? slots[0];
  return { ...spec, id: `${spec.id}-refined`, name: `${spec.name}, refined`, types, rules, defaultRoot: sid(root.parent, root.slot) };
}

// ---------------------------------------------------------------------------
// The Spectre's own chain
// ---------------------------------------------------------------------------

export const SPECTRE_TYPES = ['Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Gamma'] as const;

export const SPECTRE_TYPE_COLORS: Readonly<Record<string, string>> = {
  Gamma: '#c3a6e3',
  Delta: '#f4c95d',
  Theta: '#e89a8f',
  Lambda: '#a7d8de',
  Xi: '#7cc6a4',
  Pi: '#8fb3e8',
  Sigma: '#e8c1a0',
  Phi: '#d9e4a5',
  Psi: '#f2a7c3',
};

const SPECTRE_STEPS: ChainStep[] = [
  { turn: 60, from: 3, to: 1 },
  { turn: 0, from: 2, to: 0 },
  { turn: 60, from: 3, to: 1 },
  { turn: 60, from: 3, to: 1 },
  { turn: 0, from: 2, to: 0 },
  { turn: 60, from: 3, to: 1 },
  { turn: -120, from: 3, to: 3 },
];

const SPECTRE_SLOTS: Readonly<Record<string, readonly (string | null)[]>> = {
  Gamma: ['Pi', 'Delta', null, 'Theta', 'Sigma', 'Xi', 'Phi', 'Gamma'],
  Delta: ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Theta: ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Lambda: ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Xi: ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
  Pi: ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
  Sigma: ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Lambda', 'Gamma'],
  Phi: ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Psi: ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
};

const SPECTRE_SUPER_QUAD: [number, number][] = [
  [6, 2],
  [5, 1],
  [3, 2],
  [0, 1],
];

export function spectreChainSpec(base: ChainBase): ChainSpec {
  return {
    kind: 'chain',
    id: base === 'hex' ? 'hex' : 'spectre',
    name: base === 'hex' ? 'Spectre hexagons' : 'Spectre (Tile(1,1))',
    description:
      base === 'hex'
        ? 'Hexagons glued by the same nine-type supertile rules as the Spectre: same combinatorics, simpler shapes.'
        : 'The chiral aperiodic monotile. Nine tile types from the supertile construction; the Mystic (two Spectres) is one tile here.',
    base,
    quad: base === 'hex' ? [1, 2, 3, 5] : [3, 5, 7, 11],
    steps: SPECTRE_STEPS,
    superQuad: SPECTRE_SUPER_QUAD,
    mirror: true,
    types: SPECTRE_TYPES.map((t) => ({ id: t, name: t, color: SPECTRE_TYPE_COLORS[t], mystic: base === 'spectre' && t === 'Gamma' })),
    rules: SPECTRE_SLOTS,
    defaultRoot: 'Delta',
    defaultLevel: base === 'hex' ? 4 : 3,
    maxLevel: base === 'hex' ? 6 : 5,
  };
}

// ---------------------------------------------------------------------------
// Does the replacement work?
// ---------------------------------------------------------------------------

export interface ChainLevelCheck {
  readonly level: number;
  readonly tiles: number;
  /** Pairs of tiles whose outlines cross, or that sit on top of each other. */
  readonly overlaps: number;
  /** Boundary loops beyond the outer one: holes, or pieces that don't touch. */
  readonly gaps: number;
  /** Indices (into the level's leaves) of tiles involved in an overlap. */
  readonly badTiles: readonly number[];
}

function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const e = 1e-7;
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}

const qk = (p: Pt) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;

export function checkChainLeaves(prototiles: readonly Prototile[], leaves: readonly TileInstance[], level: number): ChainLevelCheck {
  const protoById = new Map(prototiles.map((p) => [p.id, p]));
  const polys = leaves.map((l) => protoById.get(l.type)!.pts.map((p) => transPt(l.xform, p)));
  const bad = new Set<number>();
  const pairs = new Set<string>();
  // Tiles sitting exactly on top of each other.
  const centre = new Map<string, number>();
  polys.forEach((pts, i) => {
    const c = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
    const k = qk(c);
    const j = centre.get(k);
    if (j !== undefined) {
      pairs.add(`${j}|${i}`);
      bad.add(i).add(j);
    } else centre.set(k, i);
  });
  // Outlines that cross: bucket edges on a grid, test pairs in each bucket.
  const grid = new Map<string, { t: number; a: Pt; b: Pt }[]>();
  polys.forEach((pts, t) => {
    for (let e = 0; e < pts.length; e++) {
      const a = pts[e];
      const b = pts[(e + 1) % pts.length];
      for (let gx = Math.floor(Math.min(a.x, b.x)); gx <= Math.floor(Math.max(a.x, b.x)); gx++)
        for (let gy = Math.floor(Math.min(a.y, b.y)); gy <= Math.floor(Math.max(a.y, b.y)); gy++) {
          const k = `${gx},${gy}`;
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push({ t, a, b });
        }
    }
  });
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i];
        const q = list[j];
        if (p.t === q.t) continue;
        const key = p.t < q.t ? `${p.t}|${q.t}` : `${q.t}|${p.t}`;
        if (pairs.has(key)) continue;
        if (properCross(p.a, p.b, q.a, q.b)) {
          pairs.add(key);
          bad.add(p.t).add(q.t);
        }
      }
  }
  // Overlaps that only touch along edges cross nothing: test points just
  // inside each tile against the tiles near it.
  const boxes = polys.map((pts) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  });
  const cells = new Map<string, number[]>();
  boxes.forEach((b, i) => {
    for (let gx = Math.floor(b.x0); gx <= Math.floor(b.x1); gx++)
      for (let gy = Math.floor(b.y0); gy <= Math.floor(b.y1); gy++) {
        const k = `${gx},${gy}`;
        const l = cells.get(k);
        if (l) l.push(i);
        else cells.set(k, [i]);
      }
  });
  const inner = polys.map((pts) => {
    const c = pts.reduce((s2, p) => ({ x: s2.x + p.x / pts.length, y: s2.y + p.y / pts.length }), { x: 0, y: 0 });
    const out: Pt[] = [];
    pts.forEach((p, e) => {
      const q = pts[(e + 1) % pts.length];
      out.push({ x: p.x + (c.x - p.x) * 0.12, y: p.y + (c.y - p.y) * 0.12 });
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      out.push({ x: m.x + (c.x - m.x) * 0.12, y: m.y + (c.y - m.y) * 0.12 });
    });
    // Points near vertices of a concave tile can fall outside it; keep only those inside.
    return out.filter((p) => insidePoly(p, pts));
  });
  for (const list of cells.values()) {
    for (const i of list)
      for (const j of list) {
        if (i >= j) continue;
        const key = `${i}|${j}`;
        if (pairs.has(key)) continue;
        const A = boxes[i];
        const B = boxes[j];
        if (A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0) continue;
        if (inner[i].some((p) => insidePoly(p, polys[j])) || inner[j].some((p) => insidePoly(p, polys[i]))) {
          pairs.add(key);
          bad.add(i).add(j);
        }
      }
  }
  // Boundary: edges no other tile shares. One outer loop is expected.
  const count = new Map<string, number>();
  const ek = (a: Pt, b: Pt) => {
    const x = qk(a);
    const y = qk(b);
    return x < y ? `${x}|${y}` : `${y}|${x}`;
  };
  for (const pts of polys) for (let e = 0; e < pts.length; e++) {
    const k = ek(pts[e], pts[(e + 1) % pts.length]);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) {
      const n = parent.get(y)!;
      parent.set(y, r);
      y = n;
    }
    return r;
  };
  for (const [k, n] of count) {
    if (n !== 1) continue;
    const [a, b] = k.split('|');
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const loops = new Set([...parent.keys()].map(find)).size;
  return { level, tiles: leaves.length, overlaps: pairs.size, gaps: Math.max(0, loops - 1), badTiles: [...bad] };
}

function insidePoly(p: Pt, pts: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function checkChain(spec: ChainSpec, maxLevel: number, cap = 30_000): { perType: Record<string, ChainLevelCheck[]>; firstBad: number | null } {
  const sys = new ChainSystem(spec);
  const prototiles = chainPrototiles(spec);
  const perType: Record<string, ChainLevelCheck[]> = {};
  let firstBad: number | null = null;
  // Two types whose supertiles have the same shape (same empty slots, same
  // shapes of children, all the way down) need checking only once.
  const shape: Map<string, string>[] = [new Map(spec.types.map((t) => [t.id, spec.base === 'spectre' && t.mystic ? 'M' : 'T']))];
  for (let lv = 1; lv <= maxLevel; lv++) {
    const prev = shape[lv - 1];
    const ids = new Map<string, string>();
    const m = new Map<string, string>();
    for (const t of spec.types) {
      const row = spec.rules[t.id] ?? [];
      const sig = Array.from({ length: slotCount(spec) }, (_, i) => {
        const c = i < row.length ? row[i] : t.id;
        return c === null ? '-' : prev.get(c) ?? '?';
      }).join(',');
      if (!ids.has(sig)) ids.set(sig, String(ids.size));
      m.set(t.id, ids.get(sig)!);
    }
    shape.push(m);
  }
  for (const t of spec.types) perType[t.id] = [];
  for (let lv = 1; lv <= maxLevel; lv++) {
    const done = new Map<string, ChainLevelCheck | null>();
    for (const t of spec.types) {
      const k = shape[lv].get(t.id)!;
      if (!done.has(k)) {
        done.set(k, sys.leafCount(t.id, lv) > cap ? null : checkChainLeaves(prototiles, sys.leaves(t.id, lv, cap), lv));
      }
      const chk = done.get(k);
      if (!chk || perType[t.id].length !== lv - 1) continue;
      perType[t.id].push(chk);
      if ((chk.overlaps || chk.gaps) && (firstBad === null || lv < firstBad)) firstBad = lv;
    }
  }
  return { perType, firstBad };
}

// ---------------------------------------------------------------------------
// Lab presets
// ---------------------------------------------------------------------------

export const CHAIN_PRESETS: readonly ChainSpec[] = [
  { ...spectreChainSpec('hex'), id: 'lab-spectre-hex', description: 'The Spectre project’s hexagons exactly: the same chain and slot table as the built-in tiling.' },
  { ...spectreChainSpec('spectre'), id: 'lab-spectre', description: 'The Spectre exactly, with the Mystic (two Spectres) as the Gamma tile.' },
  {
    ...spectreChainSpec('hex'),
    id: 'lab-spectre-abc',
    name: 'Spectre chain, three types',
    description:
      'The Spectre’s chain with three types. C plays the Mystic’s part (always in slot 7, its own slot 2 empty), which is what keeps the geometry fitting; A and B are free to rearrange.',
    types: [
      { id: 'A', name: 'A', color: '#f4c95d' },
      { id: 'B', name: 'B', color: '#8fb3e8' },
      { id: 'C', name: 'C', color: '#c3a6e3' },
    ],
    rules: {
      A: ['B', 'A', 'B', 'A', 'A', 'B', 'A', 'C'],
      B: ['A', 'A', 'B', 'B', 'A', 'A', 'B', 'C'],
      C: ['B', 'A', null, 'A', 'B', 'A', 'B', 'C'],
    },
    defaultRoot: 'A',
  },
];
