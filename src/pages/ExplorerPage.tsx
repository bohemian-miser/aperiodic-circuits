import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeCircuits, type CircuitResult } from '../core/circuits';
import { choiceCount, MAX_ENUMERATED_CROSSINGS } from '../core/matchings';
import { analyzeParity, basisCoords, crossingCounts } from '../core/parity';
import { className, computeAdjacency, ruleSetClasses, type RuleSet } from '../core/ruleset';
import { decodeShare, encodeShare } from '../core/share';
import { getTiling } from '../core/tilings';
import { InfinitePlane, meanTileArea, supportsInfinite, type Rect } from '../core/infinite';
import { qkey } from '../core/polygon';
import { StrandChase, type ChaseStatus } from '../core/chase';
import type { Tiling } from '../core/tiling';
import { PatchCanvas, pathColors } from '../components/PatchCanvas';
import { TileEditor } from '../components/TileEditor';
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
  // The picked line is remembered by a point on it, so it survives the patch
  // being regrown (infinite mode regrows on every pan).
  const [pickedAt, setPickedAt] = useState<readonly string[] | null>(null);
  const [infiniteOn, setInfiniteOn] = useState(() => p.get('inf') === '1');
  const [seed, setSeed] = useState(() => Math.max(1, Number(p.get('seed')) || 1));
  const [viewRect, setViewRect] = useState<Rect>(INITIAL_VIEW);
  // What the plane was last grown over: the view plus a margin. A view that
  // still fits inside it (and isn't much smaller) doesn't regrow anything.
  const [grownRect, setGrownRect] = useState<Rect>(() => withMargin(INITIAL_VIEW));
  const onViewChange = useCallback((r: Rect) => {
    setViewRect(r);
    setGrownRect((g) => (covers(g, r) && area(g) < 4 * area(r) ? g : withMargin(r)));
  }, []);
  // The tile pictures in the quick controls: 0 big, 1 small, 2 hidden.
  const [tileSize, setTileSize] = useStoredNumber('quick-tiles', 0, (n) => n === 0 || n === 1 || n === 2);
  const [statsOpen, setStatsOpen] = useStoredFlag('stats-open', false);
  const [basisOpen, setBasisOpen] = useStoredFlag('quick-basis', false);
  // The tile magnified for drawing its pairing.
  const [editing, setEditing] = useState<string | null>(null);
  // The panels float over the field so it never moves when they change size.
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topHeight = useHeight(topRef);
  const bottomHeight = useHeight(bottomRef);
  const [showBackground, setShowBackground] = useStoredFlag('background', true);
  const [showTiles, setShowTiles] = useStoredFlag('tile-colours', true);
  const [rainbowLines, setRainbowLines] = useStoredFlag('rainbow-lines', true);
  const [showClassEdges, setShowClassEdges] = useState(false);
  const [lineWidth, setLineWidth] = useState(1);
  const [screenTiles, setScreenTiles] = useStoredNumber('infinite-screen-tiles', INFINITE_SCREEN_TILES, (n) => SCREEN_TILE_OPTIONS.includes(n));
  // Chasing a picked line (infinite mode), as on the Spectre project's map.
  const [chaseOn, setChaseOn] = useStoredFlag('chase', true);
  const [fullSpeed, setFullSpeed] = useStoredFlag('chase-full-speed', true);
  const [pace, setPace] = useStoredNumber('chase-pace', 24, (n) => n >= 1 && n <= 240);
  const [damping, setDamping] = useStoredNumber('chase-damping', 1, (n) => n >= MIN_DAMPING && n <= MAX_DAMPING);
  const [hold, setHold] = useStoredNumber('chase-hold', 0, (n) => n >= 0 && Number.isInteger(n));
  const [chase, setChase] = useState<StrandChase | null>(null);
  const [chaseInfo, setChaseInfo] = useState<{ steps: number; status: ChaseStatus } | null>(null);

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
  const coords = useMemo(() => basisCoords(parity, selection), [parity, selection]);
  const counts = useMemo(() => crossingCounts(tiling, ruleSet, selection), [tiling, ruleSet, selection]);
  const infinite = infiniteOn && supportsInfinite(tiling);
  const plane = useMemo(() => (infinite ? new InfinitePlane(tiling, root, seed) : null), [infinite, tiling, root, seed]);
  const instances = useMemo(() => {
    if (!plane) return tiling.generate(level, root);
    return plane.query(grownRect, Math.ceil(screenTiles * INFINITE_QUERY_FACTOR)).instances;
  }, [plane, tiling, level, root, grownRect, screenTiles]);
  const adjacency = useMemo(() => computeAdjacency(tiling, instances), [tiling, instances]);
  const circuits: CircuitResult = useMemo(
    () => computeCircuits({ tiling, ruleSet, instances, selection, combo, adjacency }),
    [tiling, ruleSet, instances, selection, combo, adjacency],
  );
  // Same tiles and crossings, so a new pairing animates on the canvas.
  const morphKey = useMemo(() => ({}), [tiling, ruleSet, instances, selection]);
  useEffect(() => setPickedAt(null), [tiling, ruleSet, root, seed, infinite]);
  useEffect(() => setEditing(null), [tiling, ruleSet]);
  // A chase belongs to one plane and one set of lines.
  useEffect(() => setChase(null), [plane, ruleSet, selection, combo, chaseOn]);
  useEffect(() => {
    if (chase) chase.hold = hold;
  }, [chase, hold]);
  useEffect(() => setChaseInfo(chase ? { steps: chase.steps, status: chase.status } : null), [chase]);
  const onChaseTick = useCallback(() => {
    if (chase) setChaseInfo({ steps: chase.steps, status: chase.status });
  }, [chase]);
  const selectedPath = useMemo(() => {
    if (!pickedAt) return null;
    const want = new Set(pickedAt);
    for (let i = 0; i < circuits.chords.length; i++) {
      const ch = circuits.chords[i];
      if (want.has(qkey(ch.a, 1e3)) || want.has(qkey(ch.b, 1e3))) return circuits.pathOfChord[i];
    }
    return null;
  }, [pickedAt, circuits]);
  // Remember points spread along the picked line, densest near the middle of
  // the view, so some of them are still inside the patch after the next pan
  // regrows it. When none are (panned well away), the pick waits, and comes
  // back if you return.
  useEffect(() => {
    if (!infinite || selectedPath === null) return;
    const chords = circuits.paths[selectedPath].chords;
    const cx = (viewRect.minX + viewRect.maxX) / 2;
    const cy = (viewRect.minY + viewRect.maxY) / 2;
    const byDist = [...chords].sort((i, j) => {
      const a = circuits.chords[i].a;
      const b = circuits.chords[j].a;
      return (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2);
    });
    const step = Math.max(1, Math.floor(chords.length / 32));
    const keys = new Set<string>();
    for (const ci of byDist.slice(0, 16)) keys.add(qkey(circuits.chords[ci].a, 1e3));
    for (let k = 0; k < chords.length; k += step) keys.add(qkey(circuits.chords[chords[k]].a, 1e3));
    const next = [...keys].sort();
    if (!pickedAt || next.join() !== [...pickedAt].sort().join()) setPickedAt(next);
  }, [infinite, selectedPath, circuits, viewRect, pickedAt]);

  const setSelectedPath = (pi: number | null, chord: number | null = null) => {
    if (plane && chaseOn) {
      // In infinite mode a click starts a chase from the chord clicked.
      const ch = chord === null ? undefined : circuits.chords[chord];
      const tile = ch && instances.find((i) => i.id === ch.inst);
      setChase(ch && tile ? new StrandChase(plane, tiling, ruleSet, selection, combo, ch, tile.xform, hold) : null);
      if (ch && tile) {
        setPickedAt(null);
        return;
      }
    }
    const first = pi === null ? undefined : circuits.paths[pi]?.chords[0];
    setPickedAt(first === undefined ? null : [qkey(circuits.chords[first].a, 1e3)]);
  };

  const share = encodeShare(selection, combo, types);
  const isTailFree = circuits.oddTypes.length === 0;

  // Keep the URL in step (without spamming history).
  useEffect(() => {
    const params: Record<string, string | number | undefined> = { t: tiling.id, rs: ruleSet.id, lv: level, root, s: share, inf: infinite ? 1 : undefined, seed: infinite && seed !== 1 ? seed : undefined };
    if (embedded && embedded.id === ruleSet.id) params.rsd = p.get('rsd') ?? undefined;
    replaceHash(hashFor('explore', params));
  }, [tiling.id, ruleSet.id, level, root, share, embedded, p, infinite, seed]);

  const toggleClass = (c: number) => {
    const next = new Set(selection);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setSelection(next);
  };
  // XOR a whole basis group in: shared classes cancel, so parity is kept.
  const toggleGroup = (g: readonly number[]) => {
    const next = new Set(selection);
    for (const c of g) {
      if (next.has(c)) next.delete(c);
      else next.add(c);
    }
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
  // Combinations in order, as one mixed-radix number: the first type with a
  // choice is the lowest digit, the same order the survey runs them in.
  const choiceTypes = types.filter((t) => counts[t] <= MAX_ENUMERATED_CROSSINGS && choiceCount(counts[t]) > 1);
  let comboIndex = 0;
  for (let i = choiceTypes.length - 1; i >= 0; i--) {
    const c = choiceCount(counts[choiceTypes[i]]);
    comboIndex = comboIndex * c + ((combo[choiceTypes[i]] ?? 0) % c);
  }
  const stepAll = (d: number) => {
    if (totalCombos <= 1) return;
    let k = (((comboIndex + d) % totalCombos) + totalCombos) % totalCombos;
    const next: Record<string, number> = {};
    for (const t of choiceTypes) {
      const c = choiceCount(counts[t]);
      next[t] = k % c;
      k = Math.floor(k / c);
    }
    setCombo(next);
  };
  const quick = (
    <QuickControls
      className="quick"
      tiling={tiling}
      ruleSet={ruleSet}
      classes={classes}
      selection={selection}
      onToggle={toggleClass}
      tailFree={isTailFree}
      oddTypes={circuits.oddTypes}
      counts={counts}
      combo={combo}
      onStepTile={stepCombo}
      tileSize={tileSize}
      onTileSize={setTileSize}
      onOpenTile={setEditing}
      basis={parity.basis}
      basisCoords={coords}
      onToggleGroup={toggleGroup}
      basisOpen={basisOpen}
      onBasisOpen={setBasisOpen}
      index={comboIndex}
      total={totalCombos}
      onRandom={randomCombo}
      onStep={stepAll}
    />
  );

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
    if (infinite) {
      params.inf = 1;
      if (seed !== 1) params.seed = seed;
    }
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
          <div className="row">
            <button type="button" className={!infinite ? 'on' : ''} onClick={() => setInfiniteOn(false)} aria-pressed={!infinite}>
              Supertile
            </button>
            <button
              type="button"
              className={infinite ? 'on' : ''}
              onClick={() => setInfiniteOn(true)}
              aria-pressed={infinite}
              disabled={!supportsInfinite(tiling)}
              title={supportsInfinite(tiling) ? 'The whole plane, grown around the view as you pan' : 'This tiling has no substitution tree to grow from'}
            >
              Infinite
            </button>
          </div>
          {infinite ? (
            <>
              <p className="hint">
                The whole plane, grown around the view as you pan ({instances.length.toLocaleString()} tiles in view). {chaseOn ? 'Click a line and the camera chases it across the plane.' : 'Click a line to trace it: it stays picked, in a rainbow, as you follow it.'}
              </p>
              <div className="row">
                <label className="field inline">
                  <span>Seed</span>
                  <input type="number" min={1} value={seed} onChange={(e) => setSeed(Math.max(1, Math.floor(Number(e.target.value)) || 1))} style={{ width: 90 }} />
                </label>
                <button type="button" onClick={() => setSeed(1 + Math.floor(Math.random() * 1e6))} title="A different tiling of the plane">
                  New tiling
                </button>
              </div>
              <div className="checks">
                <label title="Click a line and the camera chases it across the plane. Dragging takes the camera back until you let go, and for good once the line has closed or hit a tail; scroll-zoom stays yours.">
                  <input type="checkbox" checked={chaseOn} onChange={(e) => setChaseOn(e.target.checked)} /> Chase the picked line
                </label>
                <label title="Walk the line as fast as the camera can follow">
                  <input type="checkbox" checked={fullSpeed} disabled={!chaseOn} onChange={(e) => setFullSpeed(e.target.checked)} /> Full speed
                </label>
              </div>
              {chaseOn && (
                <>
                  {!fullSpeed && (
                    <label className="field">
                      <span>
                        Pace <small>{pace} tiles/s</small>
                      </span>
                      <input type="range" min={1} max={240} step={1} value={pace} onChange={(e) => setPace(Number(e.target.value))} />
                    </label>
                  )}
                  <label className="field" title="How floaty the camera is: 1× is the Spectre map's feel">
                    <span>
                      Damping <small>{damping < 1 ? damping.toFixed(2) : damping.toFixed(1)}×</small>
                    </span>
                    {/* Log scale: the everyday settings all sit under 3×. */}
                    <input
                      type="range"
                      min={Math.log(MIN_DAMPING)}
                      max={Math.log(MAX_DAMPING)}
                      step="any"
                      value={Math.log(damping)}
                      onChange={(e) => setDamping(Number(Math.exp(Number(e.target.value)).toPrecision(2)))}
                    />
                  </label>
                  <label className="field inline" title="How many tiles of trail to keep behind the head. 0 keeps all of it (up to a million).">
                    <span>Hold</span>
                    <input
                      type="number"
                      min={0}
                      step={500}
                      value={hold}
                      onChange={(e) => setHold(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
                      style={{ width: 90 }}
                    />
                    <small>tiles of trail, 0 = all</small>
                  </label>
                  {chaseInfo && (
                    <div className="row">
                      <span className="hint">{describeChase(chaseInfo)}</span>
                      <button type="button" onClick={() => setChase(null)}>
                        Stop
                      </button>
                    </div>
                  )}
                </>
              )}
              <details>
                <summary>Advanced</summary>
                <label className="field" title="How far you can zoom out. Every pan regrows what's on screen, so more tiles means slower panning.">
                  <span>Zoom-out limit</span>
                  <select value={screenTiles} onChange={(e) => setScreenTiles(Number(e.target.value))}>
                    {SCREEN_TILE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        about {n.toLocaleString()} tiles on screen{n === INFINITE_SCREEN_TILES ? ' (default)' : n > INFINITE_SCREEN_TILES ? ' (slow)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </details>
            </>
          ) : (
            <label className="field">
              <span>
                Level <b>{level}</b> <small>({instances.length.toLocaleString()} tiles)</small>
              </span>
              <input type="range" min={0} max={tiling.maxLevel} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
            </label>
          )}
          {tiling.roots.length > 1 && (
            <label className="field">
              <span>{infinite ? 'Tile at the centre' : 'Grow from'}</span>
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
            <label title="The tiling behind the lines: tile colours and outlines">
              <input type="checkbox" checked={showBackground} onChange={(e) => setShowBackground(e.target.checked)} /> Background
            </label>
            <label>
              <input type="checkbox" checked={showTiles} disabled={!showBackground} onChange={(e) => setShowTiles(e.target.checked)} /> Tile colours
            </label>
            <label title="Colour open lines red to violet along their length">
              <input type="checkbox" checked={rainbowLines} onChange={(e) => setRainbowLines(e.target.checked)} /> Rainbow lines
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
          {parity.basis.length > 0 && (
            <>
              <p className="hint">
                Basis groups: tap one to flip all its edges together. Any mix of groups is tail-free, and each of the{' '}
                {parity.count.toLocaleString()} tail-free selections is exactly one mix.
              </p>
              <div className="chips small">
                {parity.basis.map((g, i) => {
                  const label = g.map((c) => className(ruleSet, c)).join(ruleSet.classNames ? ',' : '·');
                  const on = coords?.[i] ?? false;
                  return (
                    <button type="button" key={label} className={`chip plain${on ? ' on' : ''}`} onClick={() => toggleGroup(g)} aria-pressed={on}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
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
                        {((combo[q.id] ?? 0) % choices) + 1}/{choices}
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
            <button type="button" onClick={() => stepAll(1)} disabled={totalCombos <= 1}>
              Next
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
        <div className="stage-top" ref={topRef}>
          <p className="stage-hint">
            Drag to pan, scroll or pinch to zoom, click a line to {infinite && chaseOn ? 'chase it' : 'pick it out'}.
          </p>
        </div>
        {editing && (
          <TileEditor
            key={editing}
            tiling={tiling}
            ruleSet={ruleSet}
            selection={selection}
            type={editing}
            index={combo[editing] ?? 0}
            onSetIndex={(i) => setCombo({ ...combo, [editing]: i })}
            onClose={() => setEditing(null)}
          />
        )}
        <PatchCanvas
          tiling={tiling}
          instances={instances}
          ruleSet={ruleSet}
          circuits={circuits}
          showTiles={showBackground && showTiles}
          showOutlines={showBackground}
          rainbowLines={rainbowLines}
          classEdges={showClassEdges ? selection : null}
          selectedPath={chase ? null : selectedPath}
          onSelectPath={setSelectedPath}
          chase={chase}
          chasePace={fullSpeed ? null : pace}
          chaseDamping={damping}
          onChaseTick={onChaseTick}
          lineWidth={lineWidth}
          fitKey={infinite ? plane : undefined}
          fitBounds={infinite ? INITIAL_VIEW : undefined}
          onViewChange={infinite ? onViewChange : undefined}
          zoomLimit={infinite ? { tileArea: meanTileArea(tiling), maxTiles: screenTiles } : undefined}
          selectedRainbow={infinite}
          insets={topHeight === null || bottomHeight === null ? undefined : { top: topHeight, bottom: bottomHeight }}
          morphKey={morphKey}
        />
        <div className="stage-bottom" ref={bottomRef}>
        {quick}
        <div className="stats">
          <span>
            <b>{circuits.circuits.toLocaleString()}</b> circuits
          </span>
          <span>
            <b>{circuits.openLines.toLocaleString()}</b> open
          </span>
          {circuits.tails > 0 && (
            <span className="bad">
              <b>{circuits.tails.toLocaleString()}</b> with tails
            </span>
          )}
          {statsOpen && (
            <span>
              <b>{circuits.chords.length.toLocaleString()}</b> segments
            </span>
          )}
          {statsOpen && lengths.length > 0 && (
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
          {chaseInfo && <span className="picked">{describeChase(chaseInfo)}</span>}
          {sel && !chaseInfo && (
            <span className="picked">
              Picked: {sel.closed ? 'circuit' : sel.ends.includes('tail') ? 'line with a tail' : infinite ? 'line, runs off screen' : 'open line (leaves the patch)'}, {sel.chords.length} segments
              {infinite && !sel.closed ? ' so far' : ''}
            </span>
          )}
          <button type="button" className="stats-more" onClick={() => setStatsOpen(!statsOpen)} aria-expanded={statsOpen}>
            {statsOpen ? 'Less ▴' : 'More ▾'}
          </button>
        </div>
        </div>
      </main>
    </div>
  );
}

/** Infinite mode starts looking at this window round the centre tile. */
const INITIAL_VIEW: Rect = { minX: -16, minY: -16, maxX: 16, maxY: 16 };
/** By default zoom-out stops at about this many tiles on screen (Advanced can change it)… */
const INFINITE_SCREEN_TILES = 50_000;
const SCREEN_TILE_OPTIONS = [10_000, 25_000, 50_000, 100_000, 200_000];
/** …and a query returns at most this multiple of it (the screen plus a 15% margin each side). */
const INFINITE_QUERY_FACTOR = 1.75;
const MIN_DAMPING = 0.25;
const MAX_DAMPING = 30;

function withMargin(r: Rect): Rect {
  // Grow a margin past the screen so a short pan doesn't show an edge.
  const w = (r.maxX - r.minX) * 0.15;
  const h = (r.maxY - r.minY) * 0.15;
  return { minX: r.minX - w, minY: r.minY - h, maxX: r.maxX + w, maxY: r.maxY + h };
}

function covers(outer: Rect, inner: Rect): boolean {
  return outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
}

function area(r: Rect): number {
  return (r.maxX - r.minX) * (r.maxY - r.minY);
}

function describeChase(c: { steps: number; status: ChaseStatus }): string {
  const n = c.steps.toLocaleString();
  return c.status === 'closed' ? `Chased a closed circuit: ${n} tiles round` : c.status === 'tail' ? `Chase ended in a tail after ${n} tiles` : `Chasing… ${n} tiles`;
}

const TILE_SIZE_NAMES = ['big', 'small', 'off'];

interface QuickProps {
  readonly className: string;
  readonly tiling: Tiling;
  readonly ruleSet: RuleSet;
  readonly classes: readonly number[];
  readonly selection: ReadonlySet<number>;
  readonly onToggle: (c: number) => void;
  readonly tailFree: boolean;
  readonly oddTypes: readonly string[];
  readonly counts: Record<string, number>;
  readonly combo: Record<string, number>;
  readonly onStepTile: (type: string, d: number) => void;
  readonly tileSize: number;
  readonly onTileSize: (n: number) => void;
  readonly onOpenTile: (type: string) => void;
  readonly basis: readonly (readonly number[])[];
  readonly basisCoords: readonly boolean[] | null;
  readonly onToggleGroup: (g: readonly number[]) => void;
  readonly basisOpen: boolean;
  readonly onBasisOpen: (open: boolean) => void;
  readonly index: number;
  readonly total: number;
  readonly onRandom: () => void;
  readonly onStep: (d: number) => void;
}

/**
 * The edge picker, each tile's pairing, and a stepper through every pairing
 * of the picked edges, kept by the field so you can watch it change.
 */
function QuickControls(props: QuickProps) {
  const { className: cls, tiling, ruleSet, classes, selection, onToggle, tailFree, oddTypes, counts, combo, onStepTile, tileSize, onTileSize, onOpenTile, index, total, onRandom, onStep } = props;
  const { basis, basisCoords, onToggleGroup, basisOpen, onBasisOpen } = props;
  return (
    <div className={cls}>
      <div className={`quick-edges${classes.length > 12 ? ' many' : ''}`}>
        <span className="quick-label">Edges</span>
        <span className={`quick-dot ${tailFree ? 'good' : 'bad'}`} title={tailFree ? 'Tail-free' : `Odd crossings on ${oddTypes.join(', ')}`} />
        {basis.length > 0 && (
          <button
            type="button"
            className={`quick-toggle${basisOpen ? ' on' : ''}`}
            onClick={() => onBasisOpen(!basisOpen)}
            aria-expanded={basisOpen}
            title="Basis groups: flip a group's edges together and stay tail-free"
          >
            groups {basisOpen ? '▴' : '▾'}
          </button>
        )}
        <button
          type="button"
          className="quick-size"
          onClick={() => onTileSize((tileSize + 1) % 3)}
          title={`Tile pictures: ${TILE_SIZE_NAMES[tileSize]} (tap for ${TILE_SIZE_NAMES[(tileSize + 1) % 3]})`}
          aria-label={`Tile pictures: ${TILE_SIZE_NAMES[tileSize]}`}
        >
          <span className="long">Tiles: {TILE_SIZE_NAMES[tileSize]}</span>
          <span className="short">⬡{['L', 'S', '–'][tileSize]}</span>
        </button>
        {classes.map((c) => (
          <button
            type="button"
            key={c}
            className={`chip${selection.has(c) ? ' on' : ''}`}
            style={{ ['--chip' as string]: classColor(c) }}
            onClick={() => onToggle(c)}
            aria-pressed={selection.has(c)}
          >
            {className(ruleSet, c)}
          </button>
        ))}
      </div>
      {basisOpen && basis.length > 0 && (
        <div className={`quick-basis${basis.length > 8 ? ' many' : ''}`}>
          {basis.map((g, i) => {
            const label = g.map((c) => className(ruleSet, c)).join(ruleSet.classNames ? ',' : '·');
            const on = basisCoords?.[i] ?? false;
            return (
              <button type="button" key={label} className={`chip plain${on ? ' on' : ''}`} onClick={() => onToggleGroup(g)} aria-pressed={on}>
                {label}
              </button>
            );
          })}
        </div>
      )}
      {tileSize < 2 && (
        <div className={`quick-tiles${tileSize === 1 ? ' small' : ''}`}>
          {tiling.prototiles.map((q) => {
            const n = counts[q.id];
            const choices = n > MAX_ENUMERATED_CROSSINGS ? 1 : choiceCount(n);
            const varies = n % 2 === 0 && choices > 1;
            const kind = n % 2 === 1 ? 'odd' : n === 0 ? 'empty' : varies ? 'varies' : 'lines';
            // Big tiles open in the pairing editor; small ones just step their pairing.
            const open = tileSize === 0 ? n > 0 : varies;
            const onClick = () => (tileSize === 0 ? onOpenTile(q.id) : onStepTile(q.id, 1));
            const body = (
              <>
                <TileGlyph tiling={tiling} type={q.id} ruleSet={ruleSet} selection={selection} comboIndex={combo[q.id] ?? 0} size={tileSize === 1 ? 34 : 56} />
                <span className="quick-tile-name">{q.name}</span>
                {(varies || n % 2 === 1) && (
                  <span className="quick-tile-ctl">{n % 2 === 1 ? 'odd' : `${((combo[q.id] ?? 0) % choices) + 1}/${choices}`}</span>
                )}
              </>
            );
            return open ? (
              <button type="button" className={`quick-tile ${kind}`} key={q.id} title={tileSize === 0 ? `${q.name}: tap to draw its pairing` : `${q.name}: tap for its next pairing`} onClick={onClick}>
                {body}
              </button>
            ) : (
              <div className={`quick-tile ${kind}`} key={q.id} title={n === 0 ? `${q.name}: no lines` : q.name}>
                {body}
              </div>
            );
          })}
        </div>
      )}
      {total > 1 ? (
        <div className="quick-combo">
          <button type="button" onClick={() => onStep(-1)} aria-label="Previous pairing">
            ‹
          </button>
          <span className="quick-count" title={`Pairing ${(index + 1).toLocaleString()} of ${total.toLocaleString()}`}>
            Pairing
            <br />
            <b>
              {shortCount(index + 1)}/{shortCount(total)}
            </b>
          </span>
          <button type="button" onClick={() => onStep(1)}>
            Next pairing ›
          </button>
          <button type="button" className="primary" onClick={onRandom}>
            Random
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Counts that won't fit the stepper shrink to "156T". */
function shortCount(n: number): string {
  return n < 100_000 ? n.toLocaleString() : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
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

/** An element's height, kept up to date as it changes. */
function useHeight(ref: React.RefObject<HTMLElement | null>): number | null {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

/** A numeric setting, remembered in this browser if it passes `ok`. */
function useStoredNumber(name: string, initial: number, ok: (v: number) => boolean): [number, (v: number) => void] {
  const key = `aperiodic-circuits:view:${name}`;
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      const v = Number(raw);
      return raw !== null && Number.isFinite(v) && ok(v) ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: number) => {
    setValue(v);
    try {
      localStorage.setItem(key, String(v));
    } catch {
      /* private window: just don't remember */
    }
  };
  return [value, set];
}

/** A display toggle remembered in this browser. */
function useStoredFlag(name: string, initial: boolean): [boolean, (v: boolean) => void] {
  const key = `aperiodic-circuits:view:${name}`;
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* private window: just don't remember */
    }
  };
  return [value, set];
}
