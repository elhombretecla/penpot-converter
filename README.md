<div align="center">

# Penpot Converter

<img width="2172" height="724" alt="Penpot converter CLI" src="https://github.com/user-attachments/assets/cd0d42d7-665b-4a4a-a6fe-b69127260f1f" />

**Move your Figma designs into Penpot — right from your computer, no browser, no size limits.**

Convert Figma `.fig` files and Figma Slides `.deck` presentations into Penpot `.penpot` files locally. Pages, components, variants, design tokens and prototype interactions all come across, ready to use.

[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-package%20manager-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![License](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](#license)

[Quick start](#-quick-start) · [What it does](#-what-it-does) · [The tools](#-the-tools) · [Good to know](#-good-to-know)

</div>

---

## 🎯 In one minute

Figma's own "export to Penpot" plugin runs in the browser and chokes on large files. **Penpot Converter does the same job on your machine** — so it handles huge designs (200k+ shapes), keeps your components linked, brings your design tokens along, and never touches the network unless you ask it to.

If you can save a file from Figma and drag a file into Penpot, you can use this. The friendly menu walks you through the rest.

---

## ✨ What it does

| | |
|---|---|
| 🖼️ **Converts your designs** | `.fig` files and Figma Slides `.deck` → `.penpot`, with boards, text, images, auto layout, effects and more. |
| 🧩 **Keeps components linked** | Your design system and the files that use it stay connected — edit a component once, every copy updates. |
| 🎨 **Brings your tokens** | Figma variables become a real Penpot design-tokens library (colors, spacing, fonts, light/dark themes). |
| 🔀 **Handles giant files** | Splits an output that's too big to import into smaller pieces you can import one by one. |
| 🩺 **Checks & repairs** | Validates a `.penpot` for integrity problems and fixes them — locally or on a live Penpot server. |
| 🖥️ **Friendly or scriptable** | A guided arrow-key menu for people, plain commands for automation and CI. |

---

## 🚀 Quick start

### Before you begin

You'll need **Node.js 22 or newer** and **[pnpm](https://pnpm.io/installation)** (install it with `npm install -g pnpm`).
Very large files (200k+ shapes) want about **4–5 GB of free RAM**.

### Step 1 — Install it

```bash
git clone https://github.com/elhombretecla/penpot-converter.git
cd penpot-converter
pnpm install
```

<details>
<summary><strong>Optional:</strong> run <code>penpot-converter</code> from any folder</summary>

```bash
pnpm setup            # first time only — sets up pnpm's global bin dir, then open a new shell
pnpm link --global
```

After this, typing `penpot-converter` anywhere opens the guided menu.
The link points at this clone, so run `pnpm build` after you pull updates.

</details>

### Step 2 — Save your design from Figma

In the Figma desktop or web app: **Main menu → File → Save local copy…**
You get a `.fig` file — that's what the converter reads. Components from shared team libraries are baked into it automatically.

Figma Slides presentations save as `.deck` files the same way, and convert the same way — each slide becomes a Penpot board.

### Step 3 — Convert it

The **easy way** — just run it with no arguments and follow the on-screen menu (arrow keys, a file picker that finds your `.fig`/`.deck` files for you):

```bash
pnpm dev
```

The **scriptable way** — a one-line command:

```bash
pnpm tsx src/cli.ts convert my-design.fig -o my-design.penpot
```

A little Penpot-pencil progress bar draws across your terminal while it works, then prints a report of what came over: shapes by type, components, design tokens, font substitutions, and anything it skipped.

### Step 4 — Import into Penpot

In Penpot, open a project and **drag the `.penpot` file in** (or use **+ → Import file**). Done — your pages, components, variants, tokens and interactions are there.

> That's the whole loop. Everything below is the extra tools you can reach for when you need them.

---

## 📑 The tools

Jump to what you need:

- [🔄 `convert` — Figma → Penpot](#-convert--figma--penpot)
- [🖥️ Interactive menu — the guided way](#️-interactive-menu--the-guided-way)
- [🔍 `inspect` — peek inside a `.fig` file](#-inspect--peek-inside-a-fig-file)
- [✅ `validate` — check a `.penpot` for problems](#-validate--check-a-penpot-for-problems)
- [🛠️ `repair` — fix what validate finds](#️-repair--fix-what-validate-finds)
- [🌐 `repair-remote` — fix a file on a Penpot server](#-repair-remote--fix-a-file-on-a-penpot-server)
- [🔗 `relink` — reconnect split parts on a server](#-relink--reconnect-split-parts-on-a-server)
- [📡 `serve` — validate/repair as a web service](#-serve--validaterepair-as-a-web-service)
- [👋 `hello` — test that Penpot accepts your files](#-hello--test-that-penpot-accepts-your-files)

---

### 🔄 `convert` — Figma → Penpot

**What it's for.** Turning one or more Figma files into a Penpot file. This is the command you'll use 95% of the time.

**Good to know:**

- **One file → one Penpot file.** The simplest case.
- **Several files → one bundle.** Pass a design-system file **first** and the files that use it **after**. They all land in Penpot in a single import: the design system becomes a shared library, and every component instance stays linked to the real component — just like in Figma.
- **Only some pages.** Converting a couple of pages and their dependencies is *much* faster than a whole giant file — great for a quick preview.
- **Too big to import?** Penpot rejects imports over ~120 MiB. `--split` breaks an oversized output into smaller `.penpot` parts you import one at a time.

| Option | What it does |
|---|---|
| `<files...>` | One or more `.fig`/`.deck` files. Several → bundled into one `.penpot` (libraries first, consumers after). |
| `-o, --output <path>` | Where to write the result. Default: the last input's name with a `.penpot` extension. |
| `--pages <names>` | Convert only these pages (comma-separated). Pages holding components they need come along automatically. Single file only. |
| `--shared` | Mark the output as a shared library, ready to attach from other Penpot files right after import. |
| `--split` | If the result is bigger than `--max-size`, split it into self-contained parts. Single file only. |
| `--max-size <size>` | Size budget per part for `--split`, e.g. `100mb`, `0.5gb`. Default: `100mb`. |

<details>
<summary>How splitting decides what stays linked (the trade-off)</summary>

`.penpot` files come out larger than the `.fig` they came from — Penpot stores every component instance as real shapes. When the output is too big, `--split` groups pages into parts by weight, and each part keeps as much component linkage as fits its budget:

- **[components linked]** — the pages hosting the components a part uses also fit, so they ride along and every instance stays linked.
- **[static copies]** — those component pages are too heavy to duplicate (common in design-system files). The part ships its own pages, and instances whose component lives in *another* part are **detached**: pixel-identical shapes without the live link. Components stay editable in whichever part hosts them.

Penpot's importer assigns fresh ids on every import and can't re-link separately imported files, so links can only survive *inside* one `.penpot`. **Import all the parts** — each holds a different subset of your pages.

Prefer a single file? On a self-hosted Penpot you can raise `max-multipart-body-size` (backend) and `client_max_body_size` (nginx) and import the whole thing.

</details>

**In the terminal:**

```bash
# The basics — one file in, one Penpot file out
pnpm tsx src/cli.ts convert my-design.fig -o my-design.penpot

# A design system + a file that uses it (libraries FIRST, consumers AFTER)
pnpm tsx src/cli.ts convert design-system.fig app.fig -o bundle.penpot

# Just a few pages, for a fast preview
pnpm tsx src/cli.ts convert my-design.fig --pages "Checkout,Login" -o preview.penpot

# Split an output that's too big to import
pnpm tsx src/cli.ts convert my-design.fig --split               # parts under 100 MB
pnpm tsx src/cli.ts convert my-design.fig --split --max-size 80mb

# A Figma Slides deck (each slide becomes a board)
pnpm tsx src/cli.ts convert my-deck.deck -o slides.penpot
```

---

### 🖥️ Interactive menu — the guided way

**What it's for.** People who'd rather not remember commands. Run the tool with no arguments and it shows the Penpot logo and an arrow-key menu covering everything above.

**What you get:** menu choices grouped into **Convert** (`.fig`, `.deck`) and **Repair** (reconnect libraries, check & repair locally, repair on a server), plus inspect and a quick test file. File prompts are type-to-filter — they list matching files near you and narrow as you type, with a **"Browse the file system…"** option that walks folders with autocomplete, so you never hand-type a path. Output prompts accept a sensible suggested name with one Enter.

> Running in a pipe or CI (no real terminal)? You get the regular `--help` text instead.

**In the terminal:**

```bash
pnpm dev                  # from this clone
penpot-converter          # from anywhere, after `pnpm link --global`
```

---

### 🔍 `inspect` — peek inside a `.fig` file

**What it's for.** Looking at what a Figma file contains *without* converting it — a quick health check. It prints the format version, how many nodes of each type there are, the page list, and how many components come from external libraries.

**In the terminal:**

```bash
# Structural report, printed to the screen
pnpm tsx src/cli.ts inspect my-design.fig

# Dump the full decoded tree to JSON (for debugging), trimmed to a readable depth
pnpm tsx src/cli.ts inspect my-design.fig --json tree.json --max-depth 4
```

---

### ✅ `validate` — check a `.penpot` for problems

**What it's for.** Confirming a `.penpot` file is internally sound before you rely on it. It runs Penpot's own backend integrity checks (parent/child links, frame references, component/copy coherence, variants…) right on your machine and lists any error it finds.

It **exits with an error code** when problems exist, so it slots straight into CI.

**In the terminal:**

```bash
# Human-readable list of any errors
pnpm tsx src/cli.ts validate my-file.penpot

# Same thing as JSON (handy for scripts / CI)
pnpm tsx src/cli.ts validate my-file.penpot --json
```

---

### 🛠️ `repair` — fix what validate finds

**What it's for.** Automatically fixing the problems `validate` reports. It applies Penpot's own repair logic in a check→fix loop until the file is clean (up to 10 rounds). Anything it can't fix with confidence is reported and left untouched — nothing else is changed.

**In the terminal:**

```bash
# Repair and write the fixed file
pnpm tsx src/cli.ts repair broken.penpot -o fixed.penpot

# Just tell me what you'd fix — don't write anything
pnpm tsx src/cli.ts repair broken.penpot --dry-run

# Cap the number of rounds and get a JSON report
pnpm tsx src/cli.ts repair broken.penpot --max-iterations 5 --json
```

---

### 🌐 `repair-remote` — fix a file on a Penpot server

**What it's for.** Repairing a file that already lives in a Penpot instance, over its API — no download/re-upload dance. It fetches the file (and its libraries), runs the same check→fix loop as `repair`, and writes the result back in one atomic step. If the server still rejects the result, nothing is written (unless you pass `--force`).

> **Needs an access token** — pass `--token` or set the `PENPOT_ACCESS_TOKEN` environment variable. You can paste the file's URL straight from your browser.

**In the terminal:**

```bash
# Preview a repair on a live file (paste the URL from your browser)
pnpm tsx src/cli.ts repair-remote --url https://design.penpot.app \
  --file "https://design.penpot.app/#/workspace?team-id=…&file-id=…" --dry-run

# Repair it for real, using a file id
pnpm tsx src/cli.ts repair-remote --url https://design.penpot.app --file <file-id>
```

---

### 🔗 `relink` — reconnect split parts on a server

**What it's for.** A follow-up to `convert --split`. After you've imported all the parts into a Penpot project, `relink` turns their cross-part component connections back on: it rewrites the placeholder ids to the real ones Penpot assigned on import and links the parts as libraries of each other.

> **Needs an access token** and the `relink-manifest.json` that conversion produced.

**In the terminal:**

```bash
# Preview what would be reconnected
pnpm tsx src/cli.ts relink --url https://design.penpot.app \
  --project <project-id> --dry-run

# Reconnect for real
pnpm tsx src/cli.ts relink --url https://design.penpot.app \
  --project <project-id> --links relink-manifest.json
```

---

### 📡 `serve` — validate/repair as a web service

**What it's for.** Exposing the same validate/repair over HTTP so you can wire it into a pipeline or another app. Start the server, then POST `.penpot` files to `/validate` or `/repair`.

**In the terminal:**

```bash
# Start the service (a token makes the POST endpoints require auth; /health stays open)
pnpm tsx src/cli.ts serve --port 3000 --token my-secret

# Is it up?
curl http://localhost:3000/health

# Validate a file → JSON report
curl -X POST -H "Authorization: Bearer my-secret" \
     --data-binary @broken.penpot http://localhost:3000/validate

# Repair a file → get the repaired .penpot back
curl -X POST -H "Authorization: Bearer my-secret" \
     --data-binary @broken.penpot \
     "http://localhost:3000/repair?maxIterations=10" -o fixed.penpot
```

---

### 👋 `hello` — test that Penpot accepts your files

**What it's for.** A 10-second sanity check. It writes a minimal `.penpot` (a board with two shapes). If that file imports cleanly into your Penpot, the whole write pipeline works end to end.

**In the terminal:**

```bash
pnpm tsx src/cli.ts hello -o hello.penpot
```

---

## 💡 Good to know

- **Fonts.** Text using Google Fonts maps one-to-one. Common system fonts are swapped for metric-compatible Google Fonts (Helvetica Neue → Arimo, Georgia → Gelasio, Menlo → JetBrains Mono…) and every swap is listed in the report. Anything else falls back to Penpot's default until you upload the font as a custom font.
- **Images** are copied byte-for-byte — no re-encoding, no quality loss.
- **Repeatable.** Converting the same file twice produces the same internal ids, which is what keeps component links stable across runs and across a bundle.
- **Nothing disappears silently.** Node types that have no Penpot equivalent (FigJam widgets, brushes…) are counted in the report so you always know what was skipped.

<details>
<summary><strong>Everything <code>convert</code> brings across today</strong></summary>

- Frames → boards (with content clipping), groups, sections
- Rectangles (per-corner radii), ellipses, lines
- Vectors, stars and polygons via Figma's baked path geometry (fill/stroke outlines)
- Boolean operations (union/difference/intersection/exclude), with plain-group fallback
- Mask siblings → Penpot masked groups
- Text with rich per-character styling (font, size, weight, decoration, case, line height, letter spacing), Google Fonts / Penpot font resolution, missing-font report
- Fills: solid, linear/radial gradients, images (copied as-is)
- Strokes (width, alignment, dashes), drop/inner shadows, layer blur
- Auto layout → flex (direction, gaps, paddings, justify/align, wrap, hug/fill sizing, absolute-positioned children)
- Opacity, blend modes, constraints, rotations, hidden layers
- Components and variants (deterministic ids), with instance overrides translated to Penpot `touched` sync groups; nested component swaps produce swap-slot markers
- External-library component copies emitted on an "External components" page so their instances stay linked
- Figma variables: resolved for rendering, exported as a DTCG design-tokens library (one set + theme per collection/mode), and kept live on shapes via `appliedTokens`
- Multi-file bundles: earlier inputs marked as shared libraries, consumers get manifest relations, and instances point at the real component in the library file
- Prototype interactions: click/press/hover/enter/leave/after-delay events with navigate (+dissolve/slide/push), overlay, back and open-url actions
- Figma Slides (`.deck`): slides → boards at their grid positions, backgrounds and theme variables resolved, interactive elements as image snapshots, speaker notes as a labelled text block under each board

</details>

<details>
<summary><strong>Architecture (for contributors)</strong></summary>

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
repair/            .penpot validation & repair (port of Penpot's backend logic)
  model.ts         logical .penpot model + the 46-code error catalog
  io.ts            .penpot ZIP ⇄ model round-trip (ZIP64-safe past 65k entries)
  helpers.ts       component/tree helpers (swap slots, detach, find-ref-shape…)
  validate.ts      port of app.common.files.validate (pure, never mutates)
  repair.ts        port of app.common.files.repair (one handler per error code)
  runRepair.ts     validate→repair convergence loop (max 10 iterations)
commands/          CLI subcommands (convert, inspect, validate, repair, serve, hello, interactive)
ui/banner.ts       ASCII Penpot logo + wordmark for the interactive mode
```

Key third-party pieces: `kiwi-schema` (official Kiwi decoder), `@penpot/library` (official `.penpot` builder from the Penpot team), `fflate` + `fzstd` (decompression).

</details>

---

## License

[MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/)
