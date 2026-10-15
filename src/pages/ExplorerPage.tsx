import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeCircuits, type CircuitResult } from '../core/circuits';
import { choiceCount, MAX_ENUMERATED_CROSSINGS } from '../core/matchings';
import { analyzeParity, crossingCounts } from '../core/parity';
import { className, computeAdjacency, ruleSetClasses, type RuleSet } from '../core/ruleset';
import { decodeShare, encodeShare } from '../core/share';
import { getTiling } from '../core/tilings';
import type { Tiling } from '../core/tiling';
import { PatchCanvas, pathColors } from '../components/PatchCanvas';
import { TileGlyph } from '../components/TileGlyph';
import { classColor } from '../colors';
import { hashFor, replaceHash, type Route } from '../route';
import {
  defaultRuleSet,
  findRuleSet,
  fromBase64Url,
  isUserRuleSet,
  makeBundle,
  openBundle,
  ruleSetsFor,
  saveRuleSetAsNew,
  tilings,
  toBase64Url,
  type Bundle,
} from '../store';

interface Props {
  readonly route: Route;
}

function loadEmbedded(param: string | null): RuleSet | null {
  if (!param) return null;
  try {
    return openBundle(JSON.parse(fromBase64Url(param)) as Bundle);
  } catch {
    return null;
  }
}

function firstGoodSelection(t: Tiling, rs: RuleSet): number[] {
  const par = analyzeParity(t, rs, 64);
  return [...(par.selections.find((s) => s.length > 0) ?? ruleSetClasses(rs).slice(0, 1))];
}

