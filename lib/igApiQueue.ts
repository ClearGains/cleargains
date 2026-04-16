'use client';

/**
 * Client-side rate-limited queue for all IG API calls.
 *
 * Rules enforced:
 *  - Max 15 calls per 60-second rolling window (single shared counter for both tabs)
 *  - Minimum 1 second gap between consecutive calls
 *  - On 403 (rate limit): pause ALL calls for 60 seconds, then resume
 *  - Tracks timestamps of recent calls so the UI can display a live counter
 *
 * withTradeLock — shared across every IGAccountPanel instance on the page.
 *  Guarantees only one "switch account → execute trade" sequence runs at a time,
 *  so CFD and spread-bet operations never interleave mid-sequence.
 */

const MAX_PER_MINUTE  = 15;
const MIN_GAP_MS      = 1_000;
const PAUSE_ON_403_MS = 60_000;

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

// ── Trade lock ─────────────────────────────────────────────────────────────────
// Module-level promise chain acting as a mutex.  Every call to withTradeLock
// queues behind the previous one, so only one trade sequence runs at a time
// regardless of which panel initiated it.

let _tradeLockChain: Promise<void> = Promise.resolve();

/**
 * Run `fn` exclusively — no other withTradeLock call can start until fn resolves.
 * Use this to wrap the switch-account → place-order sequence so CFD and SB
 * operations never interleave.
 */
export function withTradeLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _tradeLockChain;
  let release: () => void;
  // Extend the chain: the next caller waits for THIS call to complete
  _tradeLockChain = new Promise<void>(r => { release = r; });
  return prev.then(async (): Promise<T> => {
    try   { return await fn(); }
    finally { release!(); }
  });
}

// ── Queue ─────────────────────────────────────────────────────────────────────

type QueueEntry = {
  fn:      () => Promise<Response>;
  resolve: (r: Response) => void;
  reject:  (e: unknown)  => void;
  acctId?: string;
};

class IGApiQueue {
  private queue:      QueueEntry[]   = [];
  private busy        = false;
  private lastCallAt  = 0;
  private pausedUntil = 0;
  private callTimes:  number[]       = [];
  private listeners:  (() => void)[] = [];

  /** Enqueue an IG API call. acctId is retained for telemetry only. */
  enqueue(fn: () => Promise<Response>, acctId?: string): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, acctId });
      if (!this.busy) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.busy = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      // 1. Honour 403 pause
      const pauseLeft = this.pausedUntil - Date.now();
      if (pauseLeft > 0) { this.notify(); await sleep(pauseLeft); }

      // 2. Global per-minute cap (15/min)
      let now = Date.now();
      this.callTimes = this.callTimes.filter(t => now - t < 60_000);
      if (this.callTimes.length >= MAX_PER_MINUTE) {
        const waitFor = this.callTimes[0] + 60_000 - Date.now();
        if (waitFor > 0) await sleep(waitFor);
        this.callTimes = this.callTimes.filter(t => Date.now() - t < 60_000);
      }

      // 3. Enforce minimum gap
      const gap = Date.now() - this.lastCallAt;
      if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);

      // 4. Execute
      this.lastCallAt = Date.now();
      this.callTimes.push(this.lastCallAt);
      this.notify();

      try {
        const res = await item.fn();
        if (res.status === 403) {
          this.pausedUntil = Date.now() + PAUSE_ON_403_MS;
          console.warn('[igQueue] 403 — pausing all IG calls for 60s');
          this.notify();
        }
        item.resolve(res);
      } catch (e) {
        item.reject(e);
      }
    }
    this.busy = false;
  }

  /** Total calls in the last 60 seconds. */
  get recentCalls(): number {
    return this.callTimes.filter(t => Date.now() - t < 60_000).length;
  }

  /** Alias kept for UI compatibility — same as recentCalls (single shared counter). */
  recentCallsFor(_acctId: string): number {
    return this.recentCalls;
  }

  /** Remaining 403-pause in ms (0 when not rate-limited). */
  get pauseRemaining(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify() { this.listeners.forEach(l => l()); }
}

export const igQueue: IGApiQueue =
  typeof window !== 'undefined' ? new IGApiQueue() : ({} as IGApiQueue);
