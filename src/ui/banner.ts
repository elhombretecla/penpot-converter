import pc from 'picocolors';

/**
 * Penpot pen-nib logo, generated from the official SVG: rasterized to 30px
 * wide, alpha channel mapped to unicode half-blocks (2 vertical pixels per
 * character cell, so the aspect ratio survives terminal cells being ~2:1).
 */
const LOGO = [
  '       █▄            ▄█',
  '     ▄█▀██    ██    ██▀█▄',
  '    ▄█   ▀█▄▄█▀▀█▄▄█▀   █▄',
  '    █▀▀█▀▀▀██▄▄▄▄██▀▀▀█▀▀█',
  '   ▄█  █   █▀▀██▀▀█   █  █▄',
  '▄█▀▀█  █   █  ██  █   █  █▀▀█▄',
  '█████  █   █  ██  █   █  █████',
  '██ ▀▀███▄▄ █  ██  █  ▄███▀▀ ██',
  '██     ▀▀▀██▄▄██▄▄██▀▀▀     ██',
  '██          ▀▀██▀▀          ██',
  '██            ██            ██',
  '██            ██            ██',
  '██            ██            ██',
  '██            ██            ██',
  '██            ██            ██',
  '██            ██            ██',
  '▀██▄▄▄        ██         ▄▄██▀',
  '   ▀▀▀██▄▄    ██    ▄▄███▀▀',
  '        ▀▀██▄▄██▄▄██▀▀',
  '            ▀▀██▀▀',
];

const LOGO_WIDTH = 30;

/** Penpot brand mint (#31efb8), with a plain-cyan fallback for 16-color terminals. */
function mint(text: string): string {
  if (pc.isColorSupported && (process.env['COLORTERM'] ?? '').includes('truecolor')) {
    return `\x1b[38;2;49;239;184m${text}\x1b[39m`;
  }
  return pc.cyan(text);
}

export function renderBanner(version: string): string {
  const title = [
    pc.bold('Penpot Converter') + pc.dim(`  v${version}`),
    pc.dim('Figma .fig / .deck  →  .penpot, locally'),
  ];
  const columns = process.stdout.columns || 80;

  // Wide: wordmark beside the logo. Narrow: logo on top, wordmark below.
  // Tiny (can't even fit the 30-col logo): wordmark alone.
  if (columns >= LOGO_WIDTH + 45) {
    const titleRow = Math.floor(LOGO.length / 2) - 1;
    const lines = LOGO.map((line, row) => {
      const art = mint(line.padEnd(LOGO_WIDTH));
      const text = title[row - titleRow];
      return text !== undefined ? `${art}     ${text}` : art;
    });
    return `\n${lines.join('\n')}\n`;
  }
  if (columns >= LOGO_WIDTH + 2) {
    return `\n${LOGO.map(mint).join('\n')}\n\n${title.join('\n')}\n`;
  }
  return `\n${title.join('\n')}\n`;
}
