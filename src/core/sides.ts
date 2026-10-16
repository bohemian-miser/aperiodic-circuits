/**
 * Side-glued substitutions: the Spectre's construction read as a
 * combinatorial substitution (Spectre project, docs/FASS_THEOREM.md §1–2).
 *
 * Every supertile is a combinatorial hexagon: six corners on its outline and
 * six sides between them, side e running from corner e to corner e+1 (for a
 * leaf hexagon, corner e is vertex e and side e is edge e). A substitution is
 *
 *   - slots: hexagon cells with a fixed orientation (turn and flip), the same
 *     at every level. Only where the children sit changes with the level;
 *   - per type, which type fills each slot (or nothing);
 *   - per type, the six corners of its supertile, each named as a corner of
 *     one of its children: (slot, child corner).
 *
 * Which child sides are glued is read off the level-1 picture: two hexagon
 * cells that share an edge glue those two sides. A level-m supertile is then
 * built by placing its first child and gluing every other child to an
 * already placed one along those sides. Nothing else is needed, and no
 * scaling map exists or is assumed: supertiles change shape from level to
 * level, as the Spectre's do.
 */

import { IDENT, REFLECT_X, mul, transPt, trot, ttrans, type Affine, type Pt } from './geom';
import { qkey, signedArea } from './polygon';
import { HEX_PTS, SPECTRE_TYPE_COLORS, SPECTRE_TYPES } from './chain';
import { MAX_INSTANCES, paletteColor, type HierarchyChild, type Prototile, type RuleSetPreset, type TileInstance, type Tiling } from './tiling';

export interface SideSlot {
  /** Flat-top hexagon grid cell (axial). */
  readonly q: number;
  readonly r: number;
  /** Turn in 60° steps. */
  readonly rot: number;
  readonly flip: boolean;
}

