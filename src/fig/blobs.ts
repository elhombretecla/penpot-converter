import { apply, type FigMatrix, type Point } from '../mapper/matrix.js';

/**
 * Decodes Figma "commandsBlob" path data (the derived/baked geometry stored in
 * fillGeometry / strokeGeometry / glyphs) into Penpot path content segments.
 *
 * Blob layout: a stream of [opcode: u8][float32 LE coordinate pairs]:
 *   0 = ClosePath, 1 = MoveTo (1 pt), 2 = LineTo (1 pt),
 *   3 = QuadTo (2 pts), 4 = CubicTo (3 pts)
 * Coordinates are in node-local space; `transform` maps them to canvas space.
 */

export interface PathSegment {
  command: 'move-to' | 'line-to' | 'curve-to' | 'close-path';
  params?: Record<string, number>;
}

/**
 * 0.01px precision. Full float64 coordinates triple the JSON weight of big
 * vector paths (and of the whole export) for no visible difference, which
 * bloats the network batches Penpot's import worker uploads.
 */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Figma occasionally bakes degenerate segments with NaN coordinates into
 * derived geometry (seen in fillGeometry of icon vectors). JSON serializes
 * NaN as null, which Penpot's import backend rejects with an NPE, so those
 * segments are dropped — Figma renders them as nothing anyway.
 */
function pushSegment(
  segments: PathSegment[],
  command: PathSegment['command'],
  params?: Record<string, number>,
): void {
  if (params && !Object.values(params).every(Number.isFinite)) return;
  segments.push(params ? { command, params } : { command });
}

interface NetworkVertex {
  x: number;
  y: number;
}

interface NetworkSegment {
  v1: number;
  t1x: number;
  t1y: number;
  v2: number;
  t2x: number;
  t2y: number;
}

/**
 * Decodes a raw "vectorNetworkBlob" (vectorData on VECTOR nodes that carry no
 * baked fillGeometry/strokeGeometry — commonly children of boolean ops).
 *
 * Layout: u32 vertexCount, u32 segmentCount, u32 regionCount;
 * vertices (u32 styleID, f32 x, f32 y); segments (u32 styleID, u32 v1,
 * f32 t1x, f32 t1y, u32 v2, f32 t2x, f32 t2y); regions (u32 winding|style<<1,
 * u32 loopCount, loops: u32 count + u32 segmentIndices[]).
 * Coordinates are in normalizedSize units; scaleX/Y map them to node-local
 * space, and `transform` maps local to canvas space.
 */
export interface DecodedNetwork {
  segments: PathSegment[];
  fillRule: 'evenodd' | 'nonzero';
}

export function decodeVectorNetwork(
  bytes: Uint8Array,
  scaleX: number,
  scaleY: number,
  transform: FigMatrix,
): DecodedNetwork {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const u32 = () => { const v = view.getUint32(off, true); off += 4; return v; };
  const f32 = () => { const v = view.getFloat32(off, true); off += 4; return v; };

  const vertexCount = u32();
  const segmentCount = u32();
  const regionCount = u32();

  const vertices: NetworkVertex[] = [];
  for (let i = 0; i < vertexCount; i++) {
    u32(); // styleID
    vertices.push({ x: f32() * scaleX, y: f32() * scaleY });
  }

  const segments: NetworkSegment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    u32(); // styleID
    const v1 = u32();
    const t1x = f32() * scaleX;
    const t1y = f32() * scaleY;
    const v2 = u32();
    const t2x = f32() * scaleX;
    const t2y = f32() * scaleY;
    segments.push({ v1, t1x, t1y, v2, t2x, t2y });
  }

  const loops: { segs: NetworkSegment[]; closed: boolean }[] = [];
  const used = new Set<number>();

  let fillRule: 'evenodd' | 'nonzero' = 'nonzero';
  for (let r = 0; r < regionCount; r++) {
    const flags = u32();
    // Bit 0 set = NONZERO, clear = ODD (even-odd).
    if (r === 0) fillRule = flags % 2 ? 'nonzero' : 'evenodd';
    const loopCount = u32();
    for (let l = 0; l < loopCount; l++) {
      const count = u32();
      const indices: number[] = [];
      for (let i = 0; i < count; i++) indices.push(u32());
      const segs = indices
        .filter((i) => i < segments.length)
        .map((i) => {
          used.add(i);
          return { ...segments[i] };
        });
      if (segs.length) loops.push({ segs: orientChain(segs), closed: true });
    }
  }

  // Segments not referenced by any region form open strokes.
  const leftovers = segments.filter((_, i) => !used.has(i)).map((s) => ({ ...s }));
  for (const chain of chainSegments(leftovers)) {
    const closed = chain.length > 1 && chain[0].v1 === chain[chain.length - 1].v2;
    loops.push({ segs: chain, closed });
  }

  const result: PathSegment[] = [];
  for (const { segs, closed } of loops) {
    if (!segs.length) continue;
    const start = vertices[segs[0].v1];
    if (!start) continue;
    const p0 = apply(transform, start);
    pushSegment(result, 'move-to', { x: round(p0.x), y: round(p0.y) });
    for (const seg of segs) {
      const a = vertices[seg.v1];
      const b = vertices[seg.v2];
      if (!a || !b) continue;
      if (seg.t1x === 0 && seg.t1y === 0 && seg.t2x === 0 && seg.t2y === 0) {
        const p = apply(transform, b);
        pushSegment(result, 'line-to', { x: round(p.x), y: round(p.y) });
      } else {
        const c1 = apply(transform, { x: a.x + seg.t1x, y: a.y + seg.t1y });
        const c2 = apply(transform, { x: b.x + seg.t2x, y: b.y + seg.t2y });
        const p = apply(transform, b);
        pushSegment(result, 'curve-to', {
          c1x: round(c1.x), c1y: round(c1.y), c2x: round(c2.x), c2y: round(c2.y), x: round(p.x), y: round(p.y),
        });
      }
    }
    if (closed) result.push({ command: 'close-path' });
  }
  return { segments: result, fillRule };
}

