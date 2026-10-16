import { useEffect, useRef } from 'react';
import { basePts, type ChainSpec } from '../core/chain';
import { transPt, type Pt } from '../core/geom';
import type { Prototile, TileInstance } from '../core/tiling';

interface Props {
  readonly spec: ChainSpec;
  readonly prototiles: readonly Prototile[];
  readonly leaves: readonly TileInstance[];
  /** Top-level slot of each leaf, for drawing the child supertiles' outlines. */
  readonly slots: readonly number[];
  readonly badTiles?: readonly number[];
  /** Label children with their slot numbers and draw their quad points (level 1). */
  readonly annotate?: boolean;
  readonly height?: number;
}

const key = (p: Pt) => `${Math.round(p.x * 1e3)},${Math.round(p.y * 1e3)}`;

/** One chain supertile: tiles by type, child supertiles outlined, overlaps in red. */
export function ChainPreview({ spec, prototiles, leaves, slots, badTiles, annotate, height = 220 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(canvas);
      const ink = css.getPropertyValue('--ink').trim() || '#000';
      ctx.fillStyle = css.getPropertyValue('--canvas-bg').trim() || '#fff';
      ctx.fillRect(0, 0, w, h);
      if (!leaves.length) return;
      const proto = new Map(prototiles.map((p) => [p.id, p]));
      const polys = leaves.map((l) => proto.get(l.type)!.pts.map((p) => transPt(l.xform, p)));
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const pts of polys) for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      const pad = 12;
      const s = Math.min((w - 2 * pad) / (maxX - minX || 1), (h - 2 * pad) / (maxY - minY || 1));
      const ox = w / 2 - (s * (minX + maxX)) / 2;
      const oy = h / 2 - (s * (minY + maxY)) / 2;
      const P = (p: Pt) => [ox + s * p.x, oy + s * p.y] as const;
      const bad = new Set(badTiles ?? []);
      polys.forEach((pts, i) => {
        ctx.beginPath();
        pts.forEach((p, k) => (k ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
        ctx.closePath();
        ctx.fillStyle = proto.get(leaves[i].type)!.color;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
        if (bad.has(i)) {
          ctx.fillStyle = 'rgba(229,72,77,0.55)';
          ctx.fill();
        }
      });
      // Child supertile outlines: edges not shared with a tile of the same slot.
      const owner = new Map<string, number[]>();
      polys.forEach((pts, i) => {
        for (let e = 0; e < pts.length; e++) {
          const a = key(pts[e]);
          const b = key(pts[(e + 1) % pts.length]);
          const k = a < b ? `${a}|${b}` : `${b}|${a}`;
          const list = owner.get(k);
          if (list) list.push(i);
          else owner.set(k, [i]);
        }
      });
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1, Math.min(2.4, s / 12));
      ctx.lineCap = 'round';
      ctx.beginPath();
      polys.forEach((pts) => {
        for (let e = 0; e < pts.length; e++) {
          const a = key(pts[e]);
          const b = key(pts[(e + 1) % pts.length]);
          const list = owner.get(a < b ? `${a}|${b}` : `${b}|${a}`)!;
          if (list.length === 2 && slots[list[0]] === slots[list[1]]) continue;
          ctx.moveTo(...P(pts[e]));
          ctx.lineTo(...P(pts[(e + 1) % pts.length]));
        }
      });
      ctx.stroke();
      // Slot numbers at each child's centre.
      if (annotate || s > 3) {
        const groups = new Map<number, Pt[]>();
        polys.forEach((pts, i) => {
          const g = groups.get(slots[i]) ?? [];
          g.push(...pts);
          groups.set(slots[i], g);
        });
        ctx.font = `600 ${Math.max(11, Math.min(18, s * (annotate ? 0.7 : 2)))}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [slot, pts] of groups) {
          const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
          const [x, y] = P(c);
          ctx.fillStyle = css.getPropertyValue('--canvas-bg').trim() || '#fff';
          ctx.beginPath();
          ctx.arc(x, y, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = ink;
          ctx.fillText(String(slot), x, y + 0.5);
        }
      }
      // Each child's quad points (where the chain attaches), level 1 only.
      if (annotate) {
        const base = basePts(spec.base);
        const colours = ['#e5484d', '#f59e0b', '#22a06b', '#3b82f6'];
        leaves.forEach((l) => {
          spec.quad.forEach((vi, q) => {
            const [x, y] = P(transPt(l.xform, base[vi]));
            ctx.fillStyle = colours[q];
            ctx.beginPath();
            ctx.arc(x, y, 3.2, 0, Math.PI * 2);
            ctx.fill();
          });
        });
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [spec, prototiles, leaves, slots, badTiles, annotate]);
  return <canvas ref={ref} className="lattice-preview" style={{ height }} />;
}
