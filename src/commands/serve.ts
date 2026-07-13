import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pc from 'picocolors';
import { readPenpotBundle, writePenpotBundle } from '../repair/io.js';
import { repairBundle, validateBundle, DEFAULT_MAX_ITERATIONS } from '../repair/runRepair.js';

export interface ServeOptions {
  port?: number;
  token?: string;
  /** Max accepted body size in bytes. */
  maxBodySize?: number;
}

/** Margin over Penpot's own 120 MiB import cap. */
const DEFAULT_MAX_BODY = 150 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage, maxBodySize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBodySize) {
      reject(Object.assign(new Error('body too large'), { status: 413 }));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBodySize) {
        req.destroy();
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Minimal multipart/form-data extractor: returns the body of the first part
 * that carries a filename. Enough for `curl -F file=@broken.penpot`.
 */
export function extractMultipartFile(body: Buffer, contentType: string): Buffer | undefined {
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!boundaryMatch) return undefined;
  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  let offset = body.indexOf(boundary);
  while (offset !== -1) {
    const headerStart = offset + boundary.length + 2; // skip CRLF after boundary
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) return undefined;
    const headers = body.subarray(headerStart, headerEnd).toString('latin1');
    const next = body.indexOf(boundary, headerEnd);
    if (next === -1) return undefined;
    if (/filename=/i.test(headers)) {
      return body.subarray(headerEnd + 4, next - 2); // strip CRLF before boundary
    }
    offset = next;
  }
  return undefined;
}

function extractPenpotBody(req: IncomingMessage, body: Buffer): Buffer {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    const file = extractMultipartFile(body, contentType);
    if (!file) throw Object.assign(new Error('multipart body has no file part'), { status: 400 });
    return file;
  }
  return body;
}

function stripShapes<T extends { shape?: unknown }>(errors: T[]): Omit<T, 'shape'>[] {
  return errors.map(({ shape: _shape, ...rest }) => rest);
}

export function createRepairServer(opts: ServeOptions = {}) {
  const maxBodySize = opts.maxBodySize ?? DEFAULT_MAX_BODY;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method !== 'POST' || (url.pathname !== '/validate' && url.pathname !== '/repair')) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      const body = extractPenpotBody(req, await readBody(req, maxBodySize));
      const bundle = readPenpotBundle(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));

      if (url.pathname === '/validate') {
        const errors = validateBundle(bundle);
        sendJson(res, 200, { valid: errors.length === 0, errorCount: errors.length, errors: stripShapes(errors) });
        return;
      }

      const maxIterations = url.searchParams.has('maxIterations')
        ? Number(url.searchParams.get('maxIterations'))
        : DEFAULT_MAX_ITERATIONS;
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        sendJson(res, 400, { error: 'maxIterations must be a positive integer' });
        return;
      }
      const dryRun = url.searchParams.get('dryRun') === 'true';
      const result = repairBundle(bundle, { maxIterations });

      if (dryRun) {
        sendJson(res, 200, {
          dryRun: true,
          repaired: result.repaired,
          iterations: result.iterations,
          actions: result.actions,
          remainingErrors: stripShapes(result.remainingErrors),
        });
        return;
      }

      const repaired = writePenpotBundle(bundle);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': repaired.length,
        'x-repair-iterations': String(result.iterations),
        'x-repair-remaining-errors': String(result.remainingErrors.length),
      });
      res.end(Buffer.from(repaired));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** `serve [--port 3000] [--token <secret>]`: HTTP validation/repair webhook. */
export function runServe(opts: ServeOptions = {}): Promise<void> {
  const port = opts.port ?? 3000;
  const server = createRepairServer(opts);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      console.log(`penpot repair server listening on ${pc.cyan(`http://localhost:${port}`)}`);
      console.log(`  POST /validate            body: .penpot (octet-stream or multipart)`);
      console.log(`  POST /repair              query: ?maxIterations=10&dryRun=false`);
      console.log(`  GET  /health`);
      if (opts.token) console.log(pc.dim('  auth: Authorization: Bearer <token>'));
    });
    server.on('close', resolve);
  });
}