export function ExplorerPage({ route }: Props) {
  const p = route.params;
  const [embedded, setEmbedded] = useState<RuleSet | null>(() => loadEmbedded(p.get('rsd')));
  const [tilingId, setTilingId] = useState(() => embedded?.tilingId ?? p.get('t') ?? 'hex');
  const tiling = getTiling(tilingId) ?? getTiling('hex')!;
  const [ruleSetId, setRuleSetId] = useState<string>(() => embedded?.id ?? p.get('rs') ?? '');
  const ruleSet: RuleSet = useMemo(() => {
    if (embedded && embedded.id === ruleSetId) return embedded;
    const found = findRuleSet(ruleSetId);
    return found && found.tilingId === tiling.id ? found : defaultRuleSet(tiling);
  }, [embedded, ruleSetId, tiling]);
  const types = useMemo(() => tiling.prototiles.map((q) => q.id), [tiling]);

  const [level, setLevel] = useState(() => {
    const lv = Number(p.get('lv'));
    return Number.isFinite(lv) && p.has('lv') ? Math.max(0, Math.min(tiling.maxLevel, lv)) : tiling.defaultLevel;
  });
  const [root, setRoot] = useState(() => {
    const r = p.get('root');
    return r && tiling.roots.includes(r) ? r : tiling.defaultRoot;
  });
  const initialShare = useMemo(() => {
    const s = p.get('s');
    return s ? decodeShare(s, types) : null;
  }, []);
  const [selection, setSelection] = useState<ReadonlySet<number>>(() => new Set(initialShare?.selection ?? firstGoodSelection(tiling, ruleSet)));
  const [combo, setCombo] = useState<Record<string, number>>(() => initialShare?.combo ?? {});
  const [selectedPath, setSelectedPath] = useState<number | null>(null);
  const [showTiles, setShowTiles] = useState(true);
  const [showClassEdges, setShowClassEdges] = useState(false);
  const [lineWidth, setLineWidth] = useState(1);

  // Switching tiling or rule set resets the dependent state.
  const switchTiling = (id: string) => {
    const t = getTiling(id)!;
    setTilingId(id);
    const rs = defaultRuleSet(t);
    setRuleSetId(rs.id);
    setLevel(t.defaultLevel);
    setRoot(t.defaultRoot);
    setSelection(new Set(firstGoodSelection(t, rs)));
    setCombo({});
  };
  const switchRuleSet = (id: string) => {
    setRuleSetId(id);
    const rs = (embedded?.id === id ? embedded : findRuleSet(id)) ?? defaultRuleSet(tiling);
    setSelection(new Set(firstGoodSelection(tiling, rs)));
    setCombo({});
  };

  const classes = useMemo(() => ruleSetClasses(ruleSet), [ruleSet]);
  const parity = useMemo(() => analyzeParity(tiling, ruleSet, 256), [tiling, ruleSet]);
  const counts = useMemo(() => crossingCounts(tiling, ruleSet, selection), [tiling, ruleSet, selection]);
  const instances = useMemo(() => tiling.generate(level, root), [tiling, level, root]);
  const adjacency = useMemo(() => computeAdjacency(tiling, instances), [tiling, instances]);
  const circuits: CircuitResult = useMemo(
    () => computeCircuits({ tiling, ruleSet, instances, selection, combo, adjacency }),
    [tiling, ruleSet, instances, selection, combo, adjacency],
  );
  useEffect(() => setSelectedPath(null), [circuits]);

  const share = encodeShare(selection, combo, types);
  const isTailFree = circuits.oddTypes.length === 0;

  // Keep the URL in step (without spamming history).
  useEffect(() => {
    const params: Record<string, string | number | undefined> = { t: tiling.id, rs: ruleSet.id, lv: level, root, s: share };
    if (embedded && embedded.id === ruleSet.id) params.rsd = p.get('rsd') ?? undefined;
    replaceHash(hashFor('explore', params));
  }, [tiling.id, ruleSet.id, level, root, share, embedded, p]);

  const toggleClass = (c: number) => {
    const next = new Set(selection);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setSelection(next);
  };

  const stepCombo = (type: string, d: number) => {
    const n = choiceCount(counts[type]);
    if (n <= 1) return;
    setCombo({ ...combo, [type]: (((combo[type] ?? 0) + d) % n + n) % n });
  };
  const randomCombo = () => {
    const next: Record<string, number> = {};
    for (const t of types) {
      const n = counts[t] > MAX_ENUMERATED_CROSSINGS ? 1 : choiceCount(counts[t]);
      next[t] = n > 1 ? Math.floor(Math.random() * n) : 0;
    }
    setCombo(next);
  };
  const totalCombos = types.reduce((acc, t) => acc * Math.max(1, counts[t] > MAX_ENUMERATED_CROSSINGS ? 1 : choiceCount(counts[t])), 1);

  const [shareDraft, setShareDraft] = useState<string | null>(null);
  const applyShare = (s: string) => {
    const d = decodeShare(s, types);
    if (d) {
      setSelection(new Set(d.selection));
      setCombo(d.combo);
    }
    setShareDraft(null);
  };

  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    const params: Record<string, string | number> = { t: tiling.id, rs: ruleSet.id, lv: level, root, s: share };
    // Rule sets that only live in this browser travel inside the link.
    if (isUserRuleSet(ruleSet.id) || embedded?.id === ruleSet.id) params.rsd = toBase64Url(JSON.stringify(makeBundle(ruleSet)));
    const url = `${location.origin}${location.pathname}${hashFor('explore', params)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  const ruleSets = ruleSetsFor(tiling.id);
  const colors = useMemo(() => pathColors(circuits), [circuits]);
  const lengths = [...circuits.circuitLengths.entries()].sort((a, b) => a[0] - b[0]);
  const sel = selectedPath !== null ? circuits.paths[selectedPath] : null;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <section>
          <h2>Rule set</h2>
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
            <span>Labelling</span>
            <select value={ruleSet.id} onChange={(e) => switchRuleSet(e.target.value)}>
              <optgroup label="Built in">
                {ruleSets.filter((r) => r.builtin).map((r) => (
                  <option key={r.ruleSet.id} value={r.ruleSet.id}>
                    {r.ruleSet.name}
                  </option>
                ))}
              </optgroup>
              {(ruleSets.some((r) => !r.builtin) || embedded) && (
                <optgroup label="Yours">
                  {ruleSets.filter((r) => !r.builtin).map((r) => (
                    <option key={r.ruleSet.id} value={r.ruleSet.id}>
                      {r.ruleSet.name}
                    </option>
                  ))}
                  {embedded && embedded.tilingId === tiling.id && !ruleSets.some((r) => r.ruleSet.id === embedded.id) && (
                    <option value={embedded.id}>{embedded.name} (from link)</option>
                  )}
                </optgroup>
              )}
            </select>
          </label>
          <p className="hint">{tiling.description}</p>
          <div className="row">
            <a className="button" href={hashFor('build', { t: tiling.id, rs: ruleSet.id })}>
              Edit in builder
            </a>
            {embedded && embedded.id === ruleSet.id && !isUserRuleSet(embedded.id) && (
              <button
                type="button"
                onClick={() => {
                  const saved = saveRuleSetAsNew(embedded);
                  setEmbedded(null);
                  setRuleSetId(saved.id);
                }}
              >
                Save to my rule sets
              </button>
            )}
          </div>
        </section>

        <section>
          <h2>Patch</h2>
          <label className="field">
            <span>
              Level <b>{level}</b> <small>({instances.length.toLocaleString()} tiles)</small>
            </span>
            <input type="range" min={0} max={tiling.maxLevel} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
          </label>
          {tiling.roots.length > 1 && (
            <label className="field">
              <span>Grow from</span>
              <select value={root} onChange={(e) => setRoot(e.target.value)}>
                {tiling.roots.map((r) => (
                  <option key={r} value={r}>
                    {tiling.prototiles.find((q) => q.id === r)?.name ?? r}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="checks">
            <label>
              <input type="checkbox" checked={showTiles} onChange={(e) => setShowTiles(e.target.checked)} /> Tiles
            </label>
            <label>
              <input type="checkbox" checked={showClassEdges} onChange={(e) => setShowClassEdges(e.target.checked)} /> Selected edges
            </label>
            <label>
              Line <input type="range" min={0.5} max={3} step={0.25} value={lineWidth} onChange={(e) => setLineWidth(Number(e.target.value))} />
            </label>
          </div>
        </section>

        <section>
          <h2>Edge selection</h2>
          <p className="hint">Pick which classes carry a line. A tile with an odd number of crossings can't pair them all and leaves a tail.</p>
          <div className="chips">
            {classes.map((c) => (
              <button
                type="button"
                key={c}
                className={`chip${selection.has(c) ? ' on' : ''}`}
                style={{ ['--chip' as string]: classColor(c) }}
                onClick={() => toggleClass(c)}
                aria-pressed={selection.has(c)}
              >
                {className(ruleSet, c)}
              </button>
            ))}
          </div>
          <p className={`status ${isTailFree ? 'good' : 'bad'}`}>
            {isTailFree ? 'Tail-free: every tile has an even number of crossings.' : `Odd crossings on ${circuits.oddTypes.join(', ')}.`}
          </p>
          <details open={parity.count <= 64}>
            <summary>
              {parity.count.toLocaleString()} tail-free selection{parity.count === 1 ? '' : 's'}
              {parity.truncated ? ` (showing ${parity.selections.length})` : ''}
            </summary>
            <div className="chips small">
              {parity.selections.map((s) => {
                const key = s.map((c) => className(ruleSet, c)).join(ruleSet.classNames ? ',' : '') || '∅';
                const on = s.length === selection.size && s.every((c) => selection.has(c));
                return (
                  <button type="button" key={key} className={`chip plain${on ? ' on' : ''}`} onClick={() => setSelection(new Set(s))}>
                    {key}
                  </button>
                );
              })}
            </div>
          </details>
        </section>

        <section>
          <h2>Combination</h2>
          <p className="hint">
            Each tile joins its crossings in pairs without crossing itself. {totalCombos.toLocaleString()} combination{totalCombos === 1 ? '' : 's'} for this selection.
          </p>
          <div className="glyph-grid">
            {tiling.prototiles.map((q) => {
              const n = counts[q.id];
              const choices = n > MAX_ENUMERATED_CROSSINGS ? 1 : choiceCount(n);
              return (
                <div className="glyph-card" key={q.id}>
                  <TileGlyph tiling={tiling} type={q.id} ruleSet={ruleSet} selection={selection} comboIndex={combo[q.id] ?? 0} size={84} />
                  <div className="glyph-name">{q.name}</div>
                  {n % 2 === 1 ? (
                    <div className="glyph-ctl bad">{n} · odd</div>
                  ) : choices > 1 ? (
                    <div className="glyph-ctl">
                      <button type="button" onClick={() => stepCombo(q.id, -1)} aria-label={`Previous pairing for ${q.name}`}>
                        ‹
                      </button>
                      <span>
                        {(combo[q.id] ?? 0) % choices}/{choices}
                      </span>
                      <button type="button" onClick={() => stepCombo(q.id, 1)} aria-label={`Next pairing for ${q.name}`}>
                        ›
                      </button>
                    </div>
                  ) : (
                    <div className="glyph-ctl muted">{n === 0 ? 'no lines' : 'one way'}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="row">
            <button type="button" onClick={randomCombo}>
              Random
            </button>
            <button type="button" onClick={() => setCombo({})}>
              Reset
            </button>
          </div>
          <label className="field">
            <span>Share string</span>
            <input
              className="mono"
              value={shareDraft ?? share}
              onChange={(e) => setShareDraft(e.target.value)}
              onBlur={() => shareDraft !== null && applyShare(shareDraft)}
              onKeyDown={(e) => e.key === 'Enter' && applyShare((e.target as HTMLInputElement).value)}
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={copyLink}>
            {copied ? 'Link copied' : 'Copy link to this view'}
          </button>
        </section>

        <Survey tiling={tiling} ruleSet={ruleSet} selection={selection} counts={counts} onPick={setCombo} />
      </aside>

      <main className="stage">
        <PatchCanvas
          tiling={tiling}
          instances={instances}
          ruleSet={ruleSet}
          circuits={circuits}
          showTiles={showTiles}
          classEdges={showClassEdges ? selection : null}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          lineWidth={lineWidth}
        />
        <div className="stats">
          <span>
            <b>{circuits.circuits.toLocaleString()}</b> circuits
          </span>
          <span>
            <b>{circuits.openLines.toLocaleString()}</b> open lines
          </span>
          <span className={circuits.tails ? 'bad' : ''}>
            <b>{circuits.tails.toLocaleString()}</b> with tails
          </span>
          <span>
            <b>{circuits.chords.length.toLocaleString()}</b> segments
          </span>
          {lengths.length > 0 && (
            <span className="lengths">
              {lengths.slice(0, 14).map(([len, k]) => {
                const pi = circuits.paths.findIndex((q) => q.closed && q.chords.length === len);
                return (
                  <button type="button" key={len} className="len" style={{ ['--chip' as string]: colors[pi] }} onClick={() => setSelectedPath(pi)} title={`${k} circuit(s) of length ${len}`}>
                    {len}×{k}
                  </button>
                );
              })}
              {lengths.length > 14 && <small>+{lengths.length - 14} more lengths</small>}
            </span>
          )}
          {sel && (
            <span className="picked">
              Picked: {sel.closed ? 'circuit' : sel.ends.includes('tail') ? 'line with a tail' : 'open line (leaves the patch)'}, {sel.chords.length} segments
            </span>
          )}
        </div>
        <p className="stage-hint">Drag to pan, scroll or pinch to zoom, click a line to pick it out.</p>
      </main>
    </div>
  );
}

interface SurveyProps {
  readonly tiling: Tiling;
  readonly ruleSet: RuleSet;
  readonly selection: ReadonlySet<number>;
  readonly counts: Record<string, number>;
  readonly onPick: (combo: Record<string, number>) => void;
}

interface SurveyRow {
  readonly combo: Record<string, number>;
  readonly code: string;
  readonly circuits: number;
  readonly open: number;
  readonly longest: number;
  readonly distinct: number;
}

const SURVEY_LIMIT = 2000;

/** Run every combination of the current selection on a small patch and compare. */
function Survey({ tiling, ruleSet, selection, counts, onPick }: SurveyProps) {
  const [rows, setRows] = useState<SurveyRow[] | null>(null);
  const [progress, setProgress] = useState(0);
  const [sortKey, setSortKey] = useState<keyof SurveyRow>('open');
  const cancel = useRef(0);
  const choiceTypes = tiling.prototiles.map((q) => q.id).filter((t) => counts[t] <= MAX_ENUMERATED_CROSSINGS && choiceCount(counts[t]) > 1);
  const total = choiceTypes.reduce((a, t) => a * choiceCount(counts[t]), 1);
  const surveyLevel = Math.max(1, tiling.defaultLevel - 1);
  const odd = tiling.prototiles.some((q) => counts[q.id] % 2 === 1);

  useEffect(() => {
    cancel.current++;
    setRows(null);
    setProgress(0);
  }, [tiling, ruleSet, selection]);

  const run = useCallback(() => {
    const token = ++cancel.current;
    const instances = tiling.generate(surveyLevel, tiling.defaultRoot);
    const adjacency = computeAdjacency(tiling, instances);
    const types = tiling.prototiles.map((q) => q.id);
    const out: SurveyRow[] = [];
    let i = 0;
    const n = Math.min(total, SURVEY_LIMIT);
    const step = () => {
      if (token !== cancel.current) return;
      const until = Math.min(n, i + 20);
      for (; i < until; i++) {
        const combo: Record<string, number> = {};
        let k = i;
        for (const t of choiceTypes) {
          const c = choiceCount(counts[t]);
          combo[t] = k % c;
          k = Math.floor(k / c);
        }
        const r = computeCircuits({ tiling, ruleSet, instances, selection, combo, adjacency });
        const lens = [...r.circuitLengths.keys()];
        out.push({
          combo,
          code: encodeShare(selection, combo, types).split('-')[1],
          circuits: r.circuits,
          open: r.openLines,
          longest: lens.length ? Math.max(...lens) : 0,
          distinct: lens.length,
        });
      }
      setProgress(i / n);
      if (i < n) setTimeout(step, 0);
      else setRows([...out]);
    };
    step();
  }, [tiling, ruleSet, selection, counts, choiceTypes, total, surveyLevel]);

  const sorted = rows ? [...rows].sort((a, b) => (typeof a[sortKey] === 'number' ? (b[sortKey] as number) - (a[sortKey] as number) : 0)) : null;

  return (
    <section>
      <h2>Survey</h2>
      <p className="hint">
        Try {total > SURVEY_LIMIT ? `the first ${SURVEY_LIMIT.toLocaleString()} of ${total.toLocaleString()}` : `all ${total.toLocaleString()}`} combinations on a level-{surveyLevel} patch and compare them.
      </p>
      {odd ? (
        <p className="hint">Pick a tail-free selection first.</p>
      ) : (
        <button type="button" onClick={run} disabled={progress > 0 && progress < 1}>
          {progress > 0 && progress < 1 ? `Running… ${Math.round(progress * 100)}%` : rows ? 'Run again' : 'Run survey'}
        </button>
      )}
      {sorted && (
        <div className="survey">
          <table>
            <thead>
              <tr>
                <th>Combo</th>
                {(['circuits', 'distinct', 'longest', 'open'] as const).map((k) => (
                  <th key={k}>
                    <button type="button" className={`linkish${sortKey === k ? ' on' : ''}`} onClick={() => setSortKey(k)}>
                      {k === 'distinct' ? 'lengths' : k}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 300).map((r) => (
                <tr key={r.code} onClick={() => onPick(r.combo)}>
                  <td className="mono">{r.code}</td>
                  <td>{r.circuits}</td>
                  <td>{r.distinct}</td>
                  <td>{r.longest}</td>
                  <td>{r.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Click a row to load it. “open” counts lines that leave the patch: lots of them hint at infinite lines.</p>
        </div>
      )}
    </section>
  );
}
