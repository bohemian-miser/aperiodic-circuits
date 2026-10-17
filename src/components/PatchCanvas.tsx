import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Chord, CircuitResult } from '../core/circuits';
import type { Pt } from '../core/geom';
import { edgeSeamIndex, type RuleSet } from '../core/ruleset';
import { instancePts, patchBounds, prototile, type TileInstance, type Tiling } from '../core/tiling';
import { classColor, lengthHue, mixColor, OPEN_COLOR, rainbow, TAIL_COLOR, toRgb, type Rgb } from '../colors';
import type { StrandChase } from '../core/chase';
import { advanceFollowCamera, createFollowCamera } from '../core/followCamera';
import { halfAt, MORPH_MS, morphChords, morphProgress, prefersReducedMotion, type ChordMorph } from '../core/morph';

export interface PatchCanvasProps {
  readonly tiling: Tiling;
  readonly instances: readonly TileInstance[];
  readonly ruleSet?: RuleSet;
  readonly circuits?: CircuitResult;
  readonly showTiles?: boolean;
  readonly showOutlines?: boolean;
  /** Colour open lines red-to-violet along their length (otherwise one flat colour). */
  readonly rainbowLines?: boolean;
  /** Stroke edges in their class colour (only the classes given, if any). */
  readonly classEdges?: ReadonlySet<number> | 'all' | null;
  readonly selectedPath?: number | null;
  /** A click picked a line (its path and the chord clicked), or nothing. */
  readonly onSelectPath?: (path: number | null, chord: number | null) => void;
  readonly lineWidth?: number;
  /** Re-fit the view when this changes (default: whenever the patch changes). */
  readonly fitKey?: unknown;
  /** What to fit to (default: the whole patch). */
  readonly fitBounds?: WorldRect;
  /** Called (debounced) with the world rectangle on screen after the view settles. */
  readonly onViewChange?: (rect: WorldRect) => void;
  /** Stop zooming out once roughly this many tiles of this area would be on screen. */
  readonly zoomLimit?: { readonly tileArea: number; readonly maxTiles: number };
  /** Draw the picked line as a rainbow from end to end (infinite mode's traced strand). */
  readonly selectedRainbow?: boolean;
  /**
   * How the traced line's rainbow runs: 'repeat' cycles red to violet and
   * back every {@link TRAIL_RAINBOW_PERIOD} tiles; 'stretch' spreads one
   * gradient over the whole line held, restretching as it grows.
   */
  readonly trailRainbow?: TrailRainbow;
  /** A line being chased: walked on, drawn as a trail over everything, with the camera riding its head. */
  readonly chase?: StrandChase | null;
  /** Chase pace in tiles per second, or null to go as fast as the camera can follow. */
  readonly chasePace?: number | null;
  /** Follow-camera damping: 1 is the Spectre map's feel, higher is floatier. */
  readonly chaseDamping?: number;
  /** Called a few times a second while the chase moves on. */
  readonly onChaseTick?: () => void;
  /**
   * While this stays the same, a change of lines (a new pairing) animates:
   * each crossing's line swings over from its old partner to its new one.
   */
  readonly morphKey?: unknown;
  /**
   * Screen pixels covered by panels floating over the top and bottom of the
   * canvas: fitting centres the patch in what's left, and the zoom buttons
   * sit below the top one. Changing them never moves the view.
   */
  readonly insets?: { readonly top: number; readonly bottom: number };
}

export type TrailRainbow = 'repeat' | 'stretch';

/** The repeating rainbow runs red to violet and back every this many tiles. */
export const TRAIL_RAINBOW_PERIOD = 600;
/** Trail chords per drawing chunk. */
const TRAIL_CHUNK = 512;
/**
 * Trail chords per piece of a chunk, for the stretched rainbow: its colours
 * move as the line grows, so they can't be baked in. Each piece is stroked in
 * the colour of where it now sits along the line.
 */
const TRAIL_PIECE = 8;
/** With more pieces than this on screen, a whole chunk takes one colour. */
const MAX_TRAIL_PIECES = 2000;
/** Colour steps along a rainbow. */
const RAINBOW_STEPS = 47;

interface TrailChunk {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The line's index of the chunk's first chord. */
  readonly base: number;
  readonly all: Path2D;
  /** 'repeat': the chunk's chords by colour. */
  readonly buckets: Map<string, Path2D>;
  /** 'stretch': the chunk's chords in runs of TRAIL_PIECE. */
  readonly pieces: Path2D[];
}

/** The repeating rainbow's colour for the line's g-th chord. */
function repeatingRainbow(g: number): string {
  const u = (g / TRAIL_RAINBOW_PERIOD) % 2;
  return rainbow(Math.round((u < 1 ? u : 2 - u) * RAINBOW_STEPS) / RAINBOW_STEPS);
}