function swapSegment(seg: NetworkSegment): void {
  [seg.v1, seg.v2] = [seg.v2, seg.v1];
  [seg.t1x, seg.t2x] = [seg.t2x, seg.t1x];
  [seg.t1y, seg.t2y] = [seg.t2y, seg.t1y];
}

/** Orients the segments of a loop so each one starts where the previous ended. */
function orientChain(segs: NetworkSegment[]): NetworkSegment[] {
  if (segs.length > 1) {
    const second = segs[1];
    if (segs[0].v2 !== second.v1 && segs[0].v2 !== second.v2) swapSegment(segs[0]);
  }
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].v1 !== segs[i - 1].v2) swapSegment(segs[i]);
  }
  return segs;
}

/** Greedily chains loose segments into connected polylines. */
function chainSegments(segs: NetworkSegment[]): NetworkSegment[][] {
  const chains: NetworkSegment[][] = [];
  const pool = [...segs];
  while (pool.length) {
    const chain = [pool.shift()!];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1].v2;
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i];
        if (cand.v1 === tail || cand.v2 === tail) {
          if (cand.v2 === tail) swapSegment(cand);
          chain.push(cand);
          pool.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

export function decodePathCommands(bytes: Uint8Array, transform: FigMatrix): PathSegment[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments: PathSegment[] = [];
  let off = 0;
  let current: Point = { x: 0, y: 0 };

  const readPoint = (): Point => {
    const p = { x: view.getFloat32(off, true), y: view.getFloat32(off + 4, true) };
    off += 8;
    return p;
  };

  while (off < bytes.length) {
    const op = bytes[off];
    off += 1;
    switch (op) {
      case 0:
        segments.push({ command: 'close-path' });
        break;
      case 1: {
        current = readPoint();
        const p = apply(transform, current);
        pushSegment(segments, 'move-to', { x: round(p.x), y: round(p.y) });
        break;
      }
      case 2: {
        current = readPoint();
        const p = apply(transform, current);
        pushSegment(segments, 'line-to', { x: round(p.x), y: round(p.y) });
        break;
      }
      case 3: {
        // Quadratic curve: promote to cubic (Penpot paths only store cubics).
        const q = readPoint();
        const end = readPoint();
        const c1 = { x: current.x + (2 / 3) * (q.x - current.x), y: current.y + (2 / 3) * (q.y - current.y) };
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
        const tc1 = apply(transform, c1);
        const tc2 = apply(transform, c2);
        const tEnd = apply(transform, end);
        pushSegment(segments, 'curve-to', {
          c1x: round(tc1.x), c1y: round(tc1.y), c2x: round(tc2.x), c2y: round(tc2.y), x: round(tEnd.x), y: round(tEnd.y),
        });
        current = end;
        break;
      }
      case 4: {
        const c1 = apply(transform, readPoint());
        const c2 = apply(transform, readPoint());
        const end = readPoint();
        const tEnd = apply(transform, end);
        pushSegment(segments, 'curve-to', {
          c1x: round(c1.x), c1y: round(c1.y), c2x: round(c2.x), c2y: round(c2.y), x: round(tEnd.x), y: round(tEnd.y),
        });
        current = end;
        break;
      }
      default:
        // Unknown opcode: the rest of the stream cannot be framed reliably.
        return segments;
    }
  }
  return segments;
}
