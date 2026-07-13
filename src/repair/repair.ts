import {
  detachShape,
  getChildrenIdsWithSelf,
  getChildrenInInstance,
  getComponent,
  getComponentShapes,
  getFrame,
  getHeadShape,
  getComponentShape,
  getSwapSlot,
  removeSwapSlot,
  reheadShape,
  resolveComponentFile,
  setSwapSlot,
  setTouchedGroup,
  unheadShape,
  type Libraries,
} from './helpers.js';
import {
  UUID_ZERO,
  type Component,
  type ErrorCode,
  type Page,
  type PenpotFile,
  type Shape,
  type ValidationError,
} from './model.js';

/**
 * Port of app.common.files.repair: one handler per error code. Where Penpot
 * builds a changes list (pcb/*) and applies it later, here handlers mutate the
 * in-memory file directly and describe what they did; the validate→repair loop
 * in runRepair.ts provides the same eventual convergence.
 */

export interface RepairAction {
  code: ErrorCode;
  shapeId?: string;
  pageId?: string;
  /** What the handler did, e.g. "set parentId to <root>". */
  detail: string;
  /** False when the code has no confident automatic fix (matches Penpot's warnings). */
  repaired: boolean;
}

interface RepairContext {
  file: PenpotFile;
  libraries: Libraries;
  actions: RepairAction[];
}

type RepairHandler = (error: ValidationError, ctx: RepairContext) => void;

function pageOf(ctx: RepairContext, error: ValidationError): Page | undefined {
  return error.pageId != null ? ctx.file.data.pagesIndex[error.pageId] : undefined;
}

function shapeOf(ctx: RepairContext, error: ValidationError): Shape | undefined {
  const page = pageOf(ctx, error);
  return error.shapeId != null ? page?.objects[error.shapeId] : undefined;
}

function act(ctx: RepairContext, error: ValidationError, detail: string, repaired = true): void {
  ctx.actions.push({
    code: error.code,
    ...(error.shapeId != null ? { shapeId: error.shapeId } : {}),
    ...(error.pageId != null ? { pageId: error.pageId } : {}),
    detail,
    repaired,
  });
}

