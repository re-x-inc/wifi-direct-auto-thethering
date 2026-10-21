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
  strictLinkGuard: true,
  timingUnchecked: true,
  timing: { hbIntervalMs: 20, tickMs: 10, echoMs: 60, directMs: 200, nearbyMs: 260, settleMs: 30, retryAttempts: 3, retryBackoffMs: [5], retryJoinTimeoutMs: 50, retryAttemptMs: 50, rejoinMs: 500 },
};

async function setup(cfg: object = SUSPEND, withBus = true, guestCfg: object = cfg) {
  const f = await pairedFakes({}, { bus: withBus });
  const hostT = new Tether(f.host.platform, cfg);
  const guestT = new Tether(f.guest.platform, guestCfg);
  const got = { host: [] as unknown[], guest: [] as unknown[] };
  hostT.onMessage((b) => got.host.push(b));
  guestT.onMessage((b) => got.guest.push(b));
  // ネイティブの ping/pong の代わり(バスが up の間は lastRxAt を進める)
  let pulse = true;
  const pulseTimer = setInterval(() => { if (pulse && f.bus?.isUp()) f.bus.pulse(); }, 10);
  return {
    ...f, hostT, guestT, got, stopPulse: () => { pulse = false; },
    cleanup: () => { clearInterval(pulseTimer); hostT.stop(); guestT.stop(); },
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
  c.stopPulse();
  await until(() => c.hostT.getState().overall !== 'connected', 1000, 'degraded');
  await until(() => c.hostT.getState().nearby !== 'suspended', 4000, 'host resumed nearby');
  c.cleanup();
});

test('縮退: Direct が戻らず Nearby が再開されても、アプリのメッセージは Nearby に載せない(バス復帰まで保留)。内部制御は Nearby へ移る', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  const logs: string[] = [];
  c.hostT.onLog((l) => logs.push(l));
  c.guest.ctl.joinFails = 99;
  c.guest.loseWifi(); // 子機の Wi-Fi 切断 → バスも切れる
  await until(() => !c.bus!.isUp());
  c.hostT.send({ type: 'late', v: 'host→guest' });
  assert.equal(c.got.guest.length, 0);
  await until(() => c.hostT.getState().nearby !== 'suspended' && c.guestT.getState().nearby !== 'suspended', 5000, 'both nearby resumed');
  await wait(100);
  assert.equal(c.got.guest.length, 0, 'Nearby では届かない');
  assert.deepEqual([...c.net.host.sentTexts, ...c.net.guest.sentTexts].filter((t) => t.includes('tether.app')), []);
  assert.equal(c.hostT.linkSnapshot().appPending, 1);
  assert.equal(c.hostT.linkSnapshot().appCarrier, 'bus');
  assert.equal(c.hostT.linkSnapshot().controlCarrier, 'nearby');
  assert.ok(logs.some((l) => l.includes('送信[アプリ] 種別=late → 溜め(')));
  assert.ok(c.net.host.notes.some((n) => n.includes('内部制御の運び先: Nearby')));
  c.cleanup();
});

test('バス切断中の send は Nearby に出ない。復帰で溜めた分が送信順に届き、ログは 溜め → バス(溜めていた分) → 受信', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  const hostLogs: string[] = [], guestLogs: string[] = [];
  c.hostT.onLog((l) => hostLogs.push(l)); c.guestT.onLog((l) => guestLogs.push(l));
  const nearbySent = () => [...c.net.host.sentTexts, ...c.net.guest.sentTexts].filter((t) => t.includes('tether.app')).length;
  const before = nearbySent();
  c.bus!.link(false);
  await until(() => !c.bus!.isUp());
  c.hostT.send({ type: 'a' }); c.hostT.send({ type: 'b' }); c.hostT.send({ type: 'c' });
  await wait(30);
  assert.equal(nearbySent(), before);
  assert.equal(c.hostT.linkSnapshot().appPending, 3);
  c.bus!.link(true);
  await until(() => c.got.guest.length === 3, 1000, 'resent');
  assert.deepEqual(c.got.guest.map((x: any) => x.type), ['a', 'b', 'c']);
  assert.equal(nearbySent(), before);
  assert.equal(hostLogs.filter((l) => l.includes('送信[アプリ] 種別=a → 溜め(')).length, 1);
  assert.equal(hostLogs.filter((l) => l.includes('送信[アプリ] 種別=a → バス(溜めていた分)')).length, 1);
  assert.ok(guestLogs.some((l) => l.includes('受信[アプリ] 種別=a ← バス')));
  c.cleanup();
});

test('接続中の send: ログは 送信[アプリ] → バス、内部制御は 送信[制御] 種別=… と運び先', async () => {
  const c = await setup();
  const logs: string[] = [];
  c.hostT.onLog((l) => logs.push(l));
  await established(c);
  await until(() => c.bus!.isUp());
  c.hostT.send({ type: 'open-map' });
  await until(() => c.got.guest.length === 1);
  assert.ok(logs.some((l) => l.includes('[DH-LINK] 送信[アプリ] 種別=open-map → バス')));
  assert.ok(logs.some((l) => /\[DH-LINK\] 送信\[制御\] 種別=tether\.wifi → Nearby/.test(l)));
  assert.ok(logs.every((l) => !l.includes('送信[アプリ]') || !l.includes('Nearby')));
  c.cleanup();
});

