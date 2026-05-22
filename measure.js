// bench/measure.js
//
// Shared measurement helpers for the shard-count sweep harnesses.
// Zero dependencies — node:* only.
//
// The honest-measurement rules these helpers enforce:
//
//   1. Force GC before every heap reading. Without --expose-gc + an explicit
//      global.gc() call, heapUsed is dominated by uncollected garbage and
//      any "linearity" curve is just GC-timing noise. If global.gc is not
//      available the harness refuses to run rather than produce a bad chart.
//
//   2. Report DELTAS from a baseline taken before any sockets/pools exist.
//      The Node runtime itself is tens of MB; that constant offset would
//      otherwise swamp the per-connection slope we actually care about.
//
//   3. Report BOTH heapUsed and rss. heapUsed (post-GC) is the clean signal
//      for "memory the module retains". rss is "what the OS / OpenShift
//      sees" — it does NOT shrink back after GC, so for the pod-eviction
//      question rss is the more honest number even though it's noisier.

import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Assert that the process was launched with --expose-gc. We refuse to run
 * without it: a sweep measured on un-GC'd heap is actively misleading.
 */
export const requireGc = () => {
  if (typeof global.gc !== 'function') {
    console.error(
      'FATAL: run with --expose-gc, e.g.\n' +
      '  node --expose-gc bench/sweep-sockets.js'
    );
    process.exit(1);
  }
};

/**
 * Force a few GC cycles and let microtasks drain. Multiple passes because a
 * single global.gc() does not always collect everything reachable-then-
 * unreachable in one go (finalizers, weak refs).
 */
export const settleAndGc = async (settleMs = 250) => {
  // Let any pending async allocation (socket setup, pool internals) land
  // before we freeze the numbers.
  await sleep(settleMs);
  // Three passes is empirically enough to reach a stable heapUsed in this
  // kind of micro-benchmark without being wasteful.
  for (let i = 0; i < 3; i += 1) {
    global.gc();
    await sleep(20);
  }
};

/**
 * Take a memory reading. Pure modulo the syscall.
 * @returns {{ rss: number, heapUsed: number, heapTotal: number, external: number, arrayBuffers: number }}
 */
export const readMemory = () => {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
};

/** Bytes -> whole KB, for readable CSV output. */
const kb = (bytes) => Math.round(bytes / 1024);

/**
 * Build a CSV row collector. The baseline is captured by an explicit
 * async `captureBaseline()` call rather than at construction — this lets
 * the caller settle + GC first, so every recorded delta is measured from a
 * clean, post-GC zero point (otherwise early rows show negative heap
 * deltas as the runtime's own startup garbage gets collected).
 *
 * @param {string[]} extraColumns  - column names beyond the standard set
 */
export const createCsvCollector = (extraColumns = []) => {
  /** @type {ReturnType<typeof readMemory> | null} */
  let baseline = null;
  /** @type {string[]} */
  const rows = [];

  // Column order is fixed so the CSV is diffable across runs.
  const header = [
    'connections',
    'rss_kb', 'heap_used_kb',
    'delta_rss_kb', 'delta_heap_used_kb',
    'delta_rss_per_conn_kb', 'delta_heap_per_conn_kb',
    'external_kb', 'array_buffers_kb',
    ...extraColumns,
  ].join(',');

  /** Capture the post-settle baseline. Call once, before the first record(). */
  const captureBaseline = async () => {
    await settleAndGc();
    baseline = readMemory();
  };

  /**
   * @param {number} connections  - how many connections/pools are open now
   * @param {Record<string, number|string>} [extra]  - values for extraColumns
   */
  const record = (connections, extra = {}) => {
    if (!baseline) throw new Error('call captureBaseline() before record()');
    const m = readMemory();
    const dRss = m.rss - baseline.rss;
    const dHeap = m.heapUsed - baseline.heapUsed;
    // Per-connection slope. Guard divide-by-zero at the N=0 baseline row.
    const perRss = connections > 0 ? dRss / connections : 0;
    const perHeap = connections > 0 ? dHeap / connections : 0;
    const row = [
      connections,
      kb(m.rss), kb(m.heapUsed),
      kb(dRss), kb(dHeap),
      kb(perRss), kb(perHeap),
      kb(m.external), kb(m.arrayBuffers),
      ...extraColumns.map((c) => extra[c] ?? ''),
    ].join(',');
    rows.push(row);
  };

  const toCsv = () => [header, ...rows].join('\n') + '\n';

  return { captureBaseline, record, toCsv, get baseline() { return baseline; } };
};
