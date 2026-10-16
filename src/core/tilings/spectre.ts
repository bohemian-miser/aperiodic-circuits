/**
 * The Spectre (Tile(1,1)) and its combinatorially equivalent hexagons, grown
 * with the supertile construction from the Spectre project (itself a port of
 * Craig Kaplan's app). Nine tile types: the Mystic (Gamma) is treated as one
 * prototile, so the seams inside it never appear.
 */

import { IDENT, REFLECT_X, mul, radians, transPt, trot, ttrans, type Affine, type Pt } from '../geom';
import { unionBoundary } from '../polygon';
import { seamsFromLabels, type RuleSet } from '../ruleset';
import { MAX_INSTANCES, type Prototile, type TileInstance, type Tiling } from '../tiling';

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

/**
 * Same order as the Spectre project's hexagon leaf order, so combination
 * digits (e.g. `128-010100000`) mean the same thing in both projects.
 */
export const TYPES = ['Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Gamma'] as const;

const TYPE_COLORS: Record<string, string> = {
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

/** Spectre-project edge labels (14 edges per Spectre). */
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

/** Gamma2's placement inside the Mystic (Spectre project `buildSpectreBase`). */
const GAMMA2_XFORM: Affine = mul(ttrans(SPECTRE_PTS[8].x, SPECTRE_PTS[8].y), trot(Math.PI / 6));

const MYSTIC = unionBoundary([SPECTRE_PTS, SPECTRE_PTS], [IDENT, GAMMA2_XFORM]);

/** Labels on the Mystic's outer boundary, carried over from Gamma1 / Gamma2. */
const MYSTIC_LABELS = MYSTIC.source.map((s) => (s.poly === 0 ? SPECTRE_LABELS.Gamma1 : SPECTRE_LABELS.Gamma2)[s.edge]);

// --- the supertile construction -------------------------------------------

interface Leaf {
  readonly kind: 'leaf';
  readonly type: string;
}
interface Meta {
  readonly kind: 'meta';
  readonly type: string;
  readonly children: readonly { node: Node; xform: Affine }[];
}
type Node = Leaf | Meta;
type System = Record<string, Node>;

const T_RULES: readonly (readonly [number, number, number])[] = [
  [60, 3, 1],
  [0, 2, 0],
  [60, 3, 1],
  [60, 3, 1],
  [0, 2, 0],
  [60, 3, 1],
  [-120, 3, 3],
];

const SUPER_RULES: Readonly<Record<string, readonly string[]>> = {
  Gamma: ['Pi', 'Delta', 'null', 'Theta', 'Sigma', 'Xi', 'Phi', 'Gamma'],
  Delta: ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Theta: ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Lambda: ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Xi: ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
  Pi: ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
  Sigma: ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Lambda', 'Gamma'],
  Phi: ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Psi: ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
};

function supertiles(sys: System, quad: readonly Pt[]): { sys: System; quad: Pt[] } {
  const Ts: Affine[] = [IDENT];
  let totalAng = 0;
  let rot: Affine = IDENT;
  const tquad = [...quad];
  for (const [ang, from, to] of T_RULES) {
    totalAng += ang;
    if (ang !== 0) {
      rot = trot(radians(totalAng));
      for (let i = 0; i < 4; ++i) tquad[i] = transPt(rot, quad[i]);
    }
    const prev = transPt(Ts[Ts.length - 1], quad[from]);
    Ts.push(mul(ttrans(prev.x - tquad[to].x, prev.y - tquad[to].y), rot));
  }
  for (let i = 0; i < Ts.length; ++i) Ts[i] = mul(REFLECT_X, Ts[i]);
  const superQuad = [transPt(Ts[6], quad[2]), transPt(Ts[5], quad[1]), transPt(Ts[3], quad[2]), transPt(Ts[0], quad[1])];
  const out: System = {};
  for (const [lab, subs] of Object.entries(SUPER_RULES)) {
    const children: { node: Node; xform: Affine }[] = [];
    subs.forEach((s, i) => {
      if (s !== 'null') children.push({ node: sys[s], xform: Ts[i] });
    });
    out[lab] = { kind: 'meta', type: lab, children };
  }
  return { sys: out, quad: superQuad };
}

function compositionTiling(opts: {
  id: string;
  name: string;
  description: string;
  prototiles: Prototile[];
  quadIdx: readonly [number, number, number, number];
  basePts: readonly Pt[];
  labels: Record<string, readonly string[]>;
  presetName: string;
  maxLevel: number;
  defaultLevel: number;
}): Tiling {
  const levels: System[] = [];
  const base: System = {};
  for (const t of TYPES) base[t] = { kind: 'leaf', type: t };
  levels.push(base);
  let quad = opts.quadIdx.map((i) => opts.basePts[i]);
  const systemAt = (lv: number): System => {
    while (levels.length <= lv) {
      const next = supertiles(levels[levels.length - 1], quad);
      levels.push(next.sys);
      quad = next.quad;
    }
    return levels[lv];
  };
  return {
    hierarchy: {
      children(type, level) {
        const node = systemAt(level)[type];
        return node?.kind === 'meta' ? node.children.map((c) => ({ type: c.node.type, xform: c.xform })) : [];
      },
    },
    id: opts.id,
    name: opts.name,
    description: opts.description,
    prototiles: opts.prototiles,
    roots: [...TYPES],
    defaultRoot: 'Delta',
    defaultLevel: opts.defaultLevel,
    maxLevel: opts.maxLevel,
    deriveLevel: 3,
    presets: [
      {
        id: 'spectre-labels',
        name: opts.presetName,
        description: 'The 0–8 seam classes from the Spectre project (the Mystic counted as one tile, so class 7 is gone).',
        build: (t): RuleSet => ({
          id: `${t.id}:spectre-labels`,
          name: opts.presetName,
          tilingId: t.id,
          seams: Object.fromEntries(TYPES.map((ty) => [ty, seamsFromLabels(opts.labels[ty])])),
        }),
      },
    ],
    generate(level: number, root: string): readonly TileInstance[] {
      const sys = systemAt(level);
      const out: TileInstance[] = [];
      // Every level is a mirror image of the last; undo that so the view is stable.
      const start = level % 2 === 0 ? IDENT : REFLECT_X;
      const walk = (node: Node, M: Affine): void => {
        if (out.length >= MAX_INSTANCES) return;
        if (node.kind === 'leaf') out.push({ id: out.length, type: node.type, xform: M });
        else for (const c of node.children) walk(c.node, mul(M, c.xform));
      };
      walk(sys[root] ?? sys.Delta, start);
      return out;
    },
  };
}

export const spectreTiling: Tiling = compositionTiling({
  id: 'spectre',
  name: 'Spectre (Tile(1,1))',
  description:
    'The chiral aperiodic monotile. Nine tile types from the supertile construction; the Mystic (two Spectres) is one tile here.',
  prototiles: TYPES.map((t) => ({
    id: t,
    name: t,
    color: TYPE_COLORS[t],
    pts: t === 'Gamma' ? MYSTIC.pts : SPECTRE_PTS,
  })),
  quadIdx: [3, 5, 7, 11],
  basePts: SPECTRE_PTS,
  labels: { ...SPECTRE_LABELS, Gamma: MYSTIC_LABELS },
  presetName: 'Spectre classes 0–8',
  maxLevel: 5,
  defaultLevel: 3,
});

export const hexTiling: Tiling = compositionTiling({
  id: 'hex',
  name: 'Spectre hexagons',
  description: 'Hexagons glued by the same nine-type supertile rules as the Spectre: same combinatorics, simpler shapes.',
  prototiles: TYPES.map((t) => ({ id: t, name: t, color: TYPE_COLORS[t], pts: HEX_PTS })),
  quadIdx: [1, 2, 3, 5],
  basePts: HEX_PTS,
  labels: HEX_LABELS,
  presetName: 'Spectre classes 0–8',
  maxLevel: 6,
  defaultLevel: 4,
});