export interface SidesSpec {
  readonly kind: 'sides';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly slots: readonly SideSlot[];
  readonly types: readonly { readonly id: string; readonly name: string; readonly color?: string }[];
  /** rules[type][slot] = child type, or null for an empty slot. */
  readonly rules: Readonly<Record<string, readonly (string | null)[]>>;
  /** corners[type][j] = [slot, child corner]: the supertile's corner j. */
  readonly corners: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  readonly defaultRoot?: string;
  readonly defaultLevel?: number;
  readonly maxLevel?: number;
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

const H = Math.sqrt(3) / 2;
/** Centre of the base hexagon `HEX_PTS`. */
const C0: Pt = { x: 0.5, y: H };
/** Flat-top grid: cell (q, r) is centred at q·(1.5, √3/2) + r·(0, √3). */
export function cellCentre(q: number, r: number): Pt {
  return { x: 1.5 * q, y: H * q + 2 * H * r };
}

export function slotLinear(rot: number, flip: boolean): Affine {
  const R = trot((((rot % 6) + 6) % 6) * (Math.PI / 3));
  return flip ? mul(R, REFLECT_X) : R;
}

/** Leaf hexagon frame -> parent frame for a slot. */
export function slotXform(s: SideSlot): Affine {
  const L = slotLinear(s.rot, s.flip);
  const c = cellCentre(s.q, s.r);
  const lc = transPt(L, C0);
  return mul(ttrans(c.x - lc.x, c.y - lc.y), L);
}

/** Read a slot back off a transform that puts a hexagon on the grid (for importing). */
export function slotFromXform(X: Affine, origin: Pt = { x: 0, y: 0 }): SideSlot {
  const flip = X[0] * X[4] - X[1] * X[3] < 0;
  const L = flip ? mul([X[0], X[1], 0, X[3], X[4], 0], REFLECT_X) : ([X[0], X[1], 0, X[3], X[4], 0] as Affine);
  const rot = (((Math.round(Math.atan2(L[3], L[0]) / (Math.PI / 3)) % 6) + 6) % 6);
  const c = transPt(X, C0);
  const q = Math.round((c.x - origin.x) / 1.5);
  const r = Math.round(((c.y - origin.y) / H - q) / 2);
  // `+ 0` turns a -0 from rounding into 0.
  return { q: q + 0, r: r + 0, rot: rot + 0, flip };
}

// ---------------------------------------------------------------------------
// Gluing, read off level 1
// ---------------------------------------------------------------------------

export interface Glue {
  readonly a: number;
  readonly ea: number;
  readonly b: number;
  readonly eb: number;
  /** The two sides run opposite ways in the parent (the usual case for same-handed children). */
  readonly reversed: boolean;
}

function rowOf(spec: SidesSpec, type: string): (string | null)[] {
  const row = spec.rules[type] ?? [];
  return spec.slots.map((_, i) => (i < row.length ? row[i] : type));
}

/** Pairs of slot sides that touch in the level-1 picture of `type`. */
export function gluesOf(spec: SidesSpec, type: string): Glue[] {
  const row = rowOf(spec, type);
  const edges = new Map<string, { s: number; e: number; fwd: boolean }[]>();
  spec.slots.forEach((slot, s) => {
    if (row[s] === null) return;
    const pts = HEX_PTS.map((p) => transPt(slotXform(slot), p));
    for (let e = 0; e < 6; e++) {
      const a = qkey(pts[e], 1e3);
      const b = qkey(pts[(e + 1) % 6], 1e3);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      let l = edges.get(k);
      if (!l) edges.set(k, (l = []));
      l.push({ s, e, fwd: a < b });
    }
  });
  const out: Glue[] = [];
  for (const l of edges.values()) {
    if (l.length !== 2) continue;
    const [x, y] = l[0].s < l[1].s ? l : [l[1], l[0]];
    out.push({ a: x.s, ea: x.e, b: y.s, eb: y.e, reversed: x.fwd !== y.fwd });
  }
  return out.sort((p, q) => p.a - q.a || p.ea - q.ea);
}

// ---------------------------------------------------------------------------
// Building the levels
// ---------------------------------------------------------------------------

interface Super {
  readonly children: readonly HierarchyChild[];
  /** The six corner points, in the supertile's own frame. */
  readonly corners: readonly Pt[];
  /**
   * Counter-clockwise outline starting at corner 0, and the outline index of
   * each corner. Kept only up to `FULL_LEVELS`: outlines are fractal and grow
   * faster than the tile count, and above that level only corners are needed.
   */
  readonly outline?: readonly Pt[];
  readonly cornerIdx?: readonly number[];
}

/**
 * Levels built with full outlines, so whole sides are compared and overlaps
 * and holes found. Above this, children are placed from corners alone and
 * each glue is checked at both ends.
 */
export const FULL_LEVELS = 4;

export interface SidesProblem {
  readonly level: number;
  readonly type: string;
  readonly message: string;
}

const LEAF_OUTLINE = HEX_PTS;
const LEAF_CORNERS = [0, 1, 2, 3, 4, 5];
const ccwSign = Math.sign(signedArea(HEX_PTS));

/** Outline of a union of edge-to-edge polygons (all made counter-clockwise first). */
function outlineOf(polys: readonly (readonly Pt[])[]): Pt[] | null {
  const edges: { a: Pt; b: Pt; ka: string; kb: string }[] = [];
  for (const p0 of polys) {
    const p = Math.sign(signedArea(p0)) === ccwSign ? p0 : [...p0].reverse();
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      edges.push({ a, b, ka: qkey(a, 1e3), kb: qkey(b, 1e3) });
    }
  }
  const fwd = new Set(edges.map((e) => `${e.ka}>${e.kb}`));
  const kept = edges.filter((e) => !fwd.has(`${e.kb}>${e.ka}`));
  if (!kept.length) return null;
  const byStart = new Map<string, (typeof kept)[number]>();
  for (const e of kept) {
    if (byStart.has(e.ka)) return null; // pinch point: not a simple outline
    byStart.set(e.ka, e);
  }
  const out: Pt[] = [];
  let cur = kept[0];
  for (let guard = 0; guard <= kept.length; guard++) {
    out.push(cur.a);
    const next = byStart.get(cur.kb);
    if (!next) return null;
    if (next === kept[0]) break;
    cur = next;
  }
  return out.length === kept.length ? out : null; // more than one loop: holes or pieces
}

export class SidesSystem {
  private readonly levels: Map<string, Super>[] = [];
  readonly problems: SidesProblem[] = [];
  private readonly glues = new Map<string, Glue[]>();
  /** Highest level built without problems. */
  private okUpTo = Infinity;

