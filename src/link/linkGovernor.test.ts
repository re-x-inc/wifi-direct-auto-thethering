import test from 'node:test';
import assert from 'node:assert/strict';
import { guardTimingFor } from './directGuard';
import { LinkGovernor, LinkViolation } from './linkGovernor';
import { fakeNearbyPair } from './fakeNearby';
import { fakePlatform } from '../api/fakePlatform';

const TM = guardTimingFor('host', 50, { echoMs: 150, directMs: 300, nearbyMs: 450, settleMs: 100 });

function make(strict: boolean) {
  let now = 0;
  const logs: string[] = [];
  const actions: string[] = [];
  const g = new LinkGovernor({ timing: TM, now: () => now, strict, log: (l) => logs.push(l), onAction: (a) => actions.push(a.type) });
  const net = fakeNearbyPair();
  return { g, net, logs, actions, at: (t: number) => { now = t; }, api: g.wrapNearby(net.host) };
}

test('I1: Direct 稼働中は advertise / discover / requestConnect を拒否してログ(strict では例外)', () => {
  const c = make(false);
  c.at(0); c.g.dispatch({ t: 'ready' });
  c.at(100); c.g.dispatch({ t: 'tick' }); // direct
  assert.equal(c.g.nearbyAllowed, false);
  c.api.advertise('x'); c.api.discover(); c.api.requestConnect('e', 'n');
  assert.equal(c.net.host.advertising, false);
  assert.equal(c.net.host.discovering, false);
  assert.equal(c.g.violations.length, 3);
  assert.ok(c.logs.some((l) => l.includes('violation I1')));
  const s = make(true);
  s.at(0); s.g.dispatch({ t: 'ready' }); s.at(100); s.g.dispatch({ t: 'tick' });
  assert.throws(() => s.api.advertise('x'), LinkViolation);
});

test('I1: Nearby が許される phase(nearby / settling)では通す。止める・切るは常に通す', () => {
  const c = make(true);
  c.api.advertise('x');
  assert.equal(c.net.host.advertising, true);
  c.g.dispatch({ t: 'ready' }); // settling
  c.api.discover();
  assert.equal(c.net.host.discovering, true);
  c.at(100); c.g.dispatch({ t: 'tick' });
  c.api.stop(); c.api.disconnect('x'); // direct 中でも例外なし
});

test('I2/表: Nearby 再開は T_direct(親機)の経過後だけ。それまでの tick では再開しない', () => {
  const c = make(true);
  c.at(0); c.g.dispatch({ t: 'ready' }); c.at(100); c.g.dispatch({ t: 'tick' });
  c.at(250); c.g.dispatch({ t: 'tick' }); // T_echo で retry
  assert.deepEqual(c.actions, ['suspend', 'retry']);
  c.at(399); c.g.dispatch({ t: 'tick' });
  assert.deepEqual(c.actions, ['suspend', 'retry']);
  assert.equal(c.g.nearbyAllowed, false);
  c.at(400); c.g.dispatch({ t: 'tick' });
  assert.deepEqual(c.actions, ['suspend', 'retry', 'resume']);
  assert.equal(c.g.nearbyAllowed, true);
});

test('I3: rebuild 中は Nearby を閉じ終える前の startDirect を拒否する(順序: 再送 → 閉じる → 作る)', async () => {
  const c = make(true);
  const f = fakePlatform(c.net.host, { cellular: true });
  const h = c.g.wrapHotspot(f.platform.hotspot);
  await h.startDirect(null, null, null); // rebuild でなければ通る
  c.g.dispatch({ t: 'rebuild-start' });
  await assert.rejects(() => Promise.resolve().then(() => h.startDirect(null, null, null)), LinkViolation);
  c.g.markNearbyStopped(true);
  await h.startDirect(null, null, null);
  assert.deepEqual(f.calls.filter((x) => x === 'startDirect').length, 2);
});

test('I4: 表に無い (状態, 事象) は状態を変えない', () => {
  const c = make(true);
  c.g.dispatch({ t: 'alive' });
  c.g.dispatch({ t: 'lost', reason: 'wifi-lost' });
  c.g.dispatch({ t: 'retry-failed' });
  assert.equal(c.g.phase, 'nearby');
  assert.deepEqual(c.actions, []);
});

test('I5: 時間は注入(now)だけで動く。タイマーを持たない', () => {
  const c = make(true);
  c.at(1_000_000); c.g.dispatch({ t: 'ready' });
  c.at(1_000_100); c.g.dispatch({ t: 'tick' });
  assert.equal(c.g.phase, 'direct');
});

test('reset で Nearby は誰でも使える状態に戻る', () => {
  const c = make(true);
  c.g.dispatch({ t: 'ready' }); c.at(100); c.g.dispatch({ t: 'tick' });
  c.g.reset();
  assert.equal(c.g.nearbyAllowed, true);
});
