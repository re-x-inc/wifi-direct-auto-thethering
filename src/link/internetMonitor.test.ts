import test from 'node:test';
import assert from 'node:assert/strict';
import { initialInternet, InternetMonitor, InternetReport, MonitorPorts, reduceInternet, resolveInternetConfig } from './internetMonitor';

const cfg = { failThreshold: 3, recoverThreshold: 2 };
const step = (c: ReturnType<typeof initialInternet>, success: boolean, at: number, reason: string | null = null) =>
  reduceInternet(c, { success, at, reason: reason as never }, cfg, at);

test('遷移表: unknown + 成功 → ok(初回は即)', () => {
  const c = step(initialInternet(0), true, 10);
  assert.equal(c.status.state, 'ok'); assert.equal(c.status.lastOkAt, 10); assert.equal(c.status.since, 10);
});
test('遷移表: unknown + 失敗は数えるだけ、failThreshold で ng', () => {
  let c = initialInternet(0);
  c = step(c, false, 1, 'upstream'); c = step(c, false, 2, 'upstream');
  assert.equal(c.status.state, 'unknown'); assert.equal(c.status.consecutiveFailures, 2);
  c = step(c, false, 3, 'timeout');
  assert.equal(c.status.state, 'ng'); assert.equal(c.status.reason, 'timeout'); assert.equal(c.status.since, 3);
});
test('遷移表: ok + 失敗は表示を変えず数える。3 回で ng。途中の成功で数え直し', () => {
  let c = step(initialInternet(0), true, 1);
  c = step(c, false, 2, 'upstream'); c = step(c, false, 3, 'upstream');
  assert.equal(c.status.state, 'ok');
  c = step(c, true, 4);
  assert.equal(c.status.consecutiveFailures, 0);
  c = step(c, false, 5, 'upstream'); c = step(c, false, 6, 'upstream'); c = step(c, false, 7, 'portal');
  assert.equal(c.status.state, 'ng'); assert.equal(c.status.reason, 'portal');
});
test('遷移表: ng + 成功 1 回は ng のまま(ヒステリシス)、2 回連続で ok、間の失敗で数え直し', () => {
  let c = initialInternet(0);
  for (let i = 1; i <= 3; i++) c = step(c, false, i, 'upstream');
  c = step(c, true, 10);
  assert.equal(c.status.state, 'ng'); assert.equal(c.status.lastOkAt, 10); assert.equal(c.status.reason, 'upstream');
  c = step(c, false, 11, 'upstream'); c = step(c, true, 12);
  assert.equal(c.status.state, 'ng');
  c = step(c, true, 13);
  assert.equal(c.status.state, 'ok'); assert.equal(c.status.reason, null); assert.equal(c.status.since, 13);
});
test('reason が link の失敗は数えず unknown に戻す', () => {
  let c = step(initialInternet(0), true, 1);
  c = step(c, false, 2, 'upstream');
  c = step(c, false, 3, 'link');
  assert.equal(c.status.state, 'unknown'); assert.equal(c.status.consecutiveFailures, 0); assert.equal(c.status.reason, 'link');
});

test('設定: 範囲外・不正は既定に丸めてログ。urls は平文 http の 1〜3 件だけ', () => {
  const logs: string[] = [];
  const r = resolveInternetConfig({ intervalMs: 5, failThreshold: 99, timeoutMs: 'x' as never, urls: ['https://a.example/x'] }, { log: (l) => logs.push(l) });
  assert.equal(r.intervalMs, 60_000); assert.equal(r.failThreshold, 3); assert.equal(r.timeoutMs, 5_000);
  assert.deepEqual(r.urls.length, 2); assert.ok(logs.length >= 4);
  assert.deepEqual(resolveInternetConfig({ urls: ['http://a.example/g', 'http://b.example:8080/g'] }).urls, ['http://a.example/g', 'http://b.example:8080/g']);
  assert.equal(resolveInternetConfig({ urls: ['http://a.example/\r\nX: y'] }).urls.length, 2);
  assert.equal(resolveInternetConfig({ urls: ['http://a/1', 'http://a/2', 'http://a/3', 'http://a/4'] }).urls.length, 2);
  assert.equal(resolveInternetConfig().enabled, false);
});
test('設定: confirmIntervalMs は intervalMs 以下、screenOffIntervalMs は intervalMs 以上に収める', () => {
  const r = resolveInternetConfig({ intervalMs: 20_000, confirmIntervalMs: 40_000, screenOffIntervalMs: 16_000 }, { log: () => {} });
  assert.ok(r.confirmIntervalMs <= 20_000); assert.ok(r.screenOffIntervalMs >= 20_000);
});

function mon(role: 'host' | 'guest', o: { bus?: boolean } = {}) {
  let t = 1_000_000;
  const alive: number[] = []; const sent: InternetReport[] = []; const logs: string[] = [];
  let changed = 0; let bus = o.bus ?? true;
  const ports: MonitorPorts = {
    now: () => t, log: (l) => logs.push(l), role: () => role, busUp: () => bus,
    noteAlive: (at) => (alive.push(at), true), sendReport: (r) => sent.push(r), changed: () => changed++,
  };
  const m = new InternetMonitor(ports);
  m.configure({}, { unchecked: true });
  return { m, alive, sent, logs, adv: (ms: number) => (t += ms), now: () => t, bus: (b: boolean) => (bus = b), changed: () => changed };
}

