import kiwi from 'kiwi-schema';
import type { Schema } from 'kiwi-schema';

/**
 * Decodes the fig-kiwi payload using the schema EMBEDDED in the file itself.
 * Never hard-code field ids: the schema changes with every Figma release,
 * but files are self-describing, so compiling the bundled schema keeps the
 * reader working across versions.
 */

export interface Guid {
  sessionID: number;
  localID: number;
}

export interface ParentIndex {
  guid: Guid;
  /** Fractional-index string; siblings sort lexicographically. */
  position: string;
}

/** A NodeChange is a sparse property bag: only `guid` and `type` are reliable. */
export interface NodeChange {
  guid?: Guid;
  type?: string;
  name?: string;
  parentIndex?: ParentIndex;
  internalOnly?: boolean;
  [field: string]: unknown;
}

export interface FigMessage {
  type?: string;
  sessionID?: number;
  nodeChanges?: NodeChange[];
  blobs?: { bytes: Uint8Array }[];
  [field: string]: unknown;
}

export interface DecodedCanvas {
  schema: Schema;
  message: FigMessage;
}

export function decodeCanvas(schemaBin: Uint8Array, dataBin: Uint8Array): DecodedCanvas {
  const schema = kiwi.decodeBinarySchema(schemaBin);
  const compiled = kiwi.compileSchema(schema);
  if (typeof compiled['decodeMessage'] !== 'function') {
    throw new Error('Embedded kiwi schema has no "Message" definition');
  }
  const message = compiled['decodeMessage'](dataBin) as FigMessage;
  return { schema, message };
}
