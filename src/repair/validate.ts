import {
  findNearMatch,
  findRefShape,
  getComponent,
  getComponentPage,
  getParents,
  getSwapSlot,
  inComponentCopy,
  insideComponentMain,
  instanceHead,
  instanceRoot,
  isBoolShape,
  isPathShape,
  isRoot,
  isVariant,
  isVariantContainer,
  mainInstance,
  normalTouchedGroups,
  resolveComponent,
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
 * Port of app.common.files.validate: referential-integrity and semantic
 * checks over a file's pages and components. Pure — never mutates the file.
 */

type Context =
  | 'not-component'
  | 'main-top'
  | 'main-nested'
  | 'copy-top'
  | 'copy-nested'
  | 'main-any'
  | 'copy-any';

const MAIN_CONTEXTS: ReadonlySet<Context> = new Set(['main-top', 'main-nested', 'main-any']);
const COPY_CONTEXTS: ReadonlySet<Context> = new Set(['copy-top', 'copy-nested', 'copy-any']);

class Validator {
  readonly errors: ValidationError[] = [];

  constructor(
    private readonly file: PenpotFile,
    private readonly libraries: Libraries,
  ) {}

  private report(
    code: ErrorCode,
    hint: string,
    shape: Shape | Component | undefined,
    page: Page | undefined,
    args?: Record<string, unknown>,
  ): void {
    this.errors.push({
      code,
      hint,
      fileId: this.file.id,
      ...(page ? { pageId: page.id } : {}),
      ...(shape?.id != null ? { shapeId: shape.id } : {}),
      ...(shape ? { shape } : {}),
      ...(args && Object.keys(args).length > 0 ? { args } : {}),
    });
  }

  private libraryExists(shape: Shape): boolean {
    return shape.componentFile === this.file.id || this.libraries.has(shape.componentFile ?? '');
  }

  // -------------------------------------------------------------------------
  // shape-level checks
  // -------------------------------------------------------------------------

  private checkGeometry(shape: Shape, page: Page): void {
    if (isPathShape(shape) || isBoolShape(shape)) return;
    if (
      shape.x == null ||
      shape.y == null ||
      shape.width == null ||
      shape.height == null ||
      shape.selrect == null ||
      shape.points == null
    ) {
      this.report('invalid-geometry', 'Shape geometry is invalid', shape, page);
    }
  }

  private checkParentChildren(shape: Shape, page: Page): void {
    const parent = shape.parentId != null ? page.objects[shape.parentId] : undefined;
    if (!parent) {
      this.report('parent-not-found', `Parent ${shape.parentId} not found`, shape, page);
      return;
    }
    if (!isRoot(shape) && !(parent.shapes ?? []).includes(shape.id)) {
      this.report('child-not-in-parent', `Shape ${shape.id} not in parent's children list`, shape, page);
    }
    const children = shape.shapes ?? [];
    if (new Set(children).size !== children.length) {
      this.report('duplicated-children', `Shape ${shape.id} has duplicated children`, shape, page);
    }
    for (const childId of children) {
      const child = page.objects[childId];
      if (!child) {
        this.report('child-not-found', `Child ${childId} not found in parent ${shape.id}`, shape, page, {
          parentId: shape.id,
          childId,
        });
      } else if (child.parentId !== shape.id) {
        this.report('invalid-parent', `Child ${childId} has invalid parent ${shape.id}`, child, page, {
          parentId: shape.id,
        });
      }
    }
  }

  private checkFrame(shape: Shape, page: Page): void {
    const frame = shape.frameId != null ? page.objects[shape.frameId] : undefined;
    if (!frame) {
      this.report('frame-not-found', `Frame ${shape.frameId} not found`, shape, page);
      return;
    }
    if (frame.type !== 'frame') {
      this.report('invalid-frame', `Frame ${shape.frameId} is not actually a frame`, shape, page);
      return;
    }
    const parent = shape.parentId != null ? page.objects[shape.parentId] : undefined;
    if (!parent) return;
    if (parent.type === 'frame') {
      if (shape.frameId !== parent.id) {
        this.report('invalid-frame', `Frame-id should point to parent ${parent.id}`, shape, page);
      }
    } else if (shape.frameId !== parent.frameId) {
      this.report('invalid-frame', `Frame-id should point to parent frame ${shape.frameId}`, shape, page);
    }
  }

  private checkComponentMainHead(shape: Shape, page: Page): void {
    if (shape.mainInstance == null) {
      this.report('component-not-main', 'Shape expected to be main instance', shape, page);
    }
    if (shape.componentFile !== this.file.id) {
      this.report(
        'component-main-external',
        'Main instance should refer to a component in the same file',
        shape,
        page,
      );
    }
    const component = resolveComponent(shape, this.file, this.libraries, true);
    if (!component) {
      this.report(
        'component-not-found',
        `Component ${shape.componentId} not found in file ${shape.componentFile}`,
        shape,
        page,
      );
      return;
    }
    if (component.mainInstanceId !== shape.id) {
      this.report(
        'invalid-main-instance-id',
        `Main instance id of component ${shape.componentId} is not valid`,
        shape,
        page,
      );
    }
    if (component.mainInstancePage !== page.id) {
      // The same component may have main instances in different pages; in
      // that case one of them shouldn't be main.
      const componentPage = getComponentPage(this.file, component);
      const mainShape =
        componentPage && component.mainInstanceId != null
          ? componentPage.objects[component.mainInstanceId]
          : undefined;
      if (mainShape?.mainInstance) {
        this.report('component-main', 'Shape not expected to be main instance', shape, page);
      } else {
        this.report(
          'invalid-main-instance-page',
          `Main instance page of component ${shape.componentId} is not valid`,
          shape,
          page,
        );
      }
    }
  }

  private checkComponentNotMainHead(shape: Shape, page: Page): void {
    if (shape.mainInstance === true) {
      this.report('component-not-main', 'Shape not expected to be main instance', shape, page);
    }
    const libraryExists = this.libraryExists(shape);
    const component = libraryExists ? resolveComponent(shape, this.file, this.libraries, true) : undefined;
    if (!component) {
      if (libraryExists) {
        this.report(
          'component-not-found',
          `Component ${shape.componentId} not found in file ${shape.componentFile}`,
          shape,
          page,
        );
      }
    } else if (component.mainInstanceId === shape.id && component.mainInstancePage === page.id) {
      this.report(
        'invalid-main-instance',
        `Main instance of component ${component.id} should not be this shape`,
        shape,
        page,
      );
    }
  }

  private checkComponentNotMainNotHead(shape: Shape, page: Page): void {
    if (shape.mainInstance === true) {
      this.report('component-main', 'Shape not expected to be main instance', shape, page);
    }
    if (shape.componentId != null || shape.componentFile != null) {
      this.report('component-main', 'Shape not expected to be component head', shape, page);
    }
  }

  private checkComponentRoot(shape: Shape, page: Page): void {
    if (shape.componentRoot == null) {
      this.report('should-be-component-root', 'Shape should be component root', shape, page);
    }
  }

  private checkComponentNotRoot(shape: Shape, page: Page): void {
    if (shape.componentRoot === true) {
      this.report('should-not-be-component-root', 'Shape should not be component root', shape, page);
    }
  }

  private checkComponentRef(shape: Shape, page: Page): void {
    if (!this.libraryExists(shape)) return;
    if (!findRefShape(this.file, page, this.libraries, shape)) {
      this.report(
        'ref-shape-not-found',
        `Referenced shape ${shape.shapeRef} not found in near component`,
        shape,
        page,
      );
    }
  }

  private checkComponentNotRef(shape: Shape, page: Page): void {
    if (shape.shapeRef != null) {
      this.report('shape-ref-in-main', 'Shape inside main instance should not have shape-ref', shape, page);
    }
  }

  private checkRefIsNotHead(shape: Shape, page: Page): void {
    const refShape = findRefShape(this.file, page, this.libraries, shape);
    if (refShape && instanceHead(refShape)) {
      this.report(
        'ref-shape-is-head',
        `Referenced shape ${shape.shapeRef} is a component, so the copy must also be`,
        shape,
        page,
      );
    }
  }

  private checkRefIsHead(shape: Shape, page: Page): void {
    const refShape = findRefShape(this.file, page, this.libraries, shape);
    if (refShape && !instanceHead(refShape)) {
      this.report(
        'ref-shape-is-not-head',
        `Referenced shape ${shape.shapeRef} of a head copy must also be a head`,
        shape,
        page,
        { componentFile: refShape.componentFile, componentId: refShape.componentId },
      );
    }
  }

  private checkRefComponentId(shape: Shape, page: Page): void {
    if (getSwapSlot(shape) != null) return;
    const refShape = findRefShape(this.file, page, this.libraries, shape);
    if (!refShape) return;
    if (shape.componentId !== refShape.componentId || shape.componentFile !== refShape.componentFile) {
      this.report(
        'component-id-mismatch',
        'Nested copy component-id and component-file must be the same as the near main',
        shape,
        page,
        { componentId: refShape.componentId, componentFile: refShape.componentFile },
      );
    }
  }

  private checkEmptySwapSlot(shape: Shape, page: Page): void {
    if (getSwapSlot(shape) != null) {
      this.report('misplaced-slot', 'This shape should not have swap slot', shape, page);
    }
  }

  private hasDuplicateSwapSlot(shape: Shape, objects: Record<string, Shape>): boolean {
    const seen = new Set<string>();
    for (const childId of shape.shapes ?? []) {
      const slot = getSwapSlot(objects[childId]);
      if (slot == null) continue;
      if (seen.has(slot)) return true;
      seen.add(slot);
    }
    return false;
  }

  private checkDuplicateSwapSlot(shape: Shape, page: Page): void {
    if (this.hasDuplicateSwapSlot(shape, page.objects)) {
      this.report('duplicate-slot', 'This shape has children with the same swap slot', shape, page);
    }
  }

  private checkRequiredSwapSlot(shape: Shape, page: Page): void {
    if (getSwapSlot(shape) != null) return;
    const nearMatch = findNearMatch(this.file, page, this.libraries, shape);
    if (nearMatch && shape.shapeRef !== nearMatch.id) {
      this.report('missing-slot', 'Shape has been swapped, should have swap slot', shape, page, {
        swapSlot: getSwapSlot(nearMatch) ?? nearMatch.id,
      });
    }
  }

  private checkValidTouched(shape: Shape, page: Page): void {
    const groups = normalTouchedGroups(shape);
    const contentTouched = groups.has('content-group');
    const textTouched =
      groups.has('text-content-text') ||
      groups.has('text-content-attribute') ||
      groups.has('text-content-structure');
    if (textTouched && !contentTouched) {
      this.report(
        'invalid-text-touched',
        'This shape has text type touched but not content touched',
        shape,
        page,
      );
    }
  }

  // -------------------------------------------------------------------------
  // per-role recursions
  // -------------------------------------------------------------------------

  private checkShapeMainRootTop(shape: Shape, page: Page): void {
    this.checkComponentMainHead(shape, page);
    this.checkComponentRoot(shape, page);
    this.checkComponentNotRef(shape, page);
    this.checkEmptySwapSlot(shape, page);
    this.checkDuplicateSwapSlot(shape, page);
    for (const childId of shape.shapes ?? []) this.checkShape(childId, page, 'main-top');
  }

  private checkShapeMainRootNested(shape: Shape, page: Page): void {
    this.checkComponentMainHead(shape, page);
    this.checkComponentNotRoot(shape, page);
    this.checkComponentNotRef(shape, page);
    this.checkEmptySwapSlot(shape, page);
    for (const childId of shape.shapes ?? []) this.checkShape(childId, page, 'main-nested');
  }

  private checkShapeCopyRootTop(shape: Shape, page: Page): void {
    const libraryExists = this.libraryExists(shape);
    this.checkComponentNotMainHead(shape, page);
    this.checkComponentRoot(shape, page);
    this.checkComponentRef(shape, page);
    this.checkRefIsHead(shape, page);
    this.checkEmptySwapSlot(shape, page);
    this.checkDuplicateSwapSlot(shape, page);
    this.checkValidTouched(shape, page);
    for (const childId of shape.shapes ?? []) this.checkShape(childId, page, 'copy-top', libraryExists);
  }

  private checkShapeCopyRootNested(shape: Shape, page: Page, libraryExists: boolean): void {
    this.checkComponentNotMainHead(shape, page);
    this.checkComponentNotRoot(shape, page);
    this.checkValidTouched(shape, page);
    this.checkRefComponentId(shape, page);
    this.checkRequiredSwapSlot(shape, page);
    // The nested copy and the ancestor copy can come from different libraries
    // with some of them detached; only validate the ref if the ancestor's
    // library is valid.
    if (libraryExists) {
      this.checkComponentRef(shape, page);
      this.checkRefIsHead(shape, page);
    }
    for (const childId of shape.shapes ?? []) this.checkShape(childId, page, 'copy-nested');
  }

  private checkShapeMainNotRoot(shape: Shape, page: Page): void {
    this.checkComponentNotMainNotHead(shape, page);
    this.checkComponentNotRoot(shape, page);
    this.checkComponentNotRef(shape, page);
    this.checkEmptySwapSlot(shape, page);
    for (const childId of shape.shapes ?? []) this.checkShape(childId, page, 'main-any');
  }

  private checkShapeCopyNotRoot(shape: Shape, page: Page): void {
    this.checkComponentNotMainNotHead(shape, page);
    this.checkComponentNotRoot(shape, page);
    this.checkComponentRef(shape, page);
    this.checkRefIsNotHead(shape, page);
    this.checkEmptySwapSlot(shape, page);
    this.checkValidTouched(shape, page);
    for (const childId of shape.shapes ?? []) this.checkShape(childId, page, 'copy-any');
  }

  private checkShapeNotComponent(shape: Shape, page: Page): void {
    this.checkComponentNotMainNotHead(shape, page);
    this.checkComponentNotRoot(shape, page);
    this.checkComponentNotRef(shape, page);
    this.checkEmptySwapSlot(shape, page);
    for (const childId of shape.shapes ?? []) this.checkShape(childId, page, 'not-component');
  }

  // -------------------------------------------------------------------------
  // variants
  // -------------------------------------------------------------------------

  private extractPropertyNames(shape: Shape | undefined): string {
    const component = shape ? getComponent(this.file, shape.componentId, true) : undefined;
    return (component?.variantProperties ?? []).map((p) => p.name).join(' ');
  }

  private checkVariantContainer(shape: Shape, page: Page): void {
    const firstChild = page.objects[(shape.shapes ?? [])[0]];
    const propNames = this.extractPropertyNames(firstChild);
    for (const childId of shape.shapes ?? []) {
      const child = page.objects[childId];
      if (!child) continue;
      if (!isVariant(child)) {
        this.report('not-a-variant', `Shape ${child.id} should be a variant`, child, page);
        continue;
      }
      if (child.variantId !== shape.id) {
        this.report(
          'invalid-variant-id',
          `Variant ${child.id} has invalid variant-id ${child.variantId}`,
          child,
          page,
        );
      }
      if (this.extractPropertyNames(child) !== propNames) {
        this.report('invalid-variant-properties', `Variant ${child.id} has invalid properties`, child, page);
      }
    }
  }

  /** ctv/properties-to-name: join non-empty property values with ", ". */
  private static propertiesToName(properties: { name: string; value: string }[] | undefined): string {
    return (properties ?? [])
      .map((p) => p.value)
      .filter((v) => v !== '')
      .join(', ');
  }

  /** cpn/merge-path-item */
  private static mergePathItem(path: string | undefined, name: string | undefined): string {
    return path ? `${path} / ${name ?? ''}` : (name ?? '');
  }

  private checkVariant(shape: Shape, page: Page): void {
    const parent = shape.parentId != null ? page.objects[shape.parentId] : undefined;
    const component = getComponent(this.file, shape.componentId, true);
    const name = Validator.propertiesToName(component?.variantProperties);
    if (!mainInstance(shape)) {
      this.report('variant-not-main', `Variant ${shape.id} is not a main instance`, shape, page);
    }
    if (!isVariantContainer(parent)) {
      this.report('parent-not-variant', `Variant ${shape.id} has an invalid parent`, shape, page);
    }
    if (name !== shape.variantName) {
      this.report('variant-bad-variant-name', `Variant ${shape.id} has an invalid variant-name`, shape, page);
    }
    if (parent?.name !== shape.name) {
      this.report('variant-bad-name', `Variant ${shape.id} has an invalid name`, shape, page);
    }
    if (parent?.name !== Validator.mergePathItem(component?.path, component?.name)) {
      this.report('variant-component-bad-name', `Component ${shape.id} has an invalid name`, shape, page);
    }
    if (component?.variantId !== shape.variantId) {
      this.report(
        'variant-component-bad-id',
        `Variant ${shape.id} has a different variant-id than its component`,
        shape,
        page,
      );
    }
  }

  // -------------------------------------------------------------------------
  // shape dispatch
  // -------------------------------------------------------------------------

  checkShape(shapeId: string, page: Page, context: Context = 'not-component', libraryExists = false): void {
    const shape = page.objects[shapeId];
    if (!shape) return;

    this.checkGeometry(shape, page);
    this.checkParentChildren(shape, page);
    this.checkFrame(shape, page);

    if (isVariantContainer(shape)) this.checkVariantContainer(shape, page);
    if (isVariant(shape)) this.checkVariant(shape, page);

    if (instanceHead(shape)) {
      if (shape.type !== 'frame') {
        this.report('instance-head-not-frame', 'Instance head should be a frame', shape, page);
      } else if (instanceRoot(shape)) {
        if (mainInstance(shape)) {
          if (context !== 'not-component') {
            this.report(
              'root-main-not-allowed',
              'Root main component not allowed inside other component',
              shape,
              page,
            );
          } else {
            this.checkShapeMainRootTop(shape, page);
          }
        } else if (context !== 'not-component') {
          this.report(
            'root-copy-not-allowed',
            'Root copy component not allowed inside other component',
            shape,
            page,
          );
        } else {
          this.checkShapeCopyRootTop(shape, page);
        }
      } else if (mainInstance(shape)) {
        // mains can't be nested into mains
        if (context === 'not-component' || context === 'main-top') {
          this.report(
            'nested-main-not-allowed',
            'Component main not allowed inside other component',
            shape,
            page,
          );
        } else {
          this.checkShapeMainRootNested(shape, page);
        }
      } else if (context === 'not-component') {
        this.report(
          'nested-copy-not-allowed',
          'Nested copy component only allowed inside other component',
          shape,
          page,
        );
      } else {
        this.checkShapeCopyRootNested(shape, page, libraryExists);
      }
    } else if (inComponentCopy(shape)) {
      if (!COPY_CONTEXTS.has(context)) {
        this.report('not-head-copy-not-allowed', 'Non-root copy only allowed inside a copy', shape, page);
      } else {
        this.checkShapeCopyNotRoot(shape, page);
      }
    } else {
      const inMain = MAIN_CONTEXTS.has(context) || insideComponentMain(page.objects, shape);
      if (inMain) {
        if (!MAIN_CONTEXTS.has(context)) {
          this.report(
            'not-head-main-not-allowed',
            'Non-root main only allowed inside a main component',
            shape,
            page,
          );
        } else {
          this.checkShapeMainNotRoot(shape, page);
        }
      } else if (MAIN_CONTEXTS.has(context)) {
        this.report('not-component-not-allowed', 'Not components are not allowed inside a main', shape, page);
      } else {
        this.checkShapeNotComponent(shape, page);
      }
    }
  }

  // -------------------------------------------------------------------------
  // component-level checks
  // -------------------------------------------------------------------------

  private checkComponentDuplicateSwapSlot(component: Component): void {
    const objects = component.objects ?? {};
    const shape = component.mainInstanceId != null ? objects[component.mainInstanceId] : undefined;
    if (shape && this.hasDuplicateSwapSlot(shape, objects)) {
      this.report(
        'component-duplicate-slot',
        'This deleted component has children with the same swap slot',
        component,
        undefined,
      );
    }
  }

  private checkRefCycles(component: Component): void {
    const cyclesIds = Object.entries(component.objects ?? {})
      .filter(([id, shape]) => id === shape.shapeRef)
      .map(([id]) => id);
    if (cyclesIds.length > 0) {
      this.report(
        'shape-ref-cycle',
        'This deleted component has shapes with shape-ref pointing to self',
        component,
        undefined,
        { cyclesIds },
      );
    }
  }

  private checkVariantComponent(component: Component): void {
    const componentPage = getComponentPage(this.file, component);
    const main = component.deleted
      ? component.objects?.[component.mainInstanceId ?? '']
      : componentPage?.objects[component.mainInstanceId ?? ''];
    if (main && !isVariant(main)) {
      this.report('not-a-variant', `Shape ${main.id} should be a variant`, main, componentPage);
    }
  }

  private checkMainInsideMain(component: Component): void {
    const componentPage = getComponentPage(this.file, component);
    if (!componentPage || component.mainInstanceId == null) return;
    const main = componentPage.objects[component.mainInstanceId];
    if (!main) return;
    if (getParents(componentPage.objects, main.id).some(mainInstance)) {
      this.report(
        'nested-main-not-allowed',
        'Component main not allowed inside other component',
        main,
        componentPage,
      );
    }
  }

  private checkNotObjects(component: Component): void {
    if (component.objects != null && Object.keys(component.objects).length > 0) {
      this.report(
        'non-deleted-component-cannot-have-objects',
        'A non-deleted component cannot have shapes inside',
        component,
        undefined,
      );
    }
  }

  checkComponent(component: Component): void {
    if ('objects' in component && component.objects == null) {
      this.report('component-nil-objects-not-allowed', 'Objects list cannot be nil', component, undefined);
    }
    if (!component.deleted) {
      this.checkMainInsideMain(component);
      this.checkNotObjects(component);
    } else {
      this.checkComponentDuplicateSwapSlot(component);
      this.checkRefCycles(component);
    }
    if (isVariant(component)) this.checkVariantComponent(component);
  }
}

/** Shapes unreachable from the root traversal (parent missing), root excluded. */
function getOrphanShapes(page: Page): string[] {
  return Object.values(page.objects)
    .filter((shape) => !isRoot(shape) && !(shape.parentId != null && shape.parentId in page.objects))
    .map((shape) => shape.id);
}

/**
 * Validate full referential integrity and semantic coherence of a file.
 * Like Penpot, only files with the "components/v2" feature are validated.
 */
export function validateFile(file: PenpotFile, libraries: Libraries = new Map()): ValidationError[] {
  if (!file.features.includes('components/v2')) return [];
  const validator = new Validator(file, libraries);
  for (const pageId of file.data.pages) {
    const page = file.data.pagesIndex[pageId];
    if (!page) continue;
    validator.checkShape(UUID_ZERO, page);
    for (const orphanId of getOrphanShapes(page)) validator.checkShape(orphanId, page);
  }
  for (const component of Object.values(file.data.components)) {
    validator.checkComponent(component);
  }
  return validator.errors;
}

export { getOrphanShapes };