  constructor(readonly spec: SidesSpec) {
    const leaf = new Map<string, Super>();
    for (const t of spec.types) leaf.set(t.id, { children: [], corners: LEAF_OUTLINE, outline: LEAF_OUTLINE, cornerIdx: LEAF_CORNERS });
    this.levels.push(leaf);
    for (const t of spec.types) this.glues.set(t.id, gluesOf(spec, t.id));
  }

  private problem(level: number, type: string, message: string): void {
    this.problems.push({ level, type, message });
    this.okUpTo = Math.min(this.okUpTo, level - 1);
  }

  /** The supertile of `type` at `level` (built on demand). Null if it can't be built. */
  get(type: string, level: number): Super | null {
    while (this.levels.length <= level && this.levels.length - 1 < this.okUpTo) this.buildNext();
    return this.levels[level]?.get(type) ?? null;
  }

  children(type: string, level: number): HierarchyChild[] {
    return [...(this.get(type, level)?.children ?? [])];
  }

  private buildNext(): void {
    const m = this.levels.length;
    const below = this.levels[m - 1];
    const out = new Map<string, Super>();
    for (const t of this.spec.types) {
      const row = rowOf(this.spec, t.id);
      const placed = new Map<number, Affine>();
      if (m === 1) {
        row.forEach((c, s) => c && placed.set(s, slotXform(this.spec.slots[s])));
      } else {
        // Place the first child with its slot orientation only, then glue.
        const first = row.findIndex((c) => c !== null);
        if (first < 0) {
          this.problem(m, t.id, 'has no children');
          continue;
        }
        placed.set(first, slotLinear(this.spec.slots[first].rot, this.spec.slots[first].flip));
        const glues = this.glues.get(t.id)!;
        let grew = true;
        while (grew) {
          grew = false;
          for (const g of glues) {
            for (const [from, ef, to, et] of [
              [g.a, g.ea, g.b, g.eb],
              [g.b, g.eb, g.a, g.ea],
            ] as const) {
              if (!placed.has(from) || placed.has(to)) continue;
              const cf = below.get(row[from]!);
              const ct = below.get(row[to]!);
              if (!cf || !ct) continue;
              const X = placed.get(from)!;
              const p0 = transPt(X, cf.corners[ef]);
              const p1 = transPt(X, cf.corners[(ef + 1) % 6]);
              const L = slotLinear(this.spec.slots[to].rot, this.spec.slots[to].flip);
              const target = g.reversed ? p1 : p0;
              const src = transPt(L, ct.corners[et]);
              placed.set(to, mul(ttrans(target.x - src.x, target.y - src.y), L));
              grew = true;
            }
          }
        }
        if (placed.size !== row.filter((c) => c !== null).length) {
          this.problem(m, t.id, 'some children are not glued to the rest');
          continue;
        }
        // Every glued pair must now match: along its whole length while
        // outlines are kept, at both ends above that.
        for (const g of glues) {
          const A = below.get(row[g.a]!)!;
          const B = below.get(row[g.b]!)!;
          const sa = A.outline ? this.sidePts(A, g.ea, placed.get(g.a)!) : [transPt(placed.get(g.a)!, A.corners[g.ea]), transPt(placed.get(g.a)!, A.corners[(g.ea + 1) % 6])];
          const sb = B.outline ? this.sidePts(B, g.eb, placed.get(g.b)!) : [transPt(placed.get(g.b)!, B.corners[g.eb]), transPt(placed.get(g.b)!, B.corners[(g.eb + 1) % 6])];
          const want = g.reversed ? [...sb].reverse() : sb;
          if (sa.length !== want.length || sa.some((p, i) => qkey(p, 1e3) !== qkey(want[i], 1e3))) {
            this.problem(m, t.id, `slot ${g.a} side ${g.ea} doesn't match slot ${g.b} side ${g.eb} (lengths ${sa.length - 1} and ${sb.length - 1})`);
            break;
          }
        }
      }
      const children: HierarchyChild[] = [];
      row.forEach((c, s) => {
        if (c && placed.has(s)) children.push({ type: c, xform: placed.get(s)! });
      });
      // Corners, from (slot, child corner).
      const cs = this.spec.corners[t.id] ?? [];
      const cornerPts = cs.map(([s, k]) => {
        const c = row[s] ? below.get(row[s]!) : undefined;
        const X = placed.get(s);
        return c && X && c.corners.length === 6 ? transPt(X, c.corners[((k % 6) + 6) % 6]) : null;
      });
      if (cornerPts.length !== 6 || cornerPts.some((p) => !p)) {
        this.problem(m, t.id, 'a corner names an empty slot');
        out.set(t.id, { children, corners: [] });
        continue;
      }
      const corners = cornerPts as Pt[];
      if (m > FULL_LEVELS) {
        out.set(t.id, { children, corners });
        continue;
      }
      const outline = outlineOf(children.map((ch) => below.get(ch.type)!.outline!.map((p) => transPt(ch.xform, p))));
      if (!outline) {
        this.problem(m, t.id, 'its children overlap or leave a hole');
        out.set(t.id, { children, corners: [] });
        continue;
      }
      const at = new Map(outline.map((p, i) => [qkey(p, 1e3), i]));
      const idx = corners.map((p) => at.get(qkey(p, 1e3)) ?? -1);
      if (idx.some((i) => i < 0)) {
        this.problem(m, t.id, 'a corner is not on the outline');
        out.set(t.id, { children, corners: [] });
        continue;
      }
      // Rotate so the outline starts at corner 0, and check the corners go round in order.
      const rotated = outline.slice(idx[0]).concat(outline.slice(0, idx[0]));
      const cornerIdx = idx.map((i) => (i - idx[0] + outline.length) % outline.length);
      if (cornerIdx.some((c, j) => j > 0 && c <= cornerIdx[j - 1])) this.problem(m, t.id, 'the corners are not in order round the outline');
      out.set(t.id, { children, corners, outline: rotated, cornerIdx });
    }
    this.levels.push(out);
  }

