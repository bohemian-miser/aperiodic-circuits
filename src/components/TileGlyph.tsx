import { localChords } from '../core/circuits';
import { lerpPt } from '../core/geom';
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
  /** Seam indices to flag (validation conflicts). */
  readonly flagged?: ReadonlySet<number>;
}

export function TileGlyph(props: TileGlyphProps) {
  const { tiling, type, ruleSet, selection, comboIndex = 0, size = 120, onEdgeClick, onVertexClick, showLabels, flagged } = props;
  const proto = prototile(tiling, type);
  const pts = proto.pts;
  const n = pts.length;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const pad = span * 0.12;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;
  const sw = span / 40;
  const seams = ruleSet.seams[type] ?? [];
  const soe = edgeSeamIndex(ruleSet, type, n);
  const ctr = polygonCentroid(pts);
  const chords = selection ? localChords(tiling, ruleSet, type, selection, comboIndex) : null;
  const interactive = !!onEdgeClick;

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
              strokeOpacity={lit ? 1 : selection ? 0.25 : 0.9}
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
            {showLabels && cls !== null && (() => {
              const m = lerpPt(lerpPt(a, b, 0.5), ctr, 0.18);
              return (
                <text x={m.x} y={m.y} fontSize={sw * 4.2} textAnchor="middle" dominantBaseline="central" fill={classColor(cls)} className="edge-label">
                  {className(ruleSet, cls)}
                </text>
              );
            })()}
          </g>
        );
      })}
      {chords?.chords.map((c, i) => (
        <path key={i} d={`M${c.a.x},${c.a.y} Q${c.c.x},${c.c.y} ${c.b.x},${c.b.y}`} fill="none" stroke="var(--ink)" strokeWidth={sw * 1.3} strokeLinecap="round" />
      ))}
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
