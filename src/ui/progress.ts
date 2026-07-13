import pc from 'picocolors';
import { mint } from './banner.js';

/**
 * Penpot-pencil progress bar: a mint stroke grows behind the pencil tip as
 * the conversion advances, the not-yet-drawn part stays a dim dashed guide.
 *
 *   converting  ━━━━━━━━━✐╌╌╌╌╌╌╌╌╌╌╌╌╌╌  41%  12,345/29,876 nodes
 *
 * Renders only on a TTY (piped/CI output is untouched) and throttles redraws.
 * The total can keep growing while running (multi-file bundles add each file
 * as it is decoded); done() snaps to 100% (subtrees skipped whole never tick).
 */
export class PencilBar {
  private total = 0;
  private current = 0;
  private lastRender = 0;
  private started = false;
  private readonly enabled = process.stdout.isTTY === true;

  constructor(
    private readonly label = 'converting',
    private readonly unit = 'nodes',
  ) {}

  addTotal(count: number): void {
    this.total += count;
    this.render();
  }

  tick(): void {
    this.current++;
    this.render();
  }

  /** Prints a normal log line without tearing the bar (clears, logs, redraws). */
  println(text: string): void {
    if (!this.enabled || !this.started) {
      console.log(text);
      return;
    }
    process.stdout.write('\r\x1b[2K');
    console.log(text);
    this.render(true);
  }

  /** Completes the stroke and moves to the next line. */
  done(): void {
    if (!this.enabled || !this.started) return;
    this.current = this.total;
    this.render(true);
    process.stdout.write('\n');
    this.started = false;
  }

  private render(force = false): void {
    if (!this.enabled || this.total === 0) return;
    const now = Date.now();
    if (!force && now - this.lastRender < 40) return;
    this.lastRender = now;
    this.started = true;

    const ratio = Math.min(1, this.current / this.total);
    const percent = `${Math.floor(ratio * 100)}%`.padStart(4);
    const counts = `${this.current.toLocaleString()}/${this.total.toLocaleString()} ${this.unit}`;
    const columns = process.stdout.columns || 80;
    const width = Math.max(10, Math.min(44, columns - this.label.length - percent.length - counts.length - 8));

    const drawn = Math.min(width - 1, Math.floor((width - 1) * ratio));
    const stroke = mint('━'.repeat(drawn) + '✐');
    const guide = pc.dim('╌'.repeat(width - 1 - drawn));
    process.stdout.write(`\r\x1b[2K${pc.dim(this.label)}  ${stroke}${guide} ${percent}  ${pc.dim(counts)}`);
  }
}

/**
 * Live byte counter for work whose total is unknown in advance (streaming a
 * .penpot to disk): "writing out.penpot… ✐ 84.2 MB". Interval-driven, so it
 * advances whenever the writer yields; TTY-only like the bar.
 */
export class ByteTicker {
  private timer: NodeJS.Timeout | undefined;
  private readonly enabled = process.stdout.isTTY === true;

  constructor(private readonly label: string) {}

  start(bytesNow: () => number): void {
    if (!this.enabled) return;
    const render = (): void => {
      const mb = bytesNow() / (1024 * 1024);
      const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(mb * 1024)} KB`;
      process.stdout.write(`\r\x1b[2K${pc.dim(this.label)}  ${mint('✐')} ${size}`);
    };
    render();
    this.timer = setInterval(render, 150);
  }

  /** Clears the line; the caller prints the final summary. */
  stop(): void {
    if (!this.enabled) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write('\r\x1b[2K');
  }
}
