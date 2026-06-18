/**
 * v2.1 — server-side console capture for the dashboard's Console view.
 *
 * Mirrors everything the process writes to stdout / stderr into an
 * in-memory ring buffer + a live SSE subscriber set. The dashboard's
 * Event Logs page exposes a CONSOLE button next to Clear Console that
 * connects to the SSE stream and renders the raw bridge chatter
 * (`[MeshtasticSerial] pkt from=… to=…`, admin readbacks, the
 * `[Radios]`/`[Backup]`/`[WeatherPoller]` structured lines, etc.).
 *
 * Why monkey-patch instead of tailing `docker logs`: this works in
 * dev mode, in containers, and in stripped-down deployments without
 * shelling out. It also captures the bridge's own console.log calls
 * directly — the same lines the operator would see via
 * `docker logs -f <container>` — so the dashboard view matches what
 * docker shows, line-for-line.
 *
 * Originals are kept and forwarded to so docker logs / journalctl
 * keep working. The capture is best-effort — if a subscriber throws
 * we swallow it; the original stdout write already happened.
 */

interface CapturedLine {
  /** Auto-incrementing id so SSE can dedupe + clients can detect gaps. */
  id: number;
  /** Epoch ms when console.log was called. */
  ts: number;
  /** 'log' | 'warn' | 'error' — matches the patched method. */
  level: 'log' | 'warn' | 'error';
  /** Joined argument list with the standard JSON / Error.stack treatment. */
  text: string;
}

type Subscriber = (line: CapturedLine) => void;

class ConsoleCapture {
  /** Default ring-buffer cap. ~2000 lines × ~300 chars = ~600KB, well
   *  under any meaningful memory threshold on a Jetson Nano. Bigger
   *  buffers would compete with the message/event histories. */
  private maxBuffer = 2000;
  private buffer: CapturedLine[] = [];
  private nextId = 1;
  private subscribers = new Set<Subscriber>();
  private installed = false;

  /** Replace console.log / .warn / .error with capture-and-forward
   *  wrappers. Idempotent — calling twice is a no-op. */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: any[]): void => {
      origLog(...args);
      this.capture('log', args);
    };
    console.warn = (...args: any[]): void => {
      origWarn(...args);
      this.capture('warn', args);
    };
    console.error = (...args: any[]): void => {
      origError(...args);
      this.capture('error', args);
    };

    origLog(`[ConsoleCapture] installed (buffer=${this.maxBuffer} lines)`);
  }

  private capture(level: 'log' | 'warn' | 'error', args: any[]): void {
    // Standard util-style argument join: strings as-is, Errors → stack,
    // objects → JSON. Skips cycles via try/catch — falls back to
    // String(value) when JSON.stringify chokes.
    const text = args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(' ');

    const line: CapturedLine = {
      id: this.nextId++,
      ts: Date.now(),
      level,
      text,
    };

    this.buffer.push(line);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }

    for (const sub of this.subscribers) {
      try { sub(line); } catch { /* subscriber threw — ignore */ }
    }
  }

  /** Snapshot of the buffer for backlog send on SSE connect. */
  getBuffer(): CapturedLine[] {
    return this.buffer.slice();
  }

  /** Live subscription — returns an unsubscribe fn. The new SSE
   *  client calls this AFTER replaying the backlog so it doesn't miss
   *  lines that arrive between getBuffer() and the subscribe(). */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  /** Clear the buffer (does not affect the originals — docker logs
   *  still has every line). Returns the count we wiped. */
  clear(): number {
    const n = this.buffer.length;
    this.buffer = [];
    return n;
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}

export const consoleCapture = new ConsoleCapture();
export type { CapturedLine };
