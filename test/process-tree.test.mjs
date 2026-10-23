import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessMonitor, descendants } from '../src/process-tree.mjs';

test('slow process scans remain asynchronous and concurrent callers share one scan', async () => {
  let complete, calls = 0, tables = 0;
  const monitor = createProcessMonitor({
    readTable: () => { calls++; return new Promise(resolve => { complete = resolve; }); },
    onTable: () => { tables++; },
    onError: assert.fail,
  });
  const first = monitor.poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(monitor.poll(), first);
  assert.equal(monitor.poll(true), first);
  // A pending scan must not hold up control sockets, logging, or heartbeat timers.
  let heartbeat = false;
  await new Promise(resolve => setTimeout(() => { heartbeat = true; resolve(); }, 10));
  assert.equal(heartbeat, true);
  assert.equal(tables, 0);
  complete([]);
  assert.equal(await first, true);
  assert.equal(tables, 1);
});

test('timeouts back off, limit repeated warnings, and report recovery', async () => {
  let now = 0, calls = 0, failing = true, recovered = 0, tables = 0;
  const warnings = [];
  const monitor = createProcessMonitor({
    now: () => now,
    readTable: async () => { calls++; if (failing) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); return []; },
    onTable: () => { tables++; },
    onError: (error, retryMs) => warnings.push({ code: error.code, retryMs }),
    onRecovery: () => { recovered++; },
  });
  assert.equal(await monitor.poll(), false);
  assert.deepEqual(warnings, []);
  now = 9999; await monitor.poll(); assert.equal(calls, 1);
  now = 10000; await monitor.poll(); assert.equal(calls, 2);
  now = 29999; await monitor.poll(); assert.equal(calls, 2);
  now = 30000; await monitor.poll(); assert.equal(calls, 3);
  assert.deepEqual(warnings, []);
  now = 70000; await monitor.poll(); assert.equal(calls, 4);
  assert.deepEqual(warnings, [{ code: 'ETIMEDOUT', retryMs: 60000 }]);
  now = 129999; await monitor.poll(); assert.equal(calls, 4);
  now = 130000; await monitor.poll(); assert.equal(calls, 5);
  assert.equal(warnings.length, 1);
  now = 300000; await monitor.poll(); assert.equal(warnings.length, 1);
  now = 370000; await monitor.poll(); assert.equal(warnings.length, 2);
  assert.equal(warnings[1].retryMs, 60000);
  // A stop request can ask for a fresh table without waiting out the backoff.
  failing = false; assert.equal(await monitor.poll(true), true);
  assert.equal(recovered, 1); assert.equal(tables, 1);
  now += 5000; await monitor.poll();
  assert.equal(recovered, 1); assert.equal(tables, 2);
});

test('intermittent scan timeouts never log warnings or unpaired recoveries', async () => {
  let now = 0, failing = true, tables = 0;
  const monitor = createProcessMonitor({
    now: () => now,
    readTable: async () => { if (failing) throw new Error('timeout'); return []; },
    onTable: () => { tables++; },
    onError: () => assert.fail('transient failure should remain silent'),
    onRecovery: () => assert.fail('silent failure should recover silently'),
  });
  for (let i = 0; i < 10; i++) {
    now = i * 300000;
    failing = true;
    assert.equal(await monitor.poll(), false);
    now += 10000;
    failing = false;
    assert.equal(await monitor.poll(), true);
  }
  assert.equal(tables, 10);
});

test('warning grace resets on success and cooldown survives separate outages', async () => {
  let now = 0, failing = true;
  const events = [];
  const monitor = createProcessMonitor({
    now: () => now,
    readTable: async () => { if (failing) throw new Error('timeout'); return []; },
    onTable: () => {},
    onError: () => events.push('warning'),
    onRecovery: () => events.push('recovery'),
  });
  await monitor.poll();
  now = 59999; await monitor.poll(true);
  assert.deepEqual(events, []);
  now = 60000; await monitor.poll(true);
  assert.deepEqual(events, ['warning']);
  failing = false; await monitor.poll(true);
  assert.deepEqual(events, ['warning', 'recovery']);

  // A second sustained outage inside the cooldown produces neither message.
  failing = true;
  now = 70000; await monitor.poll(true);
  now = 130000; await monitor.poll(true);
  failing = false; await monitor.poll(true);
  assert.deepEqual(events, ['warning', 'recovery']);

  // Even after the cooldown, a new outage must satisfy its own grace period.
  failing = true;
  now = 360000; await monitor.poll(true);
  now = 419999; await monitor.poll(true);
  assert.deepEqual(events, ['warning', 'recovery']);
  now = 420000; await monitor.poll(true);
  assert.deepEqual(events, ['warning', 'recovery', 'warning']);
  failing = false; await monitor.poll(true);
  await monitor.poll(true);
  assert.deepEqual(events, ['warning', 'recovery', 'warning', 'recovery']);
});

test('descendant discovery includes nested tools in arbitrary table order', () => {
  const table = [
    { pid: 30, ppid: 20, started: 'nested' },
    { pid: 40, ppid: 1, started: 'unrelated' },
    { pid: 20, ppid: 10, started: 'tool' },
    { pid: 10, ppid: 1, started: 'spar' },
  ];
  assert.deepEqual(descendants(10, table).map(p => p.pid).sort(), [20, 30]);
});
