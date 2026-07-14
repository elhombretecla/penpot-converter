import { readFileSync, createWriteStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Writable } from 'node:stream';
import pc from 'picocolors';
import * as penpot from '@penpot/library';
import { openFig, type FigContainer } from '../fig/container.js';
import { decodeCanvas, type Guid, type NodeChange } from '../fig/kiwi.js';
import { buildTree, guidKey, type FigNode, type FigTree } from '../fig/tree.js';
import { decodePathCommands, decodeVectorNetwork, type PathSegment } from '../fig/blobs.js';
import { compose, apply, IDENTITY, type FigMatrix } from '../mapper/matrix.js';
import { shapeGeometry } from '../mapper/geometry.js';
import { convertFills, convertStrokes, paintToFill, type FigPaint } from '../mapper/paints.js';
import { convertShadows, convertBlur } from '../mapper/effects.js';
import { convertLayout, layoutItemAttrs } from '../mapper/layout.js';
import { convertText } from '../mapper/text.js';
import { figmaIdToUuid, idAttrs, resetIdCache, uuidV5 } from '../mapper/ids.js';
import { appliedFontAliases } from '../mapper/fonts.js';
import { touchedFromFields } from '../mapper/touched.js';
import { rgbToHex, type FigColor } from '../mapper/color.js';
import { VariableResolver } from '../mapper/variables.js';
import { appliedTokens, buildTokensLib } from '../mapper/tokens.js';
import { convertInteractions } from '../mapper/interactions.js';
import { ByteTicker, PencilBar } from '../ui/progress.js';

type ImageResolverFn = (paint: FigPaint) => Record<string, unknown> | undefined;