/** cts/setup-rect over the minimal geometry Penpot resets broken shapes to. */
function resetGeometry(shape: Shape): void {
  const x = 0;
  const y = 0;
  const width = 0.01;
  const height = 0.01;
  shape.x = x;
  shape.y = y;
  shape.width = width;
  shape.height = height;
  shape.selrect = { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height };
  shape.points = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

/** pcb/change-parent: move the shape under a new parent, fixing links and frame-id. */
function changeParent(page: Page, shape: Shape, newParentId: string): void {
  for (const candidate of Object.values(page.objects)) {
    if (candidate.id !== shape.id && candidate.shapes?.includes(shape.id)) {
      candidate.shapes = candidate.shapes.filter((id) => id !== shape.id);
    }
  }
  const parent = page.objects[newParentId];
  if (parent) {
    parent.shapes = [...(parent.shapes ?? []), shape.id];
    shape.parentId = newParentId;
    shape.frameId = parent.type === 'frame' ? parent.id : (parent.frameId ?? UUID_ZERO);
  } else {
    shape.parentId = UUID_ZERO;
    shape.frameId = UUID_ZERO;
  }
}

function detachWithChildren(page: Page, shape: Shape): number {
  const ids = getChildrenIdsWithSelf(page.objects, shape.id);
  for (const id of ids) {
    const child = page.objects[id];
    if (child) detachShape(child);
  }
  return ids.length;
}

function cannotRepair(error: ValidationError, ctx: RepairContext): void {
  act(ctx, error, 'cannot repair this automatically', false);
}

function variantNotRepaired(error: ValidationError, ctx: RepairContext): void {
  act(ctx, error, 'variant error code, not auto-repaired for now', false);
}

const handlers: Partial<Record<ErrorCode, RepairHandler>> = {
  'invalid-geometry': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    resetGeometry(shape);
    act(ctx, error, 'reset geometry to x=0 y=0 w=0.01 h=0.01');
  },

  'parent-not-found': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.parentId = UUID_ZERO;
    act(ctx, error, `set parentId to ${UUID_ZERO}`);
  },

  'child-not-in-parent': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    const parent = shape?.parentId != null ? page?.objects[shape.parentId] : undefined;
    if (!shape || !parent) return;
    parent.shapes = [...(parent.shapes ?? []), shape.id];
    act(ctx, error, `added ${shape.id} to children of ${parent.id}`);
  },

  'duplicated-children': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.shapes = [...new Set(shape.shapes ?? [])];
    act(ctx, error, 'removed duplicated children');
  },

  'child-not-found': (error, ctx) => {
    // Here the error's shape is the parent; args carries the missing child id.
    const shape = shapeOf(ctx, error);
    const childId = error.args?.['childId'];
    if (!shape || typeof childId !== 'string') return;
    shape.shapes = (shape.shapes ?? []).filter((id) => id !== childId);
    act(ctx, error, `removed missing child ${childId}`);
  },

  'invalid-parent': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    const parentId = error.args?.['parentId'];
    if (!page || !shape || typeof parentId !== 'string') return;
    changeParent(page, shape, parentId);
    act(ctx, error, `moved under parent ${parentId}`);
  },

  'frame-not-found': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    if (!page || !shape) return;
    const frame = getFrame(page.objects, shape.parentId);
    shape.frameId = frame?.id ?? UUID_ZERO;
    act(ctx, error, `set frameId to ${shape.frameId}`);
  },

  'invalid-frame': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    if (!page || !shape) return;
    const frame = getFrame(page.objects, shape.parentId);
    shape.frameId = frame?.id ?? UUID_ZERO;
    act(ctx, error, `set frameId to ${shape.frameId}`);
  },

  'component-not-main': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.mainInstance = true;
    act(ctx, error, 'set mainInstance');
  },

  'component-main-external': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.componentFile = ctx.file.id;
    act(ctx, error, 'set componentFile to local file');
  },

  'component-not-found': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    if (!page || !shape) return;
    const count = detachWithChildren(page, shape);
    act(ctx, error, `detached shape and children (${count} shapes)`);
  },

  'invalid-main-instance-id': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    const component = getComponent(ctx.file, shape.componentId);
    if (component && !component.deleted) {
      component.mainInstanceId = shape.id;
      act(ctx, error, `assigned mainInstanceId of component ${component.id} to ${shape.id}`);
    } else {
      detachShape(shape);
      act(ctx, error, 'detached shape');
    }
  },

  'invalid-main-instance-page': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    const component = shape ? getComponent(ctx.file, shape.componentId, true) : undefined;
    if (!component || error.pageId == null) return;
    component.mainInstancePage = error.pageId;
    act(ctx, error, `assigned mainInstancePage of component ${component.id} to ${error.pageId}`);
  },

  'invalid-main-instance': cannotRepair,

  'component-main': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    delete shape.mainInstance;
    act(ctx, error, 'unset mainInstance');
  },

  'should-be-component-root': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.componentRoot = true;
    act(ctx, error, 'set componentRoot');
  },

  'should-not-be-component-root': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    delete shape.componentRoot;
    act(ctx, error, 'unset componentRoot');
  },

  'ref-shape-not-found': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    if (!page || !shape) return;
    const matching = findMatchingRefShape(ctx, page, shape);
    if (matching) {
      shape.shapeRef = matching.id;
      act(ctx, error, `reassigned shapeRef to ${matching.id}`);
    } else {
      const count = detachWithChildren(page, shape);
      act(ctx, error, `detached shape and children (${count} shapes)`);
    }
  },

  'ref-shape-is-not-head': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    unheadShape(shape);
    act(ctx, error, 'unheaded shape (removed nested copy status)');
  },

  'component-id-mismatch': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    const componentId = error.args?.['componentId'];
    const componentFile = error.args?.['componentFile'];
    if (typeof componentId === 'string') shape.componentId = componentId;
    else delete shape.componentId;
    if (typeof componentFile === 'string') shape.componentFile = componentFile;
    else delete shape.componentFile;
    act(ctx, error, `set componentId/componentFile to the near main's (${componentId}/${componentFile})`);
  },

  'ref-shape-is-head': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    const componentFile = error.args?.['componentFile'];
    const componentId = error.args?.['componentId'];
    reheadShape(
      shape,
      typeof componentFile === 'string' ? componentFile : undefined,
      typeof componentId === 'string' ? componentId : undefined,
    );
    act(ctx, error, 'reheaded shape (added component info)');
  },

  'shape-ref-cycle': (error, ctx) => {
    // Only seen on deleted components: detach the full instances that host
    // the self-referencing shapes inside the component's objects snapshot.
    const component = error.shape as Component | undefined;
    const target = component?.id != null ? ctx.file.data.components[component.id] : undefined;
    const objects = target?.objects;
    const cyclesIds = error.args?.['cyclesIds'];
    if (!target || !objects || !Array.isArray(cyclesIds)) return;
    const headIds = new Set<string>();
    for (const id of cyclesIds) {
      const shape = typeof id === 'string' ? objects[id] : undefined;
      if (!shape) continue;
      const head = getHeadShape(objects, shape);
      if (head) headIds.add(head.id);
    }
    let count = 0;
    for (const headId of headIds) {
      for (const shape of getChildrenInInstance(objects, headId)) {
        detachShape(shape);
        count++;
      }
    }
    act(ctx, error, `detached ${count} shapes in component objects`);
  },

  'shape-ref-in-main': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    delete shape.shapeRef;
    act(ctx, error, 'unset shapeRef');
  },

  'root-main-not-allowed': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    delete shape.componentRoot;
    act(ctx, error, 'unset componentRoot (converted to nested main head)');
  },

  'nested-main-not-allowed': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    if (!page || !shape) return;
    shape.componentRoot = true;
    changeParent(page, shape, UUID_ZERO);
    act(ctx, error, 'set componentRoot and moved to root (converted to top main head)');
  },

  'root-copy-not-allowed': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    delete shape.componentRoot;
    act(ctx, error, 'unset componentRoot (converted to nested copy head)');
  },

  'nested-copy-not-allowed': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.componentRoot = true;
    act(ctx, error, 'set componentRoot (converted to top copy root)');
  },

  'not-head-main-not-allowed': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    detachShape(shape);
    act(ctx, error, 'detached shape');
  },

  'not-head-copy-not-allowed': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    detachShape(shape);
    act(ctx, error, 'detached shape');
  },

  'not-component-not-allowed': cannotRepair,

  'instance-head-not-frame': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.type = 'frame';
    shape.fills = [];
    shape.hideInViewer = true;
    shape.r1 = 0;
    shape.r2 = 0;
    shape.r3 = 0;
    shape.r4 = 0;
    act(ctx, error, 'converted shape to frame');
  },

  'component-nil-objects-not-allowed': (error, ctx) => {
    const component = error.shape as Component | undefined;
    const target = component?.id != null ? ctx.file.data.components[component.id] : undefined;
    if (!target) return;
    if (target.deleted) {
      target.objects = {};
      act(ctx, error, 'set component objects to {}');
    } else {
      delete target.objects;
      act(ctx, error, 'removed component objects');
    }
  },

  'non-deleted-component-cannot-have-objects': (error, ctx) => {
    const component = error.shape as Component | undefined;
    const target = component?.id != null ? ctx.file.data.components[component.id] : undefined;
    if (!target || target.deleted) return;
    delete target.objects;
    act(ctx, error, 'removed component objects');
  },

  'invalid-text-touched': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    shape.touched = setTouchedGroup(shape.touched, 'content-group');
    act(ctx, error, 'added content-group to touched');
  },

  'misplaced-slot': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    if (!shape) return;
    removeSwapSlot(shape);
    act(ctx, error, 'removed swap slot');
  },

  'duplicate-slot': (error, ctx) => {
    const page = pageOf(ctx, error);
    const shape = shapeOf(ctx, error);
    if (!page || !shape) return;
    const duplicates = childrenWithDuplicateSlot(shape, page.objects);
    for (const child of duplicates) removeSwapSlot(child);
    act(ctx, error, `removed swap slot from ${duplicates.length} duplicated children`);
  },

  'component-duplicate-slot': (error, ctx) => {
    const component = error.shape as Component | undefined;
    const target = component?.id != null ? ctx.file.data.components[component.id] : undefined;
    const objects = target?.objects;
    const main = objects && target?.mainInstanceId != null ? objects[target.mainInstanceId] : undefined;
    if (!objects || !main) return;
    const duplicates = childrenWithDuplicateSlot(main, objects);
    for (const child of duplicates) removeSwapSlot(child);
    act(ctx, error, `removed swap slot from ${duplicates.length} duplicated children`);
  },

  'missing-slot': (error, ctx) => {
    const shape = shapeOf(ctx, error);
    const slot = error.args?.['swapSlot'];
    if (!shape || typeof slot !== 'string') return;
    setSwapSlot(shape, slot);
    act(ctx, error, `set swap slot to ${slot}`);
  },

  'not-a-variant': variantNotRepaired,
  'invalid-variant-id': variantNotRepaired,
  'invalid-variant-properties': variantNotRepaired,
  'variant-not-main': variantNotRepaired,
  'parent-not-variant': variantNotRepaired,
  'variant-bad-name': variantNotRepaired,
  'variant-bad-variant-name': variantNotRepaired,
  'variant-component-bad-name': variantNotRepaired,
  'variant-component-bad-id': variantNotRepaired,
};

