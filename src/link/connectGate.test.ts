import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectGate, SETTLE_MS, failureAction } from './connectGate';
import { NearbyApi, NearbyTransport } from './nearbyTransport';

test('同じ endpoint の requestConnection は 1 つだけ進行中、解放後はまた出せる', () => {
  const g = new ConnectGate();
  assert.equal(g.tryAcquire('A'), true);
  assert.equal(g.tryAcquire('A'), false);
  assert.equal(g.tryAcquire('B'), true); // 別の endpoint は独立
  g.release('A');
  assert.equal(g.tryAcquire('A'), true);
});

test('失敗の後始末が済むまで(SETTLE_MS)次を出さない。時間が過ぎれば出せる', () => {
  let t = 1000;
  const g = new ConnectGate(() => t);
  assert.equal(g.waitMs(), 0);
  g.settle(SETTLE_MS);
  assert.equal(g.waitMs(), SETTLE_MS);
  t += 1000;
  assert.equal(g.waitMs(), SETTLE_MS - 1000);
  t += 600;
  assert.equal(g.waitMs(), 0);
});

test('失敗コードごとの扱い: 8012・8009 は片付けて待ってから rediscover', () => {
  assert.deepEqual(failureAction(8012, 0), { kind: 'rediscover', settleMs: SETTLE_MS, disconnectFirst: true });
  assert.deepEqual(failureAction(8009, 0), { kind: 'rediscover', settleMs: SETTLE_MS, disconnectFirst: true });
  // 再試行の途中でも 8012 は同じ(再試行を重ねない)
  assert.equal(failureAction(8012, 2).kind, 'rediscover');
});

test('失敗コードごとの扱い: 8007/8003 は再試行、尽きたら 8007 は rediscover、8011 は即 rediscover', () => {
  assert.deepEqual(failureAction(8007, 0), { kind: 'retry', delayMs: 1500, disconnectFirst: false });
  assert.deepEqual(failureAction(8003, 1), { kind: 'retry', delayMs: 700, disconnectFirst: true });
  assert.deepEqual(failureAction(8007, 2), { kind: 'rediscover', settleMs: 0, disconnectFirst: false });
  assert.equal(failureAction(8003, 2).kind, 'giveup');
  assert.deepEqual(failureAction(8011, 0), { kind: 'rediscover', settleMs: 0, disconnectFirst: false });
  assert.equal(failureAction(8000, 0).kind, 'giveup');
});

test('NearbyTransport: onFound が重複しても requestConnect は 1 回だけ。失敗/切断後は出せる', async () => {
  const h = new Map<string, Set<(e: any) => void>>();
  const emit = (ev: string, e: any) => h.get(ev)?.forEach((cb) => cb(e));
  const calls: string[] = [];
  const api: NearbyApi = {
    advertise() {}, discover() {}, accept() {}, reject() {}, send() {}, disconnect() {}, stop() {},
    requestConnect(id) { calls.push(id); },
    hmac: (s, d) => `${s}|${d}`,
    on(ev, cb) { if (!h.has(ev)) h.set(ev, new Set()); h.get(ev)!.add(cb); return () => h.get(ev)!.delete(cb); },
  };
  const t = new NearbyTransport(api, { role: 'guest', selfId: 'G', pair: { peerId: 'H', secret: 's' }, connectTimeoutMs: 1000 });
  const p = t.connect().catch(() => {});
  emit('onFound', { endpointId: 'E1', name: 'H' });
  emit('onFound', { endpointId: 'E1', name: 'H' }); // 重複
  emit('onFound', { endpointId: 'E1', name: 'H' });
  assert.deepEqual(calls, ['E1']);
  emit('onFound', { endpointId: 'E2', name: 'H' }); // 別 endpoint(探索やり直しで id が変わった)は出せる
  assert.deepEqual(calls, ['E1', 'E2']);
  emit('onFailed', { endpointId: 'E1', code: 8012 }); // 失敗で枠が戻る(この例では transport は失敗として閉じる)
  t.close();
  await p;
});
