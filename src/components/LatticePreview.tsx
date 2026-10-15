import { useEffect, useRef } from 'react';
import { cellCenter, cellKey, edgeFacing, GRIDS, leafXform, type LatticeLeaf, type LatticeSpec, type LevelCheck } from '../core/lattice';
import { transPt } from '../core/geom';

interface Props {
  readonly spec: LatticeSpec;
  readonly leaves: readonly LatticeLeaf[];
  readonly check?: LevelCheck;
  readonly height?: number;
}

const MARK = [
  { x: 0.05, y: 0 },
  { x: 0.62, y: 0 },
  { x: 0.12, y: 0.32 },
];

/**
 * One supertile, tiles coloured by type, with the outlines of its child
 * supertiles drawn heavier. Overlapping cells are marked red, holes black.
 */
export function LatticePreview({ spec, leaves, check, height = 220 }: Props) {
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
      ctx.fillStyle = css.getPropertyValue('--canvas-bg').trim() || '#fff';
      ctx.fillRect(0, 0, w, h);
      if (!leaves.length) return;
      const grid = GRIDS[spec.grid];
      const centres = leaves.map((l) => cellCenter(spec.grid, l.pos));
      const xs = centres.map((p) => p.x);
      const ys = centres.map((p) => p.y);
      const minX = Math.min(...xs) - 1.2;
      const maxX = Math.max(...xs) + 1.2;
      const minY = Math.min(...ys) - 1.2;
      const maxY = Math.max(...ys) + 1.2;
      const s = Math.min(w / (maxX - minX), h / (maxY - minY));
      const ox = w / 2 - s * (minX + maxX) / 2;
      const oy = h / 2 - s * (minY + maxY) / 2;
      // y down, like the explorer's canvas, so both show the same handedness.
      const P = (x: number, y: number) => [ox + s * x, oy + s * y] as const;
      const colour = new Map(spec.types.map((t) => [t.id, t.color ?? '#ccc']));
      const slotOf = new Map<string, number>();
      for (const l of leaves) slotOf.set(cellKey(l.pos), l.slot ?? 0);

      for (const l of leaves) {
        const c = cellCenter(spec.grid, l.pos);
        ctx.beginPath();
        grid.pts.forEach((p, i) => {
          const [x, y] = P(c.x + p.x, c.y + p.y);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = colour.get(l.type) ?? '#ccc';
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
      // Orientation marks once tiles are big enough to read them.
      if (s > 9) {
        ctx.fillStyle = 'rgba(20,20,30,0.55)';
        for (const l of leaves) {
          const X = leafXform(spec.grid, l.pos, l.O);
          ctx.beginPath();
          MARK.forEach((m, i) => {
            const q = transPt(X, m);
            const [x, y] = P(q.x, q.y);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.fill();
        }
      }
      // Child supertile outlines.
      ctx.strokeStyle = css.getPropertyValue('--ink').trim() || '#000';
      ctx.lineWidth = Math.max(1, Math.min(2.2, s / 10));
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const l of leaves) {
        const c = cellCenter(spec.grid, l.pos);
        grid.neighbours.forEach((d, j) => {
          const other = slotOf.get(cellKey([l.pos[0] + d[0], l.pos[1] + d[1]]));
          if (other === (l.slot ?? 0)) return;
          const [a, b] = edgeFacing(spec.grid, j);
          const [x1, y1] = P(c.x + grid.pts[a].x, c.y + grid.pts[a].y);
          const [x2, y2] = P(c.x + grid.pts[b].x, c.y + grid.pts[b].y);
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
        });
      }
      ctx.stroke();
      const mark = (cells: readonly (readonly [number, number])[], fill: string) => {
        ctx.fillStyle = fill;
        for (const cell of cells) {
          const c = cellCenter(spec.grid, cell);
          ctx.beginPath();
          grid.pts.forEach((p, i) => {
            const [x, y] = P(c.x + p.x * 0.8, c.y + p.y * 0.8);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.fill();
        }
      };
      if (check) {
        mark(check.overlapCells, 'rgba(229,72,77,0.9)');
        mark(check.holeCells, 'rgba(20,20,20,0.85)');
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [spec, leaves, check]);
  return <canvas ref={ref} className="lattice-preview" style={{ height }} />;
}
