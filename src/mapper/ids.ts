import { createHash } from 'node:crypto';

/**
 * Deterministic shape ids, replicating penpot-exporter-figma-plugin exactly:
 * UUID v5 over Figma identifiers with the standard DNS namespace. Determinism
 * is what keeps component links stable across re-exports and across files
 * (the same Figma component key always yields the same Penpot componentId).
 */

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const NAMESPACE_BYTES = Uint8Array.from(
  NAMESPACE.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)),
);

export function uuidV5(name: string): string {
  const hash = createHash('sha1');
  hash.update(NAMESPACE_BYTES);
  hash.update(Buffer.from(name, 'utf8'));
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const idCache = new Map<string, string>();

/** Figma id (possibly a "guid;guid;…" instance path) -> deterministic UUID. */
export function figmaIdToUuid(figmaId: string): string {
  let id = idCache.get(figmaId);
  if (!id) {
    id = uuidV5(figmaId);
    idCache.set(figmaId, id);
  }
  return id;
}

/**
 * id + shapeRef for a shape identified by an instance-path id.
 * Path format (mirrors the Figma plugin API after normalization):
 *   "12:34"              plain node            -> no shapeRef
 *   "12:34;56:78"        node inside instance  -> shapeRef points at "56:78"
 *   "1:2;3:4;5:6"        nested instances      -> shapeRef points at "3:4;5:6"
 * The part after the first ";" is the id of the equivalent shape one level
 * closer to the main component — exactly Penpot's copy→main linkage.
 */
export function idAttrs(figmaPathId: string, prefix = ''): { id: string; shapeRef?: string } {
  const separator = figmaPathId.indexOf(';');
  return {
    id: figmaIdToUuid(prefix + figmaPathId),
    ...(separator !== -1
      ? { shapeRef: figmaIdToUuid(prefix + figmaPathId.slice(separator + 1)) }
      : {}),
  };
}

export function resetIdCache(): void {
  idCache.clear();
}