const BLEND_MODES: Record<string, string> = {
  PASS_THROUGH: 'normal',
  NORMAL: 'normal',
  DARKEN: 'darken',
  LINEAR_BURN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  LINEAR_DODGE: 'color-dodge',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

const CONSTRAINT_H: Record<string, string> = {
  MIN: 'left',
  MAX: 'right',
  CENTER: 'center',
  STRETCH: 'leftright',
  SCALE: 'scale',
};

const CONSTRAINT_V: Record<string, string> = {
  MIN: 'top',
  MAX: 'bottom',
  CENTER: 'center',
  STRETCH: 'topbottom',
  SCALE: 'scale',
};

const BOOL_TYPES: Record<string, string> = {
  UNION: 'union',
  SUBTRACT: 'difference',
  INTERSECT: 'intersection',
  XOR: 'exclude',
};

/** Node types converted through baked path geometry (fillGeometry/strokeGeometry blobs). */
const PATH_TYPES = new Set(['VECTOR', 'STAR', 'REGULAR_POLYGON', 'HIGHLIGHT']);

/** Typography fields a shared TEXT style carries (the ones convertText reads). */
const TEXT_STYLE_FIELDS = [
  'fontSize',
  'fontName',
  'textCase',
  'textDecoration',
  'lineHeight',
  'letterSpacing',
] as const;

/**
 * True when an ellipse's arcData describes a partial arc or a ring (donut)
 * rather than a plain full ellipse: pie slices, donut segments, gauges,
 * spinners. Those can't be a Penpot circle and must keep their path geometry.
 */
function isArcEllipse(node: NodeChange): boolean {
  const arc = node['arcData'] as
    | { startingAngle?: number; endingAngle?: number; innerRadius?: number }
    | undefined;
  if (!arc) return false;
  const TAU = Math.PI * 2;
  const sweep = Math.abs((arc.endingAngle ?? TAU) - (arc.startingAngle ?? 0));
  return (arc.innerRadius ?? 0) > 1e-3 || Math.abs(sweep - TAU) > 1e-3;
}

/**
 * Instance-node fields that do NOT represent user overrides of the main
 * component (structure, placement, bookkeeping).
 */
const NON_OVERRIDE_FIELDS = new Set([
  'guid',
  'phase',
  'parentIndex',
  'type',
  'name',
  'size',
  'transform',
  'symbolData',
  'derivedSymbolData',
  'derivedSymbolDataLayoutVersion',
  'symbolDescription',
  'overrideKey',
  'editInfo',
  'variableConsumptionMap',
  'parameterConsumptionMap',
  'componentPropAssignments',
  'horizontalConstraint',
  'verticalConstraint',
  'stackChildAlignSelf',
  'stackChildPrimaryGrow',
  'stackPositioning',
  'frameMaskDisabled',
  'visible',
  'opacity',
]);

const MAX_INSTANCE_DEPTH = 12;

/**
 * Fields that describe how THIS instance sits in its parent (not component
 * content). They are excluded from override detection, but the emitted shape
 * must still take them from the instance node — otherwise a hidden icon
 * instance renders visible, or a resized instance keeps the symbol's size.
 */
const PLACEMENT_FIELDS = [
  'name',
  'visible',
  'opacity',
  'size',
  'transform',
  'horizontalConstraint',
  'verticalConstraint',
  'stackChildAlignSelf',
  'stackChildPrimaryGrow',
  'stackPositioning',
  'frameMaskDisabled',
] as const;

/** Everything needed to read shapes out of one parsed .fig document. */
interface FileSource {
  name: string;
  container: FigContainer;
  blobs: { bytes: Uint8Array }[];
  resolver: VariableResolver;
  tokenNames: ReadonlyMap<string, string>;
  tree: FigTree;
  /** Shared style definitions (styleType nodes) by guid key. */
  sharedStyles: Map<string, NodeChange>;
  /** Local symbols by guid key. */
  symbols: Map<string, SymbolInfo>;
  /** Symbols matched into a previously converted file (guid key -> foreign info). */
  linked: Map<string, SymbolInfo>;
  /** Cross-file matching index ("VariantSet/Name" or plain name). */
  byQualifiedName: Map<string, SymbolInfo>;
  /** Guids of nodes on the pages actually converted (interaction targets). */
  targetGuids: Set<string>;
  /** Penpot file id, set when the file is opened in the build context. */
  fileId?: string;
  /**
   * Id namespace salt. Figma guids ("12:34") are only unique WITHIN one .fig,
   * so in multi-file bundles every file after the first salts its derived
   * UUIDs. Cross-file shapeRefs use the salt of the file that owns the target.
   */
  salt: string;
}

interface SymbolInfo {
  entry: FigNode;
  componentId: string;
  rootShapeId: string;
  componentKey: string;
  name: string;
  qualifiedName: string;
  source: FileSource;
}

interface PropRef {
  defID?: Guid;
  componentPropNodeField?: string;
}

interface PropAssignment {
  defID?: Guid;
  value?: { boolValue?: boolean; textValue?: { characters?: string }; guidValue?: Guid };
}

interface ComponentDef {
  componentId: string;
  frameId: string;
  name: string;
  path: string;
  pageId: string;
  fileId: string;
  variantId?: string;
  variantProperties?: { name: string; value: string }[];
}

/** State threaded through an instance expansion. */
interface Expansion {
  /** Instance-path prefix for ids, e.g. "12:34;" */
  chain: string;
  /** User overrides keyed by guid-path relative to this instance. */
  userOverrides: Map<string, Record<string, unknown>>;
  /** Figma-computed derived data (text layout, sizes), same keying. */
  derivedOverrides: Map<string, Record<string, unknown>>;
  depth: number;
  /** Symbol guids in the current expansion stack (cycle guard). */
  stack: Set<string>;
  /** Component property values (defID key -> assignment value), aliases included. */
  propValues: Map<string, PropAssignment['value']>;
  /** The .fig document the expanded subtree belongs to (may be another file). */
  source: FileSource;
  /**
   * Salt of the file whose emission contains this expansion's ref targets:
   * the "chain minus first element" counterpart of a node at depth N was
   * emitted while building the file that owns the symbol one level up.
   */
  refSalt: string;
  /**
   * True once a component swap (overriddenSymbolID) happened anywhere up the
   * chain. Below a swap the "path minus first element" shapeRef convention
   * would point at shapes that don't exist (the main instance expanded the
   * ORIGINAL component), so refs are re-based onto the immediate symbol's
   * main instance instead.
   */
  swapped: boolean;
  /**
   * The expansion belongs to a DETACHED instance: its component's main lives
   * on a page excluded from this (split) output, so every shapeRef/touched in
   * the subtree would dangle. Shapes are emitted as plain copies instead —
   * visually identical, no component linkage.
   */
  detached?: boolean;
}

interface ConvertStats {
  converted: Map<string, number>;
  skipped: Map<string, number>;
  missingImages: number;
  missingFonts: Set<string>;
  errors: number;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** The build context takes the media mtype from Blob.type, so sniff it. */
function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * Slide speaker notes are stored as a serialized Lexical editor state
 * (root -> block nodes -> inline nodes with a `text` field). Flattens it to
 * plain text: one line per top-level block, inline text concatenated.
 * Exported for tests.
 */
export function lexicalToPlainText(raw: string): string {
  interface LexicalNode {
    text?: unknown;
    children?: LexicalNode[];
  }
  let root: LexicalNode | undefined;
  try {
    root = (JSON.parse(raw) as { root?: LexicalNode }).root;
  } catch {
    return '';
  }
  const inlineText = (node: LexicalNode): string => {
    if (typeof node.text === 'string') return node.text;
    return (node.children ?? []).map(inlineText).join('');
  };
  return (root?.children ?? [])
    .map(inlineText)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "Prop1=A, Prop2=B" -> sorted variant properties, per the plugin's parser. */
function parseVariantName(name: string): { properties: { name: string; value: string }[]; variantName: string } {
  const map = new Map<string, string>();
  for (const pair of name.split(',')) {
    const [key, value] = pair.split('=').map((s) => s.trim());
    if (key) map.set(key, value ?? '');
  }
  const sorted = [...map.keys()].sort();
  const properties = sorted.map((key) => ({ name: key, value: map.get(key) ?? '' }));
  return {
    properties,
    // Penpot derives the variant name from the property VALUES, empty ones removed.
    variantName: properties.map((p) => p.value).filter(Boolean).join(', '),
  };
}

class Converter {
  /** Per-source media caches (hash -> registered penpot media). */
  private mediaCaches = new Map<FileSource, Map<string, Record<string, unknown> | undefined>>();
  private imageResolvers = new Map<FileSource, ImageResolverFn>();
  private components: ComponentDef[] = [];
  /** Symbols matched into other files: skip their local emission. */
  private externallyLinked = new Set<string>();
  /** Foreign files this file's shapes ended up referencing. */
  readonly linkedFiles = new Set<FileSource>();
  /** componentPropDefs forwarding chains: def guid key -> parentPropDefId guid key. */
  private propDefParents = new Map<string, string>();
  readonly stats: ConvertStats = {
    converted: new Map(),
    skipped: new Map(),
    missingImages: 0,
    missingFonts: new Set(),
    errors: 0,
  };

  /** Called once per real (non-instance-expanded) node visited: progress reporting. */
  onProgress?: () => void;
  /** Warning sink; routed through the progress bar while one is drawing. */
  onWarn: (msg: string) => void = (msg) => console.warn(msg);
  /**
   * When set (split parts converted without their component closure): symbol
   * guids whose main lives on a converted page. Instances of any OTHER symbol
   * are emitted detached — plain shapes, no component linkage — because their
   * refs would dangle. undefined = every symbol's page is present (default).
   */
  availableSymbols?: Set<string>;
  /**
   * Latent cross-file links (used with availableSymbols): symbol guid key ->
   * placeholder Penpot file id of the split part that hosts the symbol's main.
   * Instances of these symbols are emitted LINKED (shapeRef/componentId as
   * usual, componentFile = placeholder) instead of detached. The placeholder
   * survives Penpot's import untouched (only bundled file ids are remapped)
   * and is rewritten to the library's real post-import id by `relink`.
   */
  linkForeign?: Map<string, string>;

  /** Active variable modes: variable-set guid key -> mode guid key. */
  private activeModesBySet = new Map<string, string>();
  /** Flat view of activeModesBySet values, rebuilt on change. */
  private activeModes = new Set<string>();

  constructor(
    private readonly ctx: penpot.BuildContext,
    private readonly main: FileSource,
    private readonly registry: readonly FileSource[],
  ) {}

  private varResolverFor(src: FileSource): (guid: Guid) => FigColor | undefined {
    return (guid: Guid) => src.resolver.resolveColor(guid, this.activeModes);
  }

  /** Resolves a symbol guid within a source, honouring cross-file links. */
  private lookupSymbol(gk: string, src: FileSource): SymbolInfo | undefined {
    return src.linked.get(gk) ?? src.symbols.get(gk);
  }

  /** Applies a node's pinned variable modes; returns an undo function. */
  private pushModes(node: NodeChange): (() => void) | undefined {
    const entries = (node['variableModeBySetMap'] as
      | { entries?: { variableSetID?: { guid?: Guid }; variableModeID?: Guid }[] }
      | undefined)?.entries;
    if (!entries?.length) return undefined;
    const previous: [string, string | undefined][] = [];
    for (const entry of entries) {
      const setGuid = entry.variableSetID?.guid;
      const modeGuid = entry.variableModeID;
      if (!setGuid || !modeGuid) continue;
      const setKey = guidKey(setGuid);
      previous.push([setKey, this.activeModesBySet.get(setKey)]);
      this.activeModesBySet.set(setKey, guidKey(modeGuid));
    }
    this.activeModes = new Set(this.activeModesBySet.values());
    return () => {
      for (const [setKey, prior] of previous) {
        if (prior === undefined) this.activeModesBySet.delete(setKey);
        else this.activeModesBySet.set(setKey, prior);
      }
      this.activeModes = new Set(this.activeModesBySet.values());
    };
  }

  /**
   * Indexes every SYMBOL (component) in the document, including the ones on
   * the hidden "Internal Only Canvas" (copies of external-library components),
   * so instances can be expanded into full shape trees. Symbols that carry a
   * sourceLibraryKey (external copies) are then matched by qualified name
   * against files converted earlier in the same run: matches keep pointing at
   * the REAL component in that file (true cross-file links) and their local
   * copy is not emitted.
   */
  indexSymbols(): void {
    const src = this.main;
    const walk = (entry: FigNode, parentName: string | undefined, parentIsVariantSet: boolean): void => {
      const node = entry.node;
      for (const def of (node['componentPropDefs'] as { id?: Guid; parentPropDefId?: Guid }[] | undefined) ?? []) {
        if (def.id && def.parentPropDefId) {
          this.propDefParents.set(guidKey(def.id), guidKey(def.parentPropDefId));
        }
      }
      if (node.type === 'SYMBOL' && node.guid) {
        const gk = guidKey(node.guid);
        // Published components carry a stable global key; local ones fall back
        // to their guid (deterministic within re-exports of the same file).
        const componentKey = (node['key'] as string | undefined) || `local-${src.salt}${gk}`;
        const qualifiedName = parentIsVariantSet && parentName ? `${parentName}/${node.name ?? ''}` : (node.name ?? '');
        const info: SymbolInfo = {
          entry,
          componentKey,
          componentId: uuidV5(componentKey),
          rootShapeId: uuidV5(`id-${componentKey}`),
          name: node.name ?? '',
          qualifiedName,
          source: src,
        };
        src.symbols.set(gk, info);
        if (!src.byQualifiedName.has(qualifiedName)) src.byQualifiedName.set(qualifiedName, info);
      }
      for (const child of entry.children) {
        walk(child, node.name, node['isStateGroup'] === true);
      }
    };
    walk(src.tree.root, undefined, false);

    // Cross-file matching against previously converted files.
    if (this.registry.length === 0) return;
    for (const [gk, info] of src.symbols) {
      if (!info.entry.node['sourceLibraryKey']) continue;
      for (const foreign of this.registry) {
        const match = foreign.byQualifiedName.get(info.qualifiedName);
        if (match) {
          src.linked.set(gk, match);
          this.externallyLinked.add(gk);
          this.linkedFiles.add(foreign);
          bump(this.stats.converted, 'COMPONENT (linked external)');
          break;
        }
      }
    }
  }

  registerComponents(): void {
    for (const component of this.components) {
      this.ctx.addComponent(component as unknown as Record<string, unknown>);
    }
  }

  get componentCount(): number {
    return this.components.length;
  }

  getSymbolEntry(guidK: string): FigNode | undefined {
    return this.lookupSymbol(guidK, this.main)?.entry;
  }

  /** IMAGE paint -> Penpot media reference (registered once per hash and source). */
  private imageResolverFor(src: FileSource): ImageResolverFn {
    let fn = this.imageResolvers.get(src);
    if (fn) return fn;
    let cache = this.mediaCaches.get(src);
    if (!cache) {
      cache = new Map();
      this.mediaCaches.set(src, cache);
    }
    const mediaCache = cache;
    fn = (paint: FigPaint): Record<string, unknown> | undefined => {
      const hashBytes = paint.image?.hash;
      if (!hashBytes) return undefined;
      const hash = Buffer.from(hashBytes).toString('hex');

      if (mediaCache.has(hash)) return mediaCache.get(hash);

      const bytes = src.container.images.get(hash);
      let resolved: Record<string, unknown> | undefined;
      if (!bytes) {
        this.stats.missingImages++;
      } else {
        const mediaId = this.ctx.addFileMedia(
          {
            name: paint.image?.name || hash,
            width: paint.originalImageWidth ?? 1,
            height: paint.originalImageHeight ?? 1,
          },
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: sniffMime(bytes) }),
        );
        resolved = { ...this.ctx.getMediaAsImage(mediaId), keepAspectRatio: true };
      }
      mediaCache.set(hash, resolved);
      return resolved;
    };
    this.imageResolvers.set(src, fn);
    return fn;
  }

  private cornerRadii(node: NodeChange): Record<string, number> | undefined {
    if (node['rectangleCornerRadiiIndependent']) {
      return {
        r1: (node['rectangleTopLeftCornerRadius'] as number) ?? 0,
        r2: (node['rectangleTopRightCornerRadius'] as number) ?? 0,
        r3: (node['rectangleBottomRightCornerRadius'] as number) ?? 0,
        r4: (node['rectangleBottomLeftCornerRadius'] as number) ?? 0,
      };
    }
    const r = node['cornerRadius'] as number | undefined;
    if (r && r > 0) return { r1: r, r2: r, r3: r, r4: r };
    return undefined;
  }

  /** Attributes shared by every shape type. */
  private commonAttrs(node: NodeChange, abs: FigMatrix, src: FileSource, parent?: NodeChange): Record<string, unknown> {
    const size = (node['size'] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    const geom = shapeGeometry(abs, size.x, size.y);
    const blend = BLEND_MODES[(node['blendMode'] as string) ?? 'NORMAL'] ?? 'normal';

    return {
      name: node.name ?? '',
      x: geom.x,
      y: geom.y,
      width: Math.max(geom.width, 0.01),
      height: Math.max(geom.height, 0.01),
      rotation: geom.rotation,
      ...(geom.transform ? { transform: geom.transform, transformInverse: geom.transformInverse } : {}),
      ...(node['visible'] === false ? { hidden: true } : {}),
      ...(typeof node['opacity'] === 'number' && node['opacity'] !== 1 ? { opacity: node['opacity'] } : {}),
      ...(blend !== 'normal' ? { blendMode: blend } : {}),
      constraintsH: CONSTRAINT_H[(node['horizontalConstraint'] as string) ?? 'MIN'] ?? 'left',
      constraintsV: CONSTRAINT_V[(node['verticalConstraint'] as string) ?? 'MIN'] ?? 'top',
      ...layoutItemAttrs(node, parent),
      ...(() => {
        if (src !== this.main) return {}; // foreign tokens live in the other file's lib
        const tokens = appliedTokens(node, src.tokenNames);
        return tokens ? { appliedTokens: tokens } : {};
      })(),
      ...(() => {
        const interactions = convertInteractions(node, (guid) => {
          const gk = guidKey(guid);
          return src.targetGuids.has(gk) ? figmaIdToUuid(src.salt + gk) : undefined;
        });
        return interactions.length ? { interactions } : {};
      })(),
    };
  }

  private styleAttrs(node: NodeChange, src: FileSource): Record<string, unknown> {
    const resolveImage = this.imageResolverFor(src);
    const resolveVar = this.varResolverFor(src);
    const fills = convertFills(node, resolveImage, resolveVar);
    const strokes = convertStrokes(node, resolveImage, resolveVar);
    const shadows = convertShadows(node, resolveVar);
    const blur = convertBlur(node);
    return {
      fills,
      strokes,
      ...(shadows.length ? { shadow: shadows } : {}),
      ...(blur ? { blur } : {}),
      ...(this.cornerRadii(node) ?? {}),
    };
  }

  /** Raw vector-network geometry, scaled from normalizedSize units to node-local space. */
  private vectorNetworkContent(
    node: NodeChange,
    abs: FigMatrix,
    src: FileSource,
  ): { segments: PathSegment[]; fillRule: string } {
    const vectorData = node['vectorData'] as
      | { vectorNetworkBlob?: number; normalizedSize?: { x: number; y: number } }
      | undefined;
    const blobIndex = vectorData?.vectorNetworkBlob;
    if (typeof blobIndex !== 'number') return { segments: [], fillRule: 'nonzero' };
    const blob = src.blobs[blobIndex];
    if (!blob?.bytes?.length) return { segments: [], fillRule: 'nonzero' };
    const size = (node['size'] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    const normalized = vectorData?.normalizedSize ?? { x: 0, y: 0 };
    const scaleX = normalized.x > 0 ? size.x / normalized.x : 1;
    const scaleY = normalized.y > 0 ? size.y / normalized.y : 1;
    return decodeVectorNetwork(blob.bytes, scaleX, scaleY, abs);
  }

  /** Baked path geometry for vector-ish nodes: local blob coords -> canvas space. */
  private pathContent(node: NodeChange, abs: FigMatrix, geometryField: 'fillGeometry' | 'strokeGeometry', src: FileSource): PathSegment[] {
    const geometries = (node[geometryField] as { commandsBlob?: number }[] | undefined) ?? [];
    const segments: PathSegment[] = [];
    for (const geometry of geometries) {
      const blobIndex = geometry.commandsBlob;
      if (typeof blobIndex !== 'number') continue;
      const blob = src.blobs[blobIndex];
      if (!blob?.bytes?.length) continue;
      segments.push(...decodePathCommands(blob.bytes, abs));
    }
    return segments;
  }

  /**
   * True if the subtree will emit at least one shape. Needed because a Penpot
   * group gets its selrect/points from its children: a group whose content was
   * entirely skipped would export points: null and make the whole file fail
   * schema validation on import.
   */
  private subtreeConvertible(entry: FigNode, src: FileSource): boolean {
    const node = entry.node;
    const type = node.type ?? '';
    if (type === 'FRAME' || type === 'SECTION' || type === 'SYMBOL' || type === 'SLIDE') {
      if (node['resizeToFit']) return entry.children.some((c) => this.subtreeConvertible(c, src));
      return true; // boards carry their own geometry, empty is fine
    }
    if (type === 'SLIDE_GRID' || type === 'SLIDE_ROW' || type === 'MODULE') {
      return entry.children.some((c) => this.subtreeConvertible(c, src));
    }
    if (type === 'SHAPE_WITH_TEXT') {
      return Boolean(
        (node['derivedImmutableFrameData'] as { overrides?: unknown[] } | undefined)?.overrides?.length,
      );
    }
    if (type === 'INSTANCE') {
      const symbolGuid = (node['symbolData'] as { symbolID?: Guid } | undefined)?.symbolID;
      return Boolean(symbolGuid && this.lookupSymbol(guidKey(symbolGuid), src));
    }
    if (type === 'BOOLEAN_OPERATION') return entry.children.some((c) => this.subtreeConvertible(c, src));
    if (PATH_TYPES.has(type)) {
      return Boolean(
        (node['fillGeometry'] as unknown[] | undefined)?.length ||
          (node['strokeGeometry'] as unknown[] | undefined)?.length ||
          (node['vectorData'] as { vectorNetworkBlob?: number } | undefined)?.vectorNetworkBlob !== undefined,
      );
    }
    if (type === 'TEXT') {
      const textData = node['textData'] as { characters?: string } | undefined;
      return Boolean(textData?.characters);
    }
    return (
      type === 'RECTANGLE' ||
      type === 'ROUNDED_RECTANGLE' ||
      type === 'ELLIPSE' ||
      type === 'LINE' ||
      type === 'INTERACTIVE_SLIDE_ELEMENT'
    );
  }

  convertPage(canvas: FigNode, nameOverride?: string): string {
    const node = canvas.node;
    const bg = node['backgroundColor'] as FigColor | undefined;
    const pageId = this.ctx.addPage({
      name: nameOverride ?? node.name ?? 'Page',
      // Deterministic like shape ids: the builder's own ids are sequential per
      // process, which would make page ids drift between runs (the split
      // machinery re-runs the conversion per part and pages must line up).
      ...(node.guid ? { id: figmaIdToUuid(this.main.salt + guidKey(node.guid)) } : {}),
      ...(bg ? { background: rgbToHex(bg) } : {}),
    });
    this.visitChildren(canvas.children, IDENTITY, node, undefined, false);
    this.ctx.closePage();
    return pageId;
  }

  /**
   * The effective node during instance expansion: base + component-property
   * values + user overrides + Figma-derived data. Overrides address nodes by
   * their overrideKey when they have one, falling back to their guid.
   */
  private effectiveNode(entry: FigNode, exp: Expansion | undefined): {
    node: NodeChange;
    touched: string[];
  } {
    const base = entry.node;
    if (!exp || !base.guid) return { node: base, touched: [] };

    const keys: string[] = [];
    const overrideKey = base['overrideKey'] as Guid | undefined;
    if (overrideKey) keys.push(guidKey(overrideKey));
    keys.push(guidKey(base.guid));

    const lookup = (map: Map<string, Record<string, unknown>>): Record<string, unknown> | undefined => {
      for (const key of keys) {
        const hit = map.get(key);
        if (hit) return hit;
      }
      return undefined;
    };

    const user = lookup(exp.userOverrides);
    const derived = lookup(exp.derivedOverrides);
    const touched = new Set<string>(user ? touchedFromFields(Object.keys(user)) : []);

    // Component properties bound to this node (icon visibility, label text,
    // swapped sub-components) resolve against the instance's assignments.
    let propFields: Record<string, unknown> | undefined;
    for (const ref of (base['componentPropRefs'] as PropRef[] | undefined) ?? []) {
      if (!ref.defID) continue;
      const value = this.lookupPropValue(exp.propValues, guidKey(ref.defID));
      if (value === undefined) continue;
      propFields ??= {};
      switch (ref.componentPropNodeField) {
        case 'VISIBLE':
          if (typeof value.boolValue === 'boolean') {
            propFields['visible'] = value.boolValue;
            touched.add('visibility-group');
          }
          break;
        case 'TEXT_DATA':
          if (value.textValue?.characters !== undefined) {
            const baseText = (base['textData'] as Record<string, unknown> | undefined) ?? {};
            propFields['textData'] = { ...baseText, characters: value.textValue.characters, characterStyleIDs: [] };
            touched.add('text-content-text');
            touched.add('content-group');
          }
          break;
        case 'OVERRIDDEN_SYMBOL_ID':
          if (value.guidValue) propFields['overriddenSymbolID'] = value.guidValue;
          break;
      }
    }

    if (!user && !derived && !propFields) return { node: base, touched: [] };
    return {
      // Property values first, explicit overrides on top, derived data last
      // (it reflects Figma's final computed state, e.g. text layout sizes).
      node: { ...base, ...propFields, ...user, ...derived },
      touched: [...touched],
    };
  }

  /** Resolves a prop def key against assignments, following forwarding chains. */
  private lookupPropValue(
    values: Map<string, PropAssignment['value']>,
    defKey: string,
  ): PropAssignment['value'] | undefined {
    let key: string | undefined = defKey;
    for (let hops = 0; key && hops < 8; hops++) {
      if (values.has(key)) return values.get(key);
      key = this.propDefParents.get(key);
    }
    return undefined;
  }

  /**
   * Resolves shared style references (styleIdForText/Fill/StrokeFill/Effect).
   * Once a shared style is attached, Figma renders the STYLE node's values and
   * leaves the node-level fields stale (editing the style does not rewrite its
   * consumers), so the style definition must override the node's own fields.
   */
  private applySharedStyles(node: NodeChange, src: FileSource): NodeChange {
    if (
      node['styleIdForText'] === undefined &&
      node['styleIdForFill'] === undefined &&
      node['styleIdForStrokeFill'] === undefined &&
      node['styleIdForEffect'] === undefined
    ) {
      return node;
    }

    const styleNode = (field: string): NodeChange | undefined => {
      const guid = (node[field] as { guid?: Guid } | undefined)?.guid;
      return guid ? src.sharedStyles.get(guidKey(guid)) : undefined;
    };

    let merged: NodeChange | undefined;
    const put = (fields: Record<string, unknown>): void => {
      if (Object.keys(fields).length) merged = { ...(merged ?? node), ...fields };
    };

    const text = styleNode('styleIdForText');
    if (text) {
      const pick: Record<string, unknown> = {};
      for (const f of TEXT_STYLE_FIELDS) if (text[f] !== undefined) pick[f] = text[f];
      put(pick);
    }
    const fill = styleNode('styleIdForFill');
    if (fill?.['fillPaints']) put({ fillPaints: fill['fillPaints'] });
    const stroke = styleNode('styleIdForStrokeFill');
    if (stroke?.['fillPaints']) put({ strokePaints: stroke['fillPaints'] });
    const effect = styleNode('styleIdForEffect');
    if (effect?.['effects']) put({ effects: effect['effects'] });
    return merged ?? node;
  }

  /** Id/shapeRef attributes for a node at the current instance chain. */
  private nodeIds(node: NodeChange, exp: Expansion | undefined, prefix = ''): Record<string, unknown> {
    const gk = node.guid ? guidKey(node.guid) : '0:0';
    const idPath = (exp?.chain ?? '') + gk;
    const id = figmaIdToUuid(prefix + this.main.salt + idPath);
    if (exp?.detached) return { id };
    if (exp?.swapped) {
      // Below a swap, refs re-base onto the swapped component's own main.
      return { id, shapeRef: figmaIdToUuid(prefix + exp.source.salt + gk) };
    }
    const separator = idPath.indexOf(';');
    if (separator === -1) return { id };
    const refSalt = exp?.refSalt ?? this.main.salt;
    return { id, shapeRef: figmaIdToUuid(prefix + refSalt + idPath.slice(separator + 1)) };
  }

  /**
   * Visits a sibling list, honouring Figma masks: a node with mask=true clips
   * every LATER sibling, which in Penpot is a masked group whose first child
   * is the mask shape.
   */
  private visitChildren(
    children: FigNode[],
    parentAbs: FigMatrix,
    parentNode: NodeChange,
    exp: Expansion | undefined,
    insideComponent: boolean,
  ): void {
    const src = exp?.source ?? this.main;
    const maskIndex = children.findIndex(
      (c) => c.node['mask'] === true && c.node['visible'] !== false && this.subtreeConvertible(c, src),
    );
    if (maskIndex === -1) {
      for (const child of children) this.visit(child, parentAbs, parentNode, exp, insideComponent);
      return;
    }

    for (const child of children.slice(0, maskIndex)) this.visit(child, parentAbs, parentNode, exp, insideComponent);

    const masked = children.slice(maskIndex);
    if (!masked.some((c) => this.subtreeConvertible(c, src))) return;
    this.ctx.addGroup({
      name: `${masked[0].node.name ?? 'Mask'} group`,
      maskedGroup: true,
      ...this.nodeIds(masked[0].node, exp, 'M'),
    });
    // Within the masked slice, later masks nest recursively.
    this.visit(masked[0], parentAbs, parentNode, exp, insideComponent);
    this.visitChildren(masked.slice(1), parentAbs, parentNode, exp, insideComponent);
    this.ctx.closeGroup();
    bump(this.stats.converted, 'MASK GROUP');
  }

  private visit(entry: FigNode, parentAbs: FigMatrix, parentNode: NodeChange, exp: Expansion | undefined, insideComponent: boolean): void {
    if (!exp) this.onProgress?.();
    const { node: rawNode, touched } = this.effectiveNode(entry, exp);
    const src = exp?.source ?? this.main;
    const node = this.applySharedStyles(rawNode, src);
    const type = node.type ?? '<none>';
    const local = (node['transform'] as FigMatrix | undefined) ?? IDENTITY;
    const abs = compose(parentAbs, local);
    const touchedAttr = touched.length && !exp?.detached ? { touched } : {};
    const popModes = this.pushModes(node);

    try {
      switch (type) {
        case 'SLIDE_GRID':
        case 'SLIDE_ROW':
        case 'MODULE': {
          // Figma Slides scaffolding: purely positional wrappers around each
          // SLIDE (a MODULE is a 1:1 wrapper, rows/grid only place them on the
          // canvas). No shape is emitted; children keep their absolute spot.
          this.visitChildren(entry.children, abs, node, exp, insideComponent);
          break;
        }
        case 'FRAME':
        case 'SECTION':
        case 'SYMBOL':
        case 'SLIDE': {
          if (node['resizeToFit']) {
            // A frame with resizeToFit is what the Figma UI calls a group.
            if (!entry.children.some((c) => this.subtreeConvertible(c, src))) {
              bump(this.stats.skipped, 'GROUP (empty)');
              break;
            }
            this.ctx.addGroup({
              name: node.name ?? '',
              ...(node['visible'] === false ? { hidden: true } : {}),
              ...this.nodeIds(node, exp),
              ...touchedAttr,
            });
            this.visitChildren(entry.children, abs, node, exp, insideComponent);
            this.ctx.closeGroup();
            bump(this.stats.converted, 'GROUP');
            break;
          }

          const isComponent = type === 'SYMBOL' && !exp;
          if (isComponent && node.guid && this.externallyLinked.has(guidKey(node.guid))) {
            // This is a local copy of a component that lives in another file of
            // the bundle; instances point there directly, so skip the copy.
            break;
          }
          const isVariantContainer = node['isStateGroup'] === true;
          let componentAttrs: Record<string, unknown> = {};

          if (isComponent && node.guid) {
            componentAttrs = this.componentAttrs(entry, node, parentNode);
          }

          this.ctx.addBoard({
            ...this.commonAttrs(node, abs, src, parentNode),
            ...this.styleAttrs(node, src),
            ...convertLayout(node),
            ...(isComponent ? {} : this.nodeIds(node, exp)),
            ...componentAttrs,
            ...touchedAttr,
            ...(isVariantContainer ? { isVariantContainer: true } : {}),
            // Figma frames clip content unless frameMaskDisabled is set.
            showContent: node['frameMaskDisabled'] === true,
          });
          this.visitChildren(entry.children, abs, node, exp, insideComponent || isComponent);
          this.ctx.closeBoard();
          bump(this.stats.converted, isComponent ? 'COMPONENT' : isVariantContainer ? 'VARIANT SET' : type);
          if (type === 'SLIDE') this.emitSpeakerNotes(node, abs, exp, src);
          break;
        }
        case 'INSTANCE': {
          this.convertInstance(entry, node, abs, parentNode, exp, touched, insideComponent);
          break;
        }
        case 'RECTANGLE':
        case 'ROUNDED_RECTANGLE':
        // Polls, embeds, facepiles… arrive with an IMAGE fill snapshot, so a
        // plain rect preserves their rendered look.
        case 'INTERACTIVE_SLIDE_ELEMENT': {
          this.ctx.addRect({
            ...this.commonAttrs(node, abs, src, parentNode),
            ...this.styleAttrs(node, src),
            ...this.nodeIds(node, exp),
            ...touchedAttr,
          });
          bump(this.stats.converted, type === 'INTERACTIVE_SLIDE_ELEMENT' ? type : 'RECTANGLE');
          break;
        }
        case 'ELLIPSE': {
          // Pie/donut/gauge segments are ellipses with arcData; Penpot circles
          // can't represent them, so those go through the baked path geometry.
          if (isArcEllipse(node) && this.hasBakedGeometry(node, src)) {
            this.convertPathNode(node, abs, parentNode, exp, touchedAttr, src, { nativeStrokes: true });
            break;
          }
          this.ctx.addCircle({
            ...this.commonAttrs(node, abs, src, parentNode),
            ...this.styleAttrs(node, src),
            ...this.nodeIds(node, exp),
            ...touchedAttr,
          });
          bump(this.stats.converted, 'ELLIPSE');
          break;
        }
        case 'LINE': {
          const size = (node['size'] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
          const p1 = apply(abs, { x: 0, y: 0 });
          const p2 = apply(abs, { x: size.x, y: 0 });
          const strokes = convertStrokes(node, this.imageResolverFor(src), this.varResolverFor(src));
          this.ctx.addPath({
            name: node.name ?? '',
            ...(node['visible'] === false ? { hidden: true } : {}),
            ...layoutItemAttrs(node, parentNode),
            ...this.nodeIds(node, exp),
            ...touchedAttr,
            content: [
              { command: 'move-to', params: { x: p1.x, y: p1.y } },
              { command: 'line-to', params: { x: p2.x, y: p2.y } },
            ],
            fills: [],
            strokes,
          });
          bump(this.stats.converted, 'LINE');
          break;
        }
        case 'VECTOR':
        case 'STAR':
        case 'REGULAR_POLYGON':
        case 'HIGHLIGHT': {
          this.convertPathNode(node, abs, parentNode, exp, touchedAttr, src);
          break;
        }
        case 'SHAPE_WITH_TEXT': {
          this.convertShapeWithText(node, abs, parentNode, exp, touchedAttr, src);
          break;
        }
        case 'TEXT': {
          const text = convertText(node, this.imageResolverFor(src), this.stats.missingFonts, this.varResolverFor(src));
          if (!text) {
            bump(this.stats.skipped, 'TEXT (empty)');
            break;
          }
          const strokes = convertStrokes(node, this.imageResolverFor(src), this.varResolverFor(src));
          const shadows = convertShadows(node, this.varResolverFor(src));
          const blur = convertBlur(node);
          this.ctx.addText({
            ...this.commonAttrs(node, abs, src, parentNode),
            ...this.nodeIds(node, exp),
            ...touchedAttr,
            content: text.content,
            growType: text.growType,
            strokes,
            ...(shadows.length ? { shadow: shadows } : {}),
            ...(blur ? { blur } : {}),
          });
          bump(this.stats.converted, 'TEXT');
          break;
        }
        case 'BOOLEAN_OPERATION': {
          if (!entry.children.some((c) => this.subtreeConvertible(c, src))) {
            bump(this.stats.skipped, 'BOOLEAN (empty)');
            break;
          }
          const groupId = this.ctx.addGroup({
            name: node.name ?? '',
            ...(node['visible'] === false ? { hidden: true } : {}),
            ...this.nodeIds(node, exp),
            ...touchedAttr,
          });
          this.visitChildren(entry.children, abs, node, exp, insideComponent);
          this.ctx.closeGroup();
          try {
            this.ctx.addBool({
              groupId,
              type: BOOL_TYPES[(node['booleanOperation'] as string) ?? 'UNION'] ?? 'union',
              fills: convertFills(node, this.imageResolverFor(src), this.varResolverFor(src)),
              strokes: convertStrokes(node, this.imageResolverFor(src), this.varResolverFor(src)),
            });
            bump(this.stats.converted, 'BOOLEAN');
          } catch {
            // Penpot rejects boolean groups whose direct children are all
            // boards; the shapes stay as a plain group in that case.
            bump(this.stats.converted, 'BOOLEAN (as group)');
          }
          break;
        }
        default:
          bump(this.stats.skipped, type);
      }
    } catch (err) {
      this.stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      this.onWarn(`error converting "${node.name}" (${type}): ${msg}`);
    } finally {
      popModes?.();
    }
  }

  /** Component (main instance) attributes for a SYMBOL board + definition registration. */
  private componentAttrs(entry: FigNode, node: NodeChange, parentNode: NodeChange): Record<string, unknown> {
    const info = this.main.symbols.get(guidKey(node.guid!))!;

    // Variant members live inside an isStateGroup frame; their name encodes
    // the variant property values ("Prop=Value, ...").
    const isVariant = parentNode['isStateGroup'] === true && Boolean(parentNode.guid);
    let variantAttrs: Record<string, unknown> = {};
    let componentName = info.name;
    let componentPath = '';

    if (isVariant) {
      const variantId = figmaIdToUuid(guidKey(parentNode.guid!));
      const { properties, variantName } = parseVariantName(info.name);
      // Penpot's referential-integrity validator requires every variant member
      // (shape AND component definition) to carry the variant CONTAINER's name;
      // the "Prop=Value" combination only survives in variantProperties.
      const containerName = parentNode.name ?? info.name;
      variantAttrs = { variantId, variantName, variantProperties: properties, name: containerName };
      componentName = containerName;
    } else {
      const segments = info.name.split('/').map((s) => s.trim()).filter(Boolean);
      componentName = segments.at(-1) ?? info.name;
      componentPath = segments.slice(0, -1).join(' / ');
    }

    this.components.push({
      componentId: info.componentId,
      frameId: info.rootShapeId,
      name: componentName,
      path: componentPath,
      pageId: this.ctx.currentPageId,
      fileId: this.ctx.currentFileId,
      ...(isVariant
        ? {
            variantId: variantAttrs['variantId'] as string,
            variantProperties: variantAttrs['variantProperties'] as { name: string; value: string }[],
          }
        : {}),
    });

    return {
      id: info.rootShapeId,
      componentId: info.componentId,
      componentFile: this.ctx.currentFileId,
      componentRoot: true,
      mainInstance: true,
      ...variantAttrs,
    };
  }

  /** Expands an INSTANCE by cloning its SYMBOL subtree and applying overrides. */
  private convertInstance(
    entry: FigNode,
    node: NodeChange,
    abs: FigMatrix,
    parentNode: NodeChange,
    exp: Expansion | undefined,
    inheritedTouched: string[],
    insideComponent: boolean,
  ): void {
    const symbolData = node['symbolData'] as
      | { symbolID?: Guid; symbolOverrides?: Record<string, unknown>[] }
      | undefined;
    const overriddenSymbol = node['overriddenSymbolID'] as Guid | undefined;
    const symbolGuid = overriddenSymbol ?? symbolData?.symbolID;
    const src = exp?.source ?? this.main;
    const info = symbolGuid && this.lookupSymbol(guidKey(symbolGuid), src);
    if (!info) {
      bump(this.stats.skipped, 'INSTANCE (unknown symbol)');
      return;
    }
    if ((exp?.depth ?? 0) >= MAX_INSTANCE_DEPTH || exp?.stack.has(guidKey(symbolGuid!))) {
      bump(this.stats.skipped, 'INSTANCE (recursion limit)');
      return;
    }

    const symbolNode = info.entry.node;
    const gk = node.guid ? guidKey(node.guid) : '0:0';
    const pathId = (exp?.chain ?? '') + gk;
    // A swap can arrive as overriddenSymbolID OR as a wholesale symbolData
    // replacement in the override; compare the effective target against the
    // RAW tree node to catch both.
    const rawSymbolGuid = (entry.node['symbolData'] as { symbolID?: Guid } | undefined)?.symbolID;
    const swappedHere = Boolean(
      symbolGuid && rawSymbolGuid && guidKey(symbolGuid) !== guidKey(rawSymbolGuid),
    );
    const swapped = swappedHere || (exp?.swapped ?? false);

    // Split parts converted without their component closure: a head whose
    // subtree references the symbol's own main directly needs that main's
    // page in the output. That's the case for top-level instances, swapped
    // heads, and ANY head below a swap (the re-based ref convention points
    // children at the immediate symbol's main). When the page is missing, the
    // whole expansion is emitted detached — plain shapes, identical visuals.
    // A plain NESTED head only references shapes inside the outer main's copy
    // (which exists), so when just its component DEFINITION is missing it
    // keeps the positional shapeRef but sheds its component identity, exactly
    // like any non-instance descendant of a copy.
    const symbolAvailable =
      this.availableSymbols === undefined || this.availableSymbols.has(guidKey(symbolGuid!));
    // Latent link: the symbol's main lives in another split part, but the ids
    // are deterministic across parts (same .fig, same salt), so the head can
    // stay a real copy pointing at that part's placeholder file id.
    const linkedForeignFile = symbolAvailable ? undefined : this.linkForeign?.get(guidKey(symbolGuid!));
    const needsOwnMain = !exp || swappedHere || (exp?.swapped ?? false);
    const detached = Boolean(exp?.detached) || (needsOwnMain && !symbolAvailable && !linkedForeignFile);
    const stripComponent = !detached && !symbolAvailable && !linkedForeignFile;

    // Root shape: symbol defaults + content overrides + the instance's own
    // placement (visibility, size, transform, layout-child attributes).
    const rootOverrides: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!NON_OVERRIDE_FIELDS.has(key)) rootOverrides[key] = value;
    }
    const placement: Record<string, unknown> = {};
    for (const field of PLACEMENT_FIELDS) {
      if (node[field] !== undefined) placement[field] = node[field];
    }
    const merged: NodeChange = { ...symbolNode, ...rootOverrides, ...placement };

    const rootTouched = new Set<string>([...inheritedTouched, ...touchedFromFields(Object.keys(rootOverrides))]);
    if (node.name && node.name !== symbolNode.name) rootTouched.add('name-group');
    const symbolSize = symbolNode['size'] as { x: number; y: number } | undefined;
    const instSize = node['size'] as { x: number; y: number } | undefined;
    if (
      symbolSize && instSize &&
      (Math.abs(symbolSize.x - instSize.x) > 0.01 || Math.abs(symbolSize.y - instSize.y) > 0.01)
    ) {
      rootTouched.add('geometry-group');
    }
    // Positional counterpart of this instance head inside the parent's main
    // instance tree — what Penpot's validator calls the "near match". Under an
    // inherited swap the chain re-bases onto the swapped component's own main.
    const positionalRef = exp
      ? exp.swapped
        ? figmaIdToUuid(exp.source.salt + gk)
        : figmaIdToUuid(exp.refSalt + pathId.slice(pathId.indexOf(';') + 1))
      : undefined;
    if (swappedHere && exp && positionalRef) {
      // A swapped head keeps shapeRef on the NEW component's root and records
      // the original slot in a swap-slot touched entry.
      rootTouched.add(`swap-slot-${positionalRef}`);
    }

    // Overrides for the shapes inside: keyed by guid path relative to here.
    const userOverrides = new Map<string, Record<string, unknown>>();
    const derivedOverrides = new Map<string, Record<string, unknown>>();
    const addOverride = (
      target: Map<string, Record<string, unknown>>,
      list: Record<string, unknown>[] | undefined,
    ): void => {
      for (const override of list ?? []) {
        const guids = (override['guidPath'] as { guids?: Guid[] } | undefined)?.guids;
        if (!guids?.length) continue;
        const key = guids.map(guidKey).join(';');
        const { guidPath: _gp, ...fields } = override;
        target.set(key, { ...(target.get(key) ?? {}), ...fields });
      }
    };
    addOverride(userOverrides, symbolData?.symbolOverrides);
    addOverride(derivedOverrides, node['derivedSymbolData'] as Record<string, unknown>[] | undefined);

    // Self-overrides: a symbolOverride whose guidPath (length 1) addresses the
    // symbol's ROOT node (by its overrideKey or guid) overrides the expanded
    // instance head itself, not a child — e.g. clearing an inherited stroke.
    // Apply them to `merged` and drop them from the child override maps.
    const symbolRootKeys = new Set<string>();
    if (symbolNode.guid) symbolRootKeys.add(guidKey(symbolNode.guid));
    const symbolOverrideKey = symbolNode['overrideKey'] as Guid | undefined;
    if (symbolOverrideKey) symbolRootKeys.add(guidKey(symbolOverrideKey));
    const selfFields: Record<string, unknown> = {};
    for (const key of symbolRootKeys) {
      const userSelf = userOverrides.get(key);
      if (userSelf) {
        Object.assign(selfFields, userSelf);
        userOverrides.delete(key);
      }
      const derivedSelf = derivedOverrides.get(key);
      if (derivedSelf) {
        Object.assign(selfFields, derivedSelf);
        derivedOverrides.delete(key);
      }
    }
    for (const [key, value] of Object.entries(selfFields)) {
      if (!NON_OVERRIDE_FIELDS.has(key)) {
        rootOverrides[key] = value;
        Object.assign(merged, { [key]: value });
      }
    }
    for (const field of touchedFromFields(Object.keys(selfFields))) rootTouched.add(field);

    // Overrides inherited from an outer instance that address nodes through
    // THIS instance keep applying one level down (path "inst;child"). The
    // outer path may reference this instance by guid OR by overrideKey.
    if (exp && node.guid) {
      const overrideKey = node['overrideKey'] as Guid | undefined;
      const prefixes = [`${gk};`, ...(overrideKey ? [`${guidKey(overrideKey)};`] : [])];
      const inherit = (
        source: Map<string, Record<string, unknown>>,
        target: Map<string, Record<string, unknown>>,
      ): void => {
        for (const [key, value] of source) {
          for (const prefix of prefixes) {
            if (key.startsWith(prefix)) {
              const sub = key.slice(prefix.length);
              target.set(sub, { ...(target.get(sub) ?? {}), ...value });
              break;
            }
          }
        }
      };
      inherit(exp.userOverrides, userOverrides);
      inherit(exp.derivedOverrides, derivedOverrides);
    }

    // Component property assignments: this instance's own values on top of the
    // ones flowing down from outer instances. Values also register under the
    // def's forwarding parent so refs bound at any level of the chain resolve.
    const propValues = new Map<string, PropAssignment['value']>(exp?.propValues ?? []);
    for (const assignment of (node['componentPropAssignments'] as PropAssignment[] | undefined) ?? []) {
      if (!assignment.defID || assignment.value === undefined) continue;
      let key: string | undefined = guidKey(assignment.defID);
      for (let hops = 0; key && hops < 8; hops++) {
        propValues.set(key, assignment.value);
        key = this.propDefParents.get(key);
      }
    }

    const childExp: Expansion = {
      chain: `${pathId};`,
      userOverrides,
      derivedOverrides,
      depth: (exp?.depth ?? 0) + 1,
      stack: new Set([...(exp?.stack ?? []), guidKey(symbolGuid!)]),
      swapped,
      propValues,
      ...(detached ? { detached: true } : {}),
      // The component tree we are about to clone lives in the file that OWNS
      // the component (possibly another file of the bundle).
      source: info.source,
      refSalt: exp ? exp.source.salt : info.source.salt,
    };

    this.ctx.addBoard({
      ...this.commonAttrs(merged, abs, src, parentNode),
      ...this.styleAttrs(merged, info.source),
      ...convertLayout(merged),
      id: figmaIdToUuid(this.main.salt + pathId),
      ...(detached
        ? {}
        : {
            shapeRef: !exp || swappedHere ? info.rootShapeId : positionalRef,
            ...(stripComponent
              ? {}
              : {
                  componentId: info.componentId,
                  componentFile: linkedForeignFile ?? info.source.fileId ?? this.ctx.currentFileId,
                  // componentRoot is only legal OUTSIDE other components: Penpot's
                  // referential-integrity check rejects root copies nested inside mains.
                  ...(exp || insideComponent ? {} : { componentRoot: true }),
                }),
            ...(rootTouched.size ? { touched: [...rootTouched] } : {}),
          }),
      showContent: merged['frameMaskDisabled'] === true,
    });
    this.visitChildren(info.entry.children, abs, merged, childExp, true);
    this.ctx.closeBoard();
    bump(
      this.stats.converted,
      detached ? 'INSTANCE (detached)' : linkedForeignFile ? 'INSTANCE (linked foreign)' : 'INSTANCE',
    );
  }

  /**
   * Vector-ish nodes via baked geometry, matching what Penpot's own plugin
   * produces: one filled path per geometry entry, each with its winding rule
   * (svgAttrs.fillRule); strokes are baked as filled outline paths from
   * strokeGeometry instead of Penpot stroke attributes. Multiple paths get
   * wrapped in a group carrying the node's identity.
   */
  /** True if the node carries at least one decodable baked-geometry blob. */
  private hasBakedGeometry(node: NodeChange, src: FileSource): boolean {
    for (const field of ['fillGeometry', 'strokeGeometry'] as const) {
      const geometries = (node[field] as { commandsBlob?: number }[] | undefined) ?? [];
      for (const geometry of geometries) {
        if (typeof geometry.commandsBlob !== 'number') continue;
        if (src.blobs[geometry.commandsBlob]?.bytes?.length) return true;
      }
    }
    return false;
  }

  private convertPathNode(
    node: NodeChange,
    abs: FigMatrix,
    parentNode: NodeChange,
    exp: Expansion | undefined,
    touchedAttr: Record<string, unknown>,
    src: FileSource,
    opts: { nativeStrokes?: boolean } = {},
  ): void {
    const type = node.type ?? 'VECTOR';

    interface PathSpec {
      content: PathSegment[];
      fills: unknown[];
      fillRule: string;
    }
    const specs: PathSpec[] = [];

    const geometrySpecs = (field: 'fillGeometry' | 'strokeGeometry', fills: unknown[]): void => {
      const geometries = (node[field] as { commandsBlob?: number; windingRule?: string }[] | undefined) ?? [];
      for (const geometry of geometries) {
        if (typeof geometry.commandsBlob !== 'number') continue;
        const blob = src.blobs[geometry.commandsBlob];
        if (!blob?.bytes?.length) continue;
        const content = decodePathCommands(blob.bytes, abs);
        if (content.length === 0) continue;
        specs.push({
          content,
          fills,
          fillRule: geometry.windingRule === 'NONZERO' ? 'nonzero' : 'evenodd',
        });
      }
    };

    const resolveImage = this.imageResolverFor(src);
    const resolveVar = this.varResolverFor(src);
    const nodeFills = convertFills(node, resolveImage, resolveVar);
    const strokeFills =
      ((node['strokeWeight'] as number | undefined) ?? 0) > 0
        ? ((node['strokePaints'] as FigPaint[] | undefined) ?? [])
            .filter((p) => p.visible !== false)
            .map((p) => paintToFill(p, resolveImage, resolveVar))
            .filter((f): f is NonNullable<typeof f> => Boolean(f))
            .reverse()
        : [];

    geometrySpecs('fillGeometry', nodeFills);

    // Arc ellipses (pie/donut/gauge segments): their baked strokeGeometry is a
    // self-overlapping tessellation that no fill rule renders correctly, so the
    // stroke is emitted as a NATIVE Penpot stroke on the fill path instead.
    let nativeStrokes: unknown[] = [];
    if (opts.nativeStrokes && specs.length > 0) {
      if (strokeFills.length) nativeStrokes = convertStrokes(node, resolveImage, resolveVar);
    } else if (strokeFills.length) {
      geometrySpecs('strokeGeometry', strokeFills);
    }

    if (specs.length === 0) {
      // Raw vector network (common on children of boolean operations, which
      // carry no baked geometry of their own).
      const network = this.vectorNetworkContent(node, abs, src);
      if (network.segments.length) {
        specs.push({
          content: network.segments,
          fills: nodeFills.length ? nodeFills : strokeFills,
          fillRule: network.fillRule,
        });
      }
    }

    if (specs.length === 0) {
      bump(this.stats.skipped, `${type} (no geometry)`);
      return;
    }

    const shadows = convertShadows(node, resolveVar);
    const blur = convertBlur(node);
    const commonAttrs = {
      ...(node['visible'] === false ? { hidden: true } : {}),
      ...(typeof node['opacity'] === 'number' && node['opacity'] !== 1 ? { opacity: node['opacity'] } : {}),
      ...(shadows.length ? { shadow: shadows } : {}),
      ...(blur ? { blur } : {}),
    };

    if (specs.length === 1) {
      this.ctx.addPath({
        name: node.name ?? '',
        ...commonAttrs,
        ...layoutItemAttrs(node, parentNode),
        ...this.nodeIds(node, exp),
        ...touchedAttr,
        content: specs[0].content,
        fills: specs[0].fills,
        strokes: nativeStrokes,
        svgAttrs: { fillRule: specs[0].fillRule },
        constraintsH: 'scale',
        constraintsV: 'scale',
      });
    } else {
      this.ctx.addGroup({
        name: node.name ?? '',
        ...commonAttrs,
        ...layoutItemAttrs(node, parentNode),
        ...this.nodeIds(node, exp),
        ...touchedAttr,
      });
      specs.forEach((spec, index) => {
        this.ctx.addPath({
          name: 'svg-path',
          ...this.nodeIds(node, exp, `V${index}`),
          content: spec.content,
          fills: spec.fills,
          strokes: nativeStrokes,
          svgAttrs: { fillRule: spec.fillRule },
          constraintsH: 'scale',
          constraintsV: 'scale',
        });
      });
      this.ctx.closeGroup();
    }
    bump(this.stats.converted, type);
  }

  /**
   * FigJam-style "shape with text" (Slides decks use them for stickers and
   * small callouts). The node itself carries no geometry or text: the rendered
   * result lives in derivedImmutableFrameData.overrides as a synthetic subtree
   * — one override with baked fill/stroke geometry for the shape, and one text
   * override. Shape overrides merge into a single synthetic vector node run
   * through the normal path pipeline; the text override only converts when it
   * actually has characters.
   */
  private convertShapeWithText(
    node: NodeChange,
    abs: FigMatrix,
    parentNode: NodeChange,
    exp: Expansion | undefined,
    touchedAttr: Record<string, unknown>,
    src: FileSource,
  ): void {
    const overrides = (node['derivedImmutableFrameData'] as
      | { overrides?: Record<string, unknown>[] }
      | undefined)?.overrides;
    const fillGeometry: unknown[] = [];
    const strokeGeometry: unknown[] = [];
    let shapeTransform: FigMatrix = IDENTITY;
    let textNode: NodeChange | undefined;

    for (const override of overrides ?? []) {
      const textData = override['textData'] as { characters?: string } | undefined;
      if (textData || override['derivedTextData']) {
        // The text sub-node (its strokeGeometry is glyph outlines, not shape).
        if (textData?.characters) textNode = { ...node, ...override, type: 'TEXT' } as NodeChange;
        continue;
      }
      const fills = (override['fillGeometry'] as unknown[] | undefined) ?? [];
      const strokes = (override['strokeGeometry'] as unknown[] | undefined) ?? [];
      if (fills.length || strokes.length) {
        if (!fillGeometry.length && !strokeGeometry.length) {
          shapeTransform = (override['transform'] as FigMatrix | undefined) ?? IDENTITY;
        }
        fillGeometry.push(...fills);
        strokeGeometry.push(...strokes);
      }
    }

    if (!fillGeometry.length && !strokeGeometry.length && !textNode) {
      bump(this.stats.skipped, 'SHAPE_WITH_TEXT (no geometry)');
      return;
    }

    if (fillGeometry.length || strokeGeometry.length) {
      const synthetic = {
        ...node,
        fillGeometry,
        strokeGeometry,
        // Shapes usually inherit their fill from the FigJam/Slides theme
        // (styleIdForFill), which is not in the file; white is FigJam's default.
        ...(node['fillPaints']
          ? {}
          : { fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] }),
      } as NodeChange;
      this.convertPathNode(synthetic, compose(abs, shapeTransform), parentNode, exp, touchedAttr, src);
    }

    if (textNode) {
      const text = convertText(textNode, this.imageResolverFor(src), this.stats.missingFonts, this.varResolverFor(src));
      if (text) {
        const textAbs = compose(abs, (textNode['transform'] as FigMatrix | undefined) ?? IDENTITY);
        this.ctx.addText({
          ...this.commonAttrs(textNode, textAbs, src, node),
          ...this.nodeIds(node, exp, 'T'),
          content: text.content,
          growType: text.growType,
        });
        bump(this.stats.converted, 'SHAPE_WITH_TEXT (text)');
      }
    }
  }

  /**
   * Penpot has no speaker-notes concept, so a slide's notes ride along as a
   * text shape sitting right under its board: same width, an uppercase label
   * line naming the slide, note text below. The pairing is visual (position +
   * label), so it survives even if boards are later rearranged by hand.
   */
  private emitSpeakerNotes(
    node: NodeChange,
    abs: FigMatrix,
    exp: Expansion | undefined,
    src: FileSource,
  ): void {
    const raw = node['slideSpeakerNotes'];
    const notes = typeof raw === 'string' && raw ? lexicalToPlainText(raw) : '';
    if (!notes) return;

    const size = (node['size'] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    const geom = shapeGeometry(abs, size.x, size.y);
    const label = `SPEAKER NOTES — ${node.name ?? 'SLIDE'}`;
    const bodySize = 36;
    const synthetic: NodeChange = {
      type: 'TEXT',
      name: `Speaker notes — ${node.name ?? 'slide'}`,
      textData: {
        characters: `${label}\n${notes}`,
        // Style 1 = the label line (the trailing \n and the notes keep the
        // node-level default style).
        characterStyleIDs: Array.from({ length: label.length }, () => 1),
        styleOverrideTable: [
          {
            styleID: 1,
            fontSize: 26,
            fontName: { family: 'Inter', style: 'Bold' },
            letterSpacing: { value: 6, units: 'PERCENT' },
          },
        ],
      },
      fontSize: bodySize,
      fontName: { family: 'Inter', style: 'Regular' },
      lineHeight: { value: 145, units: 'PERCENT' },
      fillPaints: [
        { type: 'SOLID', color: { r: 0.45, g: 0.47, b: 0.51, a: 1 }, opacity: 1, visible: true },
      ],
      textAutoResize: 'HEIGHT',
    } as NodeChange;

    const text = convertText(synthetic, this.imageResolverFor(src), this.stats.missingFonts, this.varResolverFor(src));
    if (!text) return;
    const lineCount = `${label}\n${notes}`.split('\n').length;
    this.ctx.addText({
      name: synthetic.name,
      x: geom.x,
      y: geom.y + geom.height + 48,
      width: geom.width,
      height: Math.ceil(lineCount * bodySize * 1.45) + 16,
      growType: text.growType,
      ...this.nodeIds(node, exp, 'N'),
      content: text.content,
      strokes: [],
    });
    bump(this.stats.converted, 'SPEAKER NOTES');
  }
}

export interface ConvertOptions {
  output?: string;
  /**
   * Penpot file name override (what the file is called once imported).
   * Defaults to the .fig meta file_name. Single-input conversions only —
   * in bundles every file would get the same name.
   */
  fileName?: string;
  /**
   * Mark the output as a shared library, so it can be attached from other
   * Penpot files right after import. In multi-file bundles the library files
   * (every input but the last) are marked shared regardless.
   */
  shared?: boolean;
  /** Page names to convert (others are dropped, except pages hosting needed components). */
  pages?: string[];
  /**
   * Positions in the ordered page list (user pages first, internal canvas
   * last) to convert. Used by the split machinery, which needs to address
   * pages unambiguously when names repeat. Mutually exclusive with `pages`.
   */
  pageIndexes?: number[];
  /**
   * With `pageIndexes`: convert EXACTLY those pages (no component-closure
   * expansion) and emit instances of components hosted on excluded pages as
   * detached plain shapes. This is how split parts avoid dragging the whole
   * design system into every part.
   */
  detachForeign?: boolean;
  /**
   * With `detachForeign`: latent cross-part links. Symbol guid key ->
   * placeholder Penpot file id of the split part hosting the symbol's main.
   * Matching foreign instances are emitted as real linked copies against the
   * placeholder id instead of detached; after importing every part, the
   * `relink` command rewrites the placeholders to the real file ids and
   * creates the library relations.
   */
  linkForeign?: Map<string, string>;
  /**
   * File-level pluginData ({namespace: {key: "string value"}}), e.g. section
   * provenance so relink can locate the parts even if they are renamed.
   */
  filePluginData?: Record<string, Record<string, string>>;
  /** One-line completion message instead of the full per-type report. */
  quiet?: boolean;
}

export interface PageInfo {
  /** Position in the ordered page list — stable across runs of the same .fig. */
  index: number;
  name: string;
  /** Penpot page id, as written into the .penpot ZIP paths. */
  pageId: string;
  /** The hidden internal canvas ('External components'). */
  internal: boolean;
  /** Indexes of every page this one needs to stay self-contained (incl. itself). */
  closure: number[];
}

export interface ConvertResult {
  output: string;
  /** Size of the written .penpot, in bytes. */
  bytes: number;
  /** Converted pages, in output order. Empty for multi-file bundles. */
  pages: PageInfo[];
}

/**
 * User-facing page names of a .fig/.deck file, in canvas order. Excludes the
 * hidden internal-only canvas (external-library component copies), which is not
 * something a user would pick. Used by the interactive UI's page picker; the
 * decode is the same first step runConvert does, just without building shapes.
 */
export function listPages(file: string): string[] {
  const raw = readFileSync(file);
  const container = openFig(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  const { message } = decodeCanvas(container.schemaBin, container.dataBin);
  const tree = buildTree(message);
  return tree.root.children
    .filter((c) => c.node.type === 'CANVAS' && !c.node.internalOnly)
    .map((c) => (c.node.name ?? '').trim())
    .filter(Boolean);
}

/** Collects every symbol guid referenced anywhere in a subtree (instances, swaps, prop values). */
function collectSymbolRefs(entry: FigNode, into: Set<string>): void {
  const node = entry.node;
  const symbolID = (node['symbolData'] as { symbolID?: Guid } | undefined)?.symbolID;
  if (symbolID) into.add(guidKey(symbolID));
  const overridden = node['overriddenSymbolID'] as Guid | undefined;
  if (overridden) into.add(guidKey(overridden));
  const overrideLists = [
    (node['symbolData'] as { symbolOverrides?: Record<string, unknown>[] } | undefined)?.symbolOverrides,
    node['derivedSymbolData'] as Record<string, unknown>[] | undefined,
  ];
  for (const list of overrideLists) {
    for (const o of list ?? []) {
      const swap = o['overriddenSymbolID'] as Guid | undefined;
      if (swap) into.add(guidKey(swap));
      const innerSymbol = (o['symbolData'] as { symbolID?: Guid } | undefined)?.symbolID;
      if (innerSymbol) into.add(guidKey(innerSymbol));
      for (const a of (o['componentPropAssignments'] as PropAssignment[] | undefined) ?? []) {
        if (a.value?.guidValue) into.add(guidKey(a.value.guidValue));
      }
    }
  }
  for (const a of (node['componentPropAssignments'] as PropAssignment[] | undefined) ?? []) {
    if (a.value?.guidValue) into.add(guidKey(a.value.guidValue));
  }
  for (const child of entry.children) collectSymbolRefs(child, into);
}

/**
 * Copies only stay linked if the pages hosting their main components are
 * exported too: chase symbol references transitively and pull those pages in.
 * Returns the closure of `selected` (a superset, including `selected` itself).
 */
export function computePageClosure(
  ordered: FigNode[],
  converter: Converter,
  selected: ReadonlySet<FigNode>,
): Set<FigNode> {
  const closure = new Set(selected);
  const symbolPage = new Map<string, FigNode>();
  for (const canvas of ordered) {
    const collect = (entry: FigNode): void => {
      if (entry.node.type === 'SYMBOL' && entry.node.guid) symbolPage.set(guidKey(entry.node.guid), canvas);
      for (const child of entry.children) collect(child);
    };
    collect(canvas);
  }
  // Fixpoint: pages pulled in for their components carry demo content of
  // their own that references yet more components, so rescan until stable.
  const neededSymbols = new Set<string>();
  const scannedPages = new Set<FigNode>();
  const scannedSymbols = new Set<string>();
  for (;;) {
    let grew = false;
    for (const canvas of [...closure]) {
      if (scannedPages.has(canvas)) continue;
      scannedPages.add(canvas);
      collectSymbolRefs(canvas, neededSymbols);
      grew = true;
    }
    for (const gk of [...neededSymbols]) {
      if (scannedSymbols.has(gk)) continue;
      scannedSymbols.add(gk);
      const symEntry = converter.getSymbolEntry(gk);
      if (symEntry) collectSymbolRefs(symEntry, neededSymbols);
      grew = true;
    }
    for (const gk of neededSymbols) {
      const page = symbolPage.get(gk);
      if (page && !closure.has(page)) {
        closure.add(page);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return closure;
}

function filterPages(ordered: FigNode[], pageNames: string[], converter: Converter): FigNode[] {
  const wanted = new Set(pageNames.map((p) => p.trim().toLowerCase()));
  const selected = new Set(
    ordered.filter((c) => wanted.has((c.node.name ?? '').trim().toLowerCase())),
  );
  if (selected.size === 0) {
    throw new Error(`--pages matched no page. Available: ${ordered.map((c) => c.node.name).join(', ')}`);
  }
  const closure = computePageClosure(ordered, converter, selected);
  const filtered = ordered.filter((c) => closure.has(c));
  console.log(`page filter: converting ${filtered.length} pages (${filtered.map((c) => c.node.name).join(', ')})`);
  return filtered;
}

/**
 * Page filter by position in `ordered` (user pages first, internal canvas
 * last — stable across runs of the same .fig). The split planner hands over
 * index sets that already include each page's closure, so re-running the
 * closure here is idempotent; it stays as a safety net.
 */
function filterPagesByIndex(ordered: FigNode[], indexes: number[], converter: Converter): FigNode[] {
  const selected = new Set(indexes.filter((i) => i >= 0 && i < ordered.length).map((i) => ordered[i]));
  if (selected.size === 0) throw new Error('pageIndexes matched no page');
  const closure = computePageClosure(ordered, converter, selected);
  return ordered.filter((c) => closure.has(c));
}

/** Guid keys of every SYMBOL hosted on the given pages. */
function collectPageSymbols(pages: FigNode[]): Set<string> {
  const symbols = new Set<string>();
  const walk = (entry: FigNode): void => {
    if (entry.node.type === 'SYMBOL' && entry.node.guid) symbols.add(guidKey(entry.node.guid));
    for (const child of entry.children) walk(child);
  };
  for (const page of pages) walk(page);
  return symbols;
}

/**
 * Drops Figma's derived text-render caches (pre-rendered glyph outlines,
 * baselines, line tables). They dominate the decoded document's memory
 * footprint and the converter never reads them.
 */
function stripDerivedRenderData(nodes: NodeChange[]): void {
  const stripText = (holder: Record<string, unknown> | undefined): void => {
    if (!holder) return;
    delete holder['derivedTextData'];
    const textData = holder['textData'] as Record<string, unknown> | undefined;
    if (textData) {
      delete textData['glyphs'];
      delete textData['baselines'];
      delete textData['lines'];
    }
  };
  for (const node of nodes) {
    stripText(node as Record<string, unknown>);
    const symbolData = node['symbolData'] as { symbolOverrides?: Record<string, unknown>[] } | undefined;
    for (const override of symbolData?.symbolOverrides ?? []) stripText(override);
    for (const derived of (node['derivedSymbolData'] as Record<string, unknown>[] | undefined) ?? []) {
      stripText(derived);
    }
  }
}

export async function runConvert(inputs: string | string[], opts: ConvertOptions): Promise<ConvertResult> {
  const files = Array.isArray(inputs) ? inputs : [inputs];
  const started = performance.now();
  resetIdCache();
  appliedFontAliases.clear();

  if ((opts.pages?.length || opts.pageIndexes?.length) && files.length > 1) {
    throw new Error('--pages is only supported when converting a single .fig file');
  }
  if (opts.pages?.length && opts.pageIndexes?.length) {
    throw new Error('pages and pageIndexes are mutually exclusive');
  }
  if (opts.fileName && files.length > 1) {
    throw new Error('fileName is only supported when converting a single .fig file');
  }

  const ctx = penpot.createBuildContext();
  const bar = new PencilBar();
  const registry: FileSource[] = [];
  const converters: Converter[] = [];
  const pageInfos: PageInfo[] = [];
  let pages = 0;
  let componentCount = 0;
  let tokenCount = 0;
  let lastName = 'output';

  for (let index = 0; index < files.length; index++) {
    const input = files[index];
    const raw = readFileSync(input);
    const container = openFig(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    const { message } = decodeCanvas(container.schemaBin, container.dataBin);
    stripDerivedRenderData(message.nodeChanges ?? []);
    const tree = buildTree(message);

    // Slides exports often carry file_name "Untitled" in meta.json; the input
    // file name is more useful there (it also drives the default output name).
    const metaName = container.meta?.['file_name'] as string | undefined;
    const fileName =
      opts.fileName ??
      (metaName && metaName !== 'Untitled' ? metaName : basename(input).replace(/\.(fig|deck)$/i, ''));
    lastName = fileName;

    const resolver = new VariableResolver(message.nodeChanges ?? []);
    const tokens = buildTokensLib(message.nodeChanges ?? [], resolver);
    const source: FileSource = {
      name: fileName,
      container,
      blobs: message.blobs ?? [],
      resolver,
      tokenNames: tokens.tokenNames,
      tree,
      sharedStyles: new Map(
        (message.nodeChanges ?? [])
          .filter((n) => n.guid && typeof n['styleType'] === 'string')
          .map((n) => [guidKey(n.guid!), n]),
      ),
      symbols: new Map(),
      linked: new Map(),
      byQualifiedName: new Map(),
      targetGuids: new Set(),
      salt: index === 0 ? '' : `f${index};`,
    };

    const converter = new Converter(ctx, source, registry);
    converter.indexSymbols();

    // Every file but the last is treated as a shared library of the bundle.
    const isShared = opts.shared === true || (files.length > 1 && index < files.length - 1);
    // The builder derives file ids from the name, which collides when a bundle
    // repeats names — pin an explicit deterministic id per bundle position.
    source.fileId = ctx.addFile({
      id: uuidV5(`fig2penpot-file-${index}-${fileName}`),
      name: fileName,
      ...(isShared ? { isShared: true } : {}),
      ...(opts.filePluginData ? { pluginData: opts.filePluginData } : {}),
    });

    const canvases = tree.root.children.filter((c) => c.node.type === 'CANVAS');
    // Regular pages first, then the hidden internal canvas (external-library
    // component copies) as an explicit page so instances can link against it.
    const orderedFull = [
      ...canvases.filter((c) => !c.node.internalOnly),
      ...canvases.filter((c) => c.node.internalOnly),
    ];
    let ordered = orderedFull;

    if (opts.pages?.length) {
      ordered = filterPages(ordered, opts.pages, converter);
    } else if (opts.pageIndexes?.length) {
      if (opts.detachForeign) {
        // Exact page set, no closure: instances of components hosted on the
        // excluded pages are emitted detached instead of dragging them in.
        const wanted = new Set(opts.pageIndexes);
        ordered = orderedFull.filter((_, i) => wanted.has(i));
        if (ordered.length === 0) throw new Error('pageIndexes matched no page');
        converter.availableSymbols = collectPageSymbols(ordered);
        if (opts.linkForeign) converter.linkForeign = opts.linkForeign;
      } else {
        ordered = filterPagesByIndex(ordered, opts.pageIndexes, converter);
      }
    }

    for (const canvas of ordered) {
      const collectTargets = (entry: FigNode): void => {
        if (entry.node.guid) source.targetGuids.add(guidKey(entry.node.guid));
        for (const child of entry.children) collectTargets(child);
      };
      collectTargets(canvas);
    }

    // Progress: one tick per real node visited. Descendants of INSTANCE nodes
    // don't count — conversion expands the SYMBOL's subtree instead of them.
    const countVisitable = (entry: FigNode): number =>
      entry.node.type === 'INSTANCE'
        ? 1
        : 1 + entry.children.reduce((sum, child) => sum + countVisitable(child), 0);
    bar.addTotal(ordered.reduce((sum, canvas) => sum + countVisitable(canvas) - 1, 0));
    converter.onProgress = () => bar.tick();
    converter.onWarn = (msg) => bar.println(pc.yellow(msg));

    const indexInFull = new Map(orderedFull.map((c, i) => [c, i] as const));
    for (const canvas of ordered) {
      if (canvas.node.internalOnly && !canvas.children.some(Boolean)) continue;
      const pageId = converter.convertPage(canvas, canvas.node.internalOnly ? 'External components' : undefined);
      if (files.length === 1) {
        const closure = computePageClosure(orderedFull, converter, new Set([canvas]));
        pageInfos.push({
          index: indexInFull.get(canvas)!,
          name: canvas.node.internalOnly ? 'External components' : (canvas.node.name ?? 'Page'),
          pageId,
          internal: Boolean(canvas.node.internalOnly),
          closure: [...closure].map((c) => indexInFull.get(c)!).sort((a, b) => a - b),
        });
      }
      pages++;
    }

    converter.registerComponents();
    if (tokens.lib) ctx.addTokensLib(tokens.lib as unknown as Record<string, unknown>);
    ctx.closeFile();

    componentCount += converter.componentCount;
    tokenCount += tokens.tokenCount;
    registry.push(source);
    converters.push(converter);

    if (files.length > 1) {
      bar.println(`file "${fileName}": ${converter.componentCount} components, ${converter.linkedFiles.size} linked libraries`);
    }
  }

  // Manifest relations: consumer file -> each library file it references.
  for (let index = 0; index < converters.length; index++) {
    const consumer = registry[index];
    for (const library of converters[index].linkedFiles) {
      if (consumer.fileId && library.fileId) ctx.addRelation(consumer.fileId, library.fileId);
    }
  }

  const stats: ConvertStats = {
    converted: new Map(),
    skipped: new Map(),
    missingImages: 0,
    missingFonts: new Set(),
    errors: 0,
  };
  for (const converter of converters) {
    for (const [k, v] of converter.stats.converted) stats.converted.set(k, (stats.converted.get(k) ?? 0) + v);
    for (const [k, v] of converter.stats.skipped) stats.skipped.set(k, (stats.skipped.get(k) ?? 0) + v);
    stats.missingImages += converter.stats.missingImages;
    for (const f of converter.stats.missingFonts) stats.missingFonts.add(f);
    stats.errors += converter.stats.errors;
  }

  // The build context now holds copies of everything the export needs
  // (addFileMedia wraps image bytes in its own Blob), so the source-side
  // graph — decoded kiwi nodes, trees, image blobs, symbol indexes — is dead
  // weight. Release it before the export allocates the output ZIP on top.
  converters.length = 0;
  registry.length = 0;

  bar.done();
  const output = opts.output ?? `${lastName}.penpot`;
  const out = createWriteStream(output);
  const ticker = new ByteTicker(`writing ${output}…`);
  ticker.start(() => out.bytesWritten);
  try {
    await penpot.exportStream(ctx, Writable.toWeb(out) as WritableStream);
  } finally {
    ticker.stop();
  }
  const bytes = statSync(output).size;

  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  const total = [...stats.converted.values()].reduce((a, b) => a + b, 0);
  const totalSkipped = [...stats.skipped.values()].reduce((a, b) => a + b, 0);
  const result: ConvertResult = { output, bytes, pages: pageInfos };

  if (opts.quiet) {
    console.log(`wrote ${output} in ${elapsed}s  (${pages} pages, ${total} shapes)`);
    return result;
  }

  console.log(`\nwrote ${output} in ${elapsed}s  (${files.length} files, ${pages} pages, ${total} shapes, ${componentCount} components, ${tokenCount} tokens)`);
  console.log('\nconverted:');
  for (const [type, count] of [...stats.converted.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(24)} ${count.toLocaleString()}`);
  }
  if (stats.skipped.size) {
    console.log(`\nskipped (not yet supported): ${totalSkipped.toLocaleString()}`);
    for (const [type, count] of [...stats.skipped.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(24)} ${count.toLocaleString()}`);
    }
  }
  if (appliedFontAliases.size) {
    console.log(`\nfont aliases applied (system fonts mapped to Google Fonts):`);
    for (const [from, to] of [...appliedFontAliases.entries()].sort()) {
      console.log(`  ${from} -> ${to}`);
    }
  }
  if (stats.missingFonts.size) {
    console.log(`\nfonts not in Google Fonts/Penpot catalogs (upload manually in Penpot):`);
    console.log(`  ${[...stats.missingFonts].sort().join(', ')}`);
  }
  if (stats.missingImages) console.log(`\nmissing images: ${stats.missingImages}`);
  if (stats.errors) console.log(`node errors: ${stats.errors}`);
  return result;
}
