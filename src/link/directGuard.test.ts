import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardEvent, GuardState, GuardTiming, guardTimingFor, initialGuard, stepGuard } from './directGuard';

/** 時間は 1/100 に縮める(hb=50 → T_echo=150 / T_direct=300 / T_nearby=450) */
const SCALED = { echoMs: 150, directMs: 300, nearbyMs: 450, settleMs: 100 };
const HOST: GuardTiming = guardTimingFor('host', 50, SCALED);
const GUEST: GuardTiming = guardTimingFor('guest', 50, SCALED);

/** 時刻つきのイベント列を流して、最後の状態と、これまでに出た動作(note を除く)を返す */
function run(evs: [number, GuardEvent][], tm: GuardTiming = HOST, s0: GuardState = initialGuard(0)) {
  let s = s0;
  const acts: string[] = [];
  for (const [at, ev] of evs) {
    const [n, a] = stepGuard(s, ev, at, tm);
    s = n;
    for (const x of a) if (x.type !== 'note') acts.push(x.type === 'resume' || x.type === 'retry' ? `${x.type}:${x.reason}` : x.type);
  }
  return { s, acts };
}
const up: [number, GuardEvent][] = [[0, { t: 'ready' }], [100, { t: 'tick' }]]; // direct, Nearby 停止済み(aliveAt=100)

test('閾値の大小は T_echo < T_direct < T_nearby', () => {
  for (const t of [HOST, GUEST]) assert.ok(t.echoMs < t.directMs && t.directMs < t.nearbyMs);
  assert.deepEqual([HOST.echoMs, HOST.directMs, HOST.nearbyMs], [150, 300, 450]);
});

test('Direct 確立 → 安定したら Nearby を止める(settleMs 未満では止めない)', () => {
  let r = run([[0, { t: 'ready' }], [50, { t: 'tick' }]]);
  assert.equal(r.s.phase, 'settling');
  assert.deepEqual(r.acts, []);
  r = run(up);
  assert.equal(r.s.phase, 'direct');
  assert.deepEqual(r.acts, ['suspend']);
});

test('settling 中に切れたら Nearby は止めない(誤作動なし)', () => {
  const r = run([[0, { t: 'ready' }], [10, { t: 'lost', reason: 'wifi-lost' }], [200, { t: 'tick' }]]);
  assert.equal(r.s.phase, 'nearby');
  assert.deepEqual(r.acts, []);
});

test('生存信号が続く限り、何も起きない(Nearby を再開しない)', () => {
  const evs: [number, GuardEvent][] = [...up];
  for (let t = 150; t <= 1000; t += 50) evs.push([t, { t: 'alive' }], [t, { t: 'tick' }]);
  const r = run(evs);
  assert.equal(r.s.phase, 'direct');
  assert.deepEqual(r.acts, ['suspend']);
});

test('① 無通信が T_echo に達したら Direct の再接続を始める。Nearby はまだ再開しない', () => {
  let r = run([...up, [249, { t: 'tick' }]]);
  assert.equal(r.s.phase, 'direct'); // 100 + 150 = 250 未満
  r = run([...up, [250, { t: 'tick' }]]);
  assert.equal(r.s.phase, 'retrying');
  assert.deepEqual(r.acts, ['suspend', 'retry:silence']);
});

test('② T_direct までに戻れば Nearby は使わない', () => {
  const r = run([...up, [250, { t: 'tick' }], [380, { t: 'alive' }], [400, { t: 'tick' }]]);
  assert.equal(r.s.phase, 'direct');
  assert.deepEqual(r.acts, ['suspend', 'retry:silence']);
});

test('③ 親機: 基準(最後の生存 100)から T_direct(300) 戻らなければ Nearby を再開する', () => {
  const r = run([...up, [250, { t: 'tick' }], [399, { t: 'tick' }], [400, { t: 'tick' }]]);
  assert.deepEqual(r.acts, ['suspend', 'retry:silence', 'resume:direct-timeout']);
  assert.equal(r.s.phase, 'nearby');
});

test('③ 子機: 同じ基準から T_nearby(450) まで探索へ戻らない。親機の戻りより後', () => {
  const r = run([...up, [250, { t: 'tick' }], [400, { t: 'tick' }], [549, { t: 'tick' }]], GUEST);
  assert.equal(r.s.phase, 'retrying'); // 親機は 400 で再開済み。子機はまだ
  const r2 = run([...up, [250, { t: 'tick' }], [550, { t: 'tick' }]], GUEST);
  assert.deepEqual(r2.acts, ['suspend', 'retry:silence', 'resume:direct-timeout']);
  assert.ok(HOST.resumeAtMs < GUEST.resumeAtMs);
});

