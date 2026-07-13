import {
  UUID_ZERO,
  type Component,
  type PenpotFile,
  type Page,
  type Shape,
} from './model.js';

/**
 * Ports of the Penpot helpers that validate.cljc / repair.cljc lean on
 * (app.common.types.component, .container, .file and files.helpers), over the
 * camelCase JSON export model.
 */

export type Libraries = Map<string, PenpotFile>;

// ---------------------------------------------------------------------------
// app.common.files.helpers (cfh)
// ---------------------------------------------------------------------------

export function isRoot(shape: Shape): boolean {
  return shape.id === UUID_ZERO;
}

export function isPathShape(shape: Shape): boolean {
  return shape.type === 'path';
}

export function isBoolShape(shape: Shape): boolean {
  return shape.type === 'bool';
}

/** First frame at or above `id` walking the parent chain (cfh/get-frame). */
export function getFrame(objects: Record<string, Shape>, id: string | undefined): Shape | undefined {
  let current = id != null ? objects[id] : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.type === 'frame') return current;
    seen.add(current.id);
    current = current.parentId != null ? objects[current.parentId] : undefined;
  }
  return undefined;
}

/** Ancestors of `id`, nearest first, root excluded from cycles (cfh/get-parents). */
export function getParents(objects: Record<string, Shape>, id: string): Shape[] {
  const parents: Shape[] = [];
  const seen = new Set<string>([id]);
  let current = objects[id];
  while (current && current.parentId != null && !seen.has(current.parentId)) {
    const parent = objects[current.parentId];
    if (!parent) break;
    parents.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return parents;
}

/** The shape and every transitive child, in preorder (cfh/get-children-ids-with-self). */
export function getChildrenIdsWithSelf(objects: Record<string, Shape>, id: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const walk = (shapeId: string): void => {
    if (seen.has(shapeId)) return;
    seen.add(shapeId);
    result.push(shapeId);
    const shape = objects[shapeId];
    for (const childId of shape?.shapes ?? []) walk(childId);
  };
  walk(id);
  return result;
}

// ---------------------------------------------------------------------------
// app.common.types.component (ctk)
// ---------------------------------------------------------------------------

export function instanceRoot(shape: Shape): boolean {
  return shape.componentRoot === true;
}

export function instanceHead(shape: Shape): boolean {
  return shape.componentId != null;
}

export function mainInstance(shape: Shape): boolean {
  return shape.mainInstance === true;
}

export function inComponentCopy(shape: Shape): boolean {
  return shape.shapeRef != null;
}

export function isVariant(item: Shape | Component): boolean {
  return item.variantId != null;
}

export function isVariantContainer(shape: Shape | undefined): boolean {
  return shape?.isVariantContainer === true;
}

const SWAP_SLOT_PREFIX = 'swap-slot-';

function isSwapSlotGroup(group: string): boolean {
  return group.startsWith(SWAP_SLOT_PREFIX);
}

/** Swap slot id from the :touched group "swap-slot-<uuid>", if any. */
export function getSwapSlot(shape: Shape | undefined): string | undefined {
  const group = shape?.touched?.find(isSwapSlotGroup);
  return group ? group.slice(SWAP_SLOT_PREFIX.length) : undefined;
}

export function setSwapSlot(shape: Shape, swapSlot: string): void {
  shape.touched = setTouchedGroup(shape.touched, SWAP_SLOT_PREFIX + swapSlot);
}

export function removeSwapSlot(shape: Shape): void {
  shape.touched = (shape.touched ?? []).filter((group) => !isSwapSlotGroup(group));
}

/** Touched groups that are not swap slots (ctk/normal-touched-groups). */
export function normalTouchedGroups(shape: Shape): Set<string> {
  return new Set((shape.touched ?? []).filter((group) => !isSwapSlotGroup(group)));
}

export function setTouchedGroup(touched: string[] | undefined, group: string): string[] {
  const groups = touched ?? [];
  return groups.includes(group) ? groups : [...groups, group];
}

/** Remove all component links, leaving a plain shape (ctk/detach-shape). */
export function detachShape(shape: Shape): void {
  delete shape.componentId;
  delete shape.componentFile;
  delete shape.componentRoot;
  delete shape.mainInstance;
  delete shape.remoteSynced;
  delete shape.shapeRef;
  delete shape.touched;
}

/** Drop head status but keep :shape-ref/:touched of a nested copy (ctk/unhead-shape). */
export function unheadShape(shape: Shape): void {
  delete shape.componentRoot;
  delete shape.componentFile;
  delete shape.componentId;
  delete shape.mainInstance;
}

/** Make the shape a component head again (ctk/rehead-shape). */
export function reheadShape(shape: Shape, componentFile: string | undefined, componentId: string | undefined): void {
  if (componentFile != null) shape.componentFile = componentFile;
  if (componentId != null) shape.componentId = componentId;
}

// ---------------------------------------------------------------------------
// app.common.types.container (ctn)
// ---------------------------------------------------------------------------

/** Nearest shape (self included) up the parent chain that is an instance head. */
export function getHeadShape(objects: Record<string, Shape>, shape: Shape): Shape | undefined {
  let current: Shape | undefined = shape;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (instanceHead(current)) return current;
    seen.add(current.id);
    current = current.parentId != null ? objects[current.parentId] : undefined;
  }
  return undefined;
}

