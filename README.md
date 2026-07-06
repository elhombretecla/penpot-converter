# Penpot Converter

Local CLI that converts Figma `.fig` files ("Save local copy") and Figma Slides
`.deck` presentations into Penpot `.penpot` files — no browser involved and none
of the memory limits of the export plugin.

## Quick start

**Requirements:** Node.js 22 or newer and [pnpm](https://pnpm.io/installation)
(`npm install -g pnpm`). Large files (200k+ shapes) need ~4–5 GB of free RAM.

### 1. Install

```bash
git clone https://github.com/elhombretecla/penpot-converter.git
cd penpot-converter
pnpm install
```

Optional — make the `penpot-converter` command available from any directory:

```bash
pnpm setup           # first time only: configures pnpm's global bin dir (then open a new shell)
pnpm link --global
```

After that, running `penpot-converter` anywhere opens the interactive UI.
(The link points at this clone: rerun `pnpm build` after pulling changes.)

### 2. Export your design from Figma

In the Figma desktop app or web: **Main menu → File → Save local copy…**
This downloads a `.fig` file — that is the converter's input. (Components from
shared team libraries that the file uses are embedded in it automatically.)
Figma Slides presentations save as `.deck` files the same way, and convert
the same way: each slide becomes a Penpot board, laid out in the same grid
as Figma's overview.

### 3. Convert

The friendly way — run it with no arguments to enter the interactive terminal
UI (arrow-key menu, file picker over the `.fig`/`.deck` files it finds around
you):

```bash
pnpm dev
```

Or the scriptable way, as a one-shot command:

```bash
pnpm tsx src/cli.ts convert my-design.fig -o my-design.penpot
```

When it finishes it prints a report: shapes converted by type, components,
design tokens, font substitutions applied, and anything it had to skip.

### 4. Import into Penpot

In Penpot, go to a project dashboard and drag the `.penpot` file in
(or use **+ → Import file**). Pages, components, variants, tokens and
prototype interactions arrive ready to use.

That's the whole loop. The sections below cover the extra tools.

## Command reference

### Interactive mode (no arguments)

```bash
pnpm dev                  # from a clone
penpot-converter          # from anywhere, after `pnpm link --global`
```

Shows the Penpot banner and an arrow-key menu over the same commands below:
convert a `.fig`, convert a `.deck`, inspect a file, or write the `hello`
test file. It lists the `.fig`/`.deck` files found near the current directory
so you rarely have to type a path. Non-interactive shells (pipes, CI) get the
regular `--help` instead.

### `convert` — Figma → Penpot

```bash
pnpm tsx src/cli.ts convert <files...> [options]
```

| Option | Description |
|---|---|
| `<files...>` | One or more `.fig`/`.deck` files. With several, they are bundled into ONE `.penpot` (see below). |
| `-o, --output <path>` | Output file. Default: `<last input's name>.penpot` in the current directory. |
| `--pages <names>` | Convert only these pages (comma-separated, case-insensitive). Pages hosting components referenced by the selection are pulled in automatically so instance links never break. Single input only. |

**Converting a design system + files that use it (linked libraries).**
Pass the library files FIRST and the consumer files after — order matters:

```bash
pnpm tsx src/cli.ts convert design-system.fig app.fig -o bundle.penpot
```

Both files land in Penpot in one import: the design system is marked as a
shared library, the app file is linked to it (Assets → Libraries), and every
instance in the app points at the real component in the library — editing a
library component updates the copies, exactly like in Figma.

**Fast iteration on big files.** Converting one page and its dependencies is
much faster than the whole file:

```bash
pnpm tsx src/cli.ts convert my-design.fig --pages "Checkout,Login" -o preview.penpot
```

### `inspect` — look inside a `.fig`/`.deck` without converting

```bash
pnpm tsx src/cli.ts inspect my-design.fig
pnpm tsx src/cli.ts inspect my-design.fig --json tree.json --max-depth 4
```

Prints a structural report (format version, node counts by type, pages,
how many components come from external libraries). `--json` dumps the full
decoded node tree for debugging; `--max-depth` prunes it to a readable size.

### `hello` — smoke-test your Penpot instance

```bash
pnpm tsx src/cli.ts hello -o hello.penpot
```

Writes a minimal `.penpot` (a board with two shapes). If this file imports
into your Penpot, the write pipeline works end to end.

## Good to know

- **Fonts:** text using Google Fonts maps 1:1. Common system fonts are
  substituted with metric-compatible Google Fonts (Helvetica Neue → Arimo,
  Georgia → Gelasio, Menlo → JetBrains Mono, …) and every substitution is
  listed in the report. Other fonts fall back to Penpot's default until you
  upload them as custom fonts.
- **Images** are copied byte-for-byte (no re-encoding, no quality loss).
- **Deterministic ids:** converting the same file twice produces the same
  internal ids, which is what keeps component links stable across runs and
  across the files of a bundle.
- Skipped node types (FigJam widgets, brushes, raw variables already exported
  as tokens…) are counted in the report — nothing is dropped silently.

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

- Figma Slides (`.deck`): slides → boards at their grid positions (the
  grid/row/module scaffolding is flattened away), slide backgrounds and theme
  variables resolved, "shape with text" stickers via their baked geometry,
  interactive elements (polls, embeds…) as their image snapshot; speaker notes
  become a labelled gray text block right under each slide's board (Penpot has
  no notes concept, so they ride along visually)

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
commands/          CLI subcommands (convert, inspect, hello, interactive)
ui/banner.ts       ASCII Penpot logo + wordmark for the interactive mode
```

Key third-party pieces: `kiwi-schema` (official Kiwi decoder),
`@penpot/library` (official .penpot builder from the Penpot team),
`fflate` + `fzstd` (decompression).

## License

MPL-2.0
