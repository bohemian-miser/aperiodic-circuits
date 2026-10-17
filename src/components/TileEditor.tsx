import { useRef, useState, type PointerEvent } from 'react';
import { localChords } from '../core/circuits';
import { dist, type Pt } from '../core/geom';
import { nonCrossingMatchings } from '../core/matchings';
import type { RuleSet } from '../core/ruleset';
import { prototile, type Tiling } from '../core/tiling';
import { glyphFrame, TileGlyph } from './TileGlyph';

interface Props {
  readonly tiling: Tiling;
  readonly ruleSet: RuleSet;
  readonly selection: ReadonlySet<number>;
  readonly type: string;
  readonly index: number;
  readonly onSetIndex: (index: number) => void;
  readonly onClose: () => void;
}

/**
 * One tile, magnified, whose pairing you draw: tap or press a crossing, and
 * a line follows you until it snaps to another crossing. Letting go (or
 * tapping) there pairs the two, keeping as much of the old pairing as fits.
 */
export function TileEditor({ tiling, ruleSet, selection, type, index, onSetIndex, onClose }: Props) {
  const proto = prototile(tiling, type);
  const { viewBox, span } = glyphFrame(proto.pts);
  const { points, odd } = localChords(tiling, ruleSet, type, selection, index);
  const matchings = odd ? [] : nonCrossingMatchings(points.length);
  const current = matchings[Math.min(index, matchings.length - 1)] ?? [];
  const svg = useRef<SVGSVGElement>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [dragging, setDragging] = useState(false);
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
  const snap = from !== null && cursor ? nearest(cursor, snapAt, from) : null;

  const connect = (a: number, b: number) => {
    setFrom(null);
    setCursor(null);
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
      if (hit === null) return;
      setFrom(hit);
      setCursor(p);
      setDragging(true);
      setMessage(null);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    // Already holding a line: a second tap lands it, or lets go of it.
    const target = nearest(p, snapAt, from);
    if (target !== null) connect(from, target);
    else {
      setFrom(hit !== null && hit !== from ? hit : null);
      setCursor(p);
    }
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (from === null) return;
    const p = toSvg(e);
    if (p) setCursor(p);
  };
  const onUp = () => {
    if (dragging && from !== null && snap !== null) connect(from, snap);
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
        <TileGlyph tiling={tiling} type={type} ruleSet={ruleSet} selection={selection} comboIndex={index} size={260} />
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
        {message ?? (odd ? 'An odd number of crossings: no way to pair them all.' : points.length < 3 ? 'Only one way to pair these.' : from === null ? 'Tap a dot, then drag or tap towards another to pair them.' : 'Now pick the dot to pair it with.')}
      </p>
    </div>
  );
}
