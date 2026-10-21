import test from 'node:test';
import assert from 'node:assert/strict';
import { BusControl } from './busControl';
import { RoutedControl } from './controlRouter';
import { fakeBusPair } from './fakeBus';
import { initialDataPath, lastAliveAt, deriveOverall } from './dataPath';
import { NearbyControl } from './transport';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pair() {
  const f = fakeBusPair();
  const a = new BusControl(f.host, { now: () => Date.now() });
  const b = new BusControl(f.guest, { now: () => Date.now() });
  a.attach(); b.attach();
  const got: unknown[] = [];
  b.subscribe((x) => got.push(x));
  return { f, a, b, got };
}
const start = async (p: ReturnType<typeof pair>) => {
  const o = { host: false, selfId: 'g', peerId: 'h', keyHex: '00', addr: '1.2.3.4', port: 9001, pingMs: 10, timeoutMs: 30 };
  p.f.host.start({ ...o, host: true, addr: null }); p.f.guest.start(o);
  await wait(10);
};

test('BusControl: 順序・ack・ttl・key・takePending', async () => {
  const p = pair();
  p.a.send(1); p.a.send(2, { key: 'k' }); p.a.send(3, { key: 'k' }); p.a.send(4, { ttlMs: 5 }); p.a.send(5, { ttlMs: 0 });
  assert.equal(p.a.pending, 3); // 1, 3(key で 2 を置換), 4(5 は溜めない)
  await wait(10);
  assert.deepEqual(p.a.takePending().map((x) => x.body), [1, 3]); // 4 は ttl 切れ
  assert.equal(p.a.pending, 0);
  p.a.send('x'); p.a.send('y');
  await start(p);
  await wait(20);
  assert.deepEqual(p.got, ['x', 'y']);
  assert.equal(p.a.pending, 0);
});

test('RoutedControl: tether.wifi は常に Nearby、アプリは常にバス。縮退で移るのは内部制御だけ', () => {
  const f = fakeBusPair();
  const bus = new BusControl(f.host, { now: () => Date.now() });
  const sent: unknown[] = [];
  const nearby = new NearbyControl();
  nearby.attach({ send: (b: unknown) => sent.push(b), pending: 0 } as never);
  let mode: 'nearby' | 'bus' = 'bus';
  const moved: number[] = [];
  const reports: { channel: string; kind: string; to: string | null; outcome: string }[] = [];
  const r = new RoutedControl(nearby, bus, () => mode, (_to, n) => moved.push(n), (x) => reports.push(x));
  assert.equal(r.route({ kind: 'tether.wifi' }), 'nearby');
  assert.equal(r.route({ kind: 'tether.app' }), 'bus');
  r.send({ kind: 'tether.app', body: { type: 'a' } }); r.send({ kind: 'tether.app', body: { type: 'b' } }, { key: 'k' });
  r.send({ kind: 'tether.timing', body: 1 }, { key: 't' }); // 内部制御(バスに溜まる)
  r.send({ kind: 'tether.wifi', body: 'creds' });
  assert.equal(sent.length, 1);
  mode = 'nearby';
  r.reconcile();
  // 内部制御だけが Nearby へ移る。アプリは移らない
  assert.deepEqual(sent.slice(1).map((x) => (x as { kind: string }).kind), ['tether.timing']);
  assert.deepEqual(moved, [1]);
  assert.equal(r.appPending, 2);
  // 運び先が Nearby の間も、アプリはバスの保留に溜まるだけ
  r.send({ kind: 'tether.app', body: { type: 'c' } });
  assert.equal(sent.length, 2);
  assert.equal(r.appPending, 3);
  assert.deepEqual(reports.filter((x) => x.channel === 'app').map((x) => [x.kind, x.to, x.outcome]), [['a', 'bus', 'queued'], ['b', 'bus', 'queued'], ['c', 'bus', 'queued']]);
  assert.deepEqual(reports.filter((x) => x.channel === 'ctl').map((x) => [x.kind, x.to]), [['tether.timing', 'bus'], ['tether.wifi', 'nearby']]);
});

test('RoutedControl: バス部品なし(null)のアプリ送信は Nearby に出さず破棄', () => {
  const sent: unknown[] = [];
  const nearby = new NearbyControl();
  nearby.attach({ send: (b: unknown) => sent.push(b), pending: 0 } as never);
  const reports: string[] = [];
  const r = new RoutedControl(nearby, null, () => 'nearby', undefined, (x) => reports.push(`${x.outcome}:${x.reason}`));
  r.send({ kind: 'tether.app', body: 1 });
  assert.equal(sent.length, 0);
  assert.deepEqual(reports, ['dropped:no-bus']);
});

test('BusControl: アプリ ttl 切れは sweep で捨てて通知 / ttl=0 は未接続なら破棄 / 受信は subscribe', async () => {
  const p = pair();
  const ev: string[] = [];
  const a = new BusControl(p.f.host, { now: () => Date.now(), onEvent: (e) => ev.push(`${e.ev}:${e.kind}:${(e as { reason?: string }).reason ?? ''}`) });
  assert.deepEqual(a.send({ kind: 'tether.app', body: { type: 'z' } }, { ttlMs: 5 }), { outcome: 'queued' });
  assert.deepEqual(a.send({ kind: 'tether.app', body: { type: 'y' } }, { ttlMs: 0 }), { outcome: 'dropped', reason: 'ttl0' });
  await wait(15);
  a.sweep();
  assert.deepEqual(ev, ['drop:z:ttl']);
});

test('lastAliveAt: Echo とバスのどちらか新しい方。deriveOverall に効く', () => {
  const d = { ...initialDataPath(), group: true, echoAt: 1000, busAt: 1500, reach: { ok: true, at: 0 } };
  assert.equal(lastAliveAt(d, 'host'), 1500);
  assert.equal(lastAliveAt({ ...d, echoAt: 2000 }, 'host'), 2000);
  assert.equal(lastAliveAt({ ...initialDataPath(), okAt: 700 }, 'guest'), 700);
  const base = { role: 'host' as const, started: true, data: d, shareOn: true, wifiJoined: false, vpnOn: false, heartbeatMode: true, retrying: false, echoMs: 100, directMs: 400 };
  assert.equal(deriveOverall({ ...base, now: 1550 }), 'connected'); // バスが新しい(Echo は 550ms 前)
  assert.equal(deriveOverall({ ...base, now: 1700 }), 'degraded');
  assert.equal(deriveOverall({ ...base, now: 2000 }), 'disconnected');
  assert.equal(deriveOverall({ ...base, data: { ...d, busAt: null }, now: 1050 }), 'connected');
});
