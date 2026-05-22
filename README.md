# Memory sweep harness

Measures how this module's memory scales with shard/connection count.
Answers the question: **does resource use grow linearly with shard count,
or is there a super-linear blowup that would destabilize the host?**

All harnesses are zero-dependency ESM (`node:*` only, plus `mssql` which the
module already depends on). None requires a running SQL Server.

## Why three passes

The real module's memory is roughly:

    total ≈ (pool objects) + (open sockets) + (driver packet buffers)

No single cheap experiment captures all three, so we measure in layers:

| Pass | Script | Measures | Omits | Needs DB? |
|------|--------|----------|-------|-----------|
| Option 3 | `sweep-sockets.js` | TCP socket cost | pool objects, driver buffers | no |
| Option 2 | `sweep-pools.js` | `ConnectionPool` object cost | sockets, driver buffers | no |
| Real | (TODO) connected pass | everything, exactly | nothing | yes |

Option 2 + Option 3 added together is a no-database *estimate* of the real
cost. The connected pass validates it and adds the `tedious` per-connection
packet-buffer cost that neither isolated pass can see.

## Running

Both scripts REQUIRE `--expose-gc`. Without it they refuse to run — a sweep
measured on un-GC'd heap is just garbage-collector timing noise, not a
memory curve.

    # Option 3 — raw sockets. Args: [maxSteps] [socketsPerStep]
    node --expose-gc bench/sweep-sockets.js 30 10 > sockets-sweep.csv

    # Option 2 — pool objects. Args: [maxPools]
    node --expose-gc bench/sweep-pools.js 30 > pools-sweep.csv

CSV goes to stdout; diagnostics go to stderr, so `> file.csv` captures only
data.

## Reading the CSV

| Column | Meaning |
|--------|---------|
| `connections` | x-axis: sockets (Option 3) or pools (Option 2) open at this row |
| `rss_kb` | resident set size — **what OpenShift sees**; does not shrink after GC |
| `heap_used_kb` | V8 heap in use, post-GC — clean signal for retained memory |
| `delta_*` | same numbers minus the pre-sweep baseline (strips the ~Node runtime constant) |
| `delta_*_per_conn_kb` | marginal cost per connection — **the linearity signal** |

### Interpreting the slope

- `delta_*_per_conn_kb` trending **down** then flattening = healthy. Fixed
  costs amortizing; marginal cost is a small constant. Linear overall.
- `delta_*_per_conn_kb` trending **up** = super-linear growth. Investigate
  before scaling shard count — this is the destabilization signal.
- `rss` is lumpy (steps, not a smooth line) because the OS allocates memory
  in page arenas. Judge `rss` by its trend across many rows, not row-to-row.
- `heap_used` is the smooth one — read linearity off that, confirm the
  real-world footprint off `rss`.

## Caveats

- These are micro-benchmarks on an idle process. The real module under
  request load will show higher and noisier numbers — pools fill, requests
  allocate. Use these for the *shape* of the curve, not absolute capacity
  planning.
- `rss` never returning to baseline after teardown is expected: the OS does
  not reclaim eagerly. That is also why `rss`, not `heap_used`, is the right
  number for the pod-eviction question.
