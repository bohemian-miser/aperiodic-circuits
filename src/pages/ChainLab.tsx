import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  basePts,
  CHAIN_PRESETS,
  ChainSystem,
  chainPrototiles,
  checkChain,
  checkChainLeaves,
  refineChainSpec,
  slotCount,
  turnStep,
  validateChainSpec,
  type ChainBase,
  type ChainSpec,
  type ChainStep,
} from '../core/chain';
import { statsFromChildren } from '../core/lattice';
import { paletteColor } from '../core/tiling';
import { ChainPreview } from '../components/ChainPreview';
import { hashFor, replaceHash, type Route } from '../route';
import { addTilingSpec, fromBase64Url, toBase64Url } from '../store';
import { hash } from '../hash';

interface Props {
  readonly route: Route;
  readonly modeSwitch: ReactNode;
}

const STORE_KEY = 'aperiodic-circuits:lab-chain';
const QUAD_COLOURS = ['#e5484d', '#f59e0b', '#22a06b', '#3b82f6'];
const DEFAULT_QUAD: Record<ChainBase, ChainSpec['quad']> = { hex: [1, 2, 3, 5], spectre: [3, 5, 7, 11] };

function initialSpec(param: string | null): ChainSpec {
  const tries = [
    () => (param ? fromBase64Url(param) : null),
    () => localStorage.getItem(STORE_KEY),
  ];
  for (const get of tries) {
    try {
      const raw = get();
      if (!raw) continue;
      const s = JSON.parse(raw) as ChainSpec;
      if (s.kind === 'chain' && validateChainSpec(s).length === 0) return s;
    } catch {
      /* next */
    }
  }
  return CHAIN_PRESETS[0];
}

/** Row of a type's slot table, padded to the slot count (missing = itself). */
function rowOf(spec: ChainSpec, type: string): (string | null)[] {
  const row = spec.rules[type] ?? [];
  return Array.from({ length: slotCount(spec) }, (_, i) => (i < row.length ? row[i] : type));
}

