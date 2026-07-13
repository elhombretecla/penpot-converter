import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import type { Component, PageMeta, PenpotBundle, PenpotFile, Shape } from './model.js';

/**
 * Read/write the .penpot ZIP into the logical model. Entries the model does
 * not own (media, objects/, tokens.json, unknown extras) are carried verbatim
 * so a validate→repair→write cycle only rewrites what the repair touched.
 */

const FILE_META = /^files\/([^/]+)\.json$/;
const PAGE_META = /^files\/([^/]+)\/pages\/([^/]+)\.json$/;
const PAGE_SHAPE = /^files\/([^/]+)\/pages\/([^/]+)\/([^/]+)\.json$/;
const COMPONENT = /^files\/([^/]+)\/components\/([^/]+)\.json$/;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function parseJson<T>(bytes: Uint8Array, entry: string): T {
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch (err) {
    throw new Error(`invalid JSON in "${entry}": ${err instanceof Error ? err.message : err}`);
  }
}

export function readPenpotBundle(bytes: Uint8Array): PenpotBundle {
  const entries = unzipSync(bytes);
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) throw new Error('not a .penpot file: manifest.json entry is missing');
  const manifest = parseJson<Record<string, unknown>>(manifestBytes, 'manifest.json');

  interface Building {
    meta?: Record<string, unknown>;
    pageMetas: Map<string, PageMeta>;
    pageObjects: Map<string, Record<string, Shape>>;
    components: Record<string, Component>;
  }
  const building = new Map<string, Building>();
  const fileOf = (fileId: string): Building => {
    let b = building.get(fileId);
    if (!b) {
      b = { pageMetas: new Map(), pageObjects: new Map(), components: {} };
      building.set(fileId, b);
    }
    return b;
  };

  const rawEntries = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'manifest.json' || name.endsWith('/')) continue;
    let match: RegExpExecArray | null;
    if ((match = PAGE_SHAPE.exec(name))) {
      const objects = fileOf(match[1]).pageObjects;
      let page = objects.get(match[2]);
      if (!page) objects.set(match[2], (page = {}));
      page[match[3]] = parseJson<Shape>(data, name);
    } else if ((match = PAGE_META.exec(name))) {
      fileOf(match[1]).pageMetas.set(match[2], parseJson<PageMeta>(data, name));
    } else if ((match = COMPONENT.exec(name))) {
      fileOf(match[1]).components[match[2]] = parseJson<Component>(data, name);
    } else if ((match = FILE_META.exec(name))) {
      fileOf(match[1]).meta = parseJson<Record<string, unknown>>(data, name);
    } else {
      rawEntries.set(name, data);
    }
  }

  const manifestFiles = (manifest['files'] as { id: string }[] | undefined) ?? [];
  const order = manifestFiles.map((f) => f.id).filter((id) => building.has(id));
  for (const id of building.keys()) if (!order.includes(id)) order.push(id);

  const files: PenpotFile[] = order.map((fileId) => {
    const b = building.get(fileId)!;
    const meta = b.meta ?? { id: fileId };
    const pages = [...b.pageMetas.values()]
      .sort((a, z) => (a.index ?? 0) - (z.index ?? 0))
      .map((p) => p.id);
    // Page dirs can exist without a meta entry (or vice versa); keep both sides.
    for (const pageId of b.pageObjects.keys()) {
      if (!b.pageMetas.has(pageId)) {
        pages.push(pageId);
        b.pageMetas.set(pageId, { id: pageId });
      }
    }
    const pagesIndex = Object.fromEntries(
      pages.map((pageId) => [
        pageId,
        { id: pageId, meta: b.pageMetas.get(pageId)!, objects: b.pageObjects.get(pageId) ?? {} },
      ]),
    );
    return {
      id: fileId,
      name: typeof meta['name'] === 'string' ? meta['name'] : undefined,
      features: Array.isArray(meta['features']) ? (meta['features'] as string[]) : [],
      meta,
      data: { pages, pagesIndex, components: b.components },
    };
  });

  return { manifest, files, rawEntries };
}

