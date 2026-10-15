import { useMemo, useRef, useState } from 'react';
import { analyzeParity } from '../core/parity';
import {
  className,
  derivedRuleSet,
  freshClass,
  joinWithNext,
  MAX_CLASSES,
  mergeConflictingClasses,
  renumberClasses,
  ruleSetClasses,
  setEdgeClass,
  splitBefore,
  validateRuleSet,
  type Conflict,
  type RuleSet,
  type Seam,
} from '../core/ruleset';
import { refineLatticeSpec } from '../core/lattice';
import { refineSpec, type Tiling, type TilingSpec } from '../core/tiling';
import { getTiling, validateTilingSpec } from '../core/tilings';
import { greedySuggestions, neighbourReport, randomSuggestion, type Suggestion } from '../core/suggest';

import { PatchCanvas } from '../components/PatchCanvas';
import { TileGlyph } from '../components/TileGlyph';
import { classColor } from '../colors';
import { hashFor, replaceHash, type Route } from '../route';
import {
  addTilingSpec,
  defaultRuleSet,
  deleteRuleSet,
  findRuleSet,
  isUserRuleSet,
  makeBundle,
  openBundle,
  ruleSetsFor,
  saveRuleSet,
  saveRuleSetAsNew,
  tilings,
  toBase64Url,
  type Bundle,
} from '../store';

interface Props {
  readonly route: Route;
}

function asDraft(rs: RuleSet): RuleSet {
  return isUserRuleSet(rs.id) ? rs : { ...rs, id: 'draft', name: `${rs.name} (copy)` };
}

function describeConflict(t: Tiling, rs: RuleSet, c: Conflict): string {
  const nm = (id: string) => t.prototiles.find((p) => p.id === id)?.name ?? id;
  const cls = (x: number | null) => (x === null ? 'none' : className(rs, x));
  if (c.kind === 'unlabelled') return `An unlabelled edge of ${nm(c.typeA)} meets ${nm(c.typeB)}'s seam ${c.seamB} (class ${cls(c.clsB)}).`;
  if (c.kind === 'structure') return `${nm(c.typeA)}'s seam ${c.seamA} doesn't line up with one whole seam of ${nm(c.typeB)}, so the crossing points miss.`;
  return `${nm(c.typeA)}'s seam ${c.seamA} (class ${cls(c.clsA)}) meets ${nm(c.typeB)}'s seam ${c.seamB} (class ${cls(c.clsB)}).`;
}

