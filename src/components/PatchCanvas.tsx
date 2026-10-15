import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CircuitResult } from '../core/circuits';
import type { Pt } from '../core/geom';
import { edgeSeamIndex, type RuleSet } from '../core/ruleset';
import { instancePts, patchBounds, prototile, type TileInstance, type Tiling } from '../core/tiling';
import { classColor, lengthHue, OPEN_COLOR, rainbow, TAIL_COLOR } from '../colors';

export interface PatchCanvasProps {
  readonly tiling: Tiling;
  readonly instances: readonly TileInstance[];
  readonly ruleSet?: RuleSet;
  readonly circuits?: CircuitResult;
  readonly showTiles?: boolean;
  readonly showOutlines?: boolean;
  /** Stroke edges in their class colour (only the classes given, if any). */
  readonly classEdges?: ReadonlySet<number> | 'all' | null;
  readonly selectedPath?: number | null;
  readonly onSelectPath?: (path: number | null) => void;
  readonly lineWidth?: number;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

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

export function PatchCanvas(props: PatchCanvasProps) {
  const { tiling, instances, ruleSet, circuits, showTiles = true, showOutlines = true, classEdges = null, selectedPath = null, onSelectPath } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const frame = useRef(0);
  const size = useRef({ w: 1, h: 1 });

  // Geometry batched into a few Path2Ds so redraws stay cheap.
  const geo = useMemo(() => {
    const fills = new Map<string, Path2D>();
    const outline = new Path2D();
    const hidden = new Path2D();
    const byClass = new Map<number, Path2D>();
    const seamIdx = new Map<string, number[]>();
    if (ruleSet) for (const p of tiling.prototiles) seamIdx.set(p.id, edgeSeamIndex(ruleSet, p.id, p.pts.length));
    for (const inst of instances) {
      const proto = prototile(tiling, inst.type);
      const pts = instancePts(tiling, inst);
      let f = fills.get(proto.color);
      if (!f) fills.set(proto.color, (f = new Path2D()));
      f.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) f.lineTo(pts[i].x, pts[i].y);
      f.closePath();
      const hid = proto.hiddenEdges;
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
    return { fills, outline, hidden, byClass, bounds: patchBounds(tiling, instances) };
  }, [tiling, instances, ruleSet]);

  const chordGeo = useMemo(() => {
    if (!circuits) return null;
    const colors = pathColors(circuits);
    // Open lines (the candidates for infinite ones) run through a rainbow
    // from one end to the other, so you can see where a long one goes.
    const chordColor: string[] = circuits.chords.map((_, i) => colors[circuits.pathOfChord[i]] ?? OPEN_COLOR);
    for (const path of circuits.paths) {
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
    return { byColor, colors };
  }, [circuits]);

  const selectedGeo = useMemo(() => {
    if (!circuits || selectedPath === null || !circuits.paths[selectedPath]) return null;
    const p = new Path2D();
    for (const ci of circuits.paths[selectedPath].chords) {
      const ch = circuits.chords[ci];
      p.moveTo(ch.a.x, ch.a.y);
      p.quadraticCurveTo(ch.c.x, ch.c.y, ch.b.x, ch.b.y);
    }
    return p;
  }, [circuits, selectedPath]);

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size.current;
    const v = view.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar(canvas, '--canvas-bg', '#fbfaf7');
    ctx.fillRect(0, 0, w * dpr, h * dpr);
    ctx.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.tx * dpr, v.ty * dpr);
    const px = 1 / v.scale;
    const dim = selectedGeo !== null;
    if (showTiles) {
      ctx.globalAlpha = dim ? 0.3 : 0.55;
      for (const [color, p] of geo.fills) {
        ctx.fillStyle = color;
        ctx.fill(p);
      }
      ctx.globalAlpha = 1;
    }
    if (showOutlines && v.scale > 2) {
      ctx.strokeStyle = cssVar(canvas, '--tile-edge', 'rgba(40,40,40,0.55)');
      ctx.lineWidth = Math.min(1.2, v.scale / 12) * px;
      ctx.stroke(geo.outline);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([3 * px, 3 * px]);
      ctx.stroke(geo.hidden);
      ctx.restore();
    }
    if (classEdges) {
      ctx.lineWidth = Math.max(1.5 * px, Math.min(0.12, 5 * px));
      ctx.lineCap = 'round';
      for (const [cls, p] of geo.byClass) {
        if (classEdges !== 'all' && !classEdges.has(cls)) continue;
        ctx.strokeStyle = classColor(cls);
        ctx.stroke(p);
      }
    }
    if (chordGeo) {
      const lw = (props.lineWidth ?? 1) * Math.max(1.2 * px, Math.min(0.14, 4 * px));
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = dim ? 0.25 : 1;
      for (const [color, p] of chordGeo.byColor) {
        ctx.strokeStyle = color;
        ctx.stroke(p);
      }
      ctx.globalAlpha = 1;
      if (selectedGeo) {
        ctx.strokeStyle = cssVar(canvas, '--highlight-halo', '#ffffff');
        ctx.lineWidth = lw * 3.2;
        ctx.stroke(selectedGeo);
        ctx.strokeStyle = chordGeo.colors[selectedPath!] ?? '#000';
        ctx.lineWidth = lw * 1.8;
        ctx.stroke(selectedGeo);
      }
    }
  }, [geo, chordGeo, selectedGeo, selectedPath, showTiles, showOutlines, classEdges, props.lineWidth]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const fit = useCallback(() => {
    const { w, h } = size.current;
    const b = geo.bounds;
    const bw = Math.max(1e-6, b.maxX - b.minX);
    const bh = Math.max(1e-6, b.maxY - b.minY);
    const scale = 0.94 * Math.min(w / bw, h / bh);
    view.current = { scale, tx: w / 2 - scale * (b.minX + bw / 2), ty: h / 2 - scale * (b.minY + bh / 2) };
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
      size.current = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(size.current.w * dpr);
      canvas.height = Math.round(size.current.h * dpr);
      canvas.style.width = `${size.current.w}px`;
      canvas.style.height = `${size.current.h}px`;
      if (first) fit();
      else schedule();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit, schedule]);

