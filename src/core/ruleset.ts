/**
 * Rule sets: which edges of each prototile carry a crossing, grouped into
 * seams, and which seams count as the same class.
 *
 * A seam is a run of consecutive edges that meets one neighbour as a whole.
 * When its class is selected, one line crosses it at its arclength centre;
 * both tiles agree on that point because the centre is the same from either
 * end. Classes are what the edge selection picks from (the Spectre project's
 * `{2, 5, 7, 8}` and friends).
 */

import { dist, lerpPt, transPt, type Pt } from './geom';
import { pointKeyer, qkey } from './polygon';
import { prototile, type TileInstance, type Tiling } from './tiling';

export interface Seam {
  /** Consecutive edge indices (cyclic), in the prototile's edge order. */
  readonly edges: readonly number[];
  readonly cls: number;
}

export interface RuleSet {
  readonly id: string;
  readonly name: string;
  readonly tilingId: string;
  /** Seams per prototile, in boundary order. Edges in no seam never carry a line. */
  readonly seams: Readonly<Record<string, readonly Seam[]>>;
  /** Optional display names for classes. */
  readonly classNames?: Readonly<Record<number, string>>;
  readonly notes?: string;
}

/** Classes are written 0-9, a-z, then A-Z (so share strings stay one character per class). */
export const MAX_CLASSES = 62;
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function classChar(c: number): string {
  return DIGITS[c] ?? '?';
}

export function classFromChar(ch: string): number {
  return DIGITS.indexOf(ch);
}

export function className(rs: RuleSet, c: number): string {
  return rs.classNames?.[c] ?? classChar(c);
}

/** All class ids used by a rule set, ascending. */
export function ruleSetClasses(rs: RuleSet): number[] {
  const s = new Set<number>();
  for (const seams of Object.values(rs.seams)) for (const seam of seams) s.add(seam.cls);
  return [...s].sort((a, b) => a - b);
}

/** Put seams in boundary order (by first edge) so crossing order is well defined. */
export function sortSeams(seams: readonly Seam[]): Seam[] {
  return [...seams].sort((a, b) => a.edges[0] - b.edges[0]);
}

/** Edge -> seam index (or -1) for one prototile. */
export function edgeSeamIndex(rs: RuleSet, type: string, edgeCount: number): number[] {
  const out = new Array<number>(edgeCount).fill(-1);
  (rs.seams[type] ?? []).forEach((s, i) => {
    for (const e of s.edges) if (e >= 0 && e < edgeCount) out[e] = i;
  });
  return out;
}

/** Arclength centre of a seam, in the prototile's own frame. */
export function seamCenter(pts: readonly Pt[], seam: Seam): Pt {
  const n = pts.length;
  const lens = seam.edges.map((e) => dist(pts[e], pts[(e + 1) % n]));
  const half = lens.reduce((a, b) => a + b, 0) / 2;
  let acc = 0;
  for (let k = 0; k < seam.edges.length; k++) {
    if (acc + lens[k] >= half - 1e-12) {
      const e = seam.edges[k];
      const t = lens[k] > 0 ? (half - acc) / lens[k] : 0;
      return lerpPt(pts[e], pts[(e + 1) % n], Math.min(1, Math.max(0, t)));
    }
    acc += lens[k];
  }
  const e = seam.edges[seam.edges.length - 1];
  return pts[(e + 1) % n];
}

// ---------------------------------------------------------------------------
// Label-table presets (Spectre-project style labels such as '-5.1A')
// ---------------------------------------------------------------------------

const LABEL_RE = /^(-?)(\d+)\.(\d+)([A-Z])$/;

/**
 * Seams from Spectre-style labels `[sign]CLASS.INDEX[VARIANT]`: a seam is a
 * cyclic run of edges sharing sign, class and variant. `null` = unlabelled.
 */
export function seamsFromLabels(labels: readonly (string | null)[]): Seam[] {
  const n = labels.length;
  const parsed = labels.map((l) => {
    if (!l) return null;
    const m = LABEL_RE.exec(l);
    if (!m) throw new Error(`Bad label ${l}`);
    return { key: `${m[1]}${m[2]}${m[4]}`, cls: Number(m[2]) };
  });
  const same = (i: number, j: number) => {
    const a = parsed[(i + n) % n];
    const b = parsed[(j + n) % n];
    return !!a && !!b && a.key === b.key;
  };
  let start = 0;
  while (start < n && same(start - 1, start)) start++;
  if (start === n) start = 0;
  const out: Seam[] = [];
  let i = 0;
  while (i < n) {
    const idx = (start + i) % n;
    const head = parsed[idx];
    if (!head) {
      i++;
      continue;
    }
    const edges = [idx];
    let j = i + 1;
    while (j < n && same(start + j - 1, start + j)) {
      edges.push((start + j) % n);
      j++;
    }
    out.push({ edges, cls: head.cls });
    i = j;
  }
  return sortSeams(out);
}