export function ChainLab({ route, modeSwitch }: Props) {
  const [spec, setSpecRaw] = useState<ChainSpec>(() => initialSpec(route.params.get('d')));
  const [typeId, setTypeId] = useState(() => spec.types[0].id);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const type = spec.types.find((t) => t.id === typeId) ?? spec.types[0];
  const n = slotCount(spec);
  const step = turnStep(spec.base);

  const setSpec = (s: ChainSpec) => {
    setSpecRaw(s);
    setMessage(null);
  };

  useEffect(() => {
    const json = JSON.stringify(spec);
    try {
      localStorage.setItem(STORE_KEY, json);
    } catch {
      /* private window */
    }
    replaceHash(hashFor('lab', { d: toBase64Url(json) }));
  }, [spec]);

  const prototiles = useMemo(() => chainPrototiles(spec), [spec]);
  // Every type to level 3 (quick); the type on screen to level 4 as well.
  const check = useMemo(() => checkChain(spec, 3), [spec]);
  const previews = useMemo(() => {
    const sys = new ChainSystem(spec);
    return [1, 2, 3, 4]
      .filter((lv) => sys.leafCount(type.id, lv) <= 30_000)
      .map((lv) => {
        const leaves = sys.leaves(type.id, lv);
        const chk = lv <= 3 ? check.perType[type.id]?.[lv - 1] : checkChainLeaves(prototiles, leaves, lv);
        return { lv, leaves, slots: sys.slots(type.id, lv), chk };
      });
  }, [spec, type.id, check, prototiles]);
  const level4Bad = previews.find((p) => p.lv === 4 && p.chk && (p.chk.overlaps || p.chk.gaps));
  const stats = useMemo(() => statsFromChildren(spec.types.map((t) => t.id), Object.fromEntries(spec.types.map((t) => [t.id, rowOf(spec, t.id)]))), [spec]);
  const firstBad = check.firstBad ?? (level4Bad ? 4 : null);

  const setStep = (i: number, patch: Partial<ChainStep>) => setSpec({ ...spec, steps: spec.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const setRule = (t: string, slot: number, child: string | null) => {
    const row = rowOf(spec, t);
    row[slot] = child;
    setSpec({ ...spec, rules: { ...spec.rules, [t]: row } });
  };
  const addSlot = () => {
    const last = spec.steps[spec.steps.length - 1] ?? { turn: step, from: 3, to: 1 };
    const rules: Record<string, (string | null)[]> = {};
    for (const t of spec.types) rules[t.id] = [...rowOf(spec, t.id), t.id];
    setSpec({ ...spec, steps: [...spec.steps, { ...last }], rules });
  };
  const removeSlot = (slot: number) => {
    if (n <= 2) return;
    // Removing slot k removes the step that placed it (slot 0 has none: drop step 1 instead).
    const stepIdx = Math.max(0, slot - 1);
    const rules: Record<string, (string | null)[]> = {};
    for (const t of spec.types) rules[t.id] = rowOf(spec, t.id).filter((_, k) => k !== slot);
    const superQuad = spec.superQuad.map(([s, q]) => [s > slot ? s - 1 : Math.min(s, n - 2), q] as [number, number]);
    setSpec({ ...spec, steps: spec.steps.filter((_, k) => k !== stepIdx), rules, superQuad });
  };

  const addType = () => {
    const used = new Set(spec.types.map((t) => t.id));
    let id = '';
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(ch)) { id = ch; break; }
    if (!id) return;
    setSpec({ ...spec, types: [...spec.types, { id, name: id, color: paletteColor(spec.types.length) }], rules: { ...spec.rules, [id]: rowOf(spec, spec.types[0].id) } });
    setTypeId(id);
  };
  const removeType = (id: string) => {
    if (spec.types.length <= 1) return;
    const types = spec.types.filter((t) => t.id !== id);
    const fallback = types[0].id;
    const rules: Record<string, (string | null)[]> = {};
    for (const t of types) rules[t.id] = rowOf(spec, t.id).map((c) => (c === id ? fallback : c));
    setSpec({ ...spec, types, rules, defaultRoot: undefined });
    if (typeId === id) setTypeId(fallback);
  };

  const handOff = (page: 'build' | 'explore') => {
    const body = JSON.stringify({ base: spec.base, quad: spec.quad, firstFlip: spec.firstFlip, steps: spec.steps, superQuad: spec.superQuad, mirror: spec.mirror, types: spec.types, rules: spec.rules });
    const id = `lab-${hash(body)}`;
    try {
      addTilingSpec({ ...spec, id, name: spec.name || 'Lab tiling', defaultRoot: spec.types.some((t) => t.id === spec.defaultRoot) ? spec.defaultRoot : spec.types[0].id });
      window.location.hash = hashFor(page, { t: id });
    } catch (e) {
      setMessage(`Couldn't use it: ${(e as Error).message}`);
    }
  };

  const importFile = async (f: File) => {
    try {
      const s = JSON.parse(await f.text()) as ChainSpec;
      const errs = validateChainSpec(s);
      if (errs.length) throw new Error(errs.join('; '));
      setSpec(s);
      setTypeId(s.types[0].id);
    } catch (e) {
      setMessage(`Couldn't import: ${(e as Error).message}`);
    }
  };

  const turns: number[] = [];
  for (let a = -180 + step; a <= 180; a += step) turns.push(a);
  const nameOf = (id: string | null) => (id === null ? '—' : spec.types.find((t) => t.id === id)?.name ?? id);
  const baseLen = basePts(spec.base).length;

  return (
    <div className="workspace lab">
      <aside className="sidebar">
        <section>
          <h2>Substitution lab</h2>
          {modeSwitch}
          <p className="hint">
            Stage one, the Spectre's way. A supertile is a chain of slots: each child turns, then is glued so one of its four quad points lands on a
            quad point of the child before. The supertile's own quad is four of its children's quad points, so the same chain runs again a level up.
          </p>
          <label className="field">
            <span>Start from</span>
            <select
              value=""
              onChange={(e) => {
                const p = CHAIN_PRESETS.find((x) => x.id === e.target.value);
                if (p) {
                  setSpec(p);
                  setTypeId(p.types[0].id);
                }
              }}
            >
              <option value="" disabled>
                A preset…
              </option>
              {CHAIN_PRESETS.map((p) => (
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
            {(['hex', 'spectre'] as const).map((b) => (
              <button
                type="button"
                key={b}
                className={spec.base === b ? 'on' : ''}
                onClick={() => b !== spec.base && setSpec({ ...spec, base: b, quad: DEFAULT_QUAD[b] })}
              >
                {b === 'hex' ? 'Hexagons' : 'Spectres'}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>Quad points</h2>
          <p className="hint">The four vertices of the base tile the chain glues by. Defaults are the Spectre project's.</p>
          <div className="quad-row">
            {spec.quad.map((v, q) => (
              <label key={q} className="quad-pick" style={{ ['--chip' as string]: QUAD_COLOURS[q] }}>
                <span className="dot" /> {q}
                <select
                  value={v}
                  onChange={(e) => {
                    const quad = [...spec.quad] as [number, number, number, number];
                    quad[q] = Number(e.target.value);
                    setSpec({ ...spec, quad });
                  }}
                  aria-label={`Vertex for quad point ${q}`}
                >
                  {Array.from({ length: baseLen }, (_, i) => (
                    <option key={i} value={i}>
                      v{i}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h2>Chain</h2>
          <table className="chain-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Turn</th>
                <th title="Quad point of the previous slot">From</th>
                <th title="Quad point of this slot that goes there">To</th>
                <th>Flip</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>0</td>
                <td colSpan={3} className="muted">
                  starts the chain
                </td>
                <td>
                  <input type="checkbox" checked={!!spec.firstFlip} onChange={(e) => setSpec({ ...spec, firstFlip: e.target.checked || undefined })} aria-label="Flip slot 0" />
                </td>
                <td>
                  <button type="button" className="linkish" onClick={() => removeSlot(0)} disabled={n <= 2} aria-label="Remove slot 0">
                    ✕
                  </button>
                </td>
              </tr>
              {spec.steps.map((st, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <select value={st.turn} onChange={(e) => setStep(i, { turn: Number(e.target.value) })} aria-label={`Turn for slot ${i + 1}`}>
                      {!turns.includes(st.turn) && <option value={st.turn}>{st.turn}°</option>}
                      {turns.map((a) => (
                        <option key={a} value={a}>
                          {a > 0 ? `+${a}` : a}°
                        </option>
                      ))}
                    </select>
                  </td>
                  {(['from', 'to'] as const).map((k) => (
                    <td key={k}>
                      <select value={st[k]} onChange={(e) => setStep(i, { [k]: Number(e.target.value) })} style={{ color: QUAD_COLOURS[st[k]] }} aria-label={`${k} point for slot ${i + 1}`}>
                        {[0, 1, 2, 3].map((q) => (
                          <option key={q} value={q}>
                            {q}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                  <td>
                    <input type="checkbox" checked={!!st.flip} onChange={(e) => setStep(i, { flip: e.target.checked || undefined })} aria-label={`Flip slot ${i + 1}`} />
                  </td>
                  <td>
                    <button type="button" className="linkish" onClick={() => removeSlot(i + 1)} disabled={n <= 2} aria-label={`Remove slot ${i + 1}`}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row wrap">
            <button type="button" onClick={addSlot}>
              Add a slot
            </button>
            <label className="checks">
              <input type="checkbox" checked={spec.mirror} onChange={(e) => setSpec({ ...spec, mirror: e.target.checked })} /> Mirror each level
            </label>
          </div>
          <h3 className="sub">Supertile quad</h3>
          <p className="hint">Which children's quad points become the supertile's own.</p>
          <div className="quad-row">
            {spec.superQuad.map(([s, q], k) => (
              <label key={k} className="quad-pick" style={{ ['--chip' as string]: QUAD_COLOURS[k] }}>
                <span className="dot" /> {k} =
                <select
                  value={s}
                  onChange={(e) => setSpec({ ...spec, superQuad: spec.superQuad.map((x, j) => (j === k ? [Number(e.target.value), x[1]] : x)) })}
                  aria-label={`Slot for supertile quad point ${k}`}
                >
                  {Array.from({ length: n }, (_, i) => (
                    <option key={i} value={i}>
                      slot {i}
                    </option>
                  ))}
                </select>
                <select
                  value={q}
                  onChange={(e) => setSpec({ ...spec, superQuad: spec.superQuad.map((x, j) => (j === k ? [x[0], Number(e.target.value)] : x)) })}
                  aria-label={`Point for supertile quad point ${k}`}
                >
                  {[0, 1, 2, 3].map((i) => (
                    <option key={i} value={i}>
                      pt {i}
                    </option>
                  ))}
                </select>
              </label>
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
          <div className="row wrap">
            <button type="button" onClick={addType} disabled={spec.types.length >= 26}>
              Add a type
            </button>
            {spec.base === 'spectre' && (
              <label className="checks" title="A Mystic is two Spectres glued together, as the Spectre's Gamma tile is">
                <input
                  type="checkbox"
                  checked={!!type.mystic}
                  onChange={(e) => setSpec({ ...spec, types: spec.types.map((x) => (x.id === type.id ? { ...x, mystic: e.target.checked || undefined } : x)) })}
                />{' '}
                {type.name} is a Mystic
              </label>
            )}
          </div>
        </section>

        <section>
          <h2>Does it work?</h2>
          <ul className="levels">
            {[1, 2, 3, 4].map((lv) => {
              let o = 0;
              let g = 0;
              let measured = false;
              if (lv <= 3) {
                for (const t of spec.types) {
                  const c = check.perType[t.id]?.[lv - 1];
                  if (!c) continue;
                  measured = true;
                  o += c.overlaps;
                  g += c.gaps;
                }
              } else {
                const p = previews.find((x) => x.lv === 4);
                if (p?.chk) {
                  measured = true;
                  o = p.chk.overlaps;
                  g = p.chk.gaps;
                }
              }
              return (
                <li key={lv} className={!measured ? 'muted' : o || g ? 'bad' : 'good'}>
                  Level {lv}
                  {lv === 4 ? ` (${type.name})` : ''}: {!measured ? 'too big to check' : o || g ? `${o} overlap${o === 1 ? '' : 's'}, ${g} gap${g === 1 ? '' : 's'}` : 'fits'}
                </li>
              );
            })}
          </ul>
          <p className="hint">
            Grows ×{stats.growth.toFixed(2)} per level. {stats.primitive ? 'Primitive: every type ends up inside every supertile.' : 'Not primitive: some types never reach others.'}
            {stats.unused.length > 0 && ` Never used as a child: ${stats.unused.map((u) => nameOf(u)).join(', ')}.`} A gap is a hole or a piece that doesn't touch the
            rest; overlapping tiles are shaded red in the previews.
          </p>
        </section>

        <section>
          <h2>Stage two</h2>
          <p className="hint">Number the edges: the edge builder works out consistent classes and suggests numberings with tail-free selections.</p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => handOff('build')} disabled={firstBad !== null}>
              Number the edges →
            </button>
            <button type="button" onClick={() => handOff('explore')} disabled={firstBad !== null}>
              Explore
            </button>
          </div>
          <div className="row wrap">
            <button
              type="button"
              onClick={() => {
                const r = refineChainSpec(spec);
                if (r.types.length > 26) {
                  setMessage(`Refining makes ${r.types.length} types; send it on and use the edge builder's refine button instead.`);
                  return;
                }
                setSpec(r);
                setTypeId(r.types[0].id);
              }}
            >
              Refine by slot
            </button>
            <button
              type="button"
              onClick={() => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 1)], { type: 'application/json' }));
                a.download = `${(spec.name || 'chain').replace(/[^\w-]+/g, '-')}.json`;
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
          {firstBad !== null && <p className="hint">Fix the overlaps or gaps first.</p>}
          {message && <p className="hint">{message}</p>}
        </section>
      </aside>

      <main className="lab-main chain">
        <div className="lab-editor">
          <div className="type-tabs">
            {spec.types.map((t) => (
              <button type="button" key={t.id} className={t.id === typeId ? 'on' : ''} style={{ ['--chip' as string]: t.color }} onClick={() => setTypeId(t.id)}>
                <span className="dot" /> {t.name}
              </button>
            ))}
          </div>
          <p className="hint tool-hint">
            <b>{type.name}</b>'s supertile: pick what fills each slot, or — to leave it empty (like the Spectre Gamma's slot 2). Coloured dots are each child's quad
            points 0–3.
          </p>
          <div className="slot-picks">
            {rowOf(spec, type.id).map((c, i) => (
              <label key={i} className="slot-pick" style={{ ['--chip' as string]: c ? spec.types.find((t) => t.id === c)?.color : 'transparent' }}>
                <span>slot {i}</span>
                <select value={c ?? ''} onChange={(e) => setRule(type.id, i, e.target.value || null)} aria-label={`Slot ${i} of ${type.name}`}>
                  <option value="">—</option>
                  {spec.types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {previews[0] && (
            <figure className={`chain-main${previews[0].chk && (previews[0].chk.overlaps || previews[0].chk.gaps) ? ' bad' : ''}`}>
              <ChainPreview spec={spec} prototiles={prototiles} leaves={previews[0].leaves} slots={previews[0].slots} badTiles={previews[0].chk?.badTiles} annotate height={340} />
              <figcaption>{type.name}, level 1 · numbers are slots</figcaption>
            </figure>
          )}
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
                  {stats.counts[i].map((x, j) => (
                    <td key={j}>{x || ''}</td>
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
        </div>
        <div className="lab-previews">
          {previews.slice(1).map((p) => (
            <figure key={p.lv} className={p.chk && (p.chk.overlaps || p.chk.gaps) ? 'bad' : ''}>
              <ChainPreview spec={spec} prototiles={prototiles} leaves={p.leaves} slots={p.slots} badTiles={p.chk?.badTiles} />
              <figcaption>
                {type.name}, level {p.lv} · {p.leaves.length.toLocaleString()} tiles
                {p.chk && (p.chk.overlaps || p.chk.gaps) ? ` · ${p.chk.overlaps} overlaps, ${p.chk.gaps} gaps` : ''}
              </figcaption>
            </figure>
          ))}
        </div>
      </main>
    </div>
  );
}
