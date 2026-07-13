import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createRepairServer } from '../src/commands/serve.js';
import { readPenpotBundle, writePenpotBundle } from '../src/repair/io.js';
import { validateBundle } from '../src/repair/runRepair.js';
import { RECT_ID, fixtureObjects, makeFixtureBundle } from './fixtures.js';

const TOKEN = 'test-secret';
const server = createRepairServer({ token: TOKEN, maxBodySize: 1024 * 1024 });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => server.close());

function brokenPenpotBytes(): Uint8Array {
  const bundle = makeFixtureBundle();
  fixtureObjects(bundle)[RECT_ID].selrect = null;
  return writePenpotBundle(bundle);
}

function post(path: string, body: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: body as unknown as BodyInit,
  });
}

test('GET /health responds ok without auth', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('POST endpoints require the bearer token', async () => {
  const res = await post('/validate', brokenPenpotBytes(), { authorization: 'Bearer wrong' });
  assert.equal(res.status, 401);
});

test('POST /validate reports the errors of a broken file', async () => {
  const res = await post('/validate', brokenPenpotBytes());
  assert.equal(res.status, 200);
  const report = (await res.json()) as { valid: boolean; errorCount: number; errors: { code: string }[] };
  assert.equal(report.valid, false);
  assert.ok(report.errorCount > 0);
  assert.ok(report.errors.some((e) => e.code === 'invalid-geometry'));
});

test('POST /validate accepts a clean file', async () => {
  const res = await post('/validate', writePenpotBundle(makeFixtureBundle()));
  const report = (await res.json()) as { valid: boolean; errorCount: number };
  assert.deepEqual(report, { valid: true, errorCount: 0, ...{ errors: [] } });
});

test('POST /repair returns a repaired .penpot that revalidates clean', async () => {
  const res = await post('/repair', brokenPenpotBytes());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  const repaired = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(validateBundle(readPenpotBundle(repaired)), []);
});

test('POST /repair?dryRun=true returns the action report as JSON', async () => {
  const res = await post('/repair?dryRun=true', brokenPenpotBytes());
  assert.equal(res.status, 200);
  const report = (await res.json()) as { dryRun: boolean; repaired: boolean; actions: { code: string }[] };
  assert.equal(report.dryRun, true);
  assert.equal(report.repaired, true);
  assert.ok(report.actions.some((a) => a.code === 'invalid-geometry'));
});

test('POST /repair via multipart form-data works', async () => {
  const form = new FormData();
  form.set('file', new Blob([brokenPenpotBytes() as unknown as BlobPart]), 'broken.penpot');
  const res = await fetch(`${base}/repair?dryRun=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  assert.equal(res.status, 200);
  const report = (await res.json()) as { repaired: boolean };
  assert.equal(report.repaired, true);
});

test('oversized bodies are rejected with 413', async () => {
  const res = await post('/validate', new Uint8Array(2 * 1024 * 1024));
  assert.equal(res.status, 413);
});

test('invalid maxIterations is rejected with 400', async () => {
  const res = await post('/repair?maxIterations=zero', brokenPenpotBytes());
  assert.equal(res.status, 400);
});

test('garbage bodies produce a JSON error, not a crash', async () => {
  const res = await post('/validate', Uint8Array.from([1, 2, 3]));
  assert.equal(res.status, 400);
});
