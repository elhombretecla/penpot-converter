import { unzipSync, inflateSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';

/**
 * Low-level access to a Figma "save local copy" file.
 *
 * A modern .fig is a ZIP wrapping:
 *   canvas.fig       -> the fig-kiwi binary (schema + data chunks)
 *   meta.json        -> file name, thumbnail info
 *   thumbnail.png
 *   images/<sha1>    -> raw image blobs, keyed by SHA-1 hex of their bytes
 *
 * Older exports are a bare canvas.fig (no ZIP). Both are supported.
 */
export interface FigContainer {
  magic: string;
  fileVersion: number;
  schemaBin: Uint8Array;
  dataBin: Uint8Array;
  /** Chunks beyond schema+data, kept for forward compatibility. */
  extraChunks: Uint8Array[];
  meta: Record<string, unknown> | null;
  thumbnail: Uint8Array | null;
  /** sha1 hex -> raw image bytes */
  images: Map<string, Uint8Array>;
}

const KNOWN_MAGICS = ['fig-kiwi', 'fig-jam.', 'fig-make'];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function isZip(buf: Uint8Array): boolean {
  return buf[0] === 0x50 && buf[1] === 0x4b;
}

function isZstd(buf: Uint8Array): boolean {
  return ZSTD_MAGIC.every((b, i) => buf[i] === b);
}

/** Per-chunk compression is auto-detected: zstd (newer files) or raw deflate. */
function decompressChunk(chunk: Uint8Array): Uint8Array {
  if (isZstd(chunk)) return zstdDecompress(chunk);
  return inflateSync(chunk);
}

function parseCanvas(buf: Uint8Array): Pick<FigContainer, 'magic' | 'fileVersion' | 'schemaBin' | 'dataBin' | 'extraChunks'> {
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  if (!KNOWN_MAGICS.includes(magic)) {
    throw new Error(`Not a fig-kiwi file (magic: ${JSON.stringify(magic)})`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fileVersion = view.getUint32(8, true);

  const chunks: Uint8Array[] = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const len = view.getUint32(off, true);
    off += 4;
    if (off + len > buf.length) {
      throw new Error(`Corrupt chunk at offset ${off - 4}: declared ${len} bytes, ${buf.length - off} available`);
    }
    chunks.push(buf.subarray(off, off + len));
    off += len;
  }
  if (chunks.length < 2) {
    throw new Error(`Expected at least 2 chunks (schema + data), found ${chunks.length}`);
  }

  return {
    magic,
    fileVersion,
    schemaBin: decompressChunk(chunks[0]),
    dataBin: decompressChunk(chunks[1]),
    extraChunks: chunks.slice(2).map(decompressChunk),
  };
}

export function openFig(buf: Uint8Array): FigContainer {
  let canvas = buf;
  let meta: Record<string, unknown> | null = null;
  let thumbnail: Uint8Array | null = null;
  const images = new Map<string, Uint8Array>();

  if (isZip(buf)) {
    const entries = unzipSync(buf);
    const canvasEntry = entries['canvas.fig'];
    if (!canvasEntry) throw new Error('ZIP does not contain canvas.fig — not a .fig file');
    canvas = canvasEntry;
    if (entries['meta.json']) {
      meta = JSON.parse(new TextDecoder().decode(entries['meta.json']));
    }
    thumbnail = entries['thumbnail.png'] ?? null;
    for (const [path, data] of Object.entries(entries)) {
      if (path.startsWith('images/') && path.length > 'images/'.length) {
        images.set(path.slice('images/'.length), data);
      }
    }
  }

  return { ...parseCanvas(canvas), meta, thumbnail, images };
}