test('上限: アプリの保留が上限を超えたら古いものから破棄(Nearby へは出ない)', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  const logs: string[] = [];
  c.hostT.onLog((l) => logs.push(l));
  c.bus!.link(false);
  await until(() => !c.bus!.isUp());
  for (let i = 0; i < 205; i++) c.hostT.send({ type: 'x', i });
  assert.equal(c.hostT.linkSnapshot().appPending, 200);
  assert.equal(logs.filter((l) => l.includes('種別=x → 破棄(上限)')).length, 5);
  c.cleanup();
});

test('バス部品なしの子機: 到達確認はバスでしか通らないので VPN は張れず、アプリのメッセージは Nearby に載らない', async () => {
  const c = await setup(SUSPEND, false);
  await c.hostT.start();
  await c.guestT.start();
  await wait(300);
  assert.notEqual(c.guestT.getState().vpn, 'on');
  c.guestT.send({ x: 1 });
  await wait(80);
  assert.equal(c.got.host.length, 0);
  assert.deepEqual([...c.net.host.sentTexts, ...c.net.guest.sentTexts].filter((t) => t.includes('tether.app')), []);
  c.cleanup();
});

test('linkSnapshot に lastAliveAt と bus(authenticated / disconnected)が出る。バス断でも lastAliveAt は戻らない', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  await until(() => c.guestT.linkSnapshot().path.bus === 'authenticated' && c.hostT.linkSnapshot().path.bus === 'authenticated', 1000, 'bus authenticated');
  await until(() => (c.guestT.linkSnapshot().path.lastAliveAt ?? 0) > 0, 1000, 'lastAliveAt');
  const s1 = c.guestT.linkSnapshot();
  assert.equal(s1.data?.bus, 'authenticated');
  assert.equal(s1.data?.aliveAt, s1.path.lastAliveAt);
  assert.equal(c.guestT.getState().data.aliveAt, s1.path.lastAliveAt);
  c.stopPulse();
  c.bus!.link(false);
  await until(() => c.guestT.linkSnapshot().path.bus === 'disconnected', 1000, 'bus disconnected');
  const frozen = c.guestT.linkSnapshot().path.lastAliveAt as number;
  assert.ok(frozen >= (s1.path.lastAliveAt as number), '古い時刻へ戻らない');
  await wait(60);
  assert.equal(c.guestT.linkSnapshot().path.lastAliveAt, frozen, '切断中は進まない');
  c.cleanup();
});

test('restartLink: 親機は Direct を作り直し、二重起動せず、停止中は何もしない', async () => {
  const c = await setup();
  assert.deepEqual(await c.hostT.restartLink(), { action: 'none', reason: 'stopped' });
  await established(c);
  await until(() => c.bus!.isUp());
  const r = await c.hostT.restartLink();
  assert.equal(r.action, 'rebuild');
  assert.deepEqual(await c.hostT.restartLink().then((x) => x.action), 'none', '再接続中は何もしない');
  await until(() => c.hostT.getState().overall === 'connected' && c.hostT.getState().nearby === 'suspended', 5000, 'back to direct');
  c.cleanup();
});

test('restartLink: 子機は governor の表どおり retrying へ(lost manual)。戻れば direct に戻る', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  const r = await c.guestT.restartLink();
  assert.equal(r.action, 'retry');
  assert.ok(c.guestT.linkSnapshot().history.some((h) => h.to === 'retrying' && h.reason === 'manual'));
  assert.equal((await c.guestT.restartLink()).action, 'none');
  await until(() => c.guestT.linkSnapshot().state.name === 'direct-active', 5000, 'guest back to direct');
  c.cleanup();
});

test('バスの生存信号だけが進んでも、onLink / subscribe の購読者へ新しい lastAliveAt が届く(画面が古い時刻を持たない)', async () => {
  const c = await setup();
  await established(c);
  await until(() => c.bus!.isUp());
  await wait(100); // 遷移の余波を落ち着かせる
  const a0 = c.hostT.linkSnapshot().path.lastAliveAt as number;
  const links: number[] = [];
  const states: Array<number | null> = [];
  const off1 = c.hostT.onLink((s) => { if (s.path.lastAliveAt) links.push(s.path.lastAliveAt); });
  const off2 = c.hostT.subscribe((s) => states.push(s.data.aliveAt));
  await until(() => links.some((x) => x > a0 + 50), 1500, 'onLink で新しい lastAliveAt');
  await until(() => states.some((x) => (x ?? 0) > a0 + 50), 1500, 'subscribe で新しい aliveAt');
  off1(); off2();
  c.cleanup();
});
