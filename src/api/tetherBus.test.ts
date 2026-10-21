import test from 'node:test';
import assert from 'node:assert/strict';
import { pairedFakes } from './fakePlatform';
import { Tether } from './tether';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000, what = '') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout ' + what);
    await wait(5);
  }
};

/** 時間を縮めた設定(hb 20ms → T_echo 60 / T_direct 200 / T_nearby 260) */
const SUSPEND = {
  link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 400 }, connectTimeoutMs: 100, probeIntervalMs: 1,
  nearbyWhileDirect: 'suspend' as const,
  strictLinkGuard: true,
  timingUnchecked: true,
  timing: { hbIntervalMs: 20, tickMs: 10, echoMs: 60, directMs: 200, nearbyMs: 260, settleMs: 30, retryAttempts: 3, retryBackoffMs: [5], retryJoinTimeoutMs: 50, retryAttemptMs: 50, rejoinMs: 500 },
};

async function setup(cfg: object = SUSPEND, withBus = true, guestCfg: object = cfg, nativeHb = false) {
  const f = await pairedFakes({ nativeHeartbeat: nativeHb }, { bus: withBus });
  const hostT = new Tether(f.host.platform, cfg);
  const guestT = new Tether(f.guest.platform, guestCfg);
  const got = { host: [] as unknown[], guest: [] as unknown[] };
  hostT.onMessage((b) => got.host.push(b));
  guestT.onMessage((b) => got.guest.push(b));
  // 子機の Echo は、止められるようにしておく(バスだけで生存が保たれることを見る)
  let echo = true;
  const echoTimer = setInterval(() => { if (echo && f.guest.ctl.probeOk) f.host.emitEcho(); }, 10);
  // ネイティブの ping/pong の代わり(バスが up の間は lastRxAt を進める)
  let pulse = true;
  const pulseTimer = setInterval(() => { if (pulse && f.bus?.isUp()) f.bus.pulse(); }, 10);
  return {
    ...f, hostT, guestT, got, stopEcho: () => { echo = false; }, stopPulse: () => { pulse = false; },
    cleanup: () => { clearInterval(echoTimer); clearInterval(pulseTimer); hostT.stop(); guestT.stop(); },
  };
}

async function established(c: Awaited<ReturnType<typeof setup>>) {
  await c.hostT.start();
  await c.guestT.start();
  await until(() => c.guestT.getState().vpn === 'on', 3000, 'vpn');
  await until(() => c.hostT.getState().nearby === 'suspended' && c.guestT.getState().nearby === 'suspended', 3000, 'both suspended');
}

test('suspend 中: send は Bus で届く(受諾・地図を開くなど)。Nearby には何も出ない', async () => {
  const c = await setup();
  await established(c);
  assert.ok(c.bus!.ctl.starts.includes('host') && c.bus!.ctl.starts.includes('guest'));
  await until(() => c.bus!.isUp(), 1000, 'bus up');
  const nearbyBefore = [c.net.host.suspendCount, c.net.guest.suspendCount];
  c.guestT.send({ type: 'accept', id: 7 });
  c.hostT.send({ type: 'open-map', lat: 35.1, lng: 139.2 });
  await until(() => c.got.host.length === 1 && c.got.guest.length === 1, 1000, 'delivered over bus');
  assert.deepEqual(c.got.host[0], { type: 'accept', id: 7 });
  assert.deepEqual(c.got.guest[0], { type: 'open-map', lat: 35.1, lng: 139.2 });
  assert.ok(c.bus!.ctl.sent.guest.length >= 1 && c.bus!.ctl.sent.host.some((p) => p.includes('open-map')));
  assert.deepEqual([...c.net.host.leaked, ...c.net.guest.leaked], []); // Nearby の要求は出ていない
  assert.deepEqual([c.net.host.suspendCount, c.net.guest.suspendCount], nearbyBefore);
  c.cleanup();
});

