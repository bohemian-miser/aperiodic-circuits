/**
 * Lay the chords on a patch and follow them.
 *
 * Each tile pairs up its selected seams with the matching its combination
 * digit picks; the chords join at seam centres. Every crossing point is shared
 * by exactly two tiles, so lines never branch: each is either a closed
 * circuit or an open line. An open line ends either on the patch boundary
 * (it carries on past what we grew) or at a tail (the tile across the seam
 * has nothing to join it to).
 */

import { lerpPt, transPt, type Pt } from './geom';
import { pointKeyer, polygonCentroid } from './polygon';
import { computeAdjacency, seamCenter, type Adjacency, type RuleSet } from './ruleset';
import { nonCrossingMatching } from './matchings';
import { prototile, type TileInstance, type Tiling } from './tiling';

export interface Chord {
  readonly inst: number;
  readonly a: Pt;
  readonly b: Pt;
  /** Quadratic Bézier control point, pulled towards the tile's centre. */
  readonly c: Pt;
}

export type EndKind = 'boundary' | 'tail';

export interface Path {
  readonly chords: readonly number[];
  readonly closed: boolean;
  readonly ends: readonly EndKind[];
}

export interface CircuitResult {
  readonly chords: readonly Chord[];
  readonly paths: readonly Path[];
  /** chord index -> path index */
  readonly pathOfChord: Int32Array;
  readonly circuits: number;
  readonly openLines: number;
  readonly tails: number;
  /** Closed circuit lengths (in chords) -> how many. */
  readonly circuitLengths: ReadonlyMap<number, number>;
  /** Tile types that ended up with an odd number of crossings. */
  readonly oddTypes: readonly string[];
  /**
   * The chords were laid but not followed ({@link layChords}): no paths, every
   * `pathOfChord` is -1 and the counts are all 0.
   */
  readonly untraced?: true;
}

/** Local chords per type for a selection and combination. */
export interface LocalChord {
  readonly a: Pt;
  readonly b: Pt;
  readonly c: Pt;
}

export function localChords(
  t: Tiling,
  rs: RuleSet,
  type: string,
  sel: ReadonlySet<number>,
  comboIndex: number,
): { chords: LocalChord[]; points: Pt[]; odd: boolean } {
  const pts = prototile(t, type).pts;
  const active = (rs.seams[type] ?? []).filter((s) => sel.has(s.cls));
  const points = active.map((s) => seamCenter(pts, s));
  if (points.length % 2 === 1) return { chords: [], points, odd: true };
  const m = nonCrossingMatching(points.length, comboIndex) ?? [];
  const ctr = polygonCentroid(pts);
  const chords = m.map(([i, j]) => {
    const a = points[i];
    const b = points[j];
    const mid = lerpPt(a, b, 0.5);
    return { a, b, c: lerpPt(mid, ctr, 0.35) };
  });
  return { chords, points, odd: false };
}

export interface CircuitInput {
  readonly tiling: Tiling;
  readonly ruleSet: RuleSet;
  readonly instances: readonly TileInstance[];
  readonly selection: ReadonlySet<number>;
  /** Non-crossing matching index per type. */
  readonly combo: Readonly<Record<string, number>>;
  readonly adjacency?: Adjacency;
}

/**
 * Just lay the chords, without matching tiles up or following the lines: the
 * picture of the lines, at a fraction of the cost. What infinite mode shows
 * once the view holds too many tiles to trace (as on the Spectre map, which
 * draws the lines at any zoom but colours circuits only up to a ceiling).
 */
export function layChords(input: CircuitInput): CircuitResult {
  const { tiling: t, ruleSet: rs, instances, selection } = input;
  const local = new Map<string, ReturnType<typeof localChords>>();
  for (const p of t.prototiles) local.set(p.id, localChords(t, rs, p.id, selection, input.combo[p.id] ?? 0));
  const chords: Chord[] = [];
  for (const inst of instances) {
    for (const ch of local.get(inst.type)!.chords) {
      chords.push({ inst: inst.id, a: transPt(inst.xform, ch.a), b: transPt(inst.xform, ch.b), c: transPt(inst.xform, ch.c) });
    }
  }
  const oddTypes = t.prototiles.filter((p) => local.get(p.id)!.odd).map((p) => p.id);
  return { chords, paths: [], pathOfChord: new Int32Array(chords.length).fill(-1), circuits: 0, openLines: 0, tails: 0, circuitLengths: new Map(), oddTypes, untraced: true };
}

