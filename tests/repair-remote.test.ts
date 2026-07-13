import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import {
  camelizeKeys,
  diffAttrs,
  encodeAttrValue,
  parseFileId,
  runRepairRemote,
  ServerValidationError,
} from '../src/commands/repair-remote.js';
import { UUID_ZERO } from '../src/repair/model.js';
import { FILE_ID, PAGE_ID, RECT_ID, fixtureObjects, makeFixtureBundle } from './fixtures.js';

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('parseFileId handles uuids, file-id params and workspace paths', () => {
  assert.equal(parseFileId(FILE_ID), FILE_ID);
  assert.equal(
    parseFileId(`https://design.penpot.app/#/workspace?team-id=${UUID_ZERO}&file-id=${FILE_ID}&page-id=${PAGE_ID}`),
    FILE_ID,
  );
  assert.equal(
    parseFileId(`https://penpot.local/#/workspace/${UUID_ZERO}/${FILE_ID}?page-id=${PAGE_ID}`),
    FILE_ID,
  );
  assert.equal(parseFileId('not a file reference'), undefined);
});

test('camelizeKeys converts kebab keys but preserves uuid keys and values', () => {
  const input = {
    'pages-index': {
      [PAGE_ID]: {
        objects: {
          [RECT_ID]: { 'parent-id': UUID_ZERO, touched: ['swap-slot-abc', 'fill-group'] },
        },
      },
    },
  };
  const out = camelizeKeys(input) as Record<string, never>;
  const shape = out['pagesIndex'][PAGE_ID]['objects'][RECT_ID] as Record<string, unknown>;
  assert.equal(shape['parentId'], UUID_ZERO);
  assert.deepEqual(shape['touched'], ['swap-slot-abc', 'fill-group']);
});

test('encodeAttrValue tags uuids, keywords, touched sets and nil dissocs', () => {
  assert.equal(encodeAttrValue('parentId', UUID_ZERO), `~u${UUID_ZERO}`);
  assert.equal(encodeAttrValue('type', 'frame'), '~:frame');
  assert.deepEqual(encodeAttrValue('touched', ['content-group']), ['~#set', ['~:content-group']]);
  assert.deepEqual(encodeAttrValue('shapes', [RECT_ID]), [`~u${RECT_ID}`]);
  assert.equal(encodeAttrValue('componentFile', undefined), null);
  assert.equal(encodeAttrValue('x', 5), 5);
});

test('diffAttrs reports changed, added and deleted attributes', () => {
  const changes = diffAttrs(
    { id: 'x', a: 1, gone: true, same: 'v' },
    { id: 'x', a: 2, added: 'n', same: 'v' },
  );
  assert.deepEqual(
    Object.fromEntries(changes.map((c) => [c.attr, c.value])),
    { a: 2, added: 'n', gone: null },
  );
});

// ---------------------------------------------------------------------------
// end-to-end against a mock Penpot API
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inverse of camelizeKeys, to mimic the server's kebab-cased responses. */
function kebabizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(kebabizeKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        UUID_RE.test(key) ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        kebabizeKeys(val),
      ]),
    );
  }
  return value;
}

/** get-file RPC response for the fixture file, with the requested corruption. */
function brokenRpcFile(): Record<string, unknown> {
  const bundle = makeFixtureBundle();
  const objects = fixtureObjects(bundle);
  objects[RECT_ID].selrect = null; // invalid-geometry
  objects[UUID_ZERO].shapes!.push('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); // child-not-found
  const file = bundle.files[0];
  return {
    id: file.id,
    name: file.name,
    revn: 7,
    vern: 0,
    features: file.features,
    data: kebabizeKeys({
      pages: file.data.pages,
      pagesIndex: Object.fromEntries(
        file.data.pages.map((pageId) => {
          const page = file.data.pagesIndex[pageId];
          return [pageId, { id: pageId, name: page.meta.name, objects: page.objects }];
        }),
      ),
      components: file.data.components,
    }),
  };
}

interface MockCall {
  command: string;
  body: string;
}

const calls: MockCall[] = [];
let rejectUpdate = false;
const mock = createServer(async (req: IncomingMessage, res) => {
  const command = req.url?.split('/').pop() ?? '';
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  calls.push({ command, body: Buffer.concat(chunks).toString('utf8') });

  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (command === 'get-file') return reply(200, brokenRpcFile());
  if (command === 'get-file-libraries') return reply(200, []);
  if (command === 'update-file') {
    if (rejectUpdate && !calls.at(-1)!.body.includes('skip-validate')) {
      return reply(400, { type: 'validation', code: 'referential-integrity', details: [{ code: 'invalid-frame' }] });
    }
    return reply(200, { revn: 8 });
  }
  reply(404, { error: 'unknown command' });
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

after(() => mock.close());

test('dry run reports the repair without calling update-file', async () => {
  calls.length = 0;
  const result = await runRepairRemote({ url, token: 't', file: FILE_ID, dryRun: true });
  assert.equal(result.errorsBefore > 0, true);
  assert.equal(result.fixed > 0, true);
  assert.equal(result.applied, false);
  assert.ok(result.changedShapes > 0);
  assert.equal(calls.filter((c) => c.command === 'update-file').length, 0);
});

test('repairs the remote file with one atomic transit-encoded update-file', async () => {
  calls.length = 0;
  rejectUpdate = false;
  const result = await runRepairRemote({ url, token: 't', file: FILE_ID });
  assert.equal(result.applied, true);
  const updates = calls.filter((c) => c.command === 'update-file');
  assert.equal(updates.length, 1);
  const body = updates[0].body;
  assert.match(body, /~:mod-obj/);
  assert.match(body, /~:selrect/); // geometry repair reached the wire
  assert.match(body, /~:shapes/); // ghost child removed from root's children
  assert.doesNotMatch(body, /skip-validate/); // server validation is the acceptance check
});

test('a server rejection throws ServerValidationError and --force retries with skip-validate', async () => {
  calls.length = 0;
  rejectUpdate = true;
  await assert.rejects(
    runRepairRemote({ url, token: 't', file: FILE_ID }),
    (err: unknown) => err instanceof ServerValidationError && err.details.length === 1,
  );
  const result = await runRepairRemote({ url, token: 't', file: FILE_ID, force: true });
  assert.equal(result.applied, true);
  const forced = calls.filter((c) => c.command === 'update-file').at(-1)!;
  assert.match(forced.body, /skip-validate/);
  rejectUpdate = false;
});

test('a healthy remote file is reported valid and never written', async () => {
  // The fixture without corruptions round-trips clean through the same mock.
  calls.length = 0;
  const healthy = makeFixtureBundle().files[0];
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    const command = req.url?.split('/').pop() ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    if (command === 'get-file-libraries') return res.end('[]');
    res.end(
      JSON.stringify({
        id: healthy.id,
        name: healthy.name,
        revn: 1,
        vern: 0,
        features: healthy.features,
        data: kebabizeKeys({
          pages: healthy.data.pages,
          pagesIndex: Object.fromEntries(
            healthy.data.pages.map((pageId) => {
              const page = healthy.data.pagesIndex[pageId];
              return [pageId, { id: pageId, name: page.meta.name, objects: page.objects }];
            }),
          ),
          components: healthy.data.components,
        }),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await runRepairRemote({ url: `http://127.0.0.1:${port}`, token: 't', file: FILE_ID });
    assert.equal(result.errorsBefore, 0);
    assert.equal(result.applied, false);
  } finally {
    server.close();
  }
});