// ---------------------------------------------------------------------------
// Edge adjacency in a patch
// ---------------------------------------------------------------------------

export interface EdgeRef {
  readonly inst: number;
  readonly edge: number;
}

export interface Adjacency {
  readonly instances: readonly TileInstance[];
  /** neighbour[inst][edge] = the edge it is glued to, or null on the patch boundary. */
  readonly neighbour: readonly (readonly (EdgeRef | null)[])[];
  /** Edges shared by more than two tiles or overlapping oddly (should be 0). */
  readonly anomalies: number;
}

export function edgeKey(a: Pt, b: Pt): string {
  const ka = qkey(a, 1e3);
  const kb = qkey(b, 1e3);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function computeAdjacency(t: Tiling, instances: readonly TileInstance[]): Adjacency {
  // Edges are bucketed by their midpoint (a numeric key, buckets chained
  // through `next`), then matched by their ends within a bucket, which is the
  // same as keying on both ends.
  const o = instances.length ? transPt(instances[0].xform, prototile(t, instances[0].type).pts[0]) : { x: 0, y: 0 };
  const key = pointKeyer(o);
  let total = 0;
  for (const inst of instances) total += prototile(t, inst.type).pts.length;
  // Per edge (flat): its tile, its index, its two end keys, the next edge in its bucket.
  const eInst = new Int32Array(total);
  const eEdge = new Int32Array(total);
  const eA: (number | string)[] = new Array(total);
  const eB: (number | string)[] = new Array(total);
  const next = new Int32Array(total).fill(-1);
  const head = new Map<number | string, number>();
  const neighbour: (EdgeRef | null)[][] = [];
  let id = 0;
  for (const inst of instances) {
    const pts = prototile(t, inst.type).pts;
    const M = inst.xform;
    const n = pts.length;
    const x0 = M[0] * pts[0].x + M[1] * pts[0].y + M[2];
    const y0 = M[3] * pts[0].x + M[4] * pts[0].y + M[5];
    const k0 = key(x0, y0);
    let xa = x0;
    let ya = y0;
    let ka = k0;
    for (let e = 0; e < n; e++) {
      const last = e + 1 === n;
      const xb = last ? x0 : M[0] * pts[e + 1].x + M[1] * pts[e + 1].y + M[2];
      const yb = last ? y0 : M[3] * pts[e + 1].x + M[4] * pts[e + 1].y + M[5];
      const kb = last ? k0 : key(xb, yb);
      const k = key((xa + xb) / 2, (ya + yb) / 2);
      eInst[id] = inst.id;
      eEdge[id] = e;
      eA[id] = ka;
      eB[id] = kb;
      const h = head.get(k);
      if (h !== undefined) next[id] = h;
      head.set(k, id);
      id++;
      xa = xb;
      ya = yb;
      ka = kb;
    }
    neighbour[inst.id] = new Array(n).fill(null);
  }
  let anomalies = 0;
  const glue = (i: number, j: number) => {
    neighbour[eInst[i]][eEdge[i]] = { inst: eInst[j], edge: eEdge[j] };
    neighbour[eInst[j]][eEdge[j]] = { inst: eInst[i], edge: eEdge[i] };
  };
  const same = (i: number, j: number) => (eA[i] === eA[j] && eB[i] === eB[j]) || (eA[i] === eB[j] && eB[i] === eA[j]);
  for (const h of head.values()) {
    const j = next[h];
    if (j < 0) continue;
    if (next[j] < 0) {
      if (same(h, j)) glue(h, j);
      continue;
    }
    // Rare: three or more edges on one midpoint. Group them by their ends.
    const left: number[] = [];
    for (let i = h; i >= 0; i = next[i]) left.push(i);
    while (left.length) {
      const i = left.shift()!;
      const group = [i];
      for (let k = left.length - 1; k >= 0; k--) if (same(i, left[k])) group.push(...left.splice(k, 1));
      if (group.length === 2) glue(group[0], group[1]);
      else if (group.length > 2) anomalies++;
    }
  }
  return { instances, neighbour, anomalies };
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class DSU {
  private p: number[] = [];
  make(): number {
    this.p.push(this.p.length);
    return this.p.length - 1;
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

// ---------------------------------------------------------------------------
// Deriving seams and classes from the tiling itself
// ---------------------------------------------------------------------------

function groupKey(groups: readonly (readonly number[])[]): string {
  return groups.map((g) => g.join('.')).join('|');
}

/**
 * The seam structure each type shows in the interior of a patch: consecutive
 * edges glued to the same neighbour form one seam. Returns null when some
 * type shows different structures in different places (then only per-edge
 * seams are consistent).
 */
export function deriveSeamStructure(t: Tiling, adj: Adjacency): Record<string, number[][]> | null {
  const seen = new Map<string, Map<string, number[][]>>();
  for (const inst of adj.instances) {
    const row = adj.neighbour[inst.id];
    if (row.some((r) => r === null)) continue; // only fully surrounded tiles
    const n = row.length;
    const same = (i: number, j: number) => row[(i + n) % n]!.inst === row[(j + n) % n]!.inst;
    let start = 0;
    while (start < n && same(start - 1, start)) start++;
    if (start === n) start = 0;
    const groups: number[][] = [];
    let i = 0;
    while (i < n) {
      const g = [(start + i) % n];
      let j = i + 1;
      while (j < n && same(start + j - 1, start + j)) {
        g.push((start + j) % n);
        j++;
      }
      groups.push(g);
      i = j;
    }
    groups.sort((a, b) => a[0] - b[0]);
    let m = seen.get(inst.type);
    if (!m) seen.set(inst.type, (m = new Map()));
    m.set(groupKey(groups), groups);
  }
  const out: Record<string, number[][]> = {};
  for (const p of t.prototiles) {
    const m = seen.get(p.id);
    if (!m) out[p.id] = p.pts.map((_, i) => [i]);
    else if (m.size === 1) out[p.id] = [...m.values()][0];
    else return null;
  }
  return out;
}

export function perEdgeStructure(t: Tiling): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  for (const p of t.prototiles) out[p.id] = p.pts.map((_, i) => [i]);
  return out;
}

/**
 * The finest classes consistent with a seam structure: two seams share a
 * class exactly when (a chain of) them meet somewhere in the patch. Any
 * merge of these classes is still consistent; any split of one is not.
 */
export function deriveClasses(
  t: Tiling,
  adj: Adjacency,
  structure: Record<string, number[][]>,
): Record<string, Seam[]> {
  const dsu = new DSU();
  const ids = new Map<string, number[]>(); // type -> node id per seam
  const seamOfEdge = new Map<string, number[]>();
  for (const p of t.prototiles) {
    const groups = structure[p.id];
    ids.set(p.id, groups.map(() => dsu.make()));
    const soe = new Array<number>(p.pts.length).fill(-1);
    groups.forEach((g, gi) => g.forEach((e) => (soe[e] = gi)));
    seamOfEdge.set(p.id, soe);
  }
  for (const inst of adj.instances) {
    const row = adj.neighbour[inst.id];
    row.forEach((nb, e) => {
      if (!nb || nb.inst < inst.id) return;
      const other = adj.instances[nb.inst];
      const sa = seamOfEdge.get(inst.type)![e];
      const sb = seamOfEdge.get(other.type)![nb.edge];
      if (sa < 0 || sb < 0) return;
      dsu.union(ids.get(inst.type)![sa], ids.get(other.type)![sb]);
    });
  }
  // Number classes by first appearance in prototile/seam order.
  const classOfRoot = new Map<number, number>();
  const out: Record<string, Seam[]> = {};
  for (const p of t.prototiles) {
    const groups = structure[p.id];
    out[p.id] = groups.map((g, gi) => {
      const r = dsu.find(ids.get(p.id)![gi]);
      if (!classOfRoot.has(r)) classOfRoot.set(r, classOfRoot.size);
      return { edges: g, cls: classOfRoot.get(r)! };
    });
  }
  return out;
}

/** Patch used for deriving/validating, memoized per tiling. */
const adjCache = new Map<string, Adjacency>();
export function deriveAdjacency(t: Tiling): Adjacency {
  const key = t.id;
  const hit = adjCache.get(key);
  if (hit) return hit;
  // Grow from every root so every type gets seen in the interior.
  const all: TileInstance[] = [];
  const insts = t.generate(t.deriveLevel, t.defaultRoot);
  for (const i of insts) all.push({ ...i, id: all.length });
  const adj = computeAdjacency(t, all);
  adjCache.set(key, adj);
  return adj;
}

export function derivedRuleSet(t: Tiling, mode: 'seams' | 'edges' = 'seams'): RuleSet {
  const adj = deriveAdjacency(t);
  const structure = (mode === 'seams' ? deriveSeamStructure(t, adj) : null) ?? perEdgeStructure(t);
  return {
    id: `${t.id}:derived-${mode}`,
    name: mode === 'seams' ? 'Derived seams' : 'Derived, one seam per edge',
    tilingId: t.id,
    seams: deriveClasses(t, adj, structure),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface Conflict {
  readonly kind: 'class' | 'structure' | 'unlabelled';
  readonly typeA: string;
  readonly seamA: number;
  readonly typeB: string;
  readonly seamB: number;
  readonly clsA: number | null;
  readonly clsB: number | null;
  readonly count: number;
}

export interface Validation {
  readonly ok: boolean;
  readonly conflicts: readonly Conflict[];
  /** Seam meetings checked. */
  readonly meetings: number;
}

/**
 * Check a rule set against a patch. Every seam must meet exactly one whole
 * seam of its neighbour ('structure'), of the same class ('class'), and a
 * labelled edge must never meet an unlabelled one ('unlabelled').
 */
export function validateRuleSet(t: Tiling, rs: RuleSet, adj: Adjacency = deriveAdjacency(t)): Validation {
  const soe = new Map<string, number[]>();
  for (const p of t.prototiles) soe.set(p.id, edgeSeamIndex(rs, p.id, p.pts.length));
  const agg = new Map<string, Conflict>();
  const add = (c: Omit<Conflict, 'count'>) => {
    const k = `${c.kind}|${c.typeA}|${c.seamA}|${c.typeB}|${c.seamB}`;
    const prev = agg.get(k);
    agg.set(k, { ...c, count: (prev?.count ?? 0) + 1 });
  };
  let meetings = 0;
  for (const inst of adj.instances) {
    const row = adj.neighbour[inst.id];
    const seams = rs.seams[inst.type] ?? [];
    const mySoe = soe.get(inst.type)!;
    // Unlabelled edges meeting labelled ones.
    row.forEach((nb, e) => {
      if (!nb || mySoe[e] >= 0) return;
      const other = adj.instances[nb.inst];
      const s = soe.get(other.type)![nb.edge];
      if (s >= 0) {
        add({ kind: 'unlabelled', typeA: inst.type, seamA: -1, typeB: other.type, seamB: s, clsA: null, clsB: rs.seams[other.type][s].cls });
      }
    });
    seams.forEach((seam, si) => {
      const nbs = seam.edges.map((e) => row[e]);
      if (nbs.some((x) => x === null)) return; // on the patch boundary
      const binst = nbs[0]!.inst;
      const other = adj.instances[binst];
      if (binst < inst.id) return; // count each meeting once
      const otherSoe = soe.get(other.type)!;
      const sb = otherSoe[nbs[0]!.edge];
      meetings++;
      const whole =
        nbs.every((x) => x!.inst === binst && otherSoe[x!.edge] === sb) &&
        sb >= 0 &&
        rs.seams[other.type][sb].edges.length === seam.edges.length;
      if (!whole) {
        add({ kind: 'structure', typeA: inst.type, seamA: si, typeB: other.type, seamB: sb, clsA: seam.cls, clsB: sb >= 0 ? rs.seams[other.type][sb].cls : null });
        return;
      }
      const cb = rs.seams[other.type][sb].cls;
      if (cb !== seam.cls) add({ kind: 'class', typeA: inst.type, seamA: si, typeB: other.type, seamB: sb, clsA: seam.cls, clsB: cb });
    });
  }
  const conflicts = [...agg.values()].sort((a, b) => b.count - a.count);
  return { ok: conflicts.length === 0, conflicts, meetings };
}

/** Merge every pair of classes that meet, then renumber densely. */
export function mergeConflictingClasses(rs: RuleSet, v: Validation): RuleSet {
  const classes = ruleSetClasses(rs);
  const dsu = new DSU();
  const node = new Map<number, number>();
  for (const c of classes) node.set(c, dsu.make());
  for (const c of v.conflicts) {
    if (c.kind === 'class' && c.clsA !== null && c.clsB !== null) dsu.union(node.get(c.clsA)!, node.get(c.clsB)!);
  }
  return renumberClasses({ ...rs, seams: mapClasses(rs, (c) => classes[dsu.find(node.get(c)!)]) });
}

function mapClasses(rs: RuleSet, f: (c: number) => number): Record<string, Seam[]> {
  const out: Record<string, Seam[]> = {};
  for (const [k, seams] of Object.entries(rs.seams)) out[k] = seams.map((s) => ({ ...s, cls: f(s.cls) }));
  return out;
}

/** Renumber classes 0..k-1 in order of first appearance; names follow their class. */
export function renumberClasses(rs: RuleSet, order: readonly string[] = Object.keys(rs.seams)): RuleSet {
  const map = new Map<number, number>();
  for (const k of order) for (const s of rs.seams[k] ?? []) if (!map.has(s.cls)) map.set(s.cls, map.size);
  let classNames: Record<number, string> | undefined;
  if (rs.classNames) {
    classNames = {};
    for (const [from, to] of map) if (rs.classNames[from] !== undefined) classNames[to] = rs.classNames[from];
  }
  return { ...rs, seams: mapClasses(rs, (c) => map.get(c) ?? c), classNames };
}

// ---------------------------------------------------------------------------
// Editing helpers (used by the builder)
// ---------------------------------------------------------------------------

/** Set the class of the seam containing `edge`, creating a one-edge seam if needed. */
export function setEdgeClass(rs: RuleSet, type: string, edge: number, cls: number | null): RuleSet {
  const seams = [...(rs.seams[type] ?? [])];
  const i = seams.findIndex((s) => s.edges.includes(edge));
  if (cls === null) {
    if (i >= 0) {
      // Remove just this edge; whatever is left either side stays as seams.
      const s = seams[i];
      const k = s.edges.indexOf(edge);
      const left = s.edges.slice(0, k);
      const right = s.edges.slice(k + 1);
      seams.splice(i, 1, ...[left, right].filter((g) => g.length).map((g) => ({ edges: g, cls: s.cls })));
    }
  } else if (i >= 0) seams[i] = { ...seams[i], cls };
  else seams.push({ edges: [edge], cls });
  return { ...rs, seams: { ...rs.seams, [type]: sortSeams(seams) } };
}

/** Join the seam holding `edge` with the seam holding the next edge (keeps this seam's class). */
export function joinWithNext(rs: RuleSet, type: string, edge: number, edgeCount: number): RuleSet {
  const seams = [...(rs.seams[type] ?? [])];
  const i = seams.findIndex((s) => s.edges.includes(edge));
  if (i < 0) return rs;
  const last = seams[i].edges[seams[i].edges.length - 1];
  const next = (last + 1) % edgeCount;
  const j = seams.findIndex((s) => s.edges.includes(next));
  if (j === i) return rs;
  const merged: Seam = {
    edges: j >= 0 ? [...seams[i].edges, ...seams[j].edges] : [...seams[i].edges, next],
    cls: seams[i].cls,
  };
  const rest = seams.filter((_, k) => k !== i && k !== j);
  return { ...rs, seams: { ...rs.seams, [type]: sortSeams([...rest, merged]) } };
}

/** Split the seam holding `edge` so `edge` starts a new seam of the same class. */
export function splitBefore(rs: RuleSet, type: string, edge: number): RuleSet {
  const seams = [...(rs.seams[type] ?? [])];
  const i = seams.findIndex((s) => s.edges.includes(edge));
  if (i < 0) return rs;
  const k = seams[i].edges.indexOf(edge);
  if (k === 0) return rs;
  const s = seams[i];
  seams.splice(i, 1, { edges: s.edges.slice(0, k), cls: s.cls }, { edges: s.edges.slice(k), cls: s.cls });
  return { ...rs, seams: { ...rs.seams, [type]: sortSeams(seams) } };
}

/** The lowest class id not yet in use. */
export function freshClass(rs: RuleSet): number {
  const used = new Set(ruleSetClasses(rs));
  for (let c = 0; c < MAX_CLASSES; c++) if (!used.has(c)) return c;
  return MAX_CLASSES - 1;
}