test('keep 方式(既定): バスは起動せず、Nearby で届く', async () => {
  const keep = { link: SUSPEND.link, connectTimeoutMs: 100, probeIntervalMs: 1 };
  const c = await setup(keep);
  await c.hostT.start(); await c.guestT.start();
  await until(() => c.guestT.getState().vpn === 'on');
  await until(() => c.guestT.getState().link === 'connected', 2000, 'nearby');
  c.guestT.send({ type: 'accept' });
  await until(() => c.got.host.length === 1, 1000, 'delivered over nearby');
  assert.deepEqual(c.bus!.ctl.starts, []);
  assert.deepEqual(c.bus!.ctl.sent.guest, []);
  c.cleanup();
});

test('Bus 断 → 保留(Nearby は止めたまま)→ 復帰で送信順に再送。重複しない', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  c.bus!.link(false);
  await until(() => !c.bus!.isUp());
  c.hostT.send({ n: 1 }); c.hostT.send({ n: 2 }); c.hostT.send({ n: 3 });
  await wait(30);
  assert.equal(c.got.guest.length, 0);
  assert.equal(c.hostT.getState().nearby, 'suspended'); // 再接続が先: Nearby は再開しない
  assert.ok(c.hostT.getState().pending >= 3);
  c.bus!.link(true);
  await until(() => c.got.guest.length === 3, 1000, 'resent');
  assert.deepEqual(c.got.guest, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  await wait(60); // ack が戻ったあとの再送は無い
  assert.equal(c.got.guest.length, 3);
  assert.equal(c.hostT.getState().pending, 0);
  assert.deepEqual([...c.net.host.leaked, ...c.net.guest.leaked], []);
  c.cleanup();
});

test('ack が失われた(受け手には届いた)あとの再送は、受け手のアプリに二重に渡さない', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  c.guestT.send({ once: true });
  c.bus!.ctl.dropNext = 1; // 親機が返す ack を 1 つ落とす(データは届いている)
  await until(() => c.got.host.length === 1);
  await wait(30);
  assert.equal(c.guestT.getState().pending, 1, 'ack が来ないので子機は保持したまま');
  c.bus!.link(false); await wait(10); c.bus!.link(true); // 再接続 → 子機は未確認を再送
  await until(() => c.guestT.getState().pending === 0, 1000, 'acked after resend');
  assert.equal(c.bus!.ctl.sent.guest.filter((p) => p.includes('once')).length, 2); // 実際に再送された
  assert.equal(c.got.host.length, 1); // アプリには 1 回だけ
  c.cleanup();
});

test('ttl 切れは破棄: 切断中に ttl が過ぎたものは復帰しても届かない(ttl なしは届く)', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  c.bus!.link(false);
  await until(() => !c.bus!.isUp());
  c.hostT.send({ n: 'short' }, { ttlMs: 20 });
  c.hostT.send({ n: 'forever' });
  c.hostT.send({ n: 'nowait' }, { ttlMs: 0 });
  await wait(60);
  c.bus!.link(true);
  await until(() => c.got.guest.length >= 1, 1000, 'resent');
  await wait(60);
  assert.deepEqual(c.got.guest, [{ n: 'forever' }]);
  c.cleanup();
});

test('同じ key の保留は最新に置き換わる(状態表示など)', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  c.bus!.link(false);
  await until(() => !c.bus!.isUp());
  c.hostT.send({ s: 1 }, { key: 'state' }); c.hostT.send({ s: 2 }, { key: 'state' });
  c.bus!.link(true);
  await until(() => c.got.guest.length >= 1, 1000);
  await wait(40);
  assert.deepEqual(c.got.guest, [{ s: 2 }]);
  c.cleanup();
});

test('バスが生存信号を兼ねる: Echo が止まっても、バスが生きている間は connected のまま・Nearby も再開しない', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  c.stopEcho();
  await wait(250); // T_echo(60ms)・T_direct(200ms)を過ぎる
  assert.equal(c.hostT.getState().overall, 'connected');
  assert.equal(c.guestT.getState().overall, 'connected');
  assert.equal(c.hostT.getState().nearby, 'suspended');
  assert.equal(c.net.host.suspended, true);
  c.cleanup();
});

test('バスも Echo も止まれば従来どおり degraded → 親機が Nearby を再開', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  c.stopEcho(); c.stopPulse();
  await until(() => c.hostT.getState().overall !== 'connected', 1000, 'degraded');
  await until(() => c.hostT.getState().nearby !== 'suspended', 4000, 'host resumed nearby');
  c.cleanup();
});

