'use client';

/**
 * Client-side rate-limited queue for all IG API calls.
 *
 * Rules enforced:
 *  - Max 20 calls per 60-second rolling window
 *  - Minimum 1 second gap between consecutive calls
 *  - On 403 (rate limit): pause ALL calls for 60 seconds, then resume
 *  - Tracks timestamps of recent calls so the UI can display a live counter
 */

const MAX_PER_MINUTE   = 20;
const MIN_GAP_MS       = 1_000;
const PAUSE_ON_403_MS  = 60_000;

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

type QueueEntry = {
  fn:      () => Promise<Response>;
  resolve: (r: Response) => void;
  reject:  (e: unknown)  => void;
};

class IGApiQueue {
  private queue:        QueueEntry[] = [];
  private busy          = false;
  private lastCallAt    = 0;
  private pausedUntil   = 0;
  private callTimes:    number[]      = [];
  private listeners:    (() => void)[] = [];

  /** Enqueue an IG API call and return a Promise<Response>. */
  enqueue(fn: () => Promise<Response>): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.busy) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.busy = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      // ── 1. Honour 403 pause ───────────────────────────────────────────────
      const pauseLeft = this.pausedUntil - Date.now();
      if (pauseLeft > 0) {
        this.notify();
        await sleep(pauseLeft);
      }

      // ── 2. Enforce per-minute cap ─────────────────────────────────────────
      const now = Date.now();
      this.callTimes = this.callTimes.filter(t => now - t < 60_000);
      if (this.callTimes.length >= MAX_PER_MINUTE) {
        const waitFor = this.callTimes[0] + 60_000 - Date.now();
        if (waitFor > 0) await sleep(waitFor);
        this.callTimes = this.callTimes.filter(t => Date.now() - t < 60_000);
      }

      // ── 3. Enforce minimum gap ────────────────────────────────────────────
      const gap = Date.now() - this.lastCallAt;
      if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);

      // ── 4. Execute ────────────────────────────────────────────────────────
      this.lastCallAt = Date.now();
      this.callTimes.push(this.lastCallAt);
      this.notify();

      try {
        const res = await item.fn();
        if (res.status === 403) {
          this.pausedUntil = Date.now() + PAUSE_ON_403_MS;
          console.warn('[igQueue] 403 received — pausing all IG calls for 60 s');
          this.notify();
        }
        item.resolve(res);
      } catch (e) {
        item.reject(e);
      }
    }
    this.busy = false;
  }

  /** Number of calls made in the last 60 seconds (for UI counter). */
  get recentCalls(): number {
    const now = Date.now();
    return this.callTimes.filter(t => now - t < 60_000).length;
  }

  /** Remaining pause in ms (0 when not rate-limited). */
  get pauseRemaining(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /** Subscribe to counter/pause updates. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify() { this.listeners.forEach(l => l()); }
}

// Module-level singleton — one queue per browser session.
// SSR guard: the queue is a no-op stub on the server (API routes are never called server-side).
export const igQueue: IGApiQueue =
  typeof window !== 'undefined' ? new IGApiQueue() : ({} as IGApiQueue);
