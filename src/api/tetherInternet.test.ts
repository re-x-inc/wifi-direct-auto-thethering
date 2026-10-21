import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pairedFakes } from './fakePlatform';
import { Tether } from './tether';

// 失敗してもタイマーと親機・子機を止める(残るとプロセスが終わらない)。cleanup は何度呼んでもよい
const live: Array<() => void> = [];
afterEach(() => live.splice(0).forEach((f) => f()));
const stopAll = (f: () => void) => { let done = false; const g = () => { if (!done) { done = true; f(); } }; live.push(g); return g; };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000, what = '') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout ' + what);
    await wait(5);
  }
};

/** 時間を縮めた設定(hb 20ms → T_echo 60 / T_direct 200 / T_nearby 260)。外形監視は両端で有効 */
const base = {
  link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 400 }, connectTimeoutMs: 100, probeIntervalMs: 1,
  strictLinkGuard: true, timingUnchecked: true,
  timing: { hbIntervalMs: 20, tickMs: 10, echoMs: 60, directMs: 200, nearbyMs: 260, settleMs: 30, retryAttempts: 3, retryBackoffMs: [5], retryJoinTimeoutMs: 50, retryAttemptMs: 50, rejoinMs: 500 },
};
const INTERNET = { enabled: true, intervalMs: 100, screenOffIntervalMs: 100, confirmIntervalMs: 10, timeoutMs: 50, failThreshold: 3, recoverThreshold: 2 };

async function setup(o: { internet?: object | null } = {}) {
  const cfg = { ...base, ...(o.internet === null ? {} : { internet: o.internet ?? INTERNET }) };
  const f = await pairedFakes({ externalProbe: true }, { bus: true });
  const hostT = new Tether(f.host.platform, cfg);
  const guestT = new Tether(f.guest.platform, cfg);
  let pulse = true;
  const pulseTimer = setInterval(() => { if (pulse && f.bus?.isUp()) f.bus.pulse(); }, 10);
  return {
    ...f, hostT, guestT, stop: () => { pulse = false; },
    cleanup: stopAll(() => { clearInterval(pulseTimer); hostT.stop(); guestT.stop(); }),
  };
}
type C = Awaited<ReturnType<typeof setup>>;

async function established(c: C) {
  await c.hostT.start();
  await c.guestT.start();
  await until(() => c.guestT.getState().vpn === 'on', 3000, 'vpn');
  await until(() => c.hostT.getState().nearby === 'suspended' && c.guestT.getState().nearby === 'suspended', 3000, 'both suspended');
}

test('既定は無効: 供給元は動かず、internet は unknown のまま', async () => {
  const c = await setup({ internet: null });
  await established(c);
  await wait(60);
  assert.ok(!c.guest.calls.some((x) => x.startsWith('xpStart')));
  assert.equal(c.guestT.getState().internet.state, 'unknown');
  c.cleanup();
});

test('接続確立直後に最初の probe がすぐ走り、state.internet / data.netAt / linkSnapshot に出る', async () => {
  const c = await setup();
  await c.hostT.start();
  await c.guestT.start();
  // VPN 起動を待たずに(= 確認の待ちと並行して)最初の結果が出る
  await until(() => c.guestT.getState().internet.state === 'ok', 3000, 'internet ok');
  const call = c.guest.calls.find((x) => x.startsWith('xpStart'))!;
  assert.match(call, /^xpStart:192\.168\.49\.1:\d+:100:10:50:3:2$/); // 親機の GO の IP・中継ポート・間隔・確認間隔・待ち・閾値・宛先 2 件
  const s = c.guestT.getState();
  assert.ok(s.data.netAt && s.data.aliveAt && s.data.aliveAt >= s.data.netAt);
  assert.equal(s.internet.lastOkAt, s.data.netAt);
  const snap = c.guestT.linkSnapshot();
  assert.equal(snap.internet?.state, 'ok'); assert.equal(snap.data?.netAt, s.data.netAt);
  assert.equal(c.hostT.getState().internet.state, 'unknown'); // 親機は監視しない
  c.cleanup();
});

