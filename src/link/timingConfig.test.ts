import test from 'node:test';
import assert from 'node:assert/strict';
import { pickShared, resolveTiming, TIMING_DEFAULTS, toGuardTiming } from './timingConfig';

test('既定: T_echo 15s < T_direct 150s < T_nearby 165s、再接続 3 回、Nearby 再試行 1s〜30s', () => {
  const t = resolveTiming();
  assert.deepEqual([t.hbIntervalMs, t.echoMs, t.directMs, t.nearbyMs], [5_000, 15_000, 150_000, 165_000]);
  assert.equal(t.retryAttempts, 3);
  assert.deepEqual([t.nearbyRetryBaseMs, t.nearbyRetryMaxMs, t.joinTimeoutMs], [1_000, 30_000, 180_000]);
  assert.deepEqual([t.vpnDetachMs, t.vpnReattachMs], [5_000, 3_000]);
  assert.deepEqual(t, { ...TIMING_DEFAULTS });
});

test('hb を変えると T_echo 以降の既定も追従する', () => {
  const t = resolveTiming({ hbIntervalMs: 10_000 });
  assert.deepEqual([t.echoMs, t.directMs, t.nearbyMs], [30_000, 165_000, 195_000]);
});

test('範囲外・不正値は既定に丸めてログ', () => {
  const logs: string[] = [];
  const t = resolveTiming({ hbIntervalMs: 5, retryAttempts: 99, settleMs: NaN as any, retryBackoffMs: [] }, { log: (l) => logs.push(l) });
  assert.equal(t.hbIntervalMs, 5_000);
  assert.equal(t.retryAttempts, 3);
  assert.equal(t.settleMs, 3_000);
  assert.deepEqual(t.retryBackoffMs, [1_000, 2_000, 4_000]);
  assert.equal(logs.length, 4);
});

test('大小関係が破れたら補正してログ(T_echo < T_direct < T_nearby)', () => {
  const logs: string[] = [];
  let t = resolveTiming({ echoMs: 60_000, directMs: 30_000 }, { log: (l) => logs.push(l) });
  assert.equal(t.directMs, 120_000);
  assert.ok(t.nearbyMs > t.directMs);
  t = resolveTiming({ directMs: 100_000, nearbyMs: 50_000 }, { log: (l) => logs.push(l) });
  assert.equal(t.nearbyMs, 115_000);
  assert.ok(logs.some((l) => l.includes('補正')));
});

test('再接続が T_direct − T_echo に収まらないときは注意をログに出す(補正はしない)', () => {
  const logs: string[] = [];
  const t = resolveTiming({ directMs: 30_000 }, { log: (l) => logs.push(l) });
  assert.equal(t.directMs, 30_000);
  assert.ok(logs.some((l) => l.includes('収まらない')));
});

test('unchecked: 範囲チェックを省く(短い時間)。大小関係の補正は行う', () => {
  const t = resolveTiming({ hbIntervalMs: 20, echoMs: 60, directMs: 200, nearbyMs: 260 }, { unchecked: true });
  assert.deepEqual([t.hbIntervalMs, t.echoMs, t.directMs, t.nearbyMs], [20, 60, 200, 260]);
});

test('親機の戻り(T_direct)≤ 子機の探索開始(T_nearby)が役割別の時間に反映される。共有分だけ配る', () => {
  const t = resolveTiming({ directMs: 100_000, nearbyMs: 130_000 });
  assert.equal(toGuardTiming(t, 'host').resumeAtMs, 100_000);
  assert.equal(toGuardTiming(t, 'guest').resumeAtMs, 130_000);
  const shared = pickShared(t);
  assert.ok(!('tickMs' in shared) && !('joinTimeoutMs' in shared) && !('nearbyRetryMaxMs' in shared));
  assert.equal(shared.nearbyMs, 130_000);
});

test('バスの ZMTP heartbeat: IVL / TIMEOUT は外から設定でき、既定は IVL=2s・TIMEOUT=6s(T_echo=15s より先に切れを知る)', () => {
  const d = resolveTiming({});
  assert.equal(d.busIvlMs, 2_000);
  assert.equal(d.busTimeoutMs, 6_000);
  assert.ok(d.busTimeoutMs + d.busIvlMs < d.echoMs);
  const c = resolveTiming({ busIvlMs: 1_000, busTimeoutMs: 4_000 });
  assert.equal(c.busIvlMs, 1_000); assert.equal(c.busTimeoutMs, 4_000);
  const logs: string[] = [];
  const bad = resolveTiming({ busIvlMs: 3_000, busTimeoutMs: 4_000 }, { log: (l) => logs.push(l) });
  assert.equal(bad.busTimeoutMs, 6_000, 'TIMEOUT < IVL×2 は IVL×2 に補正');
  assert.ok(logs.some((l) => l.includes('bus TIMEOUT')));
  const warn: string[] = [];
  resolveTiming({ echoMs: 5_000, busTimeoutMs: 6_000 }, { log: (l) => warn.push(l) });
  assert.ok(warn.some((l) => l.includes('T_echo')));
  const lo = resolveTiming({ busIvlMs: 10 }, { log: () => {} });
  assert.equal(lo.busIvlMs, 2_000, '範囲外は既定');
});
