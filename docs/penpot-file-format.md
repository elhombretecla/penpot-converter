# The `.penpot` File Format — Structure, Findings & Size Analysis

Everything this project has learned about the `.penpot` format (binfile-v3): how it is
laid out, how Penpot imports it, why it is so much larger than the `.fig` it came from,
and where the optimization opportunities are.

**Provenance.** All numbers below were *measured*, not estimated: on real converter
outputs (`Design System CYGNUS.fig` → 294 MB, `Codex.fig` → 124 MB) by scanning the ZIP
central directory and parsing shape JSONs, and on the Penpot backend source
(`backend/src/app/binfile/v3.clj`, `common.clj` in [penpot/penpot], branch `develop`,
July 2026). Backend behavior may change in future Penpot versions — re-verify before
relying on the import-pipeline facts.

---

## 1. The container: a ZIP in "exploded" layout (binfile-v3)

A `.penpot` file is a plain ZIP (DEFLATE) with **one JSON entry per object** — not one
big JSON. This is the *binfile-v3* format ([penpot/penpot#5172]), written by
`@penpot/library` (`exportStream`, zip.js under the hood) and read by the backend
importer.

```
manifest.json                                      export manifest (see below)
files/{fileId}.json                                file meta: name, isShared, features,
                                                   migrations, version, options
files/{fileId}/pages/{pageId}.json                 page meta: name, index, background
files/{fileId}/pages/{pageId}/{shapeId}.json       ONE JSON PER SHAPE
files/{fileId}/components/{componentId}.json       component definitions (~200 B each)
files/{fileId}/colors/{id}.json                    library colors
files/{fileId}/typographies/{id}.json              library typographies
files/{fileId}/tokens.json                         design-tokens lib (DTCG + $themes)
files/{fileId}/media/{mediaId}.json                media metadata (width/height/mtype)
objects/{hash}.png|.jpg…  +  objects/{hash}.json   raw image binaries + storage meta
```

`manifest.json`:

```json
{"type": "penpot/export-files", "version": 1,
 "generatedBy": "penpot-library/1.2.0-RC2",
 "files": [{"id": "…uuid…", "name": "…", "features": ["components/v2", "…"]}],
 "relations": []}
```

- `files[]` may list **several files** — a single `.penpot` can bundle a shared library
  plus consumer files.
- `relations[]` is the library graph: `[consumerFileId, libraryFileId]` pairs. Only
  populated when the export includes libraries.
- Shape JSON uses **camelCase** keys (the backend's internal kebab-case is transcoded).

### Measured composition — CYGNUS, 294 MB on disk, 224 625 entries

| Bucket                          | Compressed | Entries  |
|---------------------------------|-----------:|---------:|
| `files/*/pages/**` (shapes)     | 160.0 MB   | 215 892  |
| **ZIP structure** (headers, central directory) | **≈ 92 MB** | —  |
| `objects/*` (image binaries)    | 26.7 MB    | 246      |
| `files/*/components/*`          | 1.9 MB     | 8 361    |
| manifest, file/page meta, tokens| < 0.1 MB   | ~200     |

Uncompressed payload: **613 MB**. Two non-obvious takeaways:

1. **ZIP structure is a first-class cost.** Each entry pays a local header + central
   directory record (~450 B amortized here, because every path embeds three 36-char
   UUIDs). At 215 k entries that is ~92 MB — 31 % of the file — spent on *no data at all*.
2. **Images are NOT the problem** (9 % here, deduplicated by content hash, copied
   byte-for-byte from the `.fig`).

---

## 2. The data model

### Shapes

One JSON per shape; average **~3.0 KB uncompressed / ~745 B compressed** (median
1.4 KB). Anatomy of a real (small) `rect` from CYGNUS, annotated:

```jsonc
{
  "id": "66e64b65-…", "name": "Rectangle 69", "type": "rect",
  "x": 7117, "y": -371, "width": 6, "height": 38, "rotation": 0,
  "selrect": { "x":7117,"y":-371,"width":6,"height":38,
               "x1":7117,"y1":-371,"x2":7123,"y2":-333 },   // derivable from x/y/w/h
  "points": [ {"x":7117,"y":-371}, {"x":7123,"y":-371},
              {"x":7123,"y":-333}, {"x":7117,"y":-333} ],   // derivable again
  "transform":        { "a":1,"b":0,"c":0,"d":1,"e":0,"f":0 }, // identity, serialized
  "transformInverse": { "a":1,"b":0,"c":0,"d":1,"e":0,"f":0 }, // inverse of the above
  "parentId": "3da26108-…", "frameId": "3da26108-…",          // often identical
  "pageId": "667860bd-…",                                     // repeated in EVERY shape
  "flipX": null, "flipY": null,                               // nulls serialized
  "r1": 4, "r2": 4, "r3": 4, "r4": 4,
  "shapeRef": "3f62593c-…",
  "strokes": [ … ], "fills": [],
  "shadow": [ { "id": "0da8557c-…",                           // random per-run id
                "color": { "opacity": 0.6000000238418579 } } ] // float32 artifact
}
```

The same geometry is stored **four times** (x/y/w/h + selrect + points + transform
pair), identity matrices and nulls are written out, `pageId`/`parentId`/`frameId` add
three UUIDs per shape, and float32→double conversion leaks 17-digit decimals
(`0.6000000238418579`, path coords like `4213.60009765625`).

### Components: mains + physically expanded copies

This is the single most important modeling fact. Penpot has **no lazy instancing**:

- The *main* component is a real shape tree on some page, flagged
  `mainInstance: true, componentRoot: true, componentId, componentFile`, plus a
  ~200 B definition entry under `files/{id}/components/`.
- Every *copy* (Figma "instance") is a **full physical clone** of that tree. Each cloned
  shape carries `shapeRef` pointing to its counterpart in the main ("near match" — the
  positional counterpart, enforced by Penpot's referential-integrity validator), and
  `touched: [...]` entries record which attribute groups diverge locally.
- Component swaps store a `swap-slot-{uuid}` touched entry; below a swap, refs re-base
  onto the swapped component's own main.

Consequences: a 50-shape component used 100 times ⇒ ~5 000 physical shapes (each a ZIP
entry); nesting multiplies further. The links are live (edit main → copies update), but
storage-wise everything is expanded.

### Libraries / multi-file bundles

Within one `.penpot`: `files[]` + `relations[]` in the manifest, `isShared: true` on the
library file, and cross-file pointers on shapes/assets: `componentFile`,
`fillColorRefFile`/`fillColorRefId`, `strokeColorRefFile`, `typographyRefFile`/`-Id`.
`@penpot/library` exposes this via `addFile({isShared})` + `addRelation(fileId, libId)`.

---

## 3. How Penpot imports a `.penpot` (backend facts)

From `backend/src/app/binfile/v3.clj` + `common.clj` (develop, 2026-07):

| Fact | Where |
|---|---|
| **File / media / storage-object ids are REMAPPED to fresh random UUIDs on every import** (`uuid/next`). Page & shape ids are preserved. | `common.clj` `index-object`, `lookup-index` |
| All files inside one ZIP remap **through one shared index**, so `relations` and cross-file refs stay consistent — *inside that ZIP*. | `v3.clj` `import-files*`, `import-file-relations` |
| References to files **absent** from the ZIP are left **dangling** (`lookup-index` falls back to the original id). No prune/detach happens at import. | `common.clj` `lookup-index` `(or val id)` |
| There is **no reconnect-by-id or by-name** against libraries already in the team. Two `.penpot` files imported separately can never end up linked. | whole import path |
| Detach happens at **export**: default export detaches external refs; `include-libraries` bundles them; `embed-assets` absorbs them into the file. | `v3.clj` `get-file`, `export-files!` |
| An in-place overwrite import path exists (preserves the file id) but only for manifests with exactly 1 file. | `v3.clj` `import-file-and-overwrite*` |
| Upload cap: **`max-multipart-body-size` = 120 MiB default** on the backend, plus nginx `client_max_body_size` in front. | [penpot/penpot#4460] |

**Design corollary:** any "split a big export" scheme must make each output
self-sufficient. Cross-file links between separately imported `.penpot` files are
impossible by construction.

---

## 4. Why a `.penpot` outweighs the `.fig` it came from

Measured: `Codex.fig` 18 MB → 124 MB (×6.9); `Design System CYGNUS.fig` 49 MB → 294 MB
(×6.0, 70 pages, 209 417 shapes emitted, 8 361 components).

`.fig` is a ZIP too (canvas.fig + meta + images), but the design data inside is a
**Kiwi-encoded binary** (schema embedded per file), zstd/deflate-compressed, where:

- field names are numeric tags, not strings;
- an **instance is a reference + override deltas** — the component subtree is stored
  once, no matter how many instances exist;
- geometry is parametric (a star is "5 points, ratio r", not its outline).

The `.penpot` explodes on all three axes, in order of impact:

### 4.1 Instance expansion (dominant)
Penpot's model (§2) forces every copy to exist as real shapes. A design-system file is
the worst case: mostly components + instance-heavy demo pages. CYGNUS: 209 k emitted
shapes for a fraction as many source nodes.

### 4.2 One-JSON-per-shape × verbose encoding
~3 KB of JSON per shape with: string keys, 36-char UUIDs everywhere (id, parentId,
frameId, pageId, shapeRef, componentId…), quadruple-stored geometry, serialized
identity matrices and nulls, float32 noise (§2). Text compresses well (613 → 294 MB) but
DEFLATE-per-tiny-entry can't exploit cross-shape redundancy — every shape repeats the
same key strings and the compressor never sees them together.

### 4.3 ZIP entry overhead
~450 B × 215 k entries ≈ **92 MB (31 %)** of CYGNUS is ZIP headers + central directory
(three UUIDs in every path). Zero information content.

### 4.4 Baked vector geometry
The converter (like Penpot's own Figma plugin) bakes `fillGeometry`/`strokeGeometry`
into explicit path outlines: every stroke becomes a second filled outline path, and
parametric shapes become coordinate lists (with float32-artifact decimals up to 17
digits).

---

## 5. What the converter does about it: `--split`

Since a >120 MiB `.penpot` won't import, the CLI splits oversized outputs into
independently importable parts:

```bash
pnpm tsx src/cli.ts convert design.fig --split                # parts ≤ 100 MB (default)
pnpm tsx src/cli.ts convert design.fig --split --max-size 80mb
```

Pipeline (see `src/commands/split.ts`):

1. Convert normally, `statSync` the result. Under the threshold → done.
2. Read **per-page compressed weight** from the ZIP central directory (fflate
   `unzipSync` with a filter that always returns `false` — no decompression), and
   amortize the per-entry ZIP overhead onto pages. Media is bucketed separately (it
   follows usage, it is not fixed overhead).
3. Pack pages into parts **by their own weight**, document order. Per part, then decide:
   - **`[components linked]`** — the pages hosting the components the part references
     (transitive closure, same machinery as `--pages`) also fit the budget → include
     them; every instance stays linked. Component pages may be duplicated across parts.
   - **`[static copies]`** — the closure doesn't fit (typical for design systems, where
     nearly every page drags the same huge component pages — closure-first packing
     degenerated CYGNUS into 42 parts of ~126 MB). The part ships only its own pages and
     is converted with `detachForeign`: instances of components hosted elsewhere are
     emitted **detached** — pixel-identical shapes, no component linkage.
4. Re-run the conversion once per part (`pageIndexes` + optional `detachForeign`),
   verify sizes, delete the monolith, print the plan.

Detach rules that survived verification (see `Converter.convertInstance`):

- A head needs its component's main page present when it references that main
  *directly*: top-level instances, swapped heads, **and any head below a swap** (the
  re-based ref convention points children at the immediate symbol's own main). Missing →
  the whole subtree is emitted with `Expansion.detached` (no `shapeRef`/`componentId`/
  `touched` anywhere).
- A plain **nested** head whose component definition is absent keeps its positional
  `shapeRef` (target = the outer main's copy, which exists) but sheds
  `componentId`/`componentFile` — exactly like a non-instance descendant of a copy.

Result on CYGNUS: 294 MB → **3 parts (102 / 96 / 81 MB)**, full page coverage, zero
split-induced dangling refs (audited; the full conversion itself carries ~1.3 % dangling
`shapeRef`s from an unrelated pre-existing quirk).

Alternative for self-hosted Penpot — import the single big file by raising:

```
# backend
JVM_OPTS: -Dapp.http.server.max-multipart-body-size=419430400
# nginx
client_max_body_size 400M;
```

---

## 6. Optimization study — levers to reduce `.penpot` size & improve performance

Ranked by expected impact, with what is and isn't in our control. The format is
*consumed by Penpot's importer*, so anything structural needs upstream compatibility;
data-level changes inside each shape JSON are converter-side and safe as long as
Penpot's schema accepts them.

### A. Converter-side, lossless (safe to try)

1. **Stop serializing derivable geometry** *(if the builder allows omission)*:
   `selrect`, `points`, `transformInverse` — and identity `transform` — are all
   derivable from `x/y/width/height/rotation`. In the sample rect they are ~45 % of the
   JSON. Open question: does `@penpot/library` compute them when omitted, or does the
   importer require them? (The library API takes high-level params and generates these —
   the bloat may originate in the library itself; measure by diffing addRect output.)
2. **Round float32 artifacts**: `0.6000000238418579` → `0.6`, `4213.60009765625` →
   `4213.6`. Purely presentational precision from Figma's float32; rounding to ~4
   decimals is visually lossless and shortens every path segment. Needs a pass in the
   converter's number handling (`src/mapper/*`), or upstream in the library encoder.
3. **Omit nulls and defaults**: `flipX: null`, `rotation: 0`, `proportionLock: false`,
   empty `fills: []`… every shape carries them.
4. **Drop redundant baked stroke outlines** where a native Penpot stroke represents the
   same thing (the converter already does native strokes for arc ellipses —
   `nativeStrokes` option exists; extend the audit).

### B. Structural (needs upstream / format work)

5. **Fewer ZIP entries.** 31 % of CYGNUS is entry overhead. One JSON per *page* instead
   of per shape would eliminate ~215 k entries (~90 MB) AND let DEFLATE compress
   repeated keys across shapes (expect a further large win — the 613→294 ratio would
   improve substantially with cross-shape redundancy visible to the compressor).
   binfile-v3 chose exploded layout for streaming/memory reasons; check whether the
   importer accepts a consolidated variant, or propose it upstream.
6. **Path prefix cost**: every entry path repeats `files/{uuid}/pages/{uuid}/` — 74
   chars × 2 (local + central header) × 215 k ≈ 32 MB just in repeated path prefixes.
   Shorter ids/paths inside the ZIP would be format-breaking; only viable upstream.
7. **Better compression**: the backend importer reads standard ZIP; zstd or solid
   compression is not an option without upstream changes.

### C. Model-level (bounded by Penpot's design)

8. **Instance expansion cannot be avoided** — it's Penpot's data model, not a format
   choice. The only lever is emitting *less per cloned shape* (A1–A3 multiply across
   every copy).
9. **Component pruning**: only register component definitions actually referenced
   (mostly done — defs are ~200 B, low impact).
10. **`touched`/override minimization**: emit `touched` only for real divergences
    (audit for false positives; each entry is a string per shape per group).

### D. Lossy (user-opt-in)

11. **Media recompression** (PNG→WebP/AVIF, quality caps). Only ~9 % on CYGNUS, but
    image-heavy marketing files will differ; make it a flag, never default.
12. **Aggressive coordinate rounding** (1 decimal) for screen-resolution designs.

### E. Performance (import/runtime, not just bytes)

- Shape *count* drives Penpot's editor memory and import time more than bytes do —
  instance expansion again. `--pages` / `--split` are currently the practical levers.
- Converter peak RAM (~4–5 GB on 200 k-shape files) is dominated by the
  `@penpot/library` build context holding the whole file; per-part conversion in split
  mode already bounds this.
- Quick shape-count estimate before converting: `pnpm tsx src/cli.ts inspect file.fig`.

### Measurement tooling to reuse

- **Per-bucket ZIP census** (pages / media / components / structure): scan the central
  directory only — `unzipSync(buf, { filter: f => { record(f.name, f.size); return false; } })`
  (fflate), or Python `zipfile.infolist()`. See `measurePenpotWeights` in
  `src/commands/split.ts`.
- **Dangling-ref audit** (shapeRef → shape ids, componentId → component defs,
  `*RefFile` → own file id, fillImage → media): regex scan over entry bytes; the
  session's `verify_final.py` pattern. Any structural optimization MUST re-run this and
  survive a real Penpot import.
- **Byte-identity caveat**: `@penpot/library` assigns per-run ids to media, shadows and
  token themes, and stamps `modifiedAt` — outputs are never byte-identical across runs.
  Compare shape JSONs ignoring those fields; page and shape ids ARE deterministic here
  (UUID v5, and the converter pins page ids to the canvas guid).

---

## 7. References

- Converter internals: `src/commands/convert.ts` (Converter, instance expansion,
  detach), `src/commands/split.ts` (weights, planner, split execution),
  `src/types/penpot-library.d.ts` (builder API incl. `addFile`/`addRelation`).
- Penpot backend: `backend/src/app/binfile/v3.clj`, `common.clj`;
  `common/src/app/common/files/helpers.cljc` (`relink-refs`).
- [penpot/penpot#5172] — binfile-v3 export/import format (PR).
- [penpot/penpot#4460] — `max-multipart-body-size` import limit.
- `@penpot/library` — npm builder used for writing (`exportStream`).

[penpot/penpot]: https://github.com/penpot/penpot
[penpot/penpot#5172]: https://github.com/penpot/penpot/pull/5172
[penpot/penpot#4460]: https://github.com/penpot/penpot/issues/4460