function oneClass(t: Tiling): RuleSet {
  const seams: Record<string, Seam[]> = {};
  for (const p of t.prototiles) seams[p.id] = p.pts.map((_, i) => ({ edges: [i], cls: 0 }));
  return { id: 'draft', name: 'One class everywhere', tilingId: t.id, seams };
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function BuilderPage({ route }: Props) {
  const p = route.params;
  const [tilingId, setTilingId] = useState(() => p.get('t') ?? 'hex');
  const tiling = getTiling(tilingId) ?? getTiling('hex')!;
  const [draft, setDraft] = useState<RuleSet>(() => {
    const found = findRuleSet(p.get('rs') ?? '');
    return asDraft(found && found.tilingId === tiling.id ? found : defaultRuleSet(tiling));
  });
  const [brush, setBrush] = useState<number | null>(() => ruleSetClasses(draft)[0] ?? 0);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const edit = (rs: RuleSet) => {
    setDraft(rs);
    setDirty(true);
  };
  const load = (rs: RuleSet) => {
    const d = asDraft(rs);
    setDraft(d);
    setBrush(ruleSetClasses(d)[0] ?? 0);
    setDirty(false);
  };
  const switchTiling = (id: string) => {
    const t = getTiling(id)!;
    setTilingId(id);
    load(defaultRuleSet(t));
    replaceHash(hashFor('build', { t: id }));
  };

  const validation = useMemo(() => validateRuleSet(tiling, draft), [tiling, draft]);
  const parity = useMemo(() => analyzeParity(tiling, draft, 64), [tiling, draft]);
  const classes = useMemo(() => ruleSetClasses(draft), [draft]);
  const previewLevel = Math.max(1, Math.min(tiling.deriveLevel, tiling.defaultLevel - 1));
  const preview = useMemo(() => tiling.generate(previewLevel, tiling.defaultRoot), [tiling, previewLevel]);
  const flagged = useMemo(() => {
    const m = new Map<string, Set<number>>();
    for (const c of validation.conflicts) {
      for (const [t, s] of [
        [c.typeA, c.seamA],
        [c.typeB, c.seamB],
      ] as const) {
        if (s < 0) continue;
        if (!m.has(t)) m.set(t, new Set());
        m.get(t)!.add(s);
      }
    }
    return m;
  }, [validation]);

  const onVertex = (type: string, v: number, n: number) => {
    const seams = draft.seams[type] ?? [];
    const prevEdge = (v - 1 + n) % n;
    const a = seams.findIndex((s) => s.edges.includes(prevEdge));
    const b = seams.findIndex((s) => s.edges.includes(v));
    if (a >= 0 && a === b) edit(splitBefore(draft, type, v));
    else if (a >= 0) edit(joinWithNext(draft, type, prevEdge, n));
    else if (b >= 0) edit(joinWithNext(setEdgeClass(draft, type, prevEdge, seams[b].cls), type, prevEdge, n));
  };

  const save = (asNew: boolean) => {
    const named = { ...draft, name: draft.name.trim() || 'Untitled rule set' };
    const saved = asNew || !isUserRuleSet(draft.id) ? saveRuleSetAsNew(named) : saveRuleSet(named);
    setDraft(saved);
    setDirty(false);
    replaceHash(hashFor('build', { t: tiling.id, rs: saved.id }));
    setMessage(`Saved “${saved.name}” in this browser.`);
  };

  const importFile = async (f: File) => {
    try {
      const rs = openBundle(JSON.parse(await f.text()) as Bundle);
      setTilingId(rs.tilingId);
      load({ ...rs, id: 'draft' });
      setDirty(true);
      setMessage(`Imported “${rs.name}”. Save it to keep it.`);
    } catch (e) {
      setMessage(`Couldn't import: ${(e as Error).message}`);
    }
  };

  const tryLink = hashFor('explore', {
    t: tiling.id,
    rs: draft.id,
    rsd: isUserRuleSet(draft.id) && !dirty ? undefined : toBase64Url(JSON.stringify(makeBundle(draft))),
  });

  const [specText, setSpecText] = useState('');
  const registerSpec = () => {
    try {
      const spec = JSON.parse(specText) as TilingSpec;
      const errs = validateTilingSpec(spec);
      if (errs.length) throw new Error(errs.join('; '));
      const t = addTilingSpec(spec);
      switchTiling(t.id);
      setMessage(`Added tiling “${t.name}”.`);
    } catch (e) {
      setMessage(`Couldn't add tiling: ${(e as Error).message}`);
    }
  };

  const classCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const seams of Object.values(draft.seams)) for (const s of seams) m.set(s.cls, (m.get(s.cls) ?? 0) + 1);
    return m;
  }, [draft]);

  return (
    <div className="workspace builder">
      <aside className="sidebar">
        <section>
          <h2>Start from</h2>
          <label className="field">
            <span>Tiling</span>
            <select value={tiling.id} onChange={(e) => switchTiling(e.target.value)}>
              {tilings().map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Copy a rule set</span>
            <select
              value=""
              onChange={(e) => {
                const rs = findRuleSet(e.target.value);
                if (rs) load(rs);
              }}
            >
              <option value="" disabled>
                Choose…
              </option>
              {ruleSetsFor(tiling.id).map((r) => (
                <option key={r.ruleSet.id} value={r.ruleSet.id}>
                  {r.builtin ? '' : '★ '}
                  {r.ruleSet.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row wrap">
            <button type="button" onClick={() => edit({ ...derivedRuleSet(tiling, 'seams'), id: draft.id, name: draft.name })}>
              Derive seams
            </button>
            <button type="button" onClick={() => edit({ ...derivedRuleSet(tiling, 'edges'), id: draft.id, name: draft.name })}>
              Derive per edge
            </button>
            <button type="button" onClick={() => edit({ ...oneClass(tiling), id: draft.id, name: draft.name })}>
              One class
            </button>
          </div>
          {tiling.spec && (
            <button
              type="button"
              onClick={() => {
                const spec = tiling.spec!;
                const t = addTilingSpec(spec.kind === 'lattice' ? refineLatticeSpec(spec) : refineSpec(spec));
                switchTiling(t.id);
                setMessage(`Made “${t.name}”: each tile now knows which slot of its supertile it fills.`);
              }}
            >
              Refine tiles by supertile slot
            </button>
          )}
        </section>

        <section>
          <h2>Classes</h2>
          <p className="hint">Pick a brush, then click edges on the tiles. Click a vertex to join the edges either side into one seam, or split them.</p>
          <div className="class-list">
            {classes.map((c) => (
              <div key={c} className={`class-row${brush === c ? ' on' : ''}`}>
                <button type="button" className="swatch" style={{ background: classColor(c) }} onClick={() => setBrush(c)} aria-label={`Paint class ${className(draft, c)}`} />
                <input
                  value={draft.classNames?.[c] ?? ''}
                  placeholder={`class ${className({ ...draft, classNames: undefined }, c)}`}
                  onChange={(e) => {
                    const names = { ...(draft.classNames ?? {}) };
                    if (e.target.value) names[c] = e.target.value.slice(0, 8);
                    else delete names[c];
                    edit({ ...draft, classNames: Object.keys(names).length ? names : undefined });
                  }}
                  onFocus={() => setBrush(c)}
                  aria-label={`Name for class ${c}`}
                />
                <small>{classCounts.get(c)} seams</small>
              </div>
            ))}
          </div>
          <div className="row wrap">
            <button
              type="button"
              onClick={() => {
                const c = freshClass(draft);
                setBrush(c);
              }}
            >
              New class{brush !== null && !classes.includes(brush) ? ` (${brush} — paint an edge)` : ''}
            </button>
            <button type="button" className={brush === null ? 'on' : ''} onClick={() => setBrush(null)}>
              Eraser
            </button>
            <button type="button" onClick={() => edit(renumberClasses(draft, tiling.prototiles.map((q) => q.id)))}>
              Renumber
            </button>
          </div>
        </section>

        <section>
          <h2>Check</h2>
          {validation.ok ? (
            <p className="status good">Consistent: every seam meets a seam of the same class ({validation.meetings.toLocaleString()} meetings checked).</p>
          ) : (
            <>
              <p className="status bad">
                {validation.conflicts.length} kind{validation.conflicts.length === 1 ? '' : 's'} of mismatch. Lines would end where these meet.
              </p>
              <ul className="conflicts">
                {validation.conflicts.slice(0, 8).map((c, i) => (
                  <li key={i}>
                    {describeConflict(tiling, draft, c)} <small>×{c.count}</small>
                  </li>
                ))}
              </ul>
              {validation.conflicts.some((c) => c.kind === 'class') && (
                <button type="button" onClick={() => edit(mergeConflictingClasses(draft, validation))}>
                  Merge classes that meet
                </button>
              )}
            </>
          )}
          <p className="hint">
            {parity.count.toLocaleString()} tail-free edge selection{parity.count === 1 ? '' : 's'} out of {(2 ** classes.length).toLocaleString()}
            {parity.selections.length > 1 && (
              <>
                : {parity.selections.slice(1, 13).map((s) => s.map((c) => className(draft, c)).join(draft.classNames ? ',' : '')).join('  ')}
                {parity.count > 13 ? ' …' : ''}
              </>
            )}
          </p>
        </section>

        <EdgeHelp tiling={tiling} onUse={(rs) => edit({ ...rs, id: draft.id, name: draft.name === '' ? rs.name : draft.name })} />

        <section>
          <h2>Keep it</h2>
          <label className="field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => edit({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea rows={2} value={draft.notes ?? ''} onChange={(e) => edit({ ...draft, notes: e.target.value || undefined })} />
          </label>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => save(false)}>
              {isUserRuleSet(draft.id) ? 'Save' : 'Save as mine'}
            </button>
            {isUserRuleSet(draft.id) && (
              <button type="button" onClick={() => save(true)}>
                Save as new
              </button>
            )}
            <a className="button" href={tryLink}>
              Explore it →
            </a>
          </div>
          <div className="row wrap">
            <button type="button" onClick={() => download(`${(draft.name || 'rule-set').replace(/[^\w-]+/g, '-')}.json`, JSON.stringify(makeBundle(draft), null, 2))}>
              Export JSON
            </button>
            <button type="button" onClick={() => fileRef.current?.click()}>
              Import JSON
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
            {isUserRuleSet(draft.id) && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (!confirm(`Delete “${draft.name}”?`)) return;
                  deleteRuleSet(draft.id);
                  load(defaultRuleSet(tiling));
                }}
              >
                Delete
              </button>
            )}
          </div>
          {dirty && <p className="hint">Unsaved changes.</p>}
          {message && <p className="hint">{message}</p>}
        </section>

        <section>
          <details>
            <summary>Define a new tiling</summary>
            <p className="hint">
              Paste a substitution tiling as JSON: prototile vertices, an inflation factor, and for each prototile where its children's first two vertices land. Start from the current tiling's JSON if it has one.
            </p>
            {tiling.spec && (
              <button type="button" onClick={() => setSpecText(JSON.stringify({ ...tiling.spec, id: `${tiling.id}-copy`, name: `${tiling.name} copy` }, null, 1))}>
                Load this tiling's JSON
              </button>
            )}
            <textarea className="mono" rows={10} value={specText} onChange={(e) => setSpecText(e.target.value)} spellCheck={false} />
            <button type="button" onClick={registerSpec} disabled={!specText.trim()}>
              Add tiling
            </button>
          </details>
        </section>
      </aside>

      <main className="builder-main">
        <div className="tile-editors">
          {tiling.prototiles.map((q) => (
            <figure key={q.id} className="tile-editor">
              <TileGlyph
                tiling={tiling}
                type={q.id}
                ruleSet={draft}
                size={180}
                showLabels
                flagged={flagged.get(q.id)}
                onEdgeClick={(e) => edit(setEdgeClass(draft, q.id, e, brush))}
                onVertexClick={(v) => onVertex(q.id, v, q.pts.length)}
              />
              <figcaption>
                {q.name} <small>· {(draft.seams[q.id] ?? []).length} seams</small>
              </figcaption>
            </figure>
          ))}
        </div>
        <div className="builder-preview">
          <PatchCanvas tiling={tiling} instances={preview} ruleSet={draft} classEdges="all" showOutlines />
        </div>
      </main>
    </div>
  );
}