/** Nearest shape (self included) up the parent chain that is an instance root. */
export function getComponentShape(objects: Record<string, Shape>, shape: Shape): Shape | undefined {
  let current: Shape | undefined = shape;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (instanceRoot(current)) return current;
    seen.add(current.id);
    current = current.parentId != null ? objects[current.parentId] : undefined;
  }
  return undefined;
}

/**
 * True when the shape belongs to a main-instance subtree: its nearest head
 * ancestor (self included) is a main instance (ctn/inside-component-main?).
 */
export function insideComponentMain(objects: Record<string, Shape>, shape: Shape): boolean {
  const head = getHeadShape(objects, shape);
  return head != null && mainInstance(head);
}

/** Every shape of the subtree rooted at `id` that carries a shape-ref. */
export function getChildrenInInstance(objects: Record<string, Shape>, id: string): Shape[] {
  return getChildrenIdsWithSelf(objects, id)
    .map((childId) => objects[childId])
    .filter((shape): shape is Shape => shape != null);
}

// ---------------------------------------------------------------------------
// app.common.types.file (ctf) / components-list (ctkl)
// ---------------------------------------------------------------------------

export function getComponent(
  file: PenpotFile,
  componentId: string | undefined,
  includeDeleted = false,
): Component | undefined {
  if (componentId == null) return undefined;
  const component = file.data.components[componentId];
  if (!component) return undefined;
  if (component.deleted && !includeDeleted) return undefined;
  return component;
}

/** File that hosts the shape's componentFile: the local file or a library. */
export function resolveComponentFile(
  shape: { componentFile?: string },
  file: PenpotFile,
  libraries: Libraries,
): PenpotFile | undefined {
  if (shape.componentFile == null || shape.componentFile === file.id) return file;
  return libraries.get(shape.componentFile);
}

/** ctf/resolve-component: the component a head shape points to. */
export function resolveComponent(
  shape: Shape,
  file: PenpotFile,
  libraries: Libraries,
  includeDeleted = false,
): Component | undefined {
  const componentFile = resolveComponentFile(shape, file, libraries);
  if (!componentFile) return undefined;
  return getComponent(componentFile, shape.componentId, includeDeleted);
}

export function getComponentPage(file: PenpotFile, component: Component): Page | undefined {
  return component.mainInstancePage != null
    ? file.data.pagesIndex[component.mainInstancePage]
    : undefined;
}

/**
 * ctf/get-component-shapes: the shapes making up a component — the deleted
 * snapshot's objects, or the main-instance subtree on its page.
 */
export function getComponentShapes(file: PenpotFile, component: Component | undefined): Shape[] {
  if (!component) return [];
  if (component.deleted) return Object.values(component.objects ?? {});
  const page = getComponentPage(file, component);
  if (!page || component.mainInstanceId == null) return [];
  return getChildrenInInstance(page.objects, component.mainInstanceId);
}

/**
 * ctn/get-parent-heads: every instance head among the shape's ancestors
 * (self included), in top-down order — outermost component first.
 */
export function getParentHeads(objects: Record<string, Shape>, shape: Shape): Shape[] {
  const heads: Shape[] = [];
  let current: Shape | undefined = shape;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (instanceHead(current)) heads.push(current);
    seen.add(current.id);
    current = current.parentId != null ? objects[current.parentId] : undefined;
  }
  return heads.reverse();
}

/**
 * ctf/find-ref-shape: locate the nearest component that contains the shape
 * referenced by the instance shape — trying every ancestor head's component
 * top-down, exactly as `(some find-ref-shape-in-head (get-parent-heads …))`.
 */
export function findRefShape(
  file: PenpotFile,
  page: Page,
  libraries: Libraries,
  shape: Shape,
): Shape | undefined {
  if (shape.shapeRef == null) return undefined;
  for (const head of getParentHeads(page.objects, shape)) {
    const componentFile = resolveComponentFile(head, file, libraries);
    if (!componentFile) continue;
    const component = getComponent(componentFile, head.componentId, true);
    const found = getComponentShapes(componentFile, component).find(
      (candidate) => candidate.id === shape.shapeRef,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * ctf/find-near-match (simplified): the shape in the near main that occupies
 * the same position as `shape` — matched via the parent's ref shape children.
 * Used only to detect swapped copies missing their swap slot.
 */
export function findNearMatch(
  file: PenpotFile,
  page: Page,
  libraries: Libraries,
  shape: Shape,
): Shape | undefined {
  const parent = shape.parentId != null ? page.objects[shape.parentId] : undefined;
  if (!parent || parent.shapeRef == null) return undefined;
  const parentRef = findRefShape(file, page, libraries, parent);
  if (!parentRef) return undefined;
  const head = getHeadShape(page.objects, parent);
  if (!head) return undefined;
  const componentFile = resolveComponentFile(head, file, libraries);
  if (!componentFile) return undefined;
  const component = getComponent(componentFile, head.componentId, true);
  const componentShapes = getComponentShapes(componentFile, component);
  const byId = new Map(componentShapes.map((s) => [s.id, s] as const));
  const position = (parent.shapes ?? []).indexOf(shape.id);
  if (position < 0) return undefined;
  const matchId = (parentRef.shapes ?? [])[position];
  return matchId != null ? byId.get(matchId) : undefined;
}
