import { describe, expect, it } from 'vitest';
import { computeCircuits } from '../circuits';
import { halfAt, morphChords } from '../morph';
import { derivedRuleSet } from '../ruleset';
import { hexTiling } from '../tilings/spectre';

describe('pairing morph', () => {
  const t = hexTiling;
  const rs = derivedRuleSet(t, 'seams');
  const selection = new Set(rs.seams[t.prototiles[0].id].map((s) => s.cls));
  const instances = t.generate(1, t.defaultRoot);
  const run = (k: number) => computeCircuits({ tiling: t, ruleSet: rs, instances, selection, combo: { [t.prototiles[0].id]: k } });

  it('swings each crossing from its old partner to its new one', () => {
    const a = run(0);
    const b = run(1);
    const m = morphChords(a.chords, b.chords, (ch) => ch.inst)!;
    expect(m).not.toBeNull();
    expect(m.moving.length).toBeGreaterThan(0);
    expect(m.still.length + m.moving.length / 2).toBe(b.chords.length);
    for (const h of m.moving) {
      // Ends stay on the seam; at the end each half meets its new chord's middle.
      const ch = b.chords[h.chord];
      expect([ch.a, ch.b]).toContainEqual(h.e);
      const end = halfAt(h, 1);
      const mid = { x: (ch.a.x + 2 * ch.c.x + ch.b.x) / 4, y: (ch.a.y + 2 * ch.c.y + ch.b.y) / 4 };
      expect(end.m.x).toBeCloseTo(mid.x);
      expect(end.m.y).toBeCloseTo(mid.y);
    }
  });

  it('leaves an unchanged pairing still', () => {
    const a = run(0);
    const m = morphChords(a.chords, run(0).chords, (ch) => ch.inst)!;
    expect(m.moving).toEqual([]);
  });
});
