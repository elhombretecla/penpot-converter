import type { PenpotBundle, PenpotFile, Selrect, Shape } from '../src/repair/model.js';
import { UUID_ZERO } from '../src/repair/model.js';

/**
 * Programmatic .penpot fixtures for the validate/repair tests: a minimal but
 * fully valid file (root frame, plain shapes, a component with its main
 * instance and one copy) that individual tests then corrupt on purpose.
 */

export const FILE_ID = '11111111-1111-1111-1111-111111111111';
export const PAGE_ID = '22222222-2222-2222-2222-222222222222';
export const COMPONENT_ID = '33333333-3333-3333-3333-333333333333';
export const MAIN_ID = '44444444-4444-4444-4444-444444444444';
export const MAIN_CHILD_ID = '55555555-5555-5555-5555-555555555555';
export const COPY_ID = '66666666-6666-6666-6666-666666666666';
export const COPY_CHILD_ID = '77777777-7777-7777-7777-777777777777';
export const RECT_ID = '88888888-8888-8888-8888-888888888888';

function selrect(x: number, y: number, width: number, height: number): Selrect {
  return { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height };
}

function geometry(x: number, y: number, width: number, height: number): Partial<Shape> {
  return {
    x,
    y,
    width,
    height,
    selrect: selrect(x, y, width, height),
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  };
}

function shape(partial: Partial<Shape> & { id: string }): Shape {
  return { name: partial.id.slice(0, 8), type: 'rect', ...geometry(0, 0, 10, 10), ...partial };
}

export function makeFixtureBundle(): PenpotBundle {
  const objects: Record<string, Shape> = {};
  const put = (s: Shape): void => {
    objects[s.id] = s;
  };

  put(
    shape({
      id: UUID_ZERO,
      name: 'Root Frame',
      type: 'frame',
      parentId: UUID_ZERO,
      frameId: UUID_ZERO,
      ...geometry(0, 0, 0.01, 0.01),
      shapes: [RECT_ID, MAIN_ID, COPY_ID],
    }),
  );
  put(shape({ id: RECT_ID, parentId: UUID_ZERO, frameId: UUID_ZERO }));
  put(
    shape({
      id: MAIN_ID,
      type: 'frame',
      parentId: UUID_ZERO,
      frameId: UUID_ZERO,
      shapes: [MAIN_CHILD_ID],
      componentId: COMPONENT_ID,
      componentFile: FILE_ID,
      componentRoot: true,
      mainInstance: true,
    }),
  );
  put(shape({ id: MAIN_CHILD_ID, parentId: MAIN_ID, frameId: MAIN_ID }));
  put(
    shape({
      id: COPY_ID,
      type: 'frame',
      parentId: UUID_ZERO,
      frameId: UUID_ZERO,
      shapes: [COPY_CHILD_ID],
      componentId: COMPONENT_ID,
      componentFile: FILE_ID,
      componentRoot: true,
      shapeRef: MAIN_ID,
    }),
  );
  put(shape({ id: COPY_CHILD_ID, parentId: COPY_ID, frameId: COPY_ID, shapeRef: MAIN_CHILD_ID }));

  const file: PenpotFile = {
    id: FILE_ID,
    name: 'fixture',
    features: ['components/v2'],
    meta: { id: FILE_ID, name: 'fixture', features: ['components/v2'] },
    data: {
      pages: [PAGE_ID],
      pagesIndex: {
        [PAGE_ID]: { id: PAGE_ID, meta: { id: PAGE_ID, name: 'Page 1', index: 0 }, objects },
      },
      components: {
        [COMPONENT_ID]: {
          id: COMPONENT_ID,
          name: 'component',
          path: '',
          mainInstanceId: MAIN_ID,
          mainInstancePage: PAGE_ID,
        },
      },
    },
  };

  return {
    manifest: {
      type: 'penpot/export-files',
      version: 1,
      generatedBy: 'fixture',
      files: [{ id: FILE_ID, name: 'fixture', features: ['components/v2'] }],
      relations: [],
    },
    files: [file],
    rawEntries: new Map([['objects/fixture.bin', Uint8Array.from([1, 2, 3, 4])]]),
  };
}

export function fixtureObjects(bundle: PenpotBundle): Record<string, Shape> {
  return bundle.files[0].data.pagesIndex[PAGE_ID].objects;
}
