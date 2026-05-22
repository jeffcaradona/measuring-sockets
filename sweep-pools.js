// bench/sweep-pools.js
//
// OPTION 2 — ConnectionPool object memory sweep.
//
// Constructs N real `mssql.ConnectionPool` objects but never calls
// .connect(). This measures the per-pool OBJECT overhead: the ConnectionPool
// instance, its embedded tarn pool, the frozen config, the event-emitter
// machinery — everything that exists the moment you do `new ConnectionPool()`
// and before a single socket is opened.
//
// What this models:  the fixed cost of having 30 pool objects resident,
//                    independent of how many connections they hold.
// What this OMITS:    sockets (Option 3 / sweep-sockets.js covers those) and
//                     the tedious per-connection packet buffers (only the
//                     real-driver connected pass shows those).
//
// Why this matters separately from Option 3: in the real module, memory is
// (pool objects) + (sockets) + (driver buffers). Option 3 gave us the socket
// slope; this gives us the pool-object slope. Add them for a no-database
// estimate; the connected pass validates it.
//
// No SQL Server and no credentials required — we never connect. The config
// points at a bogus host that is never contacted.
//
// Run:
//   node --expose-gc bench/sweep-pools.js [maxPools]
//
// Default: maxPools=30. Output: CSV on stdout.
//   node --expose-gc bench/sweep-pools.js > pools-sweep.csv

import mssql from 'mssql';
import { requireGc, settleAndGc, createCsvCollector } from './measure.js';

requireGc();

const MAX_POOLS = Number(process.argv[2] ?? 30);

/**
 * Build a representative pool config. Mirrors the shape the real module's
 * config/index.js produces, so the per-pool object cost we measure matches
 * production. The `server` value is intentionally unreachable — we never
 * call .connect(), so it is never contacted.
 *
 * @param {string} database
 */
const makePoolConfig = (database) => ({
  server: '127.0.0.1',          // never contacted; .connect() is never called
  port: 1433,
  user: 'bench',
  password: 'bench',            // not a real credential — no connection made
  database,
  pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  options: { encrypt: true, trustServerCertificate: true },
  connectionTimeout: 15_000,
  requestTimeout: 30_000,
});

const main = async () => {
  const csv = createCsvCollector(['pool_objects']);

  await csv.captureBaseline();
  csv.record(0, { pool_objects: 0 });

  /** @type {import('mssql').ConnectionPool[]} */
  const pools = [];

  for (let n = 1; n <= MAX_POOLS; n += 1) {
    // Construct one pool. `new ConnectionPool(config)` allocates the object
    // graph but opens no sockets — that only happens on .connect(). We also
    // attach an 'error' listener because the real module does, and a
    // registered listener is part of the per-pool object footprint.
    const pool = new mssql.ConnectionPool(makePoolConfig(`DSHARD${String(n).padStart(2, '0')}`));
    // No-op listener: matches the real module, which must listen or an
    // emitted 'error' would be unhandled. Costs a closure per pool — small,
    // but we want it IN the measurement, not omitted.
    pool.on('error', () => {});
    pools.push(pool);

    await settleAndGc();
    csv.record(pools.length, { pool_objects: pools.length });
  }

  process.stdout.write(csv.toCsv());
  process.stderr.write(`\nconstructed ${MAX_POOLS} ConnectionPool objects (never connected)\n`);

  // Teardown. close() on a never-connected pool is safe and resolves fast;
  // it tears down the tarn pool's internal timers so the process exits
  // cleanly.
  for (const p of pools) {
    try { await p.close(); } catch { /* never connected — nothing to fail */ }
  }
};

main().catch((err) => {
  console.error('pool sweep failed:', err);
  process.exit(1);
});
