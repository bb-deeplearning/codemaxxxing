# Codex Parity — Final Performance Audit

**Generated:** 2026-05-14T01:55:47.430Z
**Baseline:** wave_0 (18369b2a8, captured 2026-05-13T16:31:35.286Z)
**Budget:** p50 ≤ 5%, p95 ≤ 10%, p99 ≤ 15%

## Summary

- Baseline metrics tracked: **2**
- Within budget: **2**
- Over budget: **0**
- Wave-introduced metrics (no baseline; informational): **26**

**Result:** PASS — no regressions beyond budget.

## Hot-path summary

### TUI render

| Metric | Wave | Baseline p50 | Current p50 | Δp50 | Δp95 | Δp99 | Status |
|---|---|---|---|---|---|---|---|
| `session.render.steady` | wave_11 | 53.0µs | 48.3µs | -8.7% | -54.8% | -63.6% | OK |

### Pty push / read

| Metric | Wave | Baseline p50 | Current p50 | Δp50 | Δp95 | Δp99 | Status |
|---|---|---|---|---|---|---|---|
| `pty.push.4kb` | wave_2 | 1.9µs | 542ns | -71.1% | -9.1% | -32.6% | OK |

## Wave-introduced metrics (no baseline comparison)

These metrics were added by individual waves and have no wave-0 reference. Recorded for future regression checks; budget cannot be applied retroactively.

### wave_1

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `head-tail.push.4kb` | 500 | 1.2µs | 3.2µs | 5.5µs | 875ns | 54.0µs |
| `head-tail.push.large` | 100 | 542ns | 2.8µs | 6.3µs | 250ns | 7.3µs |
| `head-tail.snapshot` | 1000 | 875ns | 3.4µs | 4.8µs | 708ns | 37.6µs |

### wave_2

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `pty.push.4kb.headtail` | 500 | 1.0µs | 3.6µs | 6.9µs | 875ns | 16.6µs |
| `pty.read.immediate` | 200 | 23.2µs | 46.0µs | 62.9µs | 14.3µs | 64.6µs |
| `pty.read.timeout` | 50 | 101.41ms | 105.50ms | 109.94ms | 100.27ms | 109.94ms |
| `pty.read.wakeup` | 50 | 8.31ms | 34.35ms | 161.82ms | 58.0µs | 161.82ms |

### wave_3

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `process.exec_command.short_command` | 20 | 78.64ms | 138.34ms | 172.97ms | 66.85ms | 172.97ms |
| `process.write_stdin.poll_with_data` | 30 | 101.59ms | 156.97ms | 164.90ms | 100.50ms | 164.90ms |

### wave_4

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `process.render.steady` | 1000 | 51.5µs | 61.2µs | 73.0µs | 46.6µs | 112.3µs |
| `process.render.tree.steady` | 100 | 4.38ms | 4.51ms | 4.55ms | 4.29ms | 4.59ms |

### wave_5

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `mailbox.drain.100_messages` | 200 | 340.0µs | 591.6µs | 2.68ms | 272.0µs | 3.93ms |
| `mailbox.send` | 1000 | 9.8µs | 16.9µs | 28.7µs | 6.0µs | 253.1µs |
| `mailbox.subscribe.wakeup_latency` | 300 | 27.2µs | 49.0µs | 104.0µs | 19.0µs | 1.13ms |

### wave_6

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `registry.agentIdForPath.lookup` | 1000 | 791ns | 2.8µs | 5.9µs | 500ns | 13.0µs |
| `registry.liveAgents.snapshot` | 1000 | 3.0µs | 6.3µs | 10.5µs | 1.8µs | 16.3µs |
| `registry.reserveSpawnSlot.then.commit` | 1000 | 8.5µs | 16.2µs | 25.2µs | 4.5µs | 76.1µs |

### wave_7

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `agentControl.listAgents.populated` | 1000 | 11.9µs | 22.7µs | 88.8µs | 8.1µs | 9.99ms |
| `agentControl.sendInterAgentCommunication` | 1000 | 100.0µs | 175.1µs | 1.39ms | 76.3µs | 11.70ms |
| `agentControl.spawnAgent` | 200 | 574.1µs | 1.22ms | 4.21ms | 437.2µs | 4.97ms |

### wave_9

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `runloop.spawn_v2` | 200 | 505.1µs | 714.6µs | 3.83ms | 430.3µs | 4.66ms |
| `runloop.step.4_pending_mailbox` | 200 | 10.5µs | 26.5µs | 42.7µs | 7.5µs | 68.3µs |
| `runloop.step.empty_mailbox` | 200 | 11.1µs | 18.2µs | 31.0µs | 7.1µs | 42.7µs |

### wave_11

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `session.render.steady.4_siblings` | 1000 | 60.8µs | 72.9µs | 84.0µs | 53.5µs | 125.7µs |

### wave_14

| Metric | Samples | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|
| `e2e.concurrent.4sibling_vs_single` | 10 | 192.81ms | 522.17ms | 522.17ms | 148.71ms | 522.17ms |
| `e2e.mailbox.wakeup_latency` | 100 | 124.1µs | 291.0µs | 1.36ms | 94.6µs | 4.81ms |

## All baseline metrics (alphabetical)

| Metric | Wave | Baseline p50 | Current p50 | Δp50 | Baseline p99 | Current p99 | Δp99 | Status |
|---|---|---|---|---|---|---|---|---|
| `pty.push.4kb` | wave_2 | 1.9µs | 542ns | -71.1% | 7.7µs | 5.2µs | -32.6% | OK |
| `session.render.steady` | wave_11 | 53.0µs | 48.3µs | -8.7% | 185.1µs | 67.3µs | -63.6% | OK |

## Baseline metrics not re-measured by any wave

These baseline metrics had no wave-side bench file re-measure them. Their wave-0 captures stand as the reference; if a regression on these surfaces in production, future waves should add a corresponding bench.

- `bus.publish.no_subscribers` (p50=10.0µs, p99=43.5µs)
- `bus.publish.one_subscriber` (p50=13.3µs, p99=46.0µs)
- `eventv2.run.text_delta` (p50=72.7µs, p99=129.9µs)
- `permission.ask.cached` (p50=14.7µs, p99=42.8µs)
- `permission.ask.uncached` (p50=22.3µs, p99=54.8µs)
- `runloop.step.no_op` (p50=19.5µs, p99=293.8µs)
- `session.render.first_paint` (p50=936.3µs, p99=1.63ms)
- `snapshot.patch` (p50=33.61ms, p99=166.46ms)
- `snapshot.track` (p50=24.00ms, p99=51.32ms)