  private sidePts(s: Super, e: number, X: Affine): Pt[] {
    const a = s.cornerIdx![e];
    const b = s.cornerIdx![(e + 1) % 6];
    const n = s.outline!.length;
    const pts: Pt[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      pts.push(transPt(X, s.outline![i]));
      if (i === b) break;
    }
    return pts;
  }

  /** Problems found while building up to `level`. */
  check(level: number): SidesProblem[] {
    for (const t of this.spec.types) this.get(t.id, level);
    return this.problems.filter((p) => p.level <= level);
  }

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
    walk(root, level, IDENT);
    return out;
  }
}

export function sidesPrototiles(spec: SidesSpec): Prototile[] {
  return spec.types.map((t, i) => ({
    id: t.id,
    name: t.name,
    color: t.color ?? paletteColor(i),
    pts: HEX_PTS,
  }));
}

export function validateSidesSpec(spec: SidesSpec): string[] {
  const errs: string[] = [];
  if (spec.kind !== 'sides') errs.push('kind must be "sides"');
  if (!Array.isArray(spec.slots) || spec.slots.length < 2) errs.push('needs at least two slots');
  const ids = new Set((spec.types ?? []).map((t) => t.id));
  if (!ids.size) errs.push('needs at least one type');
  for (const [t, row] of Object.entries(spec.rules ?? {})) {
    if (!ids.has(t)) errs.push(`rule for unknown type ${t}`);
    for (const c of row) if (c !== null && !ids.has(c)) errs.push(`${t}: child of unknown type ${c}`);
  }
  for (const t of spec.types ?? []) if ((spec.corners?.[t.id] ?? []).length !== 6) errs.push(`${t.id}: needs six corners`);
  return errs;
}

export function sidesTiling(spec: SidesSpec, presets?: readonly RuleSetPreset[]): Tiling {
  const errs = validateSidesSpec(spec);
  if (errs.length) throw new Error(errs.join('; '));
  const sys = new SidesSystem(spec);
  const prototiles = sidesPrototiles(spec);
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? `A side-glued substitution with ${spec.slots.length} slots per supertile.`,
    prototiles,
    roots: prototiles.map((p) => p.id),
    defaultRoot: spec.defaultRoot ?? prototiles[0].id,
    defaultLevel: spec.defaultLevel ?? 3,
    maxLevel: spec.maxLevel ?? 5,
    deriveLevel: 3,
    presets,
    spec,
    hierarchy: { children: (type, level) => sys.children(type, level) },
    generate: (level, root) => sys.leaves(root, level),
  };
}

