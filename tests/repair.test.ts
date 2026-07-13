import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPenpotBundle, writePenpotBundle } from '../src/repair/io.js';
import { UUID_ZERO } from '../src/repair/model.js';
import { repairBundle, runRepair, validateBundle } from '../src/repair/runRepair.js';
import { validateFile } from '../src/repair/validate.js';
import {
  COMPONENT_ID,
  COPY_CHILD_ID,
  COPY_ID,
  MAIN_CHILD_ID,
  MAIN_ID,
  PAGE_ID,
  RECT_ID,
  fixtureObjects,
  makeFixtureBundle,
} from './fixtures.js';

test('clean fixture validates with zero errors', () => {
  const bundle = makeFixtureBundle();
  assert.deepEqual(validateBundle(bundle), []);
});

test('round-trip preserves content of a healthy file', () => {
  const bundle = makeFixtureBundle();
  const reread = readPenpotBundle(writePenpotBundle(bundle));
  assert.deepEqual(reread.manifest, bundle.manifest);
  assert.deepEqual(reread.files[0].data.pages, bundle.files[0].data.pages);
  assert.deepEqual(fixtureObjects(reread), fixtureObjects(bundle));
  assert.deepEqual(reread.files[0].data.components, bundle.files[0].data.components);
  assert.deepEqual([...reread.rawEntries.keys()], [...bundle.rawEntries.keys()]);
  assert.deepEqual(reread.rawEntries.get('objects/fixture.bin'), Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual(validateBundle(reread), []);
});

interface Corruption {
  name: string;
  corrupt: (objects: ReturnType<typeof fixtureObjects>, bundle: ReturnType<typeof makeFixtureBundle>) => void;
  expectedCodes: string[];
}

const corruptions: Corruption[] = [
  {
    name: 'orphan parent (parentId points nowhere)',
    corrupt: (objects) => {
      objects[RECT_ID].parentId = '99999999-9999-9999-9999-999999999999';
    },
    expectedCodes: ['parent-not-found', 'invalid-parent'],
  },
  {
    name: 'duplicated children',
    corrupt: (objects) => {
      objects[UUID_ZERO].shapes = [RECT_ID, RECT_ID, MAIN_ID, COPY_ID];
    },
    expectedCodes: ['duplicated-children'],
  },
  {
    name: 'child id without object',
    corrupt: (objects) => {
      objects[UUID_ZERO].shapes!.push('99999999-9999-9999-9999-999999999999');
    },
    expectedCodes: ['child-not-found'],
  },
  {
    // The shape stays reachable through the root but claims another parent
    // that does not list it back.
    name: 'shape missing from parent children list',
    corrupt: (objects) => {
      objects[RECT_ID].parentId = MAIN_ID;
    },
    expectedCodes: ['child-not-in-parent', 'invalid-parent'],
  },
  {
    name: 'invalid geometry',
    corrupt: (objects) => {
      objects[RECT_ID].selrect = null;
      objects[RECT_ID].width = null;
    },
    expectedCodes: ['invalid-geometry'],
  },
  {
    name: 'frame-id points nowhere',
    corrupt: (objects) => {
      objects[RECT_ID].frameId = '99999999-9999-9999-9999-999999999999';
    },
    expectedCodes: ['frame-not-found'],
  },
  {
    name: 'frame-id points to a non-frame',
    corrupt: (objects) => {
      objects[MAIN_CHILD_ID].frameId = RECT_ID;
    },
    expectedCodes: ['invalid-frame'],
  },
  {
    name: 'broken shape-ref in a copy head',
    corrupt: (objects) => {
      objects[COPY_ID].shapeRef = '99999999-9999-9999-9999-999999999999';
    },
    expectedCodes: ['ref-shape-not-found'],
  },
  {
    name: 'shape-ref on a main instance head',
    corrupt: (objects) => {
      objects[MAIN_ID].shapeRef = RECT_ID;
    },
    expectedCodes: ['shape-ref-in-main'],
  },
  {
    // A plain shape with shape-ref inside a main instance is dispatched as a
    // misplaced copy, like in Penpot.
    name: 'shape-ref on a shape inside a main instance',
    corrupt: (objects) => {
      objects[MAIN_CHILD_ID].shapeRef = RECT_ID;
    },
    expectedCodes: ['not-head-copy-not-allowed'],
  },
  {
    name: 'component deleted from the file',
    corrupt: (_objects, bundle) => {
      delete bundle.files[0].data.components[COMPONENT_ID];
    },
    expectedCodes: ['component-not-found'],
  },
  {
    // Without componentRoot the head is dispatched as a nested copy at top
    // level; repair restores the flag.
    name: 'copy head missing componentRoot',
    corrupt: (objects) => {
      delete objects[COPY_ID].componentRoot;
    },
    expectedCodes: ['nested-copy-not-allowed'],
  },
  {
    name: 'component main-instance-id mismatch',
    corrupt: (_objects, bundle) => {
      bundle.files[0].data.components[COMPONENT_ID].mainInstanceId = RECT_ID;
    },
    expectedCodes: ['invalid-main-instance-id'],
  },
  {
    name: 'non-deleted component with objects',
    corrupt: (_objects, bundle) => {
      bundle.files[0].data.components[COMPONENT_ID].objects = {
        [MAIN_ID]: { id: MAIN_ID },
      };
    },
    expectedCodes: ['non-deleted-component-cannot-have-objects'],
  },
];

for (const { name, corrupt, expectedCodes } of corruptions) {
  test(`detects and repairs: ${name}`, () => {
    const bundle = makeFixtureBundle();
    corrupt(fixtureObjects(bundle), bundle);

    const errors = validateBundle(bundle);
    assert.ok(errors.length > 0, 'corruption must be detected');
    for (const code of expectedCodes) {
      assert.ok(
        errors.some((e) => e.code === code),
        `expected code ${code}, got: ${errors.map((e) => e.code).join(', ')}`,
      );
    }

    const result = repairBundle(bundle);
    assert.ok(result.repaired, 'repair must apply actions');
    assert.deepEqual(
      validateBundle(bundle).map((e) => e.code),
      [],
      'file must revalidate clean after repair',
    );
    assert.deepEqual(result.remainingErrors, []);
  });
}

test('main instance without its flag reports invalid-main-instance (not auto-fixable)', () => {
  const bundle = makeFixtureBundle();
  delete fixtureObjects(bundle)[MAIN_ID].mainInstance;
  const errors = validateBundle(bundle);
  assert.ok(errors.some((e) => e.code === 'invalid-main-instance'));
  const result = repairBundle(bundle);
  assert.ok(result.remainingErrors.some((e) => e.code === 'invalid-main-instance'));
});

test('repair keeps healthy shapes intact', () => {
  const bundle = makeFixtureBundle();
  const pristine = structuredClone(fixtureObjects(bundle)[MAIN_ID]);
  fixtureObjects(bundle)[RECT_ID].selrect = null;
  repairBundle(bundle);
  assert.deepEqual(fixtureObjects(bundle)[MAIN_ID], pristine);
});

test('runRepair honors maxIterations', () => {
  const bundle = makeFixtureBundle();
  const objects = fixtureObjects(bundle);
  // Chained damage that needs more than one iteration to converge.
  objects[RECT_ID].parentId = '99999999-9999-9999-9999-999999999999';
  objects[UUID_ZERO].shapes = [MAIN_ID, COPY_ID];
  const result = runRepair(bundle.files[0], new Map(), { maxIterations: 1 });
  assert.equal(result.iterations, 1);
});

test('unrepairable variant errors are reported as remaining', () => {
  const bundle = makeFixtureBundle();
  const objects = fixtureObjects(bundle);
  // A variant whose parent is not a variant container: not auto-repaired.
  objects[MAIN_ID].variantId = COMPONENT_ID;
  objects[MAIN_ID].variantName = '';
  const result = repairBundle(bundle);
  assert.ok(result.remainingErrors.length > 0);
  assert.ok(result.actions.every((a) => a.code.startsWith('variant') || !a.repaired || a.code !== 'parent-not-variant'));
  assert.ok(result.remainingErrors.some((e) => e.code === 'parent-not-variant'));
});

test('round-trip survives more than 65535 ZIP entries (ZIP64 count)', () => {
  const bundle = makeFixtureBundle();
  for (let i = 0; i < 66000; i++) {
    bundle.rawEntries.set(`objects/pad-${i}.bin`, Uint8Array.of(i & 0xff));
  }
  const reread = readPenpotBundle(writePenpotBundle(bundle));
  assert.equal(reread.rawEntries.size, bundle.rawEntries.size);
  assert.deepEqual(fixtureObjects(reread), fixtureObjects(bundle));
  assert.deepEqual(validateBundle(reread), []);
});

test('files without components/v2 are skipped like in Penpot', () => {
  const bundle = makeFixtureBundle();
  bundle.files[0].features = [];
  fixtureObjects(bundle)[RECT_ID].selrect = null;
  assert.deepEqual(validateFile(bundle.files[0]), []);
});