test('確定した切断(Wi-Fi 切断)はその時刻が基準。すぐ再接続を始め、T_direct/T_nearby は検知時刻から数える', () => {
  const evs: [number, GuardEvent][] = [...up, [200, { t: 'lost', reason: 'wifi-lost' }]];
  let r = run([...evs, [499, { t: 'tick' }]], HOST);
  assert.deepEqual(r.acts, ['suspend', 'retry:wifi-lost']);
  r = run([...evs, [500, { t: 'tick' }]], HOST);
  assert.deepEqual(r.acts.slice(-1), ['resume:direct-timeout']);
  r = run([...evs, [500, { t: 'tick' }]], GUEST);
  assert.equal(r.s.phase, 'retrying');
  r = run([...evs, [650, { t: 'tick' }]], GUEST);
  assert.deepEqual(r.acts.slice(-1), ['resume:direct-timeout']);
});

test('再接続中の切断信号の重複は無視(再接続を二重に始めない)', () => {
  const r = run([...up, [200, { t: 'lost', reason: 'wifi-lost' }], [210, { t: 'lost', reason: 'group-gone' }]]);
  assert.deepEqual(r.acts, ['suspend', 'retry:wifi-lost']);
});

test('親機: 再接続の 3 回を使い切ったら T_direct を待たず Nearby を再開(順序: retry → resume)', () => {
  const r = run([...up, [200, { t: 'lost', reason: 'group-gone' }], [260, { t: 'retry-failed' }]], HOST);
  assert.deepEqual(r.acts, ['suspend', 'retry:group-gone', 'resume:retry-exhausted']);
});

test('子機: 3 回使い切っても親機より先に探索へ戻らない(T_nearby まで待つ)', () => {
  const r = run([...up, [200, { t: 'lost', reason: 'wifi-lost' }], [260, { t: 'retry-failed' }]], GUEST);
  assert.equal(r.s.phase, 'retrying');
  assert.deepEqual(r.acts, ['suspend', 'retry:wifi-lost']);
});

test('nearby 中の alive / lost は何もしない', () => {
  const r = run([[0, { t: 'alive' }], [2, { t: 'lost', reason: 'wifi-lost' }], [3, { t: 'tick' }]]);
  assert.equal(r.s.phase, 'nearby');
  assert.deepEqual(r.acts, []);
});

test('再接続の順序: rebuild-start(接続情報を送って Nearby を閉じた)→ 戻れば direct / 戻らなければ rejoinMs 後に再開', () => {
  let r = run([[0, { t: 'rebuild-start' }], [100, { t: 'alive' }]]);
  assert.equal(r.s.phase, 'direct');
  r = run([[0, { t: 'rebuild-start' }], [59_999, { t: 'tick' }], [60_000, { t: 'tick' }]]);
  assert.deepEqual(r.acts, ['resume:rejoin-timeout']);
});

test('reset で nearby に戻る', () => {
  assert.equal(run([...up, [150, { t: 'reset' }]]).s.phase, 'nearby');
});

test('既定値(hb=5s): T_echo=15s < T_direct=150s(=15+3×45) < T_nearby=165s。Nearby は 135s 以上経ってから。親機の戻り ≤ 子機の探索開始', () => {
  const h = guardTimingFor('host', 5_000);
  const g = guardTimingFor('guest', 5_000);
  assert.deepEqual([h.echoMs, h.directMs, h.nearbyMs], [15_000, 150_000, 165_000]);
  assert.ok(h.resumeAtMs >= 135_000);
  assert.equal(h.resumeAtMs, 150_000);
  assert.equal(g.resumeAtMs, 165_000);
  assert.ok(h.resumeAtMs <= g.resumeAtMs);
  assert.equal(h.resumeOnExhaust, true);
  assert.equal(g.resumeOnExhaust, false);
  // 3 回の再接続(最悪 127s)は T_echo から始めて T_direct の手前で終わる
  assert.ok(h.echoMs + (1_000 + 40_000) + (2_000 + 40_000) + (4_000 + 40_000) <= h.directMs);
});

test('上書き: T_direct を変えると親機の再開時刻も追従する', () => {
  assert.equal(guardTimingFor('host', 5_000, { directMs: 20_000 }).resumeAtMs, 20_000);
  assert.equal(guardTimingFor('guest', 5_000, { nearbyMs: 60_000 }).resumeAtMs, 60_000);
});