test('縮退: Direct が戻らず Nearby が再開されたら、バスに溜まっていた分は Nearby で届く', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  c.guest.ctl.joinFails = 99;
  c.guest.ctl.probeOk = false;
  c.guest.loseWifi(); // 子機の Wi-Fi 切断 → バスも切れる
  await until(() => !c.bus!.isUp());
  c.hostT.send({ late: 'host→guest' });
  assert.equal(c.got.guest.length, 0);
  await until(() => c.hostT.getState().nearby !== 'suspended' && c.guestT.getState().nearby !== 'suspended', 5000, 'both nearby resumed');
  await until(() => c.got.guest.length === 1, 4000, 'delivered over nearby after fallback');
  assert.deepEqual(c.got.guest[0], { late: 'host→guest' });
  assert.ok(c.net.host.notes.some((n) => n.includes('運び先: Nearby')));
  c.cleanup();
});

test('旧版の親機(busPort を送らない)・バス部品なしの端末: 従来どおり Nearby だけで動く', async () => {
  const c = await setup(SUSPEND, false);
  await established(c);
  c.guestT.send({ x: 1 });
  await wait(80);
  assert.equal(c.hostT.getState().nearby, 'suspended');
  assert.equal(c.got.host.length, 0); // suspend 中の Nearby は止まっているので溜まるだけ(従来の挙動)
  assert.ok(c.guestT.getState().pending >= 1);
  c.cleanup();
});

test('実効方式が suspend でない(子機が keep)ときは、バスを起動せず Nearby で届く', async () => {
  const keep = { link: SUSPEND.link, connectTimeoutMs: 100, probeIntervalMs: 1, nearbyWhileDirect: 'keep' as const };
  const c = await setup(SUSPEND, true, keep);
  await c.hostT.start(); await c.guestT.start();
  await until(() => c.guestT.getState().vpn === 'on');
  await until(() => c.guestT.getState().link === 'connected', 2000, 'nearby');
  await wait(100);
  assert.deepEqual(c.bus!.ctl.starts.filter((x) => x === 'guest'), []);
  c.guestT.send({ type: 'accept' });
  await until(() => c.got.host.length === 1, 1000, 'delivered over nearby');
  assert.deepEqual(c.bus!.ctl.sent.guest, []);
  c.cleanup();
});

test('ネイティブ heartbeat: バス接続中は Echo(ネイティブ)を止め、バス断で再開する', async () => {
  const c = await setup(SUSPEND, true, SUSPEND, true);
  // ネイティブの Echo の代わり(running の間だけ親機に Echo を届ける)
  const timer = setInterval(() => {
    const hb = c.guest.ctl.hb;
    if (!hb.running) return;
    const now = Date.now(); hb.lastAttemptAt = now; hb.lastOkAt = now; hb.consecutiveFailures = 0; c.host.emitEcho();
  }, 10);
  await established(c);
  await until(() => c.bus!.isUp());
  await wait(100);
  const starts0 = c.guest.calls.filter((x) => x.startsWith('hbStart:')).length;
  assert.equal(starts0, 0, 'バスが新しい間はネイティブ Echo を始めない(始まっていても止める)');
  await wait(150);
  assert.equal(c.guestT.getState().overall, 'connected'); // Echo なしでもバスの生存信号で connected
  assert.equal(c.hostT.getState().overall, 'connected');
  c.bus!.link(false); c.stopPulse();
  await until(() => c.guest.calls.filter((x) => x.startsWith('hbStart:')).length > starts0, 1000, 'native echo resumed after bus down');
  clearInterval(timer);
  c.cleanup();
});

test('Echo が一度も届かなくても、バスが認証済みなら親機は Nearby を止める(Echo の回数推定に頼らない)', async () => {
  const c = await setup();
  c.stopEcho(); // Echo は一度も届かない
  await c.hostT.start();
  await c.guestT.start();
  await until(() => c.hostT.getState().nearby === 'suspended', 4000, 'host suspended by bus ready');
  assert.equal(c.hostT.getState().data.echoAt, null);
  c.cleanup();
});
