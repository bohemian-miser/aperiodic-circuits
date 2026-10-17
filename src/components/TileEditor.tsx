import { useRef, useState, type PointerEvent } from 'react';
import { localChords } from '../core/circuits';
import { dist, type Pt } from '../core/geom';
import { nonCrossingMatchings } from '../core/matchings';
import { edgeSeamIndex, type RuleSet } from '../core/ruleset';
import { prototile, type Tiling } from '../core/tiling';
import { glyphFrame, TileGlyph } from './TileGlyph';

interface Props {
  readonly tiling: Tiling;
  readonly ruleSet: RuleSet;
  readonly selection: ReadonlySet<number>;
  readonly type: string;
  readonly index: number;
  readonly onSetIndex: (index: number) => void;
  /** Tapping an edge turns its class on or off. */
  readonly onToggleClass: (cls: number) => void;
  readonly onClose: () => void;
}

/**
 * One tile, magnified, whose pairing you draw: tap or press a crossing, and
 * a line follows you, latching on to each crossing you pass. Letting go (or
 * tapping) pairs it with the last one, keeping as much of the old pairing as
 * fits. Tapping an edge away from its crossing turns its class on or off.
 */
export function TileEditor({ tiling, ruleSet, selection, type, index, onSetIndex, onToggleClass, onClose }: Props) {
  const proto = prototile(tiling, type);
  const { viewBox, span } = glyphFrame(proto.pts);
  const { points, odd } = localChords(tiling, ruleSet, type, selection, index);
  const matchings = odd ? [] : nonCrossingMatchings(points.length);
  const current = matchings[Math.min(index, matchings.length - 1)] ?? [];
  const svg = useRef<SVGSVGElement>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [dragging, setDragging] = useState(false);
  // The crossing the line last passed over: it stays latched until another
  // one takes over, or the line goes back to where it started.
  const [latched, setLatched] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const grab = span * 0.1;
  const snapAt = span * 0.16;

  const toSvg = (e: PointerEvent): Pt | null => {
    const m = svg.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const nearest = (p: Pt, within: number, except: number | null): number | null => {
    let best: number | null = null;
    let bestD = within;
    points.forEach((q, i) => {
      const d = dist(p, q);
      if (i !== except && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };
  const snap = from !== null ? latched : null;
  const seams = ruleSet.seams[type] ?? [];
  const pts = proto.pts;
  const soe = edgeSeamIndex(ruleSet, type, pts.length);
  // The labelled edge under p (nearest within reach), as its seam.
  const edgeAt = (p: Pt): number | null => {
    let best: number | null = null;
    let bestD = span * 0.07;
    pts.forEach((a, e) => {
      if (soe[e] < 0) return;
      const d = segmentDist(p, a, pts[(e + 1) % pts.length]);
      if (d < bestD) {
        best = soe[e];
        bestD = d;
      }
    });
    return best;
  };
  const toggleSeam = (si: number) => {
    const cls = seams[si].cls;
    const on = !selection.has(cls);
    onToggleClass(cls);
    setMessage(null);
    setLatched(null);
    setCursor(null);
    // Turning an edge on also picks up its crossing, ready to pair.
    setFrom(on ? seams.slice(0, si).filter((q) => q.cls === cls || selection.has(q.cls)).length : null);
  };

  const connect = (a: number, b: number) => {
    setFrom(null);
    setCursor(null);
    setLatched(null);
    const has = (m: (typeof matchings)[number], i: number, j: number) => m.some(([x, y]) => (x === i && y === j) || (x === j && y === i));
    let best = -1;
    let bestShared = -1;
    matchings.forEach((m, k) => {
      if (!has(m, a, b)) return;
      const shared = current.filter(([x, y]) => has(m, x, y)).length;
      if (shared > bestShared) {
        best = k;
        bestShared = shared;
      }
    });
    if (best < 0) setMessage('Those two can’t pair: the crossings between them would be left with an odd one out.');
    else {
      setMessage(null);
      onSetIndex(best);
    }
  };

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    const p = toSvg(e);
    if (!p) return;
    const hit = nearest(p, grab, null);
    if (from === null) {
      if (hit !== null) {
        setFrom(hit);
        setCursor(p);
        setLatched(null);
        setDragging(true);
        setMessage(null);
        e.currentTarget.setPointerCapture(e.pointerId);
      } else {
        const si = edgeAt(p);
        if (si !== null) toggleSeam(si);
      }
      return;
    }
    // Already holding a line: a second tap lands it (on the crossing tapped,
    // or the one it last latched on to), turns an edge on or off, or lets go.
    const target = nearest(p, snapAt, from) ?? (hit === from ? null : latched);
    if (target !== null) connect(from, target);
    else if (hit === null && edgeAt(p) !== null) toggleSeam(edgeAt(p)!);
    else {
      setFrom(null);
      setCursor(null);
      setLatched(null);
    }
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (from === null) return;
    const p = toSvg(e);
    if (!p) return;
    setCursor(p);
    const near = nearest(p, snapAt, null);
    if (near === from) setLatched(null);
    else if (near !== null) setLatched(near);
  };
  const onUp = () => {
    if (dragging && from !== null && latched !== null) connect(from, latched);
    setDragging(false);
  };

  const sw = span / 40;
  const a = from !== null ? points[from] : null;
  const b = snap !== null ? points[snap] : cursor;

  return (
    <div className="tile-editor-pop" role="dialog" aria-label={`Pairing for ${proto.name}`}>
      <div className="tile-editor-head">
        <b>{proto.name}</b>
        {matchings.length > 1 && (
          <span className="tile-editor-step">
            <button type="button" onClick={() => onSetIndex((index - 1 + matchings.length) % matchings.length)} aria-label="Previous pairing">
              ‹
            </button>
            {(index % matchings.length) + 1}/{matchings.length}
            <button type="button" onClick={() => onSetIndex((index + 1) % matchings.length)} aria-label="Next pairing">
              ›
            </button>
          </span>
        )}
        <button type="button" className="tile-editor-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="tile-editor-stage">
        <TileGlyph tiling={tiling} type={type} ruleSet={ruleSet} selection={selection} comboIndex={index} size={260} showLabels labelInset={0.3} />
        <svg ref={svg} className="tile-editor-touch" viewBox={viewBox} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={grab} fill="transparent" className="tile-editor-hit" />
          ))}
          {a && b && (
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--accent)" strokeWidth={sw * 1.4} strokeLinecap="round" strokeDasharray={snap === null ? `${sw * 2} ${sw * 1.5}` : undefined} />
          )}
          {a && <circle cx={a.x} cy={a.y} r={sw * 3} fill="none" stroke="var(--accent)" strokeWidth={sw * 0.9} />}
          {snap !== null && <circle cx={points[snap].x} cy={points[snap].y} r={sw * 3} fill="var(--accent)" fillOpacity={0.25} stroke="var(--accent)" strokeWidth={sw * 0.9} />}
        </svg>
      </div>
      <p className="tile-editor-hint">
        {message ?? (from !== null ? 'Drag or tap to the dot to pair it with.' : odd ? 'An odd number of crossings: turn an edge on or off to even them up.' : points.length < 3 ? 'Tap an edge to turn it on or off.' : 'Tap a dot to draw from it, or an edge to turn it on or off.')}
      </p>
    </div>
  );
}

function segmentDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}
