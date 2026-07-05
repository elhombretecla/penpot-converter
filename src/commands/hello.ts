import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import * as penpot from '@penpot/library';

/**
 * Emits a minimal but non-trivial .penpot file through the official
 * @penpot/library builder. Its only purpose is validating the write
 * pipeline end to end: the output must import cleanly in Penpot.
 */
export async function runHello(output: string): Promise<void> {
  const context = penpot.createBuildContext();

  context.addFile({ name: 'fig2penpot hello' });
  context.addPage({ name: 'Page 1' });

  context.addBoard({
    name: 'Board',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    fills: [{ fillColor: '#ffffff', fillOpacity: 1 }],
  });

  context.addRect({
    name: 'Rectangle',
    x: 40,
    y: 40,
    width: 200,
    height: 120,
    r1: 8, r2: 8, r3: 8, r4: 8,
    fills: [{ fillColor: '#7b61ff', fillOpacity: 1 }],
  });

  context.addCircle({
    name: 'Circle',
    x: 300,
    y: 40,
    width: 120,
    height: 120,
    fills: [{ fillColor: '#2f9e44', fillOpacity: 0.8 }],
    strokes: [{ strokeColor: '#1b5e20', strokeOpacity: 1, strokeWidth: 2, strokeAlignment: 'center', strokeStyle: 'solid' }],
  });

  context.closeBoard();
  context.closePage();
  context.closeFile();

  const out = createWriteStream(output);
  await penpot.exportStream(context, Writable.toWeb(out) as WritableStream);
  console.log(`wrote ${output}`);
}
