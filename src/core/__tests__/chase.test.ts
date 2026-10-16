import { describe, expect, it } from 'vitest';
import { BUILTIN_TILINGS } from '../tilings';
import { InfinitePlane } from '../infinite';
import { computeCircuits } from '../circuits';
import { analyzeParity } from '../parity';
import { defaultRuleSet } from '../../store';
import { StrandChase } from '../chase';
import { qkey } from '../polygon';

describe('chasing a line', () => {
  it('walks the same line the patch traces, chord for chord', () => {
    for (const t of BUILTIN_TILINGS) {
      const rs = defaultRuleSet(t);
      const sel = new Set(analyzeParity(t, rs, 64).selections.find((s) => s.length > 0) ?? []);
      const plane = new InfinitePlane(t, t.defaultRoot);
      const { instances } = plane.query({ minX: -30, minY: -30, maxX: 30, maxY: 30 });
      const r = computeCircuits({ tiling: t, ruleSet: rs, instances, selection: sel, combo: {} });
      // The longest line on the patch, walked from its first chord.
      const path = [...r.paths].sort((p, q) => q.chords.length - p.chords.length)[0];
      expect(path.chords.length, t.id).toBeGreaterThan(2);
      const c0 = r.chords[path.chords[0]];
      const c1 = r.chords[path.chords[1]];
      // Orient the first chord so it leads into the second.
      const k = (p: { x: number; y: number }) => qkey(p, 1e3);
      const meets = k(c0.b) === k(c1.a) || k(c0.b) === k(c1.b);
      const first = meets ? c0 : { a: c0.b, b: c0.a, c: c0.c };
      const chase = new StrandChase(plane, t, rs, sel, {}, first, instances[c0.inst].xform);
      const n = Math.min(path.chords.length, 200);
      for (let i = 1; i < n; i++) expect(chase.step() || chase.status === 'closed', `${t.id} step ${i}`).toBe(true);
      for (let i = 0; i < n; i++) {
        const want = r.chords[path.chords[i]];
        const got = chase.chord(i);
        expect(new Set([k(got.a), k(got.b)]), `${t.id} chord ${i}`).toEqual(new Set([k(want.a), k(want.b)]));
      }
      if (path.closed && n === path.chords.length) expect(chase.status, t.id).toBe('closed');
    }
  });

  it('keeps going well past any patch, and the hold trims the trail', () => {
    const t = BUILTIN_TILINGS.find((x) => x.id === 'spectre')!;
    const rs = defaultRuleSet(t);
    const sel = new Set(analyzeParity(t, rs, 64).selections.find((s) => s.length > 0) ?? []);
    const plane = new InfinitePlane(t, t.defaultRoot);
    const { instances } = plane.query({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
    const r = computeCircuits({ tiling: t, ruleSet: rs, instances, selection: sel, combo: {} });
    const open = r.paths.find((p) => !p.closed && !p.ends.includes('tail'))!;
    const c = r.chords[open.chords[0]];
    const chase = new StrandChase(plane, t, rs, sel, {}, c, instances[c.inst].xform, 300);
    let i = 0;
    while (i < 3000 && chase.step()) i++;
    // Either it ran the distance, or it met a real end (the backward side of the line).
    if (chase.status === 'running') expect(chase.steps).toBe(3001);
    expect(chase.chords).toBeLessThanOrEqual(300 + 300 / 8 + 1);
    expect(chase.dropped + chase.chords).toBe(chase.steps);
    for (let j = 1; j < chase.count; j++) expect(chase.arc[j]).toBeGreaterThan(chase.arc[j - 1]);
  });
});