export function computeCircuits(input: CircuitInput): CircuitResult {
  const { tiling: t, ruleSet: rs, instances, selection } = input;
  const adj = input.adjacency ?? computeAdjacency(t, instances);
  const local = new Map<string, ReturnType<typeof localChords>>();
  for (const p of t.prototiles) local.set(p.id, localChords(t, rs, p.id, selection, input.combo[p.id] ?? 0));

  // Crossing points ("nodes", numbered as first met): how many tiles
  // register each one, and whether any of them sits on the patch boundary.
  const o = instances.length ? transPt(instances[0].xform, prototile(t, instances[0].type).pts[0]) : { x: 0, y: 0 };
  const key = pointKeyer(o);
  const nodeOf = new Map<number | string, number>();
  const node = (p: Pt): number => {
    const k = key(p.x, p.y);
    let n = nodeOf.get(k);
    if (n === undefined) nodeOf.set(k, (n = nodeOf.size));
    return n;
  };
  // Per type: its active seams, in the order localChords numbers its points.
  const activeOf = new Map(t.prototiles.map((p) => [p.id, (rs.seams[p.id] ?? []).filter((s) => selection.has(s.cls))]));
  const seenList: number[] = [];
  const boundaryList: number[] = [];
  const chords: Chord[] = [];
  const endList: number[] = [];
  for (const inst of instances) {
    const L = local.get(inst.type)!;
    const active = activeOf.get(inst.type) ?? [];
    const row = adj.neighbour[inst.id];
    for (let i = 0; i < active.length; i++) {
      const n = node(transPt(inst.xform, L.points[i]));
      seenList.push(n);
      if (active[i].edges.some((e) => !row?.[e])) boundaryList.push(n);
    }
    for (const ch of L.chords) {
      const a = transPt(inst.xform, ch.a);
      const b = transPt(inst.xform, ch.b);
      chords.push({ inst: inst.id, a, b, c: transPt(inst.xform, ch.c) });
      endList.push(node(a), node(b));
    }
  }
  const N = nodeOf.size;
  const seen = new Int32Array(N);
  for (const n of seenList) seen[n]++;
  const onBoundary = new Uint8Array(N);
  for (const n of boundaryList) onBoundary[n] = 1;
  const ends = Int32Array.from(endList);

  // Node -> incident chords: two slots each (a crossing joins two tiles),
  // with a spill list for anything odder.
  const inc0 = new Int32Array(N).fill(-1);
  const inc1 = new Int32Array(N).fill(-1);
  const deg = new Int32Array(N);
  const spill = new Map<number, number[]>();
  // Nodes in the order the chords first meet them.
  const order: number[] = [];
  for (let e = 0; e < ends.length; e++) {
    const n = ends[e];
    const ci = e >> 1;
    if (deg[n] === 0) {
      order.push(n);
      inc0[n] = ci;
    } else if (deg[n] === 1) inc1[n] = ci;
    else {
      const l = spill.get(n);
      if (l) l.push(ci);
      else spill.set(n, [ci]);
    }
    deg[n]++;
  }

  const endKind = (n: number): EndKind => (onBoundary[n] && seen[n] < 2 ? 'boundary' : 'tail');

  const pathOfChord = new Int32Array(chords.length).fill(-1);
  const unwalked = (n: number): number => {
    if (inc0[n] >= 0 && pathOfChord[inc0[n]] === -1) return inc0[n];
    if (inc1[n] >= 0 && pathOfChord[inc1[n]] === -1) return inc1[n];
    for (const j of spill.get(n) ?? []) if (pathOfChord[j] === -1) return j;
    return -1;
  };
  const paths: Path[] = [];
  const walk = (startNode: number, startChord: number): { list: number[]; end: number; closed: boolean } => {
    const list: number[] = [];
    let at = startNode;
    let ci = startChord;
    for (;;) {
      list.push(ci);
      pathOfChord[ci] = paths.length;
      const ka = ends[2 * ci];
      const kb = ends[2 * ci + 1];
      const next = ka === at ? kb : ka;
      if (next === startNode) return { list, end: next, closed: true };
      const cont = unwalked(next);
      if (cont < 0) return { list, end: next, closed: false };
      at = next;
      ci = cont;
    }
  };

  // Open lines first, from their degree-1 ends.
  for (const n of order) {
    if (deg[n] !== 1 || pathOfChord[inc0[n]] !== -1) continue;
    const r = walk(n, inc0[n]);
    paths.push({ chords: r.list, closed: false, ends: [endKind(n), endKind(r.end)] });
  }
  // Whatever is left is closed.
  for (let i = 0; i < chords.length; i++) {
    if (pathOfChord[i] !== -1) continue;
    const r = walk(ends[2 * i], i);
    paths.push({ chords: r.list, closed: r.closed, ends: r.closed ? [] : ['tail', 'tail'] });
  }

  let circuits = 0;
  let openLines = 0;
  let tails = 0;
  const circuitLengths = new Map<number, number>();
  for (const p of paths) {
    if (p.closed) {
      circuits++;
      circuitLengths.set(p.chords.length, (circuitLengths.get(p.chords.length) ?? 0) + 1);
    } else if (p.ends.includes('tail')) tails++;
    else openLines++;
  }
  const oddTypes = t.prototiles.filter((p) => local.get(p.id)!.odd).map((p) => p.id);
  return { chords, paths, pathOfChord, circuits, openLines, tails, circuitLengths, oddTypes };
}

