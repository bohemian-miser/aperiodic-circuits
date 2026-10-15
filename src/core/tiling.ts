/**
 * Tilings: a set of prototiles plus a way to grow a patch of them.
 *
 * A tiling here is pure geometry. Which edges carry crossings, and which of
 * those edges count as the same class, is a separate `RuleSet` (see
 * `ruleset.ts`) layered on top, so one tiling can have many rule sets.
 */

import { mul, similarityFrom, transPt, tscale, IDENT, type Affine, type Pt } from './geom';
import { signedArea } from './polygon';
import type { RuleSet } from './ruleset';

export interface Prototile {
  readonly id: string;
  readonly name: string;
  /** Vertices of the tile at leaf scale. Edge `i` runs `pts[i] -> pts[i+1]`. */
  readonly pts: readonly Pt[];
  readonly color: string;
  /** Edges drawn faintly (e.g. the base of a Robinson triangle, a rhomb's diagonal). */
  readonly hiddenEdges?: readonly number[];
}

export interface TileInstance {
  readonly id: number;
  readonly type: string;
  /** Leaf-scale prototile frame -> world. */
  readonly xform: Affine;
}

export interface RuleSetPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly build: (tiling: Tiling) => RuleSet;
}

export interface Tiling {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prototiles: readonly Prototile[];
  /** Types a patch can be grown from. */
  readonly roots: readonly string[];
  readonly defaultRoot: string;
  readonly defaultLevel: number;
  readonly maxLevel: number;
  /** Level whose patch is big enough to see every seam meet its neighbours. */
  readonly deriveLevel: number;
  /** Grows a patch: `level` rounds of substitution starting from one `root` tile. */
  generate(level: number, root: string): readonly TileInstance[];
  /** Labellings that ship with the tiling, beyond the derived ones. */
  readonly presets?: readonly RuleSetPreset[];
  /** For a JSON-defined tiling, the spec it was built from (for export). */
  readonly spec?: SimilaritySpec;
}

export function prototile(t: Tiling, id: string): Prototile {
  const p = t.prototiles.find((q) => q.id === id);
  if (!p) throw new Error(`Unknown prototile ${id} in ${t.id}`);
  return p;
}

/** Guard so a careless level slider can't lock the tab. */
export const MAX_INSTANCES = 120_000;

// ---------------------------------------------------------------------------
// Similarity substitutions (data-driven; JSON importable)
// ---------------------------------------------------------------------------

export type XY = readonly [number, number];

export interface SimilarityChild {
  readonly type: string;
  /** Where the child prototile's vertex 0 lands, in the parent prototile's frame. */
  readonly v0: XY;
  /** Where the child prototile's vertex 1 lands. */
  readonly v1: XY;
  /** The child is a mirror image. */
  readonly flip?: boolean;
}

export interface SimilaritySpec {
  readonly kind: 'similarity';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly prototiles: readonly {
    readonly id: string;
    readonly name?: string;
    readonly color?: string;
    readonly pts: readonly XY[];
    readonly hiddenEdges?: readonly number[];
  }[];
  /** Linear inflation factor: a supertile is this many times larger than its children. */
  readonly inflation: number;
  /** For each prototile, its children laid out inside a leaf-scale copy of it. */
  readonly rules: Readonly<Record<string, readonly SimilarityChild[]>>;
  readonly defaultLevel?: number;
  readonly maxLevel?: number;
  readonly deriveLevel?: number;
  readonly defaultRoot?: string;
}

const PALETTE = ['#f4c95d', '#7cc6a4', '#8fb3e8', '#e89a8f', '#c3a6e3', '#e8c1a0', '#a7d8de', '#d9e4a5', '#f2a7c3', '#b8c0cc'];

export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

/**
 * Build a similarity child from the images of the first three vertices of
 * its prototile; whether it mirrors is read off the orientation.
 */
export function childFromImages(proto: readonly Pt[], type: string, images: readonly Pt[]): SimilarityChild {
  const flip = Math.sign(signedArea(proto.slice(0, 3))) !== Math.sign(signedArea(images.slice(0, 3)));
  return { type, v0: [images[0].x, images[0].y], v1: [images[1].x, images[1].y], flip };
}

export function validateSimilaritySpec(spec: SimilaritySpec): string[] {
  const errs: string[] = [];
  if (spec.kind !== 'similarity') errs.push('kind must be "similarity"');
  if (!spec.id) errs.push('missing id');
  if (!Array.isArray(spec.prototiles) || spec.prototiles.length === 0) errs.push('no prototiles');
  if (!(spec.inflation > 1)) errs.push('inflation must be > 1');
  const ids = new Set(spec.prototiles?.map((p) => p.id) ?? []);
  for (const p of spec.prototiles ?? []) {
    if (!Array.isArray(p.pts) || p.pts.length < 3) errs.push(`prototile ${p.id}: needs at least 3 points`);
    if (!spec.rules?.[p.id]) errs.push(`prototile ${p.id}: no substitution rule`);
  }
  for (const [k, kids] of Object.entries(spec.rules ?? {})) {
    if (!ids.has(k)) errs.push(`rule for unknown prototile ${k}`);
    for (const c of kids) if (!ids.has(c.type)) errs.push(`rule ${k}: child of unknown type ${c.type}`);
  }
  return errs;
}

