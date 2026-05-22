// bench/sweep-sockets.js
//
// OPTION 3 — raw-socket memory sweep.
//
// Measures how Node.js memory scales as you open N TCP connections, with
// NO mssql driver and NO database involved. This isolates the socket-side
// cost: kernel socket buffers surfaced to Node, the JS `Socket` objects,
// and their internal read/write buffers.
//
// What this models:  the "30 pools each holding K sockets" socket cost.
// What this OMITS:    the mssql/tedious per-connection packet buffers and
//                     the ConnectionPool/tarn object overhead. Those are
//                     covered by Option 2 (sweep-pools.js) and the real
//                     driver pass.
//
// So: this is a LOWER BOUND on the real per-connection cost, and the
// cleanest possible signal for the question "does socket memory scale
// linearly with connection count".
//
// Run:
//   node --expose-gc bench/sweep-sockets.js [maxConnections] [socketsPerStep]
//
// Defaults: maxConnections=30, socketsPerStep=10  (i.e. simulate 30 pools
// of 10 sockets each = 300 sockets, measured every 10).
//
// Output: CSV on stdout. Redirect to a file:
//   node --expose-gc bench/sweep-sockets.js > sockets-sweep.csv

import net from 'node:net';
import { requireGc, settleAndGc, createCsvCollector } from './measure.js';

requireGc();

// CLI args. Kept positional and tiny — this is a dev harness, not a product.
const MAX_CONNECTIONS = Number(process.argv[2] ?? 30);
const SOCKETS_PER_STEP = Number(process.argv[3] ?? 10);

/**
 * Start an in-process TCP sink. It accepts connections and does nothing
 * else — no echo, no protocol. We keep a reference to every accepted
 * socket so the SERVER side's memory is held too (a real SQL Server holds
 * connection state; not modelling that here, but we at least don't let the
 * accepted side get GC'd, which would understate the picture).
 *
 * Why in-process: avoids a second process and any IPC/credential setup.
 * The loopback socket pair still allocates real kernel buffers on both
 * ends, which is what we are measuring.
 */
const startSink = () => new Promise((resolve) => {
  /** @type {import('node:net').Socket[]} */
  const accepted = [];
  const server = net.createServer((socket) => {
    // Disable Nagle so the socket behaves like a real DB connection would
    // under a latency-sensitive driver. Negligible memory effect; included
    // for realism.
    socket.setNoDelay(true);
    accepted.push(socket);
  });
  // Port 0 = let the OS pick a free port. Loopback only.
  server.listen(0, '127.0.0.1', () => {
    resolve({ server, accepted, port: server.address().port });
  });
});

/**
 * Open one client socket to the sink and resolve once it is fully
 * connected. We resolve on 'connect' (not just return the socket) so the
 * measurement happens against fully-established connections, not
 * half-open ones still mid-handshake.
 *
 * @param {number} port
 * @returns {Promise<import('node:net').Socket>}
 */
const openClientSocket = (port) => new Promise((resolve, reject) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.setNoDelay(true);
  socket.once('connect', () => resolve(socket));
  socket.once('error', reject);
});

const main = async () => {
  const { server, accepted, port } = await startSink();

  // The collector captures its baseline AFTER a settle (below) — after the
  // sink server exists but before any client sockets. The sink server's own
  // footprint is therefore excluded from the deltas, which is correct: we
  // want the client-connection cost, and in the real module the "server" is
  // an entirely separate process (SQL Server).
  const csv = createCsvCollector(['accepted_sockets']);

  // Capture the post-settle baseline, then record the N=0 zero point.
  await csv.captureBaseline();
  csv.record(0, { accepted_sockets: 0 });

  /** @type {import('node:net').Socket[]} */
  const clients = [];
  const totalSockets = MAX_CONNECTIONS * SOCKETS_PER_STEP;

  for (let step = 1; step <= MAX_CONNECTIONS; step += 1) {
    // Open one "pool worth" of sockets for this step.
    for (let i = 0; i < SOCKETS_PER_STEP; i += 1) {
      // Sequential await rather than Promise.all: keeps peak transient
      // allocation low so the measurement reflects steady-state retained
      // memory, not a connection-storm spike.
      clients.push(await openClientSocket(port));
    }
    await settleAndGc();
    // `step` is the pool-equivalent count; clients.length is the true
    // socket count. Both are useful — linearity should hold against
    // either, but socket count is the physically meaningful x-axis.
    csv.record(clients.length, { accepted_sockets: accepted.length });
  }

  // Emit CSV to stdout. Diagnostics go to stderr so a `> file.csv`
  // redirect captures only the data.
  process.stdout.write(csv.toCsv());
  process.stderr.write(
    `\nswept ${MAX_CONNECTIONS} steps x ${SOCKETS_PER_STEP} sockets ` +
    `= ${totalSockets} sockets total\n`
  );

  // Teardown. Destroy every client + accepted socket, then close the
  // server, so the process exits cleanly without --force.
  for (const s of clients) s.destroy();
  for (const s of accepted) s.destroy();
  server.close();
};

main().catch((err) => {
  console.error('sweep failed:', err);
  process.exit(1);
});
