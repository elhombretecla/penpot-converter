# Penpot Converter

Local CLI that converts Figma `.fig` files ("Save local copy") into Penpot `.penpot` files —
no browser involved and none of the memory limits of the export plugin.

## Usage

```bash
npm install

# Convert a .fig file into a .penpot file
npx tsx src/cli.ts convert file.fig -o output.penpot

# Bundle several .fig files into one .penpot with linked libraries:
# libraries FIRST, consumers after. Components used across files stay linked.
npx tsx src/cli.ts convert design-system.fig app.fig -o bundle.penpot

# Convert only some pages (pages hosting referenced components are pulled in
# automatically so component links stay intact) — handy for fast visual checks
npx tsx src/cli.ts convert file.fig --pages "ButtonGroup,Checkbox" -o debug.penpot

# Inspect a .fig file: structural report (nodes, pages, external libraries)
npx tsx src/cli.ts inspect file.fig

# Dump the full decoded node tree as JSON (prune with --max-depth)
npx tsx src/cli.ts inspect file.fig --json tree.json [--max-depth 4]

# Write a minimal test .penpot (validates the write pipeline)
npx tsx src/cli.ts hello -o hello.penpot
```

## What `convert` supports today

- Frames → boards (with content clipping), groups, sections
- Rectangles (per-corner radii), ellipses, lines
- Vectors, stars and polygons via Figma's baked path geometry (fill/stroke outlines)
- Boolean operations (union/difference/intersection/exclude), with plain-group fallback
- Mask siblings → Penpot masked groups
- Text with rich per-character styling (font, size, weight, decoration, case,
  line height, letter spacing), Google Fonts / Penpot font resolution, missing-font report
- Fills: solid, linear/radial gradients, images (copied as-is, no re-encoding)
- Strokes (width, alignment, dashes), drop/inner shadows, layer blur
- Auto layout → flex (direction, gaps, paddings, justify/align, wrap,
  hug/fill sizing, absolute-positioned children)
- Opacity, blend modes, constraints, rotations, hidden layers
- Components (components/v2 main instances, deterministic UUID v5 ids), variants
  (variant containers + properties parsed from "Prop=Value" names)
- Instances: the component tree is expanded with per-shape `shapeRef` links, user
  overrides applied (fills, text, visibility…) and translated to Penpot `touched`
  sync groups; nested component swaps produce swap-slot markers
- External-library component copies (Figma's hidden internal canvas) are emitted on
  an "External components" page so their instances stay linked

- Figma variables: resolved for rendering (fills, gradient stops, strokes,
  shadows honour alias chains and per-subtree light/dark modes), exported as a
  DTCG design-tokens library (one set + theme per collection/mode), and kept
  live on shapes via `appliedTokens` (fill, strokeColor, radii, gaps, paddings,
  sizes, font size/family/weight)
- System-font aliasing to metric-compatible Google Fonts (Helvetica Neue→Arimo,
  Georgia→Gelasio, …), reported per conversion

- Multi-file bundles: earlier inputs are marked as shared libraries
  (`isShared`), consumers get manifest `relations`, and instances of external
  components point at the real component in the library file (matched by
  qualified name, since .fig files don't carry per-component global keys)
- Prototype interactions: click/press/hover/enter/leave/after-delay events with
  navigate (+dissolve/slide/push animations), overlay, back and open-url
  actions; component state swaps (SWAP_STATE) have no Penpot equivalent

## Architecture (src/)

```
fig/container.ts   opens the .fig (ZIP or bare), splits chunks, inflates (deflate-raw | zstd)
fig/kiwi.ts        decodes the payload using the Kiwi schema EMBEDDED in the file itself
fig/tree.ts        rebuilds the node tree: GUID index, fractional sibling ordering
fig/blobs.ts       decodes commandsBlob path geometry into Penpot path segments
mapper/            value-level Figma → Penpot translation
  matrix.ts        2x3 affine matrix algebra (compose, invert)
  geometry.ts      absolute position + rotation (Penpot x/y/rotation/transform model)
  paints.ts        fillPaints/strokePaints → fills/strokes (solid, gradients, images)
  effects.ts       effects → shadows and blur
  layout.ts        auto layout (stack*) → flex layout attributes
  text.ts          textData (character style runs) → Penpot text content tree
  fonts.ts         Figma font names → Penpot font ids (Google Fonts + local catalogs)
  ids.ts           deterministic UUID v5 ids (same scheme as the official plugin)
  touched.ts       overridden .fig fields → Penpot touched sync groups
  variables.ts     Figma variable resolution (alias chains, mode contexts)
  tokens.ts        variables → DTCG tokens lib + appliedTokens on shapes
  interactions.ts  prototype interactions → Penpot shape interactions
commands/          CLI subcommands (convert, inspect, hello)
```

Key third-party pieces: `kiwi-schema` (official Kiwi decoder),
`@penpot/library` (official .penpot builder from the Penpot team),
`fflate` + `fzstd` (decompression).

## Performance

Reference numbers on a desktop Linux box (Node 22): Codex.fig (18 MB, 105k
shapes) converts in ~2 min; Design System CYGNUS.fig (49 MB, 209k shapes) in
~7 min with a ~4.5 GB peak (the build context of `@penpot/library` holds the
whole file in memory before streaming the zip). The browser plugin dies on
files this size.

## License

MPL-2.0