/** Stage two's automatic help: what the tiling's own adjacency allows, and labellings worth trying. */
function EdgeHelp({ tiling, onUse }: { readonly tiling: Tiling; readonly onUse: (rs: RuleSet) => void }) {
  const report = useMemo(() => neighbourReport(tiling), [tiling]);
  const base = useMemo(() => derivedRuleSet(tiling, 'seams'), [tiling]);
  const baseClasses = ruleSetClasses(base).length;
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState(4);
  const shown = (list ?? []).filter((s) => s.classes <= 12).sort((a, b) => a.classes - b.classes);
  const share = report.total ? report.determined / report.total : 0;

  return (
    <section>
      <h2>Help me number the edges</h2>
      <p className="hint">
        {report.determined} of {report.total} tile edges always meet the same neighbour edge.{' '}
        {share < 0.25
          ? 'Most edges meet many different neighbours, so few classes can be told apart. Refining by supertile slot gives each tile more to remember.'
          : share < 1
            ? 'Some edges still meet several neighbours; those classes get merged.'
            : 'Every edge has one partner: the types carry their own matching rules, like a collared substitution.'}
      </p>
      <p className="hint">
        The finest consistent numbering has {baseClasses} class{baseClasses === 1 ? '' : 'es'}
        {baseClasses > MAX_CLASSES ? `, more than the ${MAX_CLASSES} that fit a share string; use a suggestion to bring it down` : ''}. Every suggestion below merges those classes, so it's consistent by construction.
      </p>
      <div className="row wrap">
        <button type="button" onClick={() => onUse(base)}>
          Use finest
        </button>
        <button
          type="button"
          disabled={busy || baseClasses < 3}
          onClick={() => {
            setBusy(true);
            // Let the button repaint before the search blocks the thread.
            setTimeout(() => {
              setList(greedySuggestions(tiling, base));
              setBusy(false);
            }, 20);
          }}
        >
          {busy ? 'Searching…' : 'Suggest numberings'}
        </button>
      </div>
      <div className="row">
        <button type="button" disabled={baseClasses < 2} onClick={() => onUse(randomSuggestion(tiling, base, k).ruleSet)}>
          Random merge to
        </button>
        <input type="number" min={1} max={Math.min(MAX_CLASSES, baseClasses)} value={k} onChange={(e) => setK(Math.max(1, Number(e.target.value) || 1))} style={{ width: 64 }} aria-label="Number of classes" />
        <span className="hint">classes</span>
      </div>
      {list && (
        <table className="suggest">
          <thead>
            <tr>
              <th>Classes</th>
              <th>Tail-free selections</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.classes}>
                <td>{s.classes}</td>
                <td>{s.tailFree.toLocaleString()}</td>
                <td>
                  <button type="button" className="linkish on" onClick={() => onUse(s.ruleSet)}>
                    use
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
