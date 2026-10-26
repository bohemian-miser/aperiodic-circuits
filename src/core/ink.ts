/**
 * The circuits infinite mode has found, and the colour each length was given, kept by where they are on the plane,
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
  /** Circuit length -> its place in the ranked palette, given the first time it is seen and kept. */
  private readonly ranks = new Map<number, number>();
  /** Bumped whenever something new is kept. */
  version = 0;

  get size(): number {
    return this.lengthOf.size;
  }

  /** The length of the circuit through this chord, if one has been found. */
  length(ch: { readonly c: Pt }): number | undefined {
    return this.lengthOf.size ? this.lengthOf.get(chordKey(ch.c)) : undefined;
  }

  /**
   * A length's place in the ranked palette. The first patch ranks its lengths
   * in order, as the supertile view does; a length seen later takes the next
   * place. Either way it keeps it, so a circuit never changes colour.
   */
  rank(length: number): number {
    let r = this.ranks.get(length);
    if (r === undefined) {
      this.ranks.set(length, (r = this.ranks.size));
      this.version++;
    }
    return r;
  }

  /**
   * Keep every closed circuit of a traced patch. A view regrown round the
   * same ground holds mostly circuits found already, so each is first looked
   * up by one chord: one already held whole is only touched, not keyed again
   * chord by chord.
   */
  remember(r: CircuitResult): void {
    for (const len of [...r.circuitLengths.keys()].sort((a, b) => a - b)) this.rank(len);
    for (const p of r.paths) {
      if (!p.closed || p.chords.length === 0) continue;
      if (this.touch(r.chords[p.chords[0]], p.chords.length)) continue;
      this.keep(p.chords.map((i) => r.chords[i]), p.chords.length);
    }
  }

  /**
   * True if the circuit of `length` through this chord is already held whole,
   * moving it to the back of the queue to be let go.
   */
  private touch(ch: { readonly c: Pt }, length: number): boolean {
    const id = this.owner.get(chordKey(ch.c));
    const had = id === undefined ? undefined : this.circuits.get(id);
    if (!had || had.length < length || !id!.endsWith(`|${length}`)) return false;
    this.circuits.delete(id!);
    this.circuits.set(id!, had);
    return true;
  }

  /** Keep one circuit of `length` chords (all of it, or as much as is held). */
  keep(chords: readonly { readonly c: Pt }[], length: number): void {
    if (chords.length === 0) return;
    this.rank(length);
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
