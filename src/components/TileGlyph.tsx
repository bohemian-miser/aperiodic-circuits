import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { localChords, type LocalChord } from '../core/circuits';
import { lerpPt, type Pt } from '../core/geom';
import { halfAt, MORPH_MS, morphChords, morphProgress, prefersReducedMotion, type ChordMorph } from '../core/morph';
import { polygonCentroid } from '../core/polygon';
import { className, edgeSeamIndex, seamCenter, type RuleSet } from '../core/ruleset';
import { prototile, type Tiling } from '../core/tiling';
import { classColor } from '../colors';

export interface TileGlyphProps {
  readonly tiling: Tiling;
  readonly type: string;
  readonly ruleSet: RuleSet;
  /** Explorer use: only these classes get crossings, and chords are drawn. */
  readonly selection?: ReadonlySet<number>;
  readonly comboIndex?: number;
  readonly size?: number;
  /** Builder use: edges and vertices become clickable. */
  readonly onEdgeClick?: (edge: number) => void;
  readonly onVertexClick?: (vertex: number) => void;
  readonly showLabels?: boolean;
  /** Edge labels at this many times their usual size (small glyphs want bigger ones). */
  readonly labelScale?: number;
  /** How far in from its edge a label sits, as a fraction of the way to the centre. */
  readonly labelInset?: number;
  /** Label once per seam (a run of edges that meet as one) instead of on every edge. */
  readonly labelSeams?: boolean;
  /** Seam indices to flag (validation conflicts). */
  readonly flagged?: ReadonlySet<number>;
}

