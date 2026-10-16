import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  cellCenter,
  cellKey,
  checkSpec,
  childOf,
  expansionOptions,
  GRIDS,
  growLattice,
  idet,
  leafXform,
  orientation,
  refineLatticeSpec,
  substitutionStats,
  validateLatticeSpec,
  type Cell,
  type GridKind,
  type LatticeChild,
  type LatticeSpec,
} from '../core/lattice';
import { LATTICE_PRESETS } from '../core/latticePresets';
import { transPt } from '../core/geom';
import { paletteColor } from '../core/tiling';
import { LatticePreview } from '../components/LatticePreview';
import { hashFor, replaceHash, type Route } from '../route';
import { addTilingSpec, fromBase64Url, toBase64Url } from '../store';
import { ChainLab } from './ChainLab';
import { hash } from '../hash';

interface Props {
  readonly route: Route;
}

type Tool = 'cells' | 'paint' | 'rotate' | 'flip' | 'empty';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'paint', label: 'Paint type', hint: 'Click a slot to fill it with the brush type.' },
  { id: 'rotate', label: 'Rotate', hint: 'Click a slot to turn its child one step (shift-click turns back).' },
  { id: 'flip', label: 'Flip', hint: 'Click a slot to mirror its child.' },
  { id: 'empty', label: 'Empty', hint: 'Click a slot to leave it empty in this type only (like the Spectre Gamma’s missing child).' },
  { id: 'cells', label: 'Cells', hint: 'Click grid cells to switch slots on and off. This is shared by every type.' },
];

const STORE_KEY = 'aperiodic-circuits:lab';
const CHECK_LEVELS = 4;


function initialSpec(param: string | null): LatticeSpec {
  for (const raw of [param ? (() => { try { return fromBase64Url(param); } catch { return null; } })() : null, (() => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } })()]) {
    if (!raw) continue;
    try {
      const s = JSON.parse(raw) as LatticeSpec;
      if (validateLatticeSpec(s).length === 0) return s;
    } catch {
      /* fall through to the preset */
    }
  }
  return LATTICE_PRESETS[0];
}

/** Cells shown in the editor. */
function editorCells(grid: GridKind, radius: number): Cell[] {
  const out: Cell[] = [];
  for (let x = -radius; x <= radius; x++)
    for (let y = -radius; y <= radius; y++) {
      if (grid === 'hex' && Math.abs(x + y) > radius) continue;
      out.push([x, y]);
    }
  return out;
}

const MARK = [
  { x: 0.05, y: 0 },
  { x: 0.62, y: 0 },
  { x: 0.12, y: 0.32 },
];

type LabMode = 'chain' | 'grid';
const MODE_KEY = 'aperiodic-circuits:lab-mode';

function initialMode(param: string | null): LabMode {
  try {
    if (param) return (JSON.parse(fromBase64Url(param)) as { kind?: string }).kind === 'lattice' ? 'grid' : 'chain';
  } catch {
    /* fall through */
  }
  try {
    return localStorage.getItem(MODE_KEY) === 'grid' ? 'grid' : 'chain';
  } catch {
    return 'chain';
  }
}

/** The lab has two ways to build a supertile: a chain (how the Spectre is built) or a grid. */
export function LabPage({ route }: Props) {
  const [mode, setMode] = useState<LabMode>(() => initialMode(route.params.get('d')));
  const choose = (m: LabMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private window */
    }
  };
  const modeSwitch = (
    <div className="row">
      <button type="button" className={mode === 'chain' ? 'on' : ''} onClick={() => choose('chain')} title="Children glued corner to corner in a chain, like the Spectre">
        Chain
      </button>
      <button type="button" className={mode === 'grid' ? 'on' : ''} onClick={() => choose('grid')} title="Children on a hexagon or square grid">
        Grid
      </button>
    </div>
  );
  return mode === 'chain' ? <ChainLab key="chain" route={route} modeSwitch={modeSwitch} /> : <GridLab key="grid" route={route} modeSwitch={modeSwitch} />;
}