export function readPenpotFile(path: string): PenpotBundle {
  const raw = readFileSync(path);
  return readPenpotBundle(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
}

/**
 * fflate's zipSync writes a plain end-of-central-directory record whose
 * 16-bit entry-count fields silently wrap past 65535 entries — and a big
 * .penpot easily has 100k+ entries (one JSON per shape), which would make
 * readers see only `count % 65536` of them. Offsets still fit in 32 bits at
 * .penpot sizes, so appending a ZIP64 EOCD record + locator before the EOCD
 * (and flagging the 16-bit counts as 0xFFFF) is sufficient; fflate's own
 * unzipSync and Penpot's importer both honor it.
 */
function withZip64Eocd(zipped: Uint8Array, entryCount: number): Uint8Array {
  if (entryCount <= 0xffff) return zipped;
  const eocdOffset = zipped.length - 22; // zipSync writes no archive comment
  const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  if (view.getUint32(eocdOffset, true) !== 0x06054b50) {
    throw new Error('unexpected ZIP layout: end-of-central-directory record not found');
  }
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const z64 = new Uint8Array(56 + 20);
  const z64view = new DataView(z64.buffer);
  z64view.setUint32(0, 0x06064b50, true); // ZIP64 EOCD record
  z64view.setBigUint64(4, 44n, true); // size of the rest of the record
  z64view.setUint16(12, 45, true); // version made by
  z64view.setUint16(14, 45, true); // version needed
  z64view.setBigUint64(24, BigInt(entryCount), true); // entries on this disk
  z64view.setBigUint64(32, BigInt(entryCount), true); // total entries
  z64view.setBigUint64(40, BigInt(cdSize), true);
  z64view.setBigUint64(48, BigInt(cdOffset), true);
  z64view.setUint32(56, 0x07064b50, true); // ZIP64 EOCD locator
  z64view.setBigUint64(64, BigInt(eocdOffset), true); // record sits where the EOCD was
  z64view.setUint32(72, 1, true); // total disks

  const out = new Uint8Array(zipped.length + z64.length);
  out.set(zipped.subarray(0, eocdOffset));
  out.set(z64, eocdOffset);
  out.set(zipped.subarray(eocdOffset), eocdOffset + z64.length);
  const outView = new DataView(out.buffer);
  outView.setUint16(eocdOffset + z64.length + 8, 0xffff, true); // entries on disk
  outView.setUint16(eocdOffset + z64.length + 10, 0xffff, true); // total entries
  return out;
}

export function writePenpotBundle(bundle: PenpotBundle): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  entries['manifest.json'] = encoder.encode(JSON.stringify(bundle.manifest));
  for (const [name, data] of bundle.rawEntries) entries[name] = data;
  for (const file of bundle.files) {
    entries[`files/${file.id}.json`] = encoder.encode(JSON.stringify(file.meta));
    for (const pageId of file.data.pages) {
      const page = file.data.pagesIndex[pageId];
      if (!page) continue;
      entries[`files/${file.id}/pages/${pageId}.json`] = encoder.encode(JSON.stringify(page.meta));
      for (const [shapeId, shape] of Object.entries(page.objects)) {
        entries[`files/${file.id}/pages/${pageId}/${shapeId}.json`] = encoder.encode(JSON.stringify(shape));
      }
    }
    for (const [componentId, component] of Object.entries(file.data.components)) {
      entries[`files/${file.id}/components/${componentId}.json`] = encoder.encode(JSON.stringify(component));
    }
  }
  return withZip64Eocd(zipSync(entries), Object.keys(entries).length);
}

export function writePenpotFile(bundle: PenpotBundle, path: string): void {
  writeFileSync(path, writePenpotBundle(bundle));
}