export function similarityTiling(spec: SimilaritySpec, presets?: readonly RuleSetPreset[]): Tiling {
  const errs = validateSimilaritySpec(spec);
  if (errs.length) throw new Error(errs.join('; '));
  const prototiles: Prototile[] = spec.prototiles.map((p, i) => ({
    id: p.id,
    name: p.name ?? p.id,
    color: p.color ?? paletteColor(i),
    pts: p.pts.map(([x, y]) => ({ x, y })),
    hiddenEdges: p.hiddenEdges,
  }));
  const byId = new Map(prototiles.map((p) => [p.id, p]));
  // Child maps: child leaf frame -> parent leaf frame (scale 1/inflation).
  const childMaps = new Map<string, { type: string; m: Affine }[]>();
  for (const [type, kids] of Object.entries(spec.rules)) {
    childMaps.set(
      type,
      kids.map((c) => {
        const cp = byId.get(c.type)!.pts;
        const m = similarityFrom(cp[0], cp[1], { x: c.v0[0], y: c.v0[1] }, { x: c.v1[0], y: c.v1[1] }, !!c.flip);
        return { type: c.type, m };
      }),
    );
  }
  const roots = prototiles.map((p) => p.id);
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
    prototiles,
    roots,
    defaultRoot: spec.defaultRoot ?? roots[0],
    defaultLevel: spec.defaultLevel ?? 4,
    maxLevel: spec.maxLevel ?? 8,
    deriveLevel: spec.deriveLevel ?? 5,
    presets,
    spec,
    generate(level, root) {
      const out: TileInstance[] = [];
      const walk = (type: string, M: Affine, depth: number): void => {
        if (out.length >= MAX_INSTANCES) return;
        if (depth === 0) {
          out.push({ id: out.length, type, xform: M });
          return;
        }
        for (const c of childMaps.get(type) ?? []) walk(c.type, mul(M, c.m), depth - 1);
      };
      walk(byId.has(root) ? root : roots[0], tscale(Math.pow(spec.inflation, level)), level);
      return out;
    },
  };
}

/** World-space vertices of an instance. */
export function instancePts(t: Tiling, inst: TileInstance): Pt[] {
  return prototile(t, inst.type).pts.map((p) => transPt(inst.xform, p));
}

export function patchBounds(t: Tiling, insts: readonly TileInstance[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const inst of insts) {
    for (const p of instancePts(t, inst)) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

export { IDENT };

/**
 * Split every prototile by the slot it fills in its parent's substitution
 * (`chair` -> `chair@0` … `chair@3`). The geometry is unchanged, but tiles
 * now know where they sit, which is how the Spectre gets its nine types and
 * what lets a one-tile tiling like the chair carry more than one edge class.
 */
export function refineSpec(spec: SimilaritySpec): SimilaritySpec {
  const slots: { parent: string; index: number; child: SimilarityChild }[] = [];
  for (const p of spec.prototiles) (spec.rules[p.id] ?? []).forEach((child, index) => slots.push({ parent: p.id, index, child }));
  const slotId = (s: { parent: string; index: number }) => `${s.parent}@${s.index}`;
  const protoById = new Map(spec.prototiles.map((p) => [p.id, p]));
  const prototiles = slots.map((s, i) => {
    const base = protoById.get(s.child.type)!;
    return { ...base, id: slotId(s), name: `${base.name ?? base.id} @${s.parent === s.child.type ? '' : s.parent + ' '}${s.index}`, color: paletteColor(i) };
  });
  const rules: Record<string, SimilarityChild[]> = {};
  for (const s of slots) {
    // A tile in slot s is a copy of s.child.type; its children are that type's slots.
    rules[slotId(s)] = (spec.rules[s.child.type] ?? []).map((c, index) => ({ ...c, type: slotId({ parent: s.child.type, index }) }));
  }
  const root = slots.find((s) => s.child.type === (spec.defaultRoot ?? spec.prototiles[0].id)) ?? slots[0];
  return {
    ...spec,
    id: `${spec.id}-refined`,
    name: `${spec.name}, refined`,
    description: `${spec.name} with each tile split by its slot in the parent supertile.`,
    prototiles,
    rules,
    defaultRoot: slotId(root),
  };
}
