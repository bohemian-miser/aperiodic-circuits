/**
 * Share strings in the Spectre project's style: `<classes>-<digits>`, e.g.
 * `2578-0100101100`. Classes and digits are base 36; the digits are one per
 * prototile, in the tiling's order, each picking a non-crossing pairing.
 */

import { classChar, classFromChar } from './ruleset';

export function encodeShare(selection: Iterable<number>, combo: Readonly<Record<string, number>>, types: readonly string[]): string {
  const sel = [...selection].sort((a, b) => a - b).map(classChar).join('');
  const digits = types.map((t) => classChar(Math.min(35, combo[t] ?? 0))).join('');
  return `${sel}-${digits}`;
}

export function decodeShare(s: string, types: readonly string[]): { selection: number[]; combo: Record<string, number> } | null {
  const m = /^([0-9a-z]*)-([0-9a-z]*)$/i.exec(s.trim());
  if (!m) return null;
  const selection = [...new Set([...m[1]].map(classFromChar))].filter((c) => c >= 0).sort((a, b) => a - b);
  const combo: Record<string, number> = {};
  types.forEach((t, i) => {
    const d = i < m[2].length ? classFromChar(m[2][i]) : 0;
    combo[t] = Math.max(0, d);
  });
  return { selection, combo };
}