/** The viewBox a glyph of these points is drawn in, and the size of the tile. */
export function glyphFrame(pts: readonly Pt[]): { viewBox: string; span: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const pad = span * 0.12;
  return { viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`, span };
}

export function TileGlyph(props: TileGlyphProps) {
  const { tiling, type, ruleSet, selection, comboIndex = 0, size = 120, onEdgeClick, onVertexClick, showLabels, labelScale = 1, labelInset = 0.18, labelSeams = false, flagged } = props;
  const proto = prototile(tiling, type);
  const pts = proto.pts;
  const n = pts.length;
  const { viewBox: vb, span } = glyphFrame(pts);
  const sw = span / 40;
  const seams = ruleSet.seams[type] ?? [];
  const soe = edgeSeamIndex(ruleSet, type, n);
  const ctr = polygonCentroid(pts);
  const chords = useMemo(() => (selection ? localChords(tiling, ruleSet, type, selection, comboIndex) : null), [tiling, ruleSet, type, selection, comboIndex]);
  const morph = useChordMorph(chords?.chords ?? null, [tiling, ruleSet, type, selection]);
  const interactive = !!onEdgeClick;

  const label = (m: Pt, cls: number, lit: boolean, key: string | number) => (
    <text
      key={key}
      x={m.x}
      y={m.y}
      fontSize={sw * 4.2 * labelScale}
      textAnchor="middle"
      dominantBaseline="central"
      fill={classColor(cls)}
      fillOpacity={lit ? 1 : 0.6}
      stroke="var(--panel)"
      strokeWidth={sw * 0.9 * labelScale}
      strokeOpacity={0.75}
      paintOrder="stroke"
      className="edge-label"
    >
      {className(ruleSet, cls)}
    </text>
  );

  return (
    <svg className={`tile-glyph${interactive ? ' interactive' : ''}`} viewBox={vb} width={size} height={size} role="img" aria-label={proto.name}>
      <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={proto.color} fillOpacity={0.55} stroke="none" />
      {pts.map((a, e) => {
        const b = pts[(e + 1) % n];
        const si = soe[e];
        const cls = si >= 0 ? seams[si].cls : null;
        const lit = cls !== null && (!selection || selection.has(cls));
        const hidden = proto.hiddenEdges?.includes(e);
        return (
          <g key={e}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={cls === null ? 'var(--muted)' : classColor(cls)}
              strokeOpacity={lit ? 1 : selection ? 0.4 : 0.9}
              strokeWidth={cls === null ? sw * 0.6 : sw * 1.6}
              strokeDasharray={cls === null || hidden ? `${sw * 1.5} ${sw * 1.5}` : undefined}
              strokeLinecap="round"
            />
            {flagged?.has(si) && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--danger)" strokeWidth={sw * 3.5} strokeOpacity={0.35} />}
            {interactive && (
              <line
                className="hit"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="transparent"
                strokeWidth={sw * 5}
                onClick={() => onEdgeClick(e)}
              >
                <title>{`Edge ${e}${cls === null ? ' (no class)' : `, seam ${si}, class ${className(ruleSet, cls)}`}`}</title>
              </line>
            )}
            {showLabels && !labelSeams && cls !== null && label(lerpPt(lerpPt(a, b, 0.5), ctr, labelInset), cls, lit, e)}
          </g>
        );
      })}
      {showLabels && labelSeams && seams.map((q, i) => label(lerpPt(seamCenter(pts, q), ctr, labelInset), q.cls, !selection || selection.has(q.cls), `s${i}`))}
      {(morph ? morph.m.still.map((i) => chords!.chords[i]) : chords?.chords)?.map((c, i) => (
        <path key={i} d={`M${c.a.x},${c.a.y} Q${c.c.x},${c.c.y} ${c.b.x},${c.b.y}`} fill="none" stroke="var(--ink)" strokeWidth={sw * 1.3} strokeLinecap="round" />
      ))}
      {morph?.m.moving.map((h, i) => {
        const { e, q, m } = halfAt(h, morph.u);
        return <path key={`h${i}`} d={`M${e.x},${e.y} Q${q.x},${q.y} ${m.x},${m.y}`} fill="none" stroke="var(--ink)" strokeWidth={sw * 1.3} strokeLinecap="round" />;
      })}
      {seams.map((s, i) => {
        if (selection && !selection.has(s.cls)) return null;
        const p = seamCenter(pts, s);
        return <circle key={i} cx={p.x} cy={p.y} r={sw * 1.5} fill={chords?.odd ? 'var(--danger)' : classColor(s.cls)} stroke="var(--canvas-bg)" strokeWidth={sw * 0.5} />;
      })}
      {onVertexClick &&
        pts.map((p, v) => {
          const prev = soe[(v - 1 + n) % n];
          const joined = prev >= 0 && prev === soe[v];
          return (
            <circle
              key={`v${v}`}
              className="vertex"
              cx={p.x}
              cy={p.y}
              r={sw * 1.3}
              fill={joined ? 'var(--ink)' : 'var(--canvas-bg)'}
              stroke="var(--ink)"
              strokeWidth={sw * 0.5}
              onClick={() => onVertexClick(v)}
            >
              <title>{joined ? `Vertex ${v}: inside a seam (click to split)` : `Vertex ${v}: seam break (click to join)`}</title>
            </circle>
          );
        })}
    </svg>
  );
}

/**
 * When the chords change but nothing else in `deps` does (a new pairing),
 * the morph from the old chords to the new and how far along it is.
 */
function useChordMorph(chords: readonly LocalChord[] | null, deps: readonly unknown[]): { m: ChordMorph; u: number } | null {
  const [anim, setAnim] = useState<{ m: ChordMorph; u: number } | null>(null);
  const prev = useRef<{ chords: readonly LocalChord[] | null; deps: readonly unknown[] } | null>(null);
  const raf = useRef(0);
  useLayoutEffect(() => {
    const p = prev.current;
    prev.current = { chords, deps };
    cancelAnimationFrame(raf.current);
    setAnim(null);
    if (!p?.chords || !chords || p.chords === chords || p.deps.some((d, i) => d !== deps[i]) || prefersReducedMotion()) return;
    const m = morphChords(p.chords, chords);
    if (!m || m.moving.length === 0) return;
    const start = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - start >= MORPH_MS) {
        setAnim(null);
        return;
      }
      setAnim({ m, u: morphProgress(start, now) });
      raf.current = requestAnimationFrame(tick);
    };
    setAnim({ m, u: 0 });
    raf.current = requestAnimationFrame(tick);
  }, [chords]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return anim;
}