/** The stretched rainbow's colour at fraction t of the way along the line. */
function stretchedRainbow(t: number): string {
  return rainbow(Math.round(Math.max(0, Math.min(1, t)) * RAINBOW_STEPS) / RAINBOW_STEPS);
}

export interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * A pairing change in progress, worked out in full before its first frame.
 * The lines that stay put are drawn once with their old colours and once
 * with their new ones; a frame cross-fades the two pictures and strokes only
 * the halves on the move.
 */
interface MorphState {
  /** When the first frame went up (the clock starts once everything is ready). */
  start: number | null;
  /** Its last frame (the finished picture) has been drawn. */
  done: boolean;
  readonly morph: ChordMorph;
  /** The lines that stay put, by their old and by their new colour. */
  readonly stillOld: Map<string, Path2D>;
  readonly stillNew: Map<string, Path2D>;
  /** Moving halves (indices into `morph.moving`) by old and new colour. */
  readonly halves: Map<string, MorphHalves>;
  base: {
    readonly from: HTMLCanvasElement;
    readonly to: HTMLCanvasElement;
    readonly view: View;
    /** The moving halves on screen in this view, by colour pair. */
    readonly shown: readonly { readonly H: MorphHalves; readonly list: readonly number[] }[];
  } | null;
}

type MorphHalves = { readonly from: Rgb; readonly to: Rgb; readonly fixed: string | null; readonly list: number[] };

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Bézier point at t. */
function bez(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export function pathColors(r: CircuitResult): string[] {
  const lengths = [...r.circuitLengths.keys()].sort((a, b) => a - b);
  const rank = new Map(lengths.map((l, i) => [l, i]));
  return r.paths.map((p) => (p.closed ? lengthHue(rank.get(p.chords.length) ?? 0) : p.ends.includes('tail') ? TAIL_COLOR : OPEN_COLOR));
}

/**
 * The colour of a circuit of length `len`: the patch's colour for that length,
 * or, for a length not on the patch, the one it would get if it were.
 */
function circuitColor(r: CircuitResult | null | undefined, len: number): string {
  let rank = 0;
  for (const l of r?.circuitLengths.keys() ?? []) if (l < len) rank++;
  return lengthHue(rank);
}

/** Chord line width in world units at this zoom. */
function chordWidth(scale: number, lineWidth = 1): number {
  const px = 1 / scale;
  return lineWidth * Math.max(1.2 * px, Math.min(0.14, 4 * px));
}

export function PatchCanvas(props: PatchCanvasProps) {
  const { tiling, instances, ruleSet, circuits, showTiles = true, showOutlines = true, rainbowLines = true, classEdges = null, selectedPath = null, onSelectPath, chase = null, trailRainbow = 'repeat' } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const frame = useRef(0);
  const size = useRef({ w: 1, h: 1 });

  // Geometry batched into a few Path2Ds so redraws stay cheap. The edges are
  // only built once something draws them: zoomed well out (infinite mode
  // regrowing 100,000 tiles as you pan) nothing does.
  const geo = useMemo(() => {
    const fills = new Map<string, Path2D>();
    for (const inst of instances) {
      const proto = prototile(tiling, inst.type);
      const pts = instancePts(tiling, inst);
      let f = fills.get(proto.color);
      if (!f) fills.set(proto.color, (f = new Path2D()));
      f.moveTo(pts[0].x, pts[0].y);
      // No closePath: fill closes each subpath anyway, and closePath gets slow
      // on a Path2D holding tens of thousands of them.
      for (let i = 1; i < pts.length; i++) f.lineTo(pts[i].x, pts[i].y);
    }
    let edges: { outline: Path2D; hidden: Path2D; byClass: Map<number, Path2D> } | null = null;
    const getEdges = () => {
      if (edges) return edges;
      const outline = new Path2D();
      const hidden = new Path2D();
      const byClass = new Map<number, Path2D>();
      const seamIdx = new Map<string, number[]>();
      if (ruleSet) for (const p of tiling.prototiles) seamIdx.set(p.id, edgeSeamIndex(ruleSet, p.id, p.pts.length));
      for (const inst of instances) {
        const pts = instancePts(tiling, inst);
        const hid = prototile(tiling, inst.type).hiddenEdges;
        const soe = seamIdx.get(inst.type);
        for (let e = 0; e < pts.length; e++) {
          const a = pts[e];
          const b = pts[(e + 1) % pts.length];
          const target = hid?.includes(e) ? hidden : outline;
          target.moveTo(a.x, a.y);
          target.lineTo(b.x, b.y);
          if (soe && soe[e] >= 0) {
            const cls = ruleSet!.seams[inst.type][soe[e]].cls;
            let cp = byClass.get(cls);
            if (!cp) byClass.set(cls, (cp = new Path2D()));
            cp.moveTo(a.x, a.y);
            cp.lineTo(b.x, b.y);
          }
        }
      }
      return (edges = { outline, hidden, byClass });
    };
    return { fills, edges: getEdges, bounds: patchBounds(tiling, instances) };
  }, [tiling, instances, ruleSet]);

  const chordGeo = useMemo(() => {
    if (!circuits) return null;
    const colors = pathColors(circuits);
    // Open lines (the candidates for infinite ones) run through a rainbow
    // from one end to the other, so you can see where a long one goes.
    const chordColor: string[] = circuits.chords.map((_, i) => colors[circuits.pathOfChord[i]] ?? OPEN_COLOR);
    for (const path of rainbowLines ? circuits.paths : []) {
      if (path.closed || path.ends.includes('tail') || path.chords.length < 2) continue;
      const n = path.chords.length;
      path.chords.forEach((ci, k) => (chordColor[ci] = rainbow(Math.round((k / (n - 1)) * 47) / 47)));
    }
    const byColor = new Map<string, Path2D>();
    circuits.chords.forEach((ch, i) => {
      const col = chordColor[i];
      let p = byColor.get(col);
      if (!p) byColor.set(col, (p = new Path2D()));
      p.moveTo(ch.a.x, ch.a.y);
      p.quadraticCurveTo(ch.c.x, ch.c.y, ch.b.x, ch.b.y);
    });
    return { byColor, colors, chordColor };
  }, [circuits, rainbowLines]);

  const morph = useRef<MorphState | null>(null);
  const morphFrom = useRef<{ circuits?: CircuitResult; colors?: readonly string[]; key: unknown }>({ key: undefined });
  const morphRaf = useRef(0);

  const selectedGeo = useMemo(() => {
    if (!circuits || selectedPath === null || !circuits.paths[selectedPath]) return null;
    const p = new Path2D();
    const chords = circuits.paths[selectedPath].chords;
    // Rainbow buckets along the line, in walk order.
    const buckets = new Map<string, Path2D>();
    chords.forEach((ci, k) => {
      const ch = circuits.chords[ci];
      p.moveTo(ch.a.x, ch.a.y);
      p.quadraticCurveTo(ch.c.x, ch.c.y, ch.b.x, ch.b.y);
      const col = trailRainbow === 'repeat' ? repeatingRainbow(k) : stretchedRainbow(chords.length > 1 ? k / (chords.length - 1) : 0);
      let b = buckets.get(col);
      if (!b) buckets.set(col, (b = new Path2D()));
      b.moveTo(ch.a.x, ch.a.y);
      b.quadraticCurveTo(ch.c.x, ch.c.y, ch.b.x, ch.b.y);
    });
    return { all: p, buckets };
  }, [circuits, selectedPath, trailRainbow]);

  // The chase trail, kept as Path2Ds in chunks of consecutive chords that
  // are only ever appended to, so a frame strokes just the chunks on screen
  // and the hold drops whole chunks off the back. A change of rainbow
  // rebuilds them from the chords held.
  const trail = useRef<{ chase: StrandChase; mode: TrailRainbow; built: number; chunks: Map<number, TrailChunk> } | null>(null);
  const drawTrail = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    if (!chase) return;
    let T = trail.current;
    if (!T || T.chase !== chase || T.mode !== trailRainbow) T = trail.current = { chase, mode: trailRainbow, built: 0, chunks: new Map() };
    const end = chase.dropped + chase.chords;
    for (let g = Math.max(T.built, chase.dropped); g < end; g++) {
      const ch = chase.chord(g - chase.dropped);
      const k = Math.floor(g / TRAIL_CHUNK);
      let C = T.chunks.get(k);
      if (!C) T.chunks.set(k, (C = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, base: k * TRAIL_CHUNK, all: new Path2D(), buckets: new Map(), pieces: [] }));
      let b: Path2D;
      if (T.mode === 'repeat') {
        const col = repeatingRainbow(g);
        let hit = C.buckets.get(col);
        if (!hit) C.buckets.set(col, (hit = new Path2D()));
        b = hit;
      } else {
        const i = Math.floor((g % TRAIL_CHUNK) / TRAIL_PIECE);
        b = C.pieces[i] ??= new Path2D();
      }
      for (const q of [C.all, b]) {
        q.moveTo(ch.a.x, ch.a.y);
        q.quadraticCurveTo(ch.c.x, ch.c.y, ch.b.x, ch.b.y);
      }
      for (const p of [ch.a, ch.b, ch.c]) {
        C.minX = Math.min(C.minX, p.x);
        C.minY = Math.min(C.minY, p.y);
        C.maxX = Math.max(C.maxX, p.x);
        C.maxY = Math.max(C.maxY, p.y);
      }
    }
    T.built = end;
    for (const k of T.chunks.keys()) if ((k + 1) * TRAIL_CHUNK <= chase.dropped) T.chunks.delete(k);
    const dpr = window.devicePixelRatio || 1;
    const v = view.current;
    const { w, h } = size.current;
    ctx.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.tx * dpr, v.ty * dpr);
    const lw = chordWidth(v.scale, props.lineWidth);
    const pad = lw * 4;
    const minX = -v.tx / v.scale - pad;
    const minY = -v.ty / v.scale - pad;
    const maxX = (w - v.tx) / v.scale + pad;
    const maxY = (h - v.ty) / v.scale + pad;
    const shown = [...T.chunks.values()].filter((C) => C.maxX >= minX && C.minX <= maxX && C.maxY >= minY && C.minY <= maxY);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = cssVar(canvas, '--highlight-halo', '#ffffff');
    ctx.lineWidth = lw * 3.2;
    for (const C of shown) ctx.stroke(C.all);
    ctx.lineWidth = lw * 1.8;
    // A closed circuit takes one solid colour by its length, as on the patch.
    if (chase.status === 'closed') {
      ctx.strokeStyle = circuitColor(circuits, chase.steps);
      for (const C of shown) ctx.stroke(C.all);
      // Its head is back at the start: a marker there would read as a gap in the loop.
      return;
    }
    if (T.mode === 'repeat') {
      for (const C of shown) {
        for (const [col, b] of C.buckets) {
          ctx.strokeStyle = col;
          ctx.stroke(b);
        }
      }
    } else {
      // Red at the oldest chord held, violet at the head: each piece in the
      // colour of where it now sits, or each chunk when too many show.
      const held = Math.max(1, chase.chords - 1);
      const at = (g: number) => stretchedRainbow((g - chase.dropped) / held);
      const fine = shown.length * (TRAIL_CHUNK / TRAIL_PIECE) <= MAX_TRAIL_PIECES;
      for (const C of shown) {
        if (!fine) {
          ctx.strokeStyle = at(C.base + TRAIL_CHUNK / 2);
          ctx.stroke(C.all);
          continue;
        }
        C.pieces.forEach((p, i) => {
          ctx.strokeStyle = at(C.base + i * TRAIL_PIECE + TRAIL_PIECE / 2);
          ctx.stroke(p);
        });
      }
    }
    const hd = chase.headPt;
    ctx.beginPath();
    ctx.arc(hd.x, hd.y, Math.max(lw * 2.4, 4 / v.scale), 0, 2 * Math.PI);
    ctx.fillStyle = cssVar(canvas, '--highlight-halo', '#ffffff');
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#111';
    ctx.stroke();
  };
  const drawTrailRef = useRef(drawTrail);
  drawTrailRef.current = drawTrail;

  // A big patch is slow to stroke, so while the view is moving a frame just
  // shifts and scales a snapshot of the last full draw; the full draw comes
  // back once the view has been still for a moment.
  const snapshot = useRef<{ canvas: HTMLCanvasElement; view: View; ms: number } | null>(null);
  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const t0 = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size.current;
    const v = view.current;
    const px = 1 / v.scale;
    const dim = selectedGeo !== null || chase !== null;
    const lw = chordWidth(v.scale, props.lineWidth);
    // The tiles and edges, then set up to stroke chords.
    const ground = (c: CanvasRenderingContext2D) => {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = cssVar(canvas, '--canvas-bg', '#fbfaf7');
      c.fillRect(0, 0, w * dpr, h * dpr);
      c.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.tx * dpr, v.ty * dpr);
      if (showTiles) {
        c.globalAlpha = dim ? 0.3 : 0.55;
        for (const [color, p] of geo.fills) {
          c.fillStyle = color;
          c.fill(p);
        }
        c.globalAlpha = 1;
      }
      if (showOutlines && v.scale > 2) {
        c.strokeStyle = cssVar(canvas, '--tile-edge', 'rgba(40,40,40,0.55)');
        c.lineWidth = Math.min(1.2, v.scale / 12) * px;
        c.stroke(geo.edges().outline);
        c.save();
        c.globalAlpha = 0.35;
        c.setLineDash([3 * px, 3 * px]);
        c.stroke(geo.edges().hidden);
        c.restore();
      }
      if (classEdges) {
        c.lineWidth = Math.max(1.5 * px, Math.min(0.12, 5 * px));
        c.lineCap = 'round';
        for (const [cls, p] of geo.edges().byClass) {
          if (classEdges !== 'all' && !classEdges.has(cls)) continue;
          c.strokeStyle = classColor(cls);
          c.stroke(p);
        }
      }
      c.lineWidth = lw;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.globalAlpha = dim ? 0.25 : 1;
    };

    const M = morph.current;
    if (M && chordGeo) {
      let B = M.base;
      // The bases are drawn for one view: a pan or zoom mid-swing redraws them.
      const fresh = !B || B.view.scale !== v.scale || B.view.tx !== v.tx || B.view.ty !== v.ty || B.from.width !== canvas.width || B.from.height !== canvas.height;
      if (!B || fresh) {
        const layer = () => {
          const c = document.createElement('canvas');
          c.width = canvas.width;
          c.height = canvas.height;
          return c;
        };
        const g = layer();
        const gctx = g.getContext('2d');
        if (gctx) ground(gctx);
        const paint = (still: Map<string, Path2D>) => {
          const c = layer();
          const cx = c.getContext('2d');
          if (!cx) return c;
          cx.drawImage(g, 0, 0);
          cx.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.tx * dpr, v.ty * dpr);
          cx.lineWidth = lw;
          cx.lineCap = 'round';
          cx.lineJoin = 'round';
          cx.globalAlpha = dim ? 0.25 : 1;
          for (const [color, p] of still) {
            cx.strokeStyle = color;
            cx.stroke(p);
          }
          return c;
        };
        const pad = lw * 2;
        const x0 = -v.tx / v.scale - pad;
        const y0 = -v.ty / v.scale - pad;
        const x1 = (w - v.tx) / v.scale + pad;
        const y1 = (h - v.ty) / v.scale + pad;
        const on = (p: Pt) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        const shown = [...M.halves.values()].map((H) => ({
          H,
          // A half lies within its end and its two middles' hull, near enough.
          list: H.list.filter((i) => {
            const hf = M.morph.moving[i];
            return on(hf.e) || on(hf.m0) || on(hf.m1);
          }),
        }));
        B = M.base = { from: paint(M.stillOld), to: paint(M.stillNew), view: { ...v }, shown };
      }
      // The first frame of fresh bases can be slow to show (the browser
      // renders them then), so the clock starts on the frame after it: the
      // whole swing is seen, however long the setting up took.
      const now = performance.now();
      if (M.start === null && !fresh) M.start = now;
      const u = M.start === null ? 0 : morphProgress(M.start, now);
      if (M.start !== null && now - M.start >= MORPH_MS) M.done = true;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(B.from, 0, 0);
      ctx.globalAlpha = u;
      ctx.drawImage(B.to, 0, 0);
      ctx.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.tx * dpr, v.ty * dpr);
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = dim ? 0.25 : 1;
      for (const { H, list } of B.shown) {
        if (list.length === 0) continue;
        const path = new Path2D();
        for (const i of list) {
          const { e, q, m } = halfAt(M.morph.moving[i], u);
          path.moveTo(e.x, e.y);
          path.quadraticCurveTo(q.x, q.y, m.x, m.y);
        }
        ctx.strokeStyle = H.fixed ?? mixColor(H.from, H.to, u);
        ctx.stroke(path);
      }
      ctx.globalAlpha = 1;
      drawTrail(ctx, canvas);
      reportView();
      return;
    }

    ground(ctx);
    if (chordGeo) {
      for (const [color, p] of chordGeo.byColor) {
        ctx.strokeStyle = color;
        ctx.stroke(p);
      }
      ctx.globalAlpha = 1;
      if (selectedGeo) {
        ctx.strokeStyle = cssVar(canvas, '--highlight-halo', '#ffffff');
        ctx.lineWidth = lw * 3.2;
        ctx.stroke(selectedGeo.all);
        ctx.lineWidth = lw * 1.8;
        if (props.selectedRainbow) {
          for (const [col, b] of selectedGeo.buckets) {
            ctx.strokeStyle = col;
            ctx.stroke(b);
          }
        } else {
          ctx.strokeStyle = chordGeo.colors[selectedPath!] ?? '#000';
          ctx.stroke(selectedGeo.all);
        }
      }
    }
    ctx.globalAlpha = 1;
    const snap = snapshot.current?.canvas ?? document.createElement('canvas');
    if (snap.width !== canvas.width || snap.height !== canvas.height) {
      snap.width = canvas.width;
      snap.height = canvas.height;
    }
    const sctx = snap.getContext('2d');
    if (sctx) {
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, snap.width, snap.height);
      sctx.drawImage(canvas, 0, 0);
    }
    snapshot.current = { canvas: snap, view: { ...v }, ms: performance.now() - t0 };
    drawTrail(ctx, canvas);
    reportView();
  }, [geo, chordGeo, selectedGeo, selectedPath, showTiles, showOutlines, classEdges, props.lineWidth, props.selectedRainbow, chase, trailRainbow]);

  // Tell the owner what's on screen once the view stops moving.
  const viewTimer = useRef(0);
  const lastReported = useRef('');
  const lastReportAt = useRef(0);
  const onViewChangeRef = useRef(props.onViewChange);
  onViewChangeRef.current = props.onViewChange;
  function reportView(): void {
    if (!onViewChangeRef.current) return;
    window.clearTimeout(viewTimer.current);
    // A view that never stops (a chase) still reports every so often.
    const wait = performance.now() - lastReportAt.current > 600 ? 0 : 140;
    viewTimer.current = window.setTimeout(() => {
      lastReportAt.current = performance.now();
      const v = view.current;
      const { w, h } = size.current;
      const rect = { minX: -v.tx / v.scale, minY: -v.ty / v.scale, maxX: (w - v.tx) / v.scale, maxY: (h - v.ty) / v.scale };
      const key = [rect.minX, rect.minY, rect.maxX, rect.maxY].map((x) => x.toFixed(3)).join(',');
      if (key === lastReported.current) return;
      lastReported.current = key;
      onViewChangeRef.current?.(rect);
    }, wait);
  }

  const minScale = useCallback(() => {
    const zl = props.zoomLimit;
    if (!zl) return 1e-3;
    const { w, h } = size.current;
    return Math.sqrt((w * h) / (zl.maxTiles * zl.tileArea));
  }, [props.zoomLimit]);
  const minScaleRef = useRef(minScale);
  minScaleRef.current = minScale;


  const drawRef = useRef(draw);
  drawRef.current = draw;
  // Anything but a view change needs a full draw.
  const quick = useRef(false);
  const settleTimer = useRef(0);
  const frameFn = useCallback(() => {
    frame.current = 0;
    const snap = snapshot.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!quick.current || morph.current || !snap || !canvas || !ctx || snap.canvas.width !== canvas.width || snap.canvas.height !== canvas.height) {
      drawRef.current();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const v = view.current;
    const k = v.scale / snap.view.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar(canvas, '--canvas-bg', '#fbfaf7');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, (v.tx - k * snap.view.tx) * dpr, (v.ty - k * snap.view.ty) * dpr);
    ctx.drawImage(snap.canvas, 0, 0);
    drawTrailRef.current(ctx, canvas);
    reportView();
  }, []);
  const schedule = useCallback(() => {
    quick.current = false;
    if (!frame.current) frame.current = requestAnimationFrame(frameFn);
  }, [draw, frameFn]); // a new draw (new geometry, colours, …) is the cue for a full redraw
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  /**
   * Redraw after a pan or zoom: from the snapshot if a full draw is slow.
   * Stable for the component's life, so the pointer handlers and the chase
   * loop that use it never restart mid-gesture.
   */
  const scheduleMove = useCallback(() => {
    if ((snapshot.current?.ms ?? 0) < 12) {
      scheduleRef.current();
      return;
    }
    quick.current = true;
    if (!frame.current) frame.current = requestAnimationFrame(frameFn);
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => scheduleRef.current(), 160);
  }, [frameFn]);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  // The chase: walk the line on at its pace, and ride the camera along it.
  // Dragging takes the camera back until you let go (for good once the line
  // has closed or hit a tail); wheel zoom stays yours.
  const dragging = useRef(false);
  const chaseOpts = useRef({ pace: props.chasePace ?? null, damping: props.chaseDamping ?? 1, onTick: props.onChaseTick });
  chaseOpts.current = { pace: props.chasePace ?? null, damping: props.chaseDamping ?? 1, onTick: props.onChaseTick };
  useEffect(() => {
    if (!chase) return;
    const cam = createFollowCamera(chase);
    let last = performance.now();
    let lastTick = 0;
    let budget = 0;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      raf = requestAnimationFrame(tick);
      if (dragging.current) {
        // A finished line has nothing left to show: a drag takes the camera
        // back for good, rather than until you let go.
        if (chase.status !== 'running') cancelAnimationFrame(raf);
        return;
      }
      const v = view.current;
      const { w, h } = size.current;
      const viewMin = Math.min(w, h) / v.scale;
      const cx = (w / 2 - v.tx) / v.scale;
      const cy = (h / 2 - v.ty) / v.scale;
      const { pace, damping, onTick } = chaseOpts.current;
      const before = chase.steps;
      const until = now + 6;
      chase.sipping = pace !== null;
      if (pace === null) {
        // Full speed, as on the Spectre map: as far as a slice of the frame
        // allows; the camera's catch-up rules keep the head in sight.
        while (performance.now() < until) {
          let n = 0;
          while (n < 256 && chase.step()) n++;
          if (n < 256) break;
        }
      } else if (chase.status === 'running') {
        budget = Math.min(budget + (pace * dt) / 1000, 2000);
        while (budget >= 1 && performance.now() < until && chase.step()) budget--;
        if (chase.status !== 'running') budget = 0;
      }
      const f = advanceFollowCamera(cam, chase, { x: cx, y: cy }, dt, viewMin, v.scale, damping);
      if (!f.settled) view.current = { scale: v.scale, tx: w / 2 - f.cx * v.scale, ty: h / 2 - f.cy * v.scale };
      if (!f.settled || chase.steps !== before) scheduleMove();
      if (now - lastTick > 200 || (chase.status !== 'running' && chase.steps !== before)) {
        lastTick = now;
        onTick?.();
      }
      // Arrived at the end of a finished line: nothing left to animate.
      if (f.settled && chase.status !== 'running') {
        cancelAnimationFrame(raf);
        onTick?.();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [chase, scheduleMove]);
  const chaseRef = useRef(chase);
  chaseRef.current = chase;

  const fitBoundsRef = useRef(props.fitBounds);
  fitBoundsRef.current = props.fitBounds;
  const insetsRef = useRef(props.insets);
  insetsRef.current = props.insets;
  const fit = useCallback(() => {
    const { w } = size.current;
    const top = insetsRef.current?.top ?? 0;
    const h = Math.max(1, size.current.h - top - (insetsRef.current?.bottom ?? 0));
    const b = fitBoundsRef.current ?? geo.bounds;
    const bw = Math.max(1e-6, b.maxX - b.minX);
    const bh = Math.max(1e-6, b.maxY - b.minY);
    const scale = Math.max(minScaleRef.current(), 0.94 * Math.min(w / bw, h / bh));
    view.current = { scale, tx: w / 2 - scale * (b.minX + bw / 2), ty: top + h / 2 - scale * (b.minY + bh / 2) };
    schedule();
  }, [geo, schedule]);

  // Size tracking.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const first = size.current.w <= 1;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, r.width);
      const h = Math.max(1, r.height);
      // A new observer reports the size straight away, and it is re-made
      // whenever the drawing changes: setting a canvas's size wipes it, so
      // only touch it when it really changed, or the canvas blanks until the
      // next full draw.
      if (!first && w === size.current.w && h === size.current.h && canvas.width === Math.round(w * dpr) && canvas.height === Math.round(h * dpr)) return;
      size.current = { w, h };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${size.current.w}px`;
      canvas.style.height = `${size.current.h}px`;
      if (first) fit();
      else schedule();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit, schedule]);

  // Re-fit when the patch changes (or whatever `fitKey` says); redraw for everything else.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fitKey = props.fitKey === undefined ? geo.bounds : props.fitKey;
  useEffect(() => {
    if (size.current.w > 1) fitRef.current();
  }, [fitKey]);
  // The panels are measured just after the canvas: fit again once they are.
  const hasInsets = props.insets !== undefined;
  useEffect(() => {
    if (hasInsets && size.current.w > 1) fitRef.current();
  }, [hasInsets]);
  useEffect(() => {
    schedule();
  }, [schedule]);

  // New lines on the same tiles: animate the change of pairing. A layout
  // effect, so the first frame drawn for the new lines is already the morph.
  useLayoutEffect(() => {
    const prev = morphFrom.current;
    morphFrom.current = { circuits, colors: chordGeo?.chordColor, key: props.morphKey };
    cancelAnimationFrame(morphRaf.current);
    morph.current = null;
    if (!circuits || !chordGeo || !prev.circuits || !prev.colors || prev.circuits === circuits || prev.key !== props.morphKey || props.morphKey === undefined || prefersReducedMotion()) return;
    const m = morphChords(prev.circuits.chords, circuits.chords, (ch) => ch.inst);
    if (!m || m.moving.length === 0) return;
    // Every colour change worked out up front: each line fades from its old
    // colour to its new one as it swings.
    const oldColor = prev.colors;
    const newColor = chordGeo.chordColor;
    const stillOld = new Map<string, Path2D>();
    const stillNew = new Map<string, Path2D>();
    const add = (by: Map<string, Path2D>, col: string, ch: Chord) => {
      let p = by.get(col);
      if (!p) by.set(col, (p = new Path2D()));
      p.moveTo(ch.a.x, ch.a.y);
      p.quadraticCurveTo(ch.c.x, ch.c.y, ch.b.x, ch.b.y);
    };
    m.still.forEach((i, k) => {
      add(stillOld, oldColor[m.stillFrom[k]] ?? newColor[i], circuits.chords[i]);
      add(stillNew, newColor[i], circuits.chords[i]);
    });
    const halves: MorphState['halves'] = new Map();
    m.moving.forEach((hf, i) => {
      const a = oldColor[hf.from] ?? newColor[hf.chord];
      const b = newColor[hf.chord];
      const k = `${a}|${b}`;
      let H = halves.get(k);
      if (!H) halves.set(k, (H = { from: toRgb(a), to: toRgb(b), fixed: a === b ? a : null, list: [] }));
      H.list.push(i);
    });
    const M: MorphState = { start: null, done: false, morph: m, stillOld, stillNew, halves, base: null };
    morph.current = M;
    const tick = () => {
      if (morph.current !== M) return;
      if (M.done) {
        // The last frame showed the finished picture: hand back to the full draw.
        morph.current = null;
        scheduleRef.current();
        return;
      }
      scheduleRef.current();
      morphRaf.current = requestAnimationFrame(tick);
    };
    scheduleRef.current();
    morphRaf.current = requestAnimationFrame(tick);
  }, [circuits, chordGeo]);
  useEffect(() => () => cancelAnimationFrame(morphRaf.current), []);

  // Re-draw on theme change.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', schedule);
    return () => mq.removeEventListener('change', schedule);
  }, [schedule]);

  // Pan / zoom / click. The handlers read the lines and the click callback
  // through refs: re-attaching them on a re-render would drop a drag midway.
  const clickRef = useRef({ circuits, onSelectPath });
  clickRef.current = { circuits, onSelectPath };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    // A flick keeps the view gliding for a moment after you let go.
    let vel = { vx: 0, vy: 0, t: 0 };
    let glide = 0;
    const stopGlide = () => {
      cancelAnimationFrame(glide);
      glide = 0;
    };
    const startGlide = () => {
      const v = vel;
      if (performance.now() - v.t > 100 || Math.hypot(v.vx, v.vy) < 0.15) return;
      let last = performance.now();
      const step = () => {
        const t = performance.now();
        const dt = Math.min(64, t - last);
        last = t;
        view.current.tx += v.vx * dt;
        view.current.ty += v.vy * dt;
        const decay = Math.exp(-dt / 220);
        v.vx *= decay;
        v.vy *= decay;
        scheduleMove();
        glide = Math.hypot(v.vx, v.vy) > 0.02 ? requestAnimationFrame(step) : 0;
      };
      glide = requestAnimationFrame(step);
    };
    let pinch: { d: number; cx: number; cy: number } | null = null;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const zoomAt = (x: number, y: number, k: number) => {
      const v = view.current;
      const s = Math.max(minScaleRef.current(), Math.min(1e5, v.scale * k));
      const kk = s / v.scale;
      view.current = { scale: s, tx: x - (x - v.tx) * kk, ty: y - (y - v.ty) * kk };
      scheduleMove();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopGlide();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    };
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      stopGlide();
      pointers.set(e.pointerId, local(e));
      dragging.current = true;
      moved = 0;
      vel = { vx: 0, vy: 0, t: performance.now() };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        view.current.tx += cx - pinch.cx;
        view.current.ty += cy - pinch.cy;
        zoomAt(cx, cy, d / Math.max(1, pinch.d));
        pinch = { d, cx, cy };
        moved += 10;
        return;
      }
      moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      view.current.tx += dx;
      view.current.ty += dy;
      const t = performance.now();
      const dt = Math.max(1, t - vel.t);
      vel = { vx: 0.5 * vel.vx + (0.5 * dx) / dt, vy: 0.5 * vel.vy + (0.5 * dy) / dt, t };
      scheduleMove();
    };
    const onUp = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) dragging.current = false;
      // No glide while a chase has the camera: it would only fight it.
      if (p && pointers.size === 0 && moved > 6 && e.type === 'pointerup' && !chaseRef.current) startGlide();
      const { circuits, onSelectPath } = clickRef.current;
      if (!p || moved > 6 || !onSelectPath || !circuits) return;
      const v = view.current;
      const w = { x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale };
      let best = -1;
      let bestD = (10 / v.scale) ** 2;
      circuits.chords.forEach((ch, i) => {
        for (let k = 0; k <= 4; k++) {
          const q = bez(ch.a, ch.c, ch.b, k / 4);
          const d = (q.x - w.x) ** 2 + (q.y - w.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      });
      onSelectPath(best < 0 ? null : circuits.pathOfChord[best], best < 0 ? null : best);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      stopGlide();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [scheduleMove]);

  return (
    <div className="patch-canvas" ref={wrapRef}>
      <canvas ref={canvasRef} aria-label={`${tiling.name} patch`} />
      <div className="canvas-tools" style={props.insets ? { top: props.insets.top + 10 } : undefined}>
        <button type="button" onClick={() => zoomBy(view, size.current, 1.4, schedule)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(view, size.current, 1 / 1.4, schedule, minScaleRef.current())} aria-label="Zoom out">−</button>
        <button type="button" onClick={fit} aria-label="Fit to view">Fit</button>
      </div>
    </div>
  );
}

function zoomBy(view: { current: View }, size: { w: number; h: number }, k0: number, schedule: () => void, min = 1e-3) {
  const v = view.current;
  const k = Math.max(min, v.scale * k0) / v.scale;
  const x = size.w / 2;
  const y = size.h / 2;
  view.current = { scale: v.scale * k, tx: x - (x - v.tx) * k, ty: y - (y - v.ty) * k };
  schedule();
}
