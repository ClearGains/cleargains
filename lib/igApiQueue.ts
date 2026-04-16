'use client';

/**
 * Client-side rate-limited queue for all IG API calls.
 *
 * Rules enforced:
 *  - Max 20 calls per 60-second rolling window (shared across all accounts)
 *  - Minimum 1 second gap between consecutive calls
 *  - Per-account fair-share: when both CFD and SPREADBET accounts are active,
 *    each is capped at 10/min; when only one is active it gets the full 20/min
 *  - On 403 (rate limit): pause ALL calls for 60 seconds, then resume
 *  - Tracks timestamps of recent calls so the UI can display a live counter
 */

const MAX_PER_MINUTE  = 20;
const MIN_GAP_MS      = 1_000;
const PAUSE_ON_403_MS = 60_000;

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

type QueueEntry = {
  fn:      () => Promise<Response>;
  resolve: (r: Response) => void;
  reject:  (e: unknown)  => void;
  acctId?: string;
};

class IGApiQueue {
  private queue:         QueueEntry[]          = [];
  private busy           = false;
  private lastCallAt     = 0;
  private pausedUntil    = 0;
  private callTimes:     number[]              = [];
  private acctCallTimes: Map<string, number[]> = new Map();
  private listeners:     (() => void)[]        = [];

  /** Enqueue an IG API call. Pass acctId to enable per-account fair-share limiting. */
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

      // 2. Global per-minute cap
      let now = Date.now();
      this.callTimes = this.callTimes.filter(t => now - t < 60_000);
      if (this.callTimes.length >= MAX_PER_MINUTE) {
        const waitFor = this.callTimes[0] + 60_000 - Date.now();
        if (waitFor > 0) await sleep(waitFor);
        this.callTimes = this.callTimes.filter(t => Date.now() - t < 60_000);
      }

      // 3. Per-account fair-share cap
      if (item.acctId) {
        now = Date.now();
        // Active = had calls in last 60s, or currently queued
        const activeAccts = new Set<string>();
        for (const [id, times] of this.acctCallTimes) {
          if (times.some(t => now - t < 60_000)) activeAccts.add(id);
        }
        activeAccts.add(item.acctId);
        this.queue.forEach(q => { if (q.acctId) activeAccts.add(q.acctId); });

        const perAcctCap = Math.floor(MAX_PER_MINUTE / Math.max(1, activeAccts.size));
        const myTimes = (this.acctCallTimes.get(item.acctId) ?? []).filter(t => now - t < 60_000);
        this.acctCallTimes.set(item.acctId, myTimes);

        if (myTimes.length >= perAcctCap && myTimes.length > 0) {
          const waitFor = myTimes[0] + 60_000 - Date.now();
          if (waitFor > 0) await sleep(waitFor);
          const refreshed = (this.acctCallTimes.get(item.acctId) ?? []).filter(t => Date.now() - t < 60_000);
          this.acctCallTimes.set(item.acctId, refreshed);
        }
      }

      // 4. Enforce minimum gap
      const gap = Date.now() - this.lastCallAt;
      if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);

      // 5. Execute
      this.lastCallAt = Date.now();
      this.callTimes.push(this.lastCallAt);
      if (item.acctId) {
        const times = this.acctCallTimes.get(item.acctId) ?? [];
        times.push(this.lastCallAt);
        this.acctCallTimes.set(item.acctId, times);
      }
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

  /** Calls in the last 60 seconds for a specific account. */
  recentCallsFor(acctId: string): number {
    return (this.acctCallTimes.get(acctId) ?? []).filter(t => Date.now() - t < 60_000).length;
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
