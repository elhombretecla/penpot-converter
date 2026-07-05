# fig2penpot — Research and technical proposal

Local CLI converter from `.fig` (Figma) to `.penpot` (Penpot), aiming at maximum
fidelity and preservation of component-instance and shared-library links.

Research date: 2026-07-04. Development started 2026-07-05.

---

## 1. Executive summary

- **Both file formats are decoded and empirically verified** against the files in
  `sample-files/`.
- **Chosen language: TypeScript on Node.js.** Not an aesthetic preference: the two
  critical pieces already exist as official, maintained JS code —
  `kiwi-schema` (Kiwi decoder by the format's own author, Evan Wallace/Figma) and
  `@penpot/library` (official .penpot builder from the Penpot team, compiled from the
  Penpot monorepo itself). On top of that, the Figma→Penpot mapping logic of the official
  plugin (`penpot-exporter-figma-plugin`, MPL-2.0, by the Penpot team) is plain TypeScript
  that can be reused almost verbatim.
- **The current plugin's memory problem is not the language, it is the environment**:
  the Figma plugin sandbox has a memory cap, the whole document crosses a single
  `postMessage`, the ZIP is assembled fully in memory and images are re-encoded to WebP
  on a canvas. A local Node CLI streams to disk and never touches image bytes: none of
  those constraints apply.
- **Proof of concept done on this machine**: `Codex.fig` (18 MB) fully decoded in Node
  with ~40 lines (20,730 nodes: components, instances with overrides, variables,
  auto layout). The format is self-describing (the schema ships inside each file),
  which makes the reader robust across Figma versions.

---

## 2. The `.fig` format (verified with Codex.fig and Design System CYGNUS.fig)

### 2.1 Container

```
file.fig  (ZIP)
├── canvas.fig          <- "fig-kiwi" binary with the whole document
├── meta.json           <- file name, thumbnail info, background color
├── thumbnail.png
└── images/<sha1>       <- raw PNG/JPEG blobs, named by content SHA-1
```

`canvas.fig`:
- Bytes 0–7: magic `fig-kiwi` · bytes 8–11: version (uint32 LE; our samples: v106)
- Then length-prefixed chunks. **Chunk 0 = binary Kiwi schema** (raw-deflate compressed) ·
  **Chunk 1 = data** (**zstd** in recent files, raw-deflate in older ones; detected via
  the `28 B5 2F FD` magic).

### 2.2 Data model

The data is a Kiwi message `Message { type: NODE_CHANGES, nodeChanges[], blobs[] }`:
- **`nodeChanges`**: flat list of nodes (sparse property bags). The first one is the
  `DOCUMENT`; `CANVAS` nodes are pages; the tree is rebuilt by linking
  `parentIndex.guid` and sorting siblings by `parentIndex.position` (fractional index,
  plain lexicographic string order).
- **Identity**: `GUID {sessionID, localID}`.
- **Relevant types**: FRAME, GROUP, RECTANGLE/ROUNDED_RECTANGLE, ELLIPSE, LINE, VECTOR,
  STAR, REGULAR_POLYGON, BOOLEAN_OPERATION, TEXT, SECTION, **SYMBOL** (component),
  **INSTANCE**, **VARIABLE / VARIABLE_SET** (variables/tokens), shared STYLE nodes.
- **Auto layout**: the `stack*` field family (stackMode, stackSpacing, stackPadding…).
- **Vector geometry**: binary blobs (`vectorNetworkBlob` with normalized
  vertices/segments/regions; `commandsBlob` with already-baked path commands — a
  faithful shortcut).
- **Text**: `textData { characters, characterStyleIDs[], styleOverrideTable, glyphs… }` —
  style runs are reconstructed per character (fig2sketch shows how).
- **Instances**: `symbolData { symbolID, symbolOverrides[] }` — each override is a sparse
  NodeChange addressed by `guidPath` (GUID chain through nested instances), plus
  `componentPropAssignments` for component properties.

### 2.3 Shared libraries inside `.fig` (key for this project)

Verified in Codex.fig:
- External-library components used by the file are **copied into a hidden canvas**
  ("Internal Only Canvas", flagged `internalOnly`).
- Every external `SYMBOL` and `VARIABLE` keeps its **`sourceLibraryKey`** (id of the
  source library), its **`key`** (stable global key of the component/variable, identical
  in every file that uses it) and `sharedSymbolVersion`. In Codex: 2,221 of 3,339 symbols
  carried a library key.

In other words: the `.fig` contains **everything needed** to rebuild cross-file links.

### 2.4 Risk and mitigation

The format is internal and undocumented; Figma changes it on every release. Mitigation:
the schema travels **inside each file**, so the decoder must always compile the embedded
schema and work by field *names* (never hard-coded ids). That is the strategy used by
fig2sketch (MIT, by Sketch B.V.) and by Evan Wallace's own reference parser, and it
survives version bumps. What actually breaks things are new semantics (e.g. the
deflate→zstd switch, variables), which get covered incrementally.

---

## 3. The `.penpot` format (verified with the 3 samples + Penpot source code)

### 3.1 Container: "binfile-v3"

The current export/import format (backend `app.binfile.v3`), a ZIP of JSONs:

```
file.penpot  (ZIP)
├── manifest.json                       {"type":"penpot/export-files","version":1,
│                                        "files":[{id,name,features}], "relations":[[file,lib],…]}
├── files/<file-uuid>.json              file metadata (version: 67, features, isShared…)
├── files/<fid>/pages/<pid>.json        {id, name, index}
├── files/<fid>/pages/<pid>/<sid>.json  ONE JSON PER SHAPE (root frame = zero uuid)
├── files/<fid>/components/<cid>.json   {id, name, path, mainInstanceId, mainInstancePage}
├── files/<fid>/colors|typographies/…   library assets
├── files/<fid>/tokens.json             design tokens in standard DTCG format
├── files/<fid>/media/<id>.json         refs to binaries
└── objects/<id>.json + <id>.<ext>      binaries (images) + metadata
```

- camelCase JSON; Malli schema validation that is **tolerant**: the minimum per-shape
  fields are `id, name, type, selrect, points, transform, transformInverse, parentId,
  frameId` (+ geometry); everything else is optional or auto-repaired by idempotent
  migrations at import time.
- **UUIDs are remapped on import** → only internal consistency is required.
- Shape types: `frame, group, bool, rect, circle, path, text, image, svg-raw`.
- Text: `root → paragraph-set → paragraph → children` tree with per-node styles
  (numeric values as strings).
- Flex/grid layout with the same vocabulary as auto layout (dir, gap, padding,
  fill/fix/auto sizing, absolute, z-index).
- Interactions/prototypes: the model exists (`interactions` per shape) — the current
  plugin does **not** export them; a local converter can beat the plugin here.

### 3.2 Components, instances and libraries (components/v2)

- A component definition has no geometry: it points at a **main instance** living as a
  normal shape on a page (`mainInstanceId` + `mainInstancePage`).
- Copies (instances) carry: `componentId`, **`componentFile`** (UUID of the owning
  file/library), `componentRoot` (on the root), **`shapeRef`** (id of the matching shape
  inside the main instance — the copy→main link), and **`touched`** (set of sync groups
  marking the copy's overrides: `fill-group`, `geometry-group`, `content-group`…).
- **Linked libraries**: the ZIP may contain **several files** and the manifest declares
  `relations` ([file, library] pairs); import creates the real relations. Verified in
  `🎥 Equalizer music app v2.1.penpot`: 4 files (app + 3 libraries) with their relations.
  Cross-file refs also live in `typographyRefFile`, `fillColorRefFile`, etc.
- Variants: container with `isVariantContainer`, components with `variantId` +
  `variantProperties`.

### 3.3 `@penpot/library` — the official writer

Official npm package from the Penpot team (MPL-2.0, zero deps, compiled from the Penpot
monorepo). Builder API: `createBuildContext()` → `addFile/addPage/addBoard/addRect/
addText/addComponent/addTokensLib/addRelation/…` → `exportStream(context, writable)`.
Works in Node (verified). It guarantees the output stays importable as Penpot evolves
(it stamps the right `version`, `migrations` and `features`).

Proof this path scales: `Design System CYGNUS.penpot` (230 MB, 178,373 entries,
173,875 shapes) was generated by the plugin through this library, and imports fine.

---

## 4. The current plugin (`penpot-exporter-figma-plugin`, MPL-2.0, Kaleidos/Penpot)

Pipeline: Figma node → transformers (`plugin-src/transformers/`) → TypeScript IR →
`postMessage` → UI parser (`ui-src/parser/`) → `@penpot/library` → `.penpot`.

**Reusable for our CLI (license-compatible):**
- The whole `plugin-src/translators/` tree: pure value-to-value functions (layouts,
  gradients, shadows, blend modes, strokes, text, Google Fonts catalogs, token
  equivalence tables and the complete NodeChange→`touched` table).
- The whole `ui-src/parser/` + IR types (`ui-src/lib/types/`): **no Figma dependency** —
  usable in Node almost verbatim.
- The ID strategy: **deterministic UUID v5** derived from the node id and from Figma's
  **global component key**. Powerful consequence: converting a library and a consumer
  file separately still yields matching `componentId`s → links reconnect automatically.

**What the plugin gets for free from the Figma runtime and we must derive from `.fig`:**
computed geometry (`vectorPaths`), styled text segments, variable resolution, image
bytes, library publish status. All have known recipes (fig2sketch, MIT, solves all of
it in its .fig→.sketch converter).

**Why the plugin dies on large files** (confirmed in its code and changelog): the whole
document as one JS object crossing `postMessage` (briefly duplicated in memory), the ZIP
assembled in memory, images decoded to bitmaps and re-encoded to WebP on canvas, all
inside the capped plugin sandbox. A local CLI removes all four causes.

---

## 5. Technical proposal

### 5.1 Language: TypeScript / Node.js

| Criterion | Assessment |
|---|---|
| `.penpot` writer | Official `@penpot/library` — zero risk of drifting from the format |
| `.fig` reader | Official `kiwi-schema` + zstd/inflateRaw (Node or pure-JS libs) |
| Mapping logic | Official plugin in TS (MPL-2.0) directly reusable |
| Performance | The bottleneck is I/O and data size, not CPU: 18 MB .fig → 25 MB decoded Kiwi. Node handles it with streaming; `worker_threads` available if ever needed |
| Rust alternative | Faster cold, but forces reimplementing the Penpot writer and all mapping from scratch, and chasing every format change by hand. If profiling ever justifies it, only the Kiwi decoder could move to Rust (napi-rs) without touching the rest |

### 5.2 CLI architecture

```
fig2penpot convert file.fig -o file.penpot [--libs map.json] [--verbose]

┌─────────────┐   ┌──────────────┐   ┌───────────────────┐   ┌────────────┐   ┌──────────────┐
│ 1. Reader    │ → │ 2. TreeBuild │ → │ 3. Normalizer      │ → │ 4. Mapper  │ → │ 5. Writer     │
│ unzip .fig   │   │ index GUIDs  │   │ plugin-API-like    │   │ Penpot IR  │   │ @penpot/     │
│ inflate/zstd │   │ parentIndex  │   │ shim over raw      │   │ (adapted   │   │ library →    │
│ kiwi decode  │   │ fractional   │   │ nodes: fills,      │   │ plugin     │   │ exportStream │
│ (embedded    │   │ order        │   │ layout, text runs, │   │ code)      │   │ → .penpot    │
│  schema)     │   │ overrides    │   │ paths, variables   │   │            │   │ (streaming)  │
└─────────────┘   └──────────────┘   └───────────────────┘   └────────────┘   └──────────────┘
```

Piece 3 (the normalizer) is the heart of the project: it rebuilds, on top of the raw
`.fig` nodes, the same data "shape" the Figma Plugin API exposes, so layer 4 can be
plugged in. It includes:
- vector networks / commandsBlob → Penpot paths,
- `textData` → per-segment style runs,
- instance expansion: copy the SYMBOL tree, apply `symbolOverrides` by `guidPath` and
  translate each override into Penpot `touched` groups (table already in the plugin),
- variables/styles resolution into DTCG tokens,
- images: copy `images/<sha1>` blobs into the `.penpot` as-is (no re-encoding).

### 5.3 Preserving library links (the differentiating requirement)

1. Deterministic ids: `uuidv5(figma component key)` → same `componentId` in library and
   consumer.
2. `SYMBOL`s from the "Internal Only Canvas" with `sourceLibraryKey` are emitted as
   external references (`componentFile` = UUID derived from the `sourceLibraryKey`),
   not as local components.
3. Multi-file mode: convert the library `.fig` and consumer files into a single
   `.penpot` with several `files` + `relations` (as Penpot's native export does), or
   separately with a `--libs map.json` (Figma library key → already-imported Penpot
   file UUID), which is the mechanism the plugin already uses.

### 5.4 Roadmap

| Phase | Scope | Success criterion |
|---|---|---|
| 0. Skeleton | CLI + full reader (.fig → inspectable JSON tree) + minimal writer | `inspect` dumps the tree; a hello-world .penpot imports into Penpot |
| 1. Basic shapes | frames, groups, rect/ellipse/line, fills/strokes/shadows/blur, images | converted Codex.fig imports and looks reasonable |
| 2. Fidelity | auto layout → flex/grid, vectors (paths), booleans, masks, full text | page-by-page visual comparison |
| 3. Components | SYMBOL/INSTANCE/overrides → components v2 + shapeRef + touched, variants | instances stay in sync with their main in Penpot |
| 4. Tokens & styles | variables → DTCG tokens, styles → library colors/typographies | tokens visible and applied in Penpot |
| 5. Libraries | multi-file + relations, deterministic ids, `--libs` | cross-file links survive conversion |
| 6. Extras | interactions/prototypes (beyond the plugin), CYGNUS benchmark | CYGNUS converts without exhausting memory |

Continuous validation: import each output into a local Penpot instance (docker) and
compare against the reference `.penpot` files in `sample-files/` (generated from the
same designs), which form a perfect regression suite.

### 5.5 Licensing

- Code reused from the plugin and `@penpot/library`: **MPL-2.0** (compatible; derived
  files keep MPL).
- fig2sketch / kiwi / fig_kiwi as reference or vendored: **MIT**.
- The orphaned npm package `fig-kiwi` (no license): reference only for field names,
  never copy code.

---

## 6. Empirical findings from the sample files

| File | Data |
|---|---|
| Codex.fig (18 MB) | fig-kiwi v106, deflate schema + zstd data (4.9 MB → 25.8 MB), 20,730 nodes, 6,080 blobs, 3,339 SYMBOL, 5,841 INSTANCE, 764 VARIABLE, 52 pages |
| Codex.penpot (98 MB) | native binfile-v3 (penpot 2.17), 76,265 JSONs, 1,059 components, 6,592 refs to an external library NOT included in the ZIP (dangling refs that Penpot resolves on import if the library exists) |
| CYGNUS.penpot (230 MB) | generated by the plugin (`penpot-library/1.2.0-RC2`), 173,875 shapes — proof the @penpot/library path scales |
| Equalizer.penpot | multi-file export: 4 files + 3 `relations` + DTCG tokens.json — the model to imitate for linked libraries |