/** Children of `shape` that repeat a swap slot another sibling already holds. */
function childrenWithDuplicateSlot(shape: Shape, objects: Record<string, Shape>): Shape[] {
  const seen = new Set<string>();
  const duplicates: Shape[] = [];
  for (const childId of shape.shapes ?? []) {
    const child = objects[childId];
    if (!child) continue;
    const slot = getSwapSlot(child);
    if (slot == null) continue;
    if (seen.has(slot)) duplicates.push(child);
    else seen.add(slot);
  }
  return duplicates;
}

/**
 * The :ref-shape-not-found reassignment strategy from repair.cljc: try the
 * remote main's ref chain, then a random page shape's ref, then a fostered
 * copy's direct main — otherwise the caller detaches.
 */
function findMatchingRefShape(ctx: RepairContext, page: Page, shape: Shape): Shape | undefined {
  const componentShapesOf = (head: Shape | undefined): Shape[] => {
    if (!head) return [];
    const componentFile = resolveComponentFile(head, ctx.file, ctx.libraries);
    if (!componentFile) return [];
    const component = getComponent(componentFile, head.componentId, true);
    return getComponentShapes(componentFile, component);
  };

  const rootShape = getComponentShape(page.objects, shape);
  const rootComponentShapes = componentShapesOf(rootShape);

  // Does the shape point at the remote main? Reassign to the near main.
  const nearShape1 = rootComponentShapes.find((s) => s.shapeRef === shape.shapeRef);
  if (nearShape1) return nearShape1;

  // Does it point at some random shape in the page? Follow that shape's own
  // ref into the near main.
  const randomShape = shape.shapeRef != null ? page.objects[shape.shapeRef] : undefined;
  if (!randomShape) return undefined;
  const nearShape2 = rootComponentShapes.find((s) => s.id === randomShape.shapeRef);
  if (nearShape2) return nearShape2;

  // Fostered copy: look for a direct main via the nearest head.
  const headShape = getHeadShape(page.objects, shape);
  const headComponentShapes = componentShapesOf(headShape);
  return headComponentShapes.find((s) => s.id === randomShape.shapeRef);
}

/**
 * Apply the repair handlers to a list of validation errors, mutating `file`.
 * Unknown codes hit the default handler and are reported unrepaired.
 */
export function repairFile(
  file: PenpotFile,
  errors: ValidationError[],
  libraries: Libraries = new Map(),
): { file: PenpotFile; actions: RepairAction[] } {
  const ctx: RepairContext = { file, libraries, actions: [] };
  for (const error of errors) {
    const handler = handlers[error.code];
    if (handler) handler(error, ctx);
    else act(ctx, error, 'unknown error code, no repair handler', false);
  }
  return { file, actions: ctx.actions };
}