  // Re-fit when the patch changes; redraw for everything else.
  useEffect(() => {
    if (size.current.w > 1) fit();
  }, [geo.bounds, fit]);
  useEffect(() => {
    schedule();
  }, [schedule]);

  // Re-draw on theme change.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', schedule);
    return () => mq.removeEventListener('change', schedule);
  }, [schedule]);

  // Pan / zoom / click.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch: { d: number; cx: number; cy: number } | null = null;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const zoomAt = (x: number, y: number, k: number) => {
      const v = view.current;
      const s = Math.max(1e-3, Math.min(1e5, v.scale * k));
      const kk = s / v.scale;
      view.current = { scale: s, tx: x - (x - v.tx) * kk, ty: y - (y - v.ty) * kk };
      schedule();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    };
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      moved = 0;
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
      view.current.tx += p.x - prev.x;
      view.current.ty += p.y - prev.y;
      schedule();
    };
    const onUp = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
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
      onSelectPath(best < 0 ? null : circuits.pathOfChord[best]);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [schedule, circuits, onSelectPath]);

  return (
    <div className="patch-canvas" ref={wrapRef}>
      <canvas ref={canvasRef} aria-label={`${tiling.name} patch`} />
      <div className="canvas-tools">
        <button type="button" onClick={() => zoomBy(view, size.current, 1.4, schedule)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(view, size.current, 1 / 1.4, schedule)} aria-label="Zoom out">−</button>
        <button type="button" onClick={fit} aria-label="Fit to view">Fit</button>
      </div>
    </div>
  );
}

function zoomBy(view: { current: View }, size: { w: number; h: number }, k: number, schedule: () => void) {
  const v = view.current;
  const x = size.w / 2;
  const y = size.h / 2;
  view.current = { scale: v.scale * k, tx: x - (x - v.tx) * k, ty: y - (y - v.ty) * k };
  schedule();
}