// ---------------------------------------------------------------------------
// The Spectre hexagons, as a side-glued substitution
// ---------------------------------------------------------------------------

/**
 * The Spectre hexagons' level-1 supertile on the grid: eight cells, every one
 * flipped (that is where "mirror each level" comes from). Read off the
 * built-in tiling's level-1 children.
 */
export const SPECTRE_HEX_SLOTS: readonly SideSlot[] = [
  { q: 0, r: 0, rot: 0, flip: true },
  { q: 1, r: -1, rot: 5, flip: true },
  { q: 2, r: -1, rot: 5, flip: true },
  { q: 2, r: -2, rot: 4, flip: true },
  { q: 1, r: -2, rot: 3, flip: true },
  { q: 1, r: -3, rot: 3, flip: true },
  { q: 0, r: -2, rot: 2, flip: true },
  { q: 0, r: -1, rot: 4, flip: true },
];

/** The corner table CT from the Spectre project's FASS_THEOREM.md §2 (tables-hex.json). */
export const SPECTRE_HEX_CORNERS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  Gamma: [[7, 0], [6, 3], [5, 3], [3, 3], [0, 4], [0, 2]],
  Delta: [[7, 0], [5, 4], [5, 2], [3, 3], [2, 3], [0, 3]],
  Theta: [[7, 0], [5, 4], [5, 2], [2, 4], [2, 2], [0, 2]],
  Lambda: [[7, 0], [5, 4], [5, 2], [3, 3], [2, 3], [0, 2]],
  Xi: [[7, 0], [6, 3], [5, 2], [2, 4], [2, 2], [0, 2]],
  Pi: [[7, 0], [6, 3], [5, 2], [3, 3], [2, 3], [0, 2]],
  Sigma: [[6, 4], [5, 4], [5, 2], [3, 3], [2, 3], [0, 3]],
  Phi: [[7, 0], [5, 4], [5, 2], [3, 3], [2, 2], [0, 2]],
  Psi: [[7, 0], [6, 3], [5, 2], [3, 3], [2, 2], [0, 2]],
};

const SPECTRE_HEX_RULES: Readonly<Record<string, readonly (string | null)[]>> = {
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

export const SPECTRE_HEX_SIDES: SidesSpec = {
  kind: 'sides',
  id: 'lab-sides-spectre-hex',
  name: 'Spectre hexagons (glued sides)',
  description: 'The Spectre hexagons as a grid picture plus six corners per type; every level above the first is built by gluing sides.',
  slots: SPECTRE_HEX_SLOTS,
  types: SPECTRE_TYPES.map((t) => ({ id: t, name: t, color: SPECTRE_TYPE_COLORS[t] })),
  rules: SPECTRE_HEX_RULES,
  corners: SPECTRE_HEX_CORNERS,
  defaultRoot: 'Delta',
  defaultLevel: 4,
  maxLevel: 6,
};

/** Split types by the slot they fill. A refined type copies its child type's rule and corners. */
export function refineSidesSpec(spec: SidesSpec): SidesSpec {
  const slots: { parent: string; slot: number; child: string }[] = [];
  for (const t of spec.types) rowOf(spec, t.id).forEach((c, s) => c && slots.push({ parent: t.id, slot: s, child: c }));
  const sid = (p: string, i: number) => `${p}@${i}`;
  const byId = new Map(spec.types.map((t) => [t.id, t]));
  const types = slots.map((s, i) => ({ id: sid(s.parent, s.slot), name: `${byId.get(s.child)!.name}@${byId.get(s.parent)!.name}${s.slot}`, color: paletteColor(i) }));
  const rules: Record<string, (string | null)[]> = {};
  const corners: Record<string, readonly (readonly [number, number])[]> = {};
  for (const s of slots) {
    rules[sid(s.parent, s.slot)] = rowOf(spec, s.child).map((c, j) => (c ? sid(s.child, j) : null));
    corners[sid(s.parent, s.slot)] = spec.corners[s.child];
  }
  const root = slots.find((s) => s.child === (spec.defaultRoot ?? spec.types[0].id)) ?? slots[0];
  return { ...spec, id: `${spec.id}-refined`, name: `${spec.name}, refined`, types, rules, corners, defaultRoot: sid(root.parent, root.slot) };
}
