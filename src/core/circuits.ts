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
import { polygonCentroid, qkey } from './polygon';
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

export function computeCircuits(input: CircuitInput): CircuitResult {
  const { tiling: t, ruleSet: rs, instances, selection } = input;
  const adj = input.adjacency ?? computeAdjacency(t, instances);
  const local = new Map<string, ReturnType<typeof localChords>>();
  for (const p of t.prototiles) local.set(p.id, localChords(t, rs, p.id, selection, input.combo[p.id] ?? 0));

  // Crossing points: how many tiles register each one, and whether any of
  // them sits on the patch boundary.
  const seen = new Map<string, number>();
  const onBoundary = new Set<string>();
  const chords: Chord[] = [];
  const ends: [string, string][] = [];
  for (const inst of instances) {
    const L = local.get(inst.type)!;
    const active = (rs.seams[inst.type] ?? []).filter((s) => selection.has(s.cls));
    const row = adj.neighbour[inst.id];
    active.forEach((s, i) => {
      const k = qkey(transPt(inst.xform, L.points[i]), 1e3);
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (s.edges.some((e) => !row?.[e])) onBoundary.add(k);
    });
    for (const ch of L.chords) {
      const a = transPt(inst.xform, ch.a);
      const b = transPt(inst.xform, ch.b);
      chords.push({ inst: inst.id, a, b, c: transPt(inst.xform, ch.c) });
      ends.push([qkey(a, 1e3), qkey(b, 1e3)]);
    }
  }

  // Node -> incident chords.
  const inc = new Map<string, number[]>();
  ends.forEach(([ka, kb], i) => {
    for (const k of [ka, kb]) {
      let l = inc.get(k);
      if (!l) inc.set(k, (l = []));
      l.push(i);
    }
  });

  const endKind = (k: string): EndKind => (onBoundary.has(k) && (seen.get(k) ?? 0) < 2 ? 'boundary' : 'tail');

  const pathOfChord = new Int32Array(chords.length).fill(-1);
  const paths: Path[] = [];
  const walk = (startNode: string, startChord: number): { list: number[]; end: string; closed: boolean } => {
    const list: number[] = [];
    let node = startNode;
    let ci = startChord;
    for (;;) {
      list.push(ci);
      pathOfChord[ci] = paths.length;
      const [ka, kb] = ends[ci];
      const next = ka === node ? kb : ka;
      if (next === startNode) return { list, end: next, closed: true };
      const cont = (inc.get(next) ?? []).find((j) => pathOfChord[j] === -1);
      if (cont === undefined) return { list, end: next, closed: false };
      node = next;
      ci = cont;
    }
  };

  // Open lines first, from their degree-1 ends.
  for (const [k, l] of inc) {
    if (l.length !== 1 || pathOfChord[l[0]] !== -1) continue;
    const r = walk(k, l[0]);
    paths.push({ chords: r.list, closed: false, ends: [endKind(k), endKind(r.end)] });
  }
  // Whatever is left is closed.
  for (let i = 0; i < chords.length; i++) {
    if (pathOfChord[i] !== -1) continue;
    const r = walk(ends[i][0], i);
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
