/**
 * Where rule sets come from: the built-in ones each tiling ships with (and
 * the ones derived from its adjacency), plus the user's own, kept in
 * localStorage. Custom tilings (refined or imported) are kept the same way.
 */

import { derivedRuleSet, type RuleSet } from './core/ruleset';
import type { Tiling, TilingSpec } from './core/tiling';
import { allTilings, getTiling, registerCustomTiling, validateTilingSpec } from './core/tilings';

const RS_KEY = 'aperiodic-circuits:rulesets';
const TILING_KEY = 'aperiodic-circuits:tilings';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private window etc.): keep working in memory */
  }
}

let userRuleSets: RuleSet[] = [];
let userSpecs: TilingSpec[] = [];
const listeners = new Set<() => void>();

export function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function emit(): void {
  for (const f of listeners) f();
}

let loaded = false;
export function loadPersisted(): void {
  if (loaded) return;
  loaded = true;
  userSpecs = readJson<TilingSpec[]>(TILING_KEY, []).filter((s) => validateTilingSpec(s).length === 0);
  for (const s of userSpecs) {
    try {
      if (!getTiling(s.id)) registerCustomTiling(s);
    } catch {
      /* skip a broken spec rather than break the app */
    }
  }
  userRuleSets = readJson<RuleSet[]>(RS_KEY, []);
}

export interface RuleSetEntry {
  readonly ruleSet: RuleSet;
  readonly builtin: boolean;
  readonly description: string;
}

const builtinCache = new Map<string, RuleSetEntry[]>();

export function builtinRuleSets(t: Tiling): RuleSetEntry[] {
  const hit = builtinCache.get(t.id);
  if (hit) return hit;
  const out: RuleSetEntry[] = [];
  for (const p of t.presets ?? []) out.push({ ruleSet: p.build(t), builtin: true, description: p.description });
  out.push({
    ruleSet: derivedRuleSet(t, 'seams'),
    builtin: true,
    description: 'Worked out from the tiling: each run of edges against one neighbour is a seam, and seams that meet share a class. The finest consistent classes.',
  });
  const edges = derivedRuleSet(t, 'edges');
  if (JSON.stringify(edges.seams) !== JSON.stringify(out[out.length - 1].ruleSet.seams)) {
    out.push({ ruleSet: edges, builtin: true, description: 'Like the derived seams, but every edge is its own seam, so long seams carry several lines.' });
  }
  builtinCache.set(t.id, out);
  return out;
}

export function ruleSetsFor(tilingId: string): RuleSetEntry[] {
  const t = getTiling(tilingId);
  if (!t) return [];
  const mine = userRuleSets.filter((r) => r.tilingId === tilingId).map((ruleSet) => ({ ruleSet, builtin: false, description: ruleSet.notes ?? '' }));
  return [...builtinRuleSets(t), ...mine];
}

export function defaultRuleSet(t: Tiling): RuleSet {
  return builtinRuleSets(t)[0].ruleSet;
}

export function findRuleSet(id: string): RuleSet | undefined {
  const user = userRuleSets.find((r) => r.id === id);
  if (user) return user;
  const tilingId = id.split(':')[0];
  const t = getTiling(tilingId);
  return t ? builtinRuleSets(t).find((e) => e.ruleSet.id === id)?.ruleSet : undefined;
}

export function isUserRuleSet(id: string): boolean {
  return userRuleSets.some((r) => r.id === id);
}

function newId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Save (insert or replace). A rule set without a user id gets a fresh one. */
export function saveRuleSet(rs: RuleSet): RuleSet {
  const id = rs.id.startsWith('user-') ? rs.id : newId();
  const saved = { ...rs, id };
  const i = userRuleSets.findIndex((r) => r.id === id);
  if (i >= 0) userRuleSets[i] = saved;
  else userRuleSets.push(saved);
  writeJson(RS_KEY, userRuleSets);
  emit();
  return saved;
}

export function saveRuleSetAsNew(rs: RuleSet): RuleSet {
  return saveRuleSet({ ...rs, id: newId() });
}

export function deleteRuleSet(id: string): void {
  userRuleSets = userRuleSets.filter((r) => r.id !== id);
  writeJson(RS_KEY, userRuleSets);
  emit();
}

/** Register and persist a custom tiling. */
export function addTilingSpec(spec: TilingSpec): Tiling {
  const existing = getTiling(spec.id);
  if (existing) return existing;
  const t = registerCustomTiling(spec);
  userSpecs.push(spec);
  writeJson(TILING_KEY, userSpecs);
  emit();
  return t;
}

export function tilings(): Tiling[] {
  return allTilings();
}

// ---------------------------------------------------------------------------
// Portable bundles (export / import / share links)
// ---------------------------------------------------------------------------

export interface Bundle {
  readonly format: 'aperiodic-circuits/rule-set@1';
  readonly ruleSet: RuleSet;
  /** Present when the rule set's tiling isn't built in. */
  readonly tiling?: TilingSpec;
}

export function makeBundle(rs: RuleSet): Bundle {
  const t = getTiling(rs.tilingId);
  const isCustom = !!t?.spec && userSpecs.some((s) => s.id === t.id);
  return { format: 'aperiodic-circuits/rule-set@1', ruleSet: rs, tiling: isCustom ? t!.spec : undefined };
}

/** Load a bundle: registers its tiling if needed and returns its rule set (not yet saved). */
export function openBundle(b: Bundle): RuleSet {
  if (b.format !== 'aperiodic-circuits/rule-set@1' || !b.ruleSet?.tilingId || !b.ruleSet.seams) throw new Error('Not an Aperiodic Circuits rule set file');
  if (b.tiling) {
    const errs = validateTilingSpec(b.tiling);
    if (errs.length) throw new Error(`Bad tiling: ${errs.join('; ')}`);
    addTilingSpec(b.tiling);
  }
  if (!getTiling(b.ruleSet.tilingId)) throw new Error(`Unknown tiling "${b.ruleSet.tilingId}"`);
  return b.ruleSet;
}

export function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
