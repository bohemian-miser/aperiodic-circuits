/**
 * The circuits infinite mode has found, kept by where they are on the plane,
 * as the Spectre map keeps its found circuits: a circuit found once stays
 * coloured when the view moves and the patch regrown round it no longer holds
 * all of it (so it would trace as an open line), when the view holds too many
 * tiles to trace, and while a chase is running.
 *
 * Chords are named by their Bézier control point, which no other chord
 * shares and which comes out the same however the tile was reached.
 */

import type { Pt } from './geom';
import { qkey } from './polygon';
import type { CircuitResult } from './circuits';

/** Most chords held; past it the circuits found longest ago are let go. */
export const MAX_INK_CHORDS = 400_000;

const chordKey = (c: Pt) => qkey(c, 1e3);

export class CircuitInk {
  /** Chord -> length of the circuit it is on. */
  private readonly lengthOf = new Map<string, number>();
  /** Chord -> the circuit that last set it (a circuit can be kept twice, as a chase held part of it and whole). */
  private readonly owner = new Map<string, string>();
  /** Circuits by identity (a chord key and the length), oldest first, with their chord keys. */
  private readonly circuits = new Map<string, readonly string[]>();
  /** Bumped whenever something new is kept. */
  version = 0;

  get size(): number {
    return this.lengthOf.size;
  }

  /** The length of the circuit through this chord, if one has been found. */
  length(ch: { readonly c: Pt }): number | undefined {
    return this.lengthOf.size ? this.lengthOf.get(chordKey(ch.c)) : undefined;
  }

  /** Keep every closed circuit of a traced patch. */
  remember(r: CircuitResult): void {
    for (const p of r.paths) if (p.closed) this.keep(p.chords.map((i) => r.chords[i]), p.chords.length);
  }

  /** Keep one circuit of `length` chords (all of it, or as much as is held). */
  keep(chords: readonly { readonly c: Pt }[], length: number): void {
    if (chords.length === 0) return;
    const keys = chords.map((ch) => chordKey(ch.c));
    let first = keys[0];
    for (const k of keys) if (k < first) first = k;
    const id = `${first}|${length}`;
    const had = this.circuits.get(id);
    if (had && had.length >= keys.length) {
      // Seen again: it moves to the back of the queue to be let go.
      this.circuits.delete(id);
      this.circuits.set(id, had);
      return;
    }
    if (had) this.circuits.delete(id);
    this.circuits.set(id, keys);
    for (const k of keys) {
      this.lengthOf.set(k, length);
      this.owner.set(k, id);
    }
    this.version++;
    for (const [old, ks] of this.circuits) {
      if (this.lengthOf.size <= MAX_INK_CHORDS || old === id) break;
      this.circuits.delete(old);
      for (const k of ks) {
        if (this.owner.get(k) !== old) continue;
        this.lengthOf.delete(k);
        this.owner.delete(k);
      }
    }
  }
}