test('update: 無効/非活動の間は無視。enable(false) で unknown に戻る', () => {
  const x = mon('guest');
  assert.equal(x.m.update(true), false);
  x.m.enable(true); assert.equal(x.m.update(true), false); // まだ活動していない
  x.m.setActive(true);
  assert.equal(x.m.update(true), true); assert.equal(x.m.status.state, 'ok');
  x.m.enable(false); assert.equal(x.m.status.state, 'unknown'); assert.equal(x.m.update(true), false);
});
test('update: 成功のたびに生存信号(ng の間も)。at は未来を現在に丸め、古い結果は捨てる', () => {
  const x = mon('guest'); x.m.enable(true, { failThreshold: 1 }); x.m.setActive(true);
  x.m.update(true, x.now() + 99999);
  assert.deepEqual(x.alive, [x.now()]);
  x.adv(10); x.m.update(false, undefined, 'upstream'); assert.equal(x.m.status.state, 'ng');
  x.adv(10); x.m.update(true);
  assert.equal(x.m.status.state, 'ng'); assert.equal(x.alive.length, 2);
  assert.equal(x.m.update(true, x.now() - 500), false);
});
test('報告: 状態が変わったら即時、ok の成功ごと、それ以外は intervalMs ごと。バス断の間は送らない(溜めない)', () => {
  const x = mon('guest'); x.m.enable(true, { intervalMs: 60_000, failThreshold: 2 }); x.m.setActive(true);
  x.m.update(true); assert.equal(x.sent.length, 1); assert.equal(x.sent[0].state, 'ok');
  x.adv(1000); x.m.update(true); assert.equal(x.sent.length, 2); // okAt が進んだ
  x.adv(1000); x.m.tick(); assert.equal(x.sent.length, 2);
  x.adv(1000); x.m.update(false, undefined, 'timeout'); assert.equal(x.sent.length, 2); // ok のまま(表示は変えない)
  x.adv(1000); x.m.update(false, undefined, 'timeout'); assert.equal(x.sent.length, 3);
  assert.deepEqual([x.sent[2].state, x.sent[2].reason, x.sent[2].fails], ['ng', 'timeout', 2]);
  x.adv(59_000); x.m.tick(); assert.equal(x.sent.length, 3);
  x.adv(2_000); x.m.tick(); assert.equal(x.sent.length, 4); // 定期更新
  assert.ok(x.sent[3].seq > x.sent[0].seq);
  x.bus(false); x.adv(70_000); x.m.update(false, undefined, 'timeout'); assert.equal(x.sent.length, 4);
});
test('結果が途絶したら unknown に戻す(供給元が動けていない)', () => {
  const x = mon('guest'); x.m.enable(true, { intervalMs: 15_000, screenOffIntervalMs: 15_000, failThreshold: 3 }); x.m.setActive(true);
  x.m.update(true); x.adv(15_000 * 4 + 1); x.m.tick();
  assert.equal(x.m.status.state, 'unknown');
});
test('親機: ok の報告は受信時刻で延命、ng / unknown は延命しない。古い seq は捨てる。途絶・バス断で確認中に戻る', () => {
  const x = mon('host'); x.m.enable(true);
  const rep = (state: string, seq: number) => ({ kind: 'tether.internet', v: 1, state, okAt: 5, at: 5, seq, fails: 0, reason: null, since: 5 });
  assert.equal(x.m.receive(rep('ok', 10)), true);
  assert.deepEqual(x.alive, [x.now()]); assert.equal(x.m.remoteStatus?.state, 'ok');
  assert.equal(x.m.receive(rep('ok', 10)), false); assert.equal(x.m.receive(rep('ng', 9)), false);
  x.adv(100); assert.equal(x.m.receive({ ...rep('ng', 11), reason: 'portal', fails: 3 }), true);
  assert.equal(x.alive.length, 1); assert.equal(x.m.isNg('host'), true); assert.equal(x.m.remoteStatus?.reason, 'portal');
  x.m.receive(rep('unknown', 12)); assert.equal(x.alive.length, 1); assert.equal(x.m.isNg('host'), false);
  x.m.receive(rep('ok', 13)); assert.equal(x.alive.length, 2);
  x.adv(60_000 * 3 + 1); x.m.tick(); assert.equal(x.m.remoteStatus?.state, 'unknown');
  x.m.receive(rep('ok', 14)); x.m.onBusDown(); assert.equal(x.m.remoteStatus?.state, 'unknown');
});
test('親機: 無効なら受けない。不正な形は捨てる。子機は受けない', () => {
  const x = mon('host');
  assert.equal(x.m.receive({ kind: 'tether.internet', v: 1, state: 'ok', okAt: 1, at: 1, seq: 1, fails: 0, reason: null, since: 1 }), false);
  x.m.enable(true);
  assert.equal(x.m.receive({ kind: 'tether.internet', v: 2, state: 'ok' }), false);
  assert.equal(x.m.receive({ kind: 'tether.internet', v: 1, state: 'weird', okAt: 1, at: 1, seq: 1, fails: 0, reason: null, since: 1 }), false);
  assert.equal(mon('guest').m.receive({ kind: 'tether.internet', v: 1, state: 'ok', okAt: 1, at: 1, seq: 1, fails: 0, reason: null, since: 1 }), false);
});
test('親機の配布: 間隔・閾値・宛先は親機が正。enabled は親機が true のときだけ反映', () => {
  const x = mon('guest'); x.m.enable(true, { intervalMs: 30_000 });
  x.m.adoptHost({ enabled: false, intervalMs: 90_000, failThreshold: 5, urls: ['http://h.example/g'] });
  assert.equal(x.m.enabled, true); assert.equal(x.m.config.intervalMs, 90_000); assert.equal(x.m.config.failThreshold, 5); assert.deepEqual(x.m.config.urls, ['http://h.example/g']);
  const y = mon('guest'); y.m.adoptHost({ enabled: true });
  assert.equal(y.m.enabled, true);
});