test('失敗 3 回で ng → overall degraded(両端)。報告はバスだけで運ばれ、Nearby には出ない。成功 2 回で復帰', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.guestT.getState().internet.state === 'ok');
  await until(() => c.hostT.getState().remoteInternet?.state === 'ok', 2000, 'host sees ok');
  assert.equal(c.hostT.getState().overall, 'connected');
  for (let i = 0; i < 3; i++) c.guest.xpCtl.round(false, 'upstream');
  assert.equal(c.guestT.getState().internet.state, 'ng');
  assert.equal(c.guestT.getState().internet.reason, 'upstream');
  assert.equal(c.guestT.getState().overall, 'degraded');
  await until(() => c.hostT.getState().remoteInternet?.state === 'ng', 2000, 'host sees ng');
  assert.equal(c.hostT.getState().remoteInternet?.reason, 'upstream');
  assert.equal(c.hostT.getState().overall, 'degraded');
  assert.ok(c.bus!.ctl.sent.guest.some((p) => p.includes('tether.internet')));
  assert.deepEqual([...c.net.host.leaked, ...c.net.guest.leaked], []);
  assert.equal(c.guestT.getState().nearby, 'suspended'); // governor は動かない
  c.guest.xpCtl.round(true);
  assert.equal(c.guestT.getState().internet.state, 'ng');
  await wait(2); c.guest.xpCtl.round(true);
  assert.equal(c.guestT.getState().internet.state, 'ok');
  assert.equal(c.guestT.getState().overall, 'connected');
  await until(() => c.hostT.getState().remoteInternet?.state === 'ok' && c.hostT.getState().overall === 'connected', 2000, 'host recovers');
  c.cleanup();
});

test('親機は ok の報告で延命する(netAt が進む)。ng では進まない', async () => {
  const c = await setup();
  await established(c);
  await until(() => !!c.hostT.getState().data.netAt, 2000, 'host netAt');
  const n0 = c.hostT.getState().data.netAt!;
  await wait(5);
  c.guest.xpCtl.round(true);
  await until(() => (c.hostT.getState().data.netAt ?? 0) > n0, 2000, 'host netAt advances on ok');
  for (let i = 0; i < 3; i++) c.guest.xpCtl.round(false, 'timeout');
  await until(() => c.hostT.getState().remoteInternet?.state === 'ng', 4000);
  const n1 = c.hostT.getState().data.netAt!;
  await wait(40);
  assert.equal(c.hostT.getState().data.netAt, n1); // ng の間は延命しない(ng の報告で netAt が動かない)
  c.cleanup();
});

test('バスが切れたら親機の子機のインターネットは確認中(unknown)に戻る', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.hostT.getState().remoteInternet?.state === 'ok', 4000);
  c.bus!.link(false);
  await until(() => c.hostT.getState().remoteInternet?.state === 'unknown', 3000, 'unknown on bus down');
  c.cleanup();
});

test('公開の口 update(): 供給元を使わない(runner none)とき、アプリの実通信の観測から ok / ng を渡せる', async () => {
  const c = await setup({ internet: { ...INTERNET, enabled: false } });
  c.guestT.internet.enable(true, { ...INTERNET, runner: 'none' });
  await established(c);
  await wait(40);
  assert.ok(!c.guest.calls.some((x) => x.startsWith('xpStart'))); // 供給元は動かない
  assert.equal(c.guestT.getState().internet.state, 'unknown');
  assert.equal(c.guestT.internet.update(true), true);
  assert.equal(c.guestT.getState().internet.state, 'ok');
  for (let i = 0; i < 3; i++) c.guestT.internet.update(false, undefined, 'dns');
  assert.equal(c.guestT.getState().internet.state, 'ng'); assert.equal(c.guestT.getState().internet.reason, 'dns');
  c.guestT.internet.enable(false);
  assert.equal(c.guestT.getState().internet.state, 'unknown');
  assert.equal(c.guestT.internet.update(true), false);
  c.cleanup();
});

test('親機の設定(間隔・閾値・宛先)が子機に配られ、供給元に渡る', async () => {
  const c = await setup({ internet: null });
  c.hostT.internet.enable(true, { intervalMs: 150, failThreshold: 4, urls: ['http://a.example/g204'] });
  c.guestT.internet.enable(true);
  await established(c);
  await until(() => c.guest.calls.some((x) => /^xpStart:.*:150:.*:4:1$/.test(x)), 2000, 'host config reached the runner');
  assert.equal(c.guestT.internet.getConfig().failThreshold, 4);
  c.cleanup();
});

test('延命の上限: バスが途絶えたあと、外形監視の成功だけの延命は T_direct までで打ち切る', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.guestT.getState().internet.state === 'ok');
  // Echo もバスも途絶(報告の ack が生存信号を更新してしまわないよう、バスは切る)。外形監視の成功だけが続く
  c.stop(); c.bus!.link(false);
  await wait(30);
  const base = (c.guestT as any).lastBusAt as number; // バスで最後に生存を確かめた時刻(延命の上限の基準)
  assert.ok(base > 0, 'バスの生存時刻があること');
  let maxNet = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 450) {
    c.guestT.internet.update(true);
    maxNet = Math.max(maxNet, (c.guestT as any).data.netAt ?? 0);
    await wait(8);
  }
  assert.ok(maxNet > base, '途絶のあとも、上限までは延命した');
  assert.ok(maxNet - base < 200 + 20, `netAt は T_direct を超えて延命しない (${maxNet - base}ms)`);
  c.cleanup();
});