function GridLab({ route, modeSwitch }: Props & { readonly modeSwitch: ReactNode }) {
  const [spec, setSpecRaw] = useState<LatticeSpec>(() => initialSpec(route.params.get('d')));
  const [typeId, setTypeId] = useState(() => spec.types[0].id);
  const [tool, setTool] = useState<Tool>('paint');
  const [brush, setBrush] = useState(() => spec.types[0].id);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const type = spec.types.find((t) => t.id === typeId) ?? spec.types[0];

  const setSpec = (s: LatticeSpec) => {
    setSpecRaw(s);
    setMessage(null);
  };

  // Keep the design in the URL and in this browser.
  useEffect(() => {
    const json = JSON.stringify(spec);
    try {
      localStorage.setItem(STORE_KEY, json);
    } catch {
      /* private window */
    }
    replaceHash(hashFor('lab', { d: toBase64Url(json) }));
  }, [spec]);

  const options = useMemo(() => expansionOptions(spec.grid, spec.cells), [spec.grid, spec.cells]);
  const check = useMemo(() => checkSpec(spec, CHECK_LEVELS), [spec]);
  const stats = useMemo(() => substitutionStats(spec), [spec]);
  const previews = useMemo(
    () =>
      [1, 2, 3, CHECK_LEVELS]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((lv) => ({ lv, leaves: growLattice(spec, type.id, lv, 40_000), chk: check.perType[type.id]?.[lv - 1] }))
        .filter((p) => p.leaves.length <= 40_000),
    [spec, type.id, check],
  );
  const matrixOk = Math.abs(idet(spec.matrix)) === spec.cells.length;

  const setChild = (cell: Cell, f: (c: LatticeChild | null) => LatticeChild | null) => {
    const k = cellKey(cell);
    const cur = childOf(spec, type.id, cell);
    setSpec({ ...spec, rules: { ...spec.rules, [type.id]: { ...(spec.rules[type.id] ?? {}), [k]: f(cur) } } });
  };

  const onCell = (cell: Cell, shift: boolean) => {
    const k = cellKey(cell);
    const on = spec.cells.some((c) => cellKey(c) === k);
    if (tool === 'cells') {
      const cells = on ? spec.cells.filter((c) => cellKey(c) !== k) : [...spec.cells, cell];
      if (cells.length < 1) return;
      const opts = expansionOptions(spec.grid, cells);
      setSpec({ ...spec, cells, matrix: opts[0]?.matrix ?? spec.matrix });
      return;
    }
    if (!on) return;
    const steps = GRIDS[spec.grid].steps;
    if (tool === 'paint') setChild(cell, (c) => ({ type: brush, rot: c?.rot ?? 0, flip: c?.flip ?? false }));
    if (tool === 'rotate') setChild(cell, (c) => (c ? { ...c, rot: (((c.rot + (shift ? -1 : 1)) % steps) + steps) % steps } : c));
    if (tool === 'flip') setChild(cell, (c) => (c ? { ...c, flip: !c.flip } : c));
    if (tool === 'empty') setChild(cell, (c) => (c ? null : { type: type.id, rot: 0, flip: false }));
  };

  const addType = () => {
    const used = new Set(spec.types.map((t) => t.id));
    let id = '';
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(ch)) { id = ch; break; }
    if (!id) return;
    setSpec({ ...spec, types: [...spec.types, { id, name: id, color: paletteColor(spec.types.length) }] });
    setTypeId(id);
  };
  const removeType = (id: string) => {
    if (spec.types.length <= 1) return;
    const types = spec.types.filter((t) => t.id !== id);
    const fallback = types[0].id;
    const rules: Record<string, Record<string, LatticeChild | null>> = {};
    for (const t of types) {
      rules[t.id] = {};
      for (const c of spec.cells) {
        const ch = childOf(spec, t.id, c);
        rules[t.id][cellKey(c)] = ch && ch.type === id ? { ...ch, type: fallback } : ch;
      }
    }
    setSpec({ ...spec, types, rules, defaultRoot: undefined });
    if (typeId === id) setTypeId(fallback);
    if (brush === id) setBrush(fallback);
  };

  const handOff = (page: 'build' | 'explore') => {
    const body = JSON.stringify({ grid: spec.grid, cells: spec.cells, matrix: spec.matrix, types: spec.types, rules: spec.rules });
    const id = `lab-${hash(body)}`;
    try {
      addTilingSpec({ ...spec, id, name: spec.name || 'Lab tiling', defaultRoot: spec.types[0].id });
      window.location.hash = hashFor(page, { t: id });
    } catch (e) {
      setMessage(`Couldn't use it: ${(e as Error).message}`);
    }
  };

  const importFile = async (f: File) => {
    try {
      const s = JSON.parse(await f.text()) as LatticeSpec;
      const errs = validateLatticeSpec(s);
      if (errs.length) throw new Error(errs.join('; '));
      setSpec(s);
      setTypeId(s.types[0].id);
      setBrush(s.types[0].id);
    } catch (e) {
      setMessage(`Couldn't import: ${(e as Error).message}`);
    }
  };

  // --- the slot editor ---------------------------------------------------
  const grid = GRIDS[spec.grid];
  const shown = editorCells(spec.grid, 3);
  const centres = shown.map((c) => cellCenter(spec.grid, c));
  const xs = centres.map((p) => p.x);
  const ys = centres.map((p) => p.y);
  const vb = `${Math.min(...xs) - 1.2} ${Math.min(...ys) - 1.2} ${Math.max(...xs) - Math.min(...xs) + 2.4} ${Math.max(...ys) - Math.min(...ys) + 2.4}`;
  const colour = new Map(spec.types.map((t) => [t.id, t.color ?? '#ccc']));
  const slotIndex = new Map(spec.cells.map((c, i) => [cellKey(c), i]));
  const worst = (lv: number) => {
    let o = 0;
    let h = 0;
    let measured = false;
    for (const t of spec.types) {
      const c = check.perType[t.id]?.[lv - 1];
      if (!c) continue;
      measured = true;
      o += c.overlaps;
      h += c.holes;
    }
    return measured ? { o, h } : null;
  };

  return (
    <div className="workspace lab">
      <aside className="sidebar">
        <section>
          <h2>Substitution lab</h2>
          {modeSwitch}
          <p className="hint">
            Stage one: build the supertile rules. Every tile is one cell of a grid. A supertile is the set of slot cells, and each type says what fills each slot.
            The supertiles of the next level sit apart by the expansion map. When it all fits without overlaps or holes, send it on to number the edges.
          </p>
          <label className="field">
            <span>Start from</span>
            <select
              value=""
              onChange={(e) => {
                const p = LATTICE_PRESETS.find((x) => x.id === e.target.value);
                if (p) {
                  setSpec(p);
                  setTypeId(p.types[0].id);
                  setBrush(p.types[0].id);
                }
              }}
            >
              <option value="" disabled>
                A preset…
              </option>
              {LATTICE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Name</span>
            <input value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} />
          </label>
          <div className="row">
            {(['hex', 'square'] as const).map((g) => (
              <button
                type="button"
                key={g}
                className={spec.grid === g ? 'on' : ''}
                onClick={() => {
                  if (g === spec.grid) return;
                  const opts = expansionOptions(g, spec.cells);
                  setSpec({ ...spec, grid: g, matrix: opts[0]?.matrix ?? spec.matrix });
                }}
              >
                {g === 'hex' ? 'Hexagons' : 'Squares'}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>Types</h2>
          <div className="class-list">
            {spec.types.map((t) => (
              <div key={t.id} className={`class-row${t.id === typeId ? ' on' : ''}`}>
                <button type="button" className="swatch" style={{ background: t.color }} onClick={() => setTypeId(t.id)} aria-label={`Edit type ${t.name}`} />
                <input
                  value={t.name}
                  onFocus={() => setTypeId(t.id)}
                  onChange={(e) => setSpec({ ...spec, types: spec.types.map((x) => (x.id === t.id ? { ...x, name: e.target.value.slice(0, 12) || x.id } : x)) })}
                  aria-label={`Name of type ${t.id}`}
                />
                <button type="button" className="linkish" onClick={() => removeType(t.id)} disabled={spec.types.length <= 1} aria-label={`Remove type ${t.name}`}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addType} disabled={spec.types.length >= 26}>
            Add a type
          </button>
        </section>

        <section>
          <h2>Expansion</h2>
          <p className="hint">How the next level's supertiles are spaced: it must scale area by the number of slots ({spec.cells.length}). A ✓ means the slots are a complete set of residues, so unturned children are guaranteed to fit.</p>
          {options.length ? (
            <select
              value={spec.matrix.join(',')}
              onChange={(e) => setSpec({ ...spec, matrix: e.target.value.split(',').map(Number) as unknown as LatticeSpec['matrix'] })}
            >
              {!options.some((o) => o.matrix.join(',') === spec.matrix.join(',')) && <option value={spec.matrix.join(',')}>Current [{spec.matrix.join(' ')}] (doesn't fit)</option>}
              {options.map((o) => (
                <option key={o.matrix.join(',')} value={o.matrix.join(',')}>
                  {o.residues ? '✓ ' : '· '}
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="status bad">
              No expansion scales area by {spec.cells.length} on this grid{spec.cells.length < 2 ? ': switch on at least two cells' : ''}.
            </p>
          )}
        </section>

        <section>
          <h2>Does it work?</h2>
          <ul className="levels">
            {Array.from({ length: CHECK_LEVELS }, (_, i) => i + 1).map((lv) => {
              const w = worst(lv);
              return (
                <li key={lv} className={w === null ? 'muted' : w.o || w.h ? 'bad' : 'good'}>
                  Level {lv}: {w === null ? 'too big to check' : w.o || w.h ? `${w.o} overlap${w.o === 1 ? '' : 's'}, ${w.h} hole${w.h === 1 ? '' : 's'}` : 'fits'}
                </li>
              );
            })}
          </ul>
          {!matrixOk && <p className="status bad">The expansion doesn't match the number of slots.</p>}
          <p className="hint">
            Grows ×{stats.growth.toFixed(2)} per level. {stats.primitive ? 'Primitive: every type ends up inside every supertile.' : 'Not primitive: some types never reach others, so the hierarchy splits.'}
            {stats.unused.length > 0 && ` Never used as a child: ${stats.unused.map((u) => spec.types.find((t) => t.id === u)?.name).join(', ')}.`}
          </p>
          <table className="subst">
            <thead>
              <tr>
                <th />
                {spec.types.map((t) => (
                  <th key={t.id} style={{ color: t.color }}>
                    {t.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.types.map((t, i) => (
                <tr key={t.id}>
                  <th style={{ color: t.color }}>{t.name}</th>
                  {stats.counts[i].map((n, j) => (
                    <td key={j}>{n || ''}</td>
                  ))}
                </tr>
              ))}
              <tr className="freq">
                <th>share</th>
                {stats.frequencies.map((f, j) => (
                  <td key={j}>{(f * 100).toFixed(0)}%</td>
                ))}
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2>Stage two</h2>
          <p className="hint">Number the edges: the edge builder works out consistent classes and suggests numberings with tail-free selections.</p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => handOff('build')} disabled={check.firstBad !== null || !matrixOk}>
              Number the edges →
            </button>
            <button type="button" onClick={() => handOff('explore')} disabled={check.firstBad !== null || !matrixOk}>
              Explore
            </button>
          </div>
          <div className="row wrap">
            <button
              type="button"
              onClick={() => {
                const r = refineLatticeSpec(spec);
                if (r.types.length > 26) {
                  setMessage(`Refining makes ${r.types.length} types; open it in the edge builder's refine button instead.`);
                  return;
                }
                setSpec(r);
                setTypeId(r.types[0].id);
                setBrush(r.types[0].id);
              }}
            >
              Refine by slot
            </button>
            <button
              type="button"
              onClick={() => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 1)], { type: 'application/json' }));
                a.download = `${(spec.name || 'substitution').replace(/[^\w-]+/g, '-')}.json`;
                a.click();
              }}
            >
              Export JSON
            </button>
            <button type="button" onClick={() => fileRef.current?.click()}>
              Import JSON
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </div>
          {check.firstBad !== null && <p className="hint">Fix the overlaps or holes first.</p>}
          {message && <p className="hint">{message}</p>}
        </section>
      </aside>

      <main className="lab-main">
        <div className="lab-editor">
          <div className="type-tabs">
            {spec.types.map((t) => (
              <button type="button" key={t.id} className={t.id === typeId ? 'on' : ''} style={{ ['--chip' as string]: t.color }} onClick={() => setTypeId(t.id)}>
                <span className="dot" /> {t.name}
              </button>
            ))}
          </div>
          <div className="toolbar">
            {TOOLS.map((tl) => (
              <button type="button" key={tl.id} className={tool === tl.id ? 'on' : ''} onClick={() => setTool(tl.id)} title={tl.hint}>
                {tl.label}
              </button>
            ))}
            {tool === 'paint' && (
              <span className="brushes">
                {spec.types.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    className={`swatch${brush === t.id ? ' on' : ''}`}
                    style={{ background: t.color }}
                    onClick={() => setBrush(t.id)}
                    aria-label={`Brush ${t.name}`}
                    title={t.name}
                  />
                ))}
              </span>
            )}
          </div>
          <p className="hint tool-hint">
            Editing <b>{type.name}</b>'s supertile. {TOOLS.find((x) => x.id === tool)?.hint}
          </p>
          <svg className="slot-editor" viewBox={vb} role="img" aria-label={`${type.name} supertile slots`}>
            {shown.map((cell) => {
              const k = cellKey(cell);
              const slot = slotIndex.get(k);
              const c = cellCenter(spec.grid, cell);
              const poly = grid.pts.map((p) => `${c.x + p.x * 0.97},${c.y + p.y * 0.97}`).join(' ');
              const ch = slot !== undefined ? childOf(spec, type.id, cell) : null;
              const enabled = slot !== undefined;
              return (
                <g key={k} className={`slot${enabled ? ' on' : ''}`} onClick={(e) => onCell(cell, e.shiftKey)}>
                  <polygon
                    points={poly}
                    fill={enabled ? (ch ? colour.get(ch.type) : 'var(--bg)') : 'transparent'}
                    stroke={enabled ? 'var(--ink)' : 'var(--line)'}
                    strokeWidth={enabled ? 0.06 : 0.03}
                    strokeDasharray={enabled && !ch ? '0.12 0.1' : undefined}
                  />
                  {ch && (
                    <polygon
                      points={MARK.map((m) => {
                        const q = transPt(leafXform(spec.grid, cell, orientation(spec.grid, ch.rot, ch.flip)), m);
                        return `${q.x},${q.y}`;
                      }).join(' ')}
                      fill="rgba(20,20,30,0.6)"
                    />
                  )}
                  {enabled && (
                    <text x={c.x} y={c.y + 0.62} fontSize={0.32} textAnchor="middle" className="slot-label">
                      {ch ? `${spec.types.find((t) => t.id === ch.type)?.name ?? ch.type}${ch.rot ? ` ↻${ch.rot}` : ''}${ch.flip ? ' ⇋' : ''}` : 'empty'}
                    </text>
                  )}
                  {cell[0] === 0 && cell[1] === 0 && <circle cx={c.x} cy={c.y} r={0.07} fill="var(--ink)" />}
                </g>
              );
            })}
          </svg>
        </div>
        <div className="lab-previews">
          {previews.map((p) => (
            <figure key={p.lv} className={p.chk && (p.chk.overlaps || p.chk.holes) ? 'bad' : ''}>
              <LatticePreview spec={spec} leaves={p.leaves} check={p.chk} />
              <figcaption>
                {type.name}, level {p.lv} · {p.leaves.length.toLocaleString()} tiles
                {p.chk && (p.chk.overlaps || p.chk.holes) ? ` · ${p.chk.overlaps} overlaps, ${p.chk.holes} holes` : ''}
              </figcaption>
            </figure>
          ))}
        </div>
      </main>
    </div>
  );
}

