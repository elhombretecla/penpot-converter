/**
 * Logical model of a .penpot file for validation/repair, mirroring the data
 * model of Penpot's backend (app.common.files.*) over the plain-JSON export
 * layout that @penpot/library produces:
 *
 *   manifest.json                                {type, version, files: [{id, name, features}], relations}
 *   files/<fileId>.json                          file metadata (features, name, options…)
 *   files/<fileId>/pages/<pageId>.json           {id, name, background, index}
 *   files/<fileId>/pages/<pageId>/<shapeId>.json one shape per entry, camelCase keys
 *   files/<fileId>/components/<componentId>.json component metadata
 *   objects/, files/<fileId>/media/, tokens.json binary/asset entries (preserved verbatim)
 *
 * Clojure kebab-case keywords map to the camelCase keys of the export
 * (:parent-id -> parentId, :main-instance-id -> mainInstanceId, …) and the
 * :touched set becomes a JSON array of group names.
 */

/** Root shape id of every page (uuid/zero in Penpot). */
export const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

/** Error codes ported 1:1 from app.common.files.validate/error-codes. */
export const ERROR_CODES = [
  'invalid-geometry',
  'parent-not-found',
  'child-not-in-parent',
  'duplicated-children',
  'child-not-found',
  'frame-not-found',
  'invalid-frame',
  'component-duplicate-slot',
  'component-not-main',
  'component-main-external',
  'component-not-found',
  'duplicate-slot',
  'invalid-main-instance-id',
  'invalid-main-instance-page',
  'invalid-main-instance',
  'invalid-parent',
  'component-main',
  'should-be-component-root',
  'should-not-be-component-root',
  'ref-shape-not-found',
  'ref-shape-is-head',
  'ref-shape-is-not-head',
  'shape-ref-in-main',
  'component-id-mismatch',
  'root-main-not-allowed',
  'nested-main-not-allowed',
  'root-copy-not-allowed',
  'nested-copy-not-allowed',
  'not-head-main-not-allowed',
  'not-head-copy-not-allowed',
  'not-component-not-allowed',
  'component-nil-objects-not-allowed',
  'non-deleted-component-cannot-have-objects',
  'instance-head-not-frame',
  'invalid-text-touched',
  'misplaced-slot',
  'missing-slot',
  'shape-ref-cycle',
  'not-a-variant',
  'invalid-variant-id',
  'invalid-variant-properties',
  'variant-not-main',
  'parent-not-variant',
  'variant-bad-name',
  'variant-bad-variant-name',
  'variant-component-bad-name',
  'variant-component-bad-id',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Selrect {
  x: number;
  y: number;
  width: number;
  height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A shape as stored in the export. Only the fields the validator/repairer
 * touches are typed; everything else rides along untyped so a repaired file
 * loses nothing.
 */
export interface Shape {
  id: string;
  name?: string;
  type?: string;
  parentId?: string;
  frameId?: string;
  /** Ordered ids of children. */
  shapes?: string[];
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  selrect?: Selrect | null;
  points?: Point[] | null;
  componentId?: string;
  componentFile?: string;
  componentRoot?: boolean;
  mainInstance?: boolean;
  shapeRef?: string;
  /** Touched sync groups; swap slots are entries of the form "swap-slot-<uuid>". */
  touched?: string[];
  isVariantContainer?: boolean;
  variantId?: string;
  variantName?: string;
  variantProperties?: { name: string; value: string }[];
  [key: string]: unknown;
}

export interface Component {
  id: string;
  name?: string;
  path?: string;
  mainInstanceId?: string;
  mainInstancePage?: string;
  deleted?: boolean;
  /** Only present on deleted components: a full shapeId -> shape snapshot. */
  objects?: Record<string, Shape> | null;
  variantId?: string;
  variantProperties?: { name: string; value: string }[];
  [key: string]: unknown;
}

export interface PageMeta {
  id: string;
  name?: string;
  background?: string;
  /** Document-order position; `pages` is derived by sorting on it. */
  index?: number;
  [key: string]: unknown;
}

export interface Page {
  id: string;
  meta: PageMeta;
  /** shapeId -> shape; the root is the shape with id UUID_ZERO. */
  objects: Record<string, Shape>;
}

export interface PenpotFileData {
  /** Ordered page ids (by page meta index). */
  pages: string[];
  pagesIndex: Record<string, Page>;
  components: Record<string, Component>;
}

export interface PenpotFile {
  id: string;
  name?: string;
  features: string[];
  /** Raw parsed files/<id>.json, preserved and rewritten as-is. */
  meta: Record<string, unknown>;
  data: PenpotFileData;
}

export interface PenpotBundle {
  /** Raw parsed manifest.json. */
  manifest: Record<string, unknown>;
  /** Files in manifest order. A bundle may carry several (libraries + consumers). */
  files: PenpotFile[];
  /**
   * Every ZIP entry that is not a shape/page/component/file-meta/manifest
   * (media, objects/, tokens.json…), kept verbatim for round-trip.
   */
  rawEntries: Map<string, Uint8Array>;
}

export interface ValidationError {
  code: ErrorCode;
  hint: string;
  fileId: string;
  pageId?: string;
  shapeId?: string;
  /** Extra per-code context (parentId, childId, swapSlot…), as in Penpot's :args. */
  args?: Record<string, unknown>;
  /**
   * The offending shape — or, for component-level errors, the component
   * (repair.cljc: "in this error the :shape argument is the component").
   */
  shape?: Shape | Component;
}
