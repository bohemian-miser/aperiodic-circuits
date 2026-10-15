import { hashFor } from '../route';

export function AboutPage() {
  return (
    <article className="prose">
      <h1>Aperiodic Circuits</h1>
      <p>
        Take an aperiodic tiling, mark some of its edges, and run a line through every marked edge. Inside each tile, join the lines coming in up in
        pairs. Then follow them: some close up into circuits, some run off forever, and some stop dead in a tail.
      </p>
      <p>
        This is the generalisation of the <a href="https://bohemian-miser.github.io/Spectre/">Spectre circuits</a> project. There, the edges of the
        Spectre's nine tile types come labelled with seam classes 0–8, and you pick a set of classes and a pairing per tile. Here the labels are yours
        to make.
      </p>

      <h2>The pieces</h2>
      <dl>
        <dt>Tiling</dt>
        <dd>
          A set of prototiles and a substitution rule that grows a patch of them: the Spectre and its hexagons, Penrose rhombs, the chair, or one you
          paste in as JSON.
        </dd>
        <dt>Seam</dt>
        <dd>A run of consecutive edges of a prototile that always meets one neighbour as a whole. One line crosses each active seam, at its middle.</dd>
        <dt>Rule set</dt>
        <dd>
          A labelling: which edges form seams, and which class each seam belongs to. A rule set is <em>consistent</em> when every seam meets a seam of
          the same class wherever it touches another tile, so the crossing points on both sides agree.
        </dd>
        <dt>Edge selection</dt>
        <dd>The classes that carry a line, written as a string of class ids such as <code>128</code>.</dd>
        <dt>Combination</dt>
        <dd>
          One digit per prototile picking which of its non-crossing pairings to use. A tile with 2k crossings has Catalan(k) of them: 1, 2, 5, 14, 42…
          The full share string is <code>selection-digits</code>, e.g. <code>128-010100000</code>.
        </dd>
      </dl>

      <h2>Building a substitution</h2>
      <p>
        The <a href={hashFor('lab')}>Substitution lab</a> is stage one. The Spectre is grown by one fixed arrangement of child supertiles, the same for
        every type; what differs is the table of which type fills which slot. The lab works the same way on a grid of hexagons or squares. Switch
        cells on to make the slots, then for each type paint a child type into every slot, turned and flipped as you like (or left empty, like the
        Spectre Gamma's missing child). An expansion map spaces out the next level's supertiles: it has to scale area by the number of slots, and the
        lab lists the ones that do, ticking those for which the slots are a complete set of residues (unturned children are then guaranteed to fit).
      </p>
      <p>
        Because every tile stays on the grid, "does the replacement work" has an exact answer, checked at levels 1–4: no two tiles on one cell, and no
        cell walled in without a tile. Turning or flipping a child usually breaks this a level or two later, when the child's own shape stops matching
        its slot. The lab also shows the substitution matrix, the growth per level, and whether it's primitive.
      </p>

      <h2>Numbering the edges</h2>
      <p>
        Stage two is the edge builder. Its <em>Help me number the edges</em> panel reports how many tile edges always meet the same neighbour
        edge. With only a few types almost none do, so only a couple of classes can be told apart. <em>Refine by slot</em> fixes that, the way the
        Spectre's nine types do. It then suggests numberings: greedy merges of the finest classes that keep as many tail-free selections as
        possible, or random merges. Each one is consistent by construction.
      </p>

      <h2>Making a rule set</h2>
      <p>
        In the <a href={hashFor('build')}>builder</a>, start from a tiling's derived labelling. It's worked out from the tiling itself: seams are runs of
        edges against one neighbour, and two seams share a class exactly when they meet somewhere. That is the finest consistent labelling: merging any of
        its classes keeps it consistent, splitting one breaks it. Paint edges, join or split seams, rename classes, and the checker tells you where seams
        of different classes meet. <em>Merge classes that meet</em> repairs a labelling by coarsening it.
      </p>
      <p>
        A one-tile tiling like the chair only has one derived class, because every edge eventually meets every other. <em>Refine tiles by supertile
        slot</em> splits each prototile by which slot of its parent it fills, which is how the Spectre ends up with nine types, and gives the chair four
        types and many more classes.
      </p>

      <h2>The tails problem</h2>
      <p>
        A tile with an odd number of crossings can't pair them all. Only parity matters, so the tail-free selections are the null space of the
        types × classes incidence matrix over GF(2). With the Spectre project's labels on the hexagons that gives the familiar eight:{' '}
        <code>∅ 15 128 258 01346 03456 023468 01234568</code>. The explorer lists them for whatever rule set you're on.
      </p>

      <h2>Exploring</h2>
      <p>
        The <a href={hashFor('explore')}>explorer</a> grows a patch, draws every line, and colours circuits by length. Click a line to pick it out. The
        survey tries every combination of the current selection on a smaller patch and tabulates circuits, distinct lengths, the longest circuit, and
        open lines. Open lines leave the patch, so a combination with many of them, and few circuits, is a candidate for infinite lines.
      </p>

      <h2>Tiling JSON</h2>
      <pre className="mono">{`{
  "kind": "similarity",
  "id": "my-tiling", "name": "My tiling",
  "inflation": 2,
  "prototiles": [{ "id": "a", "pts": [[0,0],[1,0],[1,1],[0,1]] }],
  "rules": { "a": [
    { "type": "a", "v0": [0,0],     "v1": [0.5,0] },
    { "type": "a", "v0": [0.5,0],   "v1": [1,0] },
    { "type": "a", "v0": [0,0.5],   "v1": [0.5,0.5] },
    { "type": "a", "v0": [0.5,0.5], "v1": [1,0.5], "flip": false }
  ]}
}`}</pre>
      <p>
        Each child is placed by where its vertex 0 and vertex 1 land inside a leaf-sized copy of the parent; <code>flip</code> mirrors it. The tiling
        must be edge-to-edge, so split long sides into the edges that neighbours actually meet.
      </p>
    </article>
  );
}
