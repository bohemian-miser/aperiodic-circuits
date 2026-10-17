import { describe, expect, it } from 'vitest';
import { computeCircuits } from '../circuits';
import { halfAt, morphChords } from '../morph';
import { derivedRuleSet } from '../ruleset';
import { hexTiling } from '../tilings/spectre';
import { mixColor, toRgb } from '../../colors';

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
    m.still.forEach((i, k) => expect(a.chords[m.stillFrom[k]]).toEqual(b.chords[i]));
    for (const h of m.moving) {
      // Each half swings away from the old chord that met its seam point.
      expect([a.chords[h.from].a, a.chords[h.from].b]).toContainEqual(h.e);
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

describe('colour blending', () => {
  it('reads our colours and mixes them in RGB', () => {
    expect(toRgb('#6f86b0')).toEqual([0x6f, 0x86, 0xb0]);
    expect(toRgb('hsl(0 100% 50%)').map(Math.round)).toEqual([255, 0, 0]);
    expect(toRgb('hsl(240 100% 50%)').map(Math.round)).toEqual([0, 0, 255]);
    expect(mixColor([255, 0, 0], [0, 0, 255], 0.5)).toBe('rgb(128 0 128)');
    expect(mixColor([255, 0, 0], [0, 0, 255], 0)).toBe('rgb(255 0 0)');
  });
});
